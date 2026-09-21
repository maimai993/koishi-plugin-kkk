/**
 * 在线播放器的会话存储。
 *
 * 用户在解析面板里选了带弹幕的那一档之后，视频**不再发到群里**，而是登记成一个
 * 「播放会话」，再把公网链接回给用户，点开就是播放页。一个会话对应一个目录：
 *
 *   <数据目录>/koishi-plugin-kkk/player/<token>/video.mp4
 *   <数据目录>/koishi-plugin-kkk/player/<token>/danmaku.json
 *
 * 会话本身放在内存的 Map 里，同时把索引写一份 sessions.json —— 宿主重启后
 * 还没过期的会话照常能看，不会因为重启就全部 404。到期由定时器统一清理
 * （删视频 + 删弹幕 + 删索引），所以链接是有寿命的。
 *
 * 注意：本文件**不要**在模块顶层 import karin 的业务模块（Common / Config 之类），
 * 那些模块在 import 时就会去读兼容层运行时状态，而插件入口是
 * bindRuntime 之前就 require 本模块的，顶层引入会直接抛异常把插件带崩。
 * 需要用到它们时一律在函数里动态 import。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { logger } from 'node-karin'

/** 播放页里的一条弹幕（已折算成统一格式） */
export interface PlayerDanmakuItem {
  /** 出现时间（毫秒） */
  time: number
  /** 类型：1/2/3 滚动，4 底部，5 顶部 */
  mode: number
  /** 字号：18 小 / 25 标准 / 36 大 */
  size: number
  /** 颜色（十进制 RGB888） */
  color: number
  /** 内容 */
  text: string
}

/** 一个播放会话 */
export interface PlayerSession {
  /** 播放令牌（链接里的那一段） */
  token: string
  /** 作品标题（播放页显示用） */
  title: string
  /** 来源平台：bilibili / douyin */
  platform: string
  /** 会话目录 */
  dir: string
  /** 视频文件绝对路径 */
  filePath: string
  /** 视频大小（字节） */
  sizeBytes: number
  /** 弹幕条数 */
  danmakuCount: number
  /** 创建时间 */
  createdAt: number
  /** 失效时间（到点删文件） */
  expireAt: number
  /**
   * 这条链接只有本机 / 内网能打开（管理员没配「播放器公网地址」）。
   *
   * 播放页上要显式写出来：用户打不开的时候得知道是「没配域名」而不是「插件坏了」。
   */
  localOnly?: boolean
  /* ---------------- 作品信息（播放页上按B站那样展示，拿不到就不显示，绝不编数据） ---------------- */
  /** UP 主 / 作者名 */
  author?: string
  /** 封面文件名（在会话目录里，页面上用同源地址 /kkk/player/<token>/cover 取） */
  cover?: string
  /** 播放量 */
  views?: number
  /** 弹幕条数（平台自己统计的那个，和实际存下来的条数可能差一点） */
  platformDanmaku?: number
  /** 点赞 */
  likes?: number
  /** 投币 */
  coins?: number
  /** 收藏 */
  favorites?: number
  /** 分享 */
  shares?: number
  /** 评论 */
  comments?: number
  /** 作品发布时间（毫秒） */
  publishedAt?: number
  /** 视频时长（秒） */
  durationSeconds?: number
}

/**
 * 登记会话时可以带进来的作品信息。
 *
 * 字段和解析链路里已有的结构对齐：
 *   - B站：`infoData.data.data` 的 `title` / `owner.name` / `pic` / `stat` / `ctime` / `duration`
 *   - 抖音：`aweme_detail` 的 `desc` / `author.nickname` / `video.cover` / `statistics` / `create_time`
 * 全部可选：拿不到就留空，页面上不显示这一项。
 */
export interface PlayerWorkInfo {
  title?: string
  author?: string
  /** 封面的远程地址（登记时下载到会话目录，页面用同源地址取） */
  coverUrl?: string
  views?: number
  platformDanmaku?: number
  likes?: number
  coins?: number
  favorites?: number
  shares?: number
  comments?: number
  publishedAt?: number
  durationSeconds?: number
}

/** 把可能为空的数字洗干净（拿不到就 undefined，别在页面上显示 NaN/undefined） */
function optionalNumber (value: unknown): number | undefined {
  const num = Number(value)
  return Number.isFinite(num) && num >= 0 ? num : undefined
}

/** 有效期上下限（分钟）：配置里写歪了也按这个夹一下 */
export const PLAYER_EXPIRE_MIN_MINUTES = 1
export const PLAYER_EXPIRE_MAX_MINUTES = 1440

/** 定时清理的间隔：一分钟扫一次，够用又不费电 */
const SWEEP_INTERVAL_MS = 60 * 1000

