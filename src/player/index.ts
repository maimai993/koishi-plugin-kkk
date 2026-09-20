/**
 * 在线播放器（弹幕在线看）。
 *
 * 用户要弹幕时，视频不再烧进画面、也不发到群里，而是：
 *   下载视频 → 登记播放会话（磁盘 + 内存）→ 回一条公网链接 → 用户点开就是带弹幕的播放页。
 *
 * 三个开关都在「通用 → 在线播放器设置」里（见 src/qqFields.json）：
 *   playerEnabled        总开关，默认关 —— 关着时行为跟以前完全一样（真烧录、文案是「烧录弹幕」）
 *   playerBaseUrl        公网地址，留空时退化成「本机可访问地址」并打警告
 *   playerPort           0 = 复用 Koishi 自己的端口；非 0 用 node:http 另起一个
 *   playerExpireMinutes  链接 / 文件的有效期（分钟），到点自动删视频和弹幕
 *
 * 本文件是播放器对外的总入口：配置读取、链接拼接、弹幕格式归一、会话发布、路由挂载。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { logger } from 'node-karin'

import { PLUGIN_DIR_NAME, tryGetRuntime } from '../compat/runtime'
// 解析阶段（「下载进度」指令读的就是这里登记的状态）
import { DOWNLOAD_STAGES, clearParseStage, updateDownloadStage } from '../karin/module/utils/Network/Downloader'
import { getParseOverride } from '../karin/module/utils/ParseOverride'
import { registerPlayerRoutes } from './server'
import {
  normalizeExpireMinutes,
  registerPlayerSession,
  setupPlayerStore,
  startPlayerSweeper,
  stopPlayerSweeper,
  type PlayerDanmakuItem,
  type PlayerWorkInfo
} from './store'

export * from './store'
export * from './page'
export * from './server'

/**
 * 在线播放器总开关是否打开。
 *
 * **默认开启**（和「面板带打开原站链接」一样）：运行时配置里没写这个键时按开启处理，
 * 只有管理员显式关掉（false）才回到原来的 ffmpeg 烧录流程。
 */
export function isOnlinePlayerEnabled (): boolean {
  try {
    return (tryGetRuntime()?.config as any)?.playerEnabled !== false
  } catch {
    return true
  }
}

/**
 * 本次解析是不是「在线播放」。
 *
 * 由 apps/tools.ts 通过 ParseOverride 传下来（避免把参数一层层塞进十几个函数签名），
 * 平台 handler 与弹幕策略都读它。
 */
export function isOnlinePlayerRequest (): boolean {
  return getParseOverride()?.onlinePlayer === true
}

/**
 * 浏览器**明令禁止访问**的端口（WHATWG 那份 + Chrome/Edge/Firefox 都用它）。
 *
 * 踩过的坑：把播放器端口配成 6666（IRC 段 6665-6669）之后，链接在浏览器里直接
 * `ERR_UNSAFE_PORT`，页面根本打不开 —— 服务端其实一切正常，纯浏览器侧的拦截。
 * 这里用来在启动/生成链接时提醒管理员换端口（反向代理场景可以不换，见 setupOnlinePlayer）。
 */
export const UNSAFE_PORTS = new Set<number>([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161,
  179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
  587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060,
  5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080
])

/** 这个端口浏览器会不会直接拒绝（ERR_UNSAFE_PORT） */
export function isUnsafePlayerPort (port: unknown): boolean {
  const num = Number(port)
  return Number.isInteger(num) && UNSAFE_PORTS.has(num)
}

/** 链接 / 文件有效期（分钟），配置里写歪了会被夹到 1~1440 */
export function playerExpireMinutes (): number {
  return normalizeExpireMinutes((tryGetRuntime()?.config as any)?.playerExpireMinutes)
}

/** 「超限转在线播放」开关本身是否打开（默认关） */
export function isPlayerOversizeRedirectOn (): boolean {
  try {
    return (tryGetRuntime()?.config as any)?.playerOnOversize === true
  } catch {
    return false
  }
}

/**
 * 现在要不要把「超过全局体积上限」的视频改成在线播放。
 *
 * 两个条件都要满足：播放器总开关开着（否则没有播放页可去）+ 这一项开关打开。
 */
export function shouldRedirectOversizeToPlayer (): boolean {
  return isOnlinePlayerEnabled() && isPlayerOversizeRedirectOn()
}

