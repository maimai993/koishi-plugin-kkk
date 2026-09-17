/**
 * 端到端冒烟测试：在裸 Koishi Context 里加载插件，模拟一条 B站链接消息，
 * 走完「识别 → 取数 → 发送」全流程，并打印实际发出的消息段。
 *
 * 用法：node scripts/smoke-parse.cjs [链接]
 */
const path = require('node:path')
const { Context } = require('koishi')

const pluginRoot = path.resolve(__dirname, '..')
const plugin = require(path.join(pluginRoot, 'lib', 'index.js'))

const target = process.argv[2] || 'https://www.bilibili.com/video/BV1xx411c7mD'
const dataPath = path.resolve(pluginRoot, 'data-smoke')

const ctx = new Context()
ctx.plugin(plugin, { dataPath, debug: true })

setTimeout(async () => {
  try {
    const { commandQueue } = require(path.join(pluginRoot, 'lib/compat/runtime.js'))
    const { Message } = require(path.join(pluginRoot, 'lib/compat/node-karin.js'))
    const reg = commandQueue.find((item) => String(item.reg).includes('bilibili'))
    if (!reg) throw new Error('没有注册 B站 解析命令')

    const sent = []
    const bot = {
      selfId: '10000', platform: 'smoke', status: 1, user: { id: '10000', name: 'smoke' }, ctx,
      sendMessage: async (channel, content) => { sent.push(content); return ['msg-1'] },
      getGuild: async () => ({ name: 'smoke-guild' })
    }
    const session = {
      content: target, selfId: '10000', userId: '12345', guildId: '456', channelId: '456',
      messageId: 'm1', bot, author: { nick: 'smoke' }, username: 'smoke', event: {},
      send: async (content) => { sent.push(content); return ['msg-2'] }
    }

    await reg.handler(Message.fromSession(session), () => Symbol('next'))

    console.log('\n=== 共发出 ' + sent.length + ' 条消息 ===')
    for (const item of sent) {
      const list = Array.isArray(item) ? item : [item]
      console.log(list.map((el) => {
        const type = el && el.type ? el.type : typeof el
        const attrs = el && el.attrs ? JSON.stringify(el.attrs).slice(0, 120) : ''
        return '[' + type + '] ' + attrs
      }).join('\n'))
    }
  } catch (error) {
    console.error('冒烟测试失败:', error && error.stack ? error.stack : error)
    process.exitCode = 1
  }
  process.exit(process.exitCode || 0)
}, 4000)
