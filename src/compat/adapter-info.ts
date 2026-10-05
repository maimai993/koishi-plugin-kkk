/**
 * 适配器信息（错误卡片与「#kkk版本」海报上的「适配器」一栏）。
 *
 * Koishi 的 Bot 只暴露 platform / adapterName，**没有版本号字段** —— 早期实现直接读
 * bot.adapter.version，结果卡片上永远是一个空的「v」，也看不出到底用的哪个适配器。
 * 这里分三步把真实信息挖出来：
 *
 *   1. 精准：bot.adapter 是 Adapter 实例，它的构造函数就定义在适配器插件模块里，
 *      拿构造函数去 require.cache 里反查模块路径，再读那个包的 package.json 版本；
 *   2. 兜底：按「平台名 + 常见包名前缀」在宿主 node_modules 里找适配器包
 *      （社区版 koishi-plugin-adapter-x，官方版 @koishijs/plugin-adapter-x）；
 *   3. 可选异步：OneBot 适配器可以问一句 get_version_info，拿到 NapCat / Lagrange
 *      这类**实现端**的名字和版本号 —— 那才是用户真正装的软件版本。
 *
 * 全部结果都缓存，卡片渲染路径上不会重复扫目录、也不会发网络请求。
 */
import fs from 'node:fs'
import path from 'node:path'

export interface KkkAdapterInfo {
  /**
   * 平台名，**保持原样**（onebot / qqguild / bilibili…）。
   *
   * 别往这里塞「好看的展示名」：面板、合并转发能力判断、错误上报都拿它当平台标识用，
   * 改成 OneBot 这种带大写的名字会让 `includes('qq')` 之类的判断全部失效。
   */
  name: string
  /** 给卡片用的友好名字：实现端名字（NapCat）优先，其次是平台对应的中文/惯用名 */
  displayName: string
  /** 展示版本：实现端版本优先，其次是适配器插件版本；都没有就是「未知」 */
  version: string
  /**
   * 实现端自报的名字（`NapCat.Onebot` / `LLOneBot` …），没问到是空串。
   *
   * 卡片**选图标**就靠它：平台名各家都是 `onebot`，只有这个名字能区分 NapCat 和 LLOneBot。
   */
  implementationName: string
  /** 实现端代号：`nc` / `ll` / `lg` …，认不出来是空串 */
  implementationCode: string
  /**
   * 卡片上的短标签：`onebot(nc)` —— 平台名 + 实现端代号。
   *
   * 各家协议端都自报 `onebot`，光看平台名分不出 NapCat 和 LLOneBot，
   * 而只写 `NapCat.Onebot` 又看不出走的是哪个平台；两个都要，所以拼成这个样子。
   * 认不出实现端时就只有平台名（`qq` / `onebot`）。
   */
  shortLabel: string
  /** 平台名，就是 Koishi 的 bot.platform */
  platform: string
  /** 协议，保持平台名语义（卡片与多页判断都按它分支） */
  protocol: string
  /** 标准，同上 */
  standard: string
  /** 通信方式，WebSocket / HTTP / 反向 之类 */
  communication: string
  /** 机器人上线时间戳（毫秒），拿不到是 0 */
  connectTime: number
  /** 适配器插件包名，排查问题时很有用 */
  packageName: string
  /** 原始适配器实例 */
  raw: any
}

interface PackageVersion {
  packageName: string
  version: string
}

/** 平台名 → 展示名 / 协议。表里没有的平台就把平台名原样当展示名 */
const PLATFORM_META: Record<string, { name: string; protocol: string }> = {
  onebot: { name: 'OneBot', protocol: 'OneBot 11' },
  qq: { name: 'QQ 机器人', protocol: 'QQ 开放平台' },
  qqguild: { name: 'QQ 频道', protocol: 'QQ 频道' },
  qqbot: { name: 'QQ 机器人', protocol: 'QQ 开放平台' },
  bilibili: { name: '哔哩哔哩私信', protocol: 'Bilibili 私信' },
  discord: { name: 'Discord', protocol: 'Discord' },
  telegram: { name: 'Telegram', protocol: 'Telegram' },
  kook: { name: 'KOOK', protocol: 'KOOK' },
  lark: { name: '飞书', protocol: 'Lark' },
  satori: { name: 'Satori', protocol: 'Satori' },
  milky: { name: 'Milky', protocol: 'Milky' },
  nextchat: { name: 'NextChat', protocol: 'NextChat' },
  github: { name: 'GitHub', protocol: 'GitHub' }
}

