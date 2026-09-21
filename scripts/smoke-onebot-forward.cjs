/**
 * 冒烟测试：合并转发在 **OneBot 适配器**上真的走 OneBot 的合并转发 API。
 *
 * 做法：起一个假 OneBot v11 服务端（WS），把**真的** koishi-plugin-adapter-onebot 接上去，
 * 然后用兼容层的 KkkBot.sendForwardMsg 发一条合并转发，看服务端收到的是不是
 * `send_group_forward_msg`（带 node 的身份信息）；最后再走一遍完整的「解析结果合并转发」，
 * 确认整条解析只发一条转发、过程提示走普通消息。
 *
 * 依赖（koishi / ws / koishi-plugin-adapter-onebot）在本包或宿主 node_modules 里找，
 * **都找不到就直接跳过**（退出码 0），不会拖累其它环境。
 *
 * 用法：node scripts/smoke-onebot-forward.cjs
 */
const path = require('node:path')
const pluginRoot = path.resolve(__dirname, '..')

/** 依赖在本包或宿主 node_modules 里找（和别的冒烟一个套路） */
const resolveDep = (name) => {
  for (const root of [path.join(pluginRoot, 'node_modules'), path.resolve(pluginRoot, '..', '..', 'node_modules')]) {
    try { return require(path.join(root, name)) } catch { /* 换下一个 */ }
  }
  try { return require(name) } catch { return null }
}

const koishi = resolveDep('koishi')
const onebotModule = resolveDep('koishi-plugin-adapter-onebot')
const WebSocket = resolveDep('ws')
if (!koishi || !onebotModule || !WebSocket) {
  console.log('跳过：本机没有装 koishi / koishi-plugin-adapter-onebot / ws（这个冒烟需要真的 OneBot 适配器）')
  process.exit(0)
}
/** 适配器是 ESM 风格导出：真正的插件在 .default 上 */
const { Context } = koishi
const onebot = onebotModule.default ?? onebotModule
const compat = require(path.join(pluginRoot, 'lib/compat/node-karin.js'))
const runtimeMod = require(path.join(pluginRoot, 'lib/compat/runtime.js'))

const PORT = 15999
const received = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? ' | ' + extra : ''))
  if (!ok) failures++
}

const wss = new WebSocket.Server({ port: PORT })
wss.on('connection', (ws) => {
  console.log('  假 OneBot 服务端：适配器已连接')
  ws.on('close', (code, reason) => console.log('  [服务端] 连接关闭 code=' + code + ' reason=' + String(reason)))
  ws.on('error', (error) => console.log('  [服务端] 连接错误: ' + String(error && error.message)))
  ws.on('message', (raw) => {
    let msg = null
    try { msg = JSON.parse(raw.toString()) } catch { /* 忽略 */ }
    if (!msg || !msg.action) return
    received.push(msg)
    console.log('  [服务端] 收到 ' + msg.action)
    const reply = (data) => ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: msg.echo }))
    if (msg.action === 'get_login_info') return reply({ user_id: 10000, nickname: 'smoke-bot' })
    if (msg.action === 'get_guild_service_profile') return reply({})
    if (msg.action === 'get_version_info') return reply({ app_name: 'fake-onebot', protocol_version: 'v11' })
    if (msg.action === 'get_status') return reply({ online: true, good: true })
    if (msg.action === 'send_group_forward_msg' || msg.action === 'send_private_forward_msg') return reply({ message_id: 'forward-777' })
    return reply({})
  })
})

