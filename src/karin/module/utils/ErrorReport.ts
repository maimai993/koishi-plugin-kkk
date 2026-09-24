/**
 * 错误上报。
 *
 * 出错的瞬间把「错误 + 运行环境 + 最近的日志」POST 到错误收集站（默认 \`https://err.tangbot.xyz\`），
 * 站长在网页上就能看到全部细节，不用让用户截图、也不用让用户翻日志文件。
 *
 * 几条硬性约定：
 *   1. **绝不影响报错本身**：整条链路失败只写一行日志，不抛异常、不拖住错误卡片的发送；
 *   2. **有超时**：默认 8 秒，超时就放弃（错误卡片该发还得发）；
 *   3. **有上限**：日志逐行折叠 + 截断（见 compat/fold），总行数、总字节数都封顶；
 *   4. **可关闭**：面板「通用 → 错误上报」里关掉就完全不上传（默认开启）。
 */
import os from 'node:os'
import { gzipSync } from 'node:zlib'

import { logger, segment } from 'node-karin'

import { MAX_CAPTURED_LOG_CHARS, foldAndTruncate } from '../../../compat/fold'
import { tryGetRuntime } from '../../../compat/runtime'
import { readQqOptions } from '../../../qqOptions'
import { Root } from '../../root'
import { Config } from './Config'
import { getBuildMetadata } from './build-metadata'

/**
 * 收集站地址：**写死，不开放配置**。
 * 自建的人改这一行重新构建即可 —— 面板里只留「是否上传」一个开关，少一个能填错的地方。
 */
export const REPORT_URL = 'https://err.tangbot.xyz'
/**
 * 上报令牌：**写死**。
 * 服务端 \`KKK_ERR_TOKEN\` 的默认值就是它，所以两边开箱即用、什么都不用配。
 * 它写在开源插件里，等于公开 —— 服务端那边另有 IP 限流兜着，挡的是随机刷接口的流量。
 */
export const REPORT_TOKEN = 'kkk-err-9f3c1d7a5b2e4c80'
/** 反馈群：写死（QQ 客户端点群链接就能进） */
export const REPORT_GROUP = '1050229473'
/** 上报多少行日志：写死（本次请求的日志 + 宿主日志文件尾部各取这么多行） */
export const REPORT_LOG_LINES = 200

/**
 * 上传超时（毫秒）：超了就放弃，不拖住错误卡片。
 *
 * 上报是**在渲染错误卡片之前**做的（编号要印在卡片上），所以站点挂掉时这 5 秒会加到
 * 报错送达上 —— 正常情况一次上传 50 毫秒左右，只有连不上站点才会等到超时。
 */
const UPLOAD_TIMEOUT_MS = 5000
/** 上报日志单行最长字符数 */
const LOG_LINE_LIMIT = 2000
/** 整份上报最多多大（压缩前），超了继续砍日志 */
const PAYLOAD_LIMIT_BYTES = 2 * 1024 * 1024
/** 读取宿主日志文件时最多读多少字节 */
const LOG_FILE_TAIL_BYTES = 512 * 1024

export interface ErrorReportResult {
  /** 收集站上的编号 */
  id: string
  /** 详情页地址 */
  url: string
}

interface ReportConfig {
  enabled: boolean
  url: string
  token: string
  logLines: number
  group: string
}

/**
 * 上报配置。
 *
 * 面板里**只有「上传错误信息」一个开关**（通用 → 错误上报）：地址、令牌、群号、日志行数全部写死，
 * 用户没有可以填错的地方。关掉开关就完全不上传。
 */
export function reportConfig (): ReportConfig {
  let enabled = true
  try {
    const options = readQqOptions((tryGetRuntime()?.config ?? {}) as any)
    enabled = options.errorReportUpload !== false
  } catch {
    enabled = (tryGetRuntime()?.config as any)?.errorReportUpload !== false
  }
  return { enabled, url: REPORT_URL, token: REPORT_TOKEN, logLines: REPORT_LOG_LINES, group: REPORT_GROUP }
}

/**
 * 反馈群的加群链接。
 *
 * ⚠️ **不能拿群号拼**：qm.qq.com/q/ 后面跟的是 QQ 给的**分享码**（一长串字母），
 * 不是群号 —— 写成 https://qm.qq.com/q/1050229473 点开就是 404（用户实测反馈过）。
 * 这里写死正确的分享链接；群号仍然照常显示在文案里。
 */
export const GROUP_INVITE_URL = 'https://qm.qq.com/q/viymkIPvvq'

