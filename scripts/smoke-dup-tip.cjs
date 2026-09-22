/**
 * 冒烟测试：**同一条消息被投递多遍时，只提示一次、只处理一次**。
 *
 * 用户实测：发一遍 B站链接，群里出现三条「检测到B站链接，开始解析」。
 * 原因是一次发送被投递了多遍（QQ 的指令按钮是「消息 + 交互事件」两条，客户端重发、连点同理），
 * 每个副本都走到了提示那一行 —— 原来的作品级去重（biliKey 等）只挡解析、挡不住提示。
 *
 * 覆盖（全部不需要外网）：
 *   1. 提示去重：同一会话同一句提示 5 秒内只发一次；开关关掉时恢复原样；
 *   2. 四个平台 handler 都在**最前面**接了「同一条消息」的去重；
 *   3. 真的把 B站 handler 连跑三遍：第 2、3 遍被立刻拦住（不再发任何东西）。
 *
 * 用法：node scripts/smoke-dup-tip.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const pluginRoot = path.resolve(__dirname, '..')
const { Context } = require('koishi')

let failures = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? ' | ' + extra : ''))
  if (!ok) failures++
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

;(async () => {
  const plugin = require(path.join(pluginRoot, 'lib/index.js'))
  const ctx = new Context()
  // 注意：这里**不要**调 ctx.start() —— 裸 Context 下 plugin() + start() 会把插件应用两遍
  ctx.plugin(plugin, { dataPath: path.join(pluginRoot, 'data-smoke-dupmg'), debug: true })
  await sleep(9000)

  const runtime = require(path.join(pluginRoot, 'lib/compat/runtime.js'))
  const { Message } = require(path.join(pluginRoot, 'lib/compat/node-karin.js'))
  const { shouldSendTip } = require(path.join(pluginRoot, 'lib/karin/module/utils/parseTip.js'))
  const { isParseDedupeEnabled } = require(path.join(pluginRoot, 'lib/karin/module/utils/ParseLock.js'))
  const { commandQueue } = runtime

  const makeEvent = (content, sent) => Message.fromSession({
    content, selfId: '10000', userId: '12345', guildId: '456', channelId: '456', messageId: 'm-' + Math.random(),
    bot: {
      selfId: '10000', platform: 'qqguild', status: 1, user: { id: '10000', name: 'smoke-bot' }, ctx,
      sendMessage: async (channel, payload) => { sent.push({ channel: String(channel), payload }); return ['msg-1'] },
      getGuild: async () => ({ name: 'smoke-guild' })
    },
    author: { nick: 'smoke' }, username: 'smoke', event: {},
    send: async (payload) => { sent.push({ channel: '456', payload }); return ['msg-2'] }
  })

  console.log('\n[1] 提示去重（shouldSendTip）')
  /** 去重开关读的是**插件配置**（koishi.yml 里的 qq.parseDedupe），直接改运行时配置即可 */
  const rt = runtime.getRuntime()
  const savedDedupe = rt.config.parseDedupe
  rt.config.parseDedupe = true
  await sleep(200)
  {
    check('开关是开着的', isParseDedupeEnabled() === true)
    const sent = []
    const e = makeEvent('https://www.bilibili.com/video/BV13SMD6nEUC', sent)
    const results = [shouldSendTip(e, '检测到B站链接，开始解析'), shouldSendTip(e, '检测到B站链接，开始解析'), shouldSendTip(e, '检测到B站链接，开始解析')]
    check('同一句提示连问三次：只有第一次该发（用户看到的是三条）',
      results[0] === true && results[1] === false && results[2] === false, JSON.stringify(results))
    check('换一句话照常发', shouldSendTip(e, '收到请求，开始下载') === true)
    const other = makeEvent('https://www.bilibili.com/video/BV13SMD6nEUC', sent)
    other.contact = { peer: '999' }
    check('换个会话照常发', shouldSendTip(other, '检测到B站链接，开始解析') === true)

    rt.config.parseDedupe = false
    await sleep(200)
    const results2 = [shouldSendTip(e, '检测到B站链接，开始解析'), shouldSendTip(e, '检测到B站链接，开始解析')]
    check('关掉「短时间不重复解析」后不再拦截（行为与以前一致）', results2.every((item) => item === true), JSON.stringify(results2))
    rt.config.parseDedupe = true
    await sleep(200)
  }

  console.log('\n[2] 四个平台都在最前面接了「同一条消息」去重')
  {
    const source = fs.readFileSync(path.join(pluginRoot, 'src/karin/apps/tools.ts'), 'utf8')
    for (const platform of ['douyin', 'bilibili', 'kuaishou', 'xiaohongshu']) {
      const lockAt = source.indexOf("acquireMessageLock(e, '" + platform + "')")
      check(platform + ' 有 acquireMessageLock', lockAt > 0)
      /** 必须出现在「取数据 / 发提示」之前，否则群里已经看到提示了 */
      const after = source.slice(lockAt)
      check(platform + ' 的去重在取数据和提示之前', lockAt > 0 && !/get(Douyin|Bilibili|Kuaishou|Xiaohongshu)ID|sendParseTip/.test(source.slice(Math.max(0, lockAt - 400), lockAt)))
    }
  }

  console.log('\n[3] B站 handler 连跑三遍：第 2、3 遍立刻被拦住')
  {
    const linkReg = commandQueue.find((item) => /bilibili/.test(String(item.reg?.source ?? item.reg ?? '')))
    check('找到了 B站链接识别的注册', !!linkReg, linkReg ? String(linkReg.options?.name) : '（没有）')
    if (linkReg) {
      const sent = []
      const link = 'https://www.bilibili.com/video/BV13SMD6nEUC'
      const started = Date.now()
      const first = Promise.resolve().then(() => linkReg.handler(makeEvent(link, sent), () => Symbol('next'))).catch(() => undefined)
      await sleep(300)   // 让第一遍先跑到去重那一行
      const sentAfterFirst = sent.length
      const second = Date.now()
      await Promise.resolve().then(() => linkReg.handler(makeEvent(link, sent), () => Symbol('next'))).catch(() => undefined)
      const costSecond = Date.now() - second
      await Promise.resolve().then(() => linkReg.handler(makeEvent(link, sent), () => Symbol('next'))).catch(() => undefined)
      console.log('     第 2 遍用时 ' + costSecond + 'ms（第 1 遍还在跑）')
      check('第 2 遍几乎立刻返回（被去重拦住，没再取数据/发提示）', costSecond < 150, costSecond + 'ms')
      check('第 2、3 遍没有新增任何发送', sent.length === sentAfterFirst, sentAfterFirst + ' → ' + sent.length)
      // 第一遍让它自己跑（这里可能有外网请求，不阻塞整条用例）
      first.catch(() => undefined)
      console.log('     第一遍仍在进行（外网请求），累计用时 ' + (Date.now() - started) + 'ms')
    }
  }

  rt.config.parseDedupe = savedDedupe
  console.log('\n=== ' + (failures ? '失败 ' + failures + ' 项' : '全部通过') + ' ===')
  process.exit(failures ? 1 : 0)
})().catch((error) => {
  console.error('冒烟测试失败:', error && error.stack ? error.stack : error)
  process.exit(1)
})
