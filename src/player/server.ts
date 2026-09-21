/**
 * 在线播放器的 HTTP 路由。
 *
 * 三条路由（都挂在自己拼的 `/kkk/player` 前缀下，和配置面板的 /kkk 互不干扰）：
 *   GET /kkk/player/:token           播放页（HTML）
 *   GET /kkk/player/:token/video     视频本体，支持 Range（拖进度条靠它）；`?download=1` = 下载
 *   GET /kkk/player/:token/download  同上，等价于 `/video?download=1`（带 Content-Disposition）
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

import { logger } from 'node-karin'

import { renderExpiredPage, renderPlayerPage } from './page'
import {
  getPlayerSession,
  isValidPlayerToken,
  readPlayerDanmaku,
  resolvePlayerCover,
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
export function downloadDisposition (title: unknown): string {
  const full = sanitizeDownloadName(title) + '.mp4'
  // 纯中文标题会变成一排下划线（对老客户端毫无意义），这种情况直接给个通用名
  const asciiRaw = full.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  // 只在**扩展名之前**数有效字符：纯中文标题会变成「_____.mp4」，那 3 个字母来自 .mp4 不能算数
  const asciiBase = asciiRaw.replace(/\.(mp4|mkv|webm|mov)$/i, '')
  const ascii = /[A-Za-z0-9]/.test(asciiBase) ? asciiRaw : 'video.mp4'
  const encoded = encodeURIComponent(full).replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase())
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encoded
}

/**
 * 视频响应：支持 Range，未过期时是 video/mp4。
 * @param download 为 true 时带上 `Content-Disposition: attachment`（浏览器直接下载），Range 照旧支持
 */
function videoResponse (token: string, range?: string, head = false, download = false): PlayerHttpResponse {
  const video = resolvePlayerVideo(token)
  if (!video) return notFound(false)
  const base: Record<string, string> = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  }
  // 下载：文件名取会话标题（清洗过），Range 行为不变（浏览器正常下载时也不会带 Range）
  if (download) base['Content-Disposition'] = downloadDisposition(getPlayerSession(token)?.title)
  const parsed = parseRange(range, video.size)
  if (parsed === 'invalid') {
    return {
      status: 416,
      headers: { ...base, 'Content-Range': 'bytes */' + video.size },
      body: Buffer.from('请求的范围无效')
    }
  }
  if (!parsed) {
    base['Content-Length'] = String(video.size)
    return { status: 200, headers: base, file: head ? undefined : { path: video.path, start: 0, end: video.size - 1 } }
  }
  const length = parsed.end - parsed.start + 1
  return {
    status: 206,
    headers: {
      ...base,
      'Content-Length': String(length),
      'Content-Range': 'bytes ' + parsed.start + '-' + parsed.end + '/' + video.size
    },
    file: head ? undefined : { path: video.path, start: parsed.start, end: parsed.end }
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
      logger.warn('[在线播放] 播放器端口 ' + port + ' 启动失败（' + String(error?.code ?? error?.message ?? error)
        + '），已退回 Koishi 自己的端口；请在配置里换一个端口或留空')
      // 端口被占用不能把插件带崩：退回 ctx.server 再挂一遍
      registerOnKoishi(ctx, disposers)
    })
    try {
      server.listen(port, () => {
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