export const groupLinkOf = (_group?: string): string => GROUP_INVITE_URL

/**
 * 已安装插件清单（名字 + 版本）。
 *
 * 插件版本号不在 Koishi 的注册表里，只能按名字去 \`node_modules/<name>/package.json\` 读；
 * 读不到就留空 —— 名字本身已经足够定位「装了哪些插件」。
 * 结果缓存 60 秒：一次报错读上百个文件没必要。
 */
let pluginCache: { at: number; list: Array<{ name: string; version: string }> } | null = null

const collectPlugins = (): Array<{ name: string; version: string }> => {
  if (pluginCache && Date.now() - pluginCache.at < 60_000) return pluginCache.list
  const names = new Set<string>()
  try {
    const registry: any = (tryGetRuntime()?.ctx as any)?.registry
    const entries = typeof registry?.values === 'function' ? [...registry.values()] : Array.isArray(registry) ? registry : []
    for (const entry of entries) {
      const name = entry?.name ?? entry?.plugin?.name
      if (name) names.add(String(name))
    }
  } catch { /* 拿不到就只报 kkk 自己 */ }
  names.add(Root.pluginName)
  const list = [...names].sort().map((name) => {
    let version = ''
    try {
      // 编译产物是 CJS，这里的 require 会沿插件的 node_modules 往上找宿主依赖
      version = String((require as any)(name + '/package.json')?.version ?? '')
    } catch { version = '' }
    return { name, version }
  })
  pluginCache = { at: Date.now(), list }
  return list
}

/** 宿主日志文件的尾部：出问题时整台机器在干什么，比单个请求的日志更能说明问题 */
const readLogFileTail = (lines: number): { file?: string; lines: string[]; truncated: boolean } => {
  if (lines <= 0) return { lines: [], truncated: false }
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const dataRoot = tryGetRuntime()?.dataRoot
    if (!dataRoot) return { lines: [], truncated: false }
    const dir = path.join(dataRoot, 'logs')
    if (!fs.existsSync(dir)) return { lines: [], truncated: false }
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.log'))
    if (!files.length) return { lines: [], truncated: false }
    // 文件名就是时间序（2026-09-22-33.log），按修改时间取最新的那个
    const newest = files
      .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)[0]
    const full = path.join(dir, newest.name)
    const size = fs.statSync(full).size
    const start = Math.max(0, size - LOG_FILE_TAIL_BYTES)
    const fd = fs.openSync(full, 'r')
    try {
      const buffer = Buffer.alloc(size - start)
      fs.readSync(fd, buffer, 0, buffer.length, start)
      const text = buffer.toString('utf8')
      const all = text.split(/\r?\n/).filter(Boolean)
      const kept = all.slice(-lines).map((line) => foldAndTruncate(line, LOG_LINE_LIMIT))
      return { file: newest.name, lines: kept, truncated: all.length > kept.length || start > 0 }
    } finally {
      fs.closeSync(fd)
    }
  } catch (error: any) {
    logger.debug('[错误上报] 读宿主日志失败: ' + String(error?.message ?? error))
    return { lines: [], truncated: false }
  }
}

/** 简短的适配器信息：出问题时是哪个平台、哪个机器人 */
const collectAdapters = (event?: any): Array<Record<string, any>> => {
  const out: Array<Record<string, any>> = []
  try {
    const bots: any[] = (tryGetRuntime()?.ctx as any)?.bots ?? []
    for (const bot of bots) {
      out.push({
        platform: String(bot?.platform ?? ''),
        selfId: String(bot?.selfId ?? ''),
        status: bot?.status ?? '',
        adapter: String(bot?.adapter?.name ?? '')
      })
    }
  } catch { /* 忽略 */ }
  const adapter = event?.bot?.adapter
  if (adapter && !out.some((item) => item.adapter === adapter.name)) {
    out.push({ platform: String(adapter.platform ?? ''), selfId: String(event?.selfId ?? ''), status: '', adapter: String(adapter.name ?? '') })
  }
  return out
}

/** 生成一个不重复的上报编号：时间 + 随机后缀，按时间排序天然有序 */
const makeReportId = (): string => {
  const now = new Date()
  const pad = (value: number, size = 2) => String(value).padStart(size, '0')
  const stamp = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds())
  return stamp + '-' + Math.random().toString(36).slice(2, 8)
}

