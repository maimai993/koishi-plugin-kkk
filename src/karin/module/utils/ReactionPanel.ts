/**
 * OneBot 平台的「表情选择面板」。
 *
 * ## 为什么要有它
 * QQ 官方机器人能发 markdown + 原生按钮，用户点一下就选好清晰度（见 QqPanel）。
 * **OneBot（NapCat / Lagrange…）没有这套 API**：它既没有 markdown 模板、也没有 keyboard 按钮，
 * 所以原来的逻辑走到 `isQqPlatform` 就 false 了 —— OneBot 群里发链接只能按配置里写死的画质直接解析。
 *
 * 表情回应（`set_msg_emoji_like`）是 OneBot 唯一还能用的「按钮」：机器人往自己那条消息上贴一排表情，
 * QQ 会把它们排成消息下面的一行小图标，用户点其中一个就等于「按了这个按钮」。
 *
 * ## 两步走
 *   1. **选清晰度**：每一档画质对应一个表情；
 *   2. **是否在线播放**：只有在线播放器开着才会问（关着时视频一定发到群里，没什么可选的）。
 *
 * ## 怎么判断「用户点了哪个」
 * 适配器只给一条快照式的 `onebot/message-reactions-updated`（`current_reactions` 里是现在的
 * **每种表情的总数**），既不说是谁点的、也不说变了什么。所以这里做计数差值：
 * 机器人自己贴过一遍（每个 +1）之后，某个表情的**数量变多了**就说明有人点了它。
 *
 * 基准值不写死成 1：收到快照时会把「比基准更小的值」采纳为新基准，
 * 这样万一机器人自己那排没贴成功（数量 0），用户点一下变成 1 也认得出来。
 *
 * ## 表情的顺序 = 列表的顺序
 * QQ 那排小图标按 **emoji id 升序**排（不是按添加顺序），所以这里给第 1/2/3… 个选项
 * 分配的也是**升序**的表情 id —— 两种排序规则下结果一致，第 N 个表情就是列表第 N 行。
 */
import type { Message } from 'node-karin'
import { logger } from 'node-karin'

import { commandInvocation, tryGetRuntime } from '../../../compat/runtime'
import { KkkBot } from '../../../compat/node-karin'
import { segment } from '../../../compat/segment'
import { isOnlinePlayerEnabled } from '../../../player'
import { platformOf, isOneBotLike } from './ImageSlice'
import { fetchPanelInfo, rememberPanelRequest, uploadPanelCard, type PanelRequest } from './QqPanel'

/**
 * 画质选择用的表情（QQ 系统表情 id），**必须升序**（见文件头的排序说明）。
 *
 * ## 为什么不用 Unicode emoji
 * `set_msg_emoji_like` 认两种 id：QQ 系统表情（三位以内）和 Unicode 码点（如 👍 = 128077）。
 * 但**不少客户端 / 协议端只认 QQ 系统表情**，传码点过去要么贴不上、要么显示成一个问号框；
 * 而且码点没法直接印在消息里 —— 想让选项前面出现表情，只能写真正的 emoji 字符，
 * 又有一批老客户端 / 协议端打不出来。
 *
 * 全用 QQ 系统表情就没这些问题：**贴得上去**，并且**同一个 id 能用 `face` 段印进消息里**
 * （`segment.face(id)`），选项前面直接显示那张表情图，和下面那排按钮一一对应。
 */
const QUALITY_EMOJI_IDS = ['301', '320', '333', '351', '355', '369', '371', '383', '396', '405']

/** 「是」= 478 对的对的，「否」= 479 不对不对（用户指定的一对） */
const YES_EMOJI_ID = '478'
const NO_EMOJI_ID = '479'

/** 面板等回应的上限（超过就把这条消息从表里丢掉，没人管的面板不该一直占内存） */
const PANEL_TTL_MS = 10 * 60 * 1000
/** 同时盯着的面板上限 */
const PANEL_MAX = 200