/**
 * 把「本次解析改成在线播放」写进当前解析的覆盖项（ParseOverride）。
 *
 * 用在**下载那一步**：Base.downloadVideoFile 发现视频超过全局上限、而管理员开着
 * 「超限转在线播放」，就把这次解析标记成在线播放，继续下载；
 * 平台 handler 后面读 isOnlinePlayerRequest() 就知道该发播放页而不是发文件。
 *
 * 覆盖项是 runWithParseOverride 里那个对象，只对本次解析的异步链路可见，不会串味。
 */
export function markOnlinePlayerOverride (): void {
  const override = getParseOverride()
  if (override) override.onlinePlayer = true
}

/**
 * 有效体积上限（MB）：0 表示不限制。
 *
 * 「在线播放最大文件」（playerMaxFileMB）留空 / 填 0 时就**跟随全局** ——
 * 用上游「文件大小限制」那一项（usefilelimit / filelimit）的值，由调用方读出来传进来。
 * 例外：打开了「超限转在线播放」时，留空按**不限制**处理 ——
 * 这个开关服务的就是「比全局上限还大」的视频，跟随全局等于刚转过来就被拦回去。
 * @param globalLimitMB 全局限制（MB），0 = 全局没开限制
 */
export function effectivePlayerSizeLimitMB (globalLimitMB = 0): number {
  const configured = Number((tryGetRuntime()?.config as any)?.playerMaxFileMB)
  if (Number.isFinite(configured) && configured > 0) return configured
  if (isPlayerOversizeRedirectOn()) return 0
  const global = Number(globalLimitMB)
  return Number.isFinite(global) && global > 0 ? global : 0
}

/**
 * 读全局的「文件大小限制」。
 *
 * Config 是 karin 那套配置代理，import 时会去读兼容层运行时状态，
 * 所以这里用动态 import（本模块在插件入口 require 阶段就会被加载，顶层引入会炸）。
 * @returns 全局限制（MB）；没开限制就是 0
 */
export async function globalFileLimitMB (): Promise<number> {
  try {
    const { Config } = await import('../karin/module/utils/Config')
    const app: any = (Config as any)?.app ?? {}
    if (app.usefilelimit === false) return 0
    const limit = Number(app.filelimit)
    return Number.isFinite(limit) && limit > 0 ? limit : 0
  } catch (error: any) {
    logger.debug('[在线播放] 读取全局文件大小限制失败（按不限制处理）: ' + String(error?.message ?? error))
    return 0
  }
}

/** 在线播放实际生效的体积上限（MB）；0 = 不限制 */
export async function resolvePlayerSizeLimitMB (): Promise<number> {
  return effectivePlayerSizeLimitMB(await globalFileLimitMB())
}

/** 取一个本机可访问的 IPv4（playerBaseUrl 留空时的兜底） */
function localAddress (): string {
  try {
    const interfaces = os.networkInterfaces()
    for (const name of Object.keys(interfaces)) {
      for (const info of interfaces[name] ?? []) {
        if (info.family === 'IPv4' && !info.internal) return info.address
      }
    }
  } catch { /* 拿不到就用回环地址 */ }
  return '127.0.0.1'
}

/**
 * Koishi 自己监听的端口（playerPort 为 0、或者端口不安全退回时，链接得指向它）。
 *
 * **优先读 `ctx.server.port`** —— 那才是真正 listen 的端口
 * （@cordisjs/plugin-server 在 ready 时写入）。配置树里那份 `port` 常常取不到：
 * 这台部署的端口是写在 server 插件自己的作用域里的（`group:server → server.port: 5200`），
 * 只读 `ctx.config / ctx.root.config` 会拿到默认值 5140，链接就指错端口了（真踩过）。
 * 注意 ready 之前 `server.port` 还是 undefined，所以这里保留后面的兜底。
 */
function koishiPort (): number {
  const ctx: any = tryGetRuntime()?.ctx
  const candidates = [
    ctx?.server?.port,
    ctx?.config?.port,
    ctx?.root?.config?.port,
    ctx?.app?.options?.port,
    process.env.PORT
  ]
  for (const value of candidates) {
    const num = Number(value)
    if (Number.isFinite(num) && num > 0) return num
  }
  return 5140
}

/** 只警告一次「没配公网地址」：每条链接都刷一行日志太吵 */
let warnedLocalBase = false

