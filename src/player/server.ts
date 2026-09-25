/**
 * 在线播放器的 HTTP 路由。
 *
 * 三条路由（都挂在自己拼的 `/kkk/player` 前缀下，和配置面板的 /kkk 互不干扰）：
 *   GET /kkk/player/:token           播放页（HTML）
 *   GET /kkk/player/:token/video     视频本体，支持 Range（拖进度条靠它）；`?download=1` = 下载
 *   GET /kkk/player/:token/audio     单独的音轨（B站这种音视频分离的）；`?download=1` = 下载音频
 *   GET /kkk/player/:token/merged    **按需**用 ffmpeg 合成音视频后下载/播放（第一次会慢一两秒）
 *   GET /kkk/player/:token/download  等价于 `/video?download=1`（带 Content-Disposition）
 *   GET /kkk/player/:token/danmaku   弹幕 JSON
 *   GET /kkk/player/:token/story     互动视频的当前剧情（题目 + 选项；带 ?cid=&edge= 取下一段）
 *   GET /kkk/player/:token/segment/:cid  互动视频某一段的视频（没下过就按需下载，支持 Range）
 *
 * 两种落地方式：
 *   - `playerPort` 为 0（默认）：挂到 Koishi 自己的 `ctx.server` 上，不额外占端口；
 *   - `playerPort` 非 0：用 node:http 另起一个独立服务（端口被别人占了就只打日志并退回 ctx.server，
 *     绝不让端口冲突把整个解析流程带崩）。
 *
 * 请求处理被抽成「请求 → 响应描述」的纯函数，Koa 与 node:http 两个适配器共用同一份逻辑，
 * 测试也能直接喂请求对象验证（不用真的起服务）。
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { logger } from 'node-karin'

// 注意只有一层 .. ：src/player/server.ts → src/compat/runtime（写两层会变成根目录下的 compat，直接 MODULE_NOT_FOUND）
import { tryGetRuntime } from '../compat/runtime'

import { renderExpiredPage, renderPlayerPage } from './page'
import {
  adoptPlayerSegment,
  getPlayerSession,
  getPlayerStorySource,
  isValidPlayerToken,
  isValidStoryCid,
  markPlayerMerged,
  readPlayerDanmaku,
  readPlayerStory,
  resolvePlayerAudio,
  resolvePlayerCover,
  resolvePlayerMerged,
  resolvePlayerSegment,
  resolvePlayerVideo,
  type SegmentKind,
  type SegmentReporter,
  type SegmentStage
} from './store'

/** 一次请求（只取用得到的字段） */
export interface PlayerHttpRequest {
  method: string
  /** 只含路径，不含查询串 */
  path: string
  /** Range 头原文 */
  range?: string
  /** 查询串（可带前导 '?'）：目前只认 download=1（下载而不是在页面里播放） */
  query?: string
}

/** 一次响应：body 或 file 二选一 */
export interface PlayerHttpResponse {
  status: number
  headers: Record<string, string>
  body?: Buffer
  /** 要流式发送的文件片段（视频走这条，避免大文件全读进内存） */
  file?: { path: string, start: number, end: number }
}

/** 路由前缀 */
export const PLAYER_ROUTE_PREFIX = '/kkk/player/'

/** 独立端口是否真的监听上了：没监听上时链接指向的公网域名很可能打不到本实例 */
let standaloneReady = false

/** 查询独立端口是否监听上了（给「生成链接」那边做提示用） */
export const isStandalonePlayerReady = (): boolean => standaloneReady

/** 面板里配的「播放器公网地址」（没配就是空串） */
function publicBaseUrl (): string {
  try {
    return String((tryGetRuntime()?.config as any)?.playerBaseUrl ?? '').trim()
  } catch {
    return ''
  }
}

const TEXT_TYPE = 'text/plain; charset=utf-8'
const HTML_TYPE = 'text/html; charset=utf-8'