/** 包名里出现这些关键字时，展示名以包名为准（同一个 qq 平台有好几个适配器） */
const PACKAGE_NAME_HINTS: Array<{ key: string; name: string }> = [
  { key: 'adapter-qq-crack', name: 'QQ（Crack）' },
  { key: 'adapter-onebot', name: 'OneBot' },
  { key: 'adapter-bilibili-dm', name: '哔哩哔哩私信' },
  { key: 'adapter-qq', name: 'QQ 机器人' },
  { key: 'adapter-satori', name: 'Satori' }
]

/**
 * 实现端自报的名字（get_version_info 的 app_name）→ 卡片上的短代号。
 *
 * 全部按**小写子串**匹配，所以 `NapCat.Onebot` 能命中 napcat、`Lagrange.OneBot` 能命中
 * lagrange。顺序有意义：越具体的放前面（没有 `onebot` 这种通用项 —— 它谁都配不上，
 * OneBot 适配器自己、以及那些不肯自报家门的协议端都属于这一类，此时就不带代号）。
 */
const IMPLEMENTATION_CODES: Array<{ key: string; code: string }> = [
  { key: 'napcat', code: 'nc' },
  { key: 'llonebot', code: 'll' },
  { key: 'lltwobot', code: 'lt' },
  { key: 'lagrange', code: 'lg' },
  { key: 'chronocat', code: 'cc' },
  { key: 'shamrock', code: 'sr' },
  { key: 'conwechat', code: 'cw' },
  { key: 'go-cqhttp', code: 'go' },
  { key: 'gocq', code: 'go' },
  { key: 'oitq', code: 'oitq' }
]

/** 实现端名字 → 短代号，认不出来给空串 */
export const implementationCode = (name: string): string => {
  const lower = String(name ?? '').toLowerCase()
  if (!lower) return ''
  for (const item of IMPLEMENTATION_CODES) {
    if (lower.includes(item.key)) return item.code
  }
  return ''
}

const PACKAGE_PREFIXES = [
  'koishi-plugin-adapter-',
  '@koishijs/plugin-adapter-',
  'koishi-plugin-',
  '@koishijs/plugin-'
]

const COMMUNICATION_NAMES: Record<string, string> = {
  ws: 'WebSocket',
  websocket: 'WebSocket',
  'ws-reverse': 'WebSocket 反向',
  wsreverse: 'WebSocket 反向',
  http: 'HTTP',
  'http-reverse': 'HTTP 反向',
  httpreverse: 'HTTP 反向',
  sse: 'SSE',
  webhook: 'Webhook'
}

/** 实现端自报的名字 / 版本 / 协议版本 */
interface ImplementationInfo {
  name: string
  version: string
  protocol: string
}

/** 包版本缓存：key 是平台名 + adapterName */
const PACKAGE_CACHE = new Map<string, PackageVersion>()
/**
 * 实现端缓存，**优先按 bot 对象记**（同一个对象必然是同一个机器人）。
 *
 * 只按 `platform:selfId` 记是不够的：还没登录的机器人 selfId 是空的，
 * 好几个机器人会撞成同一个 key，于是「第一个问到的 NapCat」会被后面每个机器人当成自己的身份。
 */
const IMPLEMENTATION_BY_BOT = new WeakMap<object, ImplementationInfo | null>()
/** 实现端缓存（按 platform:selfId）：机器人重连换了对象时也能认出来 */
const IMPLEMENTATION_CACHE = new Map<string, ImplementationInfo | null>()
/** 机器人上线时间：Koishi 没有这个字段，第一次看到它在线时记一笔 */
const ONLINE_SINCE = new Map<string, number>()

const botKey = (bot: any): string => String(bot?.platform ?? bot?.adapterName ?? '') + ':' + String(bot?.selfId ?? '')

