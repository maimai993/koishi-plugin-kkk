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
 * ## 怎么判断「用户点了哪个」：三条路，一条都不能少
 *
 *   1. **推送事件**（`notice` / `onebot` 上的 `group_msg_emoji_like`）。
 *      ⚠️ 这条路**大概率是死的**：`koishi-plugin-adapter-onebot@6.9.4` 的 `adaptSession()`
 *      不认这个 notice_type，直接把整条事件丢了（详见下面「轮询」那段的注释）。
 *      代码留着 —— 换成会派发的适配器时它立刻就能用，而且零成本。
 *   2. **主动查询**（`fetch_emoji_like`）—— **真正的主路**，不受事件派发影响，见下。
 *   3. **文字退路**：引用面板消息回序号，或发链接的人 3 分钟内直接回数字。
 *      `set_msg_emoji_like` 不存在（贴不上表情）时这是唯一能用的，所以面板文案里必须写。
 *
 * 推送那条路（`message-reactions-updated` 快照）上还有一层差值判定：
 * `current_reactions` 只给**每种表情现在有多少**，不说是谁点的，所以拿「比基准多」当点击。
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
  /**
   * 发链接的那个人。
   *
   * 只给「不引用、直接回数字」那条退路当门槛用（见 trySelectByText）：
   * 群里裸数字太常见，不加这一层就会到处吞别人的消息。
   */
  requester: string
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
  /**
   * 发这条面板用的机器人（轮询去查「谁贴了」要用它）。
   *
   * 存下来是因为轮询是**定时器**触发的，手上没有当时那条会话 ——
   * 事件驱动的路（推送 / 文字）都能从 session 拿 bot，轮询那条拿不到。
   */
  bot?: any
  /**
   * 轮询基线：面板刚发出、机器人把表情贴完那一刻，每个表情下面**已经**有谁。
   *
   * 只有「之后新冒出来的人」才算点了。这样连「机器人自己的表情也被列在
   * `emojiLikesList` 里」这种情况都不用关心（管它列不列，反正它已经在基线里），
   * 比按 id 比对 `selfId` 稳。`undefined` = 这条面板不走轮询。
   */
  polledUsers?: Map<string, Set<string>>
  /** 轮询已经问过几轮（到上限就停，别一直打接口） */
  pollRounds?: number
}

/** 等待中的面板：key = `会话ID:消息ID` */
const pending = new Map<string, PendingPanel>()

const keyOf = (channelId: string, messageId: string): string => channelId + ':' + messageId

/**
 * 一个消息 id 的几种「写法」。
 *
 * OneBot11 的 `message_id` 是 **int32**，而我们记下的 id 是适配器给的字符串。
 * 大 id 被截成 32 位有符号整数之后会长得完全不一样（例如 `2975774273` → `-1319195023`），
 * 直接 `===` 比就永远对不上 —— 于是「点了没反应」。这里把所有可能的写法都列出来逐个试。
 */
const idVariants = (messageId: string): string[] => {
  const raw = String(messageId ?? '').trim()
  if (!raw) return []
  const out = new Set<string>([raw])
  const num = Number(raw)
  if (Number.isFinite(num) && Number.isInteger(num)) {
    /** 截成 32 位有符号（协议端上报的就是这个） */
    out.add(String(num | 0))
    /** 反过来：上报的是负数、我们记的是无符号 */
    out.add(String(num >>> 0))
    /** 有些实现只是把负号丢了 */
    out.add(String(Math.abs(num | 0)))
  }
  return [...out]
}

/** 日志里放原始载荷：太长就砍掉，别把日志刷爆 */
const brief = (value: any, limit = 400): string => {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return text.length > limit ? text.slice(0, limit) + '…' : text
  } catch {
    return String(value)
  }
}

/** 现在有哪些面板在等（排查「消息 ID 对不上」时要靠它） */
const describePending = (): string => {
  if (!pending.size) return '无'
  return [...pending.values()].map((item) => item.channelId + ':' + item.messageId + '(' + item.step + ')').join(' / ')
}

