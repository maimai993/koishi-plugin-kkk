/**
 * 推送/权限链路冒烟测试（真实 Koishi 中间件链路）。
 *
 * 覆盖：
 *   1. `#B站推送列表`：配置 → 数据库 → 渲染兜底 → 发送
 *   2. `#解析统计`（perm: master）：统计库读取
 *   3. 权限校验：非 master 执行 master 命令被拒绝、master 放行
 *   4. 定时任务「B站推送」：真实接口（本机 IP 被 B站风控时应当优雅报错并入库不变）
 *
 * 用法：node scripts/smoke-push.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { Context } = require('koishi')

const pluginRoot = path.resolve(__dirname, '..')
const dataRoot = path.resolve(pluginRoot, 'data-smoke')
const cfgDir = path.join(dataRoot, 'koishi-plugin-kkk', 'config')
fs.mkdirSync(cfgDir, { recursive: true })

const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'config/default_config/config.json'), 'utf8'))
config.app.parseTip = false
config.pushlist = {
  douyin: [],
  bilibili: [{ switch: true, host_mid: 946974, group_id: ['456:10000'], remark: '影视飓风', pushTypes: ['video', 'draw', 'word'] }]
}
config.bilibili.push.switch = true
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(config, null, 2))

const plugin = require(path.join(pluginRoot, 'lib/index.js'))
const ctx = new Context()
const sent = []
const fakeBot = {
  selfId: '10000', platform: 'smoke', status: 1, user: { id: '10000', name: 'smoke' }, ctx,
  sendMessage: async (channel, content) => { sent.push({ channel, content }); return ['msg-1'] },
  sendPrivateMessage: async (user, content) => { sent.push({ channel: 'private:' + user, content }); return ['msg-1'] },
  getGuild: async () => ({ name: 'smoke-guild' }),
  getFriendList: async () => []
}
Object.defineProperty(ctx, 'bots', { get: () => [fakeBot] })

// 捕获插件注册的中间件，测试时按 Koishi 的语义依次调用
const middlewares = []
const originalMiddleware = ctx.middleware.bind(ctx)
ctx.middleware = (fn, ...rest) => { middlewares.push(fn); return originalMiddleware(fn, ...rest) }

ctx.plugin(plugin, { dataPath: dataRoot, debug: true, masters: ['12345'] })

const makeSession = (content, userId = '12345') => ({
  content, selfId: '10000', userId, guildId: '456', channelId: '456',
  messageId: 'm1', bot: fakeBot, author: { nick: 'smoke' }, username: 'smoke', event: {},
  send: async (c) => { sent.push({ channel: '456', content: c }); return ['msg-2'] }
})

/** 模拟 Koishi 的中间件链路：某个中间件不调用 next 即视为消费了该消息 */
async function dispatch (content, userId) {
  const session = makeSession(content, userId)
  let index = 0
  const run = async () => {
    while (index < middlewares.length) {
      const middleware = middlewares[index++]
      let continued = false
      await middleware(session, () => { continued = true; return run() })
      if (!continued) return
    }
  }
  await run()
}

setTimeout(async () => {
  const { taskQueue } = require(path.join(pluginRoot, 'lib/compat/runtime.js'))
  try {
    console.log('=== 1) #B站推送列表 ===')
    await dispatch('#B站推送列表')

    console.log('=== 2) #解析统计（perm: master，master 用户） ===')
    await dispatch('#解析统计')

    console.log('=== 3) 权限校验：#kkk设置推送机器人（perm: master） ===')
    console.log('--- 非 master（99999） ---')
    await dispatch('#kkk设置推送机器人10000', '99999')
    console.log('--- master（12345） ---')
    await dispatch('#kkk设置推送机器人10000', '12345')

    console.log('=== 4) 定时任务：B站推送（真实接口） ===')
    const task = taskQueue.find((item) => item.name === 'B站推送')
    await task.handler().catch((error) => console.log('任务抛出异常（已被 ErrorHandler 处理后重新抛出）:', error.message.slice(0, 120)))

    console.log('\n=== 共发出 ' + sent.length + ' 条消息 ===')
    for (const item of sent) {
      const list = Array.isArray(item.content) ? item.content : [item.content]
      console.log('→ ' + item.channel + ': ' + list.map((el) => {
        if (typeof el === 'string') return el.slice(0, 200)
        const type = el && el.type ? el.type : typeof el
        const attrs = el && el.attrs ? JSON.stringify(el.attrs).slice(0, 160) : ''
        return '[' + type + '] ' + attrs
      }).join(' | '))
    }
  } catch (error) {
    console.error('推送冒烟测试失败:', error && error.stack ? error.stack : error)
    process.exitCode = 1
  }
  process.exit(process.exitCode || 0)
}, 5000)