/** 一步可以选的东西 */
interface Choice {
  emojiId: string
  /** 选中后要落到命令里的画质标识（第一步）；第二步不带，改用 onlineWatch 标记 */
  qualityId?: string
  /** 回显给用户用的名字（第一步是「1080P」这类画质名） */
  label?: string
  onlineWatch?: boolean
}

/** 一个等待用户点表情的面板 */
interface PendingPanel {
  key: string
  channelId: string
  messageId: string
  /** 第一步 = 选画质，第二步 = 选是否在线播放 */
  step: 'quality' | 'watch'
  choices: Choice[]
  /** 这条链接对应的短令牌（体积提示要靠它反查） */
  token: string
  /** emojiId → 上一次看到的数量 */
  baseline: Map<string, number>
  request: PanelRequest
  /** 跑解析命令要用哪条会话：留着原来那条（信息比回应事件的会话更全） */
  session: any
  /** 上一步选中的画质（第二步回退到的那张卡要显示它） */
  qualityId?: string
  qualityLabel?: string
  /** 这条链路上前面已经发过的消息，选完要一起撤回 */
  recallIds: string[]
  createdAt: number
}

/** 等待中的面板：key = `会话ID:消息ID` */
const pending = new Map<string, PendingPanel>()

const keyOf = (channelId: string, messageId: string): string => channelId + ':' + messageId

/** 清理过期/超量的面板 */
const sweep = (): void => {
  if (!pending.size) return
  const now = Date.now()
  for (const [key, panel] of pending) {
    if (now - panel.createdAt > PANEL_TTL_MS) pending.delete(key)
  }
  while (pending.size > PANEL_MAX) pending.delete(pending.keys().next().value as string)
}

/** 这个开关「OneBot 用表情选清晰度」是不是开着 */
export const isReactionPanelEnabled = (): boolean => {
  const config = tryGetRuntime()?.config as any
  return (config?.onebotQualityPanel ?? true) !== false
}

/** 这条消息能不能走表情面板：平台是 OneBot 系 + 是群聊 */
export const isReactionPanelCapable = (e: Message): boolean => {
  // 注意这里不能用 e.isPrivate：兼容层的 Message 上没有这个字段（读了永远是 undefined）
  if (!e?.isGroup) return false
  return isOneBotLike(platformOf(e))
}

/** 事件里拿到的可能是原始 Bot，而 `e.bot` 已经是 KkkBot 了 —— 包两层会让能力探测拿到包装对象 */
const kkkBotOf = (bot: any): KkkBot => (bot instanceof KkkBot ? bot : new KkkBot(bot))

/**
 * 往消息上贴 / 取消一个表情。
 *
 * 注意**不经过 EmojiReaction.setEmojiReaction**：那个函数受 `Config.app.EmojiReply`
 * 控制（它只是「处理中/完成」的提示开关），而这个 emoji 是面板的按钮本体，必须独立于它。
 */
const setReaction = async (bot: any, messageId: string, emojiId: string, isAdd: boolean): Promise<boolean> => {
  try {
    return await kkkBotOf(bot).setMsgReaction('', messageId, emojiId, isAdd)
  } catch (error: any) {
    logger.debug('[表情面板] 贴表情失败（已忽略）: ' + String(error?.message ?? error))
    return false
  }
}

/** 把机器人自己贴的那排表情全部取消，并把面板消息撤回 */
const clearPanel = async (bot: any, panel: PendingPanel): Promise<void> => {
  for (const choice of panel.choices) {
    await setReaction(bot, panel.messageId, choice.emojiId, false)
  }
  for (const id of panel.recallIds) {
    await recallQuietly(bot, panel.channelId, id)
  }
  await recallQuietly(bot, panel.channelId, panel.messageId)
}

/**
 * 取消某个消息上贴的所有表情。
 *
 * 选完清晰度之后第一排表情必须撤掉：它还在那儿、点起来却没有任何反应（面板已经失效了），
 * 用户只会以为「机器人卡住了」。撤回那条消息也能让它消失，但**撤回可能被权限挡下来**，
 * 所以表情要单独收拾一遍。
 */