/** 这个频道有没有在等的面板 */
export const hasPendingIn = (channelId: string): boolean =>
  !!channelId && [...pending.values()].some((item) => item.channelId === channelId)

/** 排查用：把原始载荷转成一行短文本 */
export const briefPayload = (value: any): string => brief(value)

/** 清理过期/超量的面板 */
const sweep = (): void => {
  if (!pending.size) return
  const now = Date.now()
  for (const [key, panel] of pending) {
    if (now - panel.createdAt > PANEL_TTL_MS) pending.delete(key)
  }
  while (pending.size > PANEL_MAX) pending.delete(pending.keys().next().value as string)
  stopPollTimerIfIdle()
}

/* ------------------------------------------------------------------ *
 * 轮询：推送事件不来时的第二条路
 *
 * ## 为什么要有（**这条现在是主路，不是备胎**）
 * `group_msg_emoji_like` 这条推送**到不了插件**，而且是硬性的：
 * `koishi-plugin-adapter-onebot@6.9.4` 的 `adaptSession()` 里那个 `switch (data.notice_type)`
 * **根本没有 `group_msg_emoji_like` 这个 case** —— 未知 notice 走 `default: return`，
 * 于是 `dispatchSession()` 拿到 `undefined` 直接 `return`，**连 `bot.dispatch()` 都不会调**
 * （`lib/index.js:537-539` + `:409-412`）。
 *
 * 结论：**适配器日志里那句「WebSocket 事件上报 notice.group_msg_emoji_like」只能证明协议端发了，
 * 不能证明 Koishi 收到了。** 我们挂的任何监听（包括 `internal/session`）都看不见它 ——
 * 因为 `internal/session` 是在 `Bot.dispatch()` 里发的，而这一步根本没走到。
 * 用户那边看到的现象就是：协议端日志有事件、插件一行日志都没有、「点了没反应」。
 *
 * 既然等不到推送，那就**反着问**：拿面板消息 id + 表情 id
 * 调 `fetch_emoji_like`（兼容层 `KkkBot.fetchEmojiLikes`），自己盯着谁贴了。
 *
 * ## 为什么用「基线」而不是直接看有没有人
 * 面板下面那排表情是**机器人自己贴的**，`emojiLikesList` 里很可能就有机器人。
 * 所以面板刚发出时先记一份「每个表情下面已经有谁」，之后**新冒出来的人**才算点击 ——
 * 这样连机器人自己的 id 长什么样都不用关心。
 *
 * ## 代价
 * 每轮要对**每一档**问一次（接口只吃单个 emoji_id），所以间隔不能太小、轮数要有上限。
 * 接口不存在（老 NapCat）时**一次就判定不再问**，绝不反复打。
 * ------------------------------------------------------------------ */

/** 轮询间隔：每次都要往腾讯服务器往返一趟，别太密 */
const POLL_INTERVAL_MS = 3000
/**
 * 一条面板最多问多少轮（≈3 分钟）。
 *
 * 推送那条路大概率是死的（见本段文件头），所以这段时间里**轮询就是唯一的点击通道**，
 * 太短会变成「刚过两分钟再点就没反应」。之后交给文字退路，面板本身仍然有效。
 */
const POLL_MAX_ROUNDS = 60

/** 已经确认「问不到表情回应」的机器人（老协议端没这个接口）—— 别再拿它去打接口 */
const pollUnsupported = new WeakSet<object>()
let pollTimer: any = null

/** 包装前的原始机器人对象（WeakSet 要拿它做键，包一层就是新对象了） */
const rawBotOf = (bot: any): any => (bot instanceof KkkBot ? (bot as any).bot ?? bot : bot)

