/**
 * Web 控制台冒烟测试：起一个真实的 Koishi HTTP 服务（koishi-plugin-server），
 * 挂上插件后用 fetch 打控制台接口，验证：
 *   1. GET /kkk                     控制台页面（零构建 HTML）
 *   2. GET /kkk/v1/version          版本接口（无需鉴权）
 *   3. GET /kkk/v1/config           无 token 且非本机 → 401
 *   4. GET /kkk/v1/config           带 token → 模块列表
 *   5. POST /kkk/v1/config          改一个配置项 → 再读确认已落盘
 *   6. GET /kkk/v1/bots             机器人列表
 *
 * 用法：node scripts/smoke-server.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { Context } = require('koishi')

const pluginRoot = path.resolve(__dirname, '..')
const dataRoot = path.resolve(pluginRoot, 'data-smoke-server')
const cfgDir = path.join(dataRoot, 'koishi-plugin-kkk', 'config')
fs.mkdirSync(cfgDir, { recursive: true })

const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'config/default_config/config.json'), 'utf8'))
config.pushlist = { douyin: [], bilibili: [] }
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(config, null, 2))

const PORT = Number(process.argv[2] || 5311)
const TOKEN = 'kkk-smoke-token'
const base = 'http://127.0.0.1:' + PORT

const ctx = new Context()
const serverModule = require('@koishijs/plugin-server')
ctx.plugin(serverModule.default ?? serverModule, { port: PORT, host: '127.0.0.1' })
ctx.plugin(require(path.join(pluginRoot, 'lib/index.js')), {
  dataPath: dataRoot,
  masters: ['12345'],
  apiToken: TOKEN,
  webui: true,
  debug: false
})

const check = (name, ok, extra = '') => {
  console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? ' | ' + extra : ''))
  if (!ok) failures++
}
let failures = 0

const call = async (route, options = {}) => {
  const headers = Object.assign({}, options.headers)
  if (options.token) headers.Authorization = 'Bearer ' + options.token
  if (options.body) headers['Content-Type'] = 'application/json'
  const response = await fetch(base + route, Object.assign({}, options, { headers }))
  const text = await response.text()
  let json
  try { json = JSON.parse(text) } catch {}
  return { status: response.status, text, json }
}

// koishi 的 server 插件在 `ready` 事件里才开始监听端口，所以要显式 start 上下文
void ctx.start().catch((error) => console.error('启动 Koishi 服务失败:', error))

setTimeout(async () => {
  try {
    const page = await call('/kkk')
    check('控制台页面 /kkk', page.status === 200 && page.text.includes('koishi-plugin-kkk 控制台'), 'HTTP ' + page.status + ' ' + page.text.length + ' 字节')

    const version = await call('/kkk/v1/version')
    check('版本接口 /kkk/v1/version', version.status === 200 && version.json?.data?.version, JSON.stringify(version.json?.data))

    const noToken = await call('/kkk/v1/config')
    check('未授权访问 /kkk/v1/config', noToken.status === 401, 'HTTP ' + noToken.status + ' ' + (noToken.json?.message || ''))

    const withToken = await call('/kkk/v1/config', { token: TOKEN })
    const modules = withToken.json?.data ? Object.keys(withToken.json.data) : []
    check('读取配置 /kkk/v1/config', withToken.status === 200 && modules.length > 0, modules.length + ' 个模块: ' + modules.slice(0, 8).join(','))

    const before = withToken.json?.data?.app?.parseTip
    const save = await call('/kkk/v1/config', {
      method: 'POST',
      token: TOKEN,
      body: JSON.stringify({ app: { ...withToken.json.data.app, parseTip: before === false } })
    })
    const after = await call('/kkk/v1/config', { token: TOKEN })
    check('写入配置 POST /kkk/v1/config', save.json?.code === 200 && after.json?.data?.app?.parseTip === (before === false),
      'parseTip: ' + before + ' → ' + after.json?.data?.app?.parseTip +
      ' | results: ' + JSON.stringify(save.json?.data?.results ?? save.json).slice(0, 200))

    const bots = await call('/kkk/v1/bots', { token: TOKEN })
    check('机器人列表 /kkk/v1/bots', bots.status === 200 && Array.isArray(bots.json?.data), 'HTTP ' + bots.status)
  } catch (error) {
    console.error('控制台冒烟测试失败:', error && error.stack ? error.stack : error)
    failures++
  }
  process.exit(failures ? 1 : 0)
}, 7000)