const clearReactions = async (bot: any, messageId: string, emojiIds: string[]): Promise<void> => {
  for (const emojiId of emojiIds) {
    await setReaction(bot, messageId, emojiId, false)
  }
}

const recallQuietly = async (bot: any, channelId: string, messageId: string): Promise<void> => {
  if (!messageId) return
  try {
    await kkkBotOf(bot).recallMsg(messageId, channelId)
  } catch (error: any) {
    logger.debug('[表情面板] 撤回面板消息失败（已忽略）: ' + String(error?.message ?? error))
  }
}

/** 预估体积 → 「60MB」这种短写法 */
const sizeText = (sizeMB: number): string => {
  const num = Number(sizeMB)
  if (!Number.isFinite(num) || num <= 0) return '体积未知'
  return num < 1 ? '<1MB' : Math.round(num) + 'MB'
}

/**
 * 发一条「第几个表情 = 哪一档」的选择消息，并在它下面贴一排表情。
 * @param e 原始解析事件（群消息）
 * @param request 作品信息
 * @returns true = 面板已发出，本次不再直接解析
 */
export async function sendQualityReactionPanel (e: Message, request: PanelRequest): Promise<boolean> {
  if (!isReactionPanelEnabled()) return false
  if (!isReactionPanelCapable(e)) return false

  const runtime = tryGetRuntime()
  if (!runtime) return false

  const info = await fetchPanelInfo(request)
  /**
   * 只有一档画质时还问一遍纯属打扰 —— 直接按它解析。
   * 也省掉了「面板发出来但只有一行」的尴尬。
   */
  if (!info || info.options.length < 2) return false

  /**
   * 哪些档位能列出来：在线播放开着时不看体积（视频不发到群里），
   * 否则还是按 `qqFileLimitMB` 过滤（超了发不出去）。与 QQ 面板同一套判据。
   */
  const limit = Number((runtime.config as any).qqFileLimitMB ?? 200) || 200
  const onlinePlayer = isOnlinePlayerEnabled()
  const visible = onlinePlayer ? info.options : info.options.filter((option) => option.sizeMB <= limit)
  const shown = (visible.length ? visible : [info.options[info.options.length - 1]]).slice(0, QUALITY_EMOJI_IDS.length)

  /**
   * 令牌的作用和 QQ 面板一样：按钮里只放 `--p=<令牌>`，链接（和各档体积）留在内存里，
   * 解析时它能反查出这一档的预估体积，好提示「超过 30MB 会以文件发送」。
   */
  const sizes: Record<string, number> = {}
  for (const option of info.options) sizes[String(option.id)] = option.sizeMB
  const token = rememberPanelRequest(request, sizes)

  const channelId = String(e.contact?.peer ?? '')

  const choices: Choice[] = shown.map((option, index) => ({
    emojiId: QUALITY_EMOJI_IDS[index],
    qualityId: String(option.id),
    label: option.label
  }))

  /**
   * 渲染卡片要点时间（大卡片十几秒），先回一句「加载中…」，卡片发出去后再撤掉。
   *
   * **没有 assets 服务时干脆不提示**：那种情况下根本没有卡片、面板是秒发的，
   * 发一句再撤掉只是在群里闪一下。
   */
  const hasAssets = typeof (runtime as any)?.ctx?.assets?.upload === 'function'
  let loadingId = ''
  if (hasAssets) {
    try {
      const tip: any = await e.reply('正在加载卡片…')
      loadingId = String(tip?.messageId ?? '')
    } catch (error: any) {
      logger.debug('[表情面板] 「加载中」提示发送失败（不影响面板）: ' + String(error?.message ?? error))
    }
  }
  let card: { url: string; width: number; height: number } | null = null
  try {
    card = await uploadPanelCard(e, request, info.detail, info.hotDanmaku ?? [])
  } catch (error: any) {
    logger.debug('[表情面板] 渲染卡片失败（退回纯文字面板）: ' + String(error?.message ?? error))
  }

  /**
   * 拼一条消息：**卡片图 + 一段完整文字 + 最后排一行表情**。
   *
   * 卡片和 QQ 面板用的是同一张（同一套模板渲染出来，见 uploadPanelCard），
   * 只是这里发成**普通图片段** —— OneBot 不认 markdown，写成 md 就是一串纯文本。
   *
   * ## 三个坑
   *   1. **标题 / UP / 时长**：有卡片时这些已经在卡里了，文字里再发一遍是重复（用户反馈）；
   *   2. **表情不能和每行文字交错排**：「face → 1. … → face → 2. …」这种结构，
   *      QQ 会**吞掉中间的文本段**（用户实测 5 行选项只剩首尾两行）。
   *      所以文字全部收进**一个** text 段里；
   *   3. 表情还是要有（用户反馈「放在选项前面更直观」），所以改成**整条消息最后排一行**，
   *      顺序和下面那排回应完全一致，照着数就行。
   *
   * @param withFace 末尾要不要排表情（`face` 段）。
   *   有个别协议端不认 `face`，那时整条消息会发送失败，所以留了不带表情的退路：
   *   **面板本身比表情那行重要**，发不出去等于什么都没有。
   */
  const buildPanel = (withFace: boolean): any[] => {
    const body: string[] = []
    if (!card?.url) {
      if (info.title) body.push('《' + info.title + '》')
      const meta = [info.author && 'UP：' + info.author, info.duration && info.duration].filter(Boolean).join(' · ')
      if (meta) body.push(meta)
      if (body.length) body.push('')
    }
    body.push('点这条消息下面的表情，选一档清晰度：')
    shown.forEach((option, index) => {
      body.push((index + 1) + '. ' + option.label + ' · ' + sizeText(option.sizeMB))
    })
    body.push('（' + (
      withFace
        ? '下面这排表情从左到右数，第几个就是上面第几档'
        : '从左到右数第几个表情，就是上面第几档'
    ) + '）')

    const list: any[] = []
    if (card?.url) list.push(segment.image(card.url))
    list.push(segment.text(body.join('\n')))
    if (withFace) {
      for (let index = 0; index < shown.length; index++) list.push(segment.face(QUALITY_EMOJI_IDS[index]))
    }
    return list
  }

  let messageId = ''
  try {
    messageId = String((await e.reply(buildPanel(true)))?.messageId ?? '')
  } catch (error: any) {
    logger.debug('[表情面板] 带表情的面板发送失败（协议端可能不认 face 段），退回纯文本: ' + String(error?.message ?? error))
  }
  if (!messageId) {
    try {
      messageId = String((await e.reply(buildPanel(false)))?.messageId ?? '')
    } catch (error: any) {
      logger.debug('[表情面板] 发送选择消息失败: ' + String(error?.message ?? error))
    }
  }
  if (!messageId) {
    await recallQuietly(e.bot, channelId, loadingId)
    return false
  }
  /** 卡片已经并进面板这条消息了，「加载中」那句就没用了 */
  await recallQuietly(e.bot, channelId, loadingId)

  sweep()
  pending.set(keyOf(channelId, messageId), {
    key: keyOf(channelId, messageId),
    channelId,
    messageId,
    step: 'quality',
    choices,
    token,
    baseline: new Map(choices.map((choice) => [choice.emojiId, 1])),
    request,
    session: (e as any).session,
    recallIds: [],
    createdAt: Date.now()
  })

  /**
   * 贴表情放在登记之后：万一这两个通知发得比登记早，处理函数已经能查到面板了。
   * 有一个贴失败不影响其它 —— 少一个按钮用户还能少选一档，不至于整个面板失效。
   */
  for (const choice of choices) {
    await setReaction(e.bot, messageId, choice.emojiId, true)
  }
  logger.mark('[表情面板] 已发出清晰度面板（%d 档%s），等待用户点表情…', choices.length, card ? '，带卡片图' : '')
  return true
}

