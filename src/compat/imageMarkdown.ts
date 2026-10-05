/**
 * 图片段 → markdown 图片（`![#宽px #高px](url)`）。
 *
 * 用户反馈两条，这里一起解决：
 *   1. **「所有的图片发送都要走 md，不然太模糊了」** —— QQ 的普通图片消息（image 段 → 适配器按
 *      MEDIA 上传）会被客户端二次压缩，卡片上的小字糊成一团；markdown 里的图片不会被压，字是清楚的。
 *   2. **「![#px大小#px大小]() 必须要 #px，不然手机不会显示」** —— md 图片必须写死尺寸，
 *      不写尺寸手机端干脆不显示这张图。
 *
 * 所以这里在**发送出口**统一改写：compat/node-karin 的 reply / sendMsg / sendMaster 四条路径都过一遍，
 * 业务代码照旧 e.reply(segment.image(...))，不用一处处改。
 *
 * 只在「认 markdown 的平台」上生效（官方 QQ：`qq`）：
 *   - OneBot 系（NapCat / Lagrange / go-cqhttp / Chronocat…）收到 markdown 只显示成一串文字、
 *     图片全丢（用户实测），所以那条链路继续发图片段；
 *   - QQ 频道（`qqguild`）的适配器没有 markdown 分支，md 元素会被当纯文本渲染 → 也排除。
 *
 * 另外三种情况**不动**（动了只会更糟）：
 *   - 消息里还有视频 / 语音 / 文件：适配器遇到附件会把整条消息转成 MEDIA，markdown 内容会被丢掉；
 *   - 合并转发收集中的消息：转发节点里塞 markdown 客户端不认；
 *   - 上传拿不到公网地址（没装 assets 服务等）、或者**读不出图片尺寸**：保持原来的图片段。
 *     读不出尺寸是可以退回普通图片的，但**绝不能发一张不带尺寸的 markdown 图片** ——
 *     用户实测「必须要 #px，不然手机不会显示」，那种图上手机就是一片空白。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isUsableSize, readImageSize, scaleToWidth } from './imageSize'
import { logger } from './logger'
import { tryGetRuntime } from './runtime'
import { segment } from './segment'

/**
 * **OneBot 系**（NapCat / Lagrange / go-cqhttp / Chronocat…）。
 *
 * 这是「走不走 OneBot 那套私有协议」的判据（合并转发、表情回应那些接口），
 * **不是**「认不认 markdown」—— 后者是 {@link canUseMarkdownImage}。
 * Milky 不是 OneBot，所以它**不在这个名单里**。
 *
 * ⚠️ 全仓库只有这一处定义，别在别的文件里再抄一份正则。
 */
export const isOneBotLike = (platform: string): boolean =>
  /onebot|napcat|lagrange|go-?cqhttp|chronocat|mirai/i.test(String(platform ?? ''))

/**
 * **能渲染 markdown 图片的平台**（白名单）—— 只有 **QQ 官方机器人**。
 *
 * ## ⚠️ 图片 md 和文字 md 不是一回事，别合并成一份名单
 *
 * - **文字** markdown（代码块、面板按钮、提示语）：QQ（`qq`）和 **QQ 频道**（`qqguild`）都认，
 *   那份判据在 `QqPanel.supportsMarkdown`；
 * - **图片** markdown（`![#600px #400px](地址)` 这种带尺寸的写法）**只有 `qq` 认** ——
 *   `qqguild` 走的是另一套编码器，md 元素到那边会被当成纯文本原样发出去，
 *   图片就变成一串看不懂的代码。**所以这里必须把 `qqguild` 排除掉。**
 *   （3.7.2 引入图片 md 时就是这个结论，改动前请先看 `smoke-md-image` 那条用例。）
 *
 * ## ⚠️ 必须写成**白名单**，不能写成黑名单
 *
 * 以前是「先排除 OneBot 系，剩下都用 md」，结果**每出一个新协议端就漏一次**：
 * Discord / Telegram / Satori / **Milky** 都先后被当成过官方 QQ，
 * 图片全发出去变成一串看不懂的代码（用户反馈过不止一次）。
 * 黑名单的失效方式是「**新东西默认被放行**」，而这里放行的代价就是一堆乱码。
 *
 * 反过来写就没有这个问题：新协议端**默认不发 md**，最坏情况只是「少了点排版」，
 * 图片照样出得来 —— 宁可朴素，不要乱码。
 *
 * ## 匹配范围
 * `qq` / `qqbot`，以及带后缀的那些（`qq-xxx`）。
 * 别的形式（`qqguild` / `onebot` / `napcat` / `milky` / `satori` / 空串…）一律不算。
 */