const stopPollTimerIfIdle = (): void => {
  if (!pollTimer) return
  const alive = [...pending.values()].some(
    (item) => item.polledUsers && (item.pollRounds ?? 0) < POLL_MAX_ROUNDS
  )
  if (alive) return
  clearInterval(pollTimer)
  pollTimer = null
}

const ensurePollTimer = (): void => {
  if (pollTimer) return
  if (![...pending.values()].some((item) => !!item.polledUsers)) return
  pollTimer = setInterval(() => { void debugPollOnce() }, POLL_INTERVAL_MS)
  // 别让这个定时器把进程吊着（探针跑完要能自己退出）
  pollTimer?.unref?.()
}

/** 往面板所在的群补一句提示（失败就当没这回事，不能因为它把面板搞没） */
const sendHint = async (panel: PendingPanel, text: string): Promise<void> => {
  try {
    const session: any = panel.session
    if (session && typeof session.send === 'function') await session.send(text)
  } catch (error: any) {
    logger.debug('[表情面板] 补发提示失败（已忽略）: ' + String(error?.message ?? error))
  }
}

/** 这个协议端问不到表情回应 → 记一笔，并说清楚「点击只能靠推送或文字」 */
const markPollUnsupported = (bot: any, panel: PendingPanel): void => {
  const raw = rawBotOf(bot)
  if (raw && typeof raw === 'object') {
    if (pollUnsupported.has(raw)) return
    pollUnsupported.add(raw)
  }
  logger.mark('[表情面板] 这个协议端查不到表情回应（没有 fetch_emoji_like / get_emoji_likes）—— '
    + '面板 %s 的点击只能等推送事件，或让用户引用面板消息回序号', panel.key)
  /**
   * 最难受的一种情况：**表情贴得上去、但读不回来** ——
   * 面板下面那一排看起来能点，用户点了却什么都不会发生。
   * 推送那条路在 adapter-onebot 上还是死的（见文件头），所以这时必须当面说清楚：回序号。
   *
   * 只在面板还等着的时候补这一句；一个机器人只补一次（能力不会变）。
   */
  if (pending.has(panel.key)) {
    void sendHint(panel, '（这个协议端读不到表情回应，点表情可能没反应 —— 直接回序号就行）')
  }
}

/**
 * 面板发出、表情贴完之后：先记基线，再把它交给轮询。
 *
 * 基线和「贴表情」之间有个几毫秒的窗口，理论上用户在这一瞬间点了就会被记进基线。
 * 实际不可能：面板刚发出去，用户还没看见。所以按「新出现的人」判定是安全的。
 */
const trackPanelForPolling = (bot: any, panel: PendingPanel): void => {
  if (pollUnsupported.has(rawBotOf(bot))) return
  panel.bot = bot
  void (async () => {
    const users = new Map<string, Set<string>>()
    for (const choice of panel.choices) {
      const list = await kkkBotOf(bot).fetchEmojiLikes(panel.messageId, choice.emojiId)
      if (list === null) {
        markPollUnsupported(bot, panel)
        return
      }
      users.set(choice.emojiId, new Set(list))
    }
    /** 面板可能在这几毫秒里已经被推送事件 / 文字退路用掉了 */
    if (!pending.has(panel.key)) return
    panel.polledUsers = users
    panel.pollRounds = 0
    ensurePollTimer()
    /**
     * 这一行是「点击通道真的通了」的唯一证据，必须打出来：
     * 协议端日志里有 `group_msg_emoji_like`、插件这边一行都没有的时候，
     * 看有没有这行就能区分「轮询没起来」和「用户没点」。
     */
    logger.mark('[表情面板] 已开始主动查询表情回应（面板 %s，%d 档，每 %d 秒问一次，最多 %d 轮）',
      panel.key, panel.choices.length, POLL_INTERVAL_MS / 1000, POLL_MAX_ROUNDS)
  })().catch((error: any) => {
    logger.debug('[表情面板] 初始化轮询失败（已忽略）: ' + String(error?.message ?? error))
  })
}