/** 过期 / 无效令牌的统一回应：页面直接渲染「链接已过期」，接口退回纯文本 */
function notFound (asPage: boolean): PlayerHttpResponse {
  if (asPage) {
    return { status: 404, headers: { 'Content-Type': HTML_TYPE, 'Cache-Control': 'no-store' }, body: Buffer.from(renderExpiredPage()) }
  }
  return { status: 404, headers: { 'Content-Type': TEXT_TYPE, 'Cache-Control': 'no-store' }, body: Buffer.from('链接已过期') }
}

/**
 * 解析 Range 头。
 * @returns null 表示没有 Range（按完整文件发）；'invalid' 表示范围越界（回 416）
 */
function parseRange (range: string | undefined, size: number): { start: number, end: number } | null | 'invalid' {
  const text = String(range ?? '').trim()
  if (!text) return null
  const matched = /^bytes=(\d*)-(\d*)$/.exec(text)
  if (!matched) return null
  const hasStart = matched[1] !== ''
  const hasEnd = matched[2] !== ''
  if (!hasStart && !hasEnd) return null
  let start: number
  let end: number
  if (hasStart) {
    start = Number(matched[1])
    end = hasEnd ? Number(matched[2]) : size - 1
  } else {
    // bytes=-500：最后 500 字节
    const suffix = Number(matched[2])
    if (!suffix) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start > end || start >= size) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}

/**
 * 下载文件名（不含路径）：把视频标题清洗成一个能安全落盘的名字。
 *
 * 标题是用户内容，直接拿来当文件名有两个坑：
 *   1. 里面可能有 `/` `\\` `..` 与控制字符 —— 客户端落盘时就是路径穿越 / 写坏文件名；
 *   2. HTTP 头只能装 Latin-1 字节，中文直接写进 `filename=` 会让 Node 抛 ERR_INVALID_CHAR。
 * 所以这里清洗 + 截断（80 字符），空的就退回 video。
 */
export function sanitizeDownloadName (title: unknown): string {
  const name = String(title ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .slice(0, 80)
    .replace(/[.\s]+$/, '')
    .trim()
  return name || 'video'
}

/**
 * `Content-Disposition` 的值：`attachment` + 安全文件名。
 *
 * 两个文件名都给：`filename=` 用 ASCII 兜底名（老客户端 / 头编码限制），
 * `filename*=` 用 RFC 5987 的 UTF-8 形式放原名（现代浏览器优先用它，中文名不会变成下划线）。
 */
export function downloadDisposition (title: unknown, ext = '.mp4'): string {
  const full = sanitizeDownloadName(title) + ext
  // 纯中文标题会变成一排下划线（对老客户端毫无意义），这种情况直接给个通用名
  const asciiRaw = full.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  // 只在**扩展名之前**数有效字符：纯中文标题会变成「_____.mp4」，那 3 个字母来自 .mp4 不能算数
  const asciiBase = asciiRaw.replace(/\.(mp4|mkv|webm|mov|m4a|aac|mp3)$/i, '')
  const ascii = /[A-Za-z0-9]/.test(asciiBase) ? asciiRaw : 'video' + ext
  const encoded = encodeURIComponent(full).replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase())
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encoded
}

/**
 * 视频响应：支持 Range，未过期时是 video/mp4。
 * @param download 为 true 时带上 `Content-Disposition: attachment`（浏览器直接下载），Range 照旧支持
 */
/**
 * 通用文件响应：支持 Range。
 *
 * @param file 文件路径与大小
 * @param contentType 响应的 Content-Type（视频 / 音轨 / 合并后的视频各不同）
 * @param ext 下载时的扩展名（决定 Content-Disposition 里的文件名）
 * @param download 是否带 \`Content-Disposition: attachment\`
 */
