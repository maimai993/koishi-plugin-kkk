/**
 * 探针：OneBot 平台的「点表情选清晰度」。
 *
 * OneBot 没有 QQ 官方那种 markdown + 原生按钮，所以表情回应（`set_msg_emoji_like`）
 * 是它唯一还能用的「按钮」：机器人往自己那条选择消息上贴一排表情，
 * 用户在下面点哪个，就算选了哪一档。这个探针把整条链路离线跑一遍：
 *
 *   ① 配置项存在（控制台 / WebUI 都读同一张字段表）；
 *   ② OneBot 适配器的方法名（`setMsgEmojiLike`）真的被兼容层认出来；
 *   ③ 只有 OneBot 系的群聊会走这条面板；
 *   ④ 面板文本把「第几个表情 = 哪一档」说清楚，贴图数量/顺序也对；
 *   ⑤ 点表情 → 计数增加 → 认出来是哪一档；
 *   ⑥ 选完清晰度还要问一句「是否在线播放」（478 / 479）；
 *   ⑦ 最后落地成一条和 QQ 按钮一模一样的解析命令；
 *   ⑧ 无关表情、数量没变都不会误触发；
 *   ⑨ 协议端老到没有 `set_msg_emoji_like` 时，面板照样能发、文字退路顶上；
 *   ⑩ 「协议端到底发没发」的总探针（`internal/session`）只在有面板等着时才出声；
 *   ⑪ 兼容层怎么调 `fetch_emoji_like`（适配器没 define 它，要走通用入口）；
 *   ⑫ 推送不来时的第二条路：**主动轮询**「谁贴了这个表情」，且机器人自己不算点击。
 *
 * 用法：node scripts/probe-onebot-reaction-panel.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..')
const lib = path.join(root, 'lib')

const runtime = require(path.join(lib, 'compat/runtime.js'))
const bind = (extra = {}) => runtime.bindRuntime({
  // assets 服务：面板卡片要靠它转存成公网地址（没有它就退化成纯文字面板）
  ctx: { config: { port: 5200, prefix: '' }, assets: { upload: async () => 'https://cdn.example.com/panel.png' } },
  config: { playerEnabled: true, qqFileLimitMB: 200, onebotQualityPanel: true, ...extra },
  dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'kkk-probe-reaction-')),
  runCommand: async (session, text) => { captured.commands.push({ session, text }); return true }
})

/**
 * 面板的诊断日志要走 `logger.mark`，而 compat 里 `mark` 是转发到 **info** 级的
 * （`src/compat/logger.ts` 的 `emit`：`mark → emit('info')` → `logger.info(message)`）。
 * 所以这里把 `info` 收进 `logLines`，第 15 节靠它断言「收到的事件有没有被记下来」。
 */
const logLines = []
const LOG_LINE_MAX = 500
require(path.join(lib, 'compat/logger.js')).setLogger({
  debug () {},
  info: (...args) => {
    logLines.push(String(args[0] ?? ''))
    if (logLines.length > LOG_LINE_MAX) logLines.splice(0, logLines.length - LOG_LINE_MAX)
  },
  mark () {},
  warn: (m) => console.log('  [warn] ' + m),
  error: (m) => console.log('  [error] ' + m)
})

const captured = { commands: [] }

const fields = require(path.join(root, 'src', 'qqFields.json'))
const qqOptions = require(path.join(lib, 'qqOptions.js'))
const qqPanel = require(path.join(lib, 'karin/module/utils/QqPanel.js'))
const { KkkBot } = require(path.join(lib, 'compat/node-karin.js'))
const panel = require(path.join(lib, 'karin/module/utils/ReactionPanel.js'))

let failed = 0
const check = (name, ok, detail) => {
  console.log((ok ? '  \u2714 ' : '  \u2718 ') + name + (detail ? '  \u2192 ' + detail : ''))
  if (!ok) failed++
}

/** 清晰度那一排表情（升序，和模块里保持一致） */
const QUALITY_EMOJI = ['301', '320', '333', '351', '355', '369', '371', '383', '396', '405']
const YES = '478'
const NO = '479'

/** 面板现在是「元素数组」（图片段 / face 段 / 文本段），摊平成一段可读的文字好断言 */
const renderContent = (content) => {
  const list = Array.isArray(content) ? content : [content]
  return list.map((item) => {
    if (!item || typeof item !== 'object') return String(item ?? '')
    const attrs = item.attrs ?? {}
    if (item.type === 'text') return String(attrs.content ?? '')
    if (item.type === 'face') return '[face:' + attrs.id + ']'
    if (item.type === 'img' || item.type === 'image') return '[img:' + String(attrs.src ?? attrs.url ?? '') + ']'
    return '[' + item.type + ']'
  }).join('')
}

/** 消息里的 face 段（按顺序）：断言「表情印在选项前面」要靠它 */
const facesOf = (content) => (Array.isArray(content) ? content : [content])
  .filter((item) => item && item.type === 'face')
  .map((item) => String(item.attrs.id))

/* ------------------------------------------------------------------ *
 * 假的环境：一个 OneBot 机器人 + 一条群消息
 * ------------------------------------------------------------------ */
const makeEnv = (platform = 'onebot', isGroup = true, opts = {}) => {
  const calls = { reactions: [], replies: [], raw: [], recalls: [], likes: [] }
  const bot = {
    platform,
    selfId: '3889000',
    // 兼容层的 recallMsg 走的是 Koishi 标准的 deleteMessage(channel, messageId)
    deleteMessage: async (channel, messageId) => { calls.recalls.push({ messageId, channelId: channel }) }
  }
  /**
   * `opts.noReactionApi` = 协议端太老，连 `set_msg_emoji_like` 都没有（NapCat 要 v4.12.1+）。
   * 这种实例上「贴表情」和「点击事件」会**一起**失效，只能走文字退路 —— 必须能被模拟。
   */
  if (!opts.noReactionApi) {
    bot.setMsgEmojiLike = async (messageId, emojiId, isSet) => {
      calls.reactions.push({ messageId, emojiId, isSet })
      return true
    }
  }
  /**
   * 主动查「谁贴了这个表情」（NapCat 的 `fetch_emoji_like`）。
   * `opts.likes` 是**可变的** `{ 表情id: [用户id…] }` —— 用例中途改它就是「有人点了」。
   * `opts.noFetchApi` = 协议端没有这个接口（老 NapCat），用来验证「只判定一次就停、不反复打」。
   */
  if (!opts.noFetchApi) {
    bot.fetchEmojiLike = async (messageId, emojiId) => {
      calls.likes.push({ messageId, emojiId })
      const list = (opts.likes && opts.likes[String(emojiId)]) || []
      return {
        emojiLikesList: list.map((id) => ({ tinyId: String(id), nickName: '', headUrl: '' })),
        cookie: '', isLastPage: true, isFirstPage: true
      }
    }
  }
  const session = {
    channelId: '20001', guildId: '20001', userId: '10001', platform, bot,
    send: async (content) => { calls.replies.push(renderContent(content)); calls.raw.push(content); return ['msg-ask'] }
  }
  const e = {
    msg: 'https://v.douyin.com/abc123/',
    userId: '10001', groupId: '20001', isGroup,
    contact: { peer: '20001', isGroup },
    bot: opts.noReactionApi
      ? { platform, selfId: bot.selfId }
      : { ...bot, setMsgEmojiLike: bot.setMsgEmojiLike, fetchEmojiLike: bot.fetchEmojiLike },
    session,
    reply: async (content) => {
      const text = renderContent(content)
      calls.replies.push(text)
      calls.raw.push(content)
      // 模拟「协议端不认 face 段」：整条消息发送失败，用来验证退回纯文本那条路
      if (opts.rejectFace && facesOf(content).length) throw new Error('unsupported segment: face')
      // 「正在加载卡片…」是过程提示，给它单独的 id，免得和面板那条混在一起
      // opts.panelMessageId：第 18 节要造「协议端上报的 id 和我们记下的不是一个形态」
      return { messageId: text.includes('正在加载卡片') ? 'msg-tip' : (opts.panelMessageId ?? 'msg-1') }
    }
  }
  return { e, bot, calls, session }
}

/** 发过的、不含「正在加载卡片…」那句过程提示的消息（下标 + 文字） */
const nonTip = (env) => env.calls.replies
  .map((text, index) => ({ text, index }))
  .filter((item) => !item.text.includes('正在加载卡片'))