/**
 * 选中某一档之后的公共收尾：第一步问第二个问题，第二步才真正落地成解析。
 *
 * 四条路（推送事件 / emoji 点击 / 文字退路 / 轮询）都走这里 ——
 * 各写一份必然飘（这几条路的收尾逻辑本来就一模一样）。
 */
const dispatchPicked = async (
  panel: PendingPanel,
  picked: Choice,
  bot: any,
  fallbackSession?: any
): Promise<boolean> => {
  /** 优先用**原来那条链接消息**的会话：信息比「回了个数字」/「定时器」手上的全 */
  const session = panel.session ?? fallbackSession
  if (!session) {
    logger.debug('[表情面板] 面板上没有可用会话，放弃这次选择（%s）', panel.key)
    return false
  }
  if (panel.step === 'quality') {
    return await sendWatchQuestion(session, panel, String(picked.qualityId ?? ''), String(picked.label ?? picked.qualityId ?? ''), bot)
  }
  await clearPanel(bot, panel)
  await runParse(session, panel, picked.onlineWatch === true)
  return true
}

/**
 * 轮询一轮（导出是为了探针不用等定时器）。
 *
 * 每一轮：对每条在等的面板，问它每一档「现在有谁贴了」，有新出现的人就算点了。
 * @returns 这一轮选中了几条面板
 */
