/**
 * 扫码登录链路冒烟测试：走 Koishi 中间件链路执行 `#B站登录` / `#抖音登录`。
 *
 * 验证点：
 *   - 命令与权限（loginPerm）解析正确
 *   - amagi 登录会话能拿到二维码（真实接口）
 *   - 二维码渲染走 Render（无 puppeteer 时降级）+ 回复链路
 *   - 抖音流程里 `karin.ctx`（等待用户输入）不会卡死进程
 *
 * 注意：不会真的完成扫码，脚本在 $WAIT_MS 后退出。
 *
 * 用法：node scripts/smoke-login.cjs [等待毫秒数]
 */
const fs = require('node:fs')
const path = require('node:path')
const { Context } = require('koishi')

const pluginRoot = path.resolve(__dirname, '..')
const dataRoot = path.resolve(pluginRoot, 'data-smoke-login')
const cfgDir = path.join(dataRoot, 'koishi-plugin-kkk', 'config')
fs.mkdirSync(cfgDir, { recursive: true })

const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'config/default_config/config.json'), 'utf8'))
config.app.parseTip = false
config.bilibili.loginPerm = 'master'
config.douyin.loginPerm = 'master'
config.pushlist = { douyin: [], bilibili: [] }
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(config, null, 2))

const plugin = require(path.join(pluginRoot, 'lib/index.js'))

// 沙箱里没有 puppeteer，二维码渲染走兜底会返回空数组；这里把 Render 换成假图片，
// 以便把「取码 → 渲染 → 发送 → 轮询」整条链路走完（渲染本身由 smoke-render 另行验证）。
// 注意：\`@/module/utils\` 的 index 用 __exportStar 生成的属性是只读 getter，直接改它无效，
// 要改真正定义 Render 的模块。
require(path.join(pluginRoot, 'lib/karin/module/utils/Render/index.js')).Render = async () => [{ type: 'image', file: 'base64://iVBORw0KGgo=' }]

const ctx = new Context()
const sent = []
const fakeBot = {
  selfId: '10000', platform: 'smoke', status: 1, user: { id: '10000', name: 'smoke' }, ctx,
  sendMessage: async (channel, content) => { sent.push({ channel, content }); return ['msg-1'] },
  sendPrivateMessage: async (user, content) => { sent.push({ channel: 'private:' + user, content }); return ['msg-1'] },
  getGuild: async () => ({ name: 'smoke-guild' }),
  getFriendList: async () => [{ userId: '12345' }]
}
Object.defineProperty(ctx, 'bots', { get: () => [fakeBot] })

const middlewares = []
const originalMiddleware = ctx.middleware.bind(ctx)
ctx.middleware = (fn, ...rest) => { middlewares.push(fn); return originalMiddleware(fn, ...rest) }

ctx.plugin(plugin, { dataPath: dataRoot, debug: true, masters: ['12345'] })

const makeSession = (content, userId = '12345') => ({
  content, selfId: '10000', userId, guildId: '', channelId: 'private:' + userId,
  messageId: 'm1', bot: fakeBot, author: { nick: 'smoke' }, username: 'smoke', event: {},
  send: async (c) => { sent.push({ channel: 'private:' + userId, content: c }); return ['msg-2'] }
})

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

const waitMs = Number(process.argv[2] || 20000)

setTimeout(async () => {
  try {
    console.log('=== #B站登录 ===')
    const started = Date.now()
    // 登录流程内部会轮询扫码状态，这里只等一小段时间观察“二维码是否拿到、是否回复”
    await Promise.race([dispatch('#B站登录'), new Promise((resolve) => setTimeout(resolve, 15000))])
    console.log('B站登录流程耗时(ms):', Date.now() - started)

    console.log('=== #抖音登录 ===')
    const douyinStarted = Date.now()
    await Promise.race([dispatch('#抖音登录'), new Promise((resolve) => setTimeout(resolve, 15000))])
    console.log('抖音登录流程耗时(ms):', Date.now() - douyinStarted)

    console.log('=== 非 master 执行 #B站登录（应被拒绝） ===')
    await dispatch('#B站登录', '99999')
  } catch (error) {
    console.error('登录冒烟测试失败:', error && error.stack ? error.stack : error)
    process.exitCode = 1
  }

  setTimeout(() => {
    console.log('\n=== 共发出 ' + sent.length + ' 条消息 ===')
    for (const item of sent) {
      const list = Array.isArray(item.content) ? item.content : [item.content]
      console.log('→ ' + item.channel + ': ' + list.map((el) => {
        if (typeof el === 'string') return el.slice(0, 200)
        const type = el && el.type ? el.type : typeof el
        const attrs = el && el.attrs ? JSON.stringify(el.attrs).slice(0, 120) : ''
        return '[' + type + '] ' + attrs
      }).join(' | '))
    }
    process.exit(process.exitCode || 0)
  }, waitMs)
}, 5000)
