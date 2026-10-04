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
  ctx: { config: { port: 5200, prefix: '' } },
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

/* ------------------------------------------------------------------ *
 * 假的环境：一个 OneBot 机器人 + 一条群消息
 * ------------------------------------------------------------------ */
const makeEnv = (platform = 'onebot', isGroup = true) => {
  const calls = { reactions: [], replies: [], recalls: [] }
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
    send: async (content) => { calls.replies.push(String(content)); return ['msg-ask'] }
  }
  const e = {
    msg: 'https://v.douyin.com/abc123/',
    userId: '10001', groupId: '20001', isGroup,
    contact: { peer: '20001', isGroup },
    bot: { ...bot, setMsgEmojiLike: bot.setMsgEmojiLike },
    session,
    reply: async (content) => { calls.replies.push(String(content)); return { messageId: 'msg-1' } }
  }
  return { e, bot, calls, session }
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

/** 把面板真正发出去（已经 stub 掉拉作品信息那一步） */
const send = async (info, extra = {}) => {
  qqPanel.fetchPanelInfo = async () => info
  const env = makeEnv(extra.platform ?? 'onebot', extra.isGroup ?? true)
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
    const text = env.calls.replies[0] ?? ''
    check('文本里有作品信息', text.includes('这段路到底能不能走') && text.includes('某个UP'), JSON.stringify(text.slice(0, 40)))
    for (const [index, label] of ['1080P', '720P', '480P'].entries()) {
      check('第 ' + (index + 1) + ' 行 = ' + label, new RegExp('^' + (index + 1) + '\\.\\s*' + label, 'm').test(text))
    }
    check('提示了「从左到右数第几个表情」', /第几个表情/.test(text))
    check('写了体积（1080P 那档 120MB）', text.includes('120MB'))

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
    const linesInMany = (envMany.calls.replies[0] ?? '').match(/^\d+\.\s/gm) ?? []
    check('档位多于可用表情时只列出前 10 档', linesInMany.length === 10, String(linesInMany.length))
    check('贴的表情也没超过 10 个', envMany.calls.reactions.filter((i) => i.isSet).length === 10)

    bind({ onebotQualityPanel: false })
    panel.debugClear()
    check('开关关掉后不发面板',
      (await send({ title: 'T', author: 'A', duration: '01:00', options: options([[80, '1080P', 120], [64, '720P', 60]]) })).ok === false)
    bind()
  }

  console.log('\n' + (failed ? '\u2718 有 ' + failed + ' 项没通过' : '\u2714 全部通过'))
  process.exit(failed ? 1 : 0)
})().catch((error) => {
  console.error('\n探针崩了：', error?.stack ?? error)
  process.exit(1)
})