export const debugPollOnce = async (): Promise<number> => {
  if (!isReactionPanelEnabled()) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    return 0
  }
  let pickedCount = 0
  for (const panel of [...pending.values()]) {
    if (!panel.polledUsers) continue
    if ((panel.pollRounds ?? 0) >= POLL_MAX_ROUNDS) continue
    panel.pollRounds = (panel.pollRounds ?? 0) + 1

    const asks = await Promise.all(panel.choices.map(async (choice) => {
      const list = await kkkBotOf(panel.bot).fetchEmojiLikes(panel.messageId, choice.emojiId)
      return { choice, list }
    }))
    let picked: Choice | undefined
    for (const ask of asks) {
      if (ask.list === null) {
        markPollUnsupported(panel.bot, panel)
        panel.polledUsers = undefined
        break
      }
      const known = panel.polledUsers.get(ask.choice.emojiId) ?? new Set<string>()
      /** 基线里没有的人 = 面板发出之后才贴的 = 点了它 */
      const fresh = ask.list.filter((id) => !known.has(id))
      if (fresh.length) {
        logger.mark('[表情面板] 轮询发现有人贴了 %s（%s）→ 第 %d 档',
          ask.choice.emojiId, fresh.join(','), panel.choices.indexOf(ask.choice) + 1)
        picked = ask.choice
        break
      }
    }
    if (!picked) continue

    pickedCount++
    pending.delete(panel.key)
    await dispatchPicked(panel, picked, panel.bot)
  }
  stopPollTimerIfIdle()
  return pickedCount
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
    /** 文字退路：协议端不发表情事件时只有这条能用，必须写在面板上 */
    body.push('（点不动表情就引用本条消息，回复序号 1 / 2 / 3；发链接的人直接回数字也行）')

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
  const panel: PendingPanel = {
    key: keyOf(channelId, messageId),
    channelId,
    messageId,
    requester: String(e.userId ?? (e as any).sender?.userId ?? ''),
    step: 'quality',
    choices,
    token,
    baseline: new Map(choices.map((choice) => [choice.emojiId, 1])),
    request,
    session: (e as any).session,
    bot: e.bot,
    recallIds: [],
    createdAt: Date.now()
  }
  pending.set(panel.key, panel)

  /**
   * 贴表情放在登记之后：万一这两个通知发得比登记早，处理函数已经能查到面板了。
   * 有一个贴失败不影响其它 —— 少一个按钮用户还能少选一档，不至于整个面板失效。
   *
   * **贴成功的个数要打出来**：这是判断「协议端到底支不支持表情」的唯一直接证据。
   * 一个都贴不上去（`set_msg_emoji_like` 这个方法不存在）时，点击事件也一定不会来 ——
   * 那种情况下只有文字退路能用，日志里必须说清楚，否则又是一轮「点了没反应」的猜谜。
   */
  let stuck = 0
  for (const choice of choices) {
    if (await setReaction(e.bot, messageId, choice.emojiId, true)) stuck++
  }
  logger.mark('[表情面板] 已发出清晰度面板（%d 档%s），贴表情成功 %d/%d，等待用户点表情… 面板 key = %s',
    choices.length, card ? '，带卡片图' : '', stuck, choices.length, panel.key)
  if (!stuck) {
    logger.warn('[表情面板] 一个表情都没贴上去：这个协议端不支持 set_msg_emoji_like '
      + '（NapCat 要 v4.12.1+）。用户没有表情可点，只能引用面板消息回序号 —— 或升级协议端')
    return true
  }
  /**
   * 表情贴上了 → 开始主动查询。
   *
   * **不 await**：这一步要挨个调接口问「谁贴了」，会拖慢面板回复。
   * 一个表情都没贴上去（上面那个分支）就完全不问 —— 用户没有表情可点，问了也白问。
   *
   * ⚠️ 注意顺序：这里是**轮询而不是等推送**，因为推送那条路在
   * `koishi-plugin-adapter-onebot` 上是被适配器直接丢掉的（见上面文件头）。
   * 表情贴得上去 ≠ 点击事件能收到，两件事要分开看。
   */
  trackPanelForPolling(e.bot, panel)
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

  return await dispatchPicked(panel, picked, bot, session)
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

  /** likes 提前拆出来：下面两处（兜底判定 + 选中判定）都要用 */
  const likes: Array<{ emoji_id: string; count: number }> = Array.isArray(data.likes) ? data.likes : []

  const key = keyOf(channelId, messageId)
  let panel: PendingPanel | undefined = pending.get(key)

  if (!panel) {
    /**
     * ## 兜底：message_id 的「形态」可能不一样
     * 面板记下的 id 是 `e.reply()` 返回给我们的字符串，而协议端上报的是
     * **OneBot11 的 int32** —— 用户日志里出现过 `-1319195023` 这种负数，
     * 大 id 被截成 32 位有符号整数之后长得跟原始值完全不同，直接 `===` 就对不上。
     *
     * 所以这里把收到的 id 展开成几种可能的写法再逐个试（有符号 / 无符号 / 去负号）。
     * **不做「同群里唯一命中就算」那种宽松匹配**：301 / 320 / 333 这些是 QQ 常用小黄脸，
     * 别人在别的消息上随手贴一个就会被误认成选择。
     */
    for (const variant of idVariants(messageId)) {
      if (variant === messageId) continue
      panel = pending.get(keyOf(channelId, variant))
      if (panel) {
        logger.mark('[表情面板] 表情事件的 message_id（%s）和面板记下的 id 形态不同，'
          + '按 %s 认下这条（面板 %s）', messageId, variant, panel.key)
        break
      }
    }
  }

  if (!panel) {
    /**
     * 消息 ID 对不上时要把「在等的是哪几条」也打出来 —— 这是最可能出问题的地方
     * （比如面板消息 ID 和回应里的 message_id 不是一个东西）。
     */
    const sameChannel = [...pending.values()].some((item) => item.channelId === channelId)
    if (sameChannel) {
      logger.mark('[表情面板] 收到表情回应，但消息对不上：收到 %s；在等的是 %s', key, describePending())
    } else {
      // 别人随便贴的表情、或这条面板早就被点过了 —— 常态，只记 debug
      logger.debug('[表情面板] 收到表情回应（%s），但没有在等的面板', key)
    }
    return false
  }

  logger.mark(
    '[表情面板] 收到表情回应（消息 %s）user=%s is_add=%s likes=%s',
    messageId, who || '-', String(data.is_add), brief(data.likes)
  )

  /**
   * 给这条消息贴上**选项里的**表情 = 选中。
   * likes 有的实现给「这次点了什么」（单项）、有的给整份快照；
   * 快照那种可能好几个都在，取「比基准多」的那个，取不到（比如上报人就是自己贴的第一下）取第一个匹配的。
   */
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
  pending.delete(panel.key)
  const bot = session.bot
  logger.mark(
    '[表情面板] 用户点中表情 %s → %s',
    picked.emojiId,
    panel.step === 'quality'
      ? String(picked.label ?? picked.qualityId ?? '')
      : picked.onlineWatch ? '在线播放' : '直接发视频'
  )

  return await dispatchPicked(panel, picked, bot, session)
}