/** 第二步的两个选项：是 = 478，否 = 479 */
const YES_NO_CHOICES: Choice[] = [
  { emojiId: YES_EMOJI_ID, onlineWatch: true },
  { emojiId: NO_EMOJI_ID, onlineWatch: false }
]

/**
 * 收到 OneBot 的回应更新事件。
 * @param session Koishi 会话（适配器给的 notice session，带 `session.onebot` 原始载荷）
 * @returns true = 这条事件是我们的面板、并且已经挑下一步/开始解析
 */
export async function handleReactionUpdate (session: any): Promise<boolean> {
  if (!session) return false
  if (!isReactionPanelEnabled()) return false

  const channelId = String(session.channelId ?? session.guildId ?? '')
  const messageId = String(session.messageId ?? '')
  if (!channelId || !messageId) return false

  const key = keyOf(channelId, messageId)
  const panel = pending.get(key)
  if (!panel) return false

  const reactions: Array<{ emoji_id: string; count: number }> = session.onebot?.current_reactions ?? []
  if (!Array.isArray(reactions) || !reactions.length) return false

  /**
   * 找出被点中的那个：数量比上次看到的多。
   * 没变多就把当前值采纳成新基准（见文件头：这样机器人自己没贴成功时也能自愈）。
   */
  let picked: Choice | undefined
  for (const reaction of reactions) {
    const emojiId = String(reaction?.emoji_id ?? '')
    const choice = panel.choices.find((item) => item.emojiId === emojiId)
    if (!choice) continue
    const count = Number(reaction?.count ?? 0)
    const base = panel.baseline.get(emojiId)
    if (base === undefined) {
      panel.baseline.set(emojiId, count)
      continue
    }
    if (count > base) {
      picked = choice
      break
    }
    panel.baseline.set(emojiId, count)
  }
  if (!picked) return false

  /*
   * 到这一步就已经选中了 —— 立刻把面板从表里摘掉：
   * 同一个人可能连点两下、QQ 也会因为「取消再贴」再发一遍事件，留着只会重复解析。
   */
  pending.delete(key)
  const bot = session.bot

  if (panel.step === 'quality') {
    return await sendWatchQuestion(session, panel, String(picked.qualityId ?? ''), String(picked.label ?? picked.qualityId ?? ''), bot)
  }

  // 第二步：拿到「是否在线播放」的答案，落地成一次真正的解析
  await clearPanel(bot, panel)
  await runParse(panel.session ?? session, panel, picked.onlineWatch === true)
  return true
}

