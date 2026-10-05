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

/**
 * 各平台的「解析时发送的内容」。
 *
 * 面板要先看这里**有没有勾 video**：没勾就不该问清晰度（`willSendVideo`）。
 * 探针必须带上它 —— 缺了就轮到去读磁盘上的 config.json，那会把「配置是什么」这件事
 * 交给环境，用例就不稳了。
 */
const FULL_SEND_CONTENT = ['info', 'comment', 'video']
const bind = (extra = {}) => runtime.bindRuntime({
  // assets 服务：面板卡片要靠它转存成公网地址（没有它就退化成纯文字面板）
  ctx: { config: { port: 5200, prefix: '' }, assets: { upload: async () => 'https://cdn.example.com/panel.png' } },
  config: {
    playerEnabled: true,
    qqFileLimitMB: 200,
    onebotQualityPanel: true,
    upstream: {
      douyin: { sendContent: [...FULL_SEND_CONTENT] },
      bilibili: { sendContent: [...FULL_SEND_CONTENT] },
      xiaohongshu: { sendContent: [...FULL_SEND_CONTENT] }
    },
    ...extra
  },
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
  const calls = { reactions: [], replies: [], raw: [], recalls: [], likes: [], http: [] }
  const selfId = String(opts.selfId ?? '3889000')
  const bot = {
    platform,
    selfId,
    /**
     * 协议端自报家门（`get_version_info`）。
     *
     * 面板的**表情排法**要看对面是 NapCat 还是 LLOneBot —— LL 会把 face 段中间的文字
     * 吞掉，所以只有确认是 NapCat 时才用「表情在数字前面」那种排法。
     * 每个假机器人都得带一个，默认给 NapCat（用户实测能用行内排法的就是它）。
     * `opts.appName: null` = 「问不到 / 不肯自报家门」那种协议端（会退成末尾一排）。
     */
    internal: opts.appName === null ? undefined : {
      getVersionInfo: async () => ({
        data: { app_name: String(opts.appName ?? 'NapCat.Onebot'), app_version: '1.0.0' }
      })
    },
    // 兼容层的 recallMsg 走的是 Koishi 标准的 deleteMessage(channel, messageId)
    deleteMessage: async (channel, messageId) => { calls.recalls.push({ messageId, channelId: channel }) }
  }
  /**
   * `opts.satori` = **Satori 标准接口**那套（Milky）：
   * 贴和撤是**两个方法**、第一个参数是 `channelId`、**没有** `set_msg_emoji_like`。
   * 表情 id 由调用方写成 `face|301`（适配器自己按 `|` 拆），这里原样收下好断言。
   */
  /**
   * `opts.httpOnly` = **只有 Satori 的 HTTP 通道**（`@satorijs/adapter-satori` 就长这样）：
   * Bot 上**一个**表情方法都没有（它按 `Universal.Methods` 批量生成，而 reaction 是实验性
   * 资源、不在那张表里，所以连 `createReaction` 都没有），但 `bot.http` 可以直接
   * POST 协议路径 `/v1/reaction.create` / `.delete` / `.list`。
   */
  if (opts.httpOnly) {
    bot.http = {
      post: async (path, payload) => {
        calls.http.push({ path, payload })
        /** `reaction.list` 要回一个分页列表（Satori 标准：{ data: [User…], next? }） */
        return /reaction\.list/.test(String(path)) ? { data: [] } : {}
      }
    }
  } else if (opts.satori) {
    bot.createReaction = async (channelId, messageId, emojiId) => {
      calls.reactions.push({ messageId, emojiId, isSet: true, channelId })
      return true
    }
    bot.deleteReaction = async (channelId, messageId, emojiId) => {
      calls.reactions.push({ messageId, emojiId, isSet: false, channelId })
      return true
    }
  } else if (!opts.noReactionApi) {
    /**
     * `opts.noReactionApi` = 协议端太老，连 `set_msg_emoji_like` 都没有（NapCat 要 v4.12.1+）。
     * 这种实例上「贴表情」和「点击事件」会**一起**失效，只能走文字退路 —— 必须能被模拟。
     */
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
  /** Milky 没有「查谁贴了」的接口（它靠推送事件），Satori 那套只有 http，也都不给 */
  if (!opts.satori && !opts.httpOnly && !opts.noFetchApi) {
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
      ? { platform, selfId: bot.selfId, internal: bot.internal }
      : { ...bot, setMsgEmojiLike: bot.setMsgEmojiLike, fetchEmojiLike: bot.fetchEmojiLike },
    session,
    reply: async (content) => {
      const text = renderContent(content)
      calls.replies.push(text)
      calls.raw.push(content)
      // 模拟「协议端不认 face 段」：整条消息发送失败，用来验证退回纯文本那条路
      if (opts.rejectFace && facesOf(content).length) throw new Error('unsupported segment: face')
      /**
       * 「正在加载卡片…」是过程提示；**详情卡自己也是单独一条**（不再并进面板），
       * 都给单独的 id —— 不然「选完面板有没有把卡片一起撤回」就验不出来。
       * opts.panelMessageId：第 18 节要造「协议端上报的 id 和我们记下的不是一个形态」
       */
      const id = text.includes('正在加载卡片')
        ? 'msg-tip'
        : /^\[img:[^\]]*\]$/.test(text.trim())
          ? 'msg-card'
          : (opts.panelMessageId ?? 'msg-1')
      return { messageId: id }
    }
  }
  return { e, bot, calls, session }
}

/**
 * 发过的、属于**面板本身**的消息（下标 + 文字）。
 *
 * 要排掉两类「不是面板」的消息：`正在加载卡片…` 那句过程提示，
 * 以及**单独发出的详情卡**（见第 4 节：卡片不再并进面板，否则会被一起撤回、
 * 也进不了合并转发）。
 */
const nonTip = (env) => env.calls.replies
  .map((text, index) => ({ text, index }))
  .filter((item) => !item.text.includes('正在加载卡片'))
  .filter((item) => !/^\[img:[^\]]*\]$/.test(item.text.trim()))

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

    /**
     * 「要不要问清晰度」的**总开关**（通用分组）。
     *
     * 用户反馈：「我明明没有勾选，发送视频的配置为什么还是要求选择清晰度？
     * 没有勾选就不要要求选择清晰度了」—— 这个开关以前只加了字段、没接进运行时，
     * 关掉它照样问。下面 10 / 25 两节盯住「关掉 = 完全不问」。
     */
    const master = fields.find((item) => item.key === 'qualityListPanel')
    check('总开关「发链接后先问清晰度」在字段表里', !!master, master ? master.label : '缺')
    check('在「通用」分组里（不是 QQ 专属）', master && master.group === '通用', master && master.group)
    check('默认是开的', master && master.default === true, String(master && master.default))
    check('说明里写清了「关掉就别问了」', !!master && /关掉/.test(master.description) && /默认画质/.test(master.description))
    check('QQ_KEYS 里有它', qqOptions.QQ_KEYS.includes('qualityListPanel'))
    check('字段表默认值 = true', defaults.qualityListPanel === true, String(defaults.qualityListPanel))

    /** 超时开关：没人选就按默认画质继续解析，不能把链接晾在那儿 */
    const timeout = fields.find((item) => item.key === 'qualityPanelTimeoutSec')
    check('超时配置在字段表里', !!timeout, timeout ? timeout.label : '缺')
    check('默认 60 秒', timeout && timeout.default === 60, String(timeout && timeout.default))
    check('QQ_KEYS 里有它', qqOptions.QQ_KEYS.includes('qualityPanelTimeoutSec'))
    check('模块读出来是 60000 ms', panel.qualityPanelTimeoutMs() === 60000, String(panel.qualityPanelTimeoutMs()))
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
    /**
     * **表情排在数字前面**（用户要求）：一行就是 `[表情]N. 画质 · 体积`。
     * 之前是「文字一个 text 段 + 表情排末尾」，用户看不出哪档对应哪个表情，所以改成行内。
     * ⚠️ 这样就是 face 段和 text 段**交错**了（QQ 有吞掉中间文本段的先例），
     * 真出问题时的退路是下面第 10 节那条「face 段发不出去 → 纯文本 + 数字」。
     */
    for (const [index, label] of ['1080P', '720P', '480P'].entries()) {
      check('第 ' + (index + 1) + ' 行 = ' + label + '（表情在数字前面）',
        text.includes('[face:' + QUALITY_EMOJI[index] + ']' + (index + 1) + '. ' + label),
        JSON.stringify(text.slice(-80)))
    }
    check('写了体积（1080P 那档 120MB）', text.includes('120MB'))

    /**
     * **详情卡必须单独发一条**，不能并进面板那条消息（用户要求）：
     * 面板选完是要**撤回**的，卡片跟着一起就没了；而开着合并转发时面板那条消息
     * 为了拿到真实消息 id 必须绕开转发收集，卡片也就进不了转发 —— 两头都不剩。
     */
    check('详情卡**单独**发了一条（不和清晰度提示挤在一起）',
      env.calls.replies.some((item) => item.trim() === '[img:https://cdn.example.com/panel.png]'),
      JSON.stringify(env.calls.replies.map((item) => item.slice(0, 24))))
    check('  面板那条消息里**没有**卡片（不会跟着一起被撤回）',
      !text.includes('[img:'), JSON.stringify(text.slice(0, 60)))
    check('「正在加载卡片…」发过（渲染要点时间）',
      env.calls.replies.some((item) => item.includes('正在加载卡片')))
    check('卡片拿到之后把「加载中」撤了（群里不留过程消息）',
      env.calls.recalls.some((item) => item.messageId === 'msg-tip'))

    const faces = panelFaces(env)
    check('每个选项前面都排了一个表情（数 = 档位数）', faces.length === 3, faces.join(','))
    check('排出来的表情 = 要贴上去的表情（同一批 id、同序）',
      JSON.stringify(faces) === JSON.stringify(QUALITY_EMOJI.slice(0, 3)), faces.join(','))
    check('表情就贴在数字前面（第 N 个表情 = 第 N 档，一眼对得上）',
      /\[face:301\]1\.\s*1080P/.test(text) && /\[face:320\]2\.\s*720P/.test(text) && /\[face:333\]3\.\s*480P/.test(text),
      JSON.stringify(text.slice(-80)))
    /**
     * NapCat 上是「表情就在数字前面」，所以**不用**写「从左到右数第几个」；
     * 但「可以回序号」这句**必须有** —— 用户反馈「引用选择清晰度 12345、可以发数字的提示也没有」，
     * 没表情可点的协议端上这是唯一出路。（末尾一排表情那种排法要写「从左到右数」，见第 25 节。）
     */
    check('不写「从左到右数」（表情就贴在档位旁边）', !/从左到右数/.test(text), JSON.stringify(text.slice(-80)))
    check('写了「可以回序号」这句（没表情可点时唯一的出路）', /回序号/.test(text), JSON.stringify(text.slice(-60)))

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
    /** 详情卡是单独一条，**不许**跟着面板一起被撤（撤了用户就只剩个视频，连作品信息都没有） */
    check('详情卡**没有**被跟着撤回（它是独立的一条）',
      !recalls.includes('msg-card'), recalls.join(','))
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
    /** 纯文本那版同样要把「能回序号」写出来（序号还在，回数字照样能用） */
    check('退回时也写了「可以回序号」', /回序号/.test(fallback), JSON.stringify(fallback.slice(0, 60)))

    /**
     * **只关**「QQ 系用表情当按钮」：还是要问，只是换成**纯文字数字列表**。
     * 「不问问」那是总开关（见下面），两个不是一回事 —— 以前把这两个搞混了，
     * 于是出现「没勾选还是要求选择清晰度」。
     */
    bind({ onebotQualityPanel: false })
    panel.debugClear()
    const envNoEmoji = await send({ title: 'T', author: 'A', duration: '01:00', options: options([[80, '1080P', 120], [64, '720P', 60]]) })
    check('只关表情开关 → 仍然要问（发的是数字列表）', envNoEmoji.ok === true)
    check('  这条里一个表情段都没有', panelFaces(envNoEmoji).length === 0, panelFaces(envNoEmoji).join(','))
    check('  也没往消息上贴表情', envNoEmoji.calls.reactions.length === 0, String(envNoEmoji.calls.reactions.length))
    check('  序号和「回序号」提示都在',
      /1\.\s*1080P/.test(panelText(envNoEmoji)) && /回序号/.test(panelText(envNoEmoji)),
      JSON.stringify(panelText(envNoEmoji).slice(0, 60)))

    /** **总开关**关掉 → 完全不问（表情开关还开着也不问） */
    bind({ qualityListPanel: false })
    panel.debugClear()
    check('总开关关掉 → 完全不问（表情开关还开着也不问）',
      (await send({ title: 'T', author: 'A', duration: '01:00', options: options([[80, '1080P', 120], [64, '720P', 60]]) })).ok === false)
    bind({ onebotQualityPanel: false, qualityListPanel: false })
    panel.debugClear()
    check('两个都关 → 也不问',
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
    /**
     * 面板上**不再**写「点不动表情就引用本条消息…」（用户要求删掉那两行说明），
     * 但**退路本身必须还在**：协议端一个表情事件都不发时这是唯一能用的路。
     */
    check('面板上不再写那行退路说明（用户删掉了）', !/引用本条消息/.test(panelText(env)))

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
    /** 同理：面板上不再写「发链接的人直接回数字也行」那行说明（用户要求删掉），退路仍然在 */
    check('面板上不再写「直接回数字」那行说明（用户删掉了）', !/直接回数字/.test(panelText(env4)))

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
    bind({ onebotQualityPanel: false, qualityListPanel: false })
    check('两个开关都关掉 → 文字退路也不认', (await panel.trySelectByText(textSession(env3, 'msg-1', '1'))) === false)
    check('面板也没被误消费', panel.debugPendingCount() === 1, String(panel.debugPendingCount()))
    panel.debugClear()

    /**
     * **只关**表情开关时数字列表还在（所有平台都靠这条路），回序号必须照样认 ——
     * 以前这里挂的是「表情开关」，于是关掉表情之后 OneBot 上回序号也没人接了。
     */
    bind({ onebotQualityPanel: false })
    const envNoEmojiText = await send(info)
    check('只关表情开关 → 数字列表的回序号照样认',
      (await panel.trySelectByText(textSession(envNoEmojiText, 'msg-1', '1'))) === true,
      panelText(envNoEmojiText).slice(0, 40))
    check('  回显的是第一档', envNoEmojiText.calls.replies.some((item) => item.includes('已选 1080P')))
    panel.debugClear()
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
    check('走通用入口 internal._get', viaGet.length === 1 && viaGet[0][0] === 'fetch_emoji_like', JSON.stringify(viaGet.map((i) => i[0])))
    check('  从 emojiLikesList 里取出了 tinyId', JSON.stringify(got3) === JSON.stringify(['10005']), JSON.stringify(got3))
    /**
     * ⚠️ 参数里**必须**有 `emojiId` 和 `emojiType`（驼峰）——
     * NapCat 的 `fetch_emoji_like` 把这两个列为 **required**，缺了就回
     * `retcode 1400 请求参数错误或业务逻辑执行失败`，于是被判成「这个协议端查不到」、
     * 轮询压根起不来。以前只发了 `{message_id, emoji_id, count}`，NapCat 一直是这样挂掉的。
     */
    const sentParams = viaGet[0]?.[1] ?? {}
    check('  ⚠️ 带上了 emojiId（驼峰，NapCat 必填）', 'emojiId' in sentParams, JSON.stringify(Object.keys(sentParams)))
    check('  ⚠️ 带上了 emojiType（驼峰，NapCat 必填；1 = QQ 系统表情）', sentParams.emojiType === 1, String(sentParams.emojiType))
    check('  也带上了 emoji_type（下划线，另一个接口要的）', sentParams.emoji_type === '1', String(sentParams.emoji_type))
    check('  带上了 cookie / count（fetch_emoji_like 的必填项）',
      sentParams.cookie === '' && Number(sentParams.count) > 0, JSON.stringify([sentParams.cookie, sentParams.count]))

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

    /**
     * ⑧ **NapCat 有第二个接口，参数和返回结构完全不一样**。
     *
     * 只认 `emojiLikesList[].tinyId` 那一种就等于「只有一半协议端能用」——
     * 实测就是「LLOneBot 查得到、NapCat 查不到」。
     */
    const seen2 = []
    const viaList = await kkk({
      platform: 'onebot',
      internal: {
        _get: async (action, params) => {
          seen2.push([action, params])
          if (action !== 'get_emoji_likes') throw new Error('unknown action')
          /** NapCat 这个接口给的是 emoji_like_list + user_id */
          return { emoji_like_list: [{ user_id: '10008', nick_name: '测试用户' }] }
        }
      }
    }).fetchEmojiLikes('85030312', '301', '20001')
    check('get_emoji_likes 的 emoji_like_list[].user_id → 认得（以前完全解析不出来）',
      JSON.stringify(viaList) === JSON.stringify(['10008']), JSON.stringify(viaList))
    const params2 = seen2.find((item) => item[0] === 'get_emoji_likes')?.[1] ?? {}
    check('  带上了 emoji_id / emoji_type（下划线，这个接口要的写法）',
      params2.emoji_id === 301 && params2.emoji_type === '1', JSON.stringify(params2))
    check('  群号传下来了（get_emoji_likes 靠它定位）', params2.group_id === '20001', String(params2.group_id))

    /** 信封**没拆**时（_request 给的是整个信封）两种结构也都得认 */
    const wrapped1 = await kkk({
      platform: 'onebot',
      internal: { _request: async () => ({ status: 'ok', retcode: 0, data: { emojiLikesList: [{ tinyId: '10009' }] } }) }
    }).fetchEmojiLikes('1', '2')
    check('信封未拆 + emojiLikesList → 认得', JSON.stringify(wrapped1) === JSON.stringify(['10009']), JSON.stringify(wrapped1))
    const wrapped2 = await kkk({
      platform: 'onebot',
      internal: { _request: async () => ({ status: 'ok', retcode: 0, data: { emoji_like_list: [{ user_id: '10010' }] } }) }
    }).fetchEmojiLikes('1', '2')
    check('信封未拆 + emoji_like_list → 也认得', JSON.stringify(wrapped2) === JSON.stringify(['10010']), JSON.stringify(wrapped2))

    /**
     * `fetch_emoji_like` 回了 1400（参数不对 / 业务失败）→ 要自动换 `get_emoji_likes`，
     * 并且拿第二个的**下划线**结构。这就是 NapCat 现在真正会走的那条路。
     */
    const tried = []
    const after1400 = await kkk({
      platform: 'onebot',
      internal: {
        _get: async (action, params) => {
          tried.push(action)
          if (action === 'fetch_emoji_like') throw new Error('retcode 1400: 请求参数错误或业务逻辑执行失败')
          return { emoji_like_list: [{ user_id: '10011' }] }
        }
      }
    }).fetchEmojiLikes('85030312', '301')
    check('fetch_emoji_like 失败（1400）→ 自动换 get_emoji_likes',
      JSON.stringify(tried) === JSON.stringify(['fetch_emoji_like', 'get_emoji_likes']), tried.join(','))
    check('  换过去后拿到了人', JSON.stringify(after1400) === JSON.stringify(['10011']), JSON.stringify(after1400))
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

  /**
   * 20. 通用「表情选择」核心：几选一，await 到结果。
   *
   * 画质那两步是最早的用法，逻辑写死在 sendQualityReactionPanel 里；
   * 互动视频选项、提取图片、查询下载进度都要同一套「贴表情 → 等点击 → 交回结果」，
   * 所以抽出了 `sendEmojiChoicePanel` / `attachEmojiChoicePanel`。
   */
  console.log('\n=== 20. 通用表情选择面板（await 到结果） ===')
  {
    const likeSession = (env, messageId, data) => ({
      ...env.session,
      selfId: env.bot.selfId,
      onebot: { notice_type: 'group_msg_emoji_like', group_id: '20001', message_id: messageId, ...data }
    })
    bind()
    panel.debugClear()
    captured.commands.length = 0

    /** 一条干净的 OneBot 群环境（不走去画质面板那条路） */
    const env = makeEnv('onebot', true, { likes: {} })
    let settled = null
    const pending = panel.sendEmojiChoicePanel(env.e, {
      subject: '互动视频选项',
      title: '互动视频　·　剧情：开场',
      options: [
        { label: 'A 向左走', value: 0 },
        { label: 'B 向右走', value: 1 },
        { label: '渲染流程图', value: -1 }
      ],
      anyEmoji: false
    })
    pending.then((pick) => { settled = pick })
    /** 让它把「发消息 + 贴表情」这两步走完 */
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const text = env.calls.replies.slice(-1)[0] ?? ''
    check('面板发出来了（自己一条消息）', env.calls.replies.length === 1, String(env.calls.replies.length))
    check('标题带上了', text.includes('互动视频') && text.includes('剧情：开场'))
    check('三个选项都列了（带序号）',
      text.includes('1. A 向左走') && text.includes('2. B 向右走') && text.includes('3. 渲染流程图'))
    check('每个选项前都印了表情（第 N 个表情 = 第 N 项）',
      /\[face:301\]1\.\s*A 向左走/.test(text) && /\[face:320\]2\.\s*B 向右走/.test(text) && /\[face:333\]3\.\s*渲染流程图/.test(text),
      JSON.stringify(text.slice(0, 200)))
    check('说明那两行已经删掉了', !/从左到右数/.test(text) && !/引用本条消息/.test(text))
    check('三个表情按顺序排在选项里，是升序前三个',
      JSON.stringify(facesOf(env.calls.raw[env.calls.raw.length - 1])) === JSON.stringify(['301', '320', '333']),
      JSON.stringify(facesOf(env.calls.raw[env.calls.raw.length - 1])))
    check('表情真的贴上去了 3 个',
      env.calls.reactions.filter((item) => item.isSet).length === 3,
      String(env.calls.reactions.filter((item) => item.isSet).length))

    /** 用户点第 2 个表情（= B 向右走） */
    const handled = await panel.handleEmojiLike(likeSession(env, 'msg-1', {
      user_id: '10002', is_add: true, likes: [{ emoji_id: '320', count: 2 }]
    }))
    check('点第 2 个表情 → 认出来了', handled === true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    check('Promise 拿到的是第 2 项（value = 1）', settled && settled.index === 1 && settled.value === 1,
      JSON.stringify(settled))
    check('  label 也带回来了', settled && settled.label === 'B 向右走', settled && settled.label)
    check('一次性：面板已经被摘掉', panel.debugPendingCount() === 0, String(panel.debugPendingCount()))
    check('  摘掉时把那排表情也撤了（不留点不动的按钮）',
      env.calls.reactions.filter((item) => item.isSet === false).length === 3,
      String(env.calls.reactions.filter((item) => item.isSet === false).length))

    /** 挂到已有消息上：不新发消息 */
    panel.debugClear()
    const env2 = makeEnv('onebot', true, { likes: {} })
    const attached = panel.attachEmojiChoicePanel(env2.e, 'msg-card-9', {
      subject: '提取图片',
      options: [{ label: '提取封面图', value: 'kkk封面 bili:BV1' }]
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    check('挂在已有消息上 → 一条消息都不发', env2.calls.replies.length === 0, String(env2.calls.replies.length))
    check('  但表情贴到那条消息上了',
      env2.calls.reactions.every((item) => item.messageId === 'msg-card-9'),
      JSON.stringify(env2.calls.reactions.map((i) => i.messageId)))
    let picked2 = null
    attached.then((pick) => { picked2 = pick })
    await panel.handleEmojiLike(likeSession(env2, 'msg-card-9', {
      user_id: '10002', is_add: true, likes: [{ emoji_id: '301', count: 2 }]
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    check('  点它 → 拿到结果（value 原样带回）',
      picked2 && picked2.value === 'kkk封面 bili:BV1', JSON.stringify(picked2))

    /** 只有一项时「贴什么表情都算」 */
    panel.debugClear()
    const env3 = makeEnv('onebot', true, { likes: {} })
    let picked3 = null
    const single = panel.attachEmojiChoicePanel(env3.e, 'msg-card-10', {
      subject: '提取图片',
      options: [{ label: '提取封面图', value: 'kkk封面 bili:BV2' }],
      anyEmoji: true
    })
    single.then((pick) => { picked3 = pick })
    await new Promise((resolve) => setTimeout(resolve, 0))
    /** 用户贴的不是我们贴的那个（301），是个别的小黄脸 */
    const ok3 = await panel.handleEmojiLike(likeSession(env3, 'msg-card-10', {
      user_id: '10002', is_add: true, likes: [{ emoji_id: '396', count: 1 }]
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    check('只有一项 → 贴**任意**表情都算选中（不用点对那一个）', ok3 === true && !!picked3, JSON.stringify(picked3))

    /** 多项时不许「随意蒙」 */
    panel.debugClear()
    const env4 = makeEnv('onebot', true, { likes: {} })
    let picked4 = 'unset'
    const multi = panel.attachEmojiChoicePanel(env4.e, 'msg-card-11', {
      subject: '互动视频选项',
      options: [{ label: 'A', value: 0 }, { label: 'B', value: 1 }],
      anyEmoji: false
    })
    multi.then((pick) => { picked4 = pick })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const ok4 = await panel.handleEmojiLike(likeSession(env4, 'msg-card-11', {
      user_id: '10002', is_add: true, likes: [{ emoji_id: '396', count: 1 }]
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    check('多项时贴个不相干的表情 → **不**触发（否则随手一点就乱选）', ok4 === false && picked4 === 'unset')
    panel.debugClear()
  }

  /**
   * 21. 「查询下载进度」：贴任意表情都查，**添加几个就执行几次**。
   *
   * 下载要跑一会儿，用户会想多问几次，所以这种面板**不会被消费掉**；
   * 但同一个人贴同一个表情不会重复触发（不然三秒一次的轮询会一直刷）。
   */
  console.log('\n=== 21. 查询下载进度：可反复触发 ===')
  {
    bind()
    panel.debugClear()
    captured.commands.length = 0
    const env = makeEnv('onebot', true, { likes: {} })
    const ok = await panel.attachDownloadProgressPanel(env.e, 'msg-dl', 'BV17tHb6AEKt')
    await new Promise((resolve) => setTimeout(resolve, 0))
    check('面板挂上了', ok === true)
    check('只贴了一个表情（只有一个动作）',
      env.calls.reactions.filter((item) => item.isSet).length === 1,
      String(env.calls.reactions.filter((item) => item.isSet).length))

    const tap = async (emojiId, user) => await panel.handleEmojiLike({
      ...env.session,
      selfId: env.bot.selfId,
      onebot: {
        notice_type: 'group_msg_emoji_like', group_id: '20001', message_id: 'msg-dl',
        user_id: user, is_add: true, likes: [{ emoji_id: emojiId, count: 1 }]
      }
    })

    /** 机器人自己贴那一下不算（selfId 过滤） */
    check('机器人自己贴的不算点击',
      (await tap('301', env.bot.selfId)) === false)
    check('  也没有真的去查进度', captured.commands.length === 0, String(captured.commands.length))

    check('用户贴第 1 个表情 → 查了一次', (await tap('301', '10002')) === true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    check('  跑的是「下载进度 BV17tHb6AEKt」',
      captured.commands.length === 1 && /下载进度\s+BV17tHb6AEKt/.test(captured.commands[0].text),
      captured.commands.map((i) => i.text).join(' | '))
    check('  面板**没有**被消费（还能接着点）', panel.debugPendingCount() === 1, String(panel.debugPendingCount()))

    /**
     * 同一个表情再来一次：不重复（同一次点击会被上报/轮询看好几遍）。
     *
     * 注意返回值仍然是 true —— 这个事件确实被我们的面板认领了，只是**不再执行**；
     * 真正要断言的是「指令没有多跑一次」。
     */
    await tap('301', '10002')
    await new Promise((resolve) => setTimeout(resolve, 0))
    check('同一个表情再点一次 → 不再重复执行', captured.commands.length === 1, String(captured.commands.length))

    /** 换一个表情 = 新的一次 */
    check('换一个表情 → 又执行了一次（添加几个就执行几次）', (await tap('333', '10002')) === true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    check('  进度查了两次', captured.commands.length === 2, String(captured.commands.length))
    check('  面板仍然在（还能再查）', panel.debugPendingCount() === 1, String(panel.debugPendingCount()))

    /**
     * 轮询那条路：认任意表情时**要额外多问几个 id**，
     * 否则用户贴的不是我们贴的那个就永远问不到（fetch_emoji_like 只能按 id 问）。
     */
    panel.debugClear()
    captured.commands.length = 0
    /**
     * 关键的时序：**基线是在面板挂上那一刻拍的**。
     * 所以这里一开始必须是空的，等基线拍完再让「有人贴了 320」发生 ——
     * 提前放进去的话那个人会被算进基线，轮询就永远看不到他。
     */
    const likes = {}
    const env2 = makeEnv('onebot', true, { likes, panelMessageId: 'msg-dl2' })
    await panel.attachDownloadProgressPanel(env2.e, 'msg-dl2', 'BV1')
    await new Promise((resolve) => setTimeout(resolve, 200))
    const asked = [...new Set(env2.calls.likes.map((item) => String(item.emojiId)))]
    check('认任意表情时轮询会多问几个常用表情（不只问自己贴的那个）',
      asked.length > 1 && asked.includes('320'), JSON.stringify(asked))
    /** 用户在我们贴的那个（301）之外，随手贴了个 320 */
    likes['320'] = ['10002']
    captured.commands.length = 0
    const rounds = await panel.debugPollOnce()
    check('轮询也能触发（用户贴的是 320，不是我们贴的 301）', rounds === 1, String(rounds))
    await new Promise((resolve) => setTimeout(resolve, 0))
    check('  进度查了一次', captured.commands.length === 1, String(captured.commands.length))
    /** 关键：不能每轮都触发（新人要记进基线） */
    const again = await panel.debugPollOnce()
    check('下一轮**不再**重复触发（新的人已经记进基线）', again === 0 && captured.commands.length === 1,
      String(again) + '/' + captured.commands.length)
    panel.debugClear()
  }

  /**
   * 22. 「提取封面图 / 提取评论区图片」：**只能执行一次**。
   *
   * 用户要求：点过一次就把按钮收掉 —— 否则随手在这张卡上贴个表情就会把图再发一遍。
   */
  console.log('\n=== 22. 提取图片：只能点一次 ===')
  {
    bind()
    panel.debugClear()
    captured.commands.length = 0
    const env = makeEnv('onebot', true, { likes: {} })
    /** 造一张有封面 + 有评论图的缓存，两个按钮都该出现 */
    const cache = require(path.join(lib, 'karin/module/utils/CardImageCache.js'))
    const key = 'bilibili:BV1PROBE'
    cache.rememberCardImages(key, { cover: 'https://cdn.example.com/cover.jpg', commentPics: ['https://cdn.example.com/c1.jpg'] })

    const ok = await panel.attachCardImageEmojiPanel(env.e, 'msg-card', { cover: true, comment: true, key })
    await new Promise((resolve) => setTimeout(resolve, 0))
    check('两个按钮都挂上了（封面 + 评论区）', ok === true
      && env.calls.reactions.filter((item) => item.isSet).length === 2,
      String(env.calls.reactions.filter((item) => item.isSet).length))
    /**
     * **两个按钮时不换成 ✅️**（478）：那排表情是按 id 升序排的，
     * 478 比 301 / 320 都大，一换封面那个就会跑到最后去，「第 1 个 = 封面」当场对不上。
     * 只有**单独一个**按钮（不存在点错这回事）才换成 ✅️。
     */
    check('两个按钮 → 还是用默认那排（301 / 320，升序）',
      JSON.stringify(env.calls.reactions.filter((item) => item.isSet).map((item) => String(item.emojiId))) === JSON.stringify(['301', '320']),
      env.calls.reactions.filter((item) => item.isSet).map((item) => item.emojiId).join(','))

    const tap = async (emojiId) => await panel.handleEmojiLike({
      ...env.session,
      selfId: env.bot.selfId,
      onebot: {
        notice_type: 'group_msg_emoji_like', group_id: '20001', message_id: 'msg-card',
        user_id: '10002', is_add: true, likes: [{ emoji_id: emojiId, count: 1 }]
      }
    })

    check('点第 2 个表情（= 提取评论区图片）', (await tap('320')) === true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    check('  跑的是「kkk评论 <key>」（带作品参数，不会串到别的作品）',
      captured.commands.length === 1 && captured.commands[0].text === 'kkk评论 ' + key,
      captured.commands.map((i) => i.text).join(' | '))
    check('  面板已经被摘掉', panel.debugPendingCount() === 0, String(panel.debugPendingCount()))

    /** 再点：什么都不该发生 */
    check('再点一次 → **不**再发一遍图（只能一次）', (await tap('320')) === false)
    check('  换个表情点也不行', (await tap('301')) === false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    check('  指令只跑了一次', captured.commands.length === 1, String(captured.commands.length))

    /** 缓存里没图就别挂按钮（点了没反应的摆设） */
    const empty = await panel.attachCardImageEmojiPanel(env.e, 'msg-card2', { cover: true, comment: true, key: 'bilibili:BV-NONE' })
    check('缓存里没这张图 → 不挂按钮（宁缺毋滥）', empty === false)

    /** 只有一个按钮时「贴什么表情都行」 */
    panel.debugClear()
    captured.commands.length = 0
    const env2 = makeEnv('onebot', true, { likes: {} })
    await panel.attachCardImageEmojiPanel(env2.e, 'msg-card3', { cover: true, key })
    await new Promise((resolve) => setTimeout(resolve, 0))
    /**
     * **只有一个「提取封面图」时贴 ✅️**（478「对的」）—— 用户要的：
     * 与其贴一个看不出含义的小黄脸，不如贴个一眼就懂的「对，就要这个」。
     */
    check('只有一个封面按钮 → 贴的是 ✅️（478）',
      JSON.stringify(env2.calls.reactions.filter((item) => item.isSet).map((item) => String(item.emojiId))) === JSON.stringify([YES]),
      env2.calls.reactions.filter((item) => item.isSet).map((item) => item.emojiId).join(','))
    const ok2 = await panel.handleEmojiLike({
      ...env2.session,
      selfId: env2.bot.selfId,
      onebot: {
        notice_type: 'group_msg_emoji_like', group_id: '20001', message_id: 'msg-card3',
        user_id: '10002', is_add: true, likes: [{ emoji_id: '396', count: 1 }]
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    check('只有一个按钮 → 贴任意表情都提取（不用点对那一个）',
      ok2 === true && captured.commands.length === 1 && captured.commands[0].text === 'kkk封面 ' + key,
      captured.commands.map((i) => i.text).join(' | '))
    panel.debugClear()
  }

  /**
   * 23. 互动视频的选项：QQ 上是 markdown 按钮，OneBot 上换成**表情**。
   *
   * 表情只是印在消息末尾（不能和文字段交错，QQ 会吞掉中间的文本），
   * 真正让它变成按钮的是 `runInteractiveStory` 拿返回的 messageId 去挂面板。
   */
  console.log('\n=== 23. 互动视频选项：OneBot 走表情 ===')
  {
    const story = require(path.join(lib, 'karin/platform/bilibili/interactive-story.js'))
    const node = {
      cid: 1,
      title: '开场',
      question: '你往哪边走',
      choices: [
        { label: 'A', text: '向左走', cid: 2, edgeId: 11 },
        { label: 'B', text: '向右走', cid: 3, edgeId: 12 }
      ]
    }

    /** OneBot 群：纯文字 + 末尾一排表情（选项数 + 1，多出来那个是「渲染流程图」） */
    const env = makeEnv('onebot', true, { likes: {} })
    const messageId = await story.sendInteractiveChoices(env.e, node, { title: '互动视频', path: [], detailed: true })
    const text = env.calls.replies.slice(-1)[0] ?? ''
    const faces = facesOf(env.calls.raw[env.calls.raw.length - 1])
    check('消息发出去了（拿到 messageId 才能挂面板）', !!messageId, String(messageId))
    check('选项照常列出来（A / B）', text.includes('A 向左走') && text.includes('B 向右走'))
    check('末尾排了 3 个表情：A、B、渲染流程图', JSON.stringify(faces) === JSON.stringify(['301', '320', '333']),
      JSON.stringify(faces))
    check('文案说清了「第几个表情 = 第几个选项」', /从左到右数.*第几个就是上面第几个选项/.test(text))
    check('  也说清了最后一个是「渲染流程图」', /最后一个是「渲染流程图」/.test(text))
    check('  表情排在**最后**（文字全在一个 text 段里，不会被 QQ 吞掉）',
      env.calls.raw[env.calls.raw.length - 1].findIndex((item) => item && item.type === 'face') === 1,
      String(env.calls.raw[env.calls.raw.length - 1].findIndex((item) => item && item.type === 'face')))

    /** 面板挂上去之后，点第 2 个表情 = 选 B */
    panel.debugClear()
    let picked = null
    const attached = panel.attachEmojiChoicePanel(env.e, messageId, {
      subject: '互动视频选项',
      options: [
        { label: 'A 向左走', value: 0 },
        { label: 'B 向右走', value: 1 },
        { label: '渲染流程图', value: story.CHART_CHOICE_VALUE }
      ],
      anyEmoji: false
    })
    attached.then((pick) => { picked = pick })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await panel.handleEmojiLike({
      ...env.session,
      selfId: env.bot.selfId,
      onebot: {
        notice_type: 'group_msg_emoji_like', group_id: '20001', message_id: messageId,
        user_id: '10002', is_add: true, likes: [{ emoji_id: '320', count: 1 }]
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    check('点第 2 个表情 → 选中的是 B（value = 1）', picked && picked.value === 1, JSON.stringify(picked))
    check('「渲染流程图」那一项的 value 是 -1（不会和选项下标撞上）', story.CHART_CHOICE_VALUE === -1)
    panel.debugClear()

    /**
     * QQ 官方仍然是 markdown 按钮，不能被动到。
     *
     * `isQqPlatform` 认的是 `bot.adapter.name`（`qq` / `qqguild` / `qqbot` / `official`），
     * 不是 platform —— 假环境里必须给这个名字，否则会被当成「没有按钮的普通平台」。
     */
    const qqEnv = makeEnv('qq', true, { likes: {} })
    qqEnv.e.bot = { platform: 'qq', adapter: { name: 'qq' }, selfId: '3889000' }
    await story.sendInteractiveChoices(qqEnv.e, node, { title: '互动视频', path: [], detailed: true })
    /**
     * markdown 是一个**元素**，正文挂在它的 text 子段上 ——
     * renderContent 只会把它摊成 `[markdown]，所以这里要往下挖一层。
     */
    const qqRaw = qqEnv.calls.raw[qqEnv.calls.raw.length - 1]
    const qqText = (qqRaw?.children ?? []).map((child) => String(child?.attrs?.content ?? '')).join('')
    check('QQ 上仍然是 markdown 按钮（qqbot-cmd-input）', qqText.includes('qqbot-cmd-input'), qqText.slice(0, 60))
    check('  QQ 上不画表情', facesOf(qqEnv.calls.raw[qqEnv.calls.raw.length - 1]).length === 0)
  }

  /**
   * 24. 协议端自报家门（`get_version_info`）。
   *
   * 表情回应那两个接口 NapCat 和 LLOneBot 各认一套，排查「点了没反应」时
   * 最想知道的第一件事就是**对面到底是谁** —— 以前只能看 `bot.platform`（各家都报 onebot）。
   * 两家路径一样（都是 `get_version_info`），返回的字段名也一样。
   */
  console.log('\n=== 24. 协议端自报家门（get_version_info） ===')
  {
    const kkk = (raw) => new KkkBot(raw)

    /** ① NapCat：信封完整（_request 给的是整个信封） */
    const seen = []
    const napcat = await kkk({
      platform: 'onebot',
      internal: {
        _request: async (action, params) => {
          seen.push([action, params])
          return {
            status: 'ok', retcode: 0,
            data: { app_name: 'NapCat.Onebot', protocol_version: 'v11', app_version: '1.0.0' }
          }
        }
      }
    }).fetchVersionInfo()
    check('NapCat 自报家门 → 认得', napcat && napcat.appName === 'NapCat.Onebot', JSON.stringify(napcat))
    check('  版本 / 协议版本都拿全了',
      napcat && napcat.appVersion === '1.0.0' && napcat.protocolVersion === 'v11', JSON.stringify(napcat))
    check('  调的是 get_version_info（两家路径一样）', seen[0]?.[0] === 'get_version_info', String(seen[0]?.[0]))

    /** ② LLOneBot：`_get` 会自己拆信封，给进来的是 data 本体 */
    const llob = await kkk({
      platform: 'onebot',
      internal: {
        _get: async () => ({ app_name: 'LLOneBot', protocol_version: 'v11', app_version: '4.1.2' })
      }
    }).fetchVersionInfo()
    check('LLOneBot 自报家门 → 也认得（信封已拆的那种）',
      llob && llob.appName === 'LLOneBot' && llob.appVersion === '4.1.2', JSON.stringify(llob))

    /** ③ 只问一次：这条是诊断信息，不该每次轮询都去问一遍 */
    let asked = 0
    const once = kkk({
      platform: 'onebot',
      internal: { _get: async () => { asked++; return { app_name: 'NapCat.Onebot', app_version: '1.0.0' } } }
    })
    await once.fetchVersionInfo()
    await once.fetchVersionInfo()
    await once.fetchVersionInfo()
    check('同一个机器人只问一次（结果记在缓存里）', asked === 1, String(asked))

    /** ④ 问不到 → null，而且也不反复问 */
    let failedAsked = 0
    const none = kkk({
      platform: 'onebot',
      internal: { _get: async () => { failedAsked++; throw new Error('unknown action') } }
    })
    const r1 = await none.fetchVersionInfo()
    const r2 = await none.fetchVersionInfo()
    check('问不到 → null（不影响主流程）', r1 === null && r2 === null, JSON.stringify([r1, r2]))
    check('  也不会反复去问', failedAsked === 1, String(failedAsked))
    check('什么接口都没有 → null', (await kkk({ platform: 'onebot' }).fetchVersionInfo()) === null)

    /**
     * ⑤ 面板的轮询日志里要带上协议端名字 ——
     * 「这个协议端查不到表情回应」那行看不到对面是谁的话，下次还得再猜一轮。
     */
    bind()
    panel.debugClear()
    logLines.length = 0
    const info = { title: 'T', author: 'A', duration: '01:00', options: options([[80, '1080P', 120], [64, '720P', 60]]) }
    const env = await send(info, { env: { noFetchApi: true } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const unsupportedLine = logLines.find((line) => line.includes('查不到表情回应')) ?? ''
    check('「查不到表情回应」那行写清了协议端（拿不到版本时退回平台名）',
      !!unsupportedLine && /协议端\s*\S+/.test(unsupportedLine), unsupportedLine.slice(0, 120))
    panel.debugClear()
  }

  /**
   * 25. 表情的**排法**按协议端分两种。
   *
   * 用户实测：NapCat 上「表情排在数字前面」没问题；LLOneBot 上 QQ 会**吞掉中间的文字**
   * （5 行选项只剩首尾两行），只能改成「文字一段 + 末尾一排表情 + 从左到右数第几个」。
   * 两种排法的选择依据是协议端自报的名字（`get_version_info` 的 app_name），
   * 因为各家 `platform` 都是 `onebot`，看平台名根本分不出来。
   */
  console.log('\n=== 25. LLOneBot 这种会吞字的协议端：表情排末尾 + 「从左到右数」 ===')
  {
    bind()
    panel.debugClear()
    captured.commands.length = 0
    const info = { title: 'T', author: 'A', duration: '01:00', options: options([[80, '1080P', 120], [64, '720P', 60], [32, '480P', 25]]) }

    /** 换一个 selfId：实现端缓存按「平台 + selfId」记，和前面那些 NapCat 环境串味就测不准了 */
    const env = await send(info, { env: { appName: 'LLOneBot', selfId: '3889001' } })
    check('面板照样发出去', env.ok === true)
    const text = panelText(env)
    /**
     * 关键：**文字全在一个 text 段里**，表情排在它后面 —— 中间没有文本段可以给 QQ 吞。
     * 行内那种（`[表情]1. …`）只在 NapCat 上用（见第 4 节）。
     */
    check('表情**没有**插在每行数字前面（LL 会吞字）',
      !/\[face:\d+\]\d\./.test(text), JSON.stringify(text.slice(-80)))
    check('序号行都在（1 / 2 / 3）',
      /1\.\s*1080P/.test(text) && /2\.\s*720P/.test(text) && /3\.\s*480P/.test(text),
      JSON.stringify(text.slice(-80)))
    check('补了「从左到右数第几个」那句（那排表情和序号不挨着，不写用户不知道）',
      /从左到右数/.test(text), JSON.stringify(text.slice(-80)))
    check('也写了「可以回序号」', /回序号/.test(text))
    const faces = panelFaces(env)
    check('表情全排在消息最后一行（3 个，升序）',
      JSON.stringify(faces) === JSON.stringify(QUALITY_EMOJI.slice(0, 3)), faces.join(','))
    check('贴上去的也是这 3 个',
      env.calls.reactions.filter((item) => item.isSet).length === 3)

    /** 「问不到协议端名字」也按保守的末尾排法走，不能因为拿不到信息就用会吞字的那种 */
    panel.debugClear()
    const unknown = await send(info, { env: { appName: null, selfId: '3889002' } })
    check('协议端不自报家门 → 也用末尾排法（保守）',
      !/\[face:\d+\]\d\./.test(panelText(unknown)) && /从左到右数/.test(panelText(unknown)),
      JSON.stringify(panelText(unknown).slice(-60)))
    panel.debugClear()
  }

  /**
   * 26. 没有按钮的平台也要能选画质：纯文字数字列表。
   *
   * 用户要求「所有平台都有数字列表」—— 微信 / Telegram / Discord / Milky 这些
   * 以前只能按配置里的默认画质直接解析，用户根本没得选。
   */
  console.log('\n=== 26. 非 QQ 平台：纯文字数字列表（回序号选） ===')
  {
    bind()
    panel.debugClear()
    captured.commands.length = 0
    const info = { title: 'T', author: 'A', duration: '01:00', options: options([[80, '1080P', 120], [64, '720P', 60]]) }
    const env = await send(info, { platform: 'telegram' })
    check('Telegram 上也问了（返回 true）', env.ok === true)
    const text = panelText(env)
    check('一个表情段都没有（这个平台没有 QQ 表情）', panelFaces(env).length === 0, panelFaces(env).join(','))
    check('也没去贴表情', env.calls.reactions.length === 0, String(env.calls.reactions.length))
    check('序号 + 画质 + 体积都在', /1\.\s*1080P/.test(text) && /2\.\s*720P/.test(text) && /120MB/.test(text),
      JSON.stringify(text.slice(-80)))
    check('写了「回复序号」这句（不然用户不知道能选）', /回复序号/.test(text), JSON.stringify(text.slice(-60)))
    check('写了「直接回序号就行」的用法说明', /回序号/.test(text))
    check('面板登记上了（等用户回序号）', panel.debugPendingCount() === 1, String(panel.debugPendingCount()))

    /** 回 "2" → 选中 720P，之后照样问「是否在线播放」 */
    check('回 "2" → 认下了', (await panel.trySelectByText({
      ...env.session, selfId: env.bot.selfId, content: '2', quote: { id: 'msg-1' }
    })) === true)
    check('  第二步也是纯文字（跟着第一步走）',
      env.calls.replies.some((item) => item.includes('已选 720P')) && askFaces(env).length === 0,
      askFaces(env).join(','))
    await panel.trySelectByText({ ...env.session, selfId: env.bot.selfId, content: '2', quote: { id: 'msg-ask' } })
    check('  落地成解析命令（带选中的画质）', /--q=64/.test(captured.commands[0]?.text ?? ''), captured.commands[0]?.text ?? '没跑')
    panel.debugClear()
  }

  /**
   * 27. 超时：没人点就按**默认画质**继续解析。
   *
   * 用户要求：「如果超时了，有人没点那个按钮，那就自动按默认、直接解析的流程处理发送视频」。
   * 面板一发出，这条链接就不会再走正常解析 —— 什么都不做等于把用户的链接吞掉。
   * 「按默认」= 命令里**不带** `--qn=` / `--q=`，解析自然用配置里那一档。
   */
  console.log('\n=== 27. 超时 → 按默认画质继续解析（不把链接晾在那儿） ===')
  {
    bind({ qualityPanelTimeoutSec: 10 })
    panel.debugClear()
    captured.commands.length = 0
    const info = { title: 'T', author: 'A', duration: '01:00', options: options([[80, '1080P', 120], [64, '720P', 60]]) }

    /** 直接调内部那一步（真等 10 秒太慢）：`panel.debugFireTimeouts()` 把所有超时立刻触发 */
    const env = await send(info)
    check('面板挂上了', panel.debugPendingCount() === 1, String(panel.debugPendingCount()))
    await panel.debugFireTimeouts()
    check('超时后面板被摘掉了', panel.debugPendingCount() === 0, String(panel.debugPendingCount()))
    const command = captured.commands[0]?.text ?? ''
    check('跑了解析命令（不是什么都不做）', !!command, command || '没跑')
    check('命令里**没有**画质参数 = 按配置默认', !/--qn=/.test(command) && !/--q=/.test(command), command)
    check('链接（令牌）还在命令里', /--p=/.test(command), command)
    check('面板消息被撤了（群里不留过期列表）', env.calls.recalls.some((item) => item.messageId === 'msg-1'))

    /**
     * 第二步超时同样要兜底：画质已经选好了，没人回答「怎么给」就按**直接发视频**继续
     * （在线播放是要用户主动要的，不该替他选）。
     */
    panel.debugClear()
    captured.commands.length = 0
    const env2 = await send(info)
    await panel.trySelectByText({ ...env2.session, selfId: env2.bot.selfId, content: '1', quote: { id: 'msg-1' } })
    check('先选好了画质（第二步在等）', panel.debugPendingCount() === 1, String(panel.debugPendingCount()))
    await panel.debugFireTimeouts()
    const second = captured.commands[0]?.text ?? ''
    check('第二步超时 → 按「直接发视频」继续', !!second && !/--play=1/.test(second), second || '没跑')
    check('  带的是选好的那一档画质（不是默认）', /--q=80/.test(second), second)
    panel.debugClear()
    bind()
  }

  /**
   * 28. **这次不发视频就别问清晰度**。
   *
   * 用户反馈：「我没有勾选要发送视频啊，怎么还是有一个选择清晰度」——
   * 各平台配置里的「解析时发送的内容」（`*.sendContent`）没勾 `video` 时，
   * 弹一个「选哪档」纯属打扰：根本没有视频会发出去。
   * 正确行为是**跳过面板**走正常解析，该发的信息卡片 / 评论区卡片照发。
   */
  console.log('\n=== 28. 没勾「发送视频」→ 不问清晰度，直接发该发的卡片 ===')
  {
    bind()
    panel.debugClear()
    captured.commands.length = 0
    const info = { title: 'T', author: 'A', duration: '01:00', options: options([[80, '1080P', 120], [64, '720P', 60]]) }

    /** 只勾了「评论图片」：不该有任何面板 */
    bind({ upstream: { douyin: { sendContent: ['info', 'comment'] } } })
    const noVideo = await send(info)
    check('只勾评论图片 → 不发清晰度面板', noVideo.ok === false, String(noVideo.ok))
    check('  一条消息都没发（面板 / 提示都没有）', noVideo.calls.replies.length === 0, String(noVideo.calls.replies.length))
    check('  也没有登记面板', panel.debugPendingCount() === 0, String(panel.debugPendingCount()))

    /** 一个都没勾（空数组）也算「不发视频」 */
    panel.debugClear()
    bind({ upstream: { douyin: { sendContent: [] } } })
    check('一个都没勾（空数组）→ 也不问', (await send(info)).ok === false)

    /** 勾了 video 就照旧问 */
    panel.debugClear()
    bind({ upstream: { douyin: { sendContent: ['video'] } } })
    const withVideo = await send(info)
    check('勾了 video → 照旧问（面板照发）', withVideo.ok === true)
    panel.debugClear()

    /** 快手没有 sendContent 这个配置 → 读不到就按老行为（照旧问，别让用户少拿东西） */
    bind({ upstream: {} })
    panel.debugClear()
    const kuaishou = await send(info, { request: { platform: 'kuaishou' } })
    check('读不到 sendContent（快手那种）→ 保守按「会发视频」照旧问', kuaishou.ok === true)
    panel.debugClear()
    bind()
  }

  /**
   * 29. 卡片下面那句「也可以贴个表情」：**写了就一定要真的贴上去**。
   *
   * 用户反馈：「下方没有说可以点击表情提取……就算手动添加了也没有反应」。
   * 这是**一句话里的两件事**，必须一起验：
   *   - 卡片正文写了「贴个表情」→ 那排表情**真的**贴上去了（不然就是骗人）；
   *   - 真贴了表情 → 卡片正文**必须**写（不然用户不知道那排表情是干嘛的）。
   * 而且要走**真实调用点**（`replyWithCardActions` / `sendSlicedImageWithActions`），
   * 不能只测 `attachCardImageEmojiPanel`（第 22 节测的是那个，它拿不到「调用点传没传对」）。
   */
  console.log('\n=== 29. 卡片上的「提取封面图」：说了能贴表情，就真的贴上去 ===')
  {
    const cache = require(path.join(lib, 'karin/module/utils/CardImageCache.js'))
    const ImageSlice = require(path.join(lib, 'karin/module/utils/ImageSlice.js'))
    /**
     * `sendSlicedImage` 真跑起来要切图、要上传，和这一节要验的东西无关。
     * 产物里是 `(0, ImageSlice_1.sendSlicedImage)(…)`（取属性在调用时），
     * 所以这里把它换掉就能只看「按钮/提示拼得对不对」。
     */
    const realSendSlicedImage = ImageSlice.sendSlicedImage
    const sliced = []
    ImageSlice.sendSlicedImage = async (e, img, extra = []) => { sliced.push({ img, extra }); return true }

    const key = 'bilibili:BV1CARDPANEL'
    cache.rememberCardImages(key, { cover: 'https://cdn.example.com/cover.jpg' })

    /** 一次微任务：面板是 `void attach…` 挂的，不等一下断言不到 */
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

    /** —— 详情卡那条路（有 messageId，表情挂在卡片自己那条消息上）—— */
    bind()
    panel.debugClear()
    captured.commands.length = 0
    let env = makeEnv('onebot', true, { likes: {} })
    await qqPanel.replyWithCardActions(env.e, { type: 'img' }, key, { cover: true })
    await tick()

    const cardText = env.calls.replies[0] ?? ''
    check('卡片正文写了「也可以直接给这条消息贴个表情」', cardText.includes('贴个表情'), JSON.stringify(cardText))
    check('  也写了指令退路（引用发送 kkk封面 <key>）',
      cardText.includes('kkk封面 ' + key), JSON.stringify(cardText.slice(-60)))
    const stuckOnCard = env.calls.reactions.filter((item) => item.isSet)
    check('说完就真贴了：表情贴在卡片那条消息上（msg-1）',
      stuckOnCard.length === 1 && stuckOnCard[0].messageId === 'msg-1',
      JSON.stringify(stuckOnCard))
    check('只有一个封面按钮 → 贴的是 ✅️（478）',
      String(stuckOnCard[0]?.emojiId) === YES, String(stuckOnCard[0]?.emojiId))

    /** 点它（NapCat 真上报的 group_msg_emoji_like）→ 真跑出「kkk封面 <key>」 */
    const handled = await panel.handleEmojiLike({
      ...env.session,
      selfId: env.bot.selfId,
      onebot: {
        notice_type: 'group_msg_emoji_like', group_id: '20001', message_id: 'msg-1',
        user_id: '10002', is_add: true, likes: [{ emoji_id: '396', count: 1 }]
      }
    })
    await tick()
    check('点了表情 → 真的执行（不是「没有反应」）', handled === true)
    check('  跑的是「kkk封面 <key>」（带作品参数）',
      captured.commands.length === 1 && captured.commands[0].text === 'kkk封面 ' + key,
      captured.commands.map((item) => item.text).join(' | '))

    /**
     * —— 评论长图那条路（切片发送拿不到最后一条的 id）——
     *
     * 用户要求：**不要再单独发一条消息**。所以这条路现在
     * **不贴表情、也不写「贴个表情」**（写了却做不到 = 又一次「没有反应」），
     * 封面入口并进清晰度面板（见第 30 节）。
     */
    bind()
    panel.debugClear()
    captured.commands.length = 0
    env = makeEnv('onebot', true, { likes: {} })
    await qqPanel.sendSlicedImageWithActions(env.e, { src: '/tmp/comment.png' }, { cover: true, key })
    await tick()

    check('长图那条**不写**「贴个表情」（挂不上去，就不许说能贴）',
      !String(renderContent(sliced[0]?.extra ?? [])).includes('贴个表情'),
      JSON.stringify(renderContent(sliced[0]?.extra ?? [])))
    check('  但也**没有**为此多发一条消息',
      env.calls.replies.length === 0 && !env.calls.replies.some((item) => item.includes('上面那张卡片')),
      String(env.calls.replies.length))
    check('  一个表情都没贴', env.calls.reactions.length === 0, String(env.calls.reactions.length))
    check('  指令退路还在（引用发送 kkk封面 <key>）',
      String(renderContent(sliced[0]?.extra ?? [])).includes('kkk封面 ' + key))

    /** —— 关掉「QQ 系：用表情当按钮」：既不贴表情，也不许再写那句提示 —— */
    bind({ onebotQualityPanel: false })
    panel.debugClear()
    captured.commands.length = 0
    env = makeEnv('onebot', true, { likes: {} })
    await qqPanel.replyWithCardActions(env.e, { type: 'img' }, key, { cover: true })
    await tick()
    check('开关关着 → 一句「贴个表情」都不写（不骗人）',
      !(env.calls.replies[0] ?? '').includes('贴个表情'), JSON.stringify(env.calls.replies[0]))
    check('  也真的一个表情都没贴', env.calls.reactions.length === 0, String(env.calls.reactions.length))
    check('  但指令退路还在（还能靠引用发送）',
      (env.calls.replies[0] ?? '').includes('kkk封面 ' + key), JSON.stringify(env.calls.replies[0]?.slice(-50)))
    bind()
    panel.debugClear()

    /**
     * 卡片按钮的**等待窗口**要比画质面板长。
     *
     * 画质面板卡着解析往下走，3 分钟没点就该按默认画质继续；卡片是一直挂在群里的，
     * 用户翻回去存封面是几分钟以后的事 —— 3 分钟一过就成了「表情还在、点了没反应」
     * （用户反馈「手动添加了也没有反应」的一条成因）。所以这里给到 10 分钟（sweep 的上限）。
     */
    const src = fs.readFileSync(path.join(lib, 'karin/module/utils/ReactionPanel.js'), 'utf8')
    const body = String(src.match(/const attachCardImageEmojiPanel = [\s\S]{0,1400}/)?.[0] ?? '')
    check('卡片按钮的等待窗口 = 10 分钟（不是画质面板那个 3 分钟）',
      /const timeoutMs = PANEL_TTL_MS/.test(body) && /timeoutMs/.test(body),
      body.includes('PANEL_TTL_MS') ? 'PANEL_TTL_MS' : '缺')
    check('  PANEL_TTL_MS 真的是 10 分钟',
      /const PANEL_TTL_MS = 10 \* 60 \* 1000/.test(src), String(/const PANEL_TTL_MS = 10 \* 60 \* 1000/.test(src)))

    ImageSlice.sendSlicedImage = realSendSlicedImage
  }

  /**
   * 30. 「提取封面图」并进清晰度面板：**多贴一个 ✅️**。
   *
   * 用户要求：「清晰度选择的那个提取封面直接合在一起…监听对的对的就行，
   * 不要再单独发一条消息了。监听到了对对对的，继续监听清晰度选择，如果没有就超时处理。」
   *
   * 也就是：贴 ✅️ = 把封面单独提出来，但**面板不消费** —— 用户还能接着选清晰度，
   * 一直不点则走原来的超时兜底（按默认画质解析）。
   */
  console.log('\n=== 30. 清晰度面板上的 ✅️：提取封面，且面板不摘 ===')
  {
    const cache = require(path.join(lib, 'karin/module/utils/CardImageCache.js'))
    const REQ = { platform: 'bilibili', url: 'https://b23.tv/BV1COVER', id: 'BV1COVER' }
    const info = {
      title: '有封面的那个视频', author: 'UP', duration: '02:31',
      /** 面板要先拿到封面并记进缓存，✅️ 才有的点 */
      detail: { pic: 'https://cdn.example.com/cover.jpg' },
      options: options([[80, '1080P', 120], [64, '720P', 60], [32, '480P', 25]])
    }
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
    const like = (env, messageId, emojiId, userId = '10002') => panel.handleEmojiLike({
      ...env.session,
      selfId: env.bot.selfId,
      onebot: {
        notice_type: 'group_msg_emoji_like', group_id: '20001', message_id: messageId,
        user_id: userId, is_add: true, likes: [{ emoji_id: emojiId, count: 1 }]
      }
    })

    bind()
    panel.debugClear()
    captured.commands.length = 0
    const env = await send(info, { request: REQ })
    const text = panelText(env)
    check('面板发出了', env.ok === true)
    check('面板上写了「提取封面图」', text.includes('提取封面图'), JSON.stringify(text.slice(-80)))
    check('  ✅️（478）印在面板里', panelFaces(env).includes(YES), panelFaces(env).join(','))
    const stuck = env.calls.reactions.filter((item) => item.isSet).map((item) => String(item.emojiId))
    check('  ✅️ 真的贴上去了（且排在最后：478 比 301/320/333 都大）',
      stuck.length === 4 && stuck[3] === YES, stuck.join(','))
    check('  封面已记进缓存（面板是解析之前发的，不记就没得点）',
      qqPanel.hasCardImage('bilibili:BV1COVER', 'cover') === true)

    /** 贴 ✅️ → 跑提取封面，**面板还在** */
    check('贴 ✅️ 被认出来了', (await like(env, 'msg-1', YES)) === true)
    await tick()
    check('  跑的是「kkk封面 <key>」',
      captured.commands.length === 1 && captured.commands[0].text === 'kkk封面 bilibili:BV1COVER',
      captured.commands.map((item) => item.text).join(' | '))
    check('  面板**没有被摘掉**（还能接着选清晰度）', panel.debugPendingCount() === 1,
      String(panel.debugPendingCount()))
    check('  这一步还没开始解析', !captured.commands.some((item) => item.text.includes('--q=')))

    /** 同一个人再贴一次 ✅️ → 不重复执行 */
    check('再贴一次 ✅️ 也被认（事件本身是真的）', (await like(env, 'msg-1', YES)) === true)
    await tick()
    check('  但封面**只发了一遍**（一次点击只看一遍）',
      captured.commands.filter((item) => item.text.startsWith('kkk封面')).length === 1,
      captured.commands.map((item) => item.text).join(' | '))

    /** 接着选清晰度：照旧走第二步「是否在线播放」 */
    check('选第 1 档（301）→ 照旧问「是否在线播放」', (await like(env, 'msg-1', QUALITY_EMOJI[0])) === true)
    await tick()
    const ask = env.calls.replies.find((item) => item.includes('在线播放')) ?? ''
    check('  第二步真的发出了', !!ask, JSON.stringify(ask.slice(0, 30)))
    check('  回显了选中的画质', ask.includes('1080P'))
    check('  到这一步才开始解析（封面那条不算解析）',
      captured.commands.filter((item) => item.text.includes('--q=')).length === 0,
      captured.commands.map((item) => item.text).join(' | '))
    panel.debugClear()

    /** 数字列表那版（没有表情可点）：封面占一个序号 */
    bind({ onebotQualityPanel: false })
    panel.debugClear()
    captured.commands.length = 0
    const plain = await send(info, { request: REQ })
    const plainText = panelText(plain)
    check('没有表情时：封面也占一个序号（3 档 → 第 4 项）',
      plainText.includes('4. 提取封面图'), JSON.stringify(plainText.slice(-80)))
    check('  纯文字版一个表情都不贴', plain.calls.reactions.length === 0, String(plain.calls.reactions.length))
    panel.debugClear()

    /** 反向：拿不到封面就别贴那个 ✅️ —— 点了没反应的摆设不如不挂 */
    const noCover = await send({ ...info, detail: undefined },
      { request: { ...REQ, id: 'BV1NOCOVER' } })
    check('拿不到封面 → 不贴 ✅️、也不写「提取封面图」',
      !panelText(noCover).includes('提取封面图')
      && !noCover.calls.reactions.some((item) => String(item.emojiId) === YES),
      panelText(noCover).slice(-60))
    panel.debugClear()
    bind()
  }

  /**
   * 31. 开着「解析结果合并转发」时，面板这条消息**必须真的发出去**。
   *
   * 合并转发模式下 `e.reply()` 会把内容收进缓冲区、回一个**假的**消息 id
   * （`forward-collected`）—— 面板拿假 id 去贴表情、去等回应，当然永远等不到
   * （用户反馈「贴了表情也没有反应」的一条成因）。
   *
   * 所以面板相关发送一律 `withoutForwardCollect`：**先只发选择提示，选完撤回，
   * 解析产生的内容才进合并转发**。
   */
  console.log('\n=== 31. 合并转发开着时，选择提示不能被收进转发 ===')
  {
    const fc = require(path.join(lib, 'compat/forward-collect.js'))
    const info = { title: 'T', author: 'A', duration: '01:00', options: options([[80, '1080P', 120], [64, '720P', 60]]) }
    bind()
    panel.debugClear()

    /** 假 `reply`：完全照 `Message.reply` 的第一段写（真被收走就回假 id、且不落地） */
    const forwardEnv = () => {
      const env = makeEnv('onebot', true, { likes: {} })
      const raw = env.e.reply
      env.e.reply = async (content) => {
        if (fc.collectForward('20001', content)) return { messageId: fc.COLLECTED_MESSAGE_ID }
        return await raw(content)
      }
      return env
    }

    const env = forwardEnv()
    let groups = null
    let ok = false
    await fc.runWithForwardBag('20001', async () => {
      ok = await panel.sendQualityReactionPanel(env.e, { ...REQUEST })
      groups = fc.currentForwardBag()?.groups ?? null
    })
    check('面板发出来了', ok === true)
    /**
     * 袋子里**什么都不要有**（用户要求：「这种情况下先不要渲染图片，先询问清晰度，
     * 后面再合成一条」）。
     *
     * 之前是「袋子里留一张详情卡」，但那样会劈成**两条**转发：面板发出去 handler
     * 就返回了，那个只装着卡片的袋子立刻被冲刷；等用户选完画质再冲刷第二次。
     * 现在面板阶段一张图都不渲染，袋子保持空 —— 卡片留到真正解析那一步去发，
     * 和视频、评论卡一起攒进**同一个**袋子，最后只出一条转发。
     */
    check('  面板阶段**一张图都不渲染**（否则会劈成两条转发）',
      (groups ?? []).length === 0, JSON.stringify((groups ?? []).map((g) => g.length)))
    check('  群里也不多发一张卡片（详情卡留到解析那一步）',
      !env.calls.replies.some((item) => /^\[img:|img:/.test(String(item))),
      env.calls.replies.join(' | ').slice(0, 120))
    check('  提示里仍然写清了各档清晰度',
      env.calls.replies.some((item) => item.includes('1080P')),
      env.calls.replies.join(' | ').slice(0, 80))
    check('  没有卡片时把标题补进文字里（用户得知道在选哪个视频）',
      env.calls.replies.some((item) => /《[^》]+》/.test(String(item))),
      env.calls.replies.join(' | ').slice(0, 80))
    check('  面板拿到的是**真的**消息 id（不是 ' + fc.COLLECTED_MESSAGE_ID + '）',
      env.calls.replies.some((item) => item.includes('1080P'))
      && !env.calls.replies.includes(fc.COLLECTED_MESSAGE_ID),
      env.calls.replies.join(' | ').slice(0, 80))
    check('  面板登记成功（有面板在等，表情能贴到真消息上）',
      panel.debugPendingCount() === 1, String(panel.debugPendingCount()))
    check('  表情贴在了真消息上（msg-1）',
      env.calls.reactions.length > 0 && env.calls.reactions.every((item) => item.messageId === 'msg-1'),
      JSON.stringify(env.calls.reactions.slice(0, 2)))

    /** 对照：不包 withoutForwardCollect 的普通发送**会**被收走（证明上面不是碰巧） */
    const env2 = forwardEnv()
    let collected = false
    await fc.runWithForwardBag('20001', async () => {
      collected = fc.collectForward('20001', '一条普通内容')
    })
    check('对照：普通内容照样被收进转发（收集器本身是好的）', collected === true)
    check('  withoutForwardCollect 里则不收',
      await fc.runWithForwardBag('20001', async () => await fc.withoutForwardCollect(
        () => fc.collectForward('20001', 'x'))) === false)
    panel.debugClear()
  }

  /**
   * 32. 「提取封面图」那句提示里**不许出现 ✅️ 字符**（用户反馈：
   *     「✅️ 不要用这个，直接表情」；「ll 还是去 ✅️」）。
   *
   * 那个字符在 QQ 上会被渲染成另一个图案，跟真贴上去的那个表情对不上 ——
   * 用户照着找一个对不上的图案，写了等于白写。
   *   - **NapCat**（行内排法）：用**真 face 段**；
   *   - **LLOneBot**（末尾一排）：文字中间插 face 段会被吞，只能**点名**写「对的对的」。
   */
  console.log('\n=== 32. 「提取封面图」的提示里不写 ✅️ 字符 ===')
  {
    const REQ2 = { platform: 'bilibili', url: 'https://b23.tv/BV1COVER2', id: 'BV1COVER2' }
    const info2 = {
      title: 'T', author: 'A', duration: '01:00',
      detail: { pic: 'https://cdn.example.com/cover2.jpg' },
      options: options([[80, '1080P', 120], [64, '720P', 60]])
    }
    bind()
    panel.debugClear()

    const last = (env) => env.calls.raw[env.calls.raw.length - 1] ?? []
    const textsOf = (env) => last(env)
      .filter((item) => item && item.type === 'text')
      .map((item) => String(item.attrs?.content ?? '')).join('\n')
    const facesOf = (env) => last(env)
      .filter((item) => item && item.type === 'face')
      .map((item) => String(item.attrs?.id ?? ''))
    const NO_CHECK = /[\u2705\u2611\u2714]/

    /** NapCat：行内排法 → 封面那一格必须是真表情段 */
    const nc = await send(info2, { request: REQ2, env: { likes: {} } })
    check('NapCat：写清了「提取封面图」', textsOf(nc).includes('提取封面图'), textsOf(nc).slice(-60))
    check('  文字里**没有** ✅️ 字符', !NO_CHECK.test(textsOf(nc)), JSON.stringify(textsOf(nc).slice(-60)))
    check('  封面那一格是**真表情段** 478', facesOf(nc).includes(YES), facesOf(nc).join(','))
    panel.debugClear()

    /**
     * LLOneBot：末尾一排 → 只能点名，同样不许写 ✅️
     *
     * ⚠️ 必须换一个 selfId：`queryAdapterImplementation` 的结果**按机器人缓存**
     * （一个机器人只问一次），用同一个 id 会直接命中上面 NapCat 那份结果。
     *
     * ⚠️ `platform` 故意给 'napcat'（适配器就叫这个名字）：排法**只看协议端自报的
     * app_name**，不能因为适配器叫 napcat 就用行内排法 —— 用户实测那样会被吞字
     * （5 档清晰度只剩「1.」和「5.」两行）。
     */
    const ll = await send(info2, {
      request: REQ2,
      platform: 'napcat',
      env: { likes: {}, appName: 'LLOneBot', selfId: '3889001' }
    })
    check('  适配器 platform 叫 napcat 也不能用行内排法（只看协议端自报）',
      textsOf(ll).includes('下面这排表情从左到右数'), textsOf(ll).slice(-60))
    check('LLOneBot：写清了「提取封面图」', textsOf(ll).includes('提取封面图'), textsOf(ll).slice(-60))
    check('  文字里**没有** ✅️ 字符（ll 上也去掉）', !NO_CHECK.test(textsOf(ll)), JSON.stringify(textsOf(ll).slice(-60)))
    check('  改成点名「对的对的」（和那排最右边真贴的那个是同一个表情）',
      textsOf(ll).includes('对的对的'), textsOf(ll).slice(-60))
    check('  ll 上仍然不把 face 段插进文字中间（插了会被吞）',
      facesOf(ll).length === 3 && facesOf(ll).includes(YES), facesOf(ll).join(','))
    panel.debugClear()
  }

  /**
   * 33. **Milky**：它**不是** OneBot（没有 `set_msg_emoji_like`），但适配器实现了
   *     **Satori 标准**的 `createReaction(channelId, messageId, emojiId)` ——
   *     所以「贴表情当按钮」这条路在 Milky 上是通的，只是形状完全不一样：
   *
   *   |        | 贴表情                                        | 表情 id   | 点击事件           |
   *   |--------|-----------------------------------------------|-----------|--------------------|
   *   | OneBot | `setMsgEmojiLike(messageId, emojiId, isAdd)`   | `301`     | `group_msg_emoji_like` |
   *   | Milky  | `createReaction(channelId, messageId, id)`    | `face|301`| `reaction-added`   |
   *
   * 事件侧适配器把 `group_message_reaction` 转成了标准名 `reaction-added`，
   * `session.event.emoji.id` 也是 `face|301` 这个写法 —— 贴和认必须同一套转换。
   */
  console.log('\n=== 33. Milky：createReaction 贴表情 + reaction-added 收点击 ===')
  {
    const REQ3 = { platform: 'bilibili', url: 'https://b23.tv/BV1MILKY', id: 'BV1MILKY' }
    const info3 = {
      title: 'T', author: 'A', duration: '01:00',
      detail: { pic: 'https://cdn.example.com/milky.jpg' },
      options: options([[80, '1080P', 120], [64, '720P', 60]])
    }
    bind()
    panel.debugClear()

    const probe = makeEnv('milky', true, { satori: true, appName: null, selfId: '3889002' })
    check('Milky 也能用表情面板（isReactionPanelCapable 认它）',
      panel.isReactionPanelCapable(probe.e) === true)

    const env = await send(info3, {
      request: REQ3,
      platform: 'milky',
      env: { satori: true, appName: null, selfId: '3889002' }
    })
    check('面板发出去了', env.ok === true)
    const stuck = env.calls.reactions.filter((item) => item.isSet)
    check('  表情贴上去了（走 createReaction，不是 set_msg_emoji_like）',
      stuck.length === 3, JSON.stringify(stuck.map((item) => item.emojiId)))
    check('  emojiId 写成了 Milky 的 `face|301` 形式',
      stuck.length > 0 && stuck.every((item) => /^(face|emoji)\|/.test(String(item.emojiId))),
      JSON.stringify(stuck.map((item) => item.emojiId)))
    check('  createReaction 拿到了群号（它要从 channelId 里解 peerId / messageSeq）',
      stuck.length > 0 && stuck.every((item) => String(item.channelId) === '20001'),
      JSON.stringify(stuck.map((item) => item.channelId)))

    /** 机器人自己贴那排时协议端也会上报 —— 不能算用户点的 */
    const self = await panel.handleReactionEvent({
      ...env.session, type: 'reaction-added', channelId: '20001', messageId: 'msg-1',
      userId: env.bot.selfId, selfId: env.bot.selfId, event: { emoji: { id: 'face|320' } }
    })
    check('  机器人自己贴的上报不算（不然面板一发出就被自己点掉）', self === false)

    /** 取消回应不算 */
    const removed = await panel.handleReactionEvent({
      ...env.session, type: 'reaction-removed', channelId: '20001', messageId: 'msg-1',
      userId: '10002', selfId: env.bot.selfId, event: { emoji: { id: 'face|320' } }
    })
    check('  reaction-removed 不算选中', removed === false)

    /** 真用户点第 2 档（face|320 → 320）→ 进第二步「是否在线播放」 */
    const hit = await panel.handleReactionEvent({
      ...env.session, type: 'reaction-added', channelId: '20001', messageId: 'msg-1',
      userId: '10002', selfId: env.bot.selfId, event: { emoji: { id: 'face|320' } }
    })
    check('  reaction-added 被认出来了', hit === true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    check('  选完进了第二步「是否在线播放」',
      env.calls.replies.some((item) => item.includes('在线播放')),
      env.calls.replies.join(' | ').slice(-80))
    check('  撤掉原来那排表情时走的是 deleteReaction',
      env.calls.reactions.some((item) => item.isSet === false),
      JSON.stringify(env.calls.reactions.map((item) => String(item.emojiId) + (item.isSet ? '+' : '-'))))
    panel.debugClear()
  }

  /**
   * 34. **Satori 适配器**：Bot 上**一个**表情方法都没有，但协议有 HTTP 接口。
   *
   * 用户反馈「satori 适配器可以收到表情但是没办法发表情」——
   * `@satorijs/adapter-satori` 的 `SatoriBot` 是按 `Universal.Methods` 那张表在原型上
   * 批量生成方法的，而 reaction 是**实验性资源**，不在表里 ⇒ **连 `createReaction` 都没有**。
   * 但协议本身是通的（https://satori.chat/zh-CN/resources/reaction.html）：
   * `POST /v1/reaction.create|delete|list`，字段是 snake_case。
   * 而 `bot.http` 自带 `Satori-Platform` 那些头，直接照协议发就行。
   */
  console.log('\n=== 34. Satori 适配器：没有方法 → 走 /v1/reaction.* ===')
  {
    const REQ4 = { platform: 'bilibili', url: 'https://b23.tv/BV1SATORI', id: 'BV1SATORI' }
    const info4 = {
      title: 'T', author: 'A', duration: '01:00',
      detail: { pic: 'https://cdn.example.com/satori.jpg' },
      options: options([[80, '1080P', 120], [64, '720P', 60]])
    }
    bind()
    panel.debugClear()

    const env = await send(info4, {
      request: REQ4,
      platform: 'chronocat',
      env: { httpOnly: true, appName: null, selfId: '3889003' }
    })
    check('面板发出去了', env.ok === true)
    check('  一个表情方法都没调（Bot 上确实没有）', env.calls.reactions.length === 0,
      JSON.stringify(env.calls.reactions))
    const created = env.calls.http.filter((item) => /reaction\.create$/.test(String(item.path)))
    check('  改走 Satori 的 /v1/reaction.create', created.length === 3,
      JSON.stringify(env.calls.http.map((item) => item.path)))
    check('  路径带了 /v1 前缀（适配器自己就是这么拼的）',
      created.length > 0 && created.every((item) => String(item.path).startsWith('/v1/')),
      JSON.stringify(created.map((item) => item.path)))
    check('  载荷是 Satori 的 snake_case（channel_id / message_id / emoji_id）',
      created.length > 0 && created.every((item) => item.payload
        && item.payload.channel_id === '20001'
        && item.payload.message_id === 'msg-1'
        && /^\d+$/.test(String(item.payload.emoji_id))),
      JSON.stringify(created[0]?.payload))
    check('  非 Milky 平台不加 `face|` 前缀',
      created.length > 0 && created.every((item) => !/\|/.test(String(item.payload.emoji_id))),
      JSON.stringify(created.map((item) => item.payload.emoji_id)))

    /** 轮询：`/v1/reaction.list` 能查到 → 这条链路在 Satori 上也是通的 */
    await new Promise((resolve) => setTimeout(resolve, 60))
    check('  /v1/reaction.list 也发了（Satori 有查询接口，轮询能起来）',
      env.calls.http.some((item) => /reaction\.list$/.test(String(item.path))),
      JSON.stringify(env.calls.http.map((item) => item.path)))
    panel.debugClear()
  }

  console.log('\n' + (failed ? '\u2718 有 ' + failed + ' 项没通过' : '\u2714 全部通过'))
  process.exit(failed ? 1 : 0)
})().catch((error) => {
  console.error('\n探针崩了：', error?.stack ?? error)
  process.exit(1)
})