/**
 * 排查用：把**每一条**入站事件打出来。`index.ts` 把它挂在 `internal/session` 上。
 *
 * ## 为什么挂 `internal/session`
 * `@satorijs/core` 的 `Bot.dispatch()` 在按 `session.type` 派发**之前**，会先无条件
 * `emit('internal/session', session)`（`src/bot.ts:181`）。哪怕适配器把某个载荷
 * 归成了我们没监听的类型（甚至 `type` 被改写成别的），这里照样看得见。
 *
 * ## ⚠️ 但它**证明不了**「协议端没发」
 * `internal/session` 是在 `Bot.dispatch()` **里面**发的，而 `dispatch()` 只在
 * `dispatchSession()` 拿到 session 之后才会调。
 * `koishi-plugin-adapter-onebot@6.9.4` 的 `adaptSession()` 对**不认识的 notice_type**
 * 走 `default: return`（`lib/index.js:537-539`），于是
 * `dispatchSession()` 里 `if (!session) return`（`:409-412`）—— **`dispatch()` 根本没被调用**。
 *
 * 所以：**这里一行日志都没有 ≠ 协议端没发**。`group_msg_emoji_like` 恰恰就是被这样丢掉的
 * （适配器日志里能看到「WebSocket 事件上报 notice.group_msg_emoji_like」，插件侧却一片空白）。
 * 真正能作数的是 **协议端自己**的日志，以及本文件里那条
 * 「已开始主动查询表情回应」—— 轮询走的是主动调接口，不受事件派发影响。
 *
 * 顺带一提：机器人自己贴那排表情时协议端**也会上报**，所以面板刚发出就该有日志，
 * 不用等人点就能判断这个协议端发不发表情事件 —— 前提是这一族事件没被适配器丢掉。
 *
 * ## 什么时候打
 * 有面板在等回应时打全部；没有面板但载荷长得像表情事件（`*emoji_like*` / `*reaction*`）
 * 也打 —— 那种情况说明我们对不上号，日志必须留证。普通消息跳过（群里刷屏会把日志冲没）。
 */
export const noteInboundSession = (session: any): void => {
  const type = String(session?.type ?? '')
  const data = session?.onebot ?? session?.event?._data ?? {}
  const shape = String(data?.notice_type ?? '') + ' ' + String(data?.sub_type ?? '')
  const looksLikeReaction = /emoji_like|reaction/i.test(shape)
  if (!pending.size && !looksLikeReaction) return
  // 普通消息在群里太频繁；面板等的是一次「点击」，不会是消息
  if (type === 'message' || type === 'message-created') return
  logger.mark(
    '[表情面板] 面板等待期间收到入站事件：type=%s subtype=%s notice_type=%s channel=%s message=%s user=%s 载荷=%s',
    type || '-', String(session?.subtype ?? '-'), String(data?.notice_type ?? '-'),
    String(session?.channelId ?? session?.guildId ?? '-'), String(session?.messageId ?? '-'),
    String(session?.userId ?? '-'), brief(data)
  )
}

