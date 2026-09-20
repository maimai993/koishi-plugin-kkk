/**
 * koishi-plugin-kkk —— koishi-plugin-kkk 的 Koishi 移植版入口。
 *
 * 迁移策略：
 * 1. `src/karin/` 是从 karin-plugin-kkk 源码逐文件搬过来的业务代码，import 路径保持不变；
 * 2. `src/compat/` 用 Koishi 实现 karin 框架 API（`node-karin`），编译产物里通过 node_modules/node-karin 转发；
 * 3. 本文件是 Koishi 插件入口：绑定运行时 → 加载移植的 apps（它们会注册命令/任务）→ 落地为 Koishi 中间件与定时任务。
 */
import dns from 'node:dns'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

import { Context, Schema } from 'koishi'

import { startScheduler } from './compat/cron'
import { setLogger } from './compat/logger'
import { Message, NEXT } from './compat/node-karin'
import { bindRuntime, commandPrefixes, commandQueue, eventQueue, taskQueue, tryGetRuntime } from './compat/runtime'
import { buildQqSchema, QQ_KEYS, readQqOptions } from './qqOptions'
import { registerWebUi } from './webui'
import { applyUpstreamOverrides } from './configBridge'
import { resolveQqCardContent } from './karin/module/utils/QqCardResolve'
import { buildUpstreamSchema } from './schema'

/**
 * 插件根目录。
 *
 * 通常编译产物在 `lib/index.js`，向上一级就是包根；但生产环境不一定按这个位置加载
 * （打包 / 转译缓存 / pnpm 的不同布局 / 直接跑源码都会让 `__dirname` 落到别处），
 * 一旦猜错，`/kkk` 面板就会报「assets/web/index.html 缺失」。
 *
 * 所以这里从 `__dirname` 逐级向上找，直到找到带 `assets/web/index.html` 的那一层，
 * 再兜底试「按包名解析」和「cwd / cwd/node_modules」。
 */
function resolvePluginRoot (): string {
  const marker = path.join('assets', 'web', 'index.html')
  const candidates: string[] = []
  let dir = __dirname
  for (let i = 0; i < 6; i++) {
    candidates.push(dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  try {
    candidates.push(path.dirname(require.resolve('koishi-plugin-kkk/package.json')))
  } catch { /* 本地链接安装时解析不到，正常 */ }
  candidates.push(process.cwd(), path.join(process.cwd(), 'node_modules', 'koishi-plugin-kkk'))

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(path.join(candidate, marker))) return candidate
    } catch { /* 权限之类的问题跳过 */ }
  }
  return path.resolve(__dirname, '..')
}

const pluginRootDir = resolvePluginRoot()

/**
 * 网络兜底：优先 IPv4。
 *
 * 这台机器到 B站的 IPv6 链路是坏的（连上就被对端 reset），日志里表现为
 * `read ECONNRESET`（getBilibiliID、弹幕接口、playurl 都会中招），
 * 而且 Node 默认的 Happy Eyeballs 会**先试 IPv6**、连接建立后再被 reset，
 * 不会自动回退到 IPv4，于是整条解析随机失败。
 *
 * 这里把 DNS 结果顺序改成 IPv4 优先、并关掉 autoSelectFamily（避免 IPv6 先连），
 * 让所有出站请求都走 IPv4。改动是进程级的（Koishi 宿主里所有插件共用），
 * 但只影响「优先用哪一族地址」，不影响正常 IPv4 网络。
 */
try {
  dns.setDefaultResultOrder('ipv4first')
} catch { /* 老版本 Node 没有这个 API，忽略 */ }
try {
  (net as any).setDefaultAutoSelectFamily?.(false)
} catch { /* 同上 */ }
export const name = 'kkk'

export const inject = {
  // server 只给「插件自带控制台」用，已经移除；这里留着不需要的服务反而会拖慢加载
  // ffmpeg：由 koishi-plugin-ffmpeg-path 提供，兼容层的 ffmpeg()/ffprobe() 会优先用它
  // assets：koishi-plugin-assets-qqbot-part-file 之类提供的图床服务，
  // 面板卡片要上传成 https 地址才能放进 QQ 的 markdown 图片里
  optional: ['puppeteer', 'database', 'http', 'ffmpeg', 'assets', 'server', 'console']
}

export interface Config {
  /** 主人账号（对应 karin 的 master），用于接收报错通知等 */
  masters: string[]
  /** 数据目录，默认 <baseDir>/data/kkk */
  dataPath: string
  /** 输出调试日志 */
  debug: boolean
  /** 消息里的链接自动解析 */
  autoParse: boolean
  /** 配置面板（/kkk）是否要求先登录 Koishi 控制台（默认开；装了 auth 插件时生效） */
  webUiAuth: boolean
  /** QQ 平台解析前先发交互面板（Markdown + 按钮）让用户选解析内容和画质 */
  qqPanel: boolean
  /** QQ 面板里隐藏超过该体积（MB）的画质按钮 */
  qqFileLimitMB: number
  /** 是否在图片过大/发送失败时自动切片（默认开） */
  sliceImageOnDemand: boolean
  /** 切片高度（像素） */
  sliceImageHeight: number
  /** 卡片解析的 OCR 密钥（OCR.space） */
  ocrApiKey: string
  /** 操作后撤回上一条面板消息（默认开） */
  recallPanel: boolean
  /** 番剧分集表格的列数（默认 5） */
  bangumiPanelCols: number
  /** 番剧分集表格的行数（默认 4，含作为第一行的表头，即一页 5×4 = 20 集） */
  bangumiPanelRows: number
  /** 插件自身的配置（与 Karin 版 config.json 同构，保存时写回数据目录的 config.json） */
  upstream: Record<string, any>
}

