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
import { isOnlinePlayerEnabled, setupOnlinePlayer } from './player'
import { setupVerifyPage } from './verify'
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
  // database：**必选**。订阅关系、推送缓存、解析统计全走 Koishi 原生数据库服务
  // （表由 ctx.model.extend 注册，落在宿主自己的库里，插件不再自己开 sqlite 文件）。
  // 之前它是 optional，因为那会儿插件自己建库；现在没有数据库服务就没有地方存数据，
  // 直接声明成必选，让 Koishi 在没有配置数据库插件时明确地不加载本插件。
  required: ['database'],
  // server 只给「插件自带控制台」用，已经移除；这里留着不需要的服务反而会拖慢加载
  // ffmpeg：由 koishi-plugin-ffmpeg-path 提供，兼容层的 ffmpeg()/ffprobe() 会优先用它
  // assets：koishi-plugin-assets-qqbot-part-file 之类提供的图床服务，
  // 面板卡片要上传成 https 地址才能放进 QQ 的 markdown 图片里
  // 渲染：只用浏览器渲染服务（koishi-plugin-puppeteer 或同类插件）
  // 3.5.0 起不再支持 shotkit 内核（它在 Windows 上加载不了 https 资源，卡片会缺图）
  optional: ['puppeteer', 'http', 'ffmpeg', 'assets', 'server', 'console']
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

/**
 * 控制台里**唯一可见**的一段文字：把用户指到 WebUI 面板去。
 *
 * 为什么把设置全藏了：同一份配置在控制台改一半、在面板改一半，两边都会把整份配置写回
 * koishi.yml，很容易互相覆盖（用户实际遇到过「面板里关了、控制台一保存又回来了」）。
 * 现在控制台不再提供编辑入口，只留这块说明。
 *
 * 注意：**隐藏不等于删除** —— 字段仍然在 schema 里声明着，所以在控制台里点保存
 * 一样会把已有值带上，面板里的设置不会被清空。
 */
const WEBUI_GUIDE = [
  '两种改法都行，改哪边都生效，改完记得点保存。',
  '',
  '一、就在这个页面改：下面的设置项都在，常用的有「是否发解析面板」「画质档体积上限」「超长图自动切片」「在线播放器」「错误上报」等。',
  '',
  '二、用配置面板改：打开 Koishi 控制台后，左侧边栏有一个「kkk 配置」入口（**只能从这里进**，直接访问 /kkk 是打不开的）。',
  '面板界面更直观，接口库、抖音、哔哩哔哩、快手、小红书、推送列表都在里面，改完点右下角保存，不用重启 Koishi。',
  '',
  '两边的说明和默认值都是同一份，不会出现「面板里有、控制台里没有」。' +
  '面板是免登录页面，所以「主人账号」只能在控制台或 koishi.yml 里改。'
].join('\n')

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    webuiGuide: Schema.const('').description(WEBUI_GUIDE),
    /**
     * 常用设置（面板 / 切片 / 在线播放器 / 错误上报）。
     *
     * 这里**不做嵌套分组**：Koishi 的插件配置表单是按 schema 的形状渲染的，
     * 想在里面再分小节就得把值也改成嵌套结构 —— 而面板（/kkk）写回 koishi.yml 用的是扁平结构，
     * 两边一旦不一致，控制台一保存就会把这些设置丢回默认值。
     * 所以保持扁平，靠「字段顺序 + 每条说人话的说明」来保证可读性。
     */
    qq: buildQqSchema(Schema).description('常用设置：面板、切片、在线播放器、错误上报'),
    advanced: Schema.object({
      masters: Schema.array(Schema.string()).default([])
        .description('主人账号，填用户 ID（不是 QQ 号），例如 123456789。可以收到报错通知，也能执行只有主人能用的指令'),
      dataPath: Schema.string().default('data')
        .description('数据目录：配置、数据库、临时文件都放在这里。改完要重启 Koishi'),
      debug: Schema.boolean().default(false)
        .description('在日志里输出调试信息。排查问题时才需要打开，平时会很吵'),
      autoParse: Schema.boolean().default(true)
        .description('群里有人发链接（或者回复一条带链接的消息）就自动解析，不用打指令'),
      webUiAuth: Schema.boolean().default(true)
        .description('配置面板的数据接口是否额外要求先登录 Koishi 控制台。面板**页面本身**无论这里怎么设都只能从控制台侧边栏进（直接访问 /kkk 一律 404）；装了 auth 插件的部署建议保持打开，没装 auth 插件时这里不生效'),
    }).description('Koishi 原生设置（一般不用改）'),
  }),
  Schema.object({
    /**
     * 合并转发（两级开关）：值写回 config.json 的 app.fakeForward / app.forwardContent / <平台>.forward。
     * 面板里也有同一组开关（见 scripts/patch-webui.mjs），改哪边都行，两边读的是同一份配置。
     */
    forward: Schema.object({
      global: Schema.boolean().default(false)
        .description('全局合并转发。打开后所有平台都把一次解析的内容合成一条聊天记录发出；关着时下面各平台的开关才起作用。默认关闭'),
      globalContent: Schema.array(Schema.union(['text', 'image', 'video', 'file', 'chart', 'commentPic'])).default([])
        .description('全局合并转发里放哪些内容：text 文字 / image 图片 / video 视频 / file 文件 / chart 流程图（B站互动视频的剧情图）/ commentPic 评论区图片。没勾的单独直发，留空等于只放文字和图片。视频体积大时有些适配器（比如 NapCat）会拒绝整个聊天记录，这时会自动改成单独发送，不会丢内容'),
      douyin: Schema.boolean().default(false).description('抖音：单独打开合并转发（全局关着时才起作用）'),
      douyinContent: Schema.array(Schema.union(['text', 'image', 'video', 'file', 'commentPic'])).default([])
        .description('抖音合并转发里放哪些内容，commentPic 是评论区里用户贴的图（只有打开抖音的「是否收集评论区的图片」时才有这一路）。留空表示用全局那一份'),
      bilibili: Schema.boolean().default(false).description('B站：单独打开合并转发（全局关着时才起作用）'),
      bilibiliContent: Schema.array(Schema.union(['text', 'image', 'video', 'file', 'chart', 'commentPic'])).default([])
        .description('B站合并转发里放哪些内容：chart 是互动视频的剧情流程图（只有 B站有），commentPic 是评论区里用户贴的图（只有打开 B站的「是否收集评论区的图片」时才有这一路）。留空表示用全局那一份'),
      kuaishou: Schema.boolean().default(false).description('快手：单独打开合并转发（全局关着时才起作用）'),
      kuaishouContent: Schema.array(Schema.union(['text', 'image', 'video', 'file', 'commentPic'])).default([])
        .description('快手合并转发里放哪些内容，commentPic 是评论区里用户贴的图。留空表示用全局那一份'),
      xiaohongshu: Schema.boolean().default(false).description('小红书：单独打开合并转发（全局关着时才起作用）'),
      xiaohongshuContent: Schema.array(Schema.union(['text', 'image', 'video', 'file', 'commentPic'])).default([])
        .description('小红书合并转发里放哪些内容，commentPic 是评论区里用户贴的图。留空表示用全局那一份')
    }).description('合并转发：把一次解析的内容合成一条聊天记录发出'),
    upstream: buildUpstreamSchema(pluginRootDir).description(
      '插件配置：接口库（Cookie / 代理 / API 服务）、抖音 / B站 / 快手 / 小红书 的解析与推送、推送订阅列表。'
      + '每项都带默认值，枚举型是下拉框；和默认值不同的项会写回 config.json，保持默认值的不写（这样你直接改文件的内容不会被覆盖）'
    )
  })
])