/**
 * 表情回应的总入口：把各家实现的形状路由到对应的处理函数。
 *
 * ## 为什么需要它
 * Koishi 的 `Bot.dispatch()` **只派发 `session.type` 一个事件名**
 * （`emit(session, session.type, session)`；`type/subtype` 那条根本不发）。
 * 所以 `index.ts` 只能按类型挂 `notice` + `onebot` 两个监听，
 * 「到底是不是表情事件、是哪一种」只能在这里看载荷。
 *
 *   - `notice_type === 'group_msg_emoji_like'` → NapCat 的逐次点击上报；
 *   - `subtype === 'message-reactions-updated'` / 载荷里有 `current_reactions`
 *     → OneBot 标准的快照形式。
 *
 * 长得像表情事件、但两种形状都不是的，**原样打出来** ——
 * 各家实现的名字差很多（`reaction` / `reaction_add` / `group_msg_emoji_like`…），
 * 没有这条日志就只能猜对面发的是什么。
 *
 * 至于「面板等着的时候都收到了什么」，统一交给 {@link noteInboundSession}
 * （挂在 `internal/session` 上，任何类型的载荷都跑不掉），这里不重复打。
 */
export async function handleReactionEvent (session: any): Promise<boolean> {
  if (!session) return false
  const data: any = session.onebot ?? {}
  const noticeType = String(data.notice_type ?? '')

  if (noticeType === 'group_msg_emoji_like') return await handleEmojiLike(session)
  if (String(session.subtype ?? '') === 'message-reactions-updated') {
    /** 名字对上了但载荷不是那一套 —— 打出来才知道它长什么样 */
    if (!Array.isArray(data.current_reactions)) {
      logger.mark('[表情面板] 收到 message-reactions-updated，但载荷里没有 current_reactions：%s', brief(data))
      return false
    }
    return await handleReactionUpdate(session)
  }
  if (Array.isArray(data.current_reactions)) return await handleReactionUpdate(session)
  if (/emoji_like|reaction/i.test(noticeType) || /emoji_like|reaction/i.test(String(data.sub_type ?? ''))) {
    logger.mark('[表情面板] 收到未识别的表情事件（notice_type=%s sub_type=%s），原始载荷：%s',
      noticeType || '-', String(data.sub_type ?? '-'), brief(data))
    return false
  }
  /**
   * 最后一种可能：装的不是 `koishi-plugin-adapter-onebot`，而是
   * `koishi-plugin-adapter-napcat` —— 那个适配器会把 `group_msg_emoji_like`
   * **转成标准的 `reaction-added` / `reaction-removed` 事件**。
   *
   * 这种标准形状我们还没见过（表情 id 可能带 `face|` / `emoji|` 前缀，
   * 会话上的字段也未必是 `session.onebot`），**先原样打出来**：
   * 拿到一行真实载荷就能照着补精确映射，比瞎猜强。
   */
  if (/reaction/i.test(String(session.type ?? ''))) {
    logger.mark('[表情面板] 收到 reaction 类事件（type=%s），原始载荷：%s',
      String(session.type ?? '-'), brief(session.event ?? data))
  }
  return false
}

/** 「没引用、直接回数字」这条路的时间窗：超过它就不认了（见 trySelectByText） */
export const PLAIN_REPLY_WINDOW_MS = 3 * 60 * 1000

/**
 * 表情面板的**文字退路**：回一个序号（1 / 2 / 3…）也能选。
 *
 * ## 为什么必须有它
 * 表情回应事件完全看协议端脸色 —— NapCat 要够新、要开着对应事件，别的实现形状还不一样。
 * 协议端不发，我们就永远收不到点击；而**面板一旦发出，这条链接就不会再走正常解析**，
 * 用户会卡在那里什么都拿不到。留一条走普通消息通道的退路，最差也能用。
 *
 * ## 两种认法，门槛不一样
 *   1. **引用了面板那条消息**（`session.quote` 指到 `messageId`）—— 任何人都能这么选，
 *      引用本身就是「我在回应它」的明确表达；
 *   2. **没引用，但发数字的人是发链接的那个人** —— 只在面板发出后的
 *      {@link PLAIN_REPLY_WINDOW_MS} 内认。
 *
 * 第 2 条是给「协议端根本不发表情事件」准备的：那种情况下要让用户去学「引用」这个动作
 * 纯属折磨人。`1`、`2` 这种数字在群里太常见，所以加了双重门槛（同一个人 + 短时间窗），
 * 不去引用就只能在这两条同时成立时才算数。
 *
 * @returns true = 这条消息被当成了一次选择（调用方不要再往后传）
 */