function fileResponse (
  token: string,
  file: { path: string, size: number },
  contentType: string,
  range?: string,
  head = false,
  download = false,
  ext = '.mp4'
): PlayerHttpResponse {
  const base: Record<string, string> = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  }
  // 下载：文件名取会话标题（清洗过），Range 行为不变（浏览器正常下载时也不会带 Range）
  if (download) base['Content-Disposition'] = downloadDisposition(getPlayerSession(token)?.title, ext)
  const parsed = parseRange(range, file.size)
  if (parsed === 'invalid') {
    return {
      status: 416,
      headers: { ...base, 'Content-Range': 'bytes */' + file.size },
      body: Buffer.from('请求的范围无效')
    }
  }
  if (!parsed) {
    base['Content-Length'] = String(file.size)
    return { status: 200, headers: base, file: head ? undefined : { path: file.path, start: 0, end: file.size - 1 } }
  }
  const length = parsed.end - parsed.start + 1
  return {
    status: 206,
    headers: {
      ...base,
      'Content-Length': String(length),
      'Content-Range': 'bytes ' + parsed.start + '-' + parsed.end + '/' + file.size
    },
    file: head ? undefined : { path: file.path, start: parsed.start, end: parsed.end }
  }
}

/** 视频本体（分离音轨时这里只有画面） */
function videoResponse (token: string, range?: string, head = false, download = false): PlayerHttpResponse {
  const video = resolvePlayerVideo(token)
  if (!video) return notFound(false)
  return fileResponse(token, video, 'video/mp4', range, head, download, '.mp4')
}

/** 单独的音轨（B站这类音视频分离的）：\`<audio>\` 直接播它，\`?download=1\` 下载 m4a */
function audioResponse (token: string, range?: string, head = false, download = false): PlayerHttpResponse {
  const audio = resolvePlayerAudio(token)
  if (!audio) return notFound(false)
  return fileResponse(token, audio, 'audio/mp4', range, head, download, '.m4a')
}

/**
 * **按需合成**：把画面和音轨用 ffmpeg 合成一条 mp4（\`-c copy\`，不重新编码，通常一两秒）。
 *
 * 为什么要按需：用户要求「默认不合并音频、浏览器里同时播放就行」——
 * 解析时不再花时间合成，只有点了「服务器合并后下载」才做，而且做完会留在会话目录里，
 * 同一条链接再点就是秒回（到期随会话一起删）。
 *
 * @returns 合成好的文件；没有独立音轨 / ffmpeg 失败时返回 null（路由回 404）
 */
async function ensureMerged (token: string): Promise<{ path: string, size: number } | null> {
  const cached = resolvePlayerMerged(token)
  if (cached) return cached
  const video = resolvePlayerVideo(token)
  const audio = resolvePlayerAudio(token)
  if (!video || !audio) return null
  const session = getPlayerSession(token)
  if (!session) return null
  const target = path.join(session.dir, 'merged.mp4')
  const started = Date.now()
  try {
    const { spawn } = await import('node:child_process')
    const { resolveFfmpegBin } = await import('node-karin')
    const bin = resolveFfmpegBin()
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(bin, [
        '-y',
        '-i', video.path,
        '-i', audio.path,
        '-c', 'copy',
        '-movflags', '+faststart',
        target
      ], { stdio: 'ignore' })
      proc.on('error', reject)
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code))))
    })
    const stat = fs.statSync(target)
    markPlayerMerged(token, 'merged.mp4')
    logger.mark('[在线播放] 已按需合成音视频（' + (stat.size / 1024 / 1024).toFixed(1) + 'MB，'
      + (Date.now() - started) + 'ms）：' + token)
    return { path: target, size: stat.size }
  } catch (error: any) {
    logger.warn('[在线播放] 合成音视频失败（' + (Date.now() - started) + 'ms）: ' + String(error?.message ?? error))
    try { fs.rmSync(target, { force: true }) } catch { /* 忽略 */ }
    return null
  }
}

/**
 * 封面图。
 *
 * 刻意走**同源**：封面本来是平台 CDN 上的外链，直接放进页面就等于页面依赖外网，
 * 内网 / 断网部署会看到裂图。所以登记会话时就把封面下下来放进会话目录，这里原样发出去。
 */