/**
 * 拼给用户的播放链接。
 *
 * 配了 playerBaseUrl 就用它（末尾斜杠去掉，用户复制粘贴带斜杠也不会拼出双斜杠）；
 * 没配就退化成 `http://本机IP:端口/kkk/player/<token>` 并警告 —— 群里的人多半打不开，
 * 但内网部署（同一台机器 / 同一个局域网）是可用的。
 */
export function buildPlayerLink (token: string): string {
  const config: any = tryGetRuntime()?.config ?? {}
  const base = String(config.playerBaseUrl ?? '').replace(/\/+$/, '')
  if (base) return base + '/kkk/player/' + token
  const port = Number(config.playerPort) > 0 ? Number(config.playerPort) : koishiPort()
  const link = 'http://' + localAddress() + ':' + port + '/kkk/player/' + token
  if (!warnedLocalBase) {
    warnedLocalBase = true
    logger.warn('[在线播放] 还没有配置公网地址，链接先退化成 ' + link
      + '（只在本机 / 内网可用）。公网部署请到「通用 → 在线播放器设置 → 播放器公网地址」填上，'
      + '例如 https://play.example.com')
  }
  // 端口在浏览器的黑名单里：服务端没事，但用户点开会直接 ERR_UNSAFE_PORT
  if (isUnsafePlayerPort(port)) {
    logger.warn('[在线播放] 播放器端口 ' + port + ' 是浏览器禁止访问的端口（ERR_UNSAFE_PORT），'
      + '上面这条链接在浏览器里打不开；请到「在线播放器设置 → 播放器端口」换一个（例如 8888 / 8899），'
      + '或者配上「播放器公网地址」走反向代理')
  }
  return link
}

/** 弹幕条数上限：B站热门视频动辄十几万条，整包塞给浏览器没有意义（页面也画不过来） */
const MAX_PLAYER_DANMAKU = 50000

/**
 * 把各平台的弹幕归一成播放页用的格式。
 *
 *   - B站：`{ progress, mode, fontsize, color, content }` → 原样对应
 *   - 抖音：`{ offset_time, text }` → 只有滚动弹幕，颜色字号用默认值；
 *     抖音的弹幕表情是图片贴纸，这里直接降级成它的文字占位（例如 [捂脸]）
 * @param list 原始弹幕数组（两种形状都认）
 */
export function normalizePlayerDanmaku (list: any): PlayerDanmakuItem[] {
  if (!Array.isArray(list)) return []
  const items: PlayerDanmakuItem[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const isBili = raw.progress !== undefined || raw.content !== undefined
    const time = Number(isBili ? raw.progress : raw.offset_time)
    const text = String(isBili ? (raw.content ?? '') : (raw.text ?? '')).trim()
    if (!text || !Number.isFinite(time) || time < 0) continue
    const mode = Number(isBili ? raw.mode : 1) || 1
    items.push({
      time: Math.round(time),
      // 1/2/3 滚动，4 底部，5 顶部；认不出来的当滚动处理
      mode: [1, 2, 3, 4, 5].includes(mode) ? mode : 1,
      size: Number(isBili ? raw.fontsize : 25) || 25,
      color: Number(isBili ? raw.color : 0xffffff) || 0xffffff,
      text: text.slice(0, 200)
    })
  }
  items.sort((a, b) => a.time - b.time)
  if (items.length > MAX_PLAYER_DANMAKU) {
    logger.debug('[在线播放] 弹幕过多（' + items.length + ' 条），只保留前 ' + MAX_PLAYER_DANMAKU + ' 条')
    return items.slice(0, MAX_PLAYER_DANMAKU)
  }
  return items
}

/**
 * 把封面下到临时文件（失败就返回 null）。
 *
 * 限制得比较保守：只认图片、10 秒超时、最大 5MB —— 封面只是个装饰，
 * 不能让它拖慢解析或者把临时目录塞满。
 */
const MAX_COVER_BYTES = 5 * 1024 * 1024