/**
 * 收到 NapCat 的「群表情回应」事件（`group_msg_emoji_like`）。
 *
 * ## 为什么必须单独接这条
 * 先做的版本只监听 OneBot 标准事件 `message_reactions_updated`（当前数量的快照），
 * 但 **NapCat 根本不发那个**：它发的是自己的 `group_msg_emoji_like` ——
 * 逐次点击上报（`user_id` / `is_add` / `likes: [{emoji_id, count}]`）。
 * 用户实测「点了没反应」就是因为监听挂在了那条收不到的事件上。
 *
 * 这条事件其实更好用：**`is_add=true` 就是有人新贴了一个**，不用再对计数做差值。
 * 机器人自己贴的那排（和选完后撤掉的那排）也会上报 —— 靠 `user_id !== selfId` 滤掉。
 */
export async function handleEmojiLike (session: any): Promise<boolean> {
  if (!session) return false
  if (!isReactionPanelEnabled()) return false
  const data: any = session.onebot ?? {}
  if (data.notice_type !== 'group_msg_emoji_like') return false
  if (data.is_add === false) return false

  /** 机器人自己贴的（以及撤掉的）不上来算 —— 只认别的用户 */
  const selfId = String(session.selfId ?? session.bot?.selfId ?? '')
  const who = String(data.user_id ?? '')
  if (selfId && who && who === selfId) return false
  /** 个别实现不带上报人：没 user_id 时只能靠计数差值判定（退回和老快照那套一样） */
  const whoKnown = who !== ''

  const channelId = String(data.group_id ?? session.channelId ?? session.guildId ?? '')
  const messageId = String(data.message_id ?? session.messageId ?? '')
  if (!channelId || !messageId) return false

  const key = keyOf(channelId, messageId)
  const panel = pending.get(key)
  if (!panel) {
    // 别人随便贴的表情、或这条面板早就被点过了 —— 常态，只记 debug
    logger.debug('[表情面板] 收到表情回应（%s:%s），但没有在等的面板', channelId, messageId)
    return false
  }

  /**
   * 给这条消息贴上**选项里的**表情 = 选中。
   * likes 有的实现给「这次点了什么」（单项）、有的给整份快照；
   * 快照那种可能好几个都在，取「比基准多」的那个，取不到（比如上报人就是自己贴的第一下）取第一个匹配的。
   */
  const likes: Array<{ emoji_id: string; count: number }> = Array.isArray(data.likes) ? data.likes : []
  let picked: Choice | undefined
  for (const like of likes) {
    const emojiId = String(like?.emoji_id ?? '')
    const choice = panel.choices.find((item) => item.emojiId === emojiId)
    if (!choice) continue
    const count = Number(like?.count ?? 0)
    if (count > (panel.baseline.get(emojiId) ?? 0)) { picked = choice; break }
    if (whoKnown && !picked) picked = choice
  }
  if (!picked) return false

  /*
   * 到这一步就已经选中了 —— 立刻把面板从表里摘掉：
   * 同一个人可能连点两下、QQ 也会因为「取消再贴」再发一遍事件，留着只会重复解析。
   */
  pending.delete(key)
  const bot = session.bot
  logger.mark(
    '[表情面板] 用户点中表情 %s → %s',
    picked.emojiId,
    panel.step === 'quality'
      ? String(picked.label ?? picked.qualityId ?? '')
      : picked.onlineWatch ? '在线播放' : '直接发视频'
  )

  if (panel.step === 'quality') {
    return await sendWatchQuestion(session, panel, String(picked.qualityId ?? ''), String(picked.label ?? picked.qualityId ?? ''), bot)
  }

  // 第二步：拿到「是否在线播放」的答案，落地成一次真正的解析
  await clearPanel(bot, panel)
  await runParse(panel.session ?? session, panel, picked.onlineWatch === true)
  return true
}