export async function trySelectByText (session: any): Promise<boolean> {
  if (!session) return false
  if (!isReactionPanelEnabled()) return false

  const text = String(session.content ?? '').trim()
  if (!/^\d{1,2}$/.test(text)) return false
  const index = Number(text)
  if (!Number.isInteger(index) || index < 1) return false

  const channelId = String(session.channelId ?? session.guildId ?? '')
  if (!channelId) return false

  /** 引用着我们的面板消息（Koishi 把 reply 段解到 session.quote 上）→ 谁都能这么选 */
  const quoteId = String(session.quote?.id ?? session.event?.message?.quote?.id ?? '')
  let key = quoteId ? keyOf(channelId, quoteId) : ''
  let panel = key ? pending.get(key) : undefined

  /** 没引用：只认「发链接的人自己回的数字」，而且只认刚发出去那一小会儿 */
  if (!panel && !quoteId) {
    const me = String(session.userId ?? '')
    if (me) {
      const mine = [...pending.values()]
        .filter((item) => item.channelId === channelId && item.requester === me
          && Date.now() - item.createdAt <= PLAIN_REPLY_WINDOW_MS)
        .sort((a, b) => b.createdAt - a.createdAt)
      panel = mine[0]
      if (panel) key = panel.key
    }
  }
  if (!panel) return false
  const picked = panel.choices[index - 1]
  if (!picked) return false

  pending.delete(key)
  const bot = session.bot
  logger.mark('[表情面板] 用户用**文字**选了第 %d 项%s → %s', index,
    quoteId ? '（引用）' : '（直接回数字）',
    panel.step === 'quality'
      ? String(picked.label ?? picked.qualityId ?? '')
      : picked.onlineWatch ? '在线播放' : '直接发视频')

  return await dispatchPicked(panel, picked, bot, session)
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
      ) + '）',
      '（点不动表情就引用本条消息，回复序号 1 / 2）'
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
  const panel: PendingPanel = {
    key: keyOf(channelId, messageId),
    channelId,
    messageId,
    // 第二步还是同一个人在做选择（文字退路按这个判定）
    requester: previous.requester,
    step: 'watch',
    choices: YES_NO_CHOICES,
    token: previous.token,
    baseline: new Map(YES_NO_CHOICES.map((choice) => [choice.emojiId, 1])),
    request: previous.request,
    session: previous.session ?? session,
    bot: session.bot ?? previous.bot,
    qualityId,
    qualityLabel: qualityIdLabel,
    // 上一条「选画质」的消息连着一起撤：群里不留中间过程
    recallIds: [...previous.recallIds, previous.messageId],
    createdAt: Date.now()
  }
  pending.set(panel.key, panel)

  let stuck = 0
  for (const choice of YES_NO_CHOICES) {
    if (await setReaction(session.bot, messageId, choice.emojiId, true)) stuck++
  }
  logger.mark('[表情面板] 已发出「是否在线播放」面板（%s），贴表情成功 %d/%d，面板 key = %s',
    qualityIdLabel, stuck, YES_NO_CHOICES.length, panel.key)
  if (stuck) trackPanelForPolling(panel.bot, panel)

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
export const debugClear = (): void => {
  pending.clear()
  stopPollTimerIfIdle()
}

export default sendQualityReactionPanel
