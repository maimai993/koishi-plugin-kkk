/**
 * QQ 平台的「解析交互面板」（Markdown + 原生按钮）。
 *
 * ## 为什么要面板
 * QQ 侧解析的默认行为是「发链接 → 直接按配置的画质解析」：用户既改不了画质，
 * 也换不了「要不要带弹幕」。而 QQ 官方 bot 支持 Markdown + 按钮，
 * 于是这里在解析**之前**插一步：把可选内容和画质列出来，点一下按钮再真正解析。
 *
 * ## 体积限制
 * QQ 富媒体上传有硬限制：视频 mp4 软限制 30MB、硬限制 200MB，
 * 超过软限制会**降级成文件**发送，超过硬限制直接报错 850031。
 * 所以超过 \`qqFileLimitMB\`（默认 200）的画质**不生成按钮** —— 点了也发不出去；
 * 介于软/硬限制之间的档位会带一个 📄 标记，提示「会以文件形式发送」。
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_files.post.html
 *
 * ## 无状态
 * 面板本身不记录任何会话状态：用户的选择全部编码在按钮的 data 里（画质、要不要烧弹幕都是参数），
 * 重启 / 多实例 / 重复点击都不会串状态。
 *
 * 「烧录弹幕」那一列出不出现由**配置**决定（见 DanmakuPolicy），面板里没有开关按钮：
 * 关着就只有「清晰度 / 大小」两列，用户点哪个都是纯视频。
 */
import { logger, segment, withoutForwardCollect, type Message } from 'node-karin'
import fs from 'node:fs'

import { commandInvocation, tryGetRuntime } from '../../../compat/runtime'
import { getParseOverride } from './ParseOverride'
import { isBurnDanmakuSupported } from './DanmakuPolicy'
import { resolvePlayerSizeLimitMB } from '../../../player'
import { Config } from './Config'
import { getDouyinQualityLevel } from '@/platform/douyin/videoQuality'
import { platformOf } from '@/module/utils/ImageSlice'
import { cardImageKeyOf, recallCardImages, rememberCardImages, rememberLastCardKey } from '@/module/utils/CardImageCache'
import { getImageMetadata, Render } from '@/module/utils/Render'
import { isUsableSize, readImageSize, scaleToWidth } from '../../../compat/imageSize'
import { getHotDanmaku } from '@/platform/bilibili/danmaku'
// 头像框 / 昵称颜色要从 UP 主页接口拿，和解析结果保持一致；简介同样走解析那边的统一口径
import { buildVideoDescRichText, getUsernameMetadata } from '@/platform/bilibili/dynamic-text'
// 抖音卡片复用推送那套构建器（保真度最高）
import { renderWorkImage } from '@/platform/douyin/push/render'

import { bilibiliFetcher, douyinFetcher } from './amagiClient'

/** 面板请求 */
export interface PanelRequest {
  platform: 'bilibili' | 'douyin'
  /** 规范链接（会写进按钮指令里，点一次就是一条完整命令） */
  url: string
  /** 平台作品 ID（B站 bvid / 抖音 aweme_id） */
  id: string
  /** B站分P */
  page?: number
  /**
   * **用户消息里原样提取出来的那条链接**，只用在「复制后打开 XX 自动跳转」里。
   *
   * 之前跳转块用的是这边构造的链接（`www.douyin.com/video/<id>`、带一长串参数的分享链接…），
   * 实测**太长 App 剪贴板不认**，而用户发的那条（通常是 App 分享出来的短口令链接）
   * 反而是 App 自家生成的、一定能识别。没有时退回 `url`。
   */
  jumpUrl?: string
}

/** 一个可选画质 */
interface QualityOption {
  /** 平台画质标识（B站 qn / 抖音档位名） */
  id: string
  /** 按钮文案 */
  label: string
  /** 预估体积（MB） */
  sizeMB: number
}

/** 面板要展示的作品信息 */
interface PanelInfo {
  title: string
  author: string
  duration: string
  options: QualityOption[]
  /** 原始作品详情（B站：给面板卡片渲染用） */
  detail?: any
  /** 热门弹幕（面板卡片和解析结果保持同一张图） */
  hotDanmaku?: any[]
}

/**
 * B站画质标识 → 文案。
 * 只留分辨率本身（「高清 / 清晰 / 流畅 / 超清」这类形容词按需求去掉了），
 * 60 帧、HDR、杜比这些是画质差异本身，保留。
 */
const BILI_QN_LABEL: Record<number, string> = {
  6: '240P',
  16: '360P',
  32: '480P',
  64: '720P',
  74: '720P60',
  80: '1080P',
  112: '1080P+',
  116: '1080P60',
  120: '4K',
  125: 'HDR',
  126: '杜比视界',
  127: '8K'
}

/** 抖音档位 → 文案 */
const DY_LABEL: Record<string, string> = {
  '4k': '4K',
  '2k': '2K',
  '1080p': '1080P',
  '720p': '720P',
  '540p': '540P'
}

/** QQ 富媒体「软限制」：视频超过 30MB 会降级成文件发送 */
const QQ_SOFT_LIMIT_MB = 30

/**
 * 面板按钮里的「挂起请求」。
 *
 * 按钮发出去的是**指令文本**（QQ 的指令按钮会把 data 当作用户消息发出来），
 * 所以不能把链接直接塞进去：又长、又会把链接刷到群里、还可能撞上平台的字段长度限制。
 * 这里改成一个短令牌，真实链接只留在插件内存里：
 *   \`解析 --p=a1b2c3 --qn=80\` → 解析时用令牌换回链接。
 */
interface PendingRequest extends PanelRequest {
  at: number
  /** 各档画质的预估体积（MB）：解析时用来判断「会不会超过 30MB 变成文件发送」 */
  sizes?: Record<string, number>
}

const pendingRequests = new Map<string, PendingRequest>()
const PENDING_TTL = 30 * 60 * 1000

/**
 * 记住一次面板请求并返回短令牌。
 * 同一个作品复用同一个令牌，避免用户反复点面板把表撑爆。
 * @param request 面板请求（含规范链接）
 */
export function rememberPanelRequest (request: PanelRequest, sizes?: Record<string, number>): string {
  const now = Date.now()
  for (const [token, item] of pendingRequests) {
    if (Date.now() - item.at > PENDING_TTL) { pendingRequests.delete(token); continue }
    if (item.url === request.url) {
      item.at = now
      if (sizes) item.sizes = sizes
      return token
    }
  }
  const token = Math.random().toString(36).slice(2, 8)
  pendingRequests.set(token, { ...request, at: now, sizes })
  return token
}

/** 取某一档画质的预估体积（MB）；拿不到返回 0 */
export function resolvePanelQualitySize (token: string | undefined, quality: string | number | undefined): number {
  if (!token || quality === undefined) return 0
  const item = pendingRequests.get(token)
  const size = item?.sizes?.[String(quality)]
  return Number.isFinite(size) ? Number(size) : 0
}

/**
 * 令牌 → 规范链接。过期的令牌返回空串（此时按「没找到链接」处理即可）。
 * @param token 令牌
 */
export function resolvePanelToken (token: string | undefined): string {
  if (!token) return ''
  const item = pendingRequests.get(token)
  if (!item) return ''
  if (Date.now() - item.at > PENDING_TTL) {
    pendingRequests.delete(token)
    return ''
  }
  item.at = Date.now()
  return item.url
}

/** 面板信息缓存（点「＋弹幕」会重新渲染面板，没必要再打一次接口） */
const infoCache = new Map<string, { at: number; info: PanelInfo | null }>()
const INFO_TTL = 5 * 60 * 1000

/** 是否 QQ 平台（官方适配器 platform 为 qqguild / qq / qqbot） */
export function isQqPlatform (e: Message): boolean {
  const platform = String(e?.bot?.adapter?.name ?? e?.bot?.adapter?.protocol ?? '')
  return /qqguild|qqbot|^qq$|official/i.test(platform)
}

/** 秒 → mm:ss / hh:mm:ss */
const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours ? hours + ':' + pad(minutes) + ':' + pad(secs) : pad(minutes) + ':' + pad(secs)
}

/** 拉取 B站作品信息与可选画质 */
async function fetchBilibiliInfo (request: PanelRequest): Promise<PanelInfo | null> {
  // 用模块级 fetcher（= AmagiBase 包装过的那一层）：它会在失败信封上抛错，
  // 拿到的就是 `{ success, data: { code, data: 稿件 } }` 这层形状，与平台解析代码一致
  const infoResponse: any = await bilibiliFetcher.fetchVideoInfo({ bvid: request.id })
  const detail: any = infoResponse?.data?.data
  if (!detail) return null

  const page = request.page
  const cid = page ? (detail.pages?.[page - 1]?.cid ?? detail.cid) : detail.cid
  const duration = Number(page ? (detail.pages?.[page - 1]?.duration ?? detail.duration) : detail.duration) || 0

  /**
   * 面板卡片要和「解析结果」那张一模一样 —— 解析结果带热门弹幕（就是卡片顶部那些飘过去的文字），
   * 面板阶段也拉一份，用户选清晰度时看到的就是最终卡片。
   */
  let hotDanmaku: any[] = []
  try {
    const segments = Math.max(1, Math.ceil(duration / 360))
    const lists = await Promise.all(Array.from({ length: segments }, (_, index) =>
      bilibiliFetcher.fetchVideoDanmaku({ cid, segment_index: index + 1 })
        .then((response: any) => response?.data?.data?.elems || [])
        .catch(() => [])
    ))
    hotDanmaku = getHotDanmaku(lists.flat() as any, 20)
  } catch (error) {
    logger.debug('[QQ面板] 拉取热门弹幕失败: ' + String(error))
  }

  const playResponse: any = await bilibiliFetcher.fetchVideoStreamUrl({ avid: detail.aid, cid })
  const stream: any = playResponse?.data?.data
  const options: QualityOption[] = []

  if (Array.isArray(stream?.dash?.video) && stream.dash.video.length) {
    // 音频是独立流，最终要么合流要么单独下载，体积算进去才不会低估
    const audioBandwidth = Number(stream.dash.audio?.[0]?.bandwidth) || 0
    const seen = new Set<number>()
    for (const item of stream.dash.video) {
      const qn = Number(item?.id)
      if (!qn || seen.has(qn)) continue
      seen.add(qn)
      // dash 只给带宽（bit/s），体积按 带宽 × 时长 估算 —— 精确定长要额外发 HEAD 请求，面板阶段不值得
      const sizeMB = ((Number(item.bandwidth) || 0) + audioBandwidth) * duration / 8 / 1024 / 1024
      options.push({ id: String(qn), label: BILI_QN_LABEL[qn] ?? (qn + 'P'), sizeMB })
    }
  } else if (Array.isArray(stream?.durl) && stream.durl.length) {
    // 未登录时只有 durl（免登录 360P），体积字段是精确字节数
    const qn = Number(stream.quality) || 16
    options.push({
      id: String(qn),
      label: BILI_QN_LABEL[qn] ?? '360P 流畅',
      sizeMB: (Number(stream.durl[0]?.size) || 0) / 1024 / 1024
    })
  }

  options.sort((left, right) => right.sizeMB - left.sizeMB)
  return {
    title: String(detail.title ?? ''),
    author: String(detail.owner?.name ?? ''),
    duration: formatDuration(duration),
    options,
    detail,
    hotDanmaku
  }
}

