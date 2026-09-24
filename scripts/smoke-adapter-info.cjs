/**
 * 适配器信息 / 构建信息冒烟测试。
 *
 * 两件线上被用户发现的事：
 *   1. 卡片上「当前适配器」永远是一个空的 v —— Koishi 的 Bot 根本没有 version 字段，
 *      以前读 bot.adapter.version 只会得到空串。
 *   2. 卡片上的「Built Time / Commit Hash」一直空着 —— 没有任何地方生成 lib/build-metadata.json。
 *
 * 这个测试直接跑编译产物：造一个真的（临时）适配器包，验证构造函数反查、包名兜底、
 * 实现端版本查询和构建元数据读取这几条链路。
 *
 * 用法：node scripts/smoke-adapter-info.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const pluginRoot = path.resolve(__dirname, '..')
const libRoot = path.join(pluginRoot, 'lib')

const failures = []
let passed = 0
const check = (name, condition, detail) => {
  if (condition) {
    passed++
    console.log('  ✓ ' + name)
  } else {
    failures.push(name + (detail ? ' → ' + detail : ''))
    console.log('  ✗ ' + name + (detail ? ' → ' + detail : ''))
  }
}

const noop = () => {}
/** 有些模块顶层会读运行时（配置 / 日志），先绑一个最小实现 */
const runtime = require(path.join(libRoot, 'compat', 'runtime.js'))
runtime.bindRuntime({
  ctx: {
    get: () => undefined,
    logger: () => ({ info: noop, warn: noop, error: noop, debug: noop, mark: noop }),
    bots: [],
    registry: new Map(),
    on: noop,
    middleware: noop
  },
  config: { app: {} },
  dataRoot: path.join(pluginRoot, 'data-smoke-adapter-info'),
  pluginRoot,
  master: () => []
})

