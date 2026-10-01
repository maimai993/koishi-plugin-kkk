/**
 * 信息类命令冒烟测试：`#kkk帮助` / `#kkk版本` / `#kkk更新日志`。
 * 覆盖 Render 兜底、CHANGELOG 解析（兼容层 logs/parseChangelog/range）、运行环境快照。
 *
 * 注意：插件声明了 `inject.required = ['database']`，**必须给一个数据库服务**它才会 apply；
 * 少了这一步 `middlewares=0 commands=0`，看起来像「指令全丢了」，其实是插件根本没加载。
 *
 * 另外这三个指令都要**渲染图片**（见 Render），机器上没有浏览器渲染服务
 * （koishi-plugin-puppeteer 或同类插件）时只会看到 `[Render] 渲染失败`，属正常现象。
 *
 * 用法：node scripts/smoke-commands.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Context } = require('koishi')
const sqlite = require('@koishijs/plugin-database-sqlite').default

const pluginRoot = path.resolve(__dirname, '..')
const dataRoot = path.resolve(pluginRoot, 'data-smoke-cmd')
fs.mkdirSync(path.join(dataRoot, 'koishi-plugin-kkk', 'config'), { recursive: true })
const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'config/default_config/config.json'), 'utf8'))
config.app.parseTip = false
fs.writeFileSync(path.join(dataRoot, 'koishi-plugin-kkk', 'config', 'config.json'), JSON.stringify(config, null, 2))

const plugin = require(path.join(pluginRoot, 'lib/index.js'))

;(async () => {
  const ctx = new Context()
  ctx.plugin(sqlite, { path: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kkk-cmd-')), 'koishi.db') })
  await ctx.start()

  const sent = []
  const fakeBot = { selfId: '10000', platform: 'smoke', status: 1, user: { id: '10000', name: 's' }, ctx,
    sendMessage: async (ch, c) => { sent.push(c); return ['m'] }, getGuild: async () => ({ name: 'g' }), getFriendList: async () => [] }
  Object.defineProperty(ctx, 'bots', { get: () => [fakeBot] })

  const middlewares = []
  const orig = ctx.middleware.bind(ctx)
  ctx.middleware = (fn, ...rest) => { middlewares.push(fn); return orig(fn, ...rest) }

  ctx.plugin(plugin, { dataPath: dataRoot, debug: true, masters: ['12345'] })
  for (let i = 0; i < 80 && !ctx.$commander._commandList.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await new Promise((resolve) => setTimeout(resolve, 300))

  let sessionSeq = 0
  const makeSession = (content) => {
    const id = ++sessionSeq
    return {
      content, selfId: '10000', userId: '12345', guildId: '456', channelId: '456-' + id, messageId: 'm' + id,
      bot: fakeBot, author: { nick: 's' }, username: 's', event: {}, user: { id: '12345' },
      send: async (c) => { sent.push(c); return ['m2'] }
    }
  }

  async function dispatch (content) {
    const session = makeSession(content)
    let i = 0
    let stopped = -1
    const run = async () => {
      while (i < middlewares.length) {
        const at = i++
        let cont = false
        await middlewares[at](session, () => { cont = true; return run() })
        if (!cont) { stopped = at; return }
      }
    }
    await run()
    return stopped
  }

  const { commandQueue } = require(path.join(pluginRoot, 'lib/compat/runtime.js'))
  console.log('middlewares=' + middlewares.length + ' commands=' + commandQueue.length +
    ' 已注册 Koishi 指令=' + ctx.$commander._commandList.length)

  for (const cmd of ['#kkk帮助', '#kkk版本', '#kkk更新日志']) {
    try {
      const stopped = await dispatch(cmd)
      console.log('--- ' + cmd + ' --- 被中间件消费位置=' + stopped)
    } catch (e) {
      console.log('FAIL', e.message)
    }
  }

  console.log('\n共发出 ' + sent.length + ' 条消息')
  for (const c of sent) {
    const list = Array.isArray(c) ? c : [c]
    console.log(list.map((el) => typeof el === 'string' ? el.slice(0, 160) : '[' + (el && el.type) + ']').join(' | ').slice(0, 300))
  }
  process.exit(0)
})().catch((error) => { console.error('冒烟测试失败:', error && error.stack ? error.stack : error); process.exit(1) })