/** 拉取抖音作品信息与可选画质 */
async function fetchDouyinInfo (request: PanelRequest): Promise<PanelInfo | null> {
  const workResponse: any = await douyinFetcher.parseWork({ aweme_id: request.id })
  const detail: any = workResponse?.data?.aweme_detail
  if (!detail) return null

  const awemeType = Number(detail.aweme_type)
  const isVideo = awemeType === 0 || awemeType === 55
  if (!isVideo) return null

  const best = new Map<string, any>()
  for (const item of (detail.video?.bit_rate ?? []) as any[]) {
    if (item?.format !== 'mp4') continue
    const level = getDouyinQualityLevel(item)
    if (!level) continue
    const prev = best.get(level)
    // 同档位优先 H.264（兼容性），其次体积更大的那路源
    const better = !prev ||
      (Number(prev.is_bytevc1) - Number(item.is_bytevc1)) > 0 ||
      (Number(prev.is_bytevc1) === Number(item.is_bytevc1) && Number(item.play_addr?.data_size) > Number(prev.play_addr?.data_size))
    if (better) best.set(level, item)
  }

  const options: QualityOption[] = [...best.entries()].map(([level, item]) => ({
    id: level,
    label: DY_LABEL[level] ?? level,
    sizeMB: (Number(item.play_addr?.data_size) || 0) / 1024 / 1024
  }))
  options.sort((left, right) => right.sizeMB - left.sizeMB)

  return {
    title: String(detail.desc ?? ''),
    author: String(detail.author?.nickname ?? ''),
    duration: formatDuration(Number(detail.video?.duration) / 1000),
    options,
    // 抖音卡片用：renderWorkImage 需要原始的 aweme_detail
    detail
  }
}

/** 带缓存地拉取面板信息（失败也缓存，避免用户在坏链接上连点） */
async function fetchPanelInfo (request: PanelRequest): Promise<PanelInfo | null> {
  const key = request.platform + ':' + request.id + ':' + (request.page ?? '')
  const cached = infoCache.get(key)
  if (cached && Date.now() - cached.at < INFO_TTL) return cached.info
  try {
    const info = request.platform === 'bilibili' ? await fetchBilibiliInfo(request) : await fetchDouyinInfo(request)
    infoCache.set(key, { at: Date.now(), info })
    if (infoCache.size > 64) infoCache.delete(infoCache.keys().next().value as string)
    return info
  } catch (error) {
    logger.debug('[QQ面板] 拉取作品信息失败: ' + String(error))
    infoCache.set(key, { at: Date.now(), info: null })
    return null
  }
}

/**
 * 生成一个 QQ **markdown 内联指令按钮**。
 *
 * 官方支持两种指令标签（见「文本交互」文档）：
 *   - \`<qqbot-cmd-enter text="xxx" />\`：点击后**直接发送**，但**群聊不支持**；
 *   - \`<qqbot-cmd-input text="xxx" show="xxx" reference="false" />\`：点击后把文本插进输入框（群聊可用）。
 * 群聊场景只有后者能用，所以面板用 \`cmd-input\`：\`text\` 是真正发出去的命令，
 * \`show\` 是用户在消息里看到的文字，两者都要 urlencode。
 *
 * 用内联按钮而不是原生 keyboard 的另一个好处：不用再和适配器的 \`render_data\` 属性名较劲
 * （Koishi 的 \`h()\` 会把属性 camelize，按钮文字曾经因此变成一整条指令）。
 * @param command 点击后发送的指令文本
 * @param show 展示文字（默认同 command）
 */
/**
 * QQ markdown 里「点一下就跳转」的链接。
 *
 * **只能用普通 markdown 链接**：上游推送里写的是
 * `mqqapi://forward/url?version=1&src_type=web&url_prefix=<编码后的地址>`，
 * 但 QQ 官方接口会**直接拒收**这种自定义 scheme —— 这台部署实测报
 * `[40034028] 请求参数不允许包含url mqqapi://forward/url`，
 * 而且是**整条消息**都发不出去（不只是链接点不动），面板、解析全被连累。
 * 同一条消息里的卡片图用的是 `![](https://…)`，说明 markdown 里的 https 链接是被接受的。
 * 空地址返回空串，调用方判空即可。
 * @param label 用户看到的文字
 * @param url 目标地址
 */
export function sourceLink (label: string, url: string): string {
  if (!url) return ''
  // 括号和空白会破坏 markdown 链接语法，编码掉
  const safe = String(url).replace(/[()\s]/g, (char) => encodeURIComponent(char))
  return '[' + label + '](' + safe + ')'
}

/**
 * 「复制后打开 XX 自动跳转」代码块：
 *
 * ```复制后打开b站自动跳转 →
 * https://b23.tv/BV…
 * ```
 *
 * 提示文案放在**围栏的信息位**（` ``` ` 后面那段，也就是 markdown 写语言的地方），
 * 不占正文一行 —— 代码块里只有那条链接，全选复制时不会带上多余文字，
 * 渲染出来提示仍是显示在代码块顶上的。
 *
 * 不用 `[打开原站](url)` 是因为那种链接能不能点取决于 adapter —— 官方 QQ 接口实测会拒收
 * （见 `sourceLink` 的说明）。而各家 App 都认「剪贴板里有一条自家链接」：
 * 复制整段文本后打开 App 会弹出打开询问，比点链接稳。
 * @param appName App 名字，写进提示文案里（b站 / 抖音）
 * @param url 目标地址（放进代码块的是纯文本，不做 markdown 编码）
 * @returns 代码块的行数组；没地址时是空数组，调用方直接展开即可
 */
/**
 * 抖音 App 的唤起口令。
 *
 * 抖音认的是「剪贴板里有一段带口令的文本」：光有一条链接，App 不一定弹跳转询问，
 * 链接后接着这段口令才能保证复制后打开抖音直达作品。
 * 这是抖音 App 生成的固定串（每条作品都一样，接口里没有对应字段），别当成模板去替换。
 */
const DOUYIN_JUMP_TOKEN = ':1pm Mai:/ 2237886846@qq.com'

/**
 * @param appName App 名字，写进提示文案里（b站 / 抖音）
 * @param url 目标地址（放进代码块的是纯文本，不做 markdown 编码）
 * @param tail 追加在链接后面的文字（抖音的唤起口令走这里）
 */
export function copyJumpBlock (appName: string, url: string, tail = ''): string[] {
  if (!url) return []
  // 链接和口令之间留两个空格：抖音的口令是独立一段，贴着链接会被当成 URL 的一部分
  // 提示末尾的箭头指向代码块右上角的「复制」按钮 —— 复制的是整段（这里只有链接），App 才会跳转
  return ['```' + '复制后打开' + appName + '自动跳转 →', String(url) + (tail ? '  ' + tail : ''), '```']
}

/**
 * 抖音作品的分享链接（**给卡片右下角二维码用的**）。
 *
 * 优先取接口返回的 `share_url`：那是抖音 App 生成的分享链接，后面带一串参数，
 * 扫码场景没问题（二维码不吃 URL 长度），比自己拼的裸链接更接近官方形态；
 * 拿不到（接口改版 / 风控）才退回标准链接。
 *
 * 注意它**不适合作为「复制跳转」的链接** —— 参数太长，App 的剪贴板识别不了，
 * 那种场景要用用户原样发的那条（见 `sendParsePanel` 里 `request.jumpUrl`）。
 * @param awemeId 作品 id
 * @param detailShareUrl 作品详情里的 `share_url`
 */
export function douyinShareUrl (awemeId: string, detailShareUrl?: string): string {
  return String(detailShareUrl ?? '') || ('https://www.douyin.com/video/' + String(awemeId))
}

/**
 * B站的跳转链接：**固定用标准视频页** `https://www.bilibili.com/video/<bvid>`。
 *
 * 试过 b23.tv 短链（`https://b23.tv/<bvid>`），实测 B站 App 认不出来 —— 复制后打开 App
 * 没反应，必须是完整的 `www.bilibili.com/video/BV…` 这种形态。分 P 走 `?p=N` 查询参数。
 *
 * 卡片右下角的二维码也走这条（扫码不受长度影响，和跳转块保持一致）。
 * @param bvid BV 号
 * @param page 分 P（1 表示第一 P，不用带参数）
 */
export function bilibiliShareUrl (bvid: string, page?: number): string {
  const url = 'https://www.bilibili.com/video/' + String(bvid)
  return page && page > 1 ? url + '?p=' + page : url
}

/** 快手作品页链接（App 认的是自家域名下的链接，短链最终也是跳到这里） */
export function kuaishouShareUrl (photoId: string): string {
  return 'https://www.kuaishou.com/short-video/' + String(photoId)
}

/**
 * 小红书笔记页链接。
 *
 * 和详情卡片的二维码**逐字符对齐**（含 `xsec_token` 那串参数）——
 * 卡片那儿一直是这么拼的，跳转块换用同一个函数即可，别再单独拼一遍。
 * @param noteId 笔记 id
 * @param xsecToken 访问令牌；没有就退回到不带参数的短形式
 */
export function xiaohongshuShareUrl (noteId: string, xsecToken = ''): string {
  const base = 'https://www.xiaohongshu.com/discovery/item/' + String(noteId)
  return xsecToken
    ? base + '?source=webshare&xhsshare=pc_web&xsec_token=' + String(xsecToken) + '&xsec_source=pc_share'
    : base
}

/**
 * **能真正渲染 markdown 的平台** —— 只有官方 QQ 和 QQ 频道，别的一律发纯文本。
 *
 * 白名单而不是黑名单：markdown 是腾讯那两个 adapter 的私货，
 * OneBot（NapCat / Lagrange / go-cqhttp / Chronocat）、Discord、Telegram、KOOK…
 * 都不认这东西。代码块的 ` ``` ` 围栏在它们那里会原样露出来，
 * 用户看到的是一串反引号而不是代码块。
 *
 * 这些平台发**去围栏的纯文本**：提示一行 + 链接一行，照样能整段复制，App 一样认。
 * @param platform `platformOf(e)` 拿到的适配器名
 */
export const supportsMarkdown = (platform: string): boolean => {
  const name = String(platform ?? '').toLowerCase()
  return name === 'qq' || name === 'qqguild'
}

/**
 * **没有清晰度面板的平台**：单独发一条「复制后打开 XX 自动跳转」。
 *
 * B站 / 抖音那条 repeat 代码块挂在清晰度表格下面（`sendParsePanel`），
 * 而快手、小红书压根没有可选画质的面板——本来也不发任何原站链接。
 * 这里给它们补一条同格式的独立消息，行为和开关都跟面板里的那行一致。
 *
 * 发送失败**不影响解析**：跳转是锦上添花，主流程（卡片 / 图片 / 视频）都已经发出去了。
 * @param appName App 名字（快手 / 小红书）
 * @param url 目标地址；空则直接跳过
 * @param tail 追加在链接后面的文字（抖音走 QqPanel 内部的口令，其它平台不用）
 * @returns 是否发出去了
 */