/**
 * 配置表单 = 「Koishi 集成选项」 + 「上游插件配置」。
 *
 * 后者按 \`config/default_config/config.json\` 的形状动态生成，所以清晰度（\`douyin.videoQuality\`）、
 * 发送内容（\`*.sendContent\`）、渲染（\`app.renderScale\`）、推送（\`pushlist\`）等上游选项都会出现在控制台里。
 * 这里能改的项会被写回数据目录的 config.json（见 configBridge），在那之前 config.json 仍是权威来源。
 */
/** 摊平后由「Koishi 原生设置」分组提供的字段 */
const NATIVE_KEYS = ['masters', 'dataPath', 'debug', 'autoParse', 'webUiAuth']

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    webuiGuide: Schema.const('').description(
      '**本插件的配置都在配置面板里改**：Koishi 控制台左侧边栏 →「**kkk 配置**」。\n\n' +
      '（原版配置面板：接口库 / 通用 / 抖音 / 哔哩哔哩 / 快手 / 小红书 / **QQ 适配器** / 推送列表，' +
      '改完点右下角保存即可，写回 koishi.yml 并热重载，不用重启。）'
    ),
    // 全部隐藏：控制台表单里不显示，配置统一在控制台侧边栏的「kkk 配置」面板里改
    qq: buildQqSchema(Schema).hidden().description('QQ 适配器（只对 QQ 平台生效）'),
    advanced: Schema.object({
    masters: Schema.array(Schema.string()).default([]).description('主人账号（QQ 号）：接收报错通知，以及执行只有主人能用的指令'),
    dataPath: Schema.string().default('data').description('数据目录：配置、数据库、临时文件都放在这里'),
    debug: Schema.boolean().default(false).description('在日志里输出调试信息，排查问题时才需要打开'),
    autoParse: Schema.boolean().default(true).description('群里有人发链接（或回复一条带链接的消息）就自动解析，不用打指令'),
    webUiAuth: Schema.boolean().default(true).description('配置面板 /kkk 是否要求先登录 Koishi 控制台（默认开）。装了 auth 插件的部署只有登录后才能打开面板；没装 auth 插件时本来就没有登录这一说，这里不生效'),
    }).collapse().hidden().description('Koishi 原生设置（一般不用改，已折叠）'),
  }),
  Schema.object({
    upstream: buildUpstreamSchema(pluginRootDir).hidden().description(
      '插件自身的配置（与 Karin 版 config.json 一致）。每项都带着上游默认值，枚举型字段是下拉框；' +
      '**与默认值不同**的项会在启动时写回 config.json，保持默认值的项不写（这样你直接改文件的内容不会被覆盖）'
    )
  })
])

export const usage = `
## 配置

本插件的设置都在 **配置面板** 里改：Koishi 控制台左侧边栏 →「**kkk 配置**」。

面板里按平台分好类：接口库 / 通用 / 抖音 / 哔哩哔哩 / 快手 / 小红书 / **QQ 适配器** / 推送列表，
改完点右下角保存即可，立即生效、不用重启。

> 这个插件配置页里的设置项已经全部隐藏 —— 那是为了防止两处各改一半，配置统一在面板里维护。

## 指令

指令前缀按你的 Koishi 配置来，默认直接写命令名即可：

| 指令 | 作用 |
| --- | --- |
| \`解析 <链接>\` / \`kkk解析\` | 解析作品（QQ 上先出交互面板） |
| \`弹幕解析 <链接>\` | 把弹幕烧进视频，引用一条消息使用 |
| \`kkk帮助\` | 查看命令菜单 |
| \`kkk版本\` | 运行环境诊断卡片 |
| \`kkk解析统计\` / \`kkk全局解析统计\` | 查看解析统计（后者仅主人） |
| \`B站登录\` / \`抖音登录\` | 扫码登录，自动写入 Cookie |
| \`设置B站推送 <UID>\` / \`设置抖音推送 <抖音号>\` | 订阅或取消动态推送 |
| \`B站推送列表\` / \`抖音推送列表\` | 查看当前订阅 |
| \`卡片消息\` | 解析转发的分享卡片 |

往群里发**链接**（或回复一条含链接的消息）就会自动解析。

## QQ 上怎么用

发链接后机器人先回一条**面板**：列出各档画质和体积，选一个点下去才开始下载；
下载过程中会提示「正在获取下载链接 / 正在合并音轨 / 发送中…」，上一条面板会自动撤回，群里只留最新一条。

番剧会先出分集表格，表格下方是「上一页 / 第 x/y 页 / 下一页」。

视频体积较大时（默认超过 30MB，可在面板的「QQ 适配器」里调）会改用**群文件**发送，
避免 QQ 压缩画质或改掉文件名。
`