/** 合法的令牌：只允许小写字母和数字 —— 顺带把路径穿越挡在门外 */
export const PLAYER_TOKEN_PATTERN = /^[0-9a-z]{8,64}$/

let storeDir = ''
let indexFile = ''
let sweeper: ReturnType<typeof setInterval> | null = null
const sessions = new Map<string, PlayerSession>()

/** 令牌是否合法（路由层第一道校验，非法直接 404，别去碰文件系统） */
export function isValidPlayerToken (token: unknown): boolean {
  return typeof token === 'string' && PLAYER_TOKEN_PATTERN.test(token)
}

/** 播放器根目录（会话目录都挂在它下面） */
export function playerStoreDir (): string {
  return storeDir
}

/** 夹一下有效期（分钟） */
export function normalizeExpireMinutes (value: unknown): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return 60
  return Math.min(PLAYER_EXPIRE_MAX_MINUTES, Math.max(PLAYER_EXPIRE_MIN_MINUTES, Math.floor(num)))
}

/** 删文件复用 Common.removeFile（它会按 removeCache 配置决定删不删，force=true 时必删） */
async function removeFileQuietly (file: string): Promise<void> {
  try {
    const { Common } = await import('../karin/module/utils/Common')
    await Common.removeFile(file, true)
  } catch (error: any) {
    logger.debug('[在线播放] 删除文件失败（忽略）: ' + String(error?.message ?? error))
  }
}

/** 把内存里的会话索引写回磁盘；写失败只记日志，不影响播放本身 */
function persistIndex (): void {
  if (!indexFile) return
  try {
    fs.writeFileSync(indexFile, JSON.stringify([...sessions.values()], null, 2))
  } catch (error: any) {
    logger.debug('[在线播放] 写入会话索引失败（忽略）: ' + String(error?.message ?? error))
  }
}

/** 校验一条从磁盘读回来的会话记录（字段坏了就当没有） */
function normalizeSession (raw: any): PlayerSession | null {
  if (!raw || !isValidPlayerToken(raw.token)) return null
  const filePath = typeof raw.filePath === 'string' ? raw.filePath : ''
  if (!filePath) return null
  return {
    token: String(raw.token),
    title: String(raw.title ?? ''),
    platform: String(raw.platform ?? ''),
    dir: typeof raw.dir === 'string' && raw.dir ? raw.dir : path.dirname(filePath),
    filePath,
    sizeBytes: Number(raw.sizeBytes) || 0,
    danmakuCount: Number(raw.danmakuCount) || 0,
    createdAt: Number(raw.createdAt) || Date.now(),
    expireAt: Number(raw.expireAt) || Date.now(),
    localOnly: raw.localOnly === true ? true : undefined,
    // 作品信息（可选）：重启后也要能还原
    author: raw.author ? String(raw.author) : undefined,
    cover: raw.cover ? String(raw.cover) : undefined,
    views: optionalNumber(raw.views),
    platformDanmaku: optionalNumber(raw.platformDanmaku),
    likes: optionalNumber(raw.likes),
    coins: optionalNumber(raw.coins),
    favorites: optionalNumber(raw.favorites),
    shares: optionalNumber(raw.shares),
    comments: optionalNumber(raw.comments),
    publishedAt: optionalNumber(raw.publishedAt),
    durationSeconds: optionalNumber(raw.durationSeconds)
  }
}

/**
 * 读 JSON 文件（顺手吃掉 BOM）。
 *
 * Windows 上用 PowerShell 的 `Set-Content -Encoding utf8` 之类写出来的文件会带 U+FEFF，
 * `JSON.parse` 会直接报 `Unexpected token '﻿'` —— 表现就是「会话索引读不回来」，
 * 真实部署里踩到过，所以入口统一吃掉。
 */
function readJsonFile (file: string): any {
  const text = fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '')
  return JSON.parse(text)
}

/** 读会话索引（宿主重启后恢复还没过期的会话） */
function loadIndex (): void {
  if (!indexFile || !fs.existsSync(indexFile)) return
  try {
    const list = readJsonFile(indexFile)
    if (!Array.isArray(list)) return
    for (const item of list) {
      const session = normalizeSession(item)
      if (!session) continue
      if (!fs.existsSync(session.filePath)) continue
      sessions.set(session.token, session)
    }
    if (sessions.size) logger.info('[在线播放] 已恢复 ' + sessions.size + ' 个未过期的播放会话')
  } catch (error: any) {
    logger.warn('[在线播放] 读取会话索引失败: ' + String(error?.message ?? error))
  }
}

/**
 * 初始化存储：确定目录、建目录、读回索引、扫一遍过期。
 * @param dir 播放器根目录（一般是 <数据目录>/koishi-plugin-kkk/player）
 */