export async function sendCopyJumpMessage (
  e: Message,
  appName: string,
  url: string,
  tail = ''
): Promise<boolean> {
  if (!url) return false
  if (tryGetRuntime()?.config.qqPanelSourceLink === false) return false

  const lines = copyJumpBlock(appName, url, tail)
  /**
   * 去掉围栏就是同内容的纯文本 —— 给不渲染 markdown 的适配器兜底。
   * 提示行现在是 ``` 开头的（信息位写法），去掉 ``` 正好还原成一句提示。
   */
  const plain = lines
    .map((line) => (line.startsWith('```') ? line.slice(3) : line))
    .filter(Boolean)
    .join(String.fromCharCode(10))
  const content = supportsMarkdown(platformOf(e))
    ? segment.markdown(lines.join(String.fromCharCode(10)))
    : plain
  try {
    await e.reply(content)
    return true
  } catch (error: any) {
    /**
     * 官方 QQ 有时因为消息里的链接形式拒收整条 markdown（见 `sourceLink` 的说明），
     * 这里退回纯文本再试一次；连纯文本都发不出去就跳过，不影响主流程。
     */
    logger.debug('[原站跳转] ' + appName + ' markdown 发送失败，退回纯文本: ' + String(error?.message ?? error).slice(0, 120))
    try {
      await e.reply(plain)
      return true
    } catch (retryError: any) {
      logger.warn('[原站跳转] ' + appName + ' 发送失败，已跳过: ' + String(retryError?.message ?? retryError).slice(0, 120))
      return false
    }
  }
}

export function cmdInput (command: string, show?: string): string {
  const text = encodeURIComponent(command).replace(/'/g, '%27')
  const label = encodeURIComponent(show ?? command).replace(/'/g, '%27')
  return '<qqbot-cmd-input text="' + text + '" show="' + label + '" reference="false" />'
}

/**
 * 从作品详情里取封面地址（两个平台的字段不一样）。
 *
 * B站是 `pic`；抖音视频在 `video.cover.url_list[0]`（动图封面 `animated_cover` 优先），
 * 图文 / 文章没有 video，取 `images[0].url_list[0]`。
 * @param platform 平台
 * @param detail 作品详情（面板拿到的那份）
 */
function panelCoverUrl (platform: string, detail: any): string {
  if (!detail) return ''
  if (platform === 'bilibili') return String(detail.pic ?? '')
  return String(
    detail.video?.animated_cover?.url_list?.[0] ??
    detail.video?.cover?.url_list?.[0] ??
    detail.images?.[0]?.url_list?.[0] ??
    ''
  )
}

/**
 * 当前适配器能不能发 **QQ 原生按钮**（keyboard 上那种方块按钮，不是 markdown 里的蓝字）。
 *
 * 原生按钮要靠适配器的 `button` 元素落到消息的 `keyboard` 字段上，
 * 官方 `@koishijs/plugin-adapter-qq` **没实现**（发过去只会变成一段普通文本，按钮没了），
 * 只有接了原生能力的适配器（比如 `adapter-qq-crack`）才有。所以这里先探一下：
 *   - 适配器名对得上就直接用；
 *   - 再退一步看内部 API —— 会处理 `INTERACTION_CREATE` 的适配器才会实现
 *     `acknowledgeInteraction`，有它就说明按钮回调这条路是通的。
 * 探不到就退回 markdown 的 `<qqbot-cmd-input>`（那个是**文字链**，QQ 上显示成蓝色链接）。
 * @param e 消息事件 / `{ bot }`
 */
export function supportsKeyboardButton (e: any): boolean {
  const bot = e?.bot ?? e?.session?.bot
  const inner = bot?.bot ?? bot
  const name = String(bot?.adapter?.name ?? inner?.adapter?.name ?? '')
  if (name === 'adapter-qq-crack' || name.includes('crack')) return true
  /** crack 专属能力（它 README 里列的 `bot.refreshBotGroupState`），比猜名字稳 */
  if (typeof (bot?.refreshBotGroupState ?? inner?.refreshBotGroupState) === 'function') return true
  return typeof (bot?.internal ?? inner?.internal)?.acknowledgeInteraction === 'function'
}

/** 「把封面图单独发一遍」的指令 */
export const EXTRACT_COVER_COMMAND = 'kkk封面'
/** 「把评论区那张长图单独发一遍」的指令 */
export const EXTRACT_COMMENT_COMMAND = 'kkk评论'

/**
 * 这张卡片下面那个按钮**真的点得出东西吗**。
 *
 * 用户反馈：「**评论区没有图片就不要显示按钮了**」—— 按钮点下去是把缓存里的图
 * 单独发一遍（见 `CardImageCache`），缓存里没这张图时它就是个**点了没反应**的摆设：
 *   - `cover`：这个作品本来就没有封面（比如纯文字动态）；
 *   - `comment`：「提取评论区图片」要的是**评论里用户自己贴的图**（`commentPics`，
 *     和 `apps/tools.ts` 里点击处理的口径一致）—— 一条评论都没贴图时 `commentPics` 是空的，
 *     而那张**渲染出来的评论长图**（`comment`）卡片本身已经发过一遍了，
 *     再挂个按钮去重发一遍没有意义。
 *
 * 所以**没有图就不挂按钮**，宁缺毋滥。拿不到作品键（`key` 为空）时同样不放行。
 *
 * 注意：这要求调用方**先 `rememberCardImages`、再挂按钮**（各平台的调用点都是这个顺序）。
 * @param key 作品缓存键（{@link cardImageKeyOf}）
 * @param kind 哪个按钮
 * @returns 该按钮是否有东西可发
 */
export function hasCardImage (key: string | undefined, kind: 'cover' | 'comment'): boolean {
  /** 没有作品 id 就不挂按钮：点了也不知道该发哪张图 */
  if (!key) return false
  const cached = recallCardImages(key)
  if (!cached) return false
  if (kind === 'cover') return !!cached.cover
  return !!cached.commentPics?.length
}

/**
 * 卡片下面的「提取」按钮 —— **QQ 原生按钮**（`action.type = 1`，回调按钮）。
 *
 * 和 markdown 的 `<qqbot-cmd-input>`（蓝字文字链）不是一回事：原生按钮是挂在消息下方的
 * 方块按钮，点了直接把 `data` 回调给机器人，走 `interaction/button` 事件
 * （`src/index.ts` 里那条监听会把它当成一条指令跑掉），
 * **不会**往输入框塞文本、也不用用户再点一次发送。
 * @param e 消息事件（适配器探测用；原生按钮不区分平台，探测不通过时由调用方退回文字链）
 * @param options 要哪几个按钮；`key` 是作品缓存键，会拼进回调 data
 * @returns 按钮元素数组
 */
export function cardImageButtons (
  e: any,
  options: { cover?: boolean, comment?: boolean, key?: string } = {}
): any[] {
  const wanted: Array<{ command: string, label: string, id: string }> = []
  if (options.cover && hasCardImage(options.key, 'cover')) wanted.push({ command: EXTRACT_COVER_COMMAND, label: '提取封面图', id: 'kkk-extract-cover' })
  if (options.comment && hasCardImage(options.key, 'comment')) wanted.push({ command: EXTRACT_COMMENT_COMMAND, label: '提取评论区图片', id: 'kkk-extract-comment' })
  /** 没有图 / 没有作品 id 就不挂按钮：点了也不知道该发哪张图（见 {@link hasCardImage}） */
  if (!wanted.length || !options.key) return []
  return wanted.map((item) => segment.button({
    id: item.id,
    /**
     * 按钮**显示的名字只有中文那几个字**（`提取封面图` / `提取评论区图片`）。
     * 作品参数只放在 `action.data` 里，那是点击后回调给机器人的**载荷**，用户看不见。
     * `label` / `text` 两个别名也一起给上：适配器取名的回退链是
     * `render_data.label → 子元素文本 → attrs.text → action.data`，
     * 多给两层兜底，免得哪天 render_data 没透传时按钮把整串指令显示出来。
     */
    label: item.label,
    text: item.label,
    render_data: { label: item.label, visited_label: item.label, style: 1 },
    action: {
      /** 1 = 回调按钮：点了把 data 回调给后台，不往输入框塞文本 */
      type: 1,
      permission: { type: 2 },
      data: item.command + ' ' + options.key,
      /** `enter` 是指令按钮用的，回调按钮关掉，免得两种投递都触发、图发两遍 */
      enter: false,
      reply: false
    }
  }))
}

/**
 * **推送 / 转发类消息下面的「解析」按钮**。
 *
 * 定时推送出来的动态、作品卡片里带着链接，但**自动解析没开时**没人会去解析它
 * ——用户看到的就是一张图。这里在卡片下面给一个「解析」按钮，点一下即按这条链接解析。
 *
 * 和 {@link cardImageActions} 同一套口径：**只有 QQ / QQ 频道有按钮**，
 * 其它平台给文字提示，照着「引用这条消息发送 `解析 <链接>`」操作即可。
 * @param e 消息事件 / bot 所在上下文（用来判断平台）
 * @param url 要解析的链接；空则不追加任何东西
 * @returns 追加到卡片后面的元素
 */
export function parseCommandActions (e: any, url: string): any[] {
  if (!url) return []
  const command = '解析 ' + String(url)
  /** 同卡片提取按钮：能用原生按钮就用原生按钮（回调，点了直接解析） */
  if (supportsKeyboardButton(e)) {
    return [segment.button({
      id: 'kkk-push-parse',
      /** 同上：按钮只显示「解析」，链接是点击后回调给机器人的载荷 */
      label: '解析',
      text: '解析',
      render_data: { label: '解析', visited_label: '解析', style: 1 },
      action: { type: 1, permission: { type: 2 }, data: command, enter: false, reply: false }
    })]
  }
  if (supportsMarkdown(platformOf(e))) {
    /**
     * 前面**必须带换行**：这里是作为独立元素拼在卡片（图片 / markdown）后面的，
     * 渲染时是直接续写在卡片内容末尾，不加换行按钮会**粘在图片那一行后面**，
     * 既难看也容易被当成上一行的正文。
     */
    return [segment.markdown(String.fromCharCode(10) + cmdInput(command, '解析'))]
  }
  return [segment.text(String.fromCharCode(10) + '引用这条消息发送「' + command + '」即可解析')]
}

/**
 * 「提取封面图 / 提取评论区图片」那一行**纯文本**（markdown 写法）。
 *
 * 面板、卡片这类消息本身就是 markdown 文本，要的是**拼在图片下面的一行**，
 * 而不是一个独立的元素 —— 用这个拼进去才能和图片在同一条消息里（见 {@link cardImageActions}）。
 * @param e 消息事件（用来判断平台）
 * @param options 要哪几个按钮
 * @returns markdown 文本行；不需要按钮时是空串，调用方判空即可
 */
export function cardImageActionLine (
  e: any,
  options: { cover?: boolean, comment?: boolean, key?: string } = {}
): string {
  const wanted: Array<{ command: string, label: string }> = []
  if (options.cover && hasCardImage(options.key, 'cover')) wanted.push({ command: EXTRACT_COVER_COMMAND, label: '提取封面图' })
  if (options.comment && hasCardImage(options.key, 'comment')) wanted.push({ command: EXTRACT_COMMENT_COMMAND, label: '提取评论区图片' })
  if (!wanted.length) return ''
  /**
   * **指令必须带作品参数**（`kkk封面 bilibili:BV1JSan6GEFW`）。
   *
   * 不带参数就只能「取本会话最近解析过的作品」，而群里在你点按钮之前**可能已经又发了别的链接**
   * —— 那时点老卡片下面的按钮，发出来的是另一个作品的图。带上参数就永远点对。
   */
  const withKey = (command: string) => options.key ? command + ' ' + options.key : command
  if (supportsMarkdown(platformOf(e))) {
    return wanted.map((item) => cmdInput(withKey(item.command), item.label)).join(' ')
  }
  return wanted.map((item) => '引用这条消息发送「' + withKey(item.command) + '」可' + item.label).join('；')
}

/**
 * **卡片图下面的「提取」按钮**。
 *
 * 卡片在 QQ 上是 markdown 图片，几张图叠在一条消息里，想单独存封面 / 单独看评论区长图很不方便。
 * 这里在卡片下面给两个按钮，点一下把对应的那张图**单独发一遍**（不重新解析、不重新渲染，
 * 图源取自 `CardImageCache`）。
 *
 * **按钮就在图片下面、同一条消息里**：返回的是**追加元素**，调用方把它和图片放在同一个
 * 数组里一起 reply（详情卡片、评论区卡片都是这么干的）；面板那种纯 markdown 文本的，
 * 改用 {@link cardImageActionLine} 拿按钮行拼进文本。
 *
 * **只有 QQ / QQ 频道有按钮**（markdown 是它们才有的东西，见 `supportsMarkdown`）。
 * 其它平台给的是一句**文字提示**：它们没有按钮可点，只能「引用这条消息 + 发指令」——
 * 提示里把指令名写全，用户照着发就行。
 * @param e 消息事件（用来判断平台）
 * @param options 这张卡片下面要哪几个按钮
 * @returns 追加到卡片后面的元素（没要按钮就是空数组，调用方直接展开即可）
 */
export function cardImageActions (
  e: any,
  options: { cover?: boolean, comment?: boolean, key?: string } = {}
): any[] {
  /** 适配器支持原生按钮就用原生按钮：方块按钮 + 点击直接回调，比文字链好用得多 */
  if (supportsKeyboardButton(e)) return cardImageButtons(e, options)
  const line = cardImageActionLine(e, options)
  if (!line) return []
  /**
   * 独立成一条时用 markdown 元素（按钮要能被 QQ 认出来）；提示文字用 text 段。
   *
   * 同样**前面带换行**：这个元素是拼在图片后面的，不加换行按钮会粘在图片那一行末尾。
   * （面板那种纯文本消息走 {@link cardImageActionLine}，它自己占一行，不要这个换行。）
   */
  return supportsMarkdown(platformOf(e))
    ? [segment.markdown(String.fromCharCode(10) + line)]
    : [segment.text(String.fromCharCode(10) + line)]
}

/**
 * 把「提取封面图 / 提取评论区图片」按钮**挂到卡片后面**（同一条消息内）。
 *
 * 卡片在 QQ 上就是一张渲染出来的图，按钮要跟它一起发出去 —— 这个 helper 负责
 * 「图片（单个元素或数组）+ 按钮」拼成一条消息的内容，调用方直接 `reply` 就行。
 *
 * **不传 key 就不挂按钮**：拿不到作品 id 的作品（比如没解析出 id 的动态）挂了也点不出东西。
 * @param e 消息事件
 * @param content 卡片本身（`Render` 的返回值，可以是单个元素也可以是数组）
 * @param key 作品缓存键（{@link cardImageKeyOf}）
 * @param options 要哪几个按钮
 * @returns 一条消息的内容（数组）
 */
export function withCardActions (
  e: any,
  content: any,
  key: string,
  options: { cover?: boolean, comment?: boolean } = {}
): any[] {
  const list = Array.isArray(content) ? [...content] : [content]
  if (!key) return list
  return [...list, ...cardImageActions(e, { ...options, key })]
}

/* ------------------------------------------------------------------ *
 * 上一条面板消息的撤回
 *
 * 面板是「一步步点」的：选集 → 选清晰度 → 下载。每点一步群里就多一条面板，
 * 几步下来满屏都是面板。这里记住每个频道最后一条面板的消息 id，
 * 下次再操作时把它撤回（配置 `recallPanel` 控制，默认开）。
 * ------------------------------------------------------------------ */
const lastPanelMessages = new Map<string, { id: string; at: number }>()
const LAST_PANEL_TTL = 30 * 60 * 1000

/**
 * 记住刚刚发出的面板消息（供下一次操作撤回）。
 * 提示类消息（「检测到B站链接，开始解析」「收到请求，开始下载」「加载中…」）也用这个记，
 * 这样它们同样会在下一步被撤掉，群里不会堆一串提示。
 */
export function rememberPanelMessage (e: Message, messageId?: string) {
  if (!messageId) return
  try {
    const key = String(e.contact?.peer ?? e.channelId ?? '')
    if (!key) return
    lastPanelMessages.set(key, { id: String(messageId), at: Date.now() })
    if (lastPanelMessages.size > 128) lastPanelMessages.delete(lastPanelMessages.keys().next().value as string)
  } catch { /* 记不住也不影响功能 */ }
}

/**
 * 撤回这个频道上一条面板消息（配置关掉时什么都不做）。
 * 发送新面板之前、以及用户点完画质开始下载时都调一次。
 */
export async function recallLastPanel (e: Message): Promise<void> {
  const runtime: any = tryGetRuntime()
  if (!runtime || runtime.config?.recallPanel === false) return
  try {
    const key = String(e.contact?.peer ?? e.channelId ?? '')
    const entry = key ? lastPanelMessages.get(key) : undefined
    if (!entry) return
    lastPanelMessages.delete(key)
    if (Date.now() - entry.at > LAST_PANEL_TTL) return
    // 撤回必须带上频道号：QQ 适配器的 deleteMessage 会对 channelId 调 startsWith，
    // 传 undefined 会直接抛 TypeError（这正是一直撤不掉的原因）
    await (e.bot as any)?.recallMsg?.(entry.id, key)
  } catch (error) {
    logger.debug('[QQ面板] 撤回上一条面板失败: ' + String(error))
  }
}

/**
 * ── 「信息卡片」和「markdown 选择表」分开记、分开撤 ───────────────────────
 *
 * 用户要求：**卡片不要和「选清晰度 / 选第几集」的 markdown 一起发**，
 * 分开发并且**只撤回 markdown**（卡片留着给用户看）。
 *
 * 所以这里多一份「上一条卡片」的记录：
 *   - 选清晰度 / 翻页 / 选集时只撤 markdown（原来的 lastPanelMessages）；
 *   - **只有再发一张新卡片时**才把上一张卡片撤掉（否则番剧翻页几次群里就堆一排卡片）。
 */
const lastPanelCards = new Map<string, { id: string; at: number }>()

/** 记住刚刚发出的信息卡片（只在发新卡片时撤回） */
function rememberPanelCard (e: Message, messageId?: string) {
  if (!messageId) return
  try {
    const key = String(e.contact?.peer ?? e.channelId ?? '')
    if (!key) return
    lastPanelCards.set(key, { id: String(messageId), at: Date.now() })
    if (lastPanelCards.size > 128) lastPanelCards.delete(lastPanelCards.keys().next().value as string)
  } catch { /* 记不住也不影响功能 */ }
}

/** 撤回这个频道上一条「信息卡片」（发新卡片前调用；配置关掉撤回时什么都不做） */
async function recallLastPanelCard (e: Message): Promise<void> {
  const runtime: any = tryGetRuntime()
  if (!runtime || runtime.config?.recallPanel === false) return
  try {
    const key = String(e.contact?.peer ?? e.channelId ?? '')
    const entry = key ? lastPanelCards.get(key) : undefined
    if (!entry) return
    lastPanelCards.delete(key)
    if (Date.now() - entry.at > LAST_PANEL_TTL) return
    await (e.bot as any)?.recallMsg?.(entry.id, key)
  } catch (error) {
    logger.debug('[QQ面板] 撤回上一条卡片失败: ' + String(error))
  }
}

/** 只撤掉某条消息（例如「加载中…」），不动上面两份记录 */
async function recallMessageById (e: Message, id?: string): Promise<void> {
  if (!id) return
  try {
    await (e.bot as any)?.recallMsg?.(id, String(e.contact?.peer ?? e.channelId ?? ''))
  } catch { /* 撤不掉就留着 */ }
}

/**
 * 面板渲染比较慢（大卡片要十几秒），先回一句「加载中…」再渲染。
 * 返回这条提示的消息 id，渲染完由调用方撤回。
 */
async function showLoadingTip (e: Message): Promise<string | undefined> {
  try {
    await recallLastPanel(e)
    // 「加载中…」也是过程提示，不进合并转发
    const tip: any = await withoutForwardCollect(() => e.reply('加载中…'))
    const id = tip?.messageId
    rememberPanelMessage(e, id)
    return id
  } catch (error) {
    logger.debug('[QQ面板] 加载中提示失败: ' + String(error))
    return undefined
  }
}

/**
 * 面板里的「打开原站」链接行。
 *
 * 单独认出来是为了**发送失败时能摘掉它重发**：链接只是锦上添花，
 * 不能因为它（不同 adapter / 版本的链接限制不一样）把整条面板甚至整个解析搞挂。
 *
 * 「复制跳转」代码块（`copyJumpBlock`）也是链接行，但它跨 4 行带 ``` 围栏，
 * 按行内容匹配容易漏（漏掉围栏会把后面的文字全包进代码块），所以那几行由调用方
 * 用**下标范围**传给 `sendPanelMarkdown`。
 */
const isSourceLinkLine = (line: string): boolean => /^\[[^\]]+\]\([^)]+\)\s*$/.test(line.trim())