/**
 * 发第二条：已经选好画质了，问一句要不要在线播放。
 * @returns true = 问题已发出（本次还没开始解析）
 */
const sendWatchQuestion = async (
  session: any,
  previous: PendingPanel,
  qualityId: string,
  qualityIdLabel: string,
  bot: any
): Promise<boolean> => {
  /**
   * 在线播放器关着时不问 —— 这时候「在线播放」根本不可用，问了只会让用户白点一次。
   * 直接按选好的画质解析。
   */
  if (!isOnlinePlayerEnabled()) {
    await clearPanel(bot, previous)
    // 播放器关着就没有「在线播放」这回事了：按选好的画质直接发视频
    await runParse(previous.session ?? session, {
      ...previous,
      qualityId,
      qualityLabel: qualityIdLabel
    }, false)
    return true
  }

  /**
   * 回显给用户已选的那一档：第二步拿不到档位名时就用画质标识本身。
   *
   * 和第一步一样：文字收进一个 text 段（交错 face 段会被吞，见 buildPanel 的说明），
   * 表情排在消息最后。
   */
  const rows = [
    { emojiId: YES_EMOJI_ID, text: '在线播放 —— 发一个链接，视频不占群空间' },
    { emojiId: NO_EMOJI_ID, text: '直接发视频 —— 把视频文件发到群里' }
  ]
  const buildAsk = (withFace: boolean): any[] => {
    const body: string[] = [
      '已选 ' + qualityIdLabel,
      '',
      '点这条消息下面的表情，选怎么给你：',
      '1. ' + rows[0].text,
      '2. ' + rows[1].text,
      '（' + (
        withFace
          ? '下面这排表情从左到右数，第几个就是上面第几步'
          : '从左到右数第几个表情，就是上面第几步'
      ) + '）'
    ]
    const list: any[] = [segment.text(body.join('\n'))]
    if (withFace) for (const row of rows) list.push(segment.face(row.emojiId))
    return list
  }

  let messageId = ''
  const idsOf = (sent: any): string => String((Array.isArray(sent) ? sent[0] : sent) ?? '')
  try {
    messageId = idsOf(await session.send(buildAsk(true)))
  } catch (error: any) {
    logger.debug('[表情面板] 发「是否在线播放」带表情版失败，退回纯文本: ' + String(error?.message ?? error))
  }
  if (!messageId) {
    try {
      messageId = idsOf(await session.send(buildAsk(false)))
    } catch (error: any) {
      logger.debug('[表情面板] 发送「是否在线播放」失败: ' + String(error?.message ?? error))
    }
  }
  if (!messageId) {
    // 发不出来就把问题跳过去，别让用户白选一遍画质
    await clearPanel(bot, previous)
    // 在线播放器关着 / 第二个问题发不出来（还给用户的是「直接发视频」那个默认答案）
    await runParse(previous.session ?? session, {
      ...previous,
      qualityId,
      qualityLabel: qualityIdLabel
    }, false)
    return true
  }

  sweep()
  const channelId = String(session.channelId ?? session.guildId ?? previous.channelId)
  pending.set(keyOf(channelId, messageId), {
    key: keyOf(channelId, messageId),
    channelId,
    messageId,
    step: 'watch',
    choices: YES_NO_CHOICES,
    token: previous.token,
    baseline: new Map(YES_NO_CHOICES.map((choice) => [choice.emojiId, 1])),
    request: previous.request,
    session: previous.session ?? session,
    qualityId,
    qualityLabel: qualityIdLabel,
    // 上一条「选画质」的消息连着一起撤：群里不留中间过程
    recallIds: [...previous.recallIds, previous.messageId],
    createdAt: Date.now()
  })

  for (const choice of YES_NO_CHOICES) {
    await setReaction(session.bot, messageId, choice.emojiId, true)
  }

  /**
   * 清掉上一条「选画质」那排表情。
   *
   * 那条消息**本身也要撤回**，但撤回可能被权限挡下来（机器人不是管理员时全部失败），
   * 留着一排点不动的表情比留一条文字难看得多 —— 所以这一排无论如何都要自己收掉。
   */
  await clearReactions(session.bot, previous.messageId, previous.choices.map((choice) => choice.emojiId))
  return true
}