/**
 * **用框架原生 API 补齐来源信息**（用户要求：上报里「来源信息」不能是一片「—」）。
 *
 * 以前只读 event 上的几个字段 —— 推送任务（B站推送 / 抖音推送）的 event 是**合成**的，
 * 根本没有 channelId / guildId，于是详情页里群号、频道全是空的。
 * 现在：
 *   - 先从 event 上取（消息场景最准）；
 *   - 取不到就退回 bot 的原生字段（platform / selfId / user.name）；
 *   - 群名 / 用户名尽量用 bot.getGuild() 这类**原生接口**查出来（查不到就算了，绝不让上报卡住）。
 */
const collectSource = async (input: UploadErrorReportInput, adapterInfo: any): Promise<Record<string, any>> => {
  const event: any = input.event ?? {}
  const bot: any = event?.bot?.bot ?? event?.bot
  const channelId = String(event?.channelId ?? event?.contact?.peer ?? event?.guildId ?? '')
  const guildId = String(event?.guildId ?? event?.contact?.guildId ?? channelId)
  const userId = String(event?.userId ?? event?.sender?.userId ?? event?.author?.userId ?? '')
  const source: Record<string, any> = {
    platform: String(bot?.platform ?? event?.platform ?? adapterInfo?.platform ?? ''),
    route: String(input.route ?? ''),
    stage: String(input.stage ?? ''),
    business: String(input.business ?? ''),
    guildId,
    channelId,
    userId,
    selfId: String(event?.selfId ?? bot?.selfId ?? bot?.account?.selfId ?? ''),
    // 机器人名 / 用户名：能取到就填，详情页里比一串数字好认
    botName: String(bot?.user?.name ?? bot?.username ?? bot?.account?.name ?? ''),
    userName: String(event?.sender?.nick ?? event?.author?.nick ?? event?.username ?? event?.sender?.name ?? ''),
    guildName: '',
    command: foldAndTruncate(String(event?.msg ?? event?.content ?? ''), 300)
  }
  // 群名（框架原生接口；取不到就留空，不抛错）
  if (!source.guildName && channelId && typeof bot?.getGuild === 'function') {
    try {
      const guild: any = await bot.getGuild(channelId)
      source.guildName = String(guild?.name ?? guild?.guildName ?? '')
    } catch { /* 频道查不到就算了 */ }
  }
  /**
   * 阶段（stage）：解析链路里抛的错会带一句「步骤「渲染评论区」失败」，
   * 直接抽出来当阶段，详情页上就能看出是卡在哪一步（route 同理，有就带）。
   */
  if (!source.stage) {
    const message = String((input.error as any)?.message ?? '')
    const step = /步骤「([^」]+)」/.exec(message) ?? /步骤失败[（(]([^）)]+)[）)]/.exec(message)
    if (step) source.stage = step[1]
  }
  return source
}

/** 上游配置的几段（与 config.json 的顶层键一致）；Config 是只有 get 的 Proxy，只能按名字取 */
const UPSTREAM_SECTIONS = ['amagi', 'app', 'douyin', 'bilibili', 'kuaishou', 'xiaohongshu', 'pushlist']

/** 这些键一律不上传（cookie / 密钥 / 密码之类） */
const SECRET_KEY = /cookie|token|secret|password|passwd|sessdata|bili_jct|csrf|authorization|apikey|api_key/i

/**
 * **上报用的配置快照**：把「改过什么」也带上去，复现问题才有依据。
 *
 * 两条硬规矩：
 *   1. **cookie 一个都不传**（SESSDATA / bili_jct / 抖音那一长串都在 amagi.cookies 里，整块丢掉）；
 *   2. 其余凡是键名像密钥/密码的（token / secret / password / apiKey…）也一律换成 '***'。
 */
const snapshotConfig = (upstream: any, qq: Record<string, any>): Record<string, any> => {
  const clean = (value: any, depth: number): any => {
    if (depth > 6 || value === null || value === undefined) return value
    if (Array.isArray(value)) return value.slice(0, 200).map((item) => clean(item, depth + 1))
    if (typeof value !== 'object') return typeof value === 'string' ? foldAndTruncate(value, 500) : value
    const out: Record<string, any> = {}
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) { out[key] = '***'; continue }
      out[key] = clean(item, depth + 1)
    }
    return out
  }
  const upstreamClean = clean(upstream ?? {}, 0) as Record<string, any>
  // cookie 整块不要：键名可能不叫 cookie（amagi.cookies.bilibili 才是），所以直接在源头删掉
  if (upstreamClean?.amagi && typeof upstreamClean.amagi === 'object') delete upstreamClean.amagi.cookies
  return { qq: clean(qq, 0), upstream: upstreamClean }
}