const readPackage = (dir: string): any => {
  try {
    const file = path.join(dir, 'package.json')
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}

/** 从模块文件往上找最近的 package.json 目录，且必须在 node_modules 里（别爬到宿主项目自己的包） */
const packageDirOf = (file: string): string | null => {
  try {
    let dir = path.dirname(file)
    for (let i = 0; i < 8; i++) {
      const isModule = dir.split(/[\\/]/).includes('node_modules')
      if (isModule && fs.existsSync(path.join(dir, 'package.json'))) return dir
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* 取不到就算了 */ }
  return null
}

/**
 * 用 Adapter 构造函数反查适配器插件模块。
 *
 * 先只扫路径里带 adapter 的模块（覆盖 99% 的情况），扫不到再退化成全表扫描。
 */
const findAdapterModule = (ctor: any): string | null => {
  if (typeof ctor !== 'function') return null
  let ids: string[] = []
  try {
    ids = Object.keys(require.cache)
  } catch {
    return null
  }
  for (const pass of [0, 1]) {
    for (const id of ids) {
      if (pass === 0 && !/adapter/i.test(id)) continue
      let exportsOf: any
      try {
        exportsOf = require.cache[id]?.exports
      } catch {
        continue
      }
      if (!exportsOf) continue
      if (exportsOf === ctor) return id
      let values: any[] = []
      try {
        values = Object.values(exportsOf)
      } catch {
        continue
      }
      if (values.length > 200) continue
      if (values.includes(ctor)) return id
    }
  }
  return null
}

/**
 * 收集可能装着适配器插件的 node_modules 目录。
 *
 * 三个来源：插件自己往上找的各级 node_modules、require.cache 里真实加载过的
 * node_modules（pnpm / 全局安装也逃不掉）、以及进程工作目录。
 */
const moduleRoots = (): string[] => {
  const roots: string[] = []
  try {
    let dir = __dirname
    for (let i = 0; i < 8; i++) {
      roots.push(path.join(dir, 'node_modules'))
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* 忽略 */ }
  try {
    for (const id of Object.keys(require.cache)) {
      const marker = id.toLowerCase().lastIndexOf('node_modules')
      if (marker < 0) continue
      roots.push(id.slice(0, marker + 'node_modules'.length))
    }
  } catch { /* 忽略 */ }
  try {
    roots.push(path.join(process.cwd(), 'node_modules'))
  } catch { /* 忽略 */ }
  const unique: string[] = []
  for (const root of roots) if (!unique.includes(root)) unique.push(root)
  return unique
}

/** 平台名 / adapterName → 候选包名 */
const packageCandidates = (tokens: string[]): string[] => {
  const out: string[] = []
  for (const token of tokens) {
    const name = String(token ?? '').trim()
    if (!name) continue
    if (name.startsWith('@') || name.includes('koishi-')) out.push(name)
    const bare = name.replace(/^@[^/]+\//, '')
    for (const prefix of PACKAGE_PREFIXES) out.push(prefix + bare)
  }
  return Array.from(new Set(out))
}

/** 按候选包名去 node_modules 里翻版本号 */
const lookupPackage = (tokens: string[]): PackageVersion => {
  const key = tokens.join('|')
  const cached = PACKAGE_CACHE.get(key)
  if (cached) return cached

  const empty: PackageVersion = { packageName: '', version: '' }
  const roots = moduleRoots()
  for (const candidate of packageCandidates(tokens)) {
    for (const root of roots) {
      const pkg = readPackage(path.join(root, ...candidate.split('/')))
      const version = String(pkg?.version ?? '')
      if (!version) continue
      const hit: PackageVersion = { packageName: String(pkg.name ?? candidate), version }
      PACKAGE_CACHE.set(key, hit)
      return hit
    }
  }
  PACKAGE_CACHE.set(key, empty)
  return empty
}

/** 适配器插件包名与版本（缓存，扫不到就返回空） */
const resolvePackage = (bot: any): PackageVersion => {
  const key = botKey(bot)
  const cached = PACKAGE_CACHE.get(key)
  if (cached) return cached

  const file = findAdapterModule(bot?.adapter?.constructor)
  const dir = file ? packageDirOf(file) : null
  const pkg = dir ? readPackage(dir) : null
  if (pkg?.version) {
    const hit: PackageVersion = { packageName: String(pkg.name ?? ''), version: String(pkg.version) }
    PACKAGE_CACHE.set(key, hit)
    return hit
  }
  const fallback = lookupPackage([bot?.platform, bot?.adapterName])
  PACKAGE_CACHE.set(key, fallback)
  return fallback
}

/** 通信方式：读适配器配置里的 protocol，翻成好认的名字 */
const communicationOf = (bot: any): string => {
  const config: any = bot?.config ?? {}
  const raw = String(config.protocol ?? config.connection ?? config.mode ?? '').toLowerCase()
  if (!raw) return '未知'
  return COMMUNICATION_NAMES[raw] ?? raw
}

/** 上线时间：Koishi 不提供，第一次读到「在线」时记一笔，之后一直用它 */
const onlineSince = (bot: any, force = false): number => {
  const key = botKey(bot)
  const known = ONLINE_SINCE.get(key)
  if (known && !force) return known
  const status = bot?.status
  const online = status === 1 || status === 2 || status === 'online' || status === 'connect'
  if (online && !known) {
    const now = Date.now()
    ONLINE_SINCE.set(key, now)
    return now
  }
  return known ?? 0
}

const displayNameOf = (platform: string, packageName: string): string => {
  const lower = packageName.toLowerCase()
  for (const hint of PACKAGE_NAME_HINTS) {
    if (lower.includes(hint.key)) return hint.name
  }
  return PLATFORM_META[platform]?.name ?? (platform || '未知')
}

/** 有 selfId 才按 platform:selfId 记，否则不同机器人会撞 key（见 IMPLEMENTATION_BY_BOT） */
const hasStableKey = (bot: any): boolean => !!String(bot?.selfId ?? '').trim()

/** 查缓存：undefined = 没问过；null = 问过但没问到 */
const knownImplementation = (bot: any): ImplementationInfo | null | undefined => {
  if (bot && typeof bot === 'object' && IMPLEMENTATION_BY_BOT.has(bot)) {
    return IMPLEMENTATION_BY_BOT.get(bot) ?? null
  }
  if (!hasStableKey(bot)) return undefined
  const key = botKey(bot)
  // 一定要先用 has：Map.get 缺键时返回 undefined，直接 ?? null 会被当成「问过但没问到」，
  // 于是这个机器人永远不再发问，卡片上一直是适配器插件的版本号
  if (!IMPLEMENTATION_CACHE.has(key)) return undefined
  return IMPLEMENTATION_CACHE.get(key) ?? null
}

/** 已经问到的实现端信息（没问过就是 undefined，卡片渲染路径不会触发网络请求） */
export const cachedAdapterImplementation = (bot: any) => knownImplementation(bot) ?? undefined

/** 问一次实现端的超时：问不到就放弃，绝不让错误卡片和海报干等 */
const IMPLEMENTATION_TIMEOUT_MS = 1500

/**
 * 带超时的 await，超时或报错都给 null。
 *
 * 注意一定要给原 promise 挂 `.catch`：Promise.race 输了的那条如果之后再 reject，
 * 会变成 unhandledRejection，在 Koishi 里就是一条莫名其妙的崩溃日志。
 */
const withTimeout = async (task: any): Promise<any> => {
  let timer: any
  try {
    return await Promise.race([
      Promise.resolve(task).catch(() => null),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), IMPLEMENTATION_TIMEOUT_MS)
        timer.unref?.()
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 从 get_version_info 的返回里挖出实现端信息。
 *
 * 信封拆没拆不一定（`_get` 会拆、`_request` 不拆），所以带 `data.app_name` 的先剥一层。
 */
const pickImplementation = (payload: any): { name: string; version: string; protocol: string } | null => {
  if (!payload || typeof payload !== 'object') return null
  const data = payload?.data && typeof payload.data === 'object' && ('app_name' in payload.data)
    ? payload.data
    : payload
  const name = String(data?.app_name ?? data?.appName ?? '').trim()
  const version = String(data?.app_version ?? data?.appVersion ?? '').trim()
  if (!name && !version) return null
  return { name, version, protocol: String(data?.protocol_version ?? data?.protocolVersion ?? '').trim() }
}

/**
 * 问适配器要实现端名字与版本（只有 OneBot 一整类支持 get_version_info）。
 *
 * 各家把这个接口暴露成什么样都有：适配器自己 define 的 `getVersionInfo`、
 * 原样的 `get_version_info`、以及通用的 `_get` / `_request`（信封拆不拆也不一样）。
 * 所以按顺序全试一遍，第一个认出 `app_name` 的就算数。
 *
 * 每一步都带 1.5 秒超时：适配器没实现这个接口、或者对面不回，都直接放弃。
 * 结果（包括「问不到」）按机器人缓存，**只会问一次**。
 */
export const queryAdapterImplementation = async (bot: any) => {
  const cached = knownImplementation(bot)
  if (cached !== undefined) return cached

  const result = await (async () => {
    const internal: any = bot?.internal
    if (!internal) return null
    // 适配器用 Internal.define 声明时，方法挂在 internal 上；也有直接挂在 bot 上的
    for (const name of ['getVersionInfo', 'getVersion', 'get_version_info']) {
      for (const owner of [bot, internal]) {
        if (typeof owner?.[name] !== 'function') continue
        const hit = pickImplementation(await withTimeout(owner[name]()))
        if (hit) return hit
      }
    }
    if (typeof internal._get === 'function') {
      const hit = pickImplementation(await withTimeout(internal._get('get_version_info', {})))
      if (hit) return hit
    }
    if (typeof internal._request === 'function') {
      const response = await withTimeout(internal._request('get_version_info', {}))
      if (Number(response?.retcode ?? 0) === 0) {
        const hit = pickImplementation(response?.data ?? response)
        if (hit) return hit
      }
    }
    return null
  })()

  if (bot && typeof bot === 'object') IMPLEMENTATION_BY_BOT.set(bot, result)
  if (hasStableKey(bot)) IMPLEMENTATION_CACHE.set(botKey(bot), result)
  return result
}

/**
 * 错误卡片底部「Adapter / 适配器」那一栏。
 *
 * 关键是**先问一句实现端再取快照**：捕获错误时 `e.bot.adapter` 是同步算出来的，
 * 那时还没人问过协议端是谁，卡片上就只有 `OneBot` 一个空壳名字、图标也只能是万能拼图。
 * 这里补问一次（带超时、按机器人缓存，只问一遍），之后 NapCat 就能印成 `onebot(nc)`
 * 并配上 NapCat 的图标。
 *
 * @param bot 兼容层的 KkkBot 包装**或** Koishi 原生 Bot，两种都收
 */
export const adapterCardInfo = async (bot: any): Promise<{ name: string; version: string; implementationName: string }> => {
  const unknown = { name: '未知适配器', version: '', implementationName: '' }
  try {
    const koishiBot: any = bot?.bot ?? bot
    if (!koishiBot) return unknown
    await queryAdapterImplementation(koishiBot)
    const info = resolveAdapterInfo(koishiBot)
    return {
      name: info.shortLabel || info.displayName || info.name || '未知适配器',
      version: info.version || '',
      // 选图标靠它：平台名各家都是 onebot，只有实现端名字能分出 NapCat / LLOneBot
      implementationName: info.implementationName || ''
    }
  } catch {
    return unknown
  }
}

/**
 * 同步采集适配器信息（错误卡片、上报用的都是这一份）。
 *
 * @param bot Koishi 的原生 Bot（不是兼容层的包装）
 */
export const resolveAdapterInfo = (bot: any): KkkAdapterInfo => {
  const platform = String(bot?.platform ?? bot?.adapterName ?? '').trim()
  const pkg = resolvePackage(bot)
  const implementation = cachedAdapterImplementation(bot)
  const version = implementation?.version || pkg.version || '未知'
  const name = platform || '未知'
  // 各家协议端都自报 onebot，光看平台名分不出来，所以拼上实现端代号：onebot(nc)
  const code = implementationCode(implementation?.name ?? '')

  return {
    // 前四个字段是「身份」，一律保持 Koishi 的原值；只有下面这些是这次修好的展示信息
    name,
    displayName: implementation?.name || displayNameOf(platform, pkg.packageName),
    implementationName: implementation?.name ?? '',
    implementationCode: code,
    shortLabel: code ? `${name}(${code})` : name,
    version,
    platform: platform || '未知',
    protocol: platform,
    standard: platform,
    communication: communicationOf(bot),
    connectTime: onlineSince(bot),
    packageName: pkg.packageName,
    raw: bot?.adapter
  }
}