const MARKDOWN_IMAGE_PLATFORMS = /^qq(bot)?(-|$)/i

export const canUseMarkdownImage = (platform: string): boolean =>
  MARKDOWN_IMAGE_PLATFORMS.test(String(platform ?? '').trim())

/** 媒体段：md 和附件不能塞进同一条消息（会被适配器吃掉），所以要跳过整条改写 */
const ATTACHMENT_TYPES = new Set(['video', 'audio', 'record', 'file'])

const isImageElement = (element: any): boolean =>
  !!element && typeof element === 'object' && (element.type === 'img' || element.type === 'image')

const srcOf = (element: any): string => {
  const attrs = element?.attrs ?? {}
  const src = attrs.src ?? attrs.url ?? element?.data?.file ?? element?.data?.url
  return typeof src === 'string' ? src : ''
}

/** 按二进制头认 mime（发给 assets 用；标错会让适配器按错格式处理） */
const mimeOfBuffer = (buffer: Buffer): string => {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer.toString('latin1', 1, 4) === 'PNG') return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
  if (buffer.length >= 6 && buffer.toString('latin1', 0, 3) === 'GIF') return 'image/gif'
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return 'image/jpeg'
}

/** 把各种写法读成 Buffer：data URI / base64:// / file:// / 本地路径 / http(s) */
const loadImageBuffer = async (src: string): Promise<Buffer | null> => {
  try {
    if (src.startsWith('base64://')) return Buffer.from(src.slice('base64://'.length), 'base64')
    if (src.startsWith('data:')) {
      const comma = src.indexOf(',')
      if (comma < 0) return null
      return Buffer.from(src.slice(comma + 1), 'base64')
    }
    const localPath = src.startsWith('file://') ? fileURLToPath(src) : src
    if (!/^https?:\/\//i.test(src)) {
      if (fs.existsSync(localPath)) return fs.readFileSync(localPath)
      return null
    }
    const response = await fetch(src)
    if (!response.ok) {
      logger.mark('[图片md] 下载失败 HTTP ' + response.status + ': ' + src.slice(0, 80))
      return null
    }
    return Buffer.from(await response.arrayBuffer())
  } catch (error: any) {
    logger.mark('[图片md] 读取图片失败: ' + String(error?.message ?? error).slice(0, 120))
    return null
  }
}

/**
 * 上传到宿主的 assets，拿到 QQ 能直接取的 https 地址。
 *
 * md 里的图片地址**必须是公网 http(s)**：适配器只对 data: 图片做特殊处理
 * （见 qq-crack 的 renderMarkdownDataImages —— data 图片会被它转回 MEDIA 上传，等于白改），
 * 相对路径/本地路径手机端也取不到。
 */
let warnedNoAssets = false

const uploadImage = async (buffer: Buffer): Promise<string | null> => {
  const assets: any = (tryGetRuntime() as any)?.ctx?.assets
  if (!assets?.upload) {
    /** 没装 assets 服务就整条链路都用不了，提示一次就够，别每张图刷一遍日志 */
    if (!warnedNoAssets) {
      warnedNoAssets = true
      logger.mark('[图片md] 宿主没有 assets 服务（拿不到公网图片地址），图片继续按普通图片段发送')
    }
    return null
  }
  const mime = mimeOfBuffer(buffer)
  const ext = mime === 'image/png' ? '.png' : mime === 'image/gif' ? '.gif' : mime === 'image/webp' ? '.webp' : '.jpg'
  try {
    const uploaded: any = await assets.upload('data:' + mime + ';base64,' + buffer.toString('base64'), 'kkk-md' + ext)
    const url = typeof uploaded === 'string' ? uploaded : uploaded?.url
    return url && /^https?:\/\//i.test(String(url)) ? String(url) : null
  } catch (error: any) {
    logger.mark('[图片md] 上传失败: ' + String(error?.message ?? error).slice(0, 120))
    return null
  }
}

/**
 * 同一张图反复发（推送里的封面、面板卡片…）不用反复上传：
 * 按图片内容摘要缓存结果，顺带省掉重复的下载与解码。
 */
const imageCache = new Map<string, string | null>()
const IMAGE_CACHE_MAX = 200