export function setupPlayerStore (dir: string): void {
  storeDir = dir
  indexFile = path.join(dir, 'sessions.json')
  sessions.clear()
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (error: any) {
    logger.error('[在线播放] 创建播放器目录失败: ' + String(error?.message ?? error))
  }
  loadIndex()
  // 启动时先扫一遍（不阻塞启动：删文件是异步的）
  void sweepExpiredPlayers().catch(() => undefined)
}

/** 生成一个随机令牌：用 crypto 随机串，不用自增（自增可被枚举，等于把别人的视频公开） */
function createToken (): string {
  return crypto.randomBytes(18).toString('hex')
}

/**
 * 把一个下好的视频登记成播放会话。
 *
 * 视频会被**移动**到会话目录（同一分区是改名，几乎不耗时；跨分区退回复制 + 删源文件），
 * 这样会话目录是自包含的：到期删目录就等于把视频和弹幕一起清掉了。
 * @param input 视频路径、标题、平台、弹幕、有效期（分钟）、作品信息（可选）
 * @returns 会话；登记失败返回 null（调用方负责退回原来的发送流程）
 */
export function registerPlayerSession (input: {
  videoPath: string
  title?: string
  platform?: string
  danmaku?: PlayerDanmakuItem[]
  expireMinutes?: number
  /** 作品信息：标题 / UP 主 / 播放量…（播放页上按B站那样展示用） */
  work?: PlayerWorkInfo
  /** 已经下载到本地的封面文件（会复制进会话目录） */
  coverPath?: string
  /** 链接是否只有本机 / 内网能打开（没配「播放器公网地址」），播放页会提示一句 */
  localOnly?: boolean
}): PlayerSession | null {
  if (!storeDir) {
    logger.warn('[在线播放] 存储尚未初始化，无法登记播放会话')
    return null
  }
  const source = String(input.videoPath ?? '')
  try {
    if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
      logger.warn('[在线播放] 视频文件不存在，无法登记播放会话: ' + source)
      return null
    }
    const token = createToken()
    const dir = path.join(storeDir, token)
    fs.mkdirSync(dir, { recursive: true })

    const target = path.join(dir, 'video.mp4')
    try {
      fs.renameSync(source, target)
    } catch {
      // 跨分区 / 被占用：复制一份再把源文件删掉（临时目录本来也是要清的）
      fs.copyFileSync(source, target)
      fs.rmSync(source, { force: true })
    }

    const danmaku = Array.isArray(input.danmaku) ? input.danmaku : []
    fs.writeFileSync(path.join(dir, 'danmaku.json'), JSON.stringify({ total: danmaku.length, items: danmaku }))

    // 封面：复制进会话目录，页面用同源地址取（不引外链，断网/内网也能看）
    let cover: string | undefined
    if (input.coverPath && fs.existsSync(input.coverPath)) {
      try {
        const ext = path.extname(input.coverPath).toLowerCase() || '.jpg'
        cover = 'cover' + (/^\.(jpg|jpeg|png|webp|gif)$/.test(ext) ? ext : '.jpg')
        fs.copyFileSync(input.coverPath, path.join(dir, cover))
      } catch (error: any) {
        cover = undefined
        logger.debug('[在线播放] 封面复制失败（忽略）: ' + String(error?.message ?? error))
      }
    }

    const now = Date.now()
    const work = input.work ?? {}
    const session: PlayerSession = {
      token,
      title: String(input.title || work.title || ''),
      platform: String(input.platform ?? ''),
      dir,
      filePath: target,
      sizeBytes: Number(fs.statSync(target).size) || 0,
      danmakuCount: danmaku.length,
      createdAt: now,
      expireAt: now + normalizeExpireMinutes(input.expireMinutes) * 60 * 1000,
      localOnly: input.localOnly === true ? true : undefined,
      author: work.author ? String(work.author) : undefined,
      cover,
      views: optionalNumber(work.views),
      platformDanmaku: optionalNumber(work.platformDanmaku),
      likes: optionalNumber(work.likes),
      coins: optionalNumber(work.coins),
      favorites: optionalNumber(work.favorites),
      shares: optionalNumber(work.shares),
      comments: optionalNumber(work.comments),
      publishedAt: optionalNumber(work.publishedAt),
      durationSeconds: optionalNumber(work.durationSeconds)
    }
    sessions.set(token, session)
    persistIndex()
    logger.mark('[在线播放] 已登记播放会话 ' + token + '（' + (session.title || '无标题')
      + (session.author ? ' / ' + session.author : '') + '，' + danmaku.length + ' 条弹幕，'
      + (session.sizeBytes / 1024 / 1024).toFixed(2) + ' MB，有效期 '
      + normalizeExpireMinutes(input.expireMinutes) + ' 分钟）')
    return session
  } catch (error: any) {
    logger.error('[在线播放] 登记播放会话失败: ' + String(error?.stack ?? error))
    try {
      // 登记到一半失败：把可能已经搬过去的文件删掉，别留垃圾
      if (source && !fs.existsSync(source)) fs.rmSync(source, { force: true })
    } catch { /* 忽略 */ }
    return null
  }
}