function coverResponse (token: string): PlayerHttpResponse {
  const cover = resolvePlayerCover(token)
  if (!cover) return notFound(false)
  return {
    status: 200,
    headers: { 'Content-Type': cover.type, 'Cache-Control': 'no-store' },
    file: { path: cover.path, start: 0, end: Math.max(0, fs.statSync(cover.path).size - 1) }
  }
}

/** 弹幕 JSON： `{ total, items: [{ time, mode, size, color, text }] }` */
function danmakuResponse (token: string): PlayerHttpResponse {
  const data = readPlayerDanmaku(token)
  if (!data) return notFound(false)
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: Buffer.from(JSON.stringify(data))
  }
}

/** 一段 JSON（互动剧情的节点数据走它） */
function jsonResponse (payload: unknown): PlayerHttpResponse {
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: Buffer.from(JSON.stringify(payload))
  }
}

/**
 * 互动剧情：当前这一段的题目 + 选项。
 *
 * 不带查询 = 会话登记时存下来的那份（第一段的题目）；
 * 带 `?cid=<从哪一段>&edge=<走的哪条边>` = 现问平台要下一段。
 * 没有剧情 / 取不到节点都回 404 —— 播放页据此就知道「这里没有互动」，按普通播放页来。
 */
async function storyResponse (token: string, query: URLSearchParams): Promise<PlayerHttpResponse> {
  const session = getPlayerSession(token)
  if (!session?.story) return notFound(false)
  const rawCid = query.get('cid')
  const edgeId = Number(query.get('edge')) || 0
  /** 没有 cid（或问的就是当前这一段、也没带边）→ 直接用会话里那份，不必再问接口 */
  if (!rawCid || (!edgeId && Number(rawCid) === Number(session.story.cid))) {
    return jsonResponse(readPlayerStory(token) ?? session.story)
  }
  const cid = Number(rawCid)
  const source = getPlayerStorySource(token)
  if (!isValidStoryCid(cid) || !source?.node) return notFound(false)
  try {
    const node = await source.node({ cid, edgeId: edgeId || undefined })
    return node ? jsonResponse(node) : notFound(false)
  } catch (error: any) {
    logger.warn('[在线播放] 取互动剧情节点失败: ' + String(error?.message ?? error))
    return notFound(false)
  }
}

/** 正在下载的分段任务：同一条会话 + 同一个 cid 只下一次，用户连点也不会把带宽打满 */
const segmentJobs = new Map<string, Promise<SegmentFiles | null>>()

/** 一次分段准备的产物：画面一份 +（可选）音轨一份 */
interface SegmentFiles {
  filepath: string
  audioPath?: string
}

/**
 * 分段准备的进度表：`token:cid` → 现在在哪一步、下了多少。
 *
 * 播放页点完选项会轮询 `/progress?cid=…` 把它显示成进度条 ——
 * 一段视频要「取流 → 下画面 → 下声音 → ffmpeg 合成」，好几秒起步，
 * 这段时间没有任何反馈的话用户面对的就是一块黑屏（体验非常割裂）。
 */
interface SegmentProgressEntry {
  cid: number
  stage: SegmentStage | 'idle'
  bytes: number
  total: number
  at: number
  /** 失败原因（页面直接把这句话显示给用户，省得用户只能看到一个「没准备好」） */
  reason?: string
}
const segmentProgress = new Map<string, SegmentProgressEntry>()
/** 进度条目保留多久：够页面轮询到就行，别当成内存垃圾堆 */
const SEGMENT_PROGRESS_TTL_MS = 10 * 60 * 1000

const progressKey = (token: string, cid: number): string => token + ':' + cid

function setSegmentProgress (
  token: string,
  cid: number,
  stage: SegmentStage,
  bytes = 0,
  total = 0,
  reason?: string
): void {
  const now = Date.now()
  for (const [key, item] of segmentProgress) {
    if (now - item.at > SEGMENT_PROGRESS_TTL_MS) segmentProgress.delete(key)
  }
  segmentProgress.set(progressKey(token, cid), { cid, stage, bytes, total, at: now, reason })
}