export const usage = `
## 配置

本插件的设置都在 **配置面板** 里改：Koishi 控制台左侧边栏 →「**kkk 配置**」。

面板里按平台分好类：接口库 / 通用 / 抖音 / 哔哩哔哩 / 快手 / 小红书 / **QQ 适配器** / 推送列表，
改完点右下角保存即可，立即生效、不用重启。

> 面板里能改的都在面板里改；**面板没有的项**（例如「合并转发」的全局 / 各平台开关与合并内容）
> 在本配置页的「**合并转发**」分组里改，改完写回 config.json。其余上游项仍隐藏在文件里维护。

## 指令

指令前缀按你的 Koishi 配置来，默认直接写命令名即可：

| 指令 | 作用 |
| --- | --- |
| \`解析 <链接>\` / \`kkk解析\` | 解析作品（QQ 上先出交互面板） |
| \`弹幕解析 <链接>\` | 带弹幕解析：开了「在线播放器」就是在网页里看，否则是烧进视频 |
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

## 弹幕烧录

两个开关都在配置面板里，默认状态是「不烧弹幕」：

- **通用 → 强制不烧录弹幕**（默认开启）：总开关。开着时不管是指令、面板还是平台配置，
  都不会烧录弹幕，一律按纯视频解析 —— 优先级最高。要用弹幕就先把这一项关掉。
- **QQ 适配器 → 面板显示「烧录弹幕」列**（默认关闭）：打开后，QQ 里的解析面板会从
  「清晰度 / 大小」两列变成「清晰度 / 烧录弹幕 / 大小」三列，用户可以自己选一档带弹幕解析。

关掉总开关之后，也可以直接用 \`弹幕解析 <链接>\` 指令走弹幕解析。不过默认是被**在线播放器**接管的
（在网页里看，不烧进画面）；想要原来那套烧录，得把下面的「在线播放器」也关掉。
烧录需要机器上装了 ffmpeg，没有的话会提示一句并退回纯视频。

## 在线播放器（弹幕在线看）

通用 → **在线播放器设置** 里的五项：

- **弹幕重定向在线播放器**（默认开）：总开关。开着时，解析面板里那一列按钮就写「**弹幕**」
  （不再是「烧录弹幕」），点它是**在线播放**：机器人把视频下下来放进播放器目录，
  回一条链接，点开就是带弹幕的播放页 —— 不烧录（不需要 ffmpeg）、也不占群文件。
  **开着它，面板上就有「弹幕」这一列**（不需要再去 QQ 适配器里开「面板显示烧录弹幕列」，
  那个开关只在下面的烧录模式里生效）。
  **这一项要先关掉上面的「强制不烧录弹幕」（也就是打开弹幕功能）才能改**，否则在面板里是灰的；
  下面四项随时都能改。
- **播放器公网地址**：**你自己的公网地址，插件猜不出来，必须由你填。**例如
  \`https://play.example.com\`，用户收到的链接就是它加上 \`/kkk/player/<令牌>\`。
  留空**照样能用**，但链接会退化成「\`http://本机 IP:端口\`」，**只有本机 / 内网能打开** ——
  这时日志里会警告一次，机器人回复和播放页上也会带一句「未配置公网地址，仅本机可访问」，
  免得用户以为插件坏了。公网部署请把 Nginx / Caddy 之类的反向代理指向播放器端口，这里填域名。
- **播放器端口**：0（默认）= 复用 Koishi 自己的端口；填别的值会用 node:http 另起一个服务，
  端口被占用时只记一条日志并退回 Koishi 端口，不影响解析。
  **别填浏览器禁止访问的端口**（例如 6665-6669 这些 IRC 段）：那种链接在浏览器里会直接
  \`ERR_UNSAFE_PORT\`；真填了、又没配公网地址时，插件会自动退回 Koishi 端口并打日志说明。
- **链接有效期（分钟）**：默认 60（1~1440）。到点自动删掉视频和弹幕，链接打开是「链接已过期」。
- **在线播放最大文件（MB）**：超过这个体积的视频**不走在线播放**，改回原来的发送流程
  （免得把机器磁盘塞满）。留空 / 填 0 = 跟随全局，用上游的「文件大小限制」（usefilelimit / filelimit）；
  全局没开限制就是不限制。**这条上限对「超限转在线播放」一样有效** ——
  开了转播也不会突破它，超限的视频照旧按原来的方式处理。
  判定发生在**把文件搬进播放器目录之前**，所以超限的视频一点都不会占到播放器目录。
- **超限转在线播放**（默认关）：打开后，体积超过全局「文件大小限制」的视频不再被拒绝
  （原来只回一句「视频太大了，还是去B站看吧」），而是照常下载并改成在线播放 ——
  用户拿到一条播放链接，视频不发群、也不占群文件。前提是体积不超过上面的
  「在线播放最大文件」（超了还是拒绝，免得把机器磁盘塞满）。

播放页是自带的单文件页面（**照B站播放页做的夜间风格**：封面 + 标题 + 数据行 + 弹幕控制条 +
  操作按钮排；手机上控件也放得开），有**弹幕开关 / 字号 / 透明度 / 显示区域**几个控件，
弹幕用 canvas 自己画，拖动进度条靠服务端的 HTTP Range 支持，页面不依赖任何外网 CDN。

关掉总开关（手动把「在线播放器」关掉）后一切照旧：面板列写「烧录弹幕」，走原来的 ffmpeg 烧录流程。
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

const PERM_KEYWORDS = ['all', 'admin', 'master', 'group.owner', 'group.admin']

/**
 * 权限判断。
 *
 * 除了 `all` / `admin` / `master` 这些关键字，还允许：
 *   - `*`：等同 all（谁都可以）
 *   - 直接写账号：`123456` 或 `123456, 234567`（多个用逗号 / 空格分隔）
 *     —— 配置里写具体**用户 ID**（Koishi 的 session.userId，不是 QQ 号）时，只有这些账号能用该功能。
 */
function checkPermission (session: any, perm?: string | string[]): boolean {
  if (!perm) return true
  const tokens = (Array.isArray(perm) ? perm : String(perm).split(/[,，\s]+/))
    .map((item: any) => String(item).trim())
    .filter(Boolean)
  if (tokens.length === 0) return true
  if (tokens.includes('*') || tokens.includes('all')) return true

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

  // 直接写账号：命中就用
  const ids = tokens.filter((token: string) => !PERM_KEYWORDS.includes(token))
  if (ids.includes(String(session.userId))) return true
  if (ids.length > 0 && !tokens.some((token: string) => PERM_KEYWORDS.includes(token))) return false

  if (tokens.includes('master')) return isMaster

  if (tokens.includes('admin')) {
    // Koishi 这边 admin 指「权限等级 4 及以上」
    if (isMaster) return true
    if (authority >= 4) return true
    const roles: string[] = session.author?.roles ?? []
    if (roles.includes('owner') || roles.includes('admin') || roles.includes('administrator')) return true
    return false
  }

  // group.owner / group.admin 走角色判断
  const roles: string[] = session.author?.roles ?? []
  if (tokens.includes('group.owner') && roles.includes('owner')) return true
  if (tokens.includes('group.admin') && (roles.includes('admin') || roles.includes('administrator'))) return true

  return false
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
  弹幕解析: '解析链接并把弹幕烧录进视频（机器上没有 ffmpeg 时会退化成纯视频）',
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

/* ------------------------------------------------------------------ *
 * 指令分组
 * ------------------------------------------------------------------ */

/**
 * 所有指令挂到的父指令名 —— 控制台「指令」页里就是一个 `kkk` 分组。
 *
 * Koishi 的指令树是**靠名字里的 `.` 分词**的（见 `@koishijs/core` 的 `ctx.command()`）：
 * `ctx.command('kkk.帮助')` 会顺手建出父指令 `kkk`，并让 `帮助` 成为它的子指令。
 * 控制台就是靠这层父子关系分组的 —— 而且 `Command.toJSON()` 只把**名字里带 `.`**
 * 的子指令收进 `children`，所以「只把 `parent` 指过去、名字还是 `kkk帮助`」是没用的，
 * 名字必须真的写成 `kkk.xxx`。
 */
const COMMAND_GROUP = 'kkk'

/**
 * 指令在分组下的显示名：去掉前导的 `kkk`。
 *
 * `kkk帮助` → `帮助`、`kkkB站登录` → `B站登录`、`kkk解析统计` → `解析统计`。
 * 这样控制台里看到的是 `kkk/帮助` 而不是 `kkk/kkk帮助`。
 * 去掉后为空（指令名就叫 `kkk`）时退回原名，免得建出一个没有名字的子指令。
 */
function groupChildName (name: string): string {
  return name.replace(/^kkk/i, '') || name
}

/**
 * 把「走 Koishi 指令树」的写法还原成 karin 注册表认的指令名。
 *
 * 分组之后 `kkk.帮助` / `kkk 帮助` 也能触发指令，但移植过来的业务代码是按
 * `e.msg.replace(/^#kkk帮助/, '')` 这种**裸指令名**写的，所以这里把
 * `kkk` + 分隔符（空格 / 点 / 全角空格）换成这条指令真正的 karin 名再往下传。
 *
 * 不处理 `/` 分隔：`ctx.command('kkk/帮助')` 建出来的子指令名字里没有 `.`，
 * 既进不了控制台的指令树、也不是用户会敲的写法。
 *
 * @param content 已经去掉 Koishi 前缀的消息正文
 * @param child 分组下的显示名（`帮助`）
 * @param canonical 该指令在 karin 注册表里的名字（`kkk帮助`）
 */
function unwrapGroupedCommand (content: string, child: string, canonical: string): string {
  const lowered = content.toLowerCase()
  const childLower = child.toLowerCase()
  // 裸写显示名（`帮助`）—— 大多是解析类指令，`解析 <链接>` 原样通过
  if (lowered.startsWith(childLower)) return canonical + content.slice(child.length)
  for (const separator of [' ', '.', '　']) {
    const head = COMMAND_GROUP + separator
    if (lowered.startsWith(head) && lowered.slice(head.length).startsWith(childLower)) {
      return canonical + content.slice(head.length + child.length)
    }
  }
  return content
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

/**
 * 命令重放入口（由 `registerCommands` 造好后挂上来）。
 *
 * 它建立在命令注册表之上，而注册表是 `registerCommands` 的局部变量，
 * 外面（比如 `apply` 里调 `bindRuntime`）根本拿不到 —— 先存在这里，
 * 表情面板选完画质要靠它把「选择」变成一次真正的解析（见 karin/module/utils/ReactionPanel.ts）。
 */
let replayCommand: ((session: any, text: string) => Promise<boolean>) | null = null

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
    } finally {
      /**
       * 兜底清理解析阶段（「下载进度」读的那条状态）。
       *
       * 正常情况下每个阶段结束自己会清（withDownloadStage / uploadFile / publishOnlinePlayer），
       * 但解析可能在任何一步提前返回（图集作品、体积超限、用户没要视频…），
       * 这里统一兜一层，保证「下载进度」不会一直卡在「正在获取下载链接」。
       */
      try {
        const { clearParseStage } = require('./karin/module/utils/Network/Downloader')
        clearParseStage()
      } catch { /* 观测失败不影响解析 */ }
    }
    return !continued
  }

  // 1) 注册成真正的 Koishi 指令 —— **全部挂在 `kkk` 分组下**
  //
  // 一个 karin 注册能推导出好几个名字（`/^#?(解析|kkk解析|弹幕解析)/` → 3 个），
  // 这些名字共用同一个 handler，所以在 Koishi 这边也合成**一条**指令：
  // 显示名取「去掉前导 kkk」的那个（`解析`），其余名字挂成别名（`kkk解析`）。
  // 于是 `解析` / `kkk解析` / `kkk.解析` / `kkk 解析` 四种写法都能用，
  // 而控制台里只看到一个 `kkk/解析`。
  const registered = new Set<string>()
  /**
   * 分组下的显示名 → 已经建好的指令。
   * 同一次注册的第二个名字（`kkk解析` 之于 `解析`）只会给它补个别名，不再建一条指令。
   */
  const groupedCommands = new Map<string, {
    command: any
    registration: typeof typedRegistrations[number]
    /** 已经挂过的别名（小写）—— `Command.alias()` 撞名会抛，这里先自己拦一道 */
    aliases: Set<string>
  }>()

  // 父指令：控制台里的分组节点。先建出来，好把说明写上（自动创建的话说明是空的）
  const group = ctx.command(COMMAND_GROUP, 'koishi-plugin-kkk 全部指令（展开看子指令）')

  /**
   * 挂别名，但**不让撞名把整个 apply 拖死**。
   *
   * `Command.alias()` 撞到别的指令会抛 `duplicate command names`。正常升级路径上
   * 旧指令会先被 dispose 掉，撞不上；但「插件热重载 / 控制台点重载」的时序偶尔会让
   * 上一个实例的指令还在表里 —— 那种情况下宁可少一个别名（重启就好了），
   * 也不能让 apply 抛出去：apply 一挂，指令和控制台路由全都上不去。
   */
  const safeAlias = (command: any, alias: string) => {
    try {
      command.alias(alias)
    } catch (error: any) {
      logger.warn('指令别名 %s 已被占用，本次跳过（重启宿主即可恢复）：%s', alias, error?.message ?? error)
    }
  }

  for (const registration of typedRegistrations) {
    const names = commandNames(registration.reg)
    if (!names.length) {
      logger.debug('推导不出指令名，只保留 # 写法: %s', String(registration.reg))
      continue
    }
    for (const name of names) {
      const child = groupChildName(name)
      const existing = groupedCommands.get(child)
      if (existing) {
        // 同一个注册的另一个名字（`kkk解析` 之于 `解析`）→ 只挂别名，不再建一条指令
        const key = name.toLowerCase()
        if (existing.registration === registration && !existing.aliases.has(key)) {
          existing.aliases.add(key)
          safeAlias(existing.command, name)
        }
        registered.add(name)
        continue
      }

      /**
       * 指令说明按「当前是不是播放器模式」动态取：开着在线播放器时，
       * 「弹幕解析」不再是「把弹幕烧进视频」，控制台里显示的用法也得跟着改。
       */
      const description = (name === '弹幕解析' && isOnlinePlayerEnabled())
        ? '解析链接并在网页上带弹幕在线播放（弹幕不烧进视频）'
        : (COMMAND_DESCRIPTIONS[name] ?? ('koishi-plugin-kkk: ' + (registration.options?.name ?? name)))
      // 解析类指令接一段自由文本（链接 / BV 号 / 参数），声明出来控制台里能看清用法；
      // Koishi 的 checkArgCount / checkUnknown 默认都是关的，多传也不会报错
      const parseCommand = name === '解析' || name === '弹幕解析' || name === 'kkk解析'
      const command = ctx.command(parseCommand ? COMMAND_GROUP + '.' + child + ' [input:text]' : COMMAND_GROUP + '.' + child, description)
      /**
       * **老写法必须原样可用** —— 用户习惯、QQ 按钮里的指令文本、「下载进度」按钮
       * 都不带分组前缀，改成正名会一次性全断掉。所以两套都挂成别名：
       *   - 分组下的显示名 `解析`（去掉前导 kkk 的那个）
       *   - karin 注册表里的原名 `kkk解析` / `kkkB站登录`
       */
      const aliases = new Set<string>()
      for (const alias of child === name ? [child] : [child, name]) {
        const key = alias.toLowerCase()
        if (aliases.has(key)) continue
        aliases.add(key)
        safeAlias(command, alias)
      }
      /**
       * 面板按钮发过来的是「解析 <链接> --qn=80」这类文本，声明一下选项免得被当成参数报错。
       *
       * **只挂一次**：插件被热重载时（改配置 / 控制台点重载 / 迁移旧配置触发的 scope.update）
       * apply 会再跑一遍，而 `ctx.command()` 拿到的是**同一个指令对象** ——
       * 再 `.option('qn', …)` 一次就会抛 `duplicate option name "qn" for command "解析"`，
       * 整个 apply 跟着失败：指令没注册上、控制台 /kkk 路由也挂不上
       * （线上表现就是「改完配置机器人不理人，控制台面板 404」）。
       * 记号直接挂在指令对象上，重载后依然是同一个对象，天然幂等。
       */
      const PARSE_OPTIONS_READY = Symbol.for('koishi-plugin-kkk/parse-options')
      if (parseCommand && !(command as any)[PARSE_OPTIONS_READY]) {
        ;(command as any)[PARSE_OPTIONS_READY] = true
        command
          .option('qn', '--qn <qn:number> B站画质 qn')
          .option('q', '--q <quality:string> 抖音/小红书画质档位')
          .option('dm', '--dm <value:string> ' + (isOnlinePlayerEnabled() ? '带弹幕（在线播放）' : '烧录弹幕'))
          .option('panel', '--panel <mode:number> 只重发解析面板')
          .option('bgp', '--bgp <page:number> 番剧分集表格翻页')
      }
      command.action(async ({ session }) => {
        if (!session) return
        // karin 的代码都假设 e.msg 以 # 开头，这里把 Koishi 前缀换回 #（见函数注释）；
        // `kkk.帮助` / `kkk 帮助` 这种分组写法也顺带还原成 karin 认的指令名
        const bare = unwrapGroupedCommand(stripCommandPrefix(session.content ?? ''), child, name)
        const consumed = await runRegistration(registration, session, '#' + bare)
        /**
         * 消费掉的消息要返回一个**非空值**：Koishi 的 \`Command.execute\` 在 action 返回空值时会
         * 继续跑后面的队列（也就是把消息交回中间件链），那条链上的链接自动解析会**再解析一次** ——
         * 表现就是「检测到链接，开始解析」出现两次、第二次还失败。
         */
        // 注意：Koishi 的实现是「返回值是真值就 send 出去」，所以这里只能返回空串：
        // 空串能截断后续中间件，又不会被当成消息发出去（返回 true 会真的回一个「true」）
        return consumed ? EMPTY_RESULT : undefined
      })

      groupedCommands.set(child, { command, registration, aliases })
      registered.add(name)
      registered.add(child)
      registered.add(COMMAND_GROUP + '.' + child)
    }
    logger.debug('注册指令 %s ← %s', names.join(' / '), String(registration.reg))
  }
  // 让「链接自动解析」认得 `kkk …` / `kkk.xxx` 这种分组写法（不然会被当成普通消息再解析一遍）
  if (groupedCommands.size) registered.add(COMMAND_GROUP)

  /**
   * 「下载进度」：面板上的 📊 按钮点一下就发它。
   * 解析大文件时群里只有一句「收到请求，开始下载」，有这个按钮就能随时看进度。
   *
   * **两条路都要接**：
   *   - Koishi 指令（`下载进度` / `kkk.下载进度`，见下面的注册）；
   *   - QQ 回调按钮（`interaction/button` 的 data 走文本兜底，见 `runTextCommand`）——
   *     它不是 karin 注册表里的指令，所以得单独认一下，否则点了没反应。
   * @param session 会话（用 `session.send` 回话）
   */
  const showDownloadProgress = async (session: any) => {
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
  }

  if (!groupedCommands.has('下载进度')) {
    groupedCommands.set('下载进度', {
      command: null, registration: null as any, aliases: new Set(['下载进度'])
    })
    registered.add('下载进度')
    registered.add(COMMAND_GROUP + '.下载进度')
    const progressCommand = ctx.command(COMMAND_GROUP + '.下载进度', '查看当前解析下载进度')
    safeAlias(progressCommand, '下载进度')
    progressCommand.action(async ({ session }) => {
      await showDownloadProgress(session)
      return EMPTY_RESULT
    })
  }

  /**
   * 父指令 `kkk` 自己：只敲 `kkk` 时列出子指令，免得对着一个空分组发愣。
   * 子指令照常优先（Koishi 会把 `kkk 帮助` 解析成 `kkk.帮助`）。
   *
   * 放在最后才挂 action —— 闭包读的是**实时**的子指令表，`下载进度` 也是这时候才进去的。
   */
  if (groupedCommands.size) {
    group.action(async ({ session }) => {
      const lines = [...groupedCommands.keys()].map((name) => '· ' + name)
      await session?.send('🧩 kkk 指令（也可以直接敲「帮助」看用法）\n' + lines.join('\n'))
      return EMPTY_RESULT
    })
  }

  // 日志放在最后报，这样 `下载进度` 也算进去（它是在中间那段才补进来的）
  if (groupedCommands.size) {
    logger.info('已注册 Koishi 指令 %d 条（挂在 %s 分组下，全部以 %s. 开头）：%s',
      groupedCommands.size, COMMAND_GROUP, COMMAND_GROUP, [...groupedCommands.keys()].join(' '))
  }

  /**
   * 按 karin 的注册表跑一条「文本命令」。
   * 旧的 \`#\` 写法和 QQ 的按钮交互事件都走这里 —— 它们都绕过了 Koishi 的指令解析。
   * @returns 是否已消费这条消息
   */
  const runTextCommand = async (session: any, text: string): Promise<boolean> => {
    /**
     * 「下载进度」不是 karin 注册表里的指令（它只在 Koishi 这边注册过），
     * 面板上那个 📊 按钮走的是回调（`interaction/button` → 文本兜底），
     * 不在这儿认一下的话点了完全没反应。放最前面，免得以后有人加个宽正则把它吃掉。
     */
    if (/^#?(kkk)?\s*下载进度\s*$/.test(text)) {
      await showDownloadProgress(session)
      return true
    }
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
  /**
   * 挂到模块级：命令注册表是这里的局部变量，`apply` 里的 `bindRuntime` 拿不到它，
   * 而 OneBot 的表情面板选完画质后要靠这个函数把选择变成一次真正的解析。
   */
  replayCommand = runTextCommand

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
        /**
         * **同一条卡片消息被投递多遍时，只处理第一遍**。
         *
         * 线上实测：同一条 B站卡片会在几秒内进来两次（平台重投 / 另一个中间件再发一遍），
         * 于是 OCR + 搜索各跑两遍、面板也可能发两条 —— 用户看到的就是「解析完了又解析一遍」。
         *
         * 去重键里的卡片正文要**先去掉 URL 的签名参数**：同一条卡片重投时图片链接会被重新签名，
         * 直接拿原文哈希会认为是两条不同的消息（踩过这个坑，第二次照样 OCR）。
         */
        const cardSignature = raw
          .replace(/https?:\/\/[^\s"'<>]+/g, (url: string) => url.split("?")[0])
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 2000)
        /**
         * 打一条「收到卡片」的日志（debug 级，排查重复投递用）。
         *
         * 同一条卡片连着来两次、而 **messageId 也相同** → 这条事件被重复投递/重复处理；
         * messageId 不同 → 平台那边确实又发了一条。排查「到底谁重复了」就看它。
         */
        logger.debug('收到卡片消息（messageId=%s，平台=%s）',
          String((session as any).messageId ?? '无'),
          String((session as any).platform ?? '未知'))
        const { acquireParseLock } = await import("./karin/module/utils/ParseLock")
        const cardKey = ["card", String((session as any).platform ?? ""), String((session as any).channelId ?? ""), String((session as any).userId ?? ""), cardSignature].join(":")
        if (!acquireParseLock(cardKey)) {
          logger.debug("短时间内重复的同一条卡片消息，已忽略（不再重复 OCR/搜索）: %s", cardKey.slice(0, 120))
          return
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
          const top = resolved.candidates.slice(0, 6)
          const tip = '没能唯一确定这个作品（识别到：' + ((resolved.upName) || '未知') + '），下面是候选：'
          const linkOf = (item: any) => item.platform === 'bilibili'
            ? 'https://www.bilibili.com/video/' + item.id
            : 'https://www.douyin.com/video/' + item.id
          /**
           * **按平台分成两种发法**。
           *
           * QQ 官方机器人认 markdown，候选直接排成表格、操作列是按钮，点一下就走解析（最省事）。
           * 个人号（OneBot / NapCat）**不渲染 markdown**：实测这条候选消息发过去整条都发不出来 ——
           * 用户只看到「正在提取卡片信息…」然后再无音讯，六个候选白搜。那边改成纯文本 + 完整链接，
           * QQ 客户端会把裸链接变成可点的蓝色链接，复制粘贴也方便。
           */
          const officialQq = /^qq/i.test(String((session as any).platform ?? ''))
          if (officialQq) {
            const { cmdInput } = await import('./karin/module/utils/QqPanel')
            const table = ['| # | 标题 | UP / 作者 | 操作 |', '| :---: | :--- | :--- | :---: |']
            top.forEach((item: any, index: number) => {
              const title = String(item.title || '（无标题）').replace(/[|\n]/g, ' ').slice(0, 26)
              const author = String(item.author || '-').replace(/[|\n]/g, ' ').slice(0, 12)
              table.push('| ' + (index + 1) + ' | ' + title + ' | ' + author + ' | ' + cmdInput('解析 ' + linkOf(item), '解析') + ' |')
            })
            await send([{ type: 'markdown', attrs: { content: tip + '点按钮直接解析' + String.fromCharCode(10) + table.join(String.fromCharCode(10)) } }])
            return
          }
          const lines = [tip]
          top.forEach((item: any, index: number) => {
            const title = String(item.title || '（无标题）').replace(/\s+/g, ' ').slice(0, 40)
            const author = String(item.author || '-').replace(/\s+/g, ' ').slice(0, 16)
            lines.push((index + 1) + '. ' + title + ' —— ' + author)
            lines.push(linkOf(item))
          })
          lines.push('把想看的那个链接发给我就能解析。')
          await send(lines.join(String.fromCharCode(10)))
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

/**
 * 合并转发内容可选项（与 ParseForward 里的 FORWARD_KINDS 保持一致）。
 *
 * 注意这里**不再有** audio / markdown：QQ 的聊天记录不支持语音气泡，markdown 只有官方 bot 认、
 * 而官方适配器没有合并转发能力 —— 留着它们只会让人配了不生效（见 ParseForward 的说明）。
 * chart 是 B站互动视频的剧情流程图；commentPic 是评论区里用户贴的那些图
 * （它默认**不进**聊天记录：评论长图里已经画过一遍，再收一份就是同一批图发两遍）。
 */
const FORWARD_KIND_VALUES = ['text', 'image', 'video', 'file', 'chart', 'commentPic']
/** 平台名 → 上游配置段名 */
const FORWARD_PLATFORMS = ['douyin', 'bilibili', 'kuaishou', 'xiaohongshu']

/**
 * 把控制台「合并转发」分组翻译成上游 config.json 的补丁。
 *
 * 只翻译**显式填过**的项：布尔值必须真的是 boolean（表单没碰时是默认 false，
 * 与上游默认值相同，configBridge 会当作「没填」跳过），数组为空则跳过。
 * @param group 控制台里的 \`forward\` 分组
 * @returns 可以直接交给 applyUpstreamOverrides 的补丁；没有内容时返回 undefined
 */
function buildForwardPatch (group: any): Record<string, any> | undefined {
  if (!group || typeof group !== 'object') return undefined
  const patch: Record<string, any> = {}
  const pickKinds = (value: any): string[] | undefined => {
    if (!Array.isArray(value)) return undefined
    const list = value.map((item) => String(item).toLowerCase()).filter((item) => FORWARD_KIND_VALUES.includes(item))
    return list.length ? list : undefined
  }

  const app: Record<string, any> = {}
  if (typeof group.global === 'boolean') app.fakeForward = group.global
  const globalKinds = pickKinds(group.globalContent)
  if (globalKinds) app.forwardContent = globalKinds
  if (Object.keys(app).length) patch.app = app

  for (const platform of FORWARD_PLATFORMS) {
    const section: Record<string, any> = {}
    if (typeof group[platform] === 'boolean') section.forward = group[platform]
    const kinds = pickKinds(group[platform + 'Content'])
    if (kinds) section.forwardContent = kinds
    if (Object.keys(section).length) patch[platform] = section
  }
  return Object.keys(patch).length ? patch : undefined
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
  const { webuiGuide: _guide, advanced, qq, forward, upstream, ...rest } = raw

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
  /**
   * **每个 qq 字段都要有值**：不能指望 Koishi 的 schema 默认值一定被填上 ——
   * 线上实测踩过（用户报「B站私聊还是发视频、没给在线播放链接」）：
   * 配置里没写过的字段，运行时读到的是 `undefined`，
   * 于是「强制在线播放的适配器」（默认 bilibili）整个失效、面板列按钮的开关也失效。
   *
   * 所以这里用 `readQqOptions` 先铺一层**字段表里的默认值**（qqFields.json 是唯一出处），
   * 再用用户显式配的值覆盖 —— 显式配置永远优先，缺的字段一律有默认。
   */
  const groupQq: any = { ...readQqOptions(raw as any), ...(qq ?? {}) }
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
    /**
     * 表情面板（OneBot）选完画质后靠它把「选择」变成一次真正的解析。
     *
     * 必须在这里传进去而不是让 ReactionPanel 自己 import：这个函数依赖命令注册表（局部在
     * `registerCommands` 里），走别的路会拿到空注册表 —— 所以由那里赋值出来的 `replayCommand` 转交。
     */
    runCommand: (session: any, text: string) =>
      replayCommand ? replayCommand(session, text) : Promise.resolve(false),
    /**
     * ⚠️ 这份 config **不是**原封不动转发，而是运行时真正读的那一份（`tryGetRuntime().config`）。
     *
     * 以前它是一个**手写白名单** —— 于是每加一个新开关（例如「强制在线播放的适配器」
     * `forceOnlinePlayer`），忘了往这里补一行，运行时就读到 undefined，功能整个静默失效：
     * 线上真实故障就是「B站私聊该给在线播放链接，结果还是去发视频文件」。
     *
     * 现在改成 `...readQqOptions(config)` 打底（qqFields.json 里的字段一个不落，缺的用默认值），
     * 下面那些需要**归一化**的字段（端口取整数、分钟数夹范围、布尔用 !== false 这种）再覆盖上去。
     */
    config: {
      ...readQqOptions(config),
      masters: config.masters ?? [],
      debug: config.debug,
      dataPath: config.dataPath,
      qqPanel: config.qqPanel !== false,
      qqFileLimitMB: Number(config.qqFileLimitMB) || 200,
      qqPanelDanmaku: config.qqPanelDanmaku === true,
      qqPanelSourceLink: (config as any).qqPanelSourceLink !== false,
      forceNoDanmaku: (config as any).forceNoDanmaku !== false,
      // 在线播放器（通用 → 在线播放器设置）：**默认开启**（和「打开原站」那个开关一样）。
      // 老配置里没有这个键时也必须是开的，所以判据写成 !== false。
      playerEnabled: (config as any).playerEnabled !== false,
      playerBaseUrl: String((config as any).playerBaseUrl ?? ''),
      // 人机验证页的公网地址（留空 → 退化成本机 IP + Koishi 端口，并打一次警告）
      verifyBaseUrl: String((config as any).verifyBaseUrl ?? ''),
      playerPort: (() => {
        const raw = (config as any).playerPort
        const num = Number(raw)
        return Number.isFinite(num) && num > 0 && num < 65536 ? Math.floor(num) : 0
      })(),
      playerExpireMinutes: (() => {
        const raw = (config as any).playerExpireMinutes
        // 空值（undefined / null / ''）走默认 60 分钟，别被 Number('') 变成 0 再夹成 1 分钟
        if (raw === undefined || raw === null || raw === '') return 60
        const num = Number(raw)
        if (!Number.isFinite(num)) return 60
        return Math.min(1440, Math.max(1, Math.floor(num)))
      })(),
      playerMaxFileMB: (() => {
        // 空值 = 跟随全局（「文件大小限制」那一项），统一记成 0
        const raw = (config as any).playerMaxFileMB
        if (raw === undefined || raw === null || raw === '') return 0
        const num = Number(raw)
        return Number.isFinite(num) && num > 0 ? num : 0
      })(),
      // 超限转在线播放：默认关（要管理员显式打开才会改变「视频太大了」的行为）
      playerOnOversize: (config as any).playerOnOversize === true,
      qqGroupFileLimitMB: (() => {
        const raw = (config as any).qqGroupFileLimitMB
        if (raw === undefined || raw === null || raw === '') return 30
        const n = Number(raw)
        return Number.isFinite(n) && n >= 0 ? n : 30
      })(),
      recallPanel: config.recallPanel !== false,
      bangumiPanelCols: Number(config.bangumiPanelCols) || 5,
      bangumiPanelRows: Number(config.bangumiPanelRows) || 4
    },
    pluginRoot,
    dataRoot
  })

  fs.mkdirSync(dataRoot, { recursive: true })

  /**
   * 「合并转发」分组（控制台可见）→ config.json。
   *
   * 面板是上游打包好的 SPA，加不了字段，所以这组开关在**控制台**里改；
   * 只有用户**显式填过**的项才会写（空数组 = 没填，见 configBridge 的 isEmptyContainer），
   * 这样不会把面板/文件里已经配好的值盖掉。
   */
  const forwardPatch = buildForwardPatch(forward)
  if (forwardPatch) {
    try {
      const { changed, file } = applyUpstreamOverrides(forwardPatch)
      if (changed.length) {
        logger.info('已把控制台里的合并转发设置写入 %s（%s）', file, changed.join(', '))
      }
    } catch (error: any) {
      logger.error('写入合并转发设置失败: %s', error?.stack ?? error)
    }
  }

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

  // 初始化数据库实例（走 Koishi 原生数据库服务 ctx.database）
  // 原实现用顶层 await 立即初始化，CJS 下改成在这里显式引导，否则 module/db 导出的实例是 null
  try {
    const { bootstrapDatabases } = await import('./karin/module/db')
    const { douyinDB, bilibiliDB, statisticsDB } = await bootstrapDatabases(ctx)
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

  /**
   * 在线播放器（弹幕在线看）：按总开关决定要不要挂 /kkk/player 路由、起过期清理定时器。
   *
   * 必须放在 bindRuntime 之后 —— 播放器要读运行时配置（公网地址、端口、有效期）。
   * 开关关着时这里什么都不做，行为和以前完全一致。
   */
  const disposeOnlinePlayer = setupOnlinePlayer(ctx)
  /**
   * 人机验证页（`/kkk/geetest`）：平台风控时把验证页发给用户自己过。
   *
   * 同样必须在 bindRuntime 之后（链接要读运行时配置里的公网地址）。
   * 没有总开关 —— 挂一条路由是零成本的，等真遇到风控再发现挂不出去就晚了。
   */
  const disposeVerifyPage = setupVerifyPage(ctx)
  ctx.on('dispose', () => {
    try {
      disposeOnlinePlayer()
    } catch (error: any) {
      logger.debug('[kkk] 卸载在线播放器失败: ' + String(error?.message ?? error))
    }
    try {
      disposeVerifyPage()
    } catch (error: any) {
      logger.debug('[kkk] 卸载人机验证页失败: ' + String(error?.message ?? error))
    }
  })

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

  /**
   * OneBot 的「点表情选清晰度」：机器人往自己那条选择消息上贴一排表情，用户点一个就算选中。
   *
   * ## ⚠️ 只能按「类型」监听 —— `type/subtype` 那个事件名根本不会发
   *
   * `@satorijs/core` 的 `Bot.dispatch()` 里是：
   *
   *     let events = [session.type]
   *     for (const event of events) this.context.emit(session, event, session)
   *
   * 也就是说**只派发 `session.type` 这一个名字**（`eventAliases` 只补了 message /
   * guild 那两三条）。所以 `ctx.on('onebot/message-reactions-updated')` 永远不触发 ——
   * 这正是「点了没反应」的第一个原因。subtype 要在回调里自己看。
   *
   * ## 两边的类型都接
   *   - NapCat 的 `group_msg_emoji_like`（逐次点击上报，带 user_id / is_add / likes）
   *     在标准适配器里**没有分支** → 会话类型就是普通 `notice`；
   *   - 个别适配器把它归到 `onebot` 类型（和 `message_reactions_updated` 一样）——
   *     `koishi-plugin-adapter-napcat` 甚至把它转成标准的 `reaction-added` / `reaction-removed`。
   *
   * 这些类型都挂上，里面的形状判断交给 ReactionPanel（`handleReactionEvent`）；
   * 认不出来的形状它会**原样打出来**，拿到真实载荷再补精确映射。
   *
   * 依赖一个 OneBot 系适配器；**一个都没装时事件永远不会触发**，这里注册也无害。
   */
  const onReactionEvent = (session: any): void => {
    void import('./karin/module/utils/ReactionPanel')
      .then((module) => module.handleReactionEvent(session))
      .catch((error: any) => logger.debug('[kkk] 处理表情回应失败: %s', String(error?.message ?? error)))
  }
  ;(ctx as any).on('notice', onReactionEvent)
  ;(ctx as any).on('onebot', onReactionEvent)
  // adapter-napcat 会把 group_msg_emoji_like 转成标准名字，一并接上
  ;(ctx as any).on('reaction-added', onReactionEvent)
  ;(ctx as any).on('reaction-removed', onReactionEvent)

  /**
   * 排查用的总探针：把**每一条**入站事件的形状打出来。
   *
   * `Bot.dispatch()` 在按类型派发**之前**会无条件 `emit('internal/session', session)`
   * （`@satorijs/core` 的 `src/bot.ts:181`），所以哪怕适配器把载荷归成了我们没监听的
   * `type`，这条也照样会走。
   *
   * ## ⚠️ 但它证明不了「协议端没发」
   * `internal/session` 是在 `Bot.dispatch()` **里面**发的。`koishi-plugin-adapter-onebot`
   * 的 `adaptSession()` 对**不认识的 notice_type** 走 `default: return`，
   * 于是 `dispatchSession()` 直接 `return` —— **`dispatch()` 根本没被调用**，
   * 这里也就一行都没有。所以「没日志」不等于「协议端没发」；
   * `group_msg_emoji_like` 恰恰就是被这样丢掉的（适配器日志里能看到上报，插件侧一片空白）。
   *
   * 它真正能回答的是**载荷长什么样**：
   *   - 有、`notice_type` 是别的名字 → 照原样补一条判断即可；
   *   - 有、`notice_type` 也对，但 `message_id` 对不上 → `handleEmojiLike` 里会把
   *     「在等的是哪几条」一起打出来。
   *
   * 只在有面板等着时（或载荷长得像表情事件时）才打日志，平时不吵。
   */
  const onInboundSession = (session: any): void => {
    void import('./karin/module/utils/ReactionPanel')
      .then((module) => module.noteInboundSession(session))
      .catch((error: any) => logger.debug('[kkk] 入站事件探针失败: %s', String(error?.message ?? error)))
  }
  ;(ctx as any).on('internal/session', onInboundSession)

  /**
   * 表情面板的**文字退路**：回一个序号（1 / 2 / 3…）也能选。
   *
   * 表情事件完全看协议端脸色（NapCat 要够新、还要开着对应事件，别的实现形状还不一样）。
   * 协议端不发就永远收不到点击 —— 而面板一旦发出，**这条链接就不会再走正常解析**，
   * 用户会卡在那儿什么都拿不到。所以留一条走普通消息通道的退路：
   * **引用**面板消息回序号（谁都能这么选），或者**发链接的人**在几分钟内直接回数字。
   *
   * 注册在最后：前面的中间件不认识这种「裸数字」消息，会 `next()` 放过来。
   */
  ctx.middleware(async (session: any, next: any) => {
    try {
      const { trySelectByText } = await import('./karin/module/utils/ReactionPanel')
      if (await trySelectByText(session)) return
    } catch (error: any) {
      logger.debug('[kkk] 文字选档失败: %s', String(error?.message ?? error))
    }
    return next()
  })

  logger.info('koishi-plugin-kkk 已加载：命令 %d 个，定时任务 %d 个', commandQueue.length, taskQueue.length)
  if (!tryGetRuntime()?.ctx.bots?.length) {
    logger.debug('当前没有已连接的机器人，等待适配器上线')
  }
}
