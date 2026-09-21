/**
 * 冒烟测试：平台解析总开关 + 解析结果合并转发。
 *
 * 覆盖：
 *   1. **关了某个平台的解析 → 那个平台什么都不做**（用户线上反馈：关了小红书还会提示没有 Cookie）：
 *      走「#解析」引用解析进来的链接也必须被拦住 —— 不回复、不报缺 Cookie、不记统计；
 *   2. 开着的时候照常处理（对照组，证明不是把整条链路一起关掉了）；
 *   3. 解析结果合并转发：
 *      - 支持合并转发的适配器（onebot 系）：解析期间产生的所有内容先攒着，结束时**只发一条转发**；
 *      - 过程提示（用 withoutForwardCollect 标记过的）**不进转发**，照常单独发；
 *      - 发往别的频道的内容（例如错误日志发给主人）不会被吞进转发；
 *      - QQ 官方适配器没有合并转发能力：**完全不收集**，保持一边解析一边逐条发；
 *      - 身份：fakeForward 开着用触发者，关着用机器人（看日志）。
 *
 * 用法：node scripts/smoke-parse-forward.cjs
 */
const path = require('node:path')
const { Context } = require('koishi')

const pluginRoot = path.resolve(__dirname, '..')
const dataRoot = path.resolve(pluginRoot, 'data-smoke-forward')

const plugin = require(path.join(pluginRoot, 'lib/index.js'))
const ctx = new Context()
ctx.plugin(plugin, { dataPath: dataRoot, debug: true })

let failures = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? ' | ' + extra : ''))
  if (!ok) failures++
}

/** 捕获控制台输出：兼容层日志走 Koishi logger（最终落到 stdout） */
const logs = []
const originalLog = console.log
const captureOn = () => {
  logs.length = 0
  console.log = (...args) => { logs.push(args.map((item) => String(item)).join(' ')) }
}
const captureOff = () => { console.log = originalLog }
const hasLog = (pattern) => logs.some((line) => pattern.test(line))