/**
 * karin 的权限模型 → Koishi 实现。
 *
 * - `master`：插件配置里的 masters，或 Koishi 管理员（user.admin / authority >= 4）
 * - `admin`：以上任一条，或群管理员（roles 里含 owner/admin）
 * - `all` / 未配置：任何人
 */
/** Koishi 宿主（koishi.yml）里配置的主人们 —— 之前只认插件自己的 masters，所以宿主的主人反而没权限 */
function koishiMasterIds (): string[] {
  try {
    const ctx: any = (tryGetRuntime() as any)?.ctx
    const config: any = ctx?.root?.config ?? ctx?.config ?? {}
    const list = Array.isArray(config.masters) ? config.masters : []
    return list.map((id: any) => String(id))
  } catch {
    return []
  }
}

/** 取与会话相关的 Koishi 权限信息（authority / admin / masters） */
function koishiAuthority (session: any): number {
  const candidates = [
    session?.user?.authority,
    session?.event?.user?.authority,
    session?.author?.authority,
    session?.bot?.user?.authority
  ]
  for (const value of candidates) {
    const num = Number(value)
    if (Number.isFinite(num) && num > 0) return num
  }
  return 0
}

function checkPermission (session: any, perm?: string): boolean {
  if (!perm || perm === 'all') return true

  // 两边的名单都认：插件自己的 masters + Koishi 宿主配置的 masters
  const masters: string[] = [
    ...(tryGetRuntime()?.config.masters ?? []),
    ...koishiMasterIds()
  ].map((id: any) => String(id))
  const user = session.user ?? {}
  const authority = koishiAuthority(session)
  const isMaster = masters.includes(String(session.userId))
    || user.admin === true
    || authority >= 4            // Koishi 的权限等级里 4 = 主人
  if (perm === 'master') return isMaster

  if (perm === 'admin') {
    if (isMaster) return true
    if (authority >= 3) return true   // 3 = 管理员
    const roles: string[] = session.author?.roles ?? []
    return roles.includes('owner') || roles.includes('admin') || roles.includes('administrator')
  }

  return true
}

/* ------------------------------------------------------------------ *
 * 指令注册
 * ------------------------------------------------------------------ */

/** 这几个注册不是「用户敲的指令」，而是「消息里出现链接就自动解析」 */
const AUTO_PARSE_REGISTRATIONS = new Set([
  'kkk-视频功能-抖音',
  'kkk-视频功能-B站',
  'kkk-视频功能-快手',
  'kkk-视频功能-小红书'
])

/**
 * 正则里含 \s、字符类等写法、推导不出指令名的，手工补一份。
 * 键是 \`reg.source\`。
 */
const MANUAL_COMMAND_NAMES: Record<string, string[]> = {
  '^#?(kkk)?\\s*B站\\s*(扫码)?\\s*登录$': ['B站登录', 'B站扫码登录', 'kkkB站登录', 'kkkB站扫码登录'],
  '^#?(kkk)?抖音(扫码)?登录$': ['抖音登录', '抖音扫码登录', 'kkk抖音登录', 'kkk抖音扫码登录'],
  '^#设置[bB]站推送': ['设置B站推送'],
  '^#?[bB]站推送列表$': ['B站推送列表']
}

/** 控制台里显示的指令说明 */
const COMMAND_DESCRIPTIONS: Record<string, string> = {
  解析: '解析消息或引用里的链接（抖音 / B站 / 快手 / 小红书）',
  kkk解析: '「解析」的别名',
  弹幕解析: '解析链接并把弹幕烧录进视频（当前移植版未接入 ffmpeg，会退化为纯视频）',
  kkk帮助: '查看插件帮助',
  kkk版本: '查看运行环境与版本信息',
  kkk更新日志: '查看更新日志',
  kkk更新: '更新插件（需要宿主支持）',
  kkk解析统计: '查看本群解析统计',
  kkk全局解析统计: '查看全局解析统计',
  登录: '扫码登录各平台账号',
  B站登录: '扫码登录 B站账号',
  抖音登录: '扫码登录抖音账号',
  设置抖音推送: '设置抖音推送（用法：设置抖音推送 <抖音号>）',
  设置B站推送: '设置B站推送（用法：设置B站推送 <UID>）',
  抖音推送列表: '查看本群抖音推送列表',
  B站推送列表: '查看本群B站推送列表',
  kkk设置推送机器人: '指定推送使用的机器人账号',
  kkk推送全局忽略: '全局忽略某个推送对象'
}

/** 把正则里的分组展开成具体名字，例如 \`(抖音|B站)(全部)?强制推送\` → 4 个名字 */
function expandPattern (input: string): string[] {
  const group = input.match(/\(([^()]*)\)(\?)?/)
  if (!group || group.index === undefined) return [input]
  const before = input.slice(0, group.index)
  const after = input.slice(group.index + group[0].length)
  const variants = group[1].includes('|') ? group[1].split('|') : [group[1]]
  const results: string[] = []
  for (const variant of variants) {
    if (group[2]) results.push(...expandPattern(before + after))
    results.push(...expandPattern(before + variant + after))
  }
  return results
}

