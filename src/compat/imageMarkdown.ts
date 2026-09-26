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

import { logger } from './logger'
import { tryGetRuntime } from './runtime'
import { segment } from './segment'

/** OneBot 系：不渲染 markdown（见文件头） */
const ONEBOT_LIKE = /onebot|napcat|lagrange|go-?cqhttp|chronocat|mirai/i

/**
 * 会渲染 markdown 图片的平台。
 *
 * 只认 `qq` 这一个平台名 —— QQ 的 markdown 是**官方机器人**能力，
 * `qqguild`（频道）走的是另一套编码器，md 元素在那里会被当成纯文本原样发出去。
 */
const canUseMarkdownImage = (platform: string): boolean => {
  const name = String(platform || '').toLowerCase()
  if (!name) return false
  if (ONEBOT_LIKE.test(name)) return false
  if (name.startsWith('qqguild')) return false
  return name === 'qq' || name.startsWith('qq-') || name.startsWith('qqbot')
}

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

/**
 * 读出图片的**真实像素尺寸** —— md 里的 `#宽px #高px` 就靠它。
 *
 * 不引第三方库：卡片是 JPEG、图集是 JPEG、二维码是 PNG、实况图封面是 WebP，四种头都自己认，
 * 免得又出现「取不到尺寸 → 正方形拉伸」或「没写尺寸 → 手机不显示」。
 */
const readImageSize = (buffer: Buffer): { width: number; height: number } => {
  // PNG：IHDR 就在固定偏移
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer.toString('latin1', 1, 4) === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  // GIF：逻辑屏幕描述符，小端
  if (buffer.length >= 10 && buffer.toString('latin1', 0, 3) === 'GIF') {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
  }
  // JPEG：扫到 SOF 段（SOF0..SOF15，跳过 DHT/DAC 这些非 SOF 标记）
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue }
      const marker = buffer[offset + 1]
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
      }
      const length = buffer.readUInt16BE(offset + 2)
      if (length <= 0) break
      offset += 2 + length
    }
  }
  // WebP：VP8X（扩展）/ VP8L（无损）/ VP8（有损）三种头的写法都不一样
  if (buffer.length >= 30 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
    const format = buffer.toString('latin1', 12, 16)
    if (format === 'VP8X') {
      return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) }
    }
    if (format === 'VP8L') {
      const bits = buffer.readUInt32LE(21)
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
    }
    if (format === 'VP8 ') {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
    }
  }
  return { width: 0, height: 0 }
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
  if (!list.some(isImageElement)) return list
  if (list.some((element) => ATTACHMENT_TYPES.has(String(element?.type ?? '')))) return list

  const out: any[] = []
  /** 攒着的连续图片（遇到非图片段就冲出去） */
  let run: string[] = []
  const flushRun = () => {
    // 有图转不动（上传失败等）时 run 里会是空串占位，这里只冲有内容的
    if (run.length) out.push(segment.markdown(run.join(String.fromCharCode(10))))
    run = []
  }

  for (const element of list) {
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