/**
 * 分段进度查询（播放页轮询它）。
 *
 * 已经下好的分段直接回 `ready`（页面据此立刻换源，不用等一次往返）；
 * 没记录过就回 `idle`（页面不用为「还没开始」特判 404）。
 */
function progressResponse (token: string, query: URLSearchParams): PlayerHttpResponse {
  const cid = Number(query.get('cid'))
  const session = getPlayerSession(token)
  if (!session?.story || !isValidStoryCid(cid)) return notFound(false)
  const cached = resolvePlayerSegment(token, cid) ??
    (Number(session.story.cid) === Number(cid) ? resolvePlayerVideo(token) : null)
  /** 文件已经在会话目录里了：一律按「就绪 + 真实体积」回，页面立刻换源 */
  if (cached) {
    return jsonResponse({ cid, stage: 'ready', bytes: cached.size, total: cached.size, percent: 100 })
  }
  const item = segmentProgress.get(progressKey(token, cid))
  return jsonResponse({
    cid,
    stage: item?.stage ?? 'idle',
    bytes: item?.bytes ?? 0,
    total: item?.total ?? 0,
    percent: item && item.total > 0 ? Math.min(100, Math.floor((item.bytes / item.total) * 100)) : 0,
    /** 失败时把原因带上：页面直接显示，用户才知道到底是「下载失败」还是「没有这一段的直链」 */
    reason: item?.reason
  })
}

function segmentJob (token: string, cid: number, run: () => Promise<SegmentFiles | null>): Promise<SegmentFiles | null> {
  const key = token + ':' + cid
  const running = segmentJobs.get(key)
  if (running) return running
  const job = run().finally(() => { segmentJobs.delete(key) })
  segmentJobs.set(key, job)
  return job
}

/**
 * 互动视频的某一段：当前这一段直接发会话里的主视频，其它段**按需下载**（下完留在会话目录里）。
 *
 * @param cid 目标分段的 cid
 */
