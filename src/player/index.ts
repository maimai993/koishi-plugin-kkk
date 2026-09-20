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
import { getParseOverride } from '../karin/module/utils/ParseOverride'
import { registerPlayerRoutes } from './server'
import {
  normalizeExpireMinutes,
  registerPlayerSession,
  setupPlayerStore,
  startPlayerSweeper,
  stopPlayerSweeper,
  type PlayerDanmakuItem
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

/** Koishi 自己监听的端口（playerPort 为 0 时链接得指向它） */
function koishiPort (): number {
  const ctx: any = tryGetRuntime()?.ctx
  const candidates = [ctx?.config?.port, ctx?.root?.config?.port, ctx?.app?.options?.port, process.env.PORT]
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
 * @param input 视频路径 / 标题 / 平台 / 弹幕
 * @returns 是否成功发布了链接
 */
export async function publishOnlinePlayer (e: any, input: {
  videoPath: string
  title?: string
  platform?: string
  danmaku?: any
}): Promise<boolean> {
  if (!isOnlinePlayerEnabled()) return false
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
    const session = registerPlayerSession({
      videoPath: input.videoPath,
      title: input.title,
      platform: input.platform,
      danmaku,
      expireMinutes: minutes
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
  const port = Number((runtime?.config as any)?.playerPort) > 0 ? Number((runtime?.config as any).playerPort) : 0
  const disposeRoutes = registerPlayerRoutes({ ctx, port })
  logger.info('[在线播放] 在线播放器已开启：' + playerExpireMinutes() + ' 分钟有效期，文件目录 ' + dir
    + (port ? '（独立端口 ' + port + '）' : '（复用 Koishi 端口）'))
  if (!String((runtime?.config as any)?.playerBaseUrl ?? '').trim()) {
    logger.warn('[在线播放] 未配置「播放器公网地址」：链接会退化成 http://<本机 IP>:' + (port || koishiPort())
      + ' 的形式（本机 / 内网可用）。公网部署请在「通用 → 在线播放器设置」里填上，例如 https://play.example.com')
  }
  return () => {
    disposeRoutes()
    stopPlayerSweeper()
  }
}