/** 日志只留本项目（kkk）的行：日志文件是 JSON 行，控制台那份是人读的文本行，两种都要认 */
const isOwnLogLine = (line: string): boolean => {
  const text = String(line ?? '').trim()
  if (!text) return false
  if (text.startsWith('{')) {
    try {
      const record = JSON.parse(text)
      const name = String(record?.name ?? '')
      // 本插件的日志 name 是 kkk；带 paths 的是它的作用域
      return name === 'kkk' || name === Root.pluginName || (Array.isArray(record?.meta?.paths) && record.meta.paths.includes('uclubw'))
    } catch { /* 不是完整 JSON，按文本处理 */ }
  }
  return /\bkkk\b/.test(text)
}
export interface UploadErrorReportInput {
  error: Error
  /** 业务名（解析 / 推送…） */
  business?: string
  /** 出错时正在跑的路由（douyin/video-work 这种），有就带上 */
  route?: string
  /** 正在干什么（渲染评论区 / 下载视频…） */
  stage?: string
  /** 触发这次错误的会话（有就带平台和群号，方便复现） */
  event?: any
  /** 本次请求捕获到的日志行 */
  logs?: string[]
  /** 适配器信息 */
  adapterInfo?: any
  /** 额外补充（比如发送失败的错误码） */
  extra?: Record<string, unknown>
}

/**
 * 上传一份错误报告。
 *
 * @returns 成功时给出收集站的编号与详情页地址；关掉上报或上传失败时返回 \`null\`（调用方照常发错误卡片）
 */