/**
 * 从 karin 的 reg 里推导出「用户能敲的 Koishi 指令名」。
 *
 * 上游的 reg 是 karin 风格的正则（\`/^#?(解析|kkk解析|弹幕解析)/\`），这里把
 * 开头锚点、结尾锚点和旧的 \`#\` 前缀剥掉，再把分组展开 —— 推不出来就返回空数组，
 * 由调用方退化成 \`#\` 前缀的中间件，不影响功能。
 * @param reg karin 的命令匹配式
 * @returns 指令名列表
 */
function commandNames (reg: RegExp | string): string[] {
  const source = typeof reg === 'string' ? reg : reg.source
  const manual = MANUAL_COMMAND_NAMES[source]
  if (manual) return manual
  const text = source.replace(/^\^/, '').replace(/\$$/, '').replace(/^#\??/, '')
  // 还剩 \s、字符类、量词这类写法的，说明不是「纯字面量」，交给手工表
  if (!/^[\w\u4e00-\u9fa5|()?]+$/.test(text)) return []
  return [...new Set(expandPattern(text))].filter((name) => /^[A-Za-z\u4e00-\u9fa5][\w\u4e00-\u9fa5]*$/.test(name))
}

/** 去掉 Koishi 命令前缀（\`/解析 x\` → \`解析 x\`） */
function stripCommandPrefix (content: string): string {
  for (const prefix of commandPrefixes()) {
    if (prefix && content.startsWith(prefix)) return content.slice(prefix.length)
  }
  return content
}

/** 这条消息是不是「在调指令」（带 Koishi 前缀，或以某个已注册指令名开头） */
function isCommandMessage (content: string, names: Set<string>): boolean {
  for (const prefix of commandPrefixes()) {
    if (prefix && content.startsWith(prefix)) return true
  }
  for (const name of names) {
    if (content === name || content.startsWith(name + ' ') || content.startsWith(name + '　')) return true
  }
  return false
}

/**
 * 注册指令。
 *
 * 上游 karin 用「正则 + 中间件」分发命令，Koishi 里这样注册出来的命令**不出现在指令列表里**、
 * 也没法用 Koishi 的前缀体系。所以这里分两条路：
 *   1. **能推导出名字的注册 → 注册成真正的 Koishi 指令**（\`解析\` / \`弹幕解析\` / \`kkk帮助\` …），
 *      控制台能看到、\`/解析\` 和（配置了空前缀时）\`解析\` 都能触发；
 *   2. **链接识别类注册 → 仍然是中间件**（它们不是「用户敲的命令」，而是「消息里有链接就解析」），
 *      遇到指令消息会让路；
 *   3. 旧的 \`#解析\` 写法保留一条中间件兜底，老用户不会突然用不了。
 *
 * karin 的业务代码都假设 \`e.msg\` 以 \`#\` 开头（\`e.msg.replace(/^#设置抖音推送/, '')\` 这种），
 * 所以给指令构造 Message 时会把 Koishi 前缀换回 \`#\` —— 20 多处命令解析不用改一行。
 * @param ctx Koishi 上下文
 * @param logger 插件日志
 * @param autoParse 是否自动解析消息里的链接
 */
/** 已经提示过「没有权限」的消息 ID（防止指令 + 文本兜底两条路重复提示） */
const permissionNotified = new Set<string>()

/**
 * 指令 action 的「已消费」返回值。
 * Koishi 的消息入口是 `if (result) await session.send(result)` —— 返回真值会被当成消息发出去
 * （之前返回 true，群里就真的收到一条「true」），所以这里用空串：既截断后续中间件，又不会被发送。
 */
const EMPTY_RESULT = ''

function registerCommands (
  ctx: Context,
  logger: ReturnType<Context['logger']>,
  autoParse: boolean
) {
  const registrations = [...commandQueue].sort((a, b) => {
    const pa = Number(a.options?.priority ?? 0)
    const pb = Number(b.options?.priority ?? 0)
    return pb - pa
  })
  const isAutoParse = (registration: typeof registrations[number]) =>
    AUTO_PARSE_REGISTRATIONS.has(String(registration.options?.name ?? ''))
  const linkRegistrations = registrations.filter(isAutoParse)
  const typedRegistrations = registrations.filter((item) => !isAutoParse(item))

  /** 跑一个 karin 注册；返回「这条消息是否已被消费」（handler 没调 next 就是消费了） */
  const runRegistration = async (
    registration: typeof registrations[number],
    session: any,
    msg: string
  ): Promise<boolean> => {
    const { handler, options, reg } = registration
    // karin 的 event 选项：限定只在这些会话类型里生效（默认 message = 群聊 + 私聊）
    const eventScope = options?.event
    if (eventScope === 'message.group' && !session.guildId) return false
    if (eventScope === 'message.private' && session.guildId) return false

    // karin 的 perm 选项：master / admin / all
    if (!checkPermission(session, options?.perm)) {
      // 同一条消息可能被「Koishi 指令」和「文本兜底中间件」各跑一次，导致重复提示；
      // 按消息 ID 去重，保证用户只看到一次
      const messageId = String(session?.messageId ?? session?.event?.message?.id ?? '')
      // 没有 messageId 时退化成「会话 + 内容 + 3 秒时间桶」，总之同一次触发只提示一次
      const key = messageId || [
        session?.selfId, session?.channelId, session?.userId,
        String(session?.content ?? '').slice(0, 40),
        Math.floor(Date.now() / 3000)
      ].join('|')
      if (!permissionNotified.has(key)) {
        permissionNotified.add(key)
        if (permissionNotified.size > 500) permissionNotified.clear()
        await session.send('你没有权限执行该命令').catch(() => {})
      }
      return true
    }

    let continued = false
    try {
      const result = await handler(Message.fromSession(session, msg), () => {
        continued = true
        return NEXT
      })
      if (result === NEXT) continued = true
    } catch (error: any) {
      logger.error('命令 %s 执行失败: %s', options?.name ?? String(reg), error?.stack ?? error)
      throw error
    }
    return !continued
  }

  // 1) 注册成真正的 Koishi 指令
  const registered = new Set<string>()
  for (const registration of typedRegistrations) {
    const names = commandNames(registration.reg)
    if (!names.length) {
      logger.debug('推导不出指令名，只保留 # 写法: %s', String(registration.reg))
      continue
    }
    for (const name of names) {
      if (registered.has(name)) continue
      /**
       * 弹幕功能已整体移除（用户要求）：弹幕解析指令不注册，发出来没有任何反应，
       * 控制台的指令列表里也不会出现它。卡片上方的热门弹幕不受影响。
       */
      if (/^#?弹幕解析$/.test(name.trim())) {
        logger.debug('弹幕功能已移除，跳过注册指令 %s', name)
        continue
      }
      registered.add(name)
      const description = COMMAND_DESCRIPTIONS[name] ?? ('koishi-plugin-kkk: ' + (registration.options?.name ?? name))
      // 解析类指令接一段自由文本（链接 / BV 号 / 参数），声明出来控制台里能看清用法；
      // Koishi 的 checkArgCount / checkUnknown 默认都是关的，多传也不会报错
      const parseCommand = name === '解析' || name === '弹幕解析' || name === 'kkk解析'
      const command = ctx.command(parseCommand ? name + ' [input:text]' : name, description)
      // 面板按钮发过来的是「解析 <链接> --qn=80」这类文本，声明一下选项免得被当成参数报错
      if (parseCommand) {
        command
          .option('qn', '--qn <qn:number> B站画质 qn')
          .option('q', '--q <quality:string> 抖音/小红书画质档位')
          .option('dm', '--dm <value:string> 烧录弹幕')
          .option('panel', '--panel <mode:number> 只重发解析面板')
          .option('bgp', '--bgp <page:number> 番剧分集表格翻页')
      }
      command.action(async ({ session }) => {
        if (!session) return
        // karin 的代码都假设 e.msg 以 # 开头，这里把 Koishi 前缀换回 #（见函数注释）
        const consumed = await runRegistration(registration, session, '#' + stripCommandPrefix(session.content ?? ''))
        /**
         * 消费掉的消息要返回一个**非空值**：Koishi 的 \`Command.execute\` 在 action 返回空值时会
         * 继续跑后面的队列（也就是把消息交回中间件链），那条链上的链接自动解析会**再解析一次** ——
         * 表现就是「检测到链接，开始解析」出现两次、第二次还失败。
         */
        // 注意：Koishi 的实现是「返回值是真值就 send 出去」，所以这里只能返回空串：
        // 空串能截断后续中间件，又不会被当成消息发出去（返回 true 会真的回一个「true」）
        return consumed ? EMPTY_RESULT : undefined
      })
    }
    logger.debug('注册指令 %s ← %s', names.join(' / '), String(registration.reg))
  }
  if (registered.size) logger.info('已注册 Koishi 指令 %d 个：%s', registered.size, [...registered].join(' '))

  /**
   * 「下载进度」指令：面板上的 📊 按钮点一下就发它。
   * 解析大文件时群里只有一句「收到请求，开始下载」，有这个按钮就能随时看进度。
   */
  if (!registered.has('下载进度')) {
    registered.add('下载进度')
    ctx.command('下载进度', '查看当前解析下载进度').action(async ({ session }) => {
      const { listActiveDownloads } = require('./karin/module/utils/Network/Downloader')
      const tasks = listActiveDownloads()
      const formatMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)
      const lines = tasks.length
        ? tasks.map((task: any) => {
            // 「还没开始传输字节」的阶段（获取下载链接 / 合并音轨）直接显示阶段文案
            if (task.stage) return '• ' + task.name + '　' + task.stage
            const percent = task.total > 0 ? Math.floor((task.bytes / task.total) * 100) + '%' : '?'
            return '• ' + task.name + '　' + formatMB(task.bytes) + (task.total > 0 ? '/' + formatMB(task.total) + ' MB' : ' MB') + '（' + percent + '）'
          })
        : ['当前没有正在进行的下载']
      await session?.send('📥 下载进度\n' + lines.join('\n'))
      return EMPTY_RESULT
    })
  }

  /**
   * 按 karin 的注册表跑一条「文本命令」。
   * 旧的 \`#\` 写法和 QQ 的按钮交互事件都走这里 —— 它们都绕过了 Koishi 的指令解析。
   * @returns 是否已消费这条消息
   */
  const runTextCommand = async (session: any, text: string): Promise<boolean> => {
    for (const registration of typedRegistrations) {
      const { reg } = registration
      let matched = false
      try {
        matched = typeof reg === 'string' ? text.startsWith(reg) : new RegExp(reg.source, reg.flags).test(text)
      } catch (error) {
        logger.warn('命令匹配失败 %s: %s', registration.options?.name ?? String(reg), error)
        continue
      }
      if (!matched) continue
      return await runRegistration(registration, session, text)
    }
    return false
  }

  // 2) 文本兜底：旧的 \`#\` 写法 + 「Koishi 没认出来的指令文本」都从这里走。
  //
  // 为什么还需要它：Koishi 的指令匹配依赖 prefix 配置 —— 面板按钮发的是不带前缀的
  // \`解析 --p=xxx --qn=80\`，用户也可能照着手敲。要是宿主的 prefix 没配空串，
  // 这条文本就既不是指令、又不像链接，插件会**完全没反应**。
  // 这里在 Koishi 没有认领（argv.command 为空）时按同一张注册表再匹配一次，行为与指令完全一致。
  ctx.middleware(async (session: any, next) => {
    const raw = session.content ?? ''
    if (!raw) return next()
    if (session.argv?.command) return next()
    /**
     * 卡片消息：**既没有链接、也不是指令**，平台正则和指令表都匹配不到，
     * 所以必须兜在链路最后一环。
     *
     * 关键：定位到作品后**不能只 next()** —— 后面已经没有处理器了。
     * 正确做法是把消息文本换成「解析 <链接>」重新跑一遍匹配，复用完整解析流程。
     */
    if (/卡片消息/.test(raw)) {
      try {
        const { extractCardInfo, resolveCardToUrl } = await import('./karin/module/utils/CardParser')
        /**
         * **只处理 B站卡片。**
         *
         * 卡片摘要里自带平台名（实测 source: 哔哩哔哩），网易云音乐、QQ音乐、淘宝之类的卡片
         * 也会被这段逻辑接住，白白跑一遍 OCR + 搜索，还会发「正在提取卡片信息…」打扰用户。
         * 认不出平台、或者不是 B站，直接放行（那些卡片本来也不该由我们解析）。
         */
        const cardPlatform = String(extractCardInfo(raw)?.source ?? '')
        if (!/哔哩|bilibili|B站/i.test(cardPlatform)) {
          logger.debug('卡片来源不是 B站（%s），跳过卡片解析', cardPlatform || '未知')
          return next()
        }
        const send = async (content: any) => {
          try {
            await (session as any).send(content)
          } catch (error: any) {
            logger.debug('卡片解析回话失败: %s', String(error?.message ?? error))
          }
        }
        // 提取 + OCR + 搜索要几秒，先给个反馈
        await send('正在提取卡片信息…')
        const resolved = await resolveCardToUrl(raw)
        if (resolved && resolved.url) {
          // 注意：这里的 logger 是 Koishi 的 ctx.logger，没有 mark 方法（只有 info/warn/debug）
          logger.info('卡片解析命中，按链接重新解析: %s', resolved.url)
          if (await runTextCommand(session, '#解析 ' + resolved.url)) return
        }
        if (resolved && resolved.candidates && resolved.candidates.length) {
          const { cmdInput } = await import('./karin/module/utils/QqPanel')
          const table = ['| # | 标题 | UP / 作者 | 操作 |', '| :---: | :--- | :--- | :---: |']
          resolved.candidates.slice(0, 6).forEach((item: any, index: number) => {
            const link = item.platform === 'bilibili'
              ? 'https://www.bilibili.com/video/' + item.id
              : 'https://www.douyin.com/video/' + item.id
            const title = String(item.title || '（无标题）').replace(/[|\n]/g, ' ').slice(0, 26)
            const author = String(item.author || '-').replace(/[|\n]/g, ' ').slice(0, 12)
            table.push('| ' + (index + 1) + ' | ' + title + ' | ' + author + ' | ' + cmdInput('解析 ' + link, '解析') + ' |')
          })
          const tip = '没能唯一确定这个作品（识别到：' + ((resolved.upName) || '未知') + '），下面是候选，点按钮直接解析：'
          await send([{ type: 'markdown', attrs: { content: tip + String.fromCharCode(10) + table.join(String.fromCharCode(10)) } }])
          return
        }
        await send('没能从这张卡片里认出作品，直接发链接给我吧')
        return
      } catch (error: any) {
        logger.warn('卡片解析失败: ' + String(error?.message ?? error))
      }
    }
    const text = raw.startsWith('#') ? raw : '#' + stripCommandPrefix(raw)
    if (await runTextCommand(session, text)) return
    return next()
  })

  /**
   * 3) QQ 按钮点击的另一种落地方式。
   *
   * QQ 官方适配器对按钮有两种投递：**指令按钮**（我们用的 type=2）会变成一条用户消息，
   * 走上面的 Koishi 指令；**回调按钮**（type=1）则是 \`interaction/button\` 事件，
   * 点击内容在 \`session.event.button.data\` 里、**不会**变成消息。
   * 两条都接上，用户点哪种按钮都能解析（也兼容以后把按钮换成回调类型）。
   */
  ctx.on('interaction/button', (session: any) => {
    const data = String(session?.event?.button?.data ?? '').trim()
    if (!data) return
    const text = data.startsWith('#') ? data : '#' + data
    logger.debug('收到 QQ 按钮交互: %s', text)
    runTextCommand(session, text).catch((error) => {
      logger.error('处理按钮交互失败: %s', error?.stack ?? error)
    })
  })

  // 4) 链接自动解析：消息里出现链接就解析（不是指令，遇到指令消息让路）
  if (!autoParse) {
    logger.info('自动解析已关闭（autoParse=false），消息里的链接不会再自动解析')
    return
  }
  ctx.middleware(async (session, next) => {
    const raw = session.content ?? ''
    if (!raw || isCommandMessage(raw, registered)) return next()
    // 上面那条兜底中间件已经按注册表匹配过一遍了，这里只处理「链接识别」
    // QQ 新版分享卡片可能一个链接都不带，必须在**匹配前**先还原出链接，
    // 否则平台的链接正则命中不了，命令根本不会触发（普通消息走同步快路径，无额外开销）
    const content = await resolveQqCardContent(raw).catch((error) => {
      logger.debug('QQ 卡片还原失败: %s', error)
      return raw
    })
    for (const registration of linkRegistrations) {
      const { reg } = registration
      let matched = false
      try {
        matched = typeof reg === 'string' ? content.startsWith(reg) : new RegExp(reg.source, reg.flags).test(content)
      } catch (error) {
        logger.warn('命令匹配失败 %s: %s', registration.options?.name ?? String(reg), error)
        continue
      }
      if (!matched) continue
      if (await runRegistration(registration, session, content)) return
    }
    return next()
  })
}

