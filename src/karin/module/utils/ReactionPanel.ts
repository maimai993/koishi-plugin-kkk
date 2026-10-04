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
import { isOnlinePlayerEnabled } from '../../../player'
import { platformOf, isOneBotLike } from './ImageSlice'
import { fetchPanelInfo, rememberPanelRequest, type PanelRequest } from './QqPanel'

/**
 * 画质选择用的表情 id，**必须升序**（见文件头的排序说明）。
 *
 * 都是 QQNT 系统表情（https://koishi.js.org/QFace/#/qqnt/<id>），挑的都是图形差异大、
 * 一眼能数出第几个的那种：301 好闪 / 320 庆祝 / 333 烟花 / 351 敲敲 / 355 耶 /
 * 369 彩虹 / 371 冒泡 / 383 企鹅爱心 / 396 狼狗 / 405 好运来。
 */
const QUALITY_EMOJI_IDS = ['301', '320', '333', '351', '355', '369', '371', '383', '396', '405'] as const

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

  const choices: Choice[] = shown.map((option, index) => ({
    emojiId: QUALITY_EMOJI_IDS[index],
    qualityId: String(option.id),
    label: option.label
  }))

  const lines: string[] = []
  if (info.title) lines.push('《' + info.title + '》')
  const meta = [info.author && 'UP：' + info.author, info.duration && info.duration].filter(Boolean).join(' · ')
  if (meta) lines.push(meta)
  if (lines.length) lines.push('')
  lines.push('点这条消息下面的表情，选一档清晰度：')
  shown.forEach((option, index) => {
    lines.push((index + 1) + '. ' + option.label + ' · ' + sizeText(option.sizeMB))
  })
  lines.push('（从左到右数第几个表情，就是上面第几档）')

  let sent: any
  try {
    sent = await e.reply(lines.join('\n'))
  } catch (error: any) {
    logger.debug('[表情面板] 发送选择消息失败: ' + String(error?.message ?? error))
    return false
  }
  const messageId = String(sent?.messageId ?? '')
  if (!messageId) return false

  sweep()
  pending.set(keyOf(String(e.contact?.peer ?? ''), messageId), {
    key: keyOf(String(e.contact?.peer ?? ''), messageId),
    channelId: String(e.contact?.peer ?? ''),
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
  logger.debug('[表情面板] 已发出清晰度面板（%d 档，messageId=%s）', choices.length, messageId)
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

  /** 回显给用户已选的那一档：第二步拿不到档位名时就用画质标识本身 */
  const lines: string[] = [
    '已选 ' + qualityIdLabel,
    '',
    '点这条消息下面的表情，选怎么给你：',
    '1. 在线播放 —— 发一个链接，视频不占群空间',
    '2. 直接发视频 —— 把视频文件发到群里',
    '（从左到右数第几个表情，就是上面第几步）'
  ]

  let messageId = ''
  try {
    const ids: any = await session.send(lines.join('\n'))
    messageId = String((Array.isArray(ids) ? ids[0] : ids) ?? '')
  } catch (error: any) {
    logger.debug('[表情面板] 发送「是否在线播放」失败: ' + String(error?.message ?? error))
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