/** 图片段 → md 图片字符串；拿不到尺寸/地址就返回 null（调用方保持原样，别把图弄丢） */
export const markdownImageOf = async (src: string): Promise<string | null> => {
  if (!src) return null
  const key = crypto.createHash('md5').update(src).digest('hex')
  const cached = imageCache.get(key)
  if (cached) return cached
  const buffer = await loadImageBuffer(src)
  let result: string | null = null
  if (buffer && buffer.length) {
    const { width, height } = readImageSize(buffer)
    /**
     * **读不出尺寸就不换成 markdown**（退回普通图片段）。
     *
     * 用户实测：「必须要 #px，不然手机不会显示」—— 不带尺寸的 md 图片在手机端干脆是空白，
     * 比糊更糟。所以这里宁可发一张（会被压糊但看得见的）普通图片，
     * 也不发一张手机上什么都不显示的 markdown 图片。
     */
    if (width > 0 && height > 0) {
      const url = await uploadImage(buffer)
      if (url) result = '![#' + width + 'px #' + height + 'px](' + url + ')'
    }
  }
  /**
   * **只缓存成功的结果**：网络 / 图床抖动导致的失败要是也缓存下来，
   * 这张图之后就一直按普通图片发（糊），得等重启才能恢复。
   */
  if (result) {
    if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value as string)
    imageCache.set(key, result)
  } else {
    logger.debug('[图片md] 这张图这次没转成 markdown，按普通图片发送: ' + src.slice(0, 60))
  }
  return result
}

/** 清空缓存（测试用） */
export const clearMarkdownImageCache = (): void => { imageCache.clear() }

/* ------------------------------------------------------------------ *
 * md 图片的尺寸兜底
 *
 * `markdownImageOf` 只管**图片段**转 md 这条线（读不出尺寸就不转，退回普通图片）。
 * 但业务代码自己拼的 markdown —— 长图切片、画质面板的封面卡、按钮行 —— 不经过那里，
 * 万一漏了尺寸（历史遗留写成 `![](url)`，或者以后新加的拼接忘了带），
 * 发出去在手机端就是**一片空白**（用户实测：「必须要 #px，不然手机不会显示」）。
 *
 * 所以在**发送出口**再扫一遍，把没带尺寸的 md 图片补上。
 *
 * ## 补的必须是**真实**尺寸
 *
 * 第一版图省事，直接塞一个「默认宽 420 × 高 546」的框 —— 结果**图片被强制拉伸**了：
 * QQ 按 `#宽px #高px` 这个框渲染图片，框的比例和原图对不上就被拉变形。
 * 所以现在**先把图下下来量一下真实尺寸**，量到了就用真实比例（和 `markdownImageOf` 同一套），
 * 只有连图片都读不到时才退到估算值（那种情况下图本来就出不来，比例已经无所谓了）。
 * ------------------------------------------------------------------ */

/** 标准 md 图片语法：`![alt](url)`（alt 里不许有 `]`、url 里不许有空白与 `)`） */
const MD_IMAGE_RE = /!\[([^\]\n]*)\]\(([^)\s]+)\)/g
/** alt 里已经写了 `#宽px` 就不动它 */
const HAS_SIZE_RE = /#[^#\]]*?\d+(?:\.\d+)?\s*px/i

/**
 * **估算版**：给一段 markdown 文本里的图片补尺寸（已经带 `#px` 的原样不动）。
 *
 * ⚠️ 估算出来的框**比例是固定的**（宽 : 高 = 1 : 1.3），和原图对不上就会**拉伸**。
 * 只该在「连图片都读不到」时当最后兜底用；正常路径请用 {@link sizeMarkdownImages}，
 * 它会先量真实尺寸。
 * @param text markdown 文本
 * @param maxWidth 估算用的默认宽度
 */
export const ensureMarkdownImageSize = (text: string, maxWidth = 420): string => {
  const source = String(text ?? '')
  if (!source.includes('![')) return source
  return source.replace(MD_IMAGE_RE, (whole, alt: string, url: string) =>
    HAS_SIZE_RE.test(String(alt))
      ? whole
      : '![#' + maxWidth + 'px #' + Math.round(maxWidth * 1.3) + 'px](' + url + ')')
}

/**
 * 量一张图的**真实**尺寸，返回带真实比例的 md 图片；读不到返回 null。
 * @param url 图片地址（http(s) / 本地 / data URI / base64://）
 * @param maxWidth 显示宽度上限
 */
const measureMarkdownImage = async (url: string, maxWidth: number): Promise<string | null> => {
  const buffer = await loadImageBuffer(url)
  if (!buffer || !buffer.length) return null
  const size = readImageSize(buffer)
  if (!isUsableSize(size)) return null
  const scaled = scaleToWidth(size, maxWidth)
  logger.mark('[图片md] 给漏了尺寸的 md 图片补真实尺寸（原图 ' + size.width + 'x' + size.height + '）：' + url.slice(0, 60))
  return '![#' + scaled.width + 'px #' + scaled.height + 'px](' + url + ')'
}

/**
 * 给一段 markdown 里的图片补尺寸 —— **优先量真实尺寸**，量不到才用估算值。
 *
 * @param text markdown 文本
 * @param maxWidth 显示宽度上限
 */