/** 造一个假适配器包，require 之后它自然就进了 require.cache —— 正是反查要靠的东西 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kkk-adapter-info-'))
const fakeDir = path.join(tmpRoot, 'node_modules', 'koishi-plugin-adapter-smoke')
fs.mkdirSync(path.join(fakeDir, 'lib'), { recursive: true })
fs.writeFileSync(path.join(fakeDir, 'package.json'), JSON.stringify({ name: 'koishi-plugin-adapter-smoke', version: '9.9.9' }))
fs.writeFileSync(path.join(fakeDir, 'lib', 'index.js'), 'class SmokeAdapter {}\nmodule.exports = { Adapter: SmokeAdapter, SmokeAdapter }\n')
const fake = require(path.join(fakeDir, 'lib', 'index.js'))

const adapterInfo = require(path.join(libRoot, 'compat', 'adapter-info.js'))
const { resolveAdapterInfo, queryAdapterImplementation, cachedAdapterImplementation } = adapterInfo

console.log('== 适配器信息 ==')
const bot = {
  platform: 'smoke',
  selfId: '10001',
  status: 1,
  config: { protocol: 'ws' },
  adapter: { constructor: fake.SmokeAdapter },
  internal: {}
}
const info = resolveAdapterInfo(bot)
check('按 Adapter 构造函数反查到适配器插件版本', info.version === '9.9.9', 'version=' + info.version)
check('带上适配器包名', info.packageName === 'koishi-plugin-adapter-smoke', info.packageName)
check('通信方式按协议翻译（ws → WebSocket）', info.communication === 'WebSocket', info.communication)
check('记录机器人上线时间（connectTime > 0）', info.connectTime > 0, String(info.connectTime))
check('身份字段保持原样（name = 平台名）', info.name === 'smoke' && info.protocol === 'smoke' && info.standard === 'smoke', info.name + '/' + info.protocol)
check('友好名单独放在 displayName', info.displayName === 'smoke', info.displayName)
check('结果被缓存，重复调用不重复扫目录', resolveAdapterInfo(bot).version === '9.9.9')
check('没有实现端信息时不编造名字', cachedAdapterImplementation(bot) === undefined, String(cachedAdapterImplementation(bot)))

console.log('== 平台兜底 ==')
const onebot = resolveAdapterInfo({ platform: 'onebot', selfId: '10002', status: 1, adapter: {}, config: { protocol: 'http' } })
check('OneBot 的友好名是 OneBot', onebot.displayName === 'OneBot', onebot.displayName)
check('OneBot 的身份字段仍然是平台名（面板/合并转发靠它判断）', onebot.name === 'onebot' && onebot.protocol === 'onebot', onebot.name + '/' + onebot.protocol)
const qqguild = resolveAdapterInfo({ platform: 'qqguild', selfId: '10007', status: 1, adapter: {}, config: {} })
check('QQ 频道这类平台名不会被改成中文（includes 判断必须继续生效）', qqguild.name === 'qqguild', qqguild.name)
check('中文友好名只出现在 displayName', qqguild.displayName === 'QQ 频道', qqguild.displayName)
check('HTTP 协议翻译', onebot.communication === 'HTTP', onebot.communication)
if (onebot.version === '未知') {
  console.log('  · 跳过：这台机器没装 koishi-plugin-adapter-onebot，包名兜底无从验证')
} else {
  check('按平台名兜底找到适配器包版本', /^\d+\.\d+\.\d+/.test(onebot.version), onebot.version)
  check('兜底也能拿到包名', onebot.packageName === 'koishi-plugin-adapter-onebot', onebot.packageName)
}

console.log('== 离线机器人 ==')
const offline = resolveAdapterInfo({ platform: 'onebot', selfId: '10003', status: 0, adapter: {}, config: {} })
check('离线时 connectTime 是 0（不编造上线时间）', offline.connectTime === 0, String(offline.connectTime))

console.log('== 构建信息 ==')
const buildMetadata = require(path.join(libRoot, 'karin', 'module', 'utils', 'build-metadata.js'))
const pkg = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'))
const meta = buildMetadata.getBuildMetadata()
check('lib/build-metadata.json 存在', fs.existsSync(path.join(libRoot, 'build-metadata.json')))
check('构建信息不为空（旧安装包也会退回 package.json）', !!meta)
check('构建信息版本与 package.json 一致', meta.version === pkg.version, meta.version + ' vs ' + pkg.version)
check('构建信息带 commit', /^[0-9a-f]{7,}$/.test(meta.shortCommitHash), meta.shortCommitHash)
check('构建时间能格式化', buildMetadata.formatBuildTime(meta.buildTime).length > 0, buildMetadata.formatBuildTime(meta.buildTime))
check('空构建时间不会被格式化成 NaN', buildMetadata.formatBuildTime('') === '', buildMetadata.formatBuildTime(''))

const main = async () => {
  console.log('== 实现端版本（OneBot get_version_info）==')
  const napcat = await queryAdapterImplementation({
    platform: 'onebot',
    selfId: '10004',
    internal: { get_version_info: async () => ({ app_name: 'NapCat', app_version: '4.8.1', protocol_version: 'v11' }) }
  })
  check('问到实现端名字与版本', napcat && napcat.name === 'NapCat' && napcat.version === '4.8.1', JSON.stringify(napcat))
  const enriched = resolveAdapterInfo({
    platform: 'onebot',
    selfId: '10004',
    status: 1,
    adapter: {},
    config: {}
  })
  check('实现端信息优先展示在卡片上（displayName）', enriched.displayName === 'NapCat' && enriched.version === '4.8.1', enriched.displayName + ' v' + enriched.version)
  check('实现端信息不覆盖平台身份字段', enriched.name === 'onebot', enriched.name)
  const noApi = await queryAdapterImplementation({ platform: 'x', selfId: '10005', internal: {} })
  check('适配器没实现该接口时安静返回 null', noApi === null, String(noApi))
  const broken = await queryAdapterImplementation({
    platform: 'x',
    selfId: '10006',
    internal: { get_version_info: async () => { throw new Error('nope') } }
  })
  check('接口报错时安静返回 null', broken === null, String(broken))

  console.log('')
  console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项')
  if (failures.length === 0) {
    console.log('=== 通过：适配器版本与构建信息都能拿到 ===')
    process.exit(0)
  } else {
    for (const item of failures) console.log('  ❌ ' + item)
    console.log('=== 失败 ===')
    process.exit(1)
  }
}

main()