/**
 * 发一条 markdown 面板；**带链接失败就摘掉链接行重发一次**。
 *
 * 背景：实测某个 QQ adapter 会因为消息里的链接形式直接拒收整条消息
 * （`[40034028] 请求参数不允许包含url mqqapi://forward/url`），
 * 面板发不出去 → 解析失败 → 最后只剩一张错误卡片。这里做一层兜底：
 * 先照常发，失败且内容里确实有链接行时，去掉链接行再发一次，成功就当没事发生。
 * @param lines 面板的 markdown 行
 * @param send 真正发送的函数（第一次/重发都走它）
 * @param linkRange 「打开原站」那几行在 lines 里的下标范围 [起, 止)；
 *   不传时退回到按内容匹配 `[label](url)` 那一种写法
 * @returns 最后一次发送的结果
 */
async function sendPanelMarkdown (
  lines: string[],
  send: (content: any) => Promise<any>,
  linkRange?: [number, number]
): Promise<{ sent: any, droppedLink: boolean }> {
  try {
    return { sent: await send(segment.markdown(lines.join(String.fromCharCode(10)))), droppedLink: false }
  } catch (error: any) {
    const withoutLink = linkRange
      ? [...lines.slice(0, linkRange[0]), ...lines.slice(linkRange[1])]
      : lines.filter((line) => !isSourceLinkLine(line))
    if (withoutLink.length === lines.length) throw error
    logger.warn('[QQ面板] 带链接的面板发送失败（' + String(error?.message ?? error).slice(0, 120) + '），去掉链接行重发一次')
    return { sent: await send(segment.markdown(withoutLink.join(String.fromCharCode(10)))), droppedLink: true }
  }
}