export async function apply (ctx: Context, rawConfig: Config) {
  const logger = ctx.logger('kkk')
  setLogger(logger)
  {
    const ok = fs.existsSync(path.join(pluginRootDir, 'assets', 'web', 'index.html'))
    logger.info('[kkk] 插件根目录: ' + pluginRootDir + (ok ? '' : '（警告：这里没有 assets/web/index.html，/kkk 面板会打不开）'))
  }

  /**
   * 控制台表单把选项分成两个折叠组（「QQ 适配器」和「Koishi 原生设置」），
   * 这里统一摊平回顶层 —— 代码里照旧读 config.qqPanel / config.sliceImageOnDemand 等。
   * 同时把引导项（webuiGuide）丢掉，它只是个提示。
   * qq 组放最后：它优先于早期直接写在顶层的同名字段。
   */
  const raw = (rawConfig ?? {}) as any
  const { webuiGuide: _guide, advanced, qq, upstream, ...rest } = raw

  /**
   * 早期的版本把这些开关直接写在配置顶层（`masters` / `qqPanel` …），
   * 现在它们分别在「Koishi 原生设置」和「QQ 适配器」分组里。
   * 顶层的旧值要**压过**分组里的默认值 —— 否则 schema 的 default 会把用户原来的设置盖掉
   * （踩过一次：masters / debug / ocrApiKey 被默认值吃掉了）。
   */
  const legacy: any = {}
  for (const key of [...NATIVE_KEYS, ...QQ_KEYS]) {
    if (raw[key] !== undefined) legacy[key] = raw[key]
  }
  const groupQq: any = { ...(qq ?? {}) }
  const groupNative: any = { ...(advanced ?? {}) }
  for (const key of QQ_KEYS) if (legacy[key] !== undefined) groupQq[key] = legacy[key]
  for (const key of NATIVE_KEYS) if (legacy[key] !== undefined) groupNative[key] = legacy[key]

  // 注意 upstream 要放回去：它被解构出来了，漏掉的话 WebUI / configBridge 就拿不到上游配置了
  const config = { ...rest, upstream, ...groupNative, ...groupQq } as Config

  /**
   * 顺手把顶层遗留项搬进分组并写回 koishi.yml（只做一次：写回后顶层就没有这些键了）。
   * 不搬的话，控制台表单里显示的是默认值、和实际生效的值不一致，很容易改错。
   */
  if (Object.keys(legacy).length) {
    // 放到 ready 之后再写：scope.update 会热重载本插件，在 apply 里直接写会和本次启动抢注册
    // （踩过：控制台报 duplicate option name "qn" for command "解析"）
    const migrate = async () => {
      const scope: any = (ctx as any).scope
      if (typeof scope?.update !== 'function') return
      const next: any = { ...rest, upstream }
      for (const key of [...NATIVE_KEYS, ...QQ_KEYS]) delete next[key]
      if (Object.keys(groupQq).length) next.qq = groupQq
      if (Object.keys(groupNative).length) next.advanced = groupNative
      try {
        await scope.update(next)
        logger.info('[kkk] 已把配置文件顶层的旧选项迁移到「QQ 适配器」/「Koishi 原生设置」分组')
      } catch (error: any) {
        logger.warn('[kkk] 迁移旧配置项失败（不影响本次运行）: ' + String(error?.message ?? error))
      }
    }
    ctx.on('ready', () => { ctx.setTimeout(() => { void migrate() }, 2000) })
  }

  /**
   * 配置 WebUI：一个独立小页面（/kkk，口令见 webUiPassword，默认 131425），
   * 保存时走 ctx.scope.update 写回 koishi.yml 并热重载；控制台里也注册了入口页面（见 client/index.js）。
   */
  registerWebUi({ ctx, config, rawConfig: rawConfig as any, logger, pluginRoot: pluginRootDir })
  try {
    const consoleService: any = (ctx as any).console
    if (consoleService && typeof consoleService.addEntry === 'function') {
      /**
       * 指向 **dist**：官方工具 `koishi-console build .` 把浏览器端产物打到 dist/index.js。
       * 之前指向 client，加载到的是源码 TS，浏览器解析不了 —— 侧边栏就一直看不到入口。
       */
      consoleService.addEntry({ prod: path.resolve(pluginRootDir, 'dist') })
    }
  } catch (error) {
    logger.debug('[kkk] 注册控制台入口失败: ' + String(error))
  }

  const pluginRoot = path.resolve(__dirname, '..')
  const dataRoot = path.isAbsolute(config.dataPath) ? config.dataPath : path.resolve(ctx.baseDir ?? process.cwd(), config.dataPath)

  bindRuntime({
    ctx,
    config: {
      masters: config.masters ?? [],
      debug: config.debug,
      dataPath: config.dataPath,
      qqPanel: config.qqPanel !== false,
      qqFileLimitMB: Number(config.qqFileLimitMB) || 200,
      recallPanel: config.recallPanel !== false,
      bangumiPanelCols: Number(config.bangumiPanelCols) || 5,
      bangumiPanelRows: Number(config.bangumiPanelRows) || 4
    },
    pluginRoot,
    dataRoot
  })

  fs.mkdirSync(dataRoot, { recursive: true })

  // 控制台里填过的上游配置写回 config.json —— 必须赶在加载上游 apps 之前，
  // 因为部分模块会在 import 时就把配置读进闭包（例如 apps/tools.ts 里的优先级判断）。
  if (config.upstream && Object.keys(config.upstream).length > 0) {
    try {
      const { changed, file } = applyUpstreamOverrides(config.upstream)
      if (changed.length) {
        logger.info('已把控制台里的 %d 项上游配置写入 %s（%s%s）', changed.length, file,
          changed.slice(0, 6).join(', '), changed.length > 6 ? ' …' : '')
      }
    } catch (error: any) {
      logger.error('写入上游配置失败: %s', error?.stack ?? error)
    }
  }

  // 加载移植过来的 Karin 应用（模块顶层会调用 karin.command / karin.task 入队）
  const apps = ['tools', 'help', 'admin', 'push', 'qrlogin', 'statistics', 'testPush', 'update']
  for (const app of apps) {
    try {
      await import('./karin/apps/' + app)
    } catch (error: any) {
      logger.warn('加载 app %s 失败（该功能暂不可用）: %s', app, error?.message ?? error)
    }
  }

  // 初始化数据库实例（对应 Karin 版 setup.ts 的 initAllDatabases）
  // 原实现用顶层 await 立即初始化，CJS 下改成在这里显式引导，否则 module/db 导出的实例是 null
  try {
    const { bootstrapDatabases } = await import('./karin/module/db')
    const { douyinDB, bilibiliDB, statisticsDB } = await bootstrapDatabases()
    logger.debug('数据库初始化完成：%s / %s / %s', douyinDB.constructor.name, bilibiliDB.constructor.name, statisticsDB.constructor.name)
  } catch (error: any) {
    logger.error('数据库初始化失败: %s', error?.stack ?? error)
  }

  // 创建运行期需要的目录（对应 Karin 版 setup.ts 里的 mkdirSync）
  try {
    const { Common } = await import('./karin/module/utils/Common')
    for (const dir of Object.values(Common.tempDri)) {
      if (typeof dir === 'string') fs.mkdirSync(dir, { recursive: true })
    }
  } catch (error: any) {
    logger.warn('初始化临时目录失败: %s', error?.message ?? error)
  }

  // 控制台里配的 OCR key 覆盖到上游配置上（CardParser 读的是 Config.app.ocrApiKey）
  if (config.ocrApiKey) { try { (Config.app as any).ocrApiKey = config.ocrApiKey } catch { /* 忽略 */ } }
  registerCommands(ctx, logger, config.autoParse !== false)
  startScheduler(ctx, logger, taskQueue)

  // 兼容 karin 的 BOT_CONNECT：Koishi 侧用 bot-status-update 近似
  ctx.on('bot-status-update', (bot: any) => {
    for (const item of eventQueue) {
      if (item.event !== 'bot-connect' && item.event !== 'BOT_CONNECT') continue
      Promise.resolve()
        .then(() => item.handler(bot))
        .catch((error: any) => logger.error('bot-connect 处理器失败: %s', error?.stack ?? error))
    }
  })

  logger.info('koishi-plugin-kkk 已加载：命令 %d 个，定时任务 %d 个', commandQueue.length, taskQueue.length)
  if (!tryGetRuntime()?.ctx.bots?.length) {
    logger.debug('当前没有已连接的机器人，等待适配器上线')
  }
}
