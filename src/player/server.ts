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

import { tryGetRuntime } from '../../compat/runtime'

import { renderExpiredPage, renderPlayerPage } from './page'
import {
  getPlayerSession,
  isValidPlayerToken,
  markPlayerMerged,
  readPlayerDanmaku,
  resolvePlayerAudio,
  resolvePlayerCover,
  resolvePlayerMerged,
  resolvePlayerVideo
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
  if (parts.length > 2 || !isValidPlayerToken(token)) return notFound(!action)
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
  const route = async (koa: any, token: string, action: string): Promise<void> => {
    const response = await handlePlayerRequest({
      method: String(koa.method ?? 'GET'),
      path: PLAYER_ROUTE_PREFIX + token + (action ? '/' + action : ''),
      range: String(koa.headers?.range ?? ''),
      // koa.search 形如 '?download=1'；旧的 querystring 不带问号也没关系（handlePlayerRequest 会去掉）
      query: String(koa.search ?? koa.querystring ?? '')
    })
    await writeKoa(koa, response)
  }
  server.get('/kkk/player/:token', (koa: any) => route(koa, String(koa.params?.token ?? ''), ''))
  server.get('/kkk/player/:token/video', (koa: any) => route(koa, String(koa.params?.token ?? ''), 'video'))
  server.get('/kkk/player/:token/download', (koa: any) => route(koa, String(koa.params?.token ?? ''), 'download'))
  server.get('/kkk/player/:token/danmaku', (koa: any) => route(koa, String(koa.params?.token ?? ''), 'danmaku'))
  logger.info('[在线播放] 播放路由已挂到 Koishi 端口：/kkk/player/:token')
}