;(async () => {
  await sleep(800)
  const ctx = new Context()
  /** OneBot 适配器依赖 http 服务（WS 客户端用它连服务端），裸 Context 里没有，先装上 */
  try {
    const httpPlugin = resolveDep('@cordisjs/plugin-http')
    ctx.plugin(httpPlugin.default ?? httpPlugin, {})
  } catch (error) { console.log('  加载 http 服务失败: ' + String(error && error.message)) }
  ctx.on('internal/error', (error) => console.log('  [ctx error] ' + String(error && error.message)))
  ctx.plugin(onebot, { protocol: 'ws', selfId: '10000', endpoint: 'ws://127.0.0.1:' + PORT })
  /** 适配器是在 ctx.start() 之后才去连服务端的（裸 Context 不会自动 start） */
  await ctx.start()
  await sleep(1500)
  console.log('  http 服务: ' + (ctx.http ? '有' : '没有') + ' / 已知道的 bot 数: ' + ctx.bots.length)

  // 等机器人上线
  let bot = null
  for (let i = 0; i < 40 && !bot; i++) {
    bot = ctx.bots.find((b) => b.selfId === '10000')
    if (!bot) await sleep(500)
  }
  check('适配器上的 OneBot 机器人已上线', !!bot && bot.status === 1, bot ? bot.platform + ' status=' + bot.status : '（没上线）')
  if (!bot) { wss.close(); process.exit(1) }
  console.log('  适配器平台: ' + bot.platform + ' / selfId=' + bot.selfId)

  runtimeMod.bindRuntime({
    ctx,
    config: {},
    pluginRoot,
    dataRoot: path.join(pluginRoot, 'data-smoke-forward')
  })
  const kkkBot = compat.karin.getBot('10000')
  check('兼容层能拿到 KkkBot', !!kkkBot)

  // 发一条合并转发（身份 = 触发者）
  const payload = compat.makeForward(
    [compat.segment.text('结果一'), compat.segment.text('结果二')],
    '12345',
    '触发者昵称'
  )
  await kkkBot.sendForwardMsg(compat.contactGroup('456'), payload)
  await sleep(1200)

  const call = received.find((m) => m.action === 'send_group_forward_msg')
  check('OneBot 服务端收到了 send_group_forward_msg（这就是 OneBot 的合并转发 API）', !!call,
    received.map((m) => m.action).join(' / ') || '（什么都没收到）')
  if (call) {
    console.log('  收到的参数: ' + JSON.stringify(call.params))
    const nodes = call.params?.messages ?? []
    check('收件群正确', String(call.params?.group_id) === '456', String(call.params?.group_id))
    check('只有 1 个 node（整次解析合成一条转发）', nodes.length === 1, nodes.length + ' 个')
    const node = nodes[0]
    check('node 的身份是触发者（uin / name）',
      node?.type === 'node' && String(node.data?.uin) === '12345' && node.data?.name === '触发者昵称',
      JSON.stringify(node?.data && { uin: node.data.uin, name: node.data.name }))
    const content = node?.data?.content ?? []
    check('node 里带着两条内容', content.length === 2 && JSON.stringify(content).includes('结果一') && JSON.stringify(content).includes('结果二'),
      JSON.stringify(content).slice(0, 140))
  }

  // 再验证一次：关掉伪造 → 用机器人身份
  received.length = 0
  const botPayload = compat.makeForward([compat.segment.text('机器人身份')], '10000', 'smoke-bot')
  await kkkBot.sendForwardMsg(compat.contactGroup('456'), botPayload)
  await sleep(1000)
  const call2 = received.find((m) => m.action === 'send_group_forward_msg')
  check('换个身份再发一次也走同一个 API',
    !!call2 && String(call2.params?.messages?.[0]?.data?.uin) === '10000' && call2.params?.messages?.[0]?.data?.name === 'smoke-bot',
    JSON.stringify(call2?.params?.messages?.[0]?.data && { uin: call2.params.messages[0].data.uin, name: call2.params.messages[0].data.name }))

  console.log('\n[端到端] 解析链路收集 → 结束发一条 OneBot 合并转发')
  {
    const { Message, segment } = compat
    const { withParseForward } = require(path.join(pluginRoot, 'lib/karin/module/utils/ParseForward.js'))
    const { withoutForwardCollect } = compat
    received.length = 0
    const e = Message.fromSession({
      content: 'x', selfId: '10000', userId: '12345', guildId: '456', channelId: '456', messageId: 'm1',
      bot,
      author: { nick: '触发者昵称' }, username: '触发者昵称', event: {},
      send: async (payload) => bot.sendMessage('456', payload)
    })
    await withParseForward(async (ev) => {
      await ev.reply(segment.text('解析卡片'))
      // 过程提示：不进转发，单独发
      await withoutForwardCollect(() => ev.reply('发送中…'))
      await ev.reply(segment.text('评论区'))
    })(e, () => Symbol('next'))
    await sleep(1200)

    const forwards = received.filter((m) => m.action === 'send_group_forward_msg')
    const plain = received.filter((m) => m.action === 'send_group_msg')
    check('整条解析只发了一条合并转发', forwards.length === 1, forwards.length + ' 条')
    const nodes = forwards[0]?.params?.messages ?? []
    const nodeText = JSON.stringify(nodes)
    check('转发里有两条结果，且不含过程提示',
      nodes.length === 1 && /解析卡片/.test(nodeText) && /评论区/.test(nodeText) && !/发送中/.test(nodeText),
      nodeText.slice(0, 180))
    check('过程提示单独发（走的是普通消息 send_group_msg）',
      plain.length === 1 && JSON.stringify(plain[0].params).includes('发送中'),
      plain.length + ' 条普通消息')
  }

  console.log('\n=== ' + (failures ? '失败 ' + failures + ' 项' : '全部通过') + ' ===')
  wss.close()
  process.exit(failures ? 1 : 0)
})().catch((error) => {
  console.error('FAILED', error && error.stack ? error.stack : error)
  try { wss.close() } catch { /* 忽略 */ }
  process.exit(1)
})