/** 取会话（顺带做一次过期校验：过期了当场清掉并返回 undefined） */
export function getPlayerSession (token: unknown): PlayerSession | undefined {
  if (!isValidPlayerToken(token)) return undefined
  const session = sessions.get(String(token))
  if (!session) return undefined
  if (session.expireAt <= Date.now()) {
    void deletePlayerSession(session.token)
    return undefined
  }
  return session
}

/** 读弹幕数据（每次从磁盘读：弹幕可能上万条，没必要常驻内存） */
export function readPlayerDanmaku (token: unknown): { total: number, items: PlayerDanmakuItem[] } | null {
  const session = getPlayerSession(token)
  if (!session) return null
  try {
    const raw = readJsonFile(path.join(session.dir, 'danmaku.json'))
    const items = Array.isArray(raw) ? raw : (Array.isArray(raw?.items) ? raw.items : [])
    return { total: Array.isArray(raw?.items) ? (Number(raw.total) || items.length) : items.length, items }
  } catch (error: any) {
    logger.debug('[在线播放] 读取弹幕失败: ' + String(error?.message ?? error))
    return { total: 0, items: [] }
  }
}

/** 取封面文件（会话目录里的同源图片；没有就返回 null，路由回 404） */
export function resolvePlayerCover (token: unknown): { path: string, type: string } | null {
  const session = getPlayerSession(token)
  if (!session?.cover) return null
  try {
    const file = path.join(session.dir, session.cover)
    if (!fs.statSync(file).isFile()) return null
    const ext = path.extname(file).toLowerCase()
    const type = ext === '.png'
      ? 'image/png'
      : ext === '.webp'
        ? 'image/webp'
        : ext === '.gif' ? 'image/gif' : 'image/jpeg'
    return { path: file, type }
  } catch {
    return null
  }
}

/** 取视频文件信息（不存在就返回 null，路由据此回 404） */
export function resolvePlayerVideo (token: unknown): { path: string, size: number } | null {
  const session = getPlayerSession(token)
  if (!session) return null
  try {
    const stat = fs.statSync(session.filePath)
    if (!stat.isFile()) return null
    return { path: session.filePath, size: stat.size }
  } catch {
    return null
  }
}

/** 删掉一个会话的文件：先按 Common.removeFile 删视频，再把整个会话目录清掉 */
async function removePlayerFiles (session: PlayerSession): Promise<void> {
  await removeFileQuietly(session.filePath)
  try {
    fs.rmSync(session.dir, { recursive: true, force: true })
  } catch (error: any) {
    logger.debug('[在线播放] 删除会话目录失败（忽略）: ' + String(error?.message ?? error))
  }
}

/** 删掉一个会话：索引和文件一起清 */
export async function deletePlayerSession (token: string): Promise<boolean> {
  const session = sessions.get(token)
  if (!session) return false
  sessions.delete(token)
  persistIndex()
  await removePlayerFiles(session)
  return true
}

/**
 * 扫一遍过期会话并删除。
 *
 * 返回 Promise 是刻意的：调用方（定时器）不需要等，但测试要能等到「文件真的删掉了」。
 * @param now 判定用的当前时间（默认 Date.now()，测试里可以传一个「未来」的时刻强制触发）
 * @returns 删掉了几个
 */
export async function sweepExpiredPlayers (now = Date.now()): Promise<number> {
  const expired = [...sessions.values()].filter((session) => session.expireAt <= now)
  if (!expired.length) return 0
  for (const session of expired) {
    sessions.delete(session.token)
    logger.info('[在线播放] 链接已过期，清理会话 ' + session.token + '（' + session.title + '）')
    await removePlayerFiles(session)
  }
  persistIndex()
  return expired.length
}

/** 当前所有有效会话（诊断 / 测试用） */
export function listPlayerSessions (): PlayerSession[] {
  return [...sessions.values()]
}

/** 启动过期清理定时器（每分钟一次）；重复调用不会叠加 */
export function startPlayerSweeper (intervalMs = SWEEP_INTERVAL_MS): void {
  if (sweeper) return
  sweeper = setInterval(() => {
    sweepExpiredPlayers().catch((error: any) => {
      logger.debug('[在线播放] 过期清理出错（忽略）: ' + String(error?.message ?? error))
    })
  }, intervalMs)
  sweeper.unref?.()
}

/** 停掉定时器（插件卸载时调用，不然热重载会越攒越多） */
export function stopPlayerSweeper (): void {
  if (!sweeper) return
  clearInterval(sweeper)
  sweeper = null
}