async function segmentResponse (
  token: string,
  cid: number,
  range?: string,
  head = false,
  download = false,
  /** true = 要**音轨**（`?audio=1`）；B站音视频是两条流，播放页两个元素同时播，不合成 */
  wantAudio = false
): Promise<PlayerHttpResponse> {
  const session = getPlayerSession(token)
  if (!session?.story || !isValidStoryCid(cid)) return notFound(false)
  const kind: SegmentKind = wantAudio ? 'audio' : 'video'
  const type = wantAudio ? 'audio/mp4' : 'video/mp4'
  const ext = wantAudio ? '.m4a' : '.mp4'
  /** 当前这一段就是会话里的那份，不用绕路也不用下载 */
  if (Number(session.story.cid) === Number(cid)) {
    const current = wantAudio ? resolvePlayerAudio(token) : resolvePlayerVideo(token)
    if (current) return fileResponse(token, current, type, range, head, download, ext)
  }
  const cached = resolvePlayerSegment(token, cid, kind)
  if (cached) return fileResponse(token, cached, type, range, head, download, ext)

  const source = getPlayerStorySource(token)
  if (!source?.segment) return notFound(false)
  const started = Date.now()
  logger.mark('[在线播放] 正在准备互动分段 cid=' + cid + '（' + token + '）')
  setSegmentProgress(token, cid, 'queued')
  const prepared = await segmentJob(token, cid, async () => {
    /** 把平台侧报的进度记下来，播放页轮询 /progress 就能画出进度条 */
    const report: SegmentReporter = (info) => setSegmentProgress(token, cid, info.stage, info.bytes, info.total)
    try {
      const result = await source.segment!(cid, report)
      if (!result) {
        logger.warn('[在线播放] 互动分段准备失败（平台侧没拿到文件）cid=' + cid + '，详情见上面的日志')
        setSegmentProgress(token, cid, 'failed', 0, 0, '平台侧没拿到这一段（详见机器人控制台日志）')
      } else {
        setSegmentProgress(token, cid, 'ready')
      }
      return result
    } catch (error: any) {
      /**
       * 这里**不往上抛**：抛出去路由就变成 500（页面只会看到「媒体加载失败」），
       * 而我们要的是「路由回 404 + 进度接口把原因带给页面」—— 用户才知道到底卡在哪一步。
       */
      logger.warn('[在线播放] 互动分段准备异常 cid=' + cid + '：' + String(error?.message ?? error))
      setSegmentProgress(token, cid, 'failed', 0, 0, String(error?.message ?? error).slice(0, 120) || '准备这一段时出错')
      return null
    }
  })
  /**
   * 并发同一个分段时两个请求等的是同一个任务，**文件只该被搬一次**：
   * 先看一眼缓存（另一个请求可能已经搬进去了），没有再自己搬。
   * 画面和音轨各搬各的（两个元素会分别来取）。
   */
  const sourcePath = wantAudio ? prepared?.audioPath : prepared?.filepath
  /**
   * **一次把两份都搬进会话目录**（画面 + 音轨）。
   *
   * 页面上是两个元素分别来取文件的：只搬自己那份的话，另一个元素来的时候
   * 会发现缓存里没有、于是**把整段又下一次**（同一条会话、同一个 cid 白下两遍）。
   */
  if (prepared?.filepath) adoptPlayerSegment(token, cid, prepared.filepath, 'video')
  if (prepared?.audioPath) adoptPlayerSegment(token, cid, prepared.audioPath, 'audio')
  const ready = resolvePlayerSegment(token, cid, kind) ??
    (sourcePath ? adoptPlayerSegment(token, cid, sourcePath, kind) : null)
  if (!ready) return notFound(false)
  logger.mark('[在线播放] 互动分段' + (wantAudio ? '音轨' : '画面') + '准备完成 cid=' + cid
    + '（' + (Date.now() - started) + 'ms）')
  return fileResponse(token, ready, type, range, head, download, ext)
}

/**
 * 分发一条请求。
 * @param request 请求（路径 + Range）
 * @returns 响应描述
 */
export async function handlePlayerRequest (request: PlayerHttpRequest): Promise<PlayerHttpResponse> {
  const method = String(request.method ?? 'GET').toUpperCase()
  const path = String(request.path ?? '')
  /** 查询参数：目前只认 download（`?download=1` = 下载而不是在页面里播放） */
  const query = new URLSearchParams(String(request.query ?? '').replace(/^\?/, ''))
  const wantDownload = query.has('download') && query.get('download') !== '0'
  // 播放器不开时路由整块不存在（调用方根本不会注册，这里再兜一层）
  if (!path.startsWith(PLAYER_ROUTE_PREFIX)) return notFound(false)
  if (method !== 'GET' && method !== 'HEAD') {
    return { status: 405, headers: { 'Content-Type': TEXT_TYPE, Allow: 'GET, HEAD' }, body: Buffer.from('只支持 GET') }
  }

  const rest = path.slice(PLAYER_ROUTE_PREFIX.length)
  const parts = rest.split('/').filter((item) => item !== '')
  const token = parts[0] ?? ''
  const action = parts[1] ?? ''
  /** 第三段：目前只有 /segment/<cid> 用得上 */
  const sub = parts[2] ?? ''
  if (parts.length > 3 || !isValidPlayerToken(token)) return notFound(!action)
  // 会话不存在 / 已过期：页面回「链接已过期」的 404 页，接口回纯文本 404
  if (!getPlayerSession(token)) return notFound(action === '')

  if (!action) {
    const session = getPlayerSession(token)!
    return {
      status: 200,
      headers: { 'Content-Type': HTML_TYPE, 'Cache-Control': 'no-store' },
      body: Buffer.from(renderPlayerPage(session))
    }
  }
  if (action === 'video') return videoResponse(token, request.range, method === 'HEAD', wantDownload)
  // 独立音轨（B站音视频分离时才有）：播放页的 <audio> 播它，?download=1 下载 m4a
  if (action === 'audio') return audioResponse(token, request.range, method === 'HEAD', wantDownload)
  /**
   * 按需合成后下载 / 播放：第一次会跑一次 ffmpeg -c copy（一两秒），之后走缓存。
   * 合成失败（没有独立音轨 / 没有 ffmpeg）回 404，页面上的按钮也就不该点得动。
   */
  if (action === 'merged') {
    const merged = await ensureMerged(token)
    if (!merged) return notFound(false)
    return fileResponse(token, merged, 'video/mp4', request.range, method === 'HEAD', wantDownload, '.mp4')
  }
  // 独立路由：`/kkk/player/<token>/download` 与 `/video?download=1` 完全等价
  if (action === 'download') return videoResponse(token, request.range, method === 'HEAD', true)
  if (action === 'danmaku') return danmakuResponse(token)
  if (action === 'cover') return coverResponse(token)
  // 互动视频：当前剧情（题目 + 选项）与分段视频
  if (action === 'story') return storyResponse(token, query)
  if (action === 'segment') {
    const wantAudio = query.has('audio') && query.get('audio') !== '0'
    return segmentResponse(token, Number(sub), request.range, method === 'HEAD', wantDownload, wantAudio)
  }
  // 互动视频：分段准备的进度（播放页点完选项轮询它显示加载进度）
  if (action === 'progress') return progressResponse(token, query)
  return notFound(false)
}