/** 渲染完成后：撤掉「加载中…」，把新面板发出去并记下来 */
async function replaceLoadingTip (e: Message, loadingId: string | undefined, content: any): Promise<string | undefined> {
  if (loadingId) {
    try {
      await (e.bot as any)?.recallMsg?.(loadingId, String(e.contact?.peer ?? e.channelId ?? ''))
      const key = String(e.contact?.peer ?? e.channelId ?? '')
      const tracked = key ? lastPanelMessages.get(key) : undefined
      if (tracked?.id === loadingId) lastPanelMessages.delete(key)
    } catch { /* 撤不掉就留着 */ }
  }
  const sent: any = await e.reply(content)
  rememberPanelMessage(e, sent?.messageId)
  return sent?.messageId
}

/**
 * 解析流程的统一出口：**发新消息前先撤掉上一条**，再把新消息记下来。
 *
 * 从「检测到链接」→ 面板 → 开始下载 → 发送中 → 最终视频，全程群里只保留最新的一条，
 * 不会越堆越多。配置 `recallPanel` 关掉时只发不撤。
 */
export async function replyReplacing (e: Message, content: any): Promise<any> {
  const runtime: any = tryGetRuntime()
  try {
    if (runtime?.config?.recallPanel !== false) await recallLastPanel(e)
  } catch { /* 撤不掉就继续发 */ }
  /**
   * 「检测到链接，开始解析」「收到请求，开始下载」这类都是**过程提示**：
   * 照常直接发，但不参与「解析结果合并转发」（用户要求：转发里不包含过程提示）。
   */
  const sent: any = await withoutForwardCollect(() => e.reply(content))
  rememberPanelMessage(e, sent?.messageId)
  return sent
}

/**
 * 「收到请求，开始下载」这条消息 + 一个查进度的按钮。
 *
 * 按钮里带上本次任务的特征串（B站是 bvid），点它就只查**这一条**的进度，
 * 多个下载同时在跑时不会串味（下载文件名里本来就带 bvid）。
 */
export function buildDownloadTip (taskId: string, text = '收到请求，开始下载'): any {
  // 体积/文件形式的提示统一放到真正发送时的「发送中…」里（见 Base.ts），这里只给进度按钮
  const command = commandInvocation('下载进度') + (taskId ? ' ' + taskId : '')
  return segment.markdown(text + '\n' + cmdInput(command, '查询下载进度'))
}

/** 画质按钮文案：标签 + 体积，超过软限制用文字标注「文件」（不用 emoji） */
const qualityLabel = (option: QualityOption): string => {
  const size = Math.round(option.sizeMB)
  return option.label + ' ' + size + 'M' + (option.sizeMB > QQ_SOFT_LIMIT_MB ? ' 文件' : '')
}

/**
 * 「渲染出来的卡片 buffer + 公网地址」→ 可嵌进 markdown 的卡片信息。
 *
 * **尺寸必须是真量出来的**：QQ 按 `#宽px #高px` 这个框渲染图片，框的比例和原图对不上就会
 * **被拉伸**。以前这里读不出尺寸时会兜 `|| 1440` / `|| 1080`（4:3），一张 1:2 的卡片就直接变形；
 * 现在读不出就返回 null —— 这张卡不出，比出一张拉变形的图好（面板的文字表格照常在）。
 * @param buffer 卡片图的二进制
 * @param url 已上传拿到的公网地址
 */
const panelCardInfo = (buffer: Buffer, url: string): { url: string; width: number; height: number } | null => {
  const size = readImageSize(buffer)
  if (!isUsableSize(size)) {
    logger.mark('[QQ面板] 卡片图读不出尺寸，跳过这张卡（写错尺寸会把图片拉伸）')
    return null
  }
  return { url, width: size.width, height: size.height }
}

/**
 * 面板卡片的 B 站数据（`bilibili/videoInfo` 模板吃的那份）。
 *
 * ## 单独抽成函数，是为了「这张卡也得有简介」这件事能被离线测到
 *
 * 这份对象以前是内联在 {@link uploadPanelCard} 里的，其中 `desc` 被写死成 `''`。
 * 于是出现一个很隐蔽的现象：**解析卡片有简介、面板卡片永远没有**，
 * 而 QQ 上开着面板时解析卡片是**不发**的（见 bilibili.ts 的 `fromPanel` 分支），
 * 用户实际看到的每一张卡都是面板这张 —— 修了解析那边的简介，
 * 用户这边「标题下面还是没有简介」。（见 scripts/probe-bili-desc.cjs）
 *
 * 简介和解析那边走**同一个** {@link buildVideoDescRichText}：接口有时把简介放在
 * `desc_v2` 里、有时只在 `desc` 里，口径收在一处才不会两边不一致。
 *
 * @param detail 稿件对象（`fetchVideoInfo` 的 `data.data`，含 desc / desc_v2）
 * @param fallbackId 稿件对象里没有 bvid 时用的作品 ID（面板请求里的那个）
 * @param hotDanmaku 热门弹幕，卡片顶部飘过的那几条（和解析结果一致）
 * @param ownerCard UP 主页卡片（头像框 / 昵称颜色），拉失败传 null
 */
export const buildBilibiliPanelCardData = (
  detail: any,
  fallbackId: string,
  hotDanmaku: any[] = [],
  ownerCard: any = null
): any => ({
  share_url: bilibiliShareUrl(String(detail?.bvid ?? fallbackId)),
  title: detail?.title,
  desc: buildVideoDescRichText(detail?.desc_v2, detail?.desc),
  stat: detail?.stat,
  bvid: detail?.bvid ?? fallbackId,
  ctime: detail?.ctime,
  pic: detail?.pic,
  hotDanmaku,
  /**
   * 头像框和粉名都来自 UP 主页（userCard）—— 面板只拉了视频信息，
   * 之前直接传 detail.owner 就少了 frame / usernameMeta 两个字段，
   * 于是卡片上「没有头像框、名字也不是粉色」。这里和解析那边用同一份构造。
   */
  owner: {
    ...detail?.owner,
    usernameMeta: ownerCard ? getUsernameMetadata(ownerCard) : undefined,
    frame: ownerCard?.pendant?.image || ''
  }
})

/**
 * 渲染面板卡片（和解析结果同一套模板）并上传到 assets，拿到 QQ markdown 能用的图片地址。
 *
 * QQ 的 markdown 图片必须是**可访问的 https 地址**（本地文件、base64 都不认），
 * 所以这里：渲染 → data URL → 交给宿主 assets 服务转存 → 拿 URL。
 * 拿不到 URL 就返回 null，调用方退回原来的纯文字表格面板。
 */