/** 面板那条消息的文字 */
const panelText = (env) => nonTip(env)[0]?.text ?? ''
/** 最后一条面板消息（face 段发不出去时会先失败一次，再退回纯文本重发） */
const lastPanelText = (env) => nonTip(env).slice(-1)[0]?.text ?? ''
/** 最后一条面板消息里印出来的表情 id（按出现顺序） */
const panelFaces = (env) => {
  const last = nonTip(env).slice(-1)[0]
  return last ? facesOf(env.calls.raw[last.index]) : []
}
/** 「是否在线播放」那条消息里印出来的表情 id */
const askFaces = (env) => {
  const index = env.calls.replies.findIndex((item) => item.includes('在线播放'))
  return index < 0 ? [] : facesOf(env.calls.raw[index])
}

/**
 * 表情回应事件的样子：`session.onebot.current_reactions` 是「现在每种表情各多少个」。
 * 复用环境里那条会话 —— 这样第二步发出去的消息也会被记进 calls.replies。
 */
const reactionSession = (env, messageId, counts) => ({
  ...env.session,
  messageId,
  onebot: { current_reactions: counts.map(([emojiId, count]) => ({ emoji_id: emojiId, count })) }
})

/** 若干档画质：B站口吻的 qn + 抖音口吻的关卡名都能走 */
const options = (list) => list.map(([id, label, sizeMB]) => ({ id: String(id), label, sizeMB }))

const REQUEST = { platform: 'douyin', url: 'https://v.douyin.com/abc123/', id: '7400000000000000001' }

/** 把面板真正发出去（已经 stub 掉拉作品信息 / 渲染卡片这两步） */
const send = async (info, extra = {}) => {
  qqPanel.fetchPanelInfo = async () => info
  qqPanel.uploadPanelCard = extra.noCard
    ? async () => null
    : async () => ({ url: 'https://cdn.example.com/panel.png', width: 800, height: 1200 })
  const env = makeEnv(extra.platform ?? 'onebot', extra.isGroup ?? true, extra.env ?? {})
  const ok = await panel.sendQualityReactionPanel(env.e, { ...REQUEST, ...(extra.request ?? {}) })
  return { ...env, ok }
}