setTimeout(async () => {
  try {
    const runtime = require(path.join(pluginRoot, 'lib/compat/runtime.js'))
    const { Message, segment, karin } = require(path.join(pluginRoot, 'lib/compat/node-karin.js'))
    const { withParseForward } = require(path.join(pluginRoot, 'lib/karin/module/utils/ParseForward.js'))
    const { withoutForwardCollect } = require(path.join(pluginRoot, 'lib/compat/node-karin.js'))
    const { commandQueue } = require(path.join(pluginRoot, 'lib/compat/runtime.js'))
    const { Config } = require(path.join(pluginRoot, 'lib/karin/module/utils/Config.js'))

    /** 造一个假会话（平台可指定），把发出去的内容都收进 sent */
    const makeEvent = (platform, sent) => Message.fromSession({
      content: 'https://www.xiaohongshu.com/explore/abcdef1234567890',
      selfId: '10000', userId: '12345', guildId: '456', channelId: '456', messageId: 'm1',
      bot: {
        selfId: '10000', platform, status: 1, user: { id: '10000', name: 'smoke-bot' }, ctx,
        sendMessage: async (channel, payload) => { sent.push({ channel: String(channel), payload }); return ['msg-1'] },
        getGuild: async () => ({ name: 'smoke-guild' })
      },
      author: { nick: 'smoke' }, username: 'smoke', event: {},
      send: async (payload) => { sent.push({ channel: '456', payload }); return ['msg-2'] }
    })

    console.log('\n[1] 关了小红书解析：#解析 进来的小红书链接什么都不做')
    /** 平台开关走官方的配置写入接口（写进 data-smoke-forward 那份 config.json） */
    const savedSwitch = Config.xiaohongshu.switch
    const setSwitch = (value) => Config.Modify('xiaohongshu', 'switch', value)
    setSwitch(false)
    {
      const sent = []
      const e = makeEvent('qqguild', sent)
      e.msg = '#解析 https://www.xiaohongshu.com/explore/abcdef1234567890'
      const prefix = commandQueue.find((item) => String(item.options?.name ?? '').includes('引用解析'))
      check('引用解析命令已注册', !!prefix, prefix ? String(prefix.options?.name) : '（没找到）')
      captureOn()
      try {
        await prefix.handler(e, () => Symbol('next'))
      } catch (error) {
        logs.push('ERR ' + String(error && error.message))
      }
      captureOff()
      check('平台关掉后一条消息都不发（没有 Cookie 报错、没有错误卡片）', sent.length === 0,
        sent.length ? JSON.stringify(sent[0].payload).slice(0, 120) : '0 条')
      check('日志里有「平台解析已关闭」的说明', hasLog(/平台解析已关闭/),
        (logs.find((line) => /平台解析已关闭/.test(line)) || '（没有）').slice(0, 120))
      check('日志里没有去碰小红书的痕迹（没有开始解析 / 没有 Cookies 报错）',
        !hasLog(/\[小红书\] 开始解析/) && !hasLog(/小红书的 Cookies/))
    }

    console.log('\n[2] 开着的时候照常处理（对照组）')
    {
      setSwitch(true)
      const sent = []
      const e = makeEvent('qqguild', sent)
      e.msg = '#解析 https://www.xiaohongshu.com/explore/abcdef1234567890'
      const prefix = commandQueue.find((item) => String(item.options?.name ?? '').includes('引用解析'))
      captureOn()
      try {
        await prefix.handler(e, () => Symbol('next'))
      } catch (error) {
        logs.push('ERR ' + String(error && error.message))
      }
      captureOff()
      check('开着时确实进了解析链路（日志里有 [小红书] 开始解析）', hasLog(/\[小红书\] 开始解析/),
        (logs.find((line) => /\[小红书\]/.test(line)) || '（没有）').slice(0, 120))
      await setSwitch(savedSwitch)
    }

    console.log('\n[3] 合并转发：解析结果攒起来，结束时只发一条转发')
    {
      const sent = []
      const e = makeEvent('onebot', sent)
      /** 解析进行到一半时的发送快照：结果应该还没发出去 */
      let midParseSnapshot = ''
      const handler = withParseForward(async (ev) => {
        await ev.reply(segment.text('结果一'))          // 结果 → 收集
        await withoutForwardCollect(() => ev.reply('发送中…'))  // 过程提示 → 直接发
        await ev.reply([segment.text('结果二')])         // 结果 → 收集
        midParseSnapshot = JSON.stringify(sent)
        // 发给别的频道（模拟错误日志发给主人）：不能被吞进转发
        await ev.bot.sendMsg(karin.contactGroup('999999'), [segment.text('发给主人的日志')])
      })
      captureOn()
      await handler(e, () => Symbol('next'))
      captureOff()

      const tip = sent.find((item) => JSON.stringify(item.payload).includes('发送中'))
      check('解析期间结果没有被立刻发出去（攒着）', !/结果一|结果二/.test(midParseSnapshot),
        midParseSnapshot.slice(0, 120))
      check('过程提示照常单独发出（不在转发里）', !!tip && tip.channel === '456')

      const forward = sent.find((item) => {
        const list = Array.isArray(item.payload) ? item.payload : [item.payload]
        return list.some((el) => el && el.type === 'message')
      })
      check('结束时发了一条合并转发', !!forward, forward ? 'channel=' + forward.channel : '（没有）')
      const node = forward ? (Array.isArray(forward.payload) ? forward.payload : [forward.payload]).find((el) => el && el.type === 'message') : null
      const children = node ? (node.children ?? []) : []
      const text = JSON.stringify(children)
      check('转发里有两条结果', children.length === 2, '节点内容 ' + children.length + ' 条')
      check('转发里没有过程提示', !!node && !/发送中/.test(text), text.slice(0, 140))
      check('发往别的频道的消息没有被吞进转发（去了 999999）',
        sent.some((item) => item.channel === '999999' && JSON.stringify(item.payload).includes('发给主人的日志')))
      // 身份跟着 fakeForward 走：默认配置里它是 true（触发者），这里按当前取值断言
      const expectFake = Config.app.fakeForward === true
      check('日志里说明这次合并了几条、用的什么身份',
        hasLog(new RegExp('\\[合并转发\\] 本次解析产生 2 条内容.*身份：' + (expectFake ? '触发者' : '机器人'))),
        (logs.find((line) => /\[合并转发\]/.test(line)) || '（没有）').slice(0, 140))
    }

    console.log('\n[3b] 身份：fakeForward 开着用触发者，关着用机器人')
    {
      const savedFake = Config.app.fakeForward
      await Config.Modify('app', 'fakeForward', true)
      const sent = []
      const e = makeEvent('onebot', sent)
      captureOn()
      await withParseForward(async (ev) => { await ev.reply(segment.text('身份测试')) })(e, () => Symbol('next'))
      captureOff()
      check('开着时日志写的是触发者身份', hasLog(/身份：触发者 smoke/),
        (logs.find((line) => /\[合并转发\]/.test(line)) || '（没有）').slice(0, 140))

      await Config.Modify('app', 'fakeForward', false)
      const sent2 = []
      captureOn()
      await withParseForward(async (ev) => { await ev.reply(segment.text('身份测试2')) })(makeEvent('onebot', sent2), () => Symbol('next'))
      captureOff()
      check('关掉后日志写的是机器人身份', hasLog(/身份：机器人 smoke-bot/),
        (logs.find((line) => /\[合并转发\]/.test(line)) || '（没有）').slice(0, 140))
      await Config.Modify('app', 'fakeForward', savedFake)
    }

    console.log('\n[4] QQ 官方适配器（不支持合并转发）：不收集、逐条发')
    {
      const sent = []
      const e = makeEvent('qqguild', sent)
      await withParseForward(async (ev) => {
        await ev.reply(segment.text('结果一'))
        await ev.reply(segment.text('结果二'))
      })(e, () => Symbol('next'))
      const texts = sent.map((item) => JSON.stringify(item.payload))
      check('两条结果各自立刻发出（老样子，没有被攒起来）',
        texts.length === 2 && texts[0].includes('结果一') && texts[1].includes('结果二'),
        texts.length + ' 条')
      check('没有出现合并转发（那条 message 元素）',
        !texts.some((text) => text.includes('"type":"message"')))
    }

    captureOff()
    console.log('\n=== ' + (failures ? '失败 ' + failures + ' 项' : '全部通过') + ' ===')
    process.exit(failures ? 1 : 0)
  } catch (error) {
    captureOff()
    console.error('冒烟测试失败:', error && error.stack ? error.stack : error)
    process.exit(1)
  }
}, 5000)