export const uploadErrorReport = async (input: UploadErrorReportInput): Promise<ErrorReportResult | null> => {
  const config = reportConfig()
  if (!config.enabled) return null
  if (typeof fetch !== 'function') return null

  const error = input.error
  const buildMetadata = getBuildMetadata()
  const adapterInfo = input.adapterInfo as any
  const id = makeReportId()
  const lines = (input.logs ?? []).slice(-Math.max(config.logLines, 0))
    .map((line) => foldAndTruncate(line, LOG_LINE_LIMIT))
  const envLogsRaw = readLogFileTail(Math.min(config.logLines, 300))
  /** 宿主日志文件里**只留本项目（kkk）的行**（用户要求：别把整台机器所有插件的日志都传上去） */
  const envLogs = { ...envLogsRaw, lines: envLogsRaw.lines.filter((line) => isOwnLogLine(line)) }
  const source = await collectSource(input, adapterInfo)
  const runtimeConfig: any = (tryGetRuntime()?.config ?? {}) as any
  const configSnapshot = (() => {
    try {
      /**
       * 上游那份（接口库 / 各平台 / 推送列表）以 **Config** 为准：它是 config.json 的读取代理，
       * 也是实际生效的那份；运行时 config 上的 `upstream` 只在控制台保存过才会有。
       *
       * 注意 Config 是个**只有 get 的 Proxy**（没有 ownKeys），直接 Object.entries 会得到空对象 ——
       * 所以按已知的几段逐个取值再拼。
       */
      const upstream: Record<string, any> = {}
      for (const section of UPSTREAM_SECTIONS) {
        try {
          const value = (Config as any)[section]
          if (value !== undefined) upstream[section] = value
        } catch { /* 某一段读不到就跳过 */ }
      }
      return snapshotConfig(upstream, readQqOptions(runtimeConfig))
    } catch (error: any) {
      logger.debug('[错误上报] 配置快照生成失败（忽略）: ' + String(error?.message ?? error))
      return undefined
    }
  })()

  const payload: Record<string, any> = {
    id,
    time: Date.now(),
    plugin: { name: Root.pluginName, version: Root.pluginVersion },
    source,
    error: {
      name: String(error?.name ?? 'Error'),
      message: foldAndTruncate(error?.message ?? String(error), MAX_CAPTURED_LOG_CHARS),
      stack: foldAndTruncate(error?.stack ?? '', MAX_CAPTURED_LOG_CHARS * 2),
      code: String((error as any)?.code ?? (error as any)?.err_code ?? ''),
      kind: String((error as any)?.kkkKind ?? '')
    },
    env: {
      node: process.version,
      os: os.type() + ' ' + os.release() + ' ' + os.arch(),
      koishi: Root.karinVersion,
      pluginVersion: Root.pluginVersion,
      buildTime: buildMetadata?.buildTime ?? '',
      commit: buildMetadata?.shortCommitHash ?? '',
      uptimeSec: Math.round(process.uptime()),
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      cwd: process.cwd(),
      dataRoot: String(tryGetRuntime()?.dataRoot ?? ''),
      plugins: collectPlugins(),
      adapters: collectAdapters(input.event)
    },
    logs: {
      lines,
      count: lines.length,
      truncated: (input.logs ?? []).length > lines.length,
      // 宿主日志文件的尾部：整台机器最近的动静
      envFile: envLogs.file ?? '',
      envLines: envLogs.lines,
      envTruncated: envLogs.truncated,
      // 只留本项目日志这件事要说清楚，免得看的人以为日志被截断了
      envFiltered: 'kkk-only'
    },
    /** 配置快照：cookie 与密钥已剔除（见 snapshotConfig） */
    config: configSnapshot,
    extra: input.extra ?? {}
  }

  /**
   * 体积兜底：太大就一层层砍（先去掉整份配置快照，再去掉宿主日志，最后砍本次日志）。
   * 配置快照最占地方（几百个字段），但它对复现最有帮助，所以放在最后才丢。
   */
  let body = Buffer.from(JSON.stringify(payload))
  if (body.length > PAYLOAD_LIMIT_BYTES && payload.logs) {
    payload.logs.envLines = []
    body = Buffer.from(JSON.stringify(payload))
  }
  if (body.length > PAYLOAD_LIMIT_BYTES) {
    payload.config = { dropped: '配置快照过大，已省略' }
    body = Buffer.from(JSON.stringify(payload))
  }
  if (body.length > PAYLOAD_LIMIT_BYTES) {
    payload.logs.lines = payload.logs.lines.slice(-50)
    payload.logs.count = payload.logs.lines.length
    payload.logs.truncated = true
    body = Buffer.from(JSON.stringify(payload))
  }

  const gzipped = gzipSync(body)
  try {
    const response = await fetch(config.url + '/api/v1/reports', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': String(gzipped.length),
        'x-kkk-token': config.token,
        'user-agent': 'koishi-plugin-kkk/' + Root.pluginVersion
      },
      body: gzipped,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
    })
    if (!response.ok) {
      logger.warn('[错误上报] 上传失败 HTTP ' + response.status + '：' + foldAndTruncate(await response.text().catch(() => ''), 200))
      return null
    }
    const result: any = await response.json().catch(() => null)
    const reportId = String(result?.id ?? id)
    const url = config.url + '/reports/' + reportId
    logger.info('[错误上报] 已上传：' + url + '（' + Math.round(body.length / 1024) + 'KB → ' + Math.round(gzipped.length / 1024) + 'KB）')
    return { id: reportId, url }
  } catch (uploadError: any) {
    logger.warn('[错误上报] 上传失败：' + String(uploadError?.message ?? uploadError))
    return null
  }
}

/**
 * 附加在错误消息里的「求助」片段。
 *
 * QQ 官方机器人认 markdown，就把群号和上报链接做成**可点**的；个人号（OneBot / NapCat）
 * 不渲染 markdown，直接给纯文本 —— QQ 客户端会把裸链接变成可点的蓝色链接。
 */
export const errorHelpSegments = (report: ErrorReportResult | null, platform: string): any[] => {
  const config = reportConfig()
  const group = config.group
  const link = groupLinkOf(group)
  const officialQq = /^qq/i.test(String(platform ?? ''))
  const head = report
    ? '错误信息已上传，ID：' + report.id
    : '错误信息上传失败（不影响使用）'
  const ask = '可以前往 QQ 群内寻找帮助，在群内发送错误 ID 或该错误图片'
  /**
   * 两段之间必须**空一行**（\n\n）。
   *
   * markdown 里单个换行不算换行：两段会被拼成一整行，QQ 那边按一行显示时字号会被撑得很难看
   * （用户原话「不换行大小会崩」）。纯文本那条也一样留空行，两种平台的观感才对得上。
   */
  if (officialQq) {
    // QQ 官方机器人认 markdown：群号做成可点的加群链接
    return [segment.markdown(head + '\n\n' + '可以前往 [QQ 群 ' + group + '](' + link + ') 内寻找帮助，在群内发送错误 ID 或该错误图片')]
  }
  // 个人号（OneBot / NapCat）不渲染 markdown：裸链接 QQ 客户端自己会变蓝可点
  return [segment.text(head + '\n\nQQ 群 ' + group + '：' + ask + '\n' + link)]
}