async function downloadCoverQuietly (url?: string): Promise<string | null> {
  const target = String(url ?? '').trim()
  if (!/^https?:\/\//i.test(target)) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(target, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: new URL(target).origin + '/' }
    })
    if (!res.ok) return null
    const type = String(res.headers.get('content-type') ?? '')
    if (!/^image\//i.test(type)) return null
    const buffer = Buffer.from(await res.arrayBuffer())
    if (!buffer.length || buffer.length > MAX_COVER_BYTES) return null
    const ext = type.includes('png')
      ? '.png'
      : type.includes('webp') ? '.webp' : type.includes('gif') ? '.gif' : '.jpg'
    const file = path.join(os.tmpdir(), 'kkk-cover-' + Date.now() + '-' + Math.random().toString(16).slice(2) + ext)
    fs.writeFileSync(file, buffer)
    return file
  } catch (error: any) {
    logger.debug('[在线播放] 封面下载失败（忽略）: ' + String(error?.message ?? error))
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 体积显示：小于 1MB 的右上限（测试/极端配置）也要看得出区别，别都显示成 0.0MB */
function formatMB (value: number): string {
  const num = Number(value)
  if (!Number.isFinite(num)) return '0MB'
  if (num >= 10) return num.toFixed(0) + 'MB'
  if (num >= 1) return num.toFixed(1) + 'MB'
  return String(Number(num.toFixed(3))) + 'MB'
}

/** 与用户之间的两句话（播放器模式下的文案，别再说「添加弹幕」了） */
const TIP_PREPARING = '下载完成，正在准备在线播放…'

/**
 * 发布一个在线播放会话：登记 + 回链接。
 *
 * 失败不抛异常 —— 调用方拿到 false 就退回「直接发视频文件」的老流程，
 * 在线播放器坏了不能连累整条解析。
 * @param e 消息事件
 * @param input 视频路径 / 标题 / 平台 / 弹幕 / 作品信息
 * @returns 是否成功发布了链接
 */
export async function publishOnlinePlayer (e: any, input: {
  videoPath: string
  title?: string
  platform?: string
  danmaku?: any
  /** 作品信息：UP 主 / 播放量 / 发布时间…（播放页按B站那样展示，拿不到就不显示） */
  work?: PlayerWorkInfo
  /** 已经下到本地的封面文件（优先用它，其次才去下 work.coverUrl） */
  coverPath?: string
}): Promise<boolean> {
  if (!isOnlinePlayerEnabled()) return false
  /**
   * 在线播放模式下的「处理阶段」：下载已经完成，接下来是登记播放会话 + 回链接。
   * 用户这时候点「下载进度」应该看到「正在准备在线播放」，而不是「当前没有正在进行的下载」。
   */
  updateDownloadStage(DOWNLOAD_STAGES.preparingPlayer)
  const reply = async (content: string) => {
    try {
      await e?.reply?.(content)
    } catch (error: any) {
      logger.debug('[在线播放] 回复失败: ' + String(error?.message ?? error))
    }
  }
  try {
    const minutes = playerExpireMinutes()
    const danmaku = normalizePlayerDanmaku(input.danmaku)
    /**
     * 体积上限：超过就不做在线播放，回一句说明并返回 false ——
     * 调用方拿到 false 会退回「直接发送视频文件」，用户不会什么都没有。
     */
    const sizeMB = Number(fs.statSync(input.videoPath).size) / 1024 / 1024
    const limitMB = await resolvePlayerSizeLimitMB()
    if (limitMB > 0 && sizeMB > limitMB) {
      logger.info('[在线播放] 视频 ' + sizeMB.toFixed(1) + 'MB 超过在线播放上限 ' + limitMB + 'MB，改回原来的发送流程')
      await reply('视频 ' + formatMB(sizeMB) + '，超过在线播放的体积上限 ' + formatMB(limitMB) + '，这里按原来的方式发送')
      return false
    }
    await reply(TIP_PREPARING)
    /**
     * 封面：趁现在把它下到本地（会话目录里存一份），播放页用**同源**地址取 ——
     * 直接塞平台 CDN 的外链会让页面依赖外网，内网 / 断网部署就是一张裂图。
     * 下载失败不影响播放，页面上就不显示封面。
     */
    const coverPath = input.coverPath ?? await downloadCoverQuietly(input.work?.coverUrl)
    const session = registerPlayerSession({
      videoPath: input.videoPath,
      title: input.title,
      platform: input.platform,
      danmaku,
      expireMinutes: minutes,
      work: input.work,
      coverPath: coverPath ?? undefined
    })
    if (!session) {
      await reply('在线播放准备失败（详情见日志），这里直接发送视频')
      return false
    }
    await reply('在线播放：' + buildPlayerLink(session.token)
      + '\n链接 ' + minutes + ' 分钟内有效，弹幕就在网页里，过期后自动清理。')
    return true
  } catch (error: any) {
    logger.error('[在线播放] 发布播放会话失败: ' + String(error?.stack ?? error))
    await reply('在线播放准备失败（详情见日志），这里直接发送视频')
    return false
  } finally {
    // 阶段结束就清掉（成功失败都清）：下一阶段（比如退回发送）会重新登记
    clearParseStage()
  }
}

/**
 * 按配置初始化在线播放器：存储 + 过期清理 + 路由。
 * @param ctx Koishi 上下文
 * @returns 卸载函数
 */
export function setupOnlinePlayer (ctx: any): () => void {
  const runtime = tryGetRuntime()
  if (!isOnlinePlayerEnabled()) {
    logger.debug('[在线播放] 未开启在线播放器（通用 → 在线播放器设置 → 在线播放器）')
    return () => {}
  }
  const dataRoot = runtime?.dataRoot ?? process.cwd()
  const dir = path.join(dataRoot, PLUGIN_DIR_NAME, 'player')
  setupPlayerStore(dir)
  startPlayerSweeper()
  const configuredPort = Number((runtime?.config as any)?.playerPort) > 0 ? Number((runtime?.config as any).playerPort) : 0
  const hasPublicBase = !!String((runtime?.config as any)?.playerBaseUrl ?? '').trim()
  /**
   * 配置的端口在浏览器黑名单里、而且**没配公网地址**（链接会直接指向这个端口）→ 退回 Koishi 端口。
   *
   * 服务端本身没问题，但用户点开链接浏览器会直接 `ERR_UNSAFE_PORT`（看起来就是「网页坏了」）。
   * 配了公网地址的（反向代理场景）照旧用配置的端口，不动它。
   */
  const unsafeWithoutBase = configuredPort > 0 && isUnsafePlayerPort(configuredPort) && !hasPublicBase
  const port = unsafeWithoutBase ? 0 : configuredPort
  if (unsafeWithoutBase) {
    // 这里不打具体端口号：apply 阶段 ctx.server.port 还没赋值，写出来的数字会是假的，
    // 链接里用的是真实端口（buildPlayerLink 生成时会连链接一起打日志）
    logger.warn('[在线播放] 播放器端口 ' + configuredPort + ' 是浏览器禁止访问的端口（ERR_UNSAFE_PORT），'
      + '而且没有配置「播放器公网地址」—— 这次先退回 Koishi 自己的端口（链接里写的是真实端口），'
      + '链接照常能用；想继续用 ' + configuredPort
      + ' 请配好公网地址走反向代理，或者干脆换一个端口（推荐 8888 这类）')
  }
  const disposeRoutes = registerPlayerRoutes({ ctx, port })
  logger.info('[在线播放] 在线播放器已开启：' + playerExpireMinutes() + ' 分钟有效期，文件目录 ' + dir
    + (port ? '（独立端口 ' + port + '）' : '（复用 Koishi 端口）'))
  if (!String((runtime?.config as any)?.playerBaseUrl ?? '').trim()) {
    logger.warn('[在线播放] 未配置「播放器公网地址」：链接会退化成 http://<本机 IP>:' + (port || koishiPort())
      + ' 的形式（本机 / 内网可用）。公网部署请在「通用 → 在线播放器设置」里填上，例如 https://play.example.com')
  }
  /**
   * 端口落在浏览器的黑名单里（例如 6666 属于 IRC 段 6665-6669）时**一定要提醒**：
   * 服务端一切正常，但用户点开链接浏览器会直接 `ERR_UNSAFE_PORT`，看起来就像「网页坏了」。
   * 反向代理场景（配了 playerBaseUrl、浏览器访问的是域名）可以忽略这条。
   */
  if (isUnsafePlayerPort(port)) {
    logger.warn('[在线播放] 播放器端口 ' + port + ' 是**浏览器禁止访问**的端口（Chrome/Edge 会报 ERR_UNSAFE_PORT），'
      + '除非你配了「播放器公网地址」走反向代理，否则请换一个端口（推荐 8888 / 8899 这类）')
  }
  return () => {
    disposeRoutes()
    stopPlayerSweeper()
  }
}
