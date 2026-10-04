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
 *   ⑧ 无关表情、数量没变都不会误触发。
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

require(path.join(lib, 'compat/logger.js')).setLogger({
  debug () {}, info () {}, mark () {},
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
  const calls = { reactions: [], replies: [], raw: [], recalls: [] }
  const bot = {
    platform,
    selfId: '3889000',
    setMsgEmojiLike: async (messageId, emojiId, isSet) => {
      calls.reactions.push({ messageId, emojiId, isSet })
      return true
    },
    // 兼容层的 recallMsg 走的是 Koishi 标准的 deleteMessage(channel, messageId)
    deleteMessage: async (channel, messageId) => { calls.recalls.push({ messageId, channelId: channel }) }
  }
  const session = {
    channelId: '20001', guildId: '20001', userId: '10001', platform, bot,
    send: async (content) => { calls.replies.push(renderContent(content)); calls.raw.push(content); return ['msg-ask'] }
  }
  const e = {
    msg: 'https://v.douyin.com/abc123/',
    userId: '10001', groupId: '20001', isGroup,
    contact: { peer: '20001', isGroup },
    bot: { ...bot, setMsgEmojiLike: bot.setMsgEmojiLike },
    session,
    reply: async (content) => {
      const text = renderContent(content)
      calls.replies.push(text)
      calls.raw.push(content)
      // 模拟「协议端不认 face 段」：整条消息发送失败，用来验证退回纯文本那条路
      if (opts.rejectFace && facesOf(content).length) throw new Error('unsupported segment: face')
      // 「正在加载卡片…」是过程提示，给它单独的 id，免得和面板那条混在一起
      return { messageId: text.includes('正在加载卡片') ? 'msg-tip' : 'msg-1' }
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

  console.log('\n' + (failed ? '\u2718 有 ' + failed + ' 项没通过' : '\u2714 全部通过'))
  process.exit(failed ? 1 : 0)
})().catch((error) => {
  console.error('\n探针崩了：', error?.stack ?? error)
  process.exit(1)
})