export const sizeMarkdownImages = async (text: string, maxWidth = 420): Promise<string> => {
  const source = String(text ?? '')
  if (!source.includes('![')) return source
  /** 没带尺寸的那几张（同一段里可能重复出现同一张，用整段文本当键去重） */
  const pending = [...source.matchAll(MD_IMAGE_RE)]
    .map((match) => match[0])
    .filter((whole) => !HAS_SIZE_RE.test(whole.slice(2, whole.indexOf(']('))))
  if (!pending.length) return source

  const replacements = new Map<string, string>()
  /** 串行量：同一段里通常只有一两张，串行能避免瞬间并发去下载同一个图床 */
  for (const whole of new Set(pending)) {
    const url = whole.slice(whole.indexOf('](') + 2, -1)
    replacements.set(whole, (await measureMarkdownImage(url, maxWidth)) ?? ensureMarkdownImageSize(whole, maxWidth))
  }
  return source.replace(MD_IMAGE_RE, (whole) => replacements.get(whole) ?? whole)
}

/**
 * 把元素树里所有**文本**过一遍改写函数（`attrs.content` 与嵌套 text 子节点都认）。
 *
 * 为什么要递归：`segment.markdown('...')` 走的是 satori 的 `h()`，
 * 形状是 `{ type:'markdown', attrs:{}, children:[{ type:'text', attrs:{ content } }] }`
 * —— 正文**不在** `attrs.content` 上。两种形状都兜住，免得哪天换回扁平写法就失效。
 * @returns 有新内容时返回新对象，没变则返回原对象（调用方可用引用比较判断）
 */
const mapTextContent = async (node: any, fn: (text: string) => Promise<string>): Promise<any> => {
  if (!node || typeof node !== 'object') return node
  let attrs = node.attrs
  let changed = false
  if (attrs && typeof attrs.content === 'string') {
    const next = await fn(attrs.content)
    if (next !== attrs.content) {
      attrs = { ...attrs, content: next }
      changed = true
    }
  }
  let children = node.children
  if (Array.isArray(children)) {
    const mapped = await Promise.all(children.map((child: any) => mapTextContent(child, fn)))
    if (mapped.some((child: any, index: number) => child !== children[index])) {
      children = mapped
      changed = true
    }
  }
  return changed ? { ...node, attrs, children } : node
}

/** 给一个元素里的 md 图片补尺寸（非 markdown 段原样返回） */
const patchMarkdownElement = async (element: any): Promise<any> =>
  String(element?.type ?? '') === 'markdown'
    ? mapTextContent(element, (text) => sizeMarkdownImages(text))
    : element

/**
 * 把一条消息里的图片段改写成 markdown 图片（其它段原样保留、顺序不变）。
 *
 * 连续的图片合成**一个** markdown 元素（换行分隔）—— 和官方 QQ 的渲染习惯一致：
 * 连续图片紧贴显示，视觉上仍是一整张卡片，而不是一张一张孤立的图。
 *
 * @param elements 已归一化的消息元素数组
 * @param platform 适配器平台名（kompat 层从 bot.platform / session.platform 取）
 * @returns 改写后的数组；不该改或改不动时**原样返回**，绝不让消息发不出去
 */
export const imagesToMarkdown = async (elements: any[], platform: string): Promise<any[]> => {
  const list = Array.isArray(elements) ? elements : []
  if (!list.length) return list
  if (!canUseMarkdownImage(platform)) return list

  /**
   * **已有的 markdown 段先补一遍尺寸，且必须在「有没有图片段」的判断之前** ——
   * 长图切片那种消息整条只有 markdown、一个 image 段都没有，
   * 放到后面就整条漏掉了。
   */
  const sized = await Promise.all(list.map(patchMarkdownElement))

  if (!sized.some(isImageElement)) return sized
  if (sized.some((element) => ATTACHMENT_TYPES.has(String(element?.type ?? '')))) return sized

  const out: any[] = []
  /** 攒着的连续图片（遇到非图片段就冲出去） */
  let run: string[] = []
  const flushRun = () => {
    // 有图转不动（上传失败等）时 run 里会是空串占位，这里只冲有内容的
    if (run.length) out.push(segment.markdown(run.join(String.fromCharCode(10))))
    run = []
  }

  for (const element of sized) {
    if (!isImageElement(element)) {
      flushRun()
      out.push(element)
      continue
    }
    const markdown = await markdownImageOf(srcOf(element))
    if (markdown) {
      run.push(markdown)
    } else {
      // 转不了就把它自己按图片段发出去，别丢
      flushRun()
      out.push(element)
    }
  }
  flushRun()
  return out
}