/** 把响应写进 Koishi（Koa）的上下文 */
async function writeKoa (koa: any, response: PlayerHttpResponse): Promise<void> {
  koa.status = response.status
  for (const [key, value] of Object.entries(response.headers)) koa.set(key, value)
  if (response.file) {
    koa.body = fs.createReadStream(response.file.path, { start: response.file.start, end: response.file.end })
    return
  }
  koa.body = response.body ?? ''
}

/** 把响应写进 node:http 的响应对象 */
async function writeNode (res: http.ServerResponse, response: PlayerHttpResponse, head: boolean): Promise<void> {
  res.writeHead(response.status, response.headers)
  if (head || !response.file && !response.body) {
    res.end()
    return
  }
  if (response.file) {
    const stream = fs.createReadStream(response.file.path, { start: response.file.start, end: response.file.end })
    stream.on('error', () => { try { res.destroy() } catch { /* 忽略 */ } })
    stream.pipe(res)
    return
  }
  res.end(response.body)
}

/**
 * 注册播放路由。
 * @param options.ctx Koishi 上下文
 * @param options.port 独立端口（0 = 挂到 ctx.server）
 * @returns 卸载函数（插件 dispose 时调用）
 */
export function registerPlayerRoutes ({ ctx, port }: { ctx: any, port: number }): () => void {
  const disposers: Array<() => void> = []

  if (port > 0) {
    const server = http.createServer((req, res) => {
      const handle = async () => {
        const method = String(req.method ?? 'GET').toUpperCase()
        const raw = String(req.url ?? '/')
        const queryAt = raw.indexOf('?')
        const path = decodeURIComponent(queryAt >= 0 ? raw.slice(0, queryAt) : raw)
        const response = await handlePlayerRequest({
          method,
          path,
          range: String(req.headers.range ?? ''),
          query: queryAt >= 0 ? raw.slice(queryAt) : ''
        })
        await writeNode(res, response, method === 'HEAD')
      }
      handle().catch((error: any) => {
        logger.warn('[在线播放] 处理请求失败: ' + String(error?.message ?? error))
        try {
          res.writeHead(500, { 'Content-Type': TEXT_TYPE })
          res.end('服务器内部错误')
        } catch { /* 已经发出去就算了 */ }
      })
    })
    server.on('error', (error: any) => {
      const code = String(error?.code ?? error?.message ?? error)
      /**
       * 端口被别的进程占了：**必须说清楚后果** —— 线上真实故障就是「用户点开播放链接看到『链接已过期』」。
       *
       * 成因：这台实例退回 Koishi 自己的端口，而另一台实例（比如同机的测试实例）抢到了这个端口；
       * 域名反代到该端口 → 用户访问的其实是**另一台实例**，它当然没有这个会话。
       */
      logger.error('[在线播放] 播放器端口 ' + port + ' 被占用（' + code + '），本次退回 Koishi 自己的端口'
        + (publicBaseUrl() ? '。注意：域名 ' + publicBaseUrl() + ' 反代的就是 ' + port + ' 的话，用户点开链接会看到「链接已过期」'
          + ' —— 说明这台实例不是 8888 的占用者（同机另一个 Koishi 实例抢到了），换一个端口或先停掉那台实例' : ''))
      standaloneReady = false
      // 端口被占用不能把插件带崩：退回 ctx.server 再挂一遍
      registerOnKoishi(ctx, disposers)
    })
    try {
      server.listen(port, () => {
        standaloneReady = true
        logger.info('[在线播放] 播放器已监听独立端口 ' + port)
      })
      disposers.push(() => { try { server.close() } catch { /* 忽略 */ } })
    } catch (error: any) {
      logger.warn('[在线播放] 播放器端口 ' + port + ' 无法监听（' + String(error?.message ?? error) + '），改用 Koishi 自己的端口')
      registerOnKoishi(ctx, disposers)
    }
    return () => { for (const dispose of disposers) dispose() }
  }

  registerOnKoishi(ctx, disposers)
  return () => { for (const dispose of disposers) dispose() }
}

