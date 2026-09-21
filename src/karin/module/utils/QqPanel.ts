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
import { getImageMetadata, Render } from '@/module/utils/Render'
import { getHotDanmaku } from '@/platform/bilibili/danmaku'
// 头像框 / 昵称颜色要从 UP 主页接口拿，和解析结果保持一致
import { getUsernameMetadata } from '@/platform/bilibili/dynamic-text'
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

export function cmdInput (command: string, show?: string): string {
  const text = encodeURIComponent(command).replace(/'/g, '%27')
  const label = encodeURIComponent(show ?? command).replace(/'/g, '%27')
  return '<qqbot-cmd-input text="' + text + '" show="' + label + '" reference="false" />'
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
 * @returns 最后一次发送的结果
 */
async function sendPanelMarkdown (
  lines: string[],
  send: (content: any) => Promise<any>
): Promise<{ sent: any, droppedLink: boolean }> {
  try {
    return { sent: await send(segment.markdown(lines.join(String.fromCharCode(10)))), droppedLink: false }
  } catch (error: any) {
    const withoutLink = lines.filter((line) => !isSourceLinkLine(line))
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
        shareLink: 'https://www.douyin.com/video/' + String(detail?.aweme_id ?? request.id),
        // 还没选档，所以不显示分辨率块（和分享信息图一致）
        videoSource: undefined
      } as any)
      const first = Array.isArray(images) ? images[0] : images
      const src = String(first?.attrs?.src ?? first?.data?.file ?? '')
      if (!src.startsWith('data:image/')) return null
      const buffer = Buffer.from(src.slice(src.indexOf(',') + 1), 'base64')
      const meta = getImageMetadata(buffer)
      const uploaded = await assets.upload(src, 'kkk-douyin-panel.png')
      const url = typeof uploaded === 'string' ? uploaded : uploaded?.url
      if (!url || !/^https?:\/\//i.test(String(url))) return null
      return { url: String(url), width: Number(meta.width) || 0, height: Number(meta.height) || 0 }
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
      ? {
          share_url: 'https://b23.tv/' + (detail.bvid ?? request.id),
          title: detail.title,
          desc: '',
          stat: detail.stat,
          bvid: detail.bvid ?? request.id,
          ctime: detail.ctime,
          pic: detail.pic,
          // 和解析结果一致：带热门弹幕，卡片顶部就有弹幕飘过
          hotDanmaku,
          /**
           * 头像框和粉名都来自 UP 主页（userCard）—— 面板只拉了视频信息，
           * 之前直接传 detail.owner 就少了 frame / usernameMeta 两个字段，
           * 于是卡片上「没有头像框、名字也不是粉色」。这里和解析那边用同一份构造。
           */
          owner: {
            ...detail.owner,
            usernameMeta: ownerCard ? getUsernameMetadata(ownerCard) : undefined,
            frame: ownerCard?.pendant?.image || ''
          }
        }
      : {
          // 抖音卡片的数据结构由模板决定，这里先不做卡片，交给兜底面板
        }


    const images: any = await Render(e, route, cardData).catch(() => null)
    const first = Array.isArray(images) ? images[0] : images
    const src = String(first?.attrs?.src ?? first?.data?.file ?? '')
    if (!src.startsWith('data:image/')) return null

    const buffer = Buffer.from(src.slice(src.indexOf(',') + 1), 'base64')
    const meta = getImageMetadata(buffer)
    const result = await assets.upload(src, 'kkk-panel.png')
    const url = typeof result === 'string' ? result : result?.url
    if (!url || !/^https?:\/\//i.test(String(url))) {
      logger.debug('[QQ面板] assets 上传返回的地址不可用: ' + String(url || result))
      return null
    }
    return { url: String(url), width: Number(meta.width) || 0, height: Number(meta.height) || 0 }
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
  const meta = getImageMetadata(buffer)
  const uploaded = await assets.upload(src, 'kkk-bangumi.png')
  const url = typeof uploaded === 'string' ? uploaded : uploaded?.url
  if (!url || !/^https?:\/\//i.test(String(url))) return null
  return { url: String(url), width: Number(meta.width) || 1440, height: Number(meta.height) || 1080 }
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
    const lines: string[] = ['![#' + card.width + 'px #' + card.height + 'px](' + card.url + ')']

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
  if (card && card.url) {
    // QQ markdown 的图片必须写成 ![#宽px #高px](url)
    lines.push('![#' + (card.width || 1440) + 'px #' + (card.height || 1080) + 'px](' + card.url + ')')
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
   */
  if (runtime.config.qqPanelSourceLink !== false && request.url) lines.push(sourceLink('打开原站', request.url))
  // 带链接发不出去时自动去掉链接行重发（不然整条面板、整个解析都会被一个链接拖死）
  await sendPanelMarkdown(lines, (content) => replaceLoadingTip(e, loadingId, content))
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
 * 把一张远程图片转成 QQ markdown 能用的地址。
 *
 * QQ 的 markdown 图片必须写成 `![#宽px #高px](https url)`，而且外链常常被拦，
 * 所以这里先下载再通过宿主的 assets 服务上传一份，返回可直接嵌进 markdown 的地址与原始尺寸。
 *
 * @param url 原始图片地址
 * @param maxWidth 最大显示宽度（等比缩放，避免大图刷屏）
 */
export const toMarkdownImage = async (url: string, maxWidth = 420): Promise<string | null> => {
  try {
    const ctx: any = tryGetRuntime()?.ctx
    const assets: any = ctx?.assets
    if (!assets?.upload) {
      // 没有 assets 服务就只能用原始链接（QQ 大概率取不到，但比直接放弃强）
      logger.mark('[QQ面板] 宿主没有 assets 服务，md 图片改用原始链接')
      return /^https?:\/\//i.test(url) ? '![#' + maxWidth + 'px #' + Math.round(maxWidth * 1.3) + 'px](' + url + ')' : null
    }
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
        logger.mark('[QQ面板] md 图片下载失败 HTTP ' + res.status + '，改用原始链接: ' + url.slice(0, 60))
        return '![#' + maxWidth + 'px #' + Math.round(maxWidth * 1.3) + 'px](' + url + ')'
      }
      buffer = Buffer.from(await res.arrayBuffer())
      mime = String(res.headers.get('content-type') ?? 'image/jpeg').split(';')[0]
    }
    /**
     * 尺寸必须尽量取到**真实值** —— 原来取不到就用 maxWidth 兜底，
     * 结果 width/height 相等 → 图片被拉成**正方形**（用户反馈「比例不对」）。
     * 这里补一层 ffprobe（webp/avif 这类 getImageMetadata 认不出的格式也能拿到）。
     */
    const meta = getImageMetadata(buffer)
    let realWidth = Number(meta.width) || 0
    let realHeight = Number(meta.height) || 0
    if (!realWidth || !realHeight) {
      try {
        const { spawnSync } = await import('node:child_process')
        const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', '-'], { input: buffer })
        const parts = String(probe.stdout ?? '').trim().split(',')
        realWidth = Number(parts[0]) || 0
        realHeight = Number(parts[1]) || 0
      } catch { /* 兜底失败 */ }
    }
    const uploaded: any = await assets.upload('data:' + mime + ';base64,' + buffer.toString('base64'), 'kkk-md.png')
    const finalUrl = typeof uploaded === 'string' ? uploaded : uploaded?.url
    if (!finalUrl || !/^https?:\/\//i.test(String(finalUrl))) {
      // 上传拿不到公网地址：退回原始链接，至少图片还能显示
      logger.mark('[QQ面板] assets 上传没有返回公网地址，md 图片改用原始链接')
      return /^https?:\/\//i.test(url) ? '![#' + maxWidth + 'px #' + Math.round(maxWidth * 1.3) + 'px](' + url + ')' : null
    }
    if (!realWidth || !realHeight) {
      // 真的拿不到：宁可不写尺寸让客户端按原图比例显示，也别硬套成正方形
      logger.mark('[QQ面板] 图片尺寸未知，改用原始尺寸显示: ' + url.slice(0, 50))
      return '![](' + finalUrl + ')'
    }
    const w = Math.min(realWidth, maxWidth)
    const h = Math.max(1, Math.round((realHeight * w) / realWidth))
    return '![#' + w + 'px #' + h + 'px](' + finalUrl + ')'
  } catch (error: any) {
    logger.mark('[QQ面板] 图片转 markdown 失败: ' + String(error?.message ?? error).slice(0, 120))
    // 兜底：直接用原始链接（QQ 取不到就取不到，总比整条图集退化成逐张发好）
    return /^https?:\/\//i.test(url) ? '![#' + maxWidth + 'px #' + Math.round(maxWidth * 1.3) + 'px](' + url + ')' : null
  }
}

/**
 * 一组图片合成**一条** markdown 消息（图集解析用）：
 * 一张图一条消息、或者走合并转发都会刷屏，这里统一成单条 md，图片按 maxWidth 等比缩放。
 */
export const buildMarkdownImageMessage = async (urls: string[], maxWidth = 420): Promise<any | null> => {
  const parts = (await Promise.all(urls.map((url) => toMarkdownImage(url, maxWidth)))).filter(Boolean) as string[]
  if (!parts.length) return null
  return segment.markdown(parts.join('\n'))
}