/**
 * 把「选好的画质 + 要不要在线播放」拼成一条解析命令跑起来。
 *
 * 走的和 QQ 按钮完全同一条路：按钮里本来就是一串 `解析 <链接> --p=<token> --qn=<画质>`，
 * 用户的变量全在这一串文本里，这里复用 `runCommand`（index.ts 里的 `runTextCommand`）就够了。
 */
const runParse = async (
  session: any,
  panel: PendingPanel,
  onlineWatch: boolean
): Promise<void> => {
  const runtime = tryGetRuntime()
  const runCommand = (runtime as any)?.runCommand
  const qualityId = panel.qualityId ?? ''
  if (!qualityId) return
  if (!runCommand) {
    logger.debug('[表情面板] 没有可用的命令入口，放弃这次选择（%s）', panel.qualityLabel ?? qualityId)
    return
  }
  const qualityFlag = panel.request.platform === 'bilibili' ? '--qn=' : '--q='
  const parts: string[] = [commandInvocation('解析')]
  if (panel.request.url && panel.request.url.length <= 120) parts.push(panel.request.url)
  if (panel.token) parts.push('--p=' + panel.token)
  parts.push(qualityFlag + qualityId)
  if (onlineWatch) parts.push('--play=1')
  try {
    await runCommand(session, parts.join(' '))
  } catch (error: any) {
    logger.debug('[表情面板] 执行解析命令失败: ' + String(error?.message ?? error))
  }
}

/** 探针用：看现在有几个面板在等着被点 */
export const debugPendingCount = (): number => pending.size
/** 探针用：强制清空（避免用例之间互相干扰） */
export const debugClear = (): void => { pending.clear() }

export default sendQualityReactionPanel