/** 挂到 Koishi 的 ctx.server 上（没有 server 服务时只记一条日志，功能其余部分照常） */
function registerOnKoishi (ctx: any, disposers: Array<() => void>): void {
  const server: any = ctx?.server
  if (!server || typeof server.get !== 'function') {
    logger.warn('[在线播放] 当前宿主没有 server 服务，播放链接无法访问；可把 playerPort 设成一个独立端口')
    return
  }
  /** 把 koa 上的这一段请求交给统一的处理函数；sub 是第三段（目前只有 /segment/<cid> 用） */
  const route = async (koa: any, token: string, action: string, sub = ''): Promise<void> => {
    const response = await handlePlayerRequest({
      method: String(koa.method ?? 'GET'),
      path: PLAYER_ROUTE_PREFIX + token + (action ? '/' + action : '') + (sub ? '/' + sub : ''),
      range: String(koa.headers?.range ?? ''),
      // koa.search 形如 '?download=1'；旧的 querystring 不带问号也没关系（handlePlayerRequest 会去掉）
      query: String(koa.search ?? koa.querystring ?? '')
    })
    await writeKoa(koa, response)
  }
  const base = '/kkk/player/:token'
  server.get(base, (koa: any) => route(koa, String(koa.params?.token ?? ''), ''))
  /**
   * 其余动作逐个注册。
   *
   * 以前这里只挂了 video / download / danmaku 三条，于是 playerPort=0（复用 Koishi 端口）时
   * `/audio`、`/merged`、`/cover` **全是 404** —— 音视频分离的播放页会「有画面没声音」、
   * 下载按钮点了报错。现在按 handlePlayerRequest 支持的动作表统一挂一遍，不再漏。
   */
  for (const action of ['video', 'audio', 'merged', 'download', 'danmaku', 'cover', 'story']) {
    server.get(base + '/' + action, (koa: any) => route(koa, String(koa.params?.token ?? ''), action))
  }
  server.get(base + '/segment/:cid', (koa: any) => route(
    koa,
    String(koa.params?.token ?? ''),
    'segment',
    String(koa.params?.cid ?? '')
  ))
  logger.info('[在线播放] 播放路由已挂到 Koishi 端口：/kkk/player/:token')
}