async function uploadPanelCard (
  e: Message,
  request: PanelRequest,
  detail: any,
  hotDanmaku: any[] = []
): Promise<{ url: string; width: number; height: number } | null> {
  try {
    const runtime = tryGetRuntime() as any
    const assets: any = runtime?.ctx?.assets
    if (!assets || typeof assets.upload !== 'function') {
      logger.debug('[QQ面板] 宿主没有可用的 assets 服务，跳过卡片图')
      return null
    }

    // 抖音：直接复用推送那套卡片构建器（renderWorkImage），保证和解析结果同一张卡
    if (request.platform === 'douyin') {
      const images: any = await renderWorkImage({
        e,
        Detail_Data: detail,
        create_time: Number(detail?.create_time) || Math.floor(Date.now() / 1000),
        // 和右下角二维码同一个链接：抖音那条带一串分享参数，App 才认
        shareLink: douyinShareUrl(String(detail?.aweme_id ?? request.id), detail?.share_url),
        // 还没选档，所以不显示分辨率块（和分享信息图一致）
        videoSource: undefined
      } as any)
      const first = Array.isArray(images) ? images[0] : images
      const src = String(first?.attrs?.src ?? first?.data?.file ?? '')
      if (!src.startsWith('data:image/')) return null
      const buffer = Buffer.from(src.slice(src.indexOf(',') + 1), 'base64')
      const uploaded = await assets.upload(src, 'kkk-douyin-panel.png')
      const url = typeof uploaded === 'string' ? uploaded : uploaded?.url
      if (!url || !/^https?:\/\//i.test(String(url))) return null
      return panelCardInfo(buffer, String(url))
    }

    /** UP 主页信息（头像框 / 昵称颜色），失败不影响面板 */
    let ownerCard: any = null
    if (request.platform === 'bilibili' && detail.owner?.mid) {
      try {
        const cardRes: any = await bilibiliFetcher.fetchUserCard({ host_mid: detail.owner.mid })
        ownerCard = cardRes?.data?.data?.card ?? null
      } catch (error: any) {
        logger.debug('[QQ面板] 拉取 UP 主页失败（头像框/粉名会缺省）: ' + String(error?.message ?? error))
      }
    }

    const route = 'bilibili/videoInfo'
    const cardData: any = request.platform === 'bilibili'
      ? buildBilibiliPanelCardData(detail, request.id, hotDanmaku, ownerCard)
      : {
          // 抖音卡片的数据结构由模板决定，这里先不做卡片，交给兜底面板
        }


    const images: any = await Render(e, route, cardData).catch(() => null)
    const first = Array.isArray(images) ? images[0] : images
    const src = String(first?.attrs?.src ?? first?.data?.file ?? '')
    if (!src.startsWith('data:image/')) return null

    const buffer = Buffer.from(src.slice(src.indexOf(',') + 1), 'base64')
    const result = await assets.upload(src, 'kkk-panel.png')
    const url = typeof result === 'string' ? result : result?.url
    if (!url || !/^https?:\/\//i.test(String(url))) {
      logger.debug('[QQ面板] assets 上传返回的地址不可用: ' + String(url || result))
      return null
    }
    return panelCardInfo(buffer, String(url))
  } catch (error: any) {
    logger.debug('[QQ面板] 渲染/上传卡片失败: ' + String(error?.message ?? error))
    return null
  }
}

/**
 * 番剧面板：**卡片图 + 分集表格（可翻页）**。
 *
 * 关键点：
 *   - 卡片仍然用原来的 `bilibili/bangumi` 模板渲染，只是**不再把分集预览画进图里**
 *     （几十集会拉成一张超长图），分集改为表格按钮；
 *   - 表格行列数由配置 `bangumiPanelRows` × `bangumiPanelCols` 决定（默认 4×4）；
 *   - 分集**倒序**排列（最新一集在最前面）；
/* 番剧面板不保存任何状态：分集与卡片数据由调用方每次算好传进来（见 sendBangumiPanelPage） */
async function renderBangumiCard (e: Message, cardData: any): Promise<{ url: string; width: number; height: number } | null> {
  const runtime = tryGetRuntime() as any
  const assets: any = runtime?.ctx?.assets
  if (!assets || typeof assets.upload !== 'function') return null

  const images: any = await Render(e, 'bilibili/bangumi', { ...cardData, Episodes: [], length: 0, hideTip: true })
  const first = Array.isArray(images) ? images[0] : images
  const src = String(first?.attrs?.src ?? '')
  if (!src.startsWith('data:image/')) return null

  const buffer = Buffer.from(src.slice(src.indexOf(',') + 1), 'base64')
  const uploaded = await assets.upload(src, 'kkk-bangumi.png')
  const url = typeof uploaded === 'string' ? uploaded : uploaded?.url
  if (!url || !/^https?:\/\//i.test(String(url))) return null
  return panelCardInfo(buffer, String(url))
}

/**
 * 发送番剧面板的某一页。
 *
 * 参数全是「算出来的」：分集数组、卡片数据、页码 —— 不依赖任何内存状态，
 * 所以宿主重启后点旧面板的「下一页」依然能正常出页面。
 */
export async function sendBangumiPanelPage (e: Message, episodes: any[], cardData: any, page = 1): Promise<boolean> {
  const runtime = tryGetRuntime()
  if (!runtime) return false
  if (runtime.config.qqPanel === false) return false
  if (!isQqPlatform(e)) return false
  if (!Array.isArray(episodes) || !episodes.length) return false

  try {
    const config = runtime.config as any
    const clamp = (value: any, min: number, max: number, fallback: number) => {
      const num = Number(value)
      return Number.isFinite(num) && num >= min && num <= max ? Math.floor(num) : fallback
    }
    // 表格行列数：配置项 bangumiPanelCols / bangumiPanelRows（默认 5×4 = 一页 20 集）
    // 注意：markdown 表格的**第一行就是表头**，所以「4 行」= 1 行表头 + 3 行正文，全都放数字
    const cols = clamp(config.bangumiPanelCols, 2, 8, 5)
    const rows = clamp(config.bangumiPanelRows, 1, 10, 4)
    const perPage = cols * rows

    // 倒序：最新一集排最前
    const ordered = episodes.map((episode: any, index: number) => ({ episode, number: index + 1 })).reverse()
    const pages = Math.max(1, Math.ceil(ordered.length / perPage))
    const current = Math.min(Math.max(1, Number(page) || 1), pages)
    const slice = ordered.slice((current - 1) * perPage, current * perPage)

    // 这一步前面已经有「检测到B站链接，开始解析」了，不再重复发「加载中…」
    const card = await renderBangumiCard(e, cardData)
    if (!card) return false

    const parseCommand = commandInvocation('解析')
    /**
     * **卡片单独发一条**（用户要求：不要和「选第几集」的表格挤在一起），
     * 并且不记进「上一条面板」—— 翻页 / 选集时只撤表格。
     * 翻页会重新渲染卡片，所以这里先撤掉上一张卡片，免得翻几次堆一排（见 recallLastPanelCard）。
     */
    const lines: string[] = []
    try {
      const cardLines = ["![#" + card.width + "px #" + card.height + "px](" + card.url + ")"]
      await recallLastPanelCard(e)
      const sentCard: any = await sendPanelMarkdown(cardLines, (content) => e.reply(content))
      rememberPanelCard(e, sentCard?.sent?.messageId)
    } catch (error: any) {
      logger.debug("[QQ面板] 番剧卡片单独发送失败（不影响选集表格）: " + String(error?.message ?? error))
    }

    /**
     * 一格：纯数字按钮，点下去就是选这一集。
     *
     * 按钮里**直接写链接**（不再用内存令牌）：令牌存在插件内存里，宿主一重启就失效，
     * 用户再点旧面板就会「没有任何反应」。链接本身很短（bilibili.com/video/BVxxx），
     * 而且只在按钮的 command 里、用户看到的是数字。
     */
    const episodeCell = ({ episode, number }: any) => {
      const url = episode?.bvid ? 'https://www.bilibili.com/video/' + episode.bvid : (episode?.link || '')
      return cmdInput(parseCommand + ' ' + url + ' --panel=1', String(number))
    }

    // 表格：第一行（markdown 的表头行）也放数字，整页 cols × rows 格全是可选集数
    for (let i = 0; i < perPage; i += cols) {
      const rowCells = slice.slice(i, i + cols).map(episodeCell)
      while (rowCells.length < cols) rowCells.push('　')
      lines.push('| ' + rowCells.join(' | ') + ' |')
      // 表头行后面必须跟分隔行
      if (i === 0) lines.push('| ' + Array(cols).fill(':---:').join(' | ') + ' |')
    }

    // 分页信息放表格**下面**（不放表头里，表头那行要留给集数）
    /**
     * 翻页按钮把番剧链接写进去（重启后也能用）。
     * 注意链接要用 `bangumi/play/ss<season_id>` 这种**解析器认得的**形式：
     * 卡片数据里的 `Link` 是 `bangumi/media/md…`，kkk 拿它取不到作品 ID（日志：无法获取作品ID）。
     */
    const seasonUrl = Number(cardData?.seasonID)
      ? 'https://www.bilibili.com/bangumi/play/ss' + String(cardData.seasonID)
      : String(cardData?.Link || '')
    const pageCommand = (page: number) => parseCommand + ' ' + seasonUrl + ' --bgp=' + page
    const prev = current > 1 ? cmdInput(pageCommand(current - 1), '上一页') : ''
    const next = current < pages ? cmdInput(pageCommand(current + 1), '下一页') : ''
    // 翻页信息放在表格**外面**（不占表格格子）：上一页 | 第 x/y 页 | 下一页
    lines.push('')
    lines.push((prev ? prev : '　') + '　第 ' + current + ' / ' + pages + ' 页　' + (next ? next : '　'))
    // 「打开原站」同样挂在选集面板下面（开关见 qqPanelSourceLink）
    if (tryGetRuntime()?.config.qqPanelSourceLink !== false && seasonUrl) lines.push(sourceLink('打开原站', seasonUrl))

    await recallLastPanel(e)
    // 带链接发不出去时自动去掉链接行重发（不同 adapter 对链接的限制不一样）
    const { sent } = await sendPanelMarkdown(lines, (content) => e.reply(content))
    rememberPanelMessage(e, sent?.messageId)
    logger.debug('[QQ面板] 番剧面板 ' + current + '/' + pages + ' 页（' + ordered.length + ' 集，' + cols + '×' + rows + '）')
    return true
  } catch (error: any) {
    logger.debug('[QQ面板] 番剧面板发送失败: ' + String(error?.message ?? error))
    return false
  }
}

/** 发送番剧面板（episodes + 卡片数据 + 页码，全程不依赖内存状态） */
export async function sendBangumiPanel (e: Message, episodes: any[], cardData: any, page = 1): Promise<boolean> {
  if (!Array.isArray(episodes) || !episodes.length) return false
  const runtime = tryGetRuntime()
  if (!runtime) return false
  if (runtime.config.qqPanel === false) return false
  if (!isQqPlatform(e)) return false
  return await sendBangumiPanelPage(e, episodes, cardData, page)
}

/**
 * 生成并发送解析面板。
 *
 * 面板长什么样完全由配置决定（画质档位来自接口，弹幕列来自 `qqPanelDanmaku` + 强制开关），
 * 调用方不需要、也不应该传「要不要弹幕」—— 那是配置的事，不是这一次解析的事。
 * @param e 消息事件
 * @param request 作品信息
 * @returns 是否已经发出面板（false 时调用方应继续正常解析）
 */
export async function sendQqParsePanel (e: Message, request: PanelRequest): Promise<boolean> {
  const runtime = tryGetRuntime()
  if (!runtime) return false
  if (runtime.config.qqPanel === false) return false
  if (!isQqPlatform(e)) return false

  const info = await fetchPanelInfo(request)
  if (!info || !info.options.length) return false

  /**
   * 封面要在**这里**就记进缓存。
   *
   * 正式解析时详情卡片是**不发**的（`fromPanel` 分支跳过 —— 面板已经发过那张卡），
   * 之后只有评论区那条长图会带按钮，而它下面的「提取封面图」要的就是这张封面。
   * 注意**面板自己不带按钮**：选了清晰度面板会被撤回（`replyReplacing`），
   * 挂在面板上的按钮跟着一起没了，点了没反应。
   */
  const panelKey = cardImageKeyOf(request.platform, request.id)
  rememberCardImages(panelKey, {
    cover: String(panelCoverUrl(request.platform, info?.detail) ?? '')
  })
  rememberLastCardKey(e, panelKey)

  const limit = Number(runtime.config.qqFileLimitMB ?? 200) || 200
  /**
   * 在线播放模式（通用 → 在线播放器设置 →「弹幕重定向在线播放器」，缺省即开启）。
   *
   * 它决定三件事：中间那一列写「弹幕」还是「烧录弹幕」、要不要多一列「在线看」、
   * 以及**画质档位不再按 QQ 的体积上限过滤**（见下面的 visible）。
   */
  const onlinePlayer = runtime.config.playerEnabled !== false
  /**
   * 面板里展示哪几档画质。
   *
   *   - **在线播放模式：全部**。视频不发到 QQ（交给播放页），所以「QQ 单个视频 200MB」
   *     这条硬限制在这里没有意义，再拿它藏档位就会变成「用户永远看不到 200MB 以上的
   *     4K / 8K 档」（用户实测反馈：「还是没有出现画质超过 200mb 的按钮」）；
   *     超限的档位只是把「清晰度」（= 发到 QQ）那一格标成「超上限」，右边的「在线看」照常可用。
   *   - 烧录模式（播放器关掉）：还是老规矩，超限档位直接不显示（点了也发不出去）。
   */
  const visible = onlinePlayer ? info.options : info.options.filter((option) => option.sizeMB <= limit)
  // 一档都不满足就别把面板做空：保留最小的一档并明确提示，否则用户连解析都点不了
  const overflow = visible.length === 0
  const shown = overflow ? [info.options[info.options.length - 1]] : visible

  // 按钮发出去的就是「用户视角的指令」，前缀按 Koishi 当前配置来（配了空前缀就是不带前缀的裸指令）
  const parseCommand = commandInvocation('解析')

  /**
   * 面板只由「卡片图片 + 按钮」组成，不带任何说明文字：
   * 文字会被 QQ 挤成一堆行，手机上看很乱；卡片图里已经有标题/UP/时长/数据了。
   */
  const lines: string[] = []
  // 这一段要拉弹幕 + 渲染卡片（十几秒），先给一句「加载中…」，也顺便撤掉上一条面板
  const loadingId = await showLoadingTip(e)
  const card = await uploadPanelCard(e, request, info.detail, info.hotDanmaku ?? [])
  /**
   * **卡片单独发一条**（用户要求：不要和「选清晰度」的 markdown 挤在一条消息里）。
   *
   * 而且它**不记进「上一条面板」** —— 下一步选清晰度/翻页时只撤 markdown 那张表，
   * 卡片留在群里；只有再解析一次（发新卡片）时才会把旧的撤掉（见 rememberPanelCard）。
   */
  let cardSent = false
  if (card && card.url) {
    // QQ markdown 的图片必须写成 ![#宽px #高px](url)，尺寸用**真实值**（panelCardInfo 保证过）
    const cardLines = ["![#" + card.width + "px #" + card.height + "px](" + card.url + ")"]
    try {
      await recallLastPanelCard(e)
      await recallMessageById(e, loadingId)
      /**
       * 「提取封面图」挂在**这张封面卡**上（同一条消息），不放画质表格那条。
       *
       * 这张卡是**单独一条**消息、选清晰度时不会被撤（撤的只是下面那张表格），
       * 所以按钮点得到；而表格那条一点就被 `replyReplacing` 撤掉了，挂那儿等于没有。
       * 这里**只给封面**：评论区那张图这会儿还没渲染，给了也点不出东西。
       */
      const sentCard: any = await sendPanelMarkdown(cardLines, (content) =>
        e.reply([content, ...cardImageActions(e, { cover: true, key: panelKey })]))
      rememberPanelCard(e, sentCard?.sent?.messageId)
      cardSent = true
    } catch (error: any) {
      logger.debug("[QQ面板] 信息卡片单独发送失败（不影响选择表）: " + String(error?.message ?? error))
    }
  }

  // 按钮里只放短令牌，链接存在内存里（见 rememberPanelRequest 的说明）；
  // 顺带把各档体积存进去：解析时能在「收到请求，开始下载」里提示会不会变成文件发送
  const sizes: Record<string, number> = {}
  for (const option of info.options) sizes[String(option.id)] = option.sizeMB
  const token = rememberPanelRequest(request, sizes)
  /**
   * 按钮里**同时写链接和令牌**：
   *   - 链接让按钮「无状态」——宿主重启后点旧面板照样能解析（令牌会失效）；
   *   - 令牌只用来查这一档的预估体积（提示「超过 30MB 会以文件发送」）。
   */
  const urlPart = request.url && request.url.length <= 120 ? request.url : ''
  const short = '--p=' + token
  const qualityFlag = request.platform === 'bilibili' ? '--qn=' : '--q='
  /**
   * 一个按钮：点下去**直接按这一档画质解析**。
   * @param flag 'dm' = 这次带弹幕（命令里多一个 `--dm=1`，播放器开着时是在线播放、关着时是真烧录）；
   *   'play' = 直接在线看（命令里多一个 `--play=1`，见 ParseOverride 的 onlineWatch）
   */
  const cell = (command: string, id: string | number, label: string, flag?: 'dm' | 'play') =>
    cmdInput(command + ' ' + (urlPart || short) + ' ' + short + ' ' + qualityFlag + id
      + (flag === 'dm' ? ' --dm=1' : flag === 'play' ? ' --play=1' : ''), label)

  /** 超上限的那一格用什么文字：markdown 里的按钮没有 disabled 状态，不给按钮才是真的点不了 */
  const OVER_LIMIT = '超上限'

  /**
   * 表格排版（有哪几列由配置决定）。
   *
   *   - 在线播放模式：「清晰度 | 弹幕 | 在线看 | 大小」，「在线看」那一列还要再看
   *     「面板显示「在线看」按钮」（playerWatchButton，默认开）；
   *   - 烧录模式（播放器关掉）：「清晰度 | 烧录弹幕 | 大小」，或者关掉面板弹幕列时的「清晰度 | 大小」。
   *
   * 三列按钮的语义（命令参数各不相同，别混用）：
   *   - **清晰度**：纯视频，**发到 QQ**（超过 qqFileLimitMB 的档发不出去，那一格标「超上限」）；
   *   - **弹幕**：这次要弹幕（`--dm=1`）。播放器开着时它落的也是在线播放（不烧录），关着时才是真烧录；
   *   - **在线看**：直接在线播放（`--play=1`），**一定带弹幕** —— 面板弹幕列关着、
   *     通用里弹幕功能关着都不影响它，视频不发到群里（用户要求：在线看不管有没有选弹幕默认都有弹幕）。
   *
   * 弹幕那一列出不出现的规则（用户实测反馈过：开了在线播放器却没有按钮）：
   *   - **在线播放模式：跟着「弹幕重定向在线播放器」走，开着就显示**
   *     —— 用户打开这个开关的意思就是「弹幕走在线播放」，面板上当然得有入口，
   *     再要求他去 QQ 适配器里另开一个「面板显示烧录弹幕列」是没道理的；
   *   - 烧录模式（播放器关掉）：还是老规矩，由 QQ 适配器里的
   *     「面板显示「烧录弹幕」列」（默认关）+ 能不能真烧（ffmpeg + 强制不烧录弹幕关掉）共同决定。
   */
  // 缺省即开启（和「打开原站」开关一个口径）：老配置里没有这个键时，列头也是「弹幕」
  const danmakuLabel = onlinePlayer ? '弹幕' : '烧录弹幕'
  const danmakuEnabled = onlinePlayer || (runtime.config.qqPanelDanmaku === true && isBurnDanmakuSupported())
  /**
   * 「弹幕」和「在线看」合并成一列的情形（用户要求）。
   *
   * 「弹幕重定向在线播放器」开着时，点「弹幕」落的**就是**在线播放（带弹幕、视频不发群），
   * 跟「在线看」完全同一个动作 —— 再并排放两个按钮，用户只会疑惑「这俩有什么区别」。
   * 所以这种模式下只留一列（按钮文案仍是用户熟悉的「弹幕」）。
   * 关掉播放器（回到烧录模式）时两者语义不同（真烧录 vs 在线播放），才分开两列。
   */
  const mergedWatch = onlinePlayer
  /**
   * 「在线看」那一列：
   *   - 合并模式下不单独出现（见 mergedWatch）；
   *   - 否则要满足通用里的「面板显示「在线看」按钮」（playerWatchButton，默认开，用户要的就是这个按钮）。
   */
  const watchEnabled = !mergedWatch && runtime.config.playerWatchButton !== false
  /**
   * 在线播放的体积上限（「在线播放最大文件」显式填了就用它，留空跟随全局；0 = 不限制）。
   *
   * 超过这一档的预估体积就不该给「弹幕 / 在线看」按钮：点了也只会退回原来的发送流程，
   * 用户白点一次还以为坏了（用户实测反馈）。这里直接把那一格换成「超上限」文字 ——
   * markdown 里的按钮没有 disabled 状态，不给按钮才是真的点不了。
   */
  const playerLimitMB = onlinePlayer ? await resolvePlayerSizeLimitMB() : 0
  const overPlayerLimit = (sizeMB: number): boolean =>
    onlinePlayer && playerLimitMB > 0 && Number(sizeMB) > playerLimitMB
  /**
   * 超过 QQ 档位上限（`qqFileLimitMB`，默认 200MB）的档位。
   *
   * 在线播放模式下这些档**照样列在面板里**（视频不发到 QQ），只是「清晰度」那一格不给按钮 ——
   * 那一格的含义就是「发到 QQ」，超了确实发不出去；想在线播放就点同一行的弹幕按钮
   * （在线播放模式下列已合并，按钮文案见 danmakuLabel；烧录模式下才是单独一列「在线看」）。
   */
  const overQqLimit = (sizeMB: number): boolean => onlinePlayer && Number(sizeMB) > limit
  let playerLimitHit = false
  let qqLimitHit = false
  const columns = ['清晰度'].concat(danmakuEnabled ? [danmakuLabel] : [], watchEnabled ? ['在线看'] : [], ['大小'])
  const aligns = [' :--- '].concat(danmakuEnabled ? [' :---: '] : [], watchEnabled ? [' :---: '] : [], [' ---: '])
  // 表头前也空一行：上一行是卡片图（![#Wpx #Hpx](…)），紧贴着会被当成表格的一部分
  lines.push('')
  lines.push('| ' + columns.join(' | ') + ' |')
  lines.push('|' + aligns.join('|') + '|')
  for (const option of shown) {
    const size = Math.round(option.sizeMB) + 'M'
    const cells: string[] = []
    // 清晰度：这一格是「发到 QQ」。超了 QQ 的档位上限就不给按钮（在线播放模式下那一档仍然列出来）
    if (overQqLimit(option.sizeMB)) {
      // 仍然写清是哪一档（只是没有按钮）：markdown 里的「按钮」没法禁用，去掉按钮、保留档位名
      cells.push(option.label + ' ' + OVER_LIMIT)
      qqLimitHit = true
    } else {
      cells.push(cell(parseCommand, option.id, option.label))
    }
    if (danmakuEnabled) {
      let danmakuCell = cell(parseCommand, option.id, danmakuLabel, 'dm')
      if (overPlayerLimit(option.sizeMB)) {
        // 在线播放模式下这一档超过上限：不给按钮，标清楚「超上限」
        danmakuCell = onlinePlayer ? OVER_LIMIT : danmakuCell
        if (onlinePlayer) playerLimitHit = true
      }
      cells.push(danmakuCell)
    }
    if (watchEnabled) {
      if (overPlayerLimit(option.sizeMB)) {
        cells.push(OVER_LIMIT)
        playerLimitHit = true
      } else {
        cells.push(cell(parseCommand, option.id, '在线看', 'play'))
      }
    }
    cells.push(size)
    lines.push('| ' + cells.join(' | ') + ' |')
  }
  /**
   * 表格与后面的说明之间**必须空一行**：markdown 的表格会把它紧跟着的下一行也当成表格行渲染，
   * 之前「标「超上限」的画质…」这句就被吞进表格里了（用户实测反馈）。
   */
  const hasTextAfterTable = qqLimitHit || playerLimitHit || overflow ||
    (runtime.config.qqPanelSourceLink !== false && !!request.url)
  if (hasTextAfterTable) lines.push('')
  if (qqLimitHit) {
    /**
     * 文案里的按钮名要跟着**实际列名**走：
     * 在线播放模式下列已经和「弹幕」合并了（同一点击就是在线播放），再写「点右边的「在线看」」
     * 用户在面板上根本找不到那个按钮（用户实测反馈）。
     */
    lines.push('标「超上限」的画质超过 QQ 的档位上限（' + limit + 'MB），发不到 QQ；'
      + (mergedWatch
        ? '想在线播放请点同一行的「' + danmakuLabel + '」。'
        : '想在线看请点同行右边的「在线看」。'))
  }
  if (playerLimitHit) {
    lines.push('标「超上限」的画质超过在线播放的体积上限（' + Math.round(playerLimitMB) + 'MB），'
      + '想在线播放请选更小的画质；还能发到 QQ 的档位点「清晰度」仍按原来的方式发送。')
  }
  /**
   * 一档都不满足体积上限：仍给出最小的一档（否则用户连解析都点不了），但要说清楚风险。
   * 在线播放模式下不会走到这里 —— 那种模式下列表不过滤，所有档位都列出来了。
   */
  if (overflow) lines.push('所有画质都超过体积上限（' + limit + 'MB），这里只保留最小的一档，发送可能失败。')
  /**
   * 「打开原站」：放在表格下方（用户要求的位置）——用户看完卡片和画质后，
   * 想直接去平台看原作品时不用再翻聊天记录找链接。
   * 开关在 WebUI 的 QQ 适配器分组（qqPanelSourceLink，默认开）。
   *
   * B站 / 抖音给的是「复制后打开 XX 自动跳转」代码块：各家 App 都认剪贴板里的自家链接，
   * 不依赖 QQ 会不会把 markdown 链接渲染成可点的东西。快手之类仍给普通链接。
   *
   * 链接**优先用用户原样发的那条**（`request.jumpUrl`）：我们拼的链接往往偏长，
   * App 剪贴板识别不了；用户发出来的 `v.douyin.com/xxx`、`v.kuaishou.com/xxx` 本来就是
   * 各家 App 自己生成的分享形态，最短也最容易被识别。
   *
   * **B站是唯一的例外**：它反过来 —— b23.tv 短链 App 不认，必须是完整的
   * `www.bilibili.com/video/BV…`，所以那支固定走 `bilibiliShareUrl()`，不用用户发的那条。
   * 二维码（卡片右下角）不受影响，和上面各平台一样保持自己的链接。
   */
  const linkStart = lines.length
  if (runtime.config.qqPanelSourceLink !== false && request.url) {
    const jumpUrl = request.jumpUrl || request.url
    const block = request.platform === 'bilibili'
      // B站固定用 BV 规范链接（短链 App 不识别），分 P 靠 request.page 带上
      ? copyJumpBlock('b站', bilibiliShareUrl(String(request.id), request.page))
      : request.platform === 'douyin'
        ? copyJumpBlock('抖音', jumpUrl, DOUYIN_JUMP_TOKEN)
        : [sourceLink('打开原站', jumpUrl)]
    lines.push(...block)
  }
  // 面板**不放**「提取」按钮：点清晰度后面板会被撤回（`replyReplacing`），按钮跟着没了
  // 带链接发不出去时自动去掉链接行重发（不然整条面板、整个解析都会被一个链接拖死）
  // 代码块连围栏共 3 行，所以按**下标范围**整块摘，不能只删中间那行
  const linkRange: [number, number] | undefined = lines.length > linkStart ? [linkStart, lines.length] : undefined
  const { sent } = await sendPanelMarkdown(lines, async (content) => {
    // 卡片已经撤过「加载中…」了；卡片没发出去（或渲染失败）时这里补撤一次
    if (!cardSent) await recallMessageById(e, loadingId)
    return await e.reply(content)
  }, linkRange)
  rememberPanelMessage(e, sent?.messageId)
  logger.debug('[QQ面板] 已发送解析面板: ' + request.platform + ' ' + request.id + '（' + shown.length + '/' + info.options.length + ' 档画质）')
  return true
}

export default sendQqParsePanel

/**
 * 解析开始时的提示语 —— 两种来源说两句话：
 *   - **面板按钮点出来的**：画质面板刚发过，这里只回「收到请求，开始下载」
 *   - 手工发链接的：仍然是「检测到 XX 链接，开始解析」
 * 两种情况都会先用 replyReplacing 撤掉上一条机器人消息，群里始终只留最新一条。
 */
export const sendParseTip = async (e: Message, platformName: string): Promise<void> => {
  const fromPanel = getParseOverride()?.fromPanel === true
  if (fromPanel) {
    await replyReplacing(e, '收到请求，开始下载')
    return
  }
  if (Config.app.parseTip) {
    await replyReplacing(e, '检测到' + platformName + '链接，开始解析')
  }
}

/**
 * 把一张图片转成 QQ markdown 能用的地址（`![#宽px #高px](https url)`）。
 *
 * ## 尺寸只写**真实值**，读不出就返回 null
 *
 * 这个函数以前有**四处**「读不出尺寸就按 `maxWidth × maxWidth×1.3` 估一个」的兜底。
 * 那不叫兜底，叫**拉变形**：QQ 按 `#宽px #高px` 这个框渲染，框的比例和原图对不上，
 * 图片就被硬拉成长宽比 1:1.3 —— 用户反馈的「自适应发送的图片有些被强制拉伸了」就是它。
 *
 * 现在的口径和其它链路统一（见 `compat/imageMarkdown`）：
 *   - 能读出来（PNG / JPEG / GIF / WebP，见 `compat/imageSize`）→ 按真实比例写死尺寸；
 *   - 读不出来 → 先补一次 ffprobe；还是不行就**返回 null**，让调用方退回「普通图片段」发。
 *     普通图片会被客户端压得糊一点，但**比例是对的、也看得见**，比一张拉变形的图强。
 *
 * @param url 原始图片地址（http(s) / 本地路径 / file:// / data URI / base64://）
 * @param maxWidth 最大显示宽度（等比缩放，避免大图刷屏）
 * @returns 可直接嵌进 markdown 的图片；**尺寸未知 / 下载失败时返回 null**
 */
export const toMarkdownImage = async (url: string, maxWidth = 420): Promise<string | null> => {
  try {
    const ctx: any = tryGetRuntime()?.ctx
    const assets: any = ctx?.assets
    /**
     * 三种图片来源都要认：
     *   1. **data URI**（卡片、提示图 ✓）
     *   2. **本地文件路径 / file://**（实况图的 Motion Photo 封面就是这种！
     *      之前只处理远程 URL，这里 fetch 一个本地路径必然失败 →
     *      md 生成不出来 → 整条图集退化成「一张一张发」）
     *   3. 远程 https 图片
     */
    let buffer: Buffer
    let mime = 'image/jpeg'
    const localPath = url.startsWith('file://') ? decodeURIComponent(url.replace(/^file:\/\//, '')) : url
    /**
     * **base64:// 必须认** —— 抖音的图片地址就是这种（processImageUrl 的产物）。
     * 少了这条会让 md 生成失败，整条图集退化成「一张一张发」
     * （诊断日志表现为「准备发送图集: md=无 视频=9 段」）。
     */
    if (url.startsWith('base64://')) {
      buffer = Buffer.from(url.slice('base64://'.length), 'base64')
      mime = 'image/jpeg'
    } else if (!url.startsWith('data:') && !/^https?:\/\//i.test(url) && fs.existsSync(localPath)) {
      buffer = fs.readFileSync(localPath)
      mime = localPath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
    } else if (url.startsWith('data:')) {
      const comma = url.indexOf(',')
      mime = url.slice(5, url.indexOf(';')) || 'image/jpeg'
      buffer = Buffer.from(url.slice(comma + 1), 'base64')
    } else {
      const res = await fetch(url)
      if (!res.ok) {
        logger.mark('[QQ面板] md 图片下载失败 HTTP ' + res.status + '，这张改用普通图片发送: ' + url.slice(0, 60))
        return null
      }
      buffer = Buffer.from(await res.arrayBuffer())
      mime = String(res.headers.get('content-type') ?? 'image/jpeg').split(';')[0]
    }

    /** 真实尺寸：先按二进制头认（PNG/JPEG/GIF/WebP），认不出再补一层 ffprobe */
    let size = readImageSize(buffer)
    if (!isUsableSize(size)) {
      try {
        const { spawnSync } = await import('node:child_process')
        const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', '-'], { input: buffer })
        const parts = String(probe.stdout ?? '').trim().split(',')
        const width = Number(parts[0]) || 0
        const height = Number(parts[1]) || 0
        if (width > 0 && height > 0) size = { width, height }
      } catch { /* ffprobe 不在就按「读不出」处理 */ }
    }
    if (!isUsableSize(size)) {
      logger.mark('[QQ面板] 读不出图片尺寸，这张不发 markdown（猜尺寸会把图拉伸），改用普通图片发送: ' + url.slice(0, 60))
      return null
    }
    const scaled = scaleToWidth(size, maxWidth)

    /**
     * 上传换公网地址。**md 里的图片地址必须是公网 https**（相对路径、本地路径手机端取不到）。
     * 没有 assets 服务、或者上传没返回公网地址时，就用原始链接 —— 只要尺寸是真的，
     * 至少比例不会错。
     */
    let finalUrl = /^https?:\/\//i.test(url) ? url : ''
    if (assets?.upload) {
      const uploaded: any = await assets.upload('data:' + mime + ';base64,' + buffer.toString('base64'), 'kkk-md.png')
      const remote = typeof uploaded === 'string' ? uploaded : uploaded?.url
      if (remote && /^https?:\/\//i.test(String(remote))) finalUrl = String(remote)
      else logger.mark('[QQ面板] assets 上传没有返回公网地址，md 图片改用原始链接')
    } else {
      logger.mark('[QQ面板] 宿主没有 assets 服务，md 图片改用原始链接')
    }
    if (!finalUrl) {
      logger.mark('[QQ面板] 拿不到可公网访问的图片地址，这张改用普通图片发送: ' + url.slice(0, 60))
      return null
    }
    return '![#' + scaled.width + 'px #' + scaled.height + 'px](' + finalUrl + ')'
  } catch (error: any) {
    logger.mark('[QQ面板] 图片转 markdown 失败（这张改用普通图片发送）: ' + String(error?.message ?? error).slice(0, 120))
    return null
  }
}

/**
 * **OneBot 系（NapCat / Lagrange / go-cqhttp…）不渲染 markdown**（用户实测反馈）：
 * markdown 是 QQ **官方机器人**才有的能力，个人号客户端收到 \`markdown\` 段只会显示成一串文字、
 * 图片一张都出不来。所以这条链路上要改发**普通图片段**。
 */
const ONEBOT_LIKE = /onebot|napcat|lagrange|go-?cqhttp|chronocat|mirai/i

/** 把一张图读成 Buffer（data URI / base64:// / 本地路径 / 远程 URL 都认） */
async function loadImageBuffer (url: string): Promise<{ buffer: Buffer; mime: string } | null> {
  try {
    const localPath = url.startsWith('file://') ? decodeURIComponent(url.replace(/^file:\/\//, '')) : url
    if (url.startsWith('base64://')) {
      return { buffer: Buffer.from(url.slice('base64://'.length), 'base64'), mime: 'image/jpeg' }
    }
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',')
      const mime = url.slice(5, url.indexOf(';')) || 'image/jpeg'
      return { buffer: Buffer.from(url.slice(comma + 1), 'base64'), mime }
    }
    if (!/^https?:\/\//i.test(url) && fs.existsSync(localPath)) {
      return { buffer: fs.readFileSync(localPath), mime: localPath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg' }
    }
    const res = await fetch(url)
    if (!res.ok) {
      logger.mark('[图片消息] 下载失败 HTTP ' + res.status + ': ' + url.slice(0, 60))
      return null
    }
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      mime: String(res.headers.get('content-type') ?? 'image/jpeg').split(';')[0]
    }
  } catch (error: any) {
    logger.mark('[图片消息] 读取图片失败: ' + String(error?.message ?? error).slice(0, 120))
    return null
  }
}

/**
 * 一组图片合成**一条**消息（图集 / 评论图片用）：
 * 一张图一条消息、或者走合并转发都会刷屏，这里统一成单条。
 *
 * **按平台分流**（markdown 只有 QQ 官方机器人认得）：
 *   - 官方 QQ：一条 markdown（图片先传 assets 拿 https 地址，连续图片紧贴渲染，视觉上是一整段）；
 *   - OneBot：若干 **image 段**（直接给 base64，既不用上传、也不怕 CDN 防盗链）。
 *
 * @param urls 图片地址（data URI / base64:// / 本地路径 / https 都行）
 * @param maxWidth markdown 模式下的显示宽度
 * @param platform 适配器平台名（缺省按官方 QQ 处理）
 */
export const buildMarkdownImageMessage = async (urls: string[], maxWidth = 420, platform = ''): Promise<any | null> => {
  const list = urls.filter(Boolean).map(String)
  if (!list.length) return null

  if (ONEBOT_LIKE.test(platform)) {
    const images: any[] = []
    for (const url of list) {
      const loaded = await loadImageBuffer(url)
      if (!loaded) continue
      // 用带 mime 的 data URI：兼容层把 base64:// 一律当 png，标错会让客户端把 jpg 当 png
      images.push(segment.image('data:' + loaded.mime + ';base64,' + loaded.buffer.toString('base64')))
    }
    if (!images.length) return null
    logger.debug('[图片消息] ' + platform + ' 不渲染 markdown，改为 ' + images.length + ' 张图片段')
    return images
  }

  const parts = (await Promise.all(list.map((url) => toMarkdownImage(url, maxWidth)))).filter(Boolean) as string[]
  if (!parts.length) return null
  return segment.markdown(parts.join('\n'))
}

/** 便捷版：直接传事件，自动取平台 */
export const buildImageMessageFor = async (e: any, urls: string[], maxWidth = 420): Promise<any | null> =>
  buildMarkdownImageMessage(urls, maxWidth, platformOf(e))