;(async () => {
  console.log('\n=== 1. 配置项「OneBot 用表情选清晰度」 ===')
  {
    const field = fields.find((item) => item.key === 'onebotQualityPanel')
    check('字段写在字段表里（控制台 + WebUI 同一份）', !!field, field ? field.label : '缺')
    check('默认是开的（用户选的就是「默认开」）', field && field.default === true, 'default=' + (field && field.default))
    check('在「解析面板」分组里', field && field.group === '解析面板', field && field.group)
    check('说明里写清了没有 markdown 按钮这件事', !!field && /OneBot|NapCat/.test(field.description) && /markdown|按钮/.test(field.description))
    check('QQ_KEYS 里也有它（才会被摊平进运行时）', qqOptions.QQ_KEYS.includes('onebotQualityPanel'))
    const defaults = qqOptions.QQ_DEFAULTS
    check('字段表默认值 = true', defaults.onebotQualityPanel === true, String(defaults.onebotQualityPanel))
  }

  console.log('\n=== 2. 兼容层认得 OneBot 的 setMsgEmojiLike ===')
  {
    bind()
    const logged = []
    const raw = {
      platform: 'onebot',
      // 只有 OneBot 系提供这个名字（set_msg_emoji_like 的驼峰写法）
      setMsgEmojiLike: async (messageId, emojiId, isSet) => {
        logged.push([messageId, emojiId, isSet])
      }
    }
    const ok = await new KkkBot(raw).setMsgReaction('', '123456', '478', true)
    check('贴表情成功（返回的 true）', ok === true)
    check('参数按 (消息ID, 表情ID, 是否贴) 传了出去', JSON.stringify(logged) === JSON.stringify([['123456', '478', true]]), JSON.stringify(logged))

    /**
     * 真正线上那个坑：OneBot 的 `set_msg_emoji_like` 是 `Internal.define` 定义的，
     * 而 `define` 把方法挂在 **Internal.prototype** 上 —— 也就是只有 `bot.internal.setMsgEmojiLike`
     * 存在，`bot.setMsgEmojiLike` 是 undefined。以前只找 bot 本体，于是表情**一个都没贴上去**
     * （用户反馈「bot 自己要先贴表情」）。这条断言盯住 internal 那一路。
     */
    const internalLogged = []
    const okInternal = await new KkkBot({
      platform: 'onebot',
      internal: { setMsgEmojiLike: async (messageId, emojiId, isSet) => { internalLogged.push([messageId, emojiId, isSet]) } }
    }).setMsgReaction('', '123456', '478', true)
    check('方法挂在 bot.internal 上（真实 OneBot 适配器就是这么挂的）也认得', okInternal === true)
    check('参数同样按 (消息ID, 表情ID, 是否贴) 传出去', JSON.stringify(internalLogged) === JSON.stringify([['123456', '478', true]]), JSON.stringify(internalLogged))

    const nothing = await new KkkBot({ platform: 'other' }).setMsgReaction('', '1', '2', true)
    check('不支持的平台不会抛异常（返回 false）', nothing === false)
  }

  console.log('\n=== 3. 只有 OneBot 系的群聊会走面板 ===')
  {
    const onebot = makeEnv('onebot', true)
    const official = makeEnv('qq', true)
    const priv = makeEnv('napcat', false)
    check('OneBot 群聊：走面板', panel.isReactionPanelCapable(onebot.e) === true)
    check('QQ 官方适配器：不走（它有自己的 markdown 面板）', panel.isReactionPanelCapable(official.e) === false)
    check('私聊：不走', panel.isReactionPanelCapable(priv.e) === false)
  }

  console.log('\n=== 4. 面板内容：第几个表情 = 哪一档 ===')
  {
    bind()
    panel.debugClear()
    const info = {
      title: '【实拍】这段路到底能不能走', author: '某个UP', duration: '02:31',
      options: options([[80, '1080P', 120], [64, '720P', 60], [32, '480P', 25]])
    }
    const env = await send(info)
    check('面板发出了（返回 true）', env.ok === true)
    const text = panelText(env)
    /**
     * 有卡片时**文字里不再重复发标题/UP**（用户反馈「居然有卡片了就不用发这些了」）——
     * 标题、UP、时长都在卡片图里了。没卡片时才有（见第 10 节的 noCard 用例）。
     */
    check('有卡片时不再重复发作品信息', !text.includes('这段路到底能不能走') && !text.includes('某个UP'), JSON.stringify(text.slice(0, 40)))
    for (const [index, label] of ['1080P', '720P', '480P'].entries()) {
      // 文字现在收在一个 text 段里（交错 face 段会被 QQ 吞掉中间的行），所以行首就是序号
      check('第 ' + (index + 1) + ' 行 = ' + label, new RegExp('^' + (index + 1) + '\\.\\s*' + label, 'm').test(text))
    }
    check('写了体积（1080P 那档 120MB）', text.includes('120MB'))

    /** 卡片图：和 QQ 面板同一张卡，OneBot 用普通图片段发（它不认 markdown 图片） */
    check('渲染出来的卡片跟着面板一起发出去了', text.includes('[img:https://cdn.example.com/panel.png]'), JSON.stringify(text.slice(0, 60)))
    check('「正在加载卡片…」发过（渲染要点时间）',
      env.calls.replies.some((item) => item.includes('正在加载卡片')))
    check('卡片拿到之后把「加载中」撤了（群里不留过程消息）',
      env.calls.recalls.some((item) => item.messageId === 'msg-tip'))

    /**
     * 表情排在**消息最后一行**：曾经试过交错排（表情 → 1. … → 表情 → 2. …），
     * QQ 把中间的文本段全吞了（用户实测 5 行只剩首尾两行）。
     * 改成文字一个 text 段 + 表情排末尾，顺序和下面那排回应一致，照着数就行。
     */
    const faces = panelFaces(env)
    check('末尾排了一排表情（数 = 档位数）', faces.length === 3, faces.join(','))
    check('排出来的表情 = 要贴上去的表情（同一批 id、同序）',
      JSON.stringify(faces) === JSON.stringify(QUALITY_EMOJI.slice(0, 3)), faces.join(','))
    check('表情排在选项文字之后（不会在中间吞字）', text.endsWith('[face:301][face:320][face:333]'), JSON.stringify(text.slice(-60)))
    check('提示是「下面这排表情从左到右数」', /下面这排表情从左到右数/.test(text))

    const added = env.calls.reactions.filter((item) => item.isSet)
    check('贴的表情数 = 档位数（3 个）', added.length === 3, '实际 ' + added.length)
    const ids = added.map((item) => Number(item.emojiId))
    check('表情 id 升序（保证显示顺序 = 列表顺序）', ids.every((v, i) => i === 0 || v > ids[i - 1]), ids.join(','))
    check('用的是模块里那一排清晰度表情', JSON.stringify(added.map((i) => i.emojiId)) === JSON.stringify(QUALITY_EMOJI.slice(0, 3)), added.map((i) => i.emojiId).join(','))
    check('等着被点的面板数为 1', panel.debugPendingCount() === 1, String(panel.debugPendingCount()))
  }

  console.log('\n=== 5. 点表情 = 选画质，然后问「是否在线播放」 ===')
  {
    bind()
    panel.debugClear()
    captured.commands.length = 0
    const info = { title: 'T', author: 'A', duration: '01:00', options: options([[80, '1080P', 120], [64, '720P', 60]]) }
    const env = await send(info)
    // 用户点了「第二个表情」（720P）：它的数量从 1 变成 2
    const handled = await panel.handleReactionUpdate(reactionSession(env, 'msg-1', [
      [QUALITY_EMOJI[0], 1], [QUALITY_EMOJI[1], 2]
    ]))
    check('这次回应被认出来了', handled === true)
    const ask = env.calls.replies.find((item) => item.includes('在线播放')) ?? ''
    check('接着发了「是否在线播放」那条', !!ask, JSON.stringify(ask.slice(0, 30)))
    check('回显了刚选的画质名（720P）', ask.includes('720P'))
    check('两个选项都说清楚了', /1\.\s*在线播放/.test(ask) && /2\.\s*直接发视频/.test(ask))
    check('这两个选项前面也印了表情（478 / 479）', JSON.stringify(askFaces(env)) === JSON.stringify([YES, NO]), askFaces(env).join(','))
    check('这一步还没开始解析（要等第二个答案）', captured.commands.length === 0, captured.commands.length + ' 次')
    const yesNo = env.calls.reactions.filter((item) => item.isSet && (item.emojiId === YES || item.emojiId === NO))
    check('第二步贴的是 478 / 479 这一对', yesNo.length === 2, yesNo.map((i) => i.emojiId).join(','))
  }

  console.log('\n=== 6. 第二步选「否」：按画质直接解析 ===')
  {
    bind()
    panel.debugClear()
    captured.commands.length = 0
    const info = { title: 'T', author: 'A', duration: '01:00', options: options([[80, '1080P', 120], [64, '720P', 60]]) }
    const env = await send(info)
    await panel.handleReactionUpdate(reactionSession(env, 'msg-1', [[QUALITY_EMOJI[0], 2]]))
    await panel.handleReactionUpdate(reactionSession(env, 'msg-ask', [[YES, 1], [NO, 2]]))
    const text = captured.commands[0]?.text ?? ''
    check('跑出了一条解析命令', !!text, text)
    // --q= 后面跟的是**画质标识**（这一段的数据里 1080P 那一档的标识就是 80，和 B站 的 qn 同理）
    check('带上了选中的画质（1080P 那档 → --q=80）', text.includes('--q=80'), text)
    check('「否」不带 --play=1（就是发视频到群里）', !text.includes('--play=1'))
    check('命令里带了原始链接', text.includes(REQUEST.url))
    check('选完清晰度后，第一排表情也撤掉了（点着没反应会像卡住）',
      env.calls.reactions.some((item) => item.isSet === false && QUALITY_EMOJI.includes(item.emojiId) && item.messageId === 'msg-1'))
    const recalls = env.calls.recalls.map((item) => item.messageId)
    check('两条面板消息都撤回了', recalls.includes('msg-1') && recalls.includes('msg-ask'), recalls.join(','))
    const unset = env.calls.reactions.filter((item) => item.isSet === false)
    check('贴上去的表情全取消了（第一排 2 个 + 是/否 2 个）', unset.length === 4, unset.length + ' 个：' + unset.map((i) => i.emojiId).join(','))
  }

  console.log('\n=== 7. 第二步选「是」：在线播放 ===')
  {
    bind()
    panel.debugClear()
    captured.commands.length = 0
    const info = { title: 'T', author: 'A', duration: '01:00', options: options([[112, '1080P+', 300], [64, '720P', 60]]) }
    const env = await send(info, { request: { platform: 'bilibili' } })
    await panel.handleReactionUpdate(reactionSession(env, 'msg-1', [[QUALITY_EMOJI[0], 2]]))
    await panel.handleReactionUpdate(reactionSession(env, 'msg-ask', [[YES, 2], [NO, 1]]))
    const text = captured.commands[0]?.text ?? ''
    check('B站的画质写 --qn=112', text.includes('--qn=112'), text)
    check('「是」带上了 --play=1', text.includes('--play=1'), text)
  }

  console.log('\n=== 8. 在线播放器关着时不问，直接解析 ===')
  {
    bind({ playerEnabled: false })
    panel.debugClear()
    captured.commands.length = 0
    const info = { title: 'T', author: 'A', duration: '01:00', options: options([[80, '1080P', 120], [64, '720P', 60]]) }
    const env = await send(info)
    await panel.handleReactionUpdate(reactionSession(env, 'msg-1', [[QUALITY_EMOJI[1], 2]]))
    const ask = env.calls.replies.find((item) => item.includes('在线播放'))
    check('没有问「是否在线播放」（问了也播不了）', !ask)
    check('选完立刻解析', captured.commands.length === 1, captured.commands[0]?.text ?? '没跑')
    check('画质是点的那一档（720P → --q=64）', (captured.commands[0]?.text ?? '').includes('--q=64'), captured.commands[0]?.text ?? '')
    bind()
  }

  console.log('\n=== 9. 不该触发的时候不触发 ===')
  {
    bind()
    panel.debugClear()
    captured.commands.length = 0
    const info = { title: 'T', author: 'A', duration: '01:00', options: options([[80, '1080P', 120], [64, '720P', 60]]) }
    const env = await send(info)
    check('数量没变（只是原样回报）→ 不触发',
      (await panel.handleReactionUpdate(reactionSession(env, 'msg-1', [[QUALITY_EMOJI[0], 1], [QUALITY_EMOJI[1], 1]]))) === false)
    check('别人贴了别的表情 → 不触发',
      (await panel.handleReactionUpdate(reactionSession(env, 'msg-1', [[QUALITY_EMOJI[0], 1], [QUALITY_EMOJI[1], 1], ['999', 1]]))) === false)
    check('不是我们的消息 → 不触发',
      (await panel.handleReactionUpdate(reactionSession(env, 'msg-other', [[QUALITY_EMOJI[0], 9]]))) === false)
    check('载荷里没有 current_reactions → 不触发',
      (await panel.handleReactionUpdate({ channelId: '20001', messageId: 'msg-1', bot: env.bot })) === false)
    check('全程没有跑过解析', captured.commands.length === 0, captured.commands.length + ' 次')

    // 贴图失败时自己那一排是 0，用户点到 1 也要认得出（基准值会自动降下来）
    const second = await send(info)
    await panel.handleReactionUpdate(reactionSession(second, 'msg-1', [[QUALITY_EMOJI[0], 0], [QUALITY_EMOJI[1], 0]]))
    const triggered = await panel.handleReactionUpdate(reactionSession(second, 'msg-1', [[QUALITY_EMOJI[0], 0], [QUALITY_EMOJI[1], 1]]))
    check('机器人自己没贴成功时，用户点一下也能选中', triggered === true)
    check('并且继续走第二步（问在线播放）', second.calls.replies.some((item) => item.includes('在线播放')))
  }

  console.log('\n=== 10. 边界：只有一档 / 档位太多 / 开关关掉 ===')
  {
    bind()
    panel.debugClear()
    check('只有一档画质时不发面板（直接按它解析）',
      (await send({ title: 'T', author: 'A', duration: '01:00', options: options([[80, '1080P', 120]]) })).ok === false)

    const many = options(Array.from({ length: 13 }, (_, i) => [i, 'Q' + i, 10 * (13 - i)]))
    const envMany = await send({ title: 'T', author: 'A', duration: '01:00', options: many })
    const linesInMany = panelText(envMany).match(/\d+\.\s/g) ?? []
    check('档位多于可用表情时只列出前 10 档', linesInMany.length === 10, String(linesInMany.length))
    check('贴的表情也没超过 10 个', envMany.calls.reactions.filter((i) => i.isSet).length === 10)

    /** 拿不到卡片（没装 assets 服务 / 渲染失败）时退化成纯文字面板，不能整条不发了 */
    const envNoCard = await send({ title: 'T', author: 'A', duration: '01:00', options: options([[80, '1080P', 120], [64, '720P', 60]]) }, { noCard: true })
    check('没卡片时面板照样发出去', envNoCard.ok === true)
    check('没卡片时不带图片段', !panelText(envNoCard).includes('[img:'), panelText(envNoCard).slice(0, 40))
    check('没卡片时选项和序号照旧', /1\.\s*1080P/.test(panelText(envNoCard)))
    check('没卡片时才在文字里发作品信息（没有卡片可看，只能靠文字）', panelText(envNoCard).includes('《T》') && panelText(envNoCard).includes('UP：A'))

    /** 协议端不认 face 段时退回纯文本：面板本身比「表情印在前面」重要 */
    const envNoFace = await send({ title: 'T', author: 'A', duration: '01:00', options: options([[80, '1080P', 120], [64, '720P', 60]]) }, { env: { rejectFace: true } })
    const fallback = lastPanelText(envNoFace)
    check('face 段发不出去时退回纯文本（面板没丢）', envNoFace.ok === true && /1\.\s*1080P/.test(fallback), JSON.stringify(fallback.slice(0, 40)))
    check('退回的那条里没有表情段', panelFaces(envNoFace).length === 0, panelFaces(envNoFace).join(','))
    check('退回时改回「从左到右数第几个表情」的说法', /从左到右数第几个表情/.test(fallback))

    bind({ onebotQualityPanel: false })
    panel.debugClear()
    check('开关关掉后不发面板',
      (await send({ title: 'T', author: 'A', duration: '01:00', options: options([[80, '1080P', 120], [64, '720P', 60]]) })).ok === false)
    bind()
  }

  console.log('\n=== 11. NapCat 真发的是 group_msg_emoji_like（点表情要靠它） ===')
  {
    /**
     * 用户实测「点了没反应」的根因：NapCat 不发 `message_reactions_updated`，
     * 它发 `group_msg_emoji_like`（逐次点击上报：user_id / is_add / likes）。
     * 这里模拟 NapCat 的上报把整条链路跑一遍。
     */
    const likeSession = (env, messageId, data) => ({
      ...env.session,
      selfId: env.bot.selfId,
      onebot: { notice_type: 'group_msg_emoji_like', group_id: '20001', message_id: messageId, ...data }
    })

    bind()
    panel.debugClear()
    captured.commands.length = 0
    const info = { title: 'T', author: 'A', duration: '01:00', options: options([[80, '1080P', 120], [64, '720P', 60]]) }
    const env = await send(info)

    /** 别人点了第二个表情（720P）：上报 likes 里 count=2（机器人自己贴了 1，用户 +1） */
    const handled = await panel.handleEmojiLike(likeSession(env, 'msg-1', {
      user_id: '10002', is_add: true, likes: [{ emoji_id: QUALITY_EMOJI[1], count: 2 }]
    }))
    check('点了表情 → 认出来了（is_add=true 直接判定，不用再数）', handled === true)
    check('继续问「是否在线播放」', env.calls.replies.some((item) => item.includes('在线播放')))
    check('回显了刚选的 720P', env.calls.replies.some((item) => item.includes('已选 720P')))

    /** 第二步：同一个用户点了「是」（478） */
    await panel.handleEmojiLike(likeSession(env, 'msg-ask', {
      user_id: '10002', is_add: true, likes: [{ emoji_id: YES, count: 2 }]
    }))
    const text = captured.commands[0]?.text ?? ''
    check('落地成一条解析命令', !!text, text)
    check('选「是」带上了 --play=1', text.includes('--play=1'), text)

    /** 机器人自己贴的那排也会上报（user_id = 自己）—— 不能当成用户点 */
    panel.debugClear()
    captured.commands.length = 0
    const env2 = await send(info)
    check('机器人自己贴表情（user_id = selfId）→ 不触发',
      (await panel.handleEmojiLike(likeSession(env2, 'msg-1', {
        user_id: env2.bot.selfId, is_add: true, likes: [{ emoji_id: QUALITY_EMOJI[0], count: 1 }]
      }))) === false)
    check('取消表情（is_add=false）→ 不触发',
      (await panel.handleEmojiLike(likeSession(env2, 'msg-1', {
        user_id: '10002', is_add: false, likes: [{ emoji_id: QUALITY_EMOJI[0], count: 0 }]
      }))) === false)
    check('点了选项里没有的表情 → 不触发',
      (await panel.handleEmojiLike(likeSession(env2, 'msg-1', {
        user_id: '10002', is_add: true, likes: [{ emoji_id: '999', count: 1 }]
      }))) === false)
    check('别的消息上的表情 → 不触发',
      (await panel.handleEmojiLike(likeSession(env2, 'msg-other', {
        user_id: '10002', is_add: true, likes: [{ emoji_id: QUALITY_EMOJI[0], count: 2 }]
      }))) === false)
    check('notice_type 不是 group_msg_emoji_like → 不触发',
      (await panel.handleEmojiLike({ ...env2.session, selfId: env2.bot.selfId, onebot: { notice_type: 'notify', sub_type: 'poke' } })) === false)
    check('这几种之后面板还在等（没被误消费）', panel.debugPendingCount() === 1, String(panel.debugPendingCount()))

    /** 机器人自己贴失败（count=1，只有用户那一下）：is_add=true + 非本人 → 照样认出来 */
    const triggered = await panel.handleEmojiLike(likeSession(env2, 'msg-1', {
      user_id: '10002', is_add: true, likes: [{ emoji_id: QUALITY_EMOJI[1], count: 1 }]
    }))
    check('机器人没贴成功时用户点一下也认得（is_add 不用等计数）', triggered === true)
  }

  console.log('\n=== 12. 事件按「类型」派发 + 形状路由 ===')
  {
    /**
     * `@satorijs/core` 的 `Bot.dispatch()` 里是 `let events = [session.type]`，
     * 然后 `emit(session, event, session)` —— **`type/subtype` 那个事件名根本不会发**。
     * 所以挂 `ctx.on('onebot/message-reactions-updated')` 是死代码（这就是「点了没反应」）。
     * 只能按类型挂 `notice` / `onebot`，形状交给 handleReactionEvent 判。
     */
    /** 产物里注释会保留，注释里也写着 `ctx.on('onebot/…')` 当反例 —— 先把块注释摘掉再找 */
    const built = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const listeners = [...built.matchAll(/\.on\(\s*["']([^"']+)["']/g)].map((match) => match[1])
    check('挂了 notice 类型（NapCat 的 group_msg_emoji_like 走这里）', listeners.includes('notice'))
    check('挂了 onebot 类型（个别适配器把它归到那边）', listeners.includes('onebot'))
    /**
     * 反例：`onebot/message-reactions-updated`。适配器把 type 设成 `onebot`、subtype 设成
     * `message-reactions-updated`，而 dispatch 只发 `session.type` —— 挂组合名永远不触发。
     * （`interaction/button` 那种是适配器**直接把 type 设成组合字符串**，另当别论。）
     */
    check('没有再挂 "onebot/message-reactions-updated" 这个永远不会触发的事件名',
      !listeners.includes('onebot/message-reactions-updated'), listeners.join(','))

    /**
     * `internal/session` 是 `Bot.dispatch()` 里**按类型派发之前**无条件发的那条
     * （`@satorijs/core` 的 `src/bot.ts:181`）。挂它 = 无论适配器把载荷归成什么 type，
     * 都能看见「协议端到底发没发」，这是排查「点了没反应」唯一靠得住的证据来源。
     */
    check('挂了 internal/session（所有入站事件都跑不掉的那条）', listeners.includes('internal/session'), listeners.join(','))

    /**
     * `koishi-plugin-adapter-napcat` 会把 `group_msg_emoji_like` **转成标准的**
     * `reaction-added` / `reaction-removed` —— 装的是它的话，前面那两个类型都不会响。
     */
    check('也接了 adapter-napcat 转出来的 reaction-added / reaction-removed',
      listeners.includes('reaction-added') && listeners.includes('reaction-removed'), listeners.join(','))

    bind()
    panel.debugClear()
    captured.commands.length = 0
    const info = { title: 'T', author: 'A', duration: '01:00', options: options([[80, '1080P', 120], [64, '720P', 60]]) }
    const env = await send(info)
    const evt = (data) => ({ ...env.session, selfId: env.bot.selfId, onebot: data })

    /** 路由：NapCat 形状 → emoji 那条 */
    const routed = await panel.handleReactionEvent(evt({
      notice_type: 'group_msg_emoji_like', group_id: '20001', message_id: 'msg-1',
      user_id: '10002', is_add: true, likes: [{ emoji_id: QUALITY_EMOJI[1], count: 2 }]
    }))
    check('路由：group_msg_emoji_like → emoji 那条（并且认出来了）', routed === true)
    check('真的走了第二步（问在线播放）', env.calls.replies.some((item) => item.includes('已选 720P')))

    /** 路由：OneBot 标准的快照形状 → 老的计数差值那条 */
    panel.debugClear()
    const env2 = await send(info)
    const snap = await panel.handleReactionEvent({
      ...env2.session, selfId: env2.bot.selfId, subtype: 'message-reactions-updated', messageId: 'msg-1',
      onebot: { current_reactions: [{ emoji_id: QUALITY_EMOJI[0], count: 1 }, { emoji_id: QUALITY_EMOJI[1], count: 2 }] }
    })
    check('路由：current_reactions 快照 → 计数差值那条', snap === true)
    check('同样走到了第二步', env2.calls.replies.some((item) => item.includes('已选 720P')))

    /** 不认识的形状：不能崩、也不能误当选中 */
    panel.debugClear()
    const env3 = await send(info)
    check('路由：不认识的形状 → 不触发（只打日志）', (await panel.handleReactionEvent(evt({
      notice_type: 'reaction', sub_type: 'add', group_id: '20001', message_id: 'msg-1', user_id: '10002'
    }))) === false)
    check('不认识的形状不会误消费面板', panel.debugPendingCount() === 1, String(panel.debugPendingCount()))
    check('路由：非 notice 的普通事件 → 不触发', (await panel.handleReactionEvent({ ...env3.session, onebot: {} })) === false)
    check('路由：空 session → 不触发', (await panel.handleReactionEvent(null)) === false)

    /**
     * 另一套适配器（adapter-napcat）的标准形状：我们还没见过它的字段，
     * 所以**先原样留证**（拿到一行真实载荷才能补精确映射），但绝不能误判成选中。
     */
    panel.debugClear()
    const env4 = await send(info)
    const start = logLines.length
    check('路由：reaction-added（另一套适配器的形状）→ 不误判',
      (await panel.handleReactionEvent({
        ...env4.session, type: 'reaction-added', onebot: {}, event: { reaction: { emoji: { id: 'face|301' } } }
      })) === false)
    check('  把原始载荷打了出来（好照着补映射）',
      logLines.slice(start).some((item) => item.includes('reaction 类事件')), logLines.slice(start).join(' | ').slice(0, 160))
    check('  面板没被误消费', panel.debugPendingCount() === 1, String(panel.debugPendingCount()))
  }

  console.log('\n=== 12b. 监听机制本身：插件子上下文能收到 app 发的事件 ===')
  {
    /**
     * 上面那条「只派发 session.type」的规则决定了要按类型挂监听；
     * 而按类型挂能不能收到，取决于 Koishi 的事件传递 —— 这里用真 Context 验一遍：
     * 插件（子上下文）注册的监听，能不能收到根上下文 `bot.dispatch()` 那样发出来的事件。
     */
    const { Context } = require('koishi')
    const root = new Context()
    const seen = []
    root.plugin({
      name: 'probe-child',
      apply: (ctx) => {
        ctx.on('my-plain', () => seen.push('plain'))
        ctx.on('notice', (session) => seen.push('notice:' + String(session?.mark ?? '-')))
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    root.emit('my-plain')
    const fake = { mark: 'A', args: [], ctx: root }
    root.emit(fake, 'notice', fake)
    check('子上下文收到了根上下文发的普通事件', seen.includes('plain'), JSON.stringify(seen))
    check('子上下文收到了「session 优先」重载发的事件（bot.dispatch 就是这么发的）',
      seen.includes('notice:A'), JSON.stringify(seen))
  }

  console.log('\n=== 13. 文字退路：引用面板消息回序号也能选 ===')
  {
    /** 协议端一个表情事件都不发时，这是唯一还能用的路 —— 否则链接永远解析不了 */
    const textSession = (env, quoteId, content, extra = {}) => ({
      ...env.session, selfId: env.bot.selfId, content, quote: { id: quoteId }, ...extra
    })

    bind()
    panel.debugClear()
    captured.commands.length = 0
    const info = { title: 'T', author: 'A', duration: '01:00', options: options([[80, '1080P', 120], [64, '720P', 60]]) }
    const env = await send(info)
    check('面板上写了这条退路（不然用户不知道能这么用）', /引用本条消息/.test(panelText(env)))

    check('引用面板消息回 "2" → 选中第二档',
      (await panel.trySelectByText(textSession(env, 'msg-1', '2'))) === true)
    check('回显了 720P', env.calls.replies.some((item) => item.includes('已选 720P')))
    check('这一步还没开始解析', captured.commands.length === 0, captured.commands.length + ' 次')

    /** 第二步同样支持 */
    await panel.trySelectByText(textSession(env, 'msg-ask', '1'))
    const text = captured.commands[0]?.text ?? ''
    check('第二步回 "1" → 在线播放（--play=1）', text.includes('--play=1'), text)

    /** 该拒绝的都要拒绝（不引用的裸数字见下面单独一段） */
    panel.debugClear()
    const env2 = await send(info)
    check('引用的不是面板消息 → 不认', (await panel.trySelectByText(textSession(env2, 'msg-other', '2'))) === false)
    check('序号超出档位数 → 不认', (await panel.trySelectByText(textSession(env2, 'msg-1', '3'))) === false)
    check('不是数字 → 不认', (await panel.trySelectByText(textSession(env2, 'msg-1', '我要这个'))) === false)
    check('两位数但超范围 → 不认', (await panel.trySelectByText(textSession(env2, 'msg-1', '99'))) === false)
    check('这些都没有消费掉面板', panel.debugPendingCount() === 1, String(panel.debugPendingCount()))
    check('然后正常选一下还是好使', (await panel.trySelectByText(textSession(env2, 'msg-1', '1'))) === true)

    /**
     * 没引用时：只认「发链接的那个人自己回的数字」，而且只认刚发出去那三分钟。
     * 协议端一个表情事件都不发时，这是摩擦最小的一条路（不用教用户「引用」这个动作）。
     */
    panel.debugClear()
    captured.commands.length = 0
    const env4 = await send(info)
    check('没引用、但发链接的人直接回 "2" → 也认', (await panel.trySelectByText(textSession(env4, '', '2'))) === true)
    check('  同样回显了 720P', env4.calls.replies.some((item) => item.includes('已选 720P')))
    /**
     * 这一步选完就换成第二步那个面板了（计数还是 1）—— 所以要看的是
     * 「原来那条选画质的面板已经不在了」：拿它的消息号再选一次必须点不动。
     */
    check('  原来那条「选画质」面板确实被消费了（再用它的消息号点不动）',
      (await panel.trySelectByText(textSession(env4, 'msg-1', '1'))) === false)
    check('面板上写清了这条（不然用户不知道能直接回数字）', /直接回数字/.test(panelText(env4)))

    panel.debugClear()
    const env5 = await send(info)
    check('别人（不是发链接的人）没引用回 "2" → 不认',
      (await panel.trySelectByText(textSession(env5, '', '2', { userId: '10002' }))) === false)
    check('  面板还留着', panel.debugPendingCount() === 1, String(panel.debugPendingCount()))

    /** 时间窗：过期之后连发链接的人自己都不认了 —— 常量在模块里，这里钉住它的值 */
    check('「直接回数字」的窗口是 3 分钟', panel.PLAIN_REPLY_WINDOW_MS === 3 * 60 * 1000,
      String(panel.PLAIN_REPLY_WINDOW_MS))

    /** 开关关掉时文字退路也要跟着关（先按开着发一个面板，再把开关关掉） */
    panel.debugClear()
    const env3 = await send(info)
    bind({ onebotQualityPanel: false })
    check('总开关关掉 → 文字退路也不认', (await panel.trySelectByText(textSession(env3, 'msg-1', '1'))) === false)
    check('面板也没被误消费', panel.debugPendingCount() === 1, String(panel.debugPendingCount()))
    bind()
  }

  console.log('\n=== 14. 协议端老到没有 set_msg_emoji_like 时：面板照样能发，退路顶上 ===')
  {
    /** NapCat 要 v4.12.1+ 才有这一套；老实例上「贴表情」和「点击事件」会一起失效 */
    bind()
    panel.debugClear()
    captured.commands.length = 0
    const info = { title: 'T', author: 'A', duration: '01:00', options: options([[80, '1080P', 120], [64, '720P', 60]]) }
    const env = await send(info, { env: { noReactionApi: true } })
    check('面板还是发出去了（贴不上表情不等于面板作废）', env.ok === true)
    check('确实一个表情都没贴上去', env.calls.reactions.length === 0, String(env.calls.reactions.length))
    check('选项文字照样完整', /1\.\s*1080P/.test(panelText(env)) && /2\.\s*720P/.test(panelText(env)))
    check('等着被点的面板数为 1', panel.debugPendingCount() === 1, String(panel.debugPendingCount()))
    check('这种实例上文字退路能救回来（回 "1" 选 1080P）',
      (await panel.trySelectByText({
        ...env.session, selfId: env.bot.selfId, content: '1', quote: { id: '' }
      })) === true)
    check('  接着问了「是否在线播放」', env.calls.replies.some((item) => item.includes('已选 1080P')))
    /** 第二步回答「2 = 直接发视频」，这时候才真正落地成解析命令 */
    await panel.trySelectByText({ ...env.session, selfId: env.bot.selfId, content: '2', quote: { id: 'msg-ask' } })
    const text = captured.commands[0]?.text ?? ''
    check('  真的跑了解析命令（带选中的画质）', text.includes('--q=80'), text)
  }

  console.log('\n=== 15. 「协议端到底发没发」总探针（internal/session） ===')
  {
    const { noteInboundSession } = panel
    check('导出了这个函数（index.ts 把它挂在 internal/session 上）', typeof noteInboundSession === 'function')
    check('是同步的（挂在事件上不该返回 Promise）',
      noteInboundSession({ type: 'notice', onebot: { notice_type: 'group_upload' } }) === undefined)

    /** 拿一段日志行：只取这段时间里新产生的 */
    const logsSince = (from) => logLines.slice(from)

    /** 没有面板在等、载荷也不像表情事件 → 完全静默（平时不许刷日志） */
    panel.debugClear()
    {
      const from = logLines.length
      noteInboundSession({ type: 'notice', onebot: { notice_type: 'group_upload' } })
      noteInboundSession({ type: 'notice', onebot: { notice_type: 'notify', sub_type: 'poke' } })
      check('没有面板在等时静默', logsSince(from).length === 0, logsSince(from).join(' | ').slice(0, 120))
    }

    /** 有面板在等时：不管什么类型都要能被记下来（哪怕 type 被适配器改写成别的） */
    bind()
    panel.debugClear()
    captured.commands.length = 0
    const info = { title: 'T', author: 'A', duration: '01:00', options: options([[80, '1080P', 120], [64, '720P', 60]]) }
    const env = await send(info)
    check('面板已挂上（有面板在等才开会话日志）', panel.debugPendingCount() === 1, String(panel.debugPendingCount()))

    const from = logLines.length
    noteInboundSession({ type: 'notice', subtype: undefined, channelId: '20001', messageId: 'msg-1',
      userId: '10002', onebot: { notice_type: 'group_msg_emoji_like', group_id: '20001', likes: [] } })
    noteInboundSession({ type: 'message-created', channelId: '20001' })
    noteInboundSession({ type: 'onebot', subtype: 'message-reactions-updated', channelId: '20001',
      onebot: { current_reactions: [] } })
    const lines = logsSince(from)
    check('面板等着时，一条 notice 被记下来了', lines.some((item) => item.includes('group_msg_emoji_like')), lines.join(' | ').slice(0, 120))
    check('  记下了 type / notice_type / channel / message / user', lines.some((item) =>
      item.includes('type=notice') && item.includes('notice_type=group_msg_emoji_like')
      && item.includes('channel=20001') && item.includes('message=msg-1') && item.includes('user=10002')),
    lines.join(' | ').slice(0, 200))
    /**
     * 注意别用 `includes('type=message')` 判：`subtype=message-reactions-updated` 里也含这一串，
     * 会假阳性。按「独立词」匹配。
     */
    check('普通消息跳过（群里刷屏会把日志冲没）',
      !lines.some((item) => /(^|\s)type=message(-created)?(\s|$)/.test(item)), lines.join(' | ').slice(0, 120))
    check('被归到 onebot 类型的也记下来了', lines.filter((item) => item.includes('type=onebot')).length === 1, String(lines.length))
    check('面板发出的那行日志里有「贴表情成功 n/m」这个关键证据',
      logsSince(0).some((item) => /贴表情成功 \d+\/\d+/.test(item)),
      logsSince(0).filter((item) => item.includes('贴表情成功')).join(' | ').slice(0, 120))

    /** 没有面板、但载荷长得像表情事件 → 也必须留证（说明我们对不上号） */
    panel.debugClear()
    {
      const start = logLines.length
      noteInboundSession({ type: 'notice', channelId: '20001', onebot: { notice_type: 'group_reaction_add' } })
      check('没有面板在等、但 notice_type 像表情事件 → 照样记下来',
        logsSince(start).some((item) => item.includes('group_reaction_add')), logsSince(start).join(' | ').slice(0, 120))
    }

    /** 适配器把 onebot 载荷藏在 event._data 上时也要能打出来 */
    {
      const start = logLines.length
      noteInboundSession({ type: 'notice', channelId: '20001', event: { _type: 'onebot', _data: { notice_type: 'group_reaction_add' } } })
      check('载荷只在 event._data 上时也能打出来',
        logsSince(start).some((item) => item.includes('group_reaction_add')), logsSince(start).join(' | ').slice(0, 120))
    }

    /** 没有 onebot 载荷（别的适配器的 notice）也不许崩 */
    let crashed = null
    try { noteInboundSession({ type: 'notice' }) } catch (error) { crashed = error }
    check('没有 onebot 载荷时不抛异常', crashed === null, String(crashed))

    /** 群里别的东西不该被误当成表情回应 */
    panel.debugClear()
    check('面板清掉之后普通 notice 不再记（日志不会一直挂着）', (() => {
      const start = logLines.length
      noteInboundSession({ type: 'notice', onebot: { notice_type: 'group_recall' } })
      return logsSince(start).length === 0
    })())
  }

  console.log('\n=== 16. 兼容层：怎么调「谁贴了这个表情」（fetch_emoji_like） ===')
  {
    const kkk = (raw) => new KkkBot(raw)

    /** ① 有别名方法（别的实现可能叫这个名字），挂在 bot 本体上 */
    const viaBot = []
    const got1 = await kkk({
      platform: 'onebot',
      fetchEmojiLike: async (...args) => {
        viaBot.push(args)
        return { emojiLikesList: [{ tinyId: '10002' }, { tinyId: '10003' }] }
      }
    }).fetchEmojiLikes('85030312', '301')
    check('别名 fetchEmojiLike 在 bot 本体上 → 认得', JSON.stringify(got1) === JSON.stringify(['10002', '10003']), JSON.stringify(got1))
    check('  参数按 (消息ID, 表情ID, 条数) 传出去',
      JSON.stringify(viaBot) === JSON.stringify([[85030312, 301, 20]]), JSON.stringify(viaBot))

    /** ② 别名挂在 bot.internal 上（OneBot 适配器全是这个挂法） */
    const viaInternal = []
    const got2 = await kkk({
      platform: 'onebot',
      internal: {
        getEmojiLikes: async (...args) => { viaInternal.push(args); return { emojiLikesList: [{ tinyId: 10004 }] } }
      }
    }).fetchEmojiLikes('85030312', '301')
    check('别名 getEmojiLikes 挂在 bot.internal 上 → 也认得', JSON.stringify(got2) === JSON.stringify(['10004']), JSON.stringify(got2))

    /**
     * ③ 适配器**没有** define `fetch_emoji_like`（只有 set_msg_emoji_like），
     *    所以真实环境走的是通用入口 `internal._get(action, params)` —— 它会自己拆
     *    `{retcode, data}` 信封。这条是线上真正会走的那条。
     */
    const viaGet = []
    const got3 = await kkk({
      platform: 'onebot',
      internal: {
        _get: async (action, params) => { viaGet.push([action, params]); return { emojiLikesList: [{ tinyId: '10005' }], cookie: '', isLastPage: true, isFirstPage: true } }
      }
    }).fetchEmojiLikes('85030312', '301')
    check('走通用入口 internal._get', JSON.stringify(viaGet) === JSON.stringify([['fetch_emoji_like', { message_id: 85030312, emoji_id: 301, count: 20 }]]), JSON.stringify(viaGet))
    check('  从 emojiLikesList 里取出了 tinyId', JSON.stringify(got3) === JSON.stringify(['10005']), JSON.stringify(got3))

    /** ③b 动作名不止一个：`fetch_emoji_like` 不被认时自动试 `get_emoji_likes` */
    const triedActions = []
    const got3b = await kkk({
      platform: 'onebot',
      internal: {
        _get: async (action) => {
          triedActions.push(action)
          if (action === 'fetch_emoji_like') throw new Error('unknown action')
          return { emojiLikesList: [{ tinyId: '10007' }] }
        }
      }
    }).fetchEmojiLikes('85030312', '301')
    check('fetch_emoji_like 不被认时自动试 get_emoji_likes',
      JSON.stringify(triedActions) === JSON.stringify(['fetch_emoji_like', 'get_emoji_likes']), triedActions.join(','))
    check('  从第二个动作名拿到了结果', JSON.stringify(got3b) === JSON.stringify(['10007']), JSON.stringify(got3b))

    /** ④ 连 _get 都没有时退回 _request，自己看 retcode */
    const got4 = await kkk({
      platform: 'onebot',
      internal: { _request: async () => ({ status: 'ok', retcode: 0, data: { emojiLikesList: [{ tinyId: '10006' }] } }) }
    }).fetchEmojiLikes('85030312', '301')
    check('退回 _request 时认得 retcode=0 + data', JSON.stringify(got4) === JSON.stringify(['10006']), JSON.stringify(got4))

    const got4b = await kkk({
      platform: 'onebot',
      internal: { _request: async () => ({ status: 'failed', retcode: 1404, data: null }) }
    }).fetchEmojiLikes('85030312', '301')
    check('  retcode ≠ 0 → 返回 null（问不到，不是「没人贴」）', got4b === null, String(got4b))

    /** ⑤ 什么接口都没有 / 调用抛错 —— 都必须返回 null，不能把异常抛给轮询 */
    check('没有任何查询接口 → null', (await kkk({ platform: 'onebot' }).fetchEmojiLikes('1', '2')) === null)
    check('调用抛错 → null（不冒泡）', (await kkk({
      platform: 'onebot',
      internal: { _get: async () => { throw new Error('boom') } }
    }).fetchEmojiLikes('1', '2')) === null)

    /**
     * ⑥ 大 id **不能强转成数字**：QQ 有些消息 id 是 19 位，超出 JS 安全整数，
     *    转过去就变成另一个数（问错消息）。适配器自己的规则也是「|值| < 2^32 才转」。
     */
    const bigSeen = []
    await kkk({
      platform: 'onebot',
      internal: { _get: async (action, params) => { bigSeen.push(params); return { emojiLikesList: [] } } }
    }).fetchEmojiLikes('7330000000000000001', '301')
    check('19 位消息 id 原样传字符串（不强转，转了就不是同一条消息了）',
      bigSeen[0]?.message_id === '7330000000000000001', JSON.stringify(bigSeen[0]))
    check('  小 id 才转成数字（协议端要 integer）', typeof bigSeen[0]?.emoji_id === 'number', typeof bigSeen[0]?.emoji_id)

    /** ⑦ 返回空列表 = 「确实没人贴」，和 null（问不到）必须能分开 */
    const empty = await kkk({
      platform: 'onebot',
      internal: { _get: async () => ({ emojiLikesList: [] }) }
    }).fetchEmojiLikes('1', '2')
    check('没人贴 = 空数组（不是 null）', Array.isArray(empty) && empty.length === 0, JSON.stringify(empty))
  }

  console.log('\n=== 17. 推送不来时的第二条路：主动轮询 ===')
  {
    /** 让 `trackPanelForPolling` 里那串异步（问基线）落地 */
    const tick = () => new Promise((resolve) => setTimeout(resolve, 8))
    const info = { title: 'T', author: 'A', duration: '01:00', options: options([[80, '1080P', 120], [64, '720P', 60]]) }

    bind()
    panel.debugClear()
    captured.commands.length = 0

    /** 基线：机器人自己贴的那排（`emojiLikesList` 里就是机器人） */
    const likes = { [QUALITY_EMOJI[0]]: ['3889000'], [QUALITY_EMOJI[1]]: ['3889000'] }
    const env = await send(info, { env: { likes } })
    await tick()
    check('面板发出后先问了一遍基线（每档一次）', env.calls.likes.length === 2, String(env.calls.likes.length))
    check('  问的是面板那条消息 + 该档的表情 id',
      env.calls.likes.every((item) => item.messageId === 'msg-1')
      && env.calls.likes.map((item) => String(item.emojiId)).join(',') === QUALITY_EMOJI.slice(0, 2).join(','),
    JSON.stringify(env.calls.likes))

    check('基线里只有机器人自己 → 一轮轮询不误判', (await panel.debugPollOnce()) === 0)

    /**
     * 有人点了第二档：那一档的列表里多出一个非机器人用户。
     *
     * ⚠️ 第二步（478 / 479）的基线是在**这一轮轮询里**（发提问消息时）抓的，
     * 所以那两个表情得**先**把机器人自己放进去，否则等会儿机器人也会被当成「新出现的人」。
     */
    likes[YES] = ['3889000']
    likes[NO] = ['3889000']
    likes[QUALITY_EMOJI[1]] = ['3889000', '10002']
    const picked = await panel.debugPollOnce()
    check('轮询发现有人点了第 2 档', picked === 1, String(picked))
    check('  接着问了「是否在线播放」', env.calls.replies.some((item) => item.includes('已选 720P')))
    check('  这一步还没解析（要等第二个答案）', captured.commands.length === 0, captured.commands.length + ' 次')

    /** 第二步（478 / 479）也要能轮询：这次只给「否」加一个人 */
    await tick()
    likes[NO] = ['3889000', '10002']
    const pickedWatch = await panel.debugPollOnce()
    check('第二步也被轮询认出来了', pickedWatch === 1, String(pickedWatch))
    const text = captured.commands[0]?.text ?? ''
    check('  选了「2 = 直接发视频」→ 按选好的画质解析、不带 --play',
      text.includes('--q=64') && !text.includes('--play=1'), text)

    /** 机器人自己的 id 永远不算点击 */
    panel.debugClear()
    const env2 = await send(info, { env: { likes: { [QUALITY_EMOJI[0]]: ['3889000'] } } })
    await tick()
    env2.calls.likes.length = 0
    const noFalse = [(await panel.debugPollOnce()), (await panel.debugPollOnce()), (await panel.debugPollOnce())]
    check('只有机器人自己贴过 → 连问三轮都不误判', noFalse.every((item) => item === 0), noFalse.join(','))

    /** 协议端没有这个接口：判定一次就停，绝不反复打 */
    panel.debugClear()
    /** 日志要在**发面板之前**开始收：那条提示是抓基线的时候（异步）就打出来的 */
    const before = logLines.length
    const env3 = await send(info, { env: { noFetchApi: true } })
    await tick()
    check('协议端没有这个接口 → 不误判', (await panel.debugPollOnce()) === 0)
    check('  留了一条日志说清楚（不然又是一轮「点了没反应」的猜谜）',
      logLines.slice(before).some((item) => item.includes('查不到表情回应')), logLines.slice(before).join(' | ').slice(0, 140))
    check('  之后没有再拿它打过接口', env3.calls.likes.length === 0, String(env3.calls.likes.length))

    /** 一个表情都没贴上去 → 压根不轮询（没人有表情可点，问了也白问） */
    panel.debugClear()
    const env4 = await send(info, { env: { noReactionApi: true, likes: {} } })
    await tick()
    check('贴不上表情就不轮询（省掉没意义的接口调用）', env4.calls.likes.length === 0, String(env4.calls.likes.length))

    /** 总开关关掉 → 一轮都不做 */
    panel.debugClear()
    const env5 = await send(info, { env: { likes: {} } })
    await tick()
    env5.calls.likes.length = 0
    bind({ onebotQualityPanel: false })
    const offResult = await panel.debugPollOnce()
    check('总开关关掉 → 轮询一轮也不做', offResult === 0 && env5.calls.likes.length === 0, String(env5.calls.likes.length))
    bind()

    /** 面板没了就不再问接口（定时器要能自己停） */
    panel.debugClear()
    const env6 = await send(info, { env: { likes: {} } })
    await tick()
    env6.calls.likes.length = 0
    panel.debugClear()
    const idleResult = await panel.debugPollOnce()
    check('没有面板在等 → 不再打接口', idleResult === 0 && env6.calls.likes.length === 0, String(env6.calls.likes.length))
  }

  /**
   * 18. message_id 的「形态」对不上时也要认得出来。
   *
   * OneBot11 的 `message_id` 是 int32，而面板记下的是适配器给的字符串 ——
   * 大 id 被截成 32 位有符号整数之后长得完全不一样（`2975774273` → `-1319195023`，
   * 这个数就是用户日志里那条的来路）。直接 `===` 比就会永远对不上号。
   */
  console.log('\n=== 18. message_id 被截成 int32（负数）也要认得 ===')
  {
    const likeSession = (env, messageId, data) => ({
      ...env.session,
      selfId: env.bot.selfId,
      onebot: { notice_type: 'group_msg_emoji_like', group_id: '20001', message_id: messageId, ...data }
    })
    const info = { title: 'T', author: 'A', duration: '01:00', options: options([[80, '1080P', 120], [64, '720P', 60]]) }
    /**
     * 面板记下的是无符号的大 id；协议端上报的是它被截成 int32 之后的样子。
     * 这两个数就是用户日志里那条 `message_id: -1319195023` 的来路。
     */
    const BIG = '2975772273'
    const WRAPPED = String(Number(BIG) | 0) // -1319195023

    bind()
    panel.debugClear()
    captured.commands.length = 0
    const env = await send(info, { env: { panelMessageId: BIG, likes: {} } })
    check('前置：这两个 id 长得确实不一样', WRAPPED !== BIG, WRAPPED + ' vs ' + BIG)
    check('面板记下的是无符号那个', env.calls.reactions.every((item) => item.messageId === BIG),
      env.calls.reactions.map((i) => i.messageId).join(','))

    const handled = await panel.handleEmojiLike(likeSession(env, WRAPPED, {
      user_id: '10002', is_add: true, likes: [{ emoji_id: QUALITY_EMOJI[1], count: 2 }]
    }))
    check('上报成 int32 负数 → 照样认出来（不会「点了没反应」）', handled === true)
    check('  选中了第 2 档（720P），继续问在线播放', env.calls.replies.some((item) => item.includes('已选 720P')))

    /** 用过的面板要真的被摘掉：同一个事件再来一遍不能重复触发 */
    check('  同一个事件再来一遍 → 不再触发',
      (await panel.handleEmojiLike(likeSession(env, WRAPPED, {
        user_id: '10002', is_add: true, likes: [{ emoji_id: QUALITY_EMOJI[1], count: 2 }]
      }))) === false)

    /** 完全无关的 id：不能靠「同一个群里唯一命中」蒙对（301 这些是常用小黄脸，会误认） */
    panel.debugClear()
    const env2 = await send(info, { env: { panelMessageId: BIG, likes: {} } })
    check('别的消息上贴了同样的表情 → 不触发（不做「同群唯一命中」的宽松匹配）',
      (await panel.handleEmojiLike(likeSession(env2, '-999', {
        user_id: '10002', is_add: true, likes: [{ emoji_id: QUALITY_EMOJI[0], count: 2 }]
      }))) === false)
    check('  面板还在等（没被误消费）', panel.debugPendingCount() === 1, String(panel.debugPendingCount()))

    /** 无符号 / 去负号这两种写法也要认 */
    check('上报无符号（2975774273）→ 认出来',
      (await panel.handleEmojiLike(likeSession(env2, BIG, {
        user_id: '10002', is_add: true, likes: [{ emoji_id: QUALITY_EMOJI[1], count: 2 }]
      }))) === true)
    panel.debugClear()
  }

  /**
   * 19. `EmojiReaction` 在 OneBot 上必须给**真的 QQ 表情 id**。
   *
   * 之前它读 `e.bot.adapter.platform`，而 `e.bot` 是 KkkBot 包装、`.adapter` 是适配器信息
   * （上面没有 platform），于是 `|| 'other'` 永远生效 —— 连官方 QQ 都会落到占位符那一档。
   * 实锤就是用户日志里那条
   * `set_msg_emoji_like { emoji_id: 'OTHER_PROCESSING_PLACEHOLDER', set: false }`：
   * 拿一串占位符当表情 id 发给协议端，协议端根本不认。
   */
  console.log('\n=== 19. EmojiReaction 在 OneBot 上给真表情 id（不是占位符） ===')
  {
    const emoji = require(path.join(lib, 'karin/module/utils/EmojiReaction.js'))

    const onebot = emoji.getEmojiId({ bot: { platform: 'onebot' } }, 'PROCESSING')
    const napcat = emoji.getEmojiId({ bot: { platform: 'napcat' } }, 'PROCESSING')
    const lagrange = emoji.getEmojiId({ bot: { platform: 'lagrange' } }, 'PROCESSING')
    const qq = emoji.getEmojiId({ bot: { platform: 'qq' } }, 'PROCESSING')
    const wechat = emoji.getEmojiId({ bot: { platform: 'wechat' } }, 'PROCESSING')

    check('OneBot → 数字表情 id（366，QQ 系统表情）', onebot === 366, String(onebot))
    check('NapCat 也是同一套', napcat === 366, String(napcat))
    check('Lagrange 也是同一套', lagrange === 366, String(lagrange))
    check('官方 QQ → 数字表情 id', qq === 366, String(qq))
    check('  不是 OTHER_…_PLACEHOLDER 那种占位符', !String(qq).includes('PLACEHOLDER'), String(qq))
    check('真不认 QQ 表情的平台（微信）仍然给占位符', typeof wechat === 'string' && wechat.includes('PLACEHOLDER'), String(wechat))

    /**
     * 关键：包装过的 KkkBot（真实链路里 `e.bot` 就是这个）也要认。
     * `platformOf` 会穿透 `e.bot.bot.platform`。
     */
    const kkkBot = new KkkBot({ platform: 'onebot', selfId: '3889000' })
    check('e.bot 是 KkkBot 包装时也一样（穿透包装拿平台名）',
      emoji.getEmojiId({ bot: kkkBot }, 'PROCESSING') === 366,
      String(emoji.getEmojiId({ bot: kkkBot }, 'PROCESSING')))
    check('  「成功/失败」两档也都不是占位符',
      emoji.getEmojiId({ bot: { platform: 'onebot' } }, 'SUCCESS') === 389
      && emoji.getEmojiId({ bot: { platform: 'onebot' } }, 'ERROR') === 379)
  }

  console.log('\n' + (failed ? '\u2718 有 ' + failed + ' 项没通过' : '\u2714 全部通过'))
  process.exit(failed ? 1 : 0)
})().catch((error) => {
  console.error('\n探针崩了：', error?.stack ?? error)
  process.exit(1)
})
