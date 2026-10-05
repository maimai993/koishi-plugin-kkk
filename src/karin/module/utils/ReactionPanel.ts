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
import { queryAdapterImplementation } from '../../../compat/adapter-info'
import { segment } from '../../../compat/segment'
import { isOnlinePlayerEnabled } from '../../../player'
import { platformOf, isQqFamily, isOfficialQq, isMilkyLike } from './ImageSlice'
import {
  EXTRACT_COVER_COMMAND,
  EXTRACT_COMMENT_COMMAND,
  fetchPanelInfo,
  hasCardImage,
  panelCoverUrl,
  rememberPanelRequest,
  uploadPanelCard,
  willSendVideo,
  type PanelRequest
} from './QqPanel'
import { cardImageKeyOf, rememberCardImages, rememberLastCardKey } from './CardImageCache'
import { isForwardCollecting, withoutForwardCollect } from '../../../compat/forward-collect'

/**
 * 选项用的表情（QQ 系统表情 id），**必须升序**（见文件头的排序说明）。
 *
 * ## 为什么不用 Unicode emoji
 * `set_msg_emoji_like` 认两种 id：QQ 系统表情（三位以内）和 Unicode 码点（如 👍 = 128077）。
 * 但**不少客户端 / 协议端只认 QQ 系统表情**，传码点过去要么贴不上、要么显示成一个问号框；
 * 而且码点没法直接印在消息里 —— 想让选项前面出现表情，只能写真正的 emoji 字符，
 * 又有一批老客户端 / 协议端打不出来。
 *
 * 全用 QQ 系统表情就没这些问题：**贴得上去**，并且**同一个 id 能用 `face` 段印进消息里**
 * （`segment.face(id)`），选项前面直接显示那张表情图，和下面那排按钮一一对应。
 *
 * 一份列表通吃所有面板（画质、互动视频选项、提取图片…）：反正规则都是
 * 「第 N 个表情 = 第 N 项」，十档够用了。
 */
const CHOICE_EMOJI_IDS = ['301', '320', '333', '351', '355', '369', '371', '383', '396', '405']

/**
 * 「随便贴什么表情都算」时**额外**要轮询的几个 id。
 *
 * `fetch_emoji_like` 只能「拿一个表情 id 换点了它的人」，没有「这条消息上都有谁」这种问法，
 * 所以「认任意表情」只能靠**枚举**（每轮每个 id 单独问一次，问多了就是白打接口）。
 * 这里挑的是 QQ 小黄脸里最常被随手点的前几个，再加上面板自己贴的那个。
 */
const ANY_EMOJI_POLL_IDS = ['301', '320', '333', '351']

/** 「是」= 478 对的对的，「否」= 479 不对不对（用户指定的一对） */
const YES_EMOJI_ID = '478'
const NO_EMOJI_ID = '479'

/** 面板等回应的上限（超过就把这条消息从表里丢掉，没人管的面板不该一直占内存） */
const PANEL_TTL_MS = 10 * 60 * 1000
/** 同时盯着的面板上限 */
const PANEL_MAX = 200

/** 「问清晰度」的默认等待秒数（配置项 qualityPanelTimeoutSec 没给 / 给了非法值时用它） */
const DEFAULT_QUALITY_TIMEOUT_SEC = 60

/**
 * 面板上那句「可以回数字」的提示。
 *
 * 用户明确要求**要有这句**：「引用选择清晰度 12345、可以发数字的提示也没有」。
 * 之前为了版面干净把它连同「从左到右数」那句一起删了，结果没表情可点的协议端上
 * 用户完全不知道还能回序号 —— 数字列表必须自带用法说明。
 */
const NUMBER_HINT = '（直接回序号就行，引用这条消息回复也可以）'

/**
 * 表情**排在末尾**时那句「数第几个」的提示。
 *
 * 只有 `trailing` 排法需要：那排表情在消息最后一行，和上面的 1 / 2 / 3 不是紧挨着的，
 * 不写清楚用户就不知道怎么点。
 */
const COUNT_HINT = '（下面这排表情从左到右数，第几个就是上面第几档；也可以直接回序号）'

/**
 * 表情 id 在**协议端**上的写法。
 *
 * 面板内部一律用 QQ 系统表情的数字 id（`301` / `478`…）。但**发到协议端时要不要加工**
 * 各家不一样：
 *
 *   - OneBot（`set_msg_emoji_like`）：原样发数字；
 *   - **Milky**：要写成 `face|301` —— 前半是类型（`face` = QQ 系统表情，`emoji` = Unicode），
 *     后半才是 id（适配器的 `createReaction` 自己按 `|` 拆开）。
 *
 * ⚠️ **贴和认必须用同一个函数**：Milky 上报的点击事件里
 * （`session.event.emoji.id`）也是 `face|301` 这个形状，
 * 贴的时候加了前缀、认的时候不加，两边就永远对不上号。
 */
const reactionIdOf = (platform: string, emojiId: string): string =>
  isMilkyLike(platform) ? 'face|' + emojiId : emojiId

/** 反解 {@link reactionIdOf}：`face|301` → `301`；没有前缀的原样返回 */
const parseReactionId = (raw: string): string => {
  const text = String(raw ?? '')
  const hit = /^(?:face|emoji)\|(.+)$/.exec(text)
  return hit ? hit[1] : text
}

/** 一步可以选的东西 */
interface Choice {
  emojiId: string
  /** 选中后要落到命令里的画质标识（第一步）；第二步不带，改用 onlineWatch 标记 */
  qualityId?: string
  /** 回显给用户用的名字（第一步是「1080P」这类画质名） */
  label?: string
  onlineWatch?: boolean
  /** 通用面板：这一项代表的值，选中后原样交回调用方 */
  value?: any
  /**
   * **附加动作**：这一项不是「选项」，是**顺手做一件事**。
   *
   * 例如清晰度面板最右边那个 ✅️（提取封面图）：贴它就发一次封面，
   * 但**面板本身不消费** —— 用户还能接着选清晰度。
   * 所以它不进「第几个 = 第几档」的编号，只在消息末尾多贴一个表情。
   */
  extra?: boolean
}

/**
 * 面板是哪一类。
 *
 *   - `quality` / `watch`：画质那两步（走死流程，选中后自己往下跑）；
 *   - `choice`：通用选择面板（互动视频选项、提取图片、查询下载进度…），
 *     选中后**交回调用方**（`onTrigger` / Promise），这里不关心它要干什么。
 */
type PanelKind = 'quality' | 'watch' | 'choice'

/** 一个等待用户点表情的面板 */
interface PendingPanel {
  key: string
  channelId: string
  messageId: string
  kind: PanelKind
  /**
   * 通用面板：这一项是干什么的（只进日志）。
   * 排查「哪一类面板点了没反应」时靠它区分，比只看 step 清楚。
   */
  subject?: string
  /**
   * 通用面板：每次触发要跑的东西。
   *
   * `repeatable` 的面板（比如「查询下载进度」）**只能**走回调 ——
   * 它不会被消费掉，没有「一次性结果」可以给 Promise。
   */
  onTrigger?: (pick: EmojiPick) => void | Promise<void>
  /**
   * 通用面板：贴一次就再触发一次，**面板本身不摘**。
   *
   * 用户要的是「查询下载进度」能反复问：下载要跑一会儿，用户会想多查几次。
   * 于是自然就是「**添加几个就执行几次**」—— 但**同一个表情同一个人只算一次**，
   * 否则一次点击被看好几遍（推送 + 轮询）就会连着执行好几次。
   */
  repeatable?: boolean
  /**
   * 反复触发的面板：**已经触发过的「表情 + 人」**（键是 `表情id:用户id`）。
   *
   * 轮询那条路靠基线去重（见过的人记进基线就不再算新），
   * 但**推送**那条路没有基线：同一个 `group_msg_emoji_like` 会被看好几遍，
   * 不记这一笔就会「点一下查三次」。
   */
  fired?: Set<string>
  /**
   * 通用面板：只有一个选项时，**任意表情**都算选中（不必点中我们贴的那一个）。
   *
   * 只有一个动作时不存在「点错别的项」这回事，硬性要求用户点中指定的那个纯属为难人。
   */
  anyEmoji?: boolean
  /**
   * 附加动作：表情 id → 贴它时要跑的东西（见 {@link Choice.extra}）。
   *
   * **点了不消费面板**：跑完面板还在，用户还能继续选清晰度。
   * 命中它的分支在 {@link dispatchPicked} 里 —— 推送 / 轮询 / 数字三条路都过那一处。
   */
  extraActions?: Map<string, () => void | Promise<void>>
  /** 通用面板：结束后要不要连面板消息一起撤回（默认留着） */
  recallOnFinish?: boolean
  /** 通用面板：到点没等到就放弃（resolve null）；空的 = 不设超时 */
  timer?: any
  /** 通用面板：等到的结果往哪儿交（`sendEmojiChoicePanel` 那个 Promise 的 resolve） */
  settle?: (pick: EmojiPick | null) => void
  /**
   * 到点没人选时要做什么（**只有画质那两步有**）。
   *
   * 用户要求：「如果超时了，有人没点那个按钮，那就自动按默认、直接解析的流程处理发送视频」。
   * 所以画质面板超时不是「放弃」，而是**按默认画质继续解析** —— 这条链接已经不会再走
   * 正常解析流程了，什么都不做就等于把用户的链接吞掉。
   */
  onTimeout?: () => void | Promise<void>
  /** 这一条面板的表情排法（见 {@link faceLayoutOf}）；第二步要跟第一步一致 */
  faceLayout?: FaceLayout
  /**
   * 这条面板到底有没有贴表情（第二步要跟着第一步走）。
   *
   * 数字列表那一步（`useEmoji === false`）第二步也得是纯文字，
   * 否则会突然冒出一排点不动的表情。
   */
  withFaces?: boolean
  /**
   * 轮询要问哪几个表情 id。
   *
   * 一般是选项那几个；`anyEmoji` 的面板会多带上 {@link ANY_EMOJI_POLL_IDS}，
   * 否则「用户随手贴了个别的表情」就永远轮询不到。
   */
  pollIds?: string[]
  /**
   * 发链接的那个人。
   *
   * 只给「不引用、直接回数字」那条退路当门槛用（见 trySelectByText）：
   * 群里裸数字太常见，不加这一层就会到处吞别人的消息。
   */
  requester: string
  /** 第一步 = 选画质，第二步 = 选是否在线播放（通用面板不带） */
  step?: 'quality' | 'watch'
  choices: Choice[]
  /** 这条链接对应的短令牌（体积提示要靠它反查；通用面板不带） */
  token?: string
  /** emojiId → 上一次看到的数量 */
  baseline: Map<string, number>
  /** 通用面板不带 */
  request?: PanelRequest
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
  return [...pending.values()]
    .map((item) => item.channelId + ':' + item.messageId + '(' + (item.subject ?? item.step ?? item.kind) + ')')
    .join(' / ')
}

/** 这个频道有没有在等的面板 */
export const hasPendingIn = (channelId: string): boolean =>
  !!channelId && [...pending.values()].some((item) => item.channelId === channelId)

/** 排查用：把原始载荷转成一行短文本 */
export const briefPayload = (value: any): string => brief(value)

/**
 * 把一个面板**收掉**：从表里摘掉、停掉它自己的超时定时器，再通知还等着的人。
 *
 * 所有「面板到此为止」的地方都必须走这里（超时、过期、超量、选中、发不出去…），
 * 否则通用面板那个 `await` 会永远挂着 —— 各写一份 `pending.delete` 必然漏。
 *
 * @param pick 选中的结果；`null` = 没等到（超时 / 被挤掉 / 面板没发出来）
 */
const settlePanel = (panel: PendingPanel, pick: EmojiPick | null): void => {
  if (panel.timer) {
    clearTimeout(panel.timer)
    panel.timer = undefined
  }
  const settle = panel.settle
  panel.settle = undefined
  if (pending.get(panel.key) === panel) pending.delete(panel.key)
  stopPollTimerIfIdle()
  if (settle) settle(pick)
}

/**
 * 一个面板**等到超时**了。
 *
 * 和 {@link settlePanel}（「没等到，什么也别做」）的区别是它会跑 `panel.onTimeout`
 * —— 画质面板挂上之后这条链接就不会再走正常解析，超时什么都不做 = 把链接吞掉，
 * 所以那两步必须在这条路上「按默认画质继续解析」。
 *
 * 已经被选中 / 被摘掉的面板不会走到这里（`pending` 里已经没有它了），
 * 所以重复触发（定时器 + 轮询）不会跑两遍。
 */
const fireTimeout = async (panel: PendingPanel): Promise<void> => {
  if (panel.timer) {
    clearTimeout(panel.timer)
    panel.timer = undefined
  }
  if (pending.get(panel.key) !== panel) return
  pending.delete(panel.key)
  stopPollTimerIfIdle()
  /** 还在 await 的调用方（一般没有）给个 null，别让它永远挂着 */
  const settle = panel.settle
  panel.settle = undefined
  const onTimeout = panel.onTimeout
  panel.onTimeout = undefined
  try {
    await onTimeout?.()
  } catch (error: any) {
    logger.debug('[表情面板] 超时后兜底失败（已忽略）: %s', String(error?.message ?? error))
  }
  if (settle) settle(null)
}

/**
 * 给面板挂上「等多久就自己往下走」的定时器。
 *
 * `unref()` 不能少：探针跑完要能自己退出，被一个 60 秒的定时器吊着就退不掉。
 */
const armTimeout = (panel: PendingPanel, timeoutMs: number): void => {
  if (!(timeoutMs > 0)) return
  panel.timer = setTimeout(() => { void fireTimeout(panel) }, timeoutMs)
  panel.timer?.unref?.()
}

/** 清理过期/超量的面板（过期的要通知调用方，不然它的 await 不会结束） */
const sweep = (): void => {
  if (!pending.size) return
  const now = Date.now()
  for (const panel of [...pending.values()]) {
    if (now - panel.createdAt > PANEL_TTL_MS) settlePanel(panel, null)
  }
  while (pending.size > PANEL_MAX) {
    const oldest = pending.get(pending.keys().next().value as string)
    if (!oldest) break
    settlePanel(oldest, null)
  }
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
 * 调 `fetch_emoji_like` / `get_emoji_likes`（兼容层 `KkkBot.fetchEmojiLikes`），自己盯着谁贴了。
 *
 * ## ⚠️ 两个接口，NapCat 和 LLOneBot 各认一套
 * |                      | 参数                                   | 返回                            |
 * |----------------------|----------------------------------------|---------------------------------|
 * | `fetch_emoji_like`   | `emojiId` / `emojiType`（**驼峰**）     | `data.emojiLikesList[].tinyId`   |
 * | `get_emoji_likes`    | `emoji_id` / `emoji_type`（**下划线**） | `data.emoji_like_list[].user_id` |
 *
 * 而且 `emojiType` / `emoji_type` 是**必填**（1 = QQ 系统表情、2 = Unicode emoji），
 * 不传就是 `retcode 1400`。只认一种 = 只有一半协议端能用（实测：LLOneBot 行、NapCat 不行）。
 * 兼容层两个动作都试、两种返回都认，并且会**把协议端名字打进日志**（`get_version_info`）——
 * 排查时先看清对面是谁。
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

/** 轮询要问的表情 id（认任意表情的面板会多问几个，见 {@link ANY_EMOJI_POLL_IDS}） */
const pollIdsOf = (panel: PendingPanel): string[] => panel.pollIds ?? panel.choices.map((choice) => choice.emojiId)

/** 往面板所在的群补一句提示（失败就当没这回事，不能因为它把面板搞没） */
const sendHint = async (panel: PendingPanel, text: string): Promise<void> => {
  try {
    const session: any = panel.session
    if (session && typeof session.send === 'function') await session.send(text)
  } catch (error: any) {
    logger.debug('[表情面板] 补发提示失败（已忽略）: ' + String(error?.message ?? error))
  }
}

/**
 * 协议端自报家门（`NapCat.Onebot 1.0.0` 这种），进日志用。
 *
 * 表情回应那两个接口 NapCat / LLOneBot 各认一套，日志里写清对面是谁，
 * 比事后对着 `bot.platform === 'onebot'` 猜强得多。问不到就退回平台名。
 */
const describeProtocolEnd = async (bot: any): Promise<string> => {
  try {
    const info = await kkkBotOf(bot).fetchVersionInfo()
    if (info?.appName) return info.appName + (info.appVersion ? ' ' + info.appVersion : '')
  } catch { /* 问不到就不写，下面还有平台名兜着 */ }
  return String(bot?.platform ?? bot?.bot?.platform ?? '未知')
}

/** 这个协议端问不到表情回应 → 记一笔，并说清楚「点击只能靠推送或文字」 */
const markPollUnsupported = async (bot: any, panel: PendingPanel): Promise<void> => {
  const raw = rawBotOf(bot)
  if (raw && typeof raw === 'object') {
    if (pollUnsupported.has(raw)) return
    pollUnsupported.add(raw)
  }
  /**
   * ⚠️ **Milky 没有「查谁贴了」的接口，但它的推送事件是通的** ——
   * 适配器把 `group_message_reaction` 直接派发成标准名 `reaction-added`，
   * 不像 `adapter-onebot` 那样把不认识的 notice 丢掉（见文件头）。
   * 所以 Milky 上这句「点表情可能没反应」是**误导**，别补。
   */
  if (isMilkyLike(platformOf({ bot }))) {
    logger.info('[表情面板] Milky 没有「查谁贴了」的接口，面板 %s 的点击走推送的 '
      + 'reaction-added 事件（这条链路是通的，不用回序号）', panel.key)
    return
  }
  logger.mark('[表情面板] 这个协议端查不到表情回应（没有 fetch_emoji_like / get_emoji_likes）—— '
    + '面板 %s 的点击只能等推送事件，或让用户引用面板消息回序号（协议端 %s）',
  panel.key, await describeProtocolEnd(bot))
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
    for (const emojiId of pollIdsOf(panel)) {
      const list = await kkkBotOf(bot).fetchEmojiLikes(panel.messageId, emojiId, panel.channelId)
      if (list === null) {
        await markPollUnsupported(bot, panel)
        return
      }
      users.set(emojiId, new Set(list))
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
     *
     * 顺带把**协议端名字**带上（`get_version_info`，NapCat / LLOneBot 表情接口不是一套）——
     * 否则下次排查又得先猜对面是谁。
     */
    logger.mark('[表情面板] 已开始主动查询表情回应（面板 %s，%d 档，每 %d 秒问一次，最多 %d 轮；协议端 %s）',
      panel.key, panel.choices.length, POLL_INTERVAL_MS / 1000, POLL_MAX_ROUNDS, await describeProtocolEnd(bot))
  })().catch((error: any) => {
    logger.debug('[表情面板] 初始化轮询失败（已忽略）: ' + String(error?.message ?? error))
  })
}

/**
 * 通用面板被选中：把结果交回调用方，然后决定这块面板还要不要留着。
 *
 * ## 两种收法
 *   - **一次性**（默认）：先把面板摘掉再跑回调 —— 这样回调里再收到同一次点击的
 *     第二条上报也不会执行两遍（「提取图片」用户要求**只能执行一次**，这条是硬性的）；
 *   - **repeatable**（查询下载进度）：**不摘**，面板继续等着，下次贴还会再触发。
 *
 * 摘掉之后还要把机器人自己贴的那排表情**撤掉**：面板已经失效了，留一排点不动的
 * 表情在那儿，用户只会以为机器人卡住了（撤回消息本身可能被权限挡下，所以单独收拾）。
 */
const triggerChoice = async (
  panel: PendingPanel,
  picked: Choice,
  bot: any,
  fireKey?: string
): Promise<void> => {
  const pick: EmojiPick = {
    index: Math.max(0, panel.choices.indexOf(picked)),
    label: String(picked.label ?? ''),
    value: picked.value
  }
  logger.mark('[表情面板] 用户选中「%s」（%s，第 %d 项）',
    pick.label, panel.subject ?? '选择', pick.index + 1)

  const onTrigger = panel.onTrigger
  if (panel.repeatable) {
    /**
     * 同一个**表情 + 同一个人**只认一次。
     *
     * 一次点击会走好几条路（推送事件可能来两遍、轮询每 3 秒问一次），
     * 不去重就变成「点一下查三次进度」。换一个表情（或换一个人）才算新的一次 ——
     * 这正是用户要的「添加几个就执行几次」。
     */
    if (fireKey) {
      if (!panel.fired) panel.fired = new Set<string>()
      if (panel.fired.has(fireKey)) {
        logger.debug('[表情面板] 「%s」这次已经被同一个人用同一个表情触发过了，跳过（%s）',
          panel.subject ?? '动作', fireKey)
        return
      }
      panel.fired.add(fireKey)
    }
    /** 面板留着，只是记一笔；回调里的异常不能把面板搞没 */
    try { await onTrigger?.(pick) } catch (error: any) {
      logger.debug('[表情面板] 执行「%s」失败（已忽略）: %s', panel.subject ?? '动作', String(error?.message ?? error))
    }
    return
  }

  settlePanel(panel, pick)
  if (panel.recallOnFinish) await recallQuietly(bot, panel.channelId, panel.messageId)
  else await clearReactions(bot, panel.channelId, panel.messageId, panel.choices.map((choice) => choice.emojiId))
  try { await onTrigger?.(pick) } catch (error: any) {
    logger.debug('[表情面板] 执行「%s」失败（已忽略）: %s', panel.subject ?? '动作', String(error?.message ?? error))
  }
}

/**
 * 选中某一档之后的公共收尾：第一步问第二个问题，第二步才真正落地成解析，
 * 通用面板则交回调用方。
 *
 * 四条路（推送事件 / emoji 点击 / 文字退路 / 轮询）都走这里 ——
 * 各写一份必然飘（这几条路的收尾逻辑本来就一模一样）。
 */
const dispatchPicked = async (
  panel: PendingPanel,
  picked: Choice,
  bot: any,
  fallbackSession?: any,
  fireKey?: string
): Promise<boolean> => {
  /**
   * **附加动作优先**：贴的是「顺手做一件事」那个表情（提取封面图）时，
   * 面板**不消费** —— 跑完继续等用户选清晰度（用户要求：
   * 「监听到了对对对的，继续监听清晰度选择，如果没有就超时处理」）。
   *
   * ## 为什么必须去重
   * 面板留着就意味着**同一次点击还会被看好几遍**（推送 + 每 3 秒一次的轮询）。
   * `repeatable` 的面板（查询下载进度）用的是同一套 `fired` 去重，这里照搬。
   */
  const extra = panel.extraActions?.get(String(picked?.emojiId ?? ''))
  if (extra) {
    const key = fireKey || (String(picked?.emojiId ?? '') + ':' + '-')
    if (!panel.fired) panel.fired = new Set<string>()
    if (panel.fired.has(key)) {
      logger.debug('[表情面板] 附加动作「%s」这次已经跑过了，跳过（%s）',
        String(picked?.label ?? ''), key)
      return true
    }
    panel.fired.add(key)
    logger.mark('[表情面板] 触发附加动作「%s」（%s），面板继续等着选清晰度',
      String(picked?.label ?? ''), panel.subject ?? '面板')
    try {
      await extra()
    } catch (error: any) {
      logger.debug('[表情面板] 附加动作执行失败（已忽略）: %s', String(error?.message ?? error))
    }
    return true
  }
  if (panel.kind === 'choice') {
    await triggerChoice(panel, picked, bot ?? panel.bot, fireKey)
    return true
  }
  /**
   * 画质那两步：到这一步就已经选中了 —— **立刻**把面板从表里摘掉。
   * 同一个人可能连点两下、QQ 也会因为「取消再贴」再发一遍事件，留着只会重复解析。
   * （通用面板由 {@link triggerChoice} 自己决定摘不摘，见那里的说明。）
   */
  if (pending.get(panel.key) === panel) pending.delete(panel.key)
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
  if (!isEmojiPanelEnabled()) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    return 0
  }
  let pickedCount = 0
  for (const panel of [...pending.values()]) {
    if (!panel.polledUsers) continue
    if ((panel.pollRounds ?? 0) >= POLL_MAX_ROUNDS) continue
    panel.pollRounds = (panel.pollRounds ?? 0) + 1

    const asks = await Promise.all(pollIdsOf(panel).map(async (emojiId) => {
      const list = await kkkBotOf(panel.bot).fetchEmojiLikes(panel.messageId, emojiId, panel.channelId)
      return { emojiId, list }
    }))
    let unsupported = false
    let picked: Choice | undefined
    let hitEmoji = ''
    /** 这一轮「新出现的人」按表情归拢：repeatable 的面板收尾时要拿它更新基线 */
    const freshByEmoji = new Map<string, string[]>()
    for (const ask of asks) {
      if (ask.list === null) { unsupported = true; break }
      const known = panel.polledUsers?.get(ask.emojiId) ?? new Set<string>()
      /** 基线里没有的人 = 面板发出之后才贴的 = 点了它 */
      const fresh = ask.list.filter((id) => !known.has(id))
      if (!fresh.length) continue
      freshByEmoji.set(ask.emojiId, fresh)
      const choice = panel.choices.find((item) => item.emojiId === ask.emojiId)
      if (choice && !picked) { picked = choice; hitEmoji = ask.emojiId }
    }
    if (unsupported) {
      await markPollUnsupported(panel.bot, panel)
      panel.polledUsers = undefined
      continue
    }
    /**
     * 「贴什么表情都算」的面板：上面没对上号（用户贴的不是我们贴的那几个）也算选中 ——
     * 只有一个动作时不存在「点错别的项」这回事。
     */
    if (!picked && panel.anyEmoji && panel.choices.length === 1 && freshByEmoji.size) {
      picked = panel.choices[0]
      hitEmoji = [...freshByEmoji.keys()][0]
    }
    if (!picked) continue

    pickedCount++
    if (panel.repeatable) {
      /**
       * 反复触发的面板：**这一轮新出现的人要记进基线**，
       * 否则下一轮还会把他们当成「刚贴的」、三秒一次地反复执行。
       * 记进去之后，同一个人贴**同一个**表情不会再触发，
       * 再贴一个**别的**表情才算新的一次 —— 也就是「添加几个就执行几次」。
       */
      for (const [emojiId, fresh] of freshByEmoji) {
        const known = panel.polledUsers?.get(emojiId) ?? new Set<string>()
        for (const id of fresh) known.add(id)
        panel.polledUsers?.set(emojiId, known)
      }
      logger.mark('[表情面板] 轮询发现有人贴了 %s（%s）→ 触发「%s」',
        hitEmoji, freshByEmoji.get(hitEmoji)?.join(',') ?? '-', panel.subject ?? '动作')
    }
    await dispatchPicked(panel, picked, panel.bot, undefined,
      hitEmoji + ':' + (freshByEmoji.get(hitEmoji)?.[0] ?? '-'))
  }
  stopPollTimerIfIdle()
  return pickedCount
}

/**
 * 「发链接后先问清晰度」这个**总开关**是不是开着（通用 → 选择清晰度的数字列表）。
 *
 * ⚠️ 它是**总开关**：关掉就是「别问了」，不管表情那个开关怎么设都按默认画质直接解析。
 * 用户反馈过「我明明没有勾选，为什么还是要求选择清晰度」—— 就是因为以前只有
 * 表情那个开关在被读，这个开关加了字段但没接进运行时。
 */
export const isQualityListEnabled = (): boolean => {
  const config = tryGetRuntime()?.config as any
  return (config?.qualityListPanel ?? true) !== false
}

/** 这个开关「QQ 系用表情当按钮」是不是开着（只在 QQ 系协议端有意义） */
export const isEmojiPanelEnabled = (): boolean => {
  const config = tryGetRuntime()?.config as any
  return (config?.onebotQualityPanel ?? true) !== false
}

/**
 * 数字列表 + 表情面板，只要有一个开着就「有人可能要回序号」。
 *
 * `trySelectByText` 用这个当总闸：两个都关掉时不可能有面板在等，
 * 那就别去动用户发的裸数字消息。
 */
export const isSelectPanelEnabled = (): boolean => isEmojiPanelEnabled() || isQualityListEnabled()

/**
 * 这个平台**有没有**「贴表情」这条路（不管开关）：**QQ 那一族**，都要群聊。
 *
 * 用 {@link isQqFamily} 而不是 {@link isOneBotLike}：走 **Satori 适配器**时
 * `bot.platform` 是**真实的协议端名**（`chronocat` / `onebot` / `milky`…），
 * 不一定落在 OneBot 那份名单里，但它连的同样是 QQ —— 表情 id 和「能不能贴」都是一套。
 *
 * ⚠️ 但要**剔掉官方 QQ**（`qq` / `qqguild`）：它虽然在 QQ 那一族里，走的却是
 * 「markdown + 原生按钮」那条路（`QqPanel.sendQqParsePanel`），
 * 给它贴表情既没必要、也会被它自己的面板比下去。
 */
export const isReactionCapablePlatform = (platform: string): boolean =>
  isQqFamily(platform) && !isOfficialQq(platform)

/** 这条消息能不能走表情面板：平台是 OneBot 系 / Milky + 是群聊 */
export const isReactionPanelCapable = (e: Message): boolean => {
  // 注意这里不能用 e.isPrivate：兼容层的 Message 上没有这个字段（读了永远是 undefined）
  if (!e?.isGroup) return false
  return isReactionCapablePlatform(platformOf(e))
}

/** 这一条要不要（且能不能）用表情按钮：两个开关都满足才行 */
export const canUseEmojiButtons = (e: any): boolean => isEmojiPanelEnabled() && isReactionPanelCapable(e)

/**
 * 问清晰度等多久（秒 → 毫秒）。
 *
 * 读完会夹到 10 ~ 600 秒：给 0 或负数等于「永不超时」，而面板一旦发出这条链接
 * 就不再走正常解析 —— 那就变成「没人点就永远晾着」，必须堵掉。
 */
export const qualityPanelTimeoutMs = (): number => {
  const raw = Number((tryGetRuntime()?.config as any)?.qualityPanelTimeoutSec ?? DEFAULT_QUALITY_TIMEOUT_SEC)
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_QUALITY_TIMEOUT_SEC * 1000
  return Math.min(600, Math.max(10, Math.round(raw))) * 1000
}

/**
 * 面板上一排表情的排法。
 *
 *   - `inline`：**表情排在每行数字前面**（`[表情]1. 1080P`）——. 只在确认是 NapCat
 *     时才这么排，因为这是唯一实测不吞字的协议端；
 *   - `trailing`：文字收进**一个** text 段，表情排在消息**最后一行**，
 *     再补一句「从左到右数第几个」—— LLOneBot 这类会把 face 段中间的文字吞掉
 *     （用户实测 5 行选项只剩首尾两行），只能这么排。
 *
 * ## 为什么不能写死一种
 * 同一个 `platform`（基本都是 `onebot`）底下是 NapCat 还是 LLOneBot 完全看不出，
 * 只能问协议端自报家门（`get_version_info` 的 `app_name`），所以这里是 async。
 * 结果按机器人缓存，一个机器人只会问一次（最坏多等 1.5 秒）。
 *
 * ## ⚠️ 判定**只看协议端自报的名字**，`platform` 不参与
 * 以前把 `platformOf(e)` 也并进去一起匹配，于是「用 `adapter-napcat` 连 LLOneBot」
 * 会被判成 `inline`（适配器 platform 就叫 `napcat`），文本段照样被吞 ——
 * 用户实测 5 档清晰度只剩「1.」和「5.」两行，中间三行全没了。
 * 会不会吞字是**对面那个协议端**决定的，跟适配器叫什么没关系。
 */
export type FaceLayout = 'inline' | 'trailing'

const faceLayoutOf = async (e: any): Promise<FaceLayout> => {
  const bot = rawBotOf(e?.bot ?? e?.session?.bot)
  const impl = bot ? await queryAdapterImplementation(bot) : null
  /** 问不到（老协议端 / 接口超时）时按最保守的来：宁可多一句「从左到右数」，也别吞字 */
  const name = String(impl?.name ?? '').toLowerCase()
  const layout: FaceLayout = /napcat/.test(name) ? 'inline' : 'trailing'
  /**
   * 用 **info** 而不是 debug：判定错了的表现是「选项被吞得只剩两行」，
   * 用户一眼看得出结果、看不出原因 —— 这行就是那个原因，默认日志级别下要能看见。
   */
  logger.info('[表情面板] 表情排法判定：协议端 = %s，适配器 platform = %s → %s',
    impl?.name || '（问不到）', platformOf(e) || '（未知）',
    layout === 'inline' ? 'inline（表情在每行数字前面）' : 'trailing（表情排最后一行）')
  return layout
}

/** 事件里拿到的可能是原始 Bot，而 `e.bot` 已经是 KkkBot 了 —— 包两层会让能力探测拿到包装对象 */
const kkkBotOf = (bot: any): KkkBot => (bot instanceof KkkBot ? bot : new KkkBot(bot))

/* ------------------------------------------------------------------ *
 * 通用「表情选择」核心
 *
 * QQ 官方适配器有 markdown + 原生按钮，所以「提取封面图」「查询下载进度」「互动视频选项」
 * 这些都能做成按钮；**OneBot 一样都没有**，全靠表情回应顶上。
 *
 * 画质那两步（{@link sendQualityReactionPanel}）是最早的一个用法，逻辑写死在里面；
 * 这一节把它抽出来，让任何「几选一 / 点一下执行个动作」的地方都能复用同一套
 * 「贴表情 → 等点击（推送 / 轮询 / 文字三条路）→ 交回结果」的骨架。
 * ------------------------------------------------------------------ */

/** 通用面板的一项 */
export interface EmojiChoiceOption {
  /** 显示给用户看的文字 */
  label: string
  /** 选中后原样交回调用方的值（不写就是下标） */
  value?: any
  /**
   * 这一项**指定**用哪个表情 id（不写就按顺序从 {@link CHOICE_EMOJI_IDS} 里取）。
   *
   * 「提取封面图」要贴 ✅️（= 478「对的」）这种一眼就懂的图案时用。
   * ⚠️ 那排表情是**按 id 升序**排的，所以给了自定义 id 之后选项会**按 id 重排**
   * （见 `openEmojiPanel`），序号才和那排一一对得上。
   */
  emojiId?: string
}

/** 用户选中的结果 */
export interface EmojiPick {
  /** 第几项（从 0 开始） */
  index: number
  /** 那一项的文字 */
  label: string
  /** 那一项的 value */
  value: any
}

export interface EmojiChoiceSpec {
  /** 面板标题（第一行，可省） */
  title?: string
  /** 这一项是干什么的（只进日志，方便排查「哪一类面板点了没反应」） */
  subject?: string
  /** 可选项；最多 {@link CHOICE_EMOJI_IDS} 项，多了截掉 */
  options: EmojiChoiceOption[]
  /** 最后补一句说明（可省） */
  tip?: string
  /**
   * **挂到一条已经发出去的消息上**（给消息 id）。
   *
   * 卡片、「收到请求，开始下载」这类提示都是别处发的，按钮本来就该在**那条**消息下面，
   * 再单独发一条纯属刷屏。给了它就不新发消息，只在那条消息上贴表情。
   */
  attachTo?: string
  /**
   * 只有一个选项时**任意表情**都算选中（默认 true）。
   *
   * 只有一个动作时不存在「点错别的项」这回事，硬性要求用户点中我们贴的那一个纯属为难人
   * —— 用户想贴哪个都行，贴了就执行。
   */
  anyEmoji?: boolean
  /**
   * 每次有人贴都再触发一次，**面板本身不摘**（默认 false = 只用一次）。
   *
   * 「查询下载进度」这类要它开着：下载要跑一会儿，用户会想多问几次。
   * 同一人贴同一个表情不会重复触发，再贴一个**别的**表情才算新的一次
   * —— 也就是用户要的「**添加几个就执行几次**」。
   * 开着时没有「一次性结果」可给，所以必须配 `onTrigger`。
   */
  repeatable?: boolean
  /** 触发时回调（`repeatable` 时它是唯一的通道） */
  onTrigger?: (pick: EmojiPick) => void | Promise<void>
  /** 等多久就放弃（一次性面板默认 {@link CHOICE_TIMEOUT_MS}） */
  timeoutMs?: number
  /** 结束后连面板消息一起撤回（默认 false：留着，用户还能看清刚点了什么） */
  recallOnFinish?: boolean
}

/** 一次性面板默认等多久（和轮询上限 60 轮 × 3 秒 ≈ 3 分钟对齐） */
export const CHOICE_TIMEOUT_MS = 3 * 60 * 1000

/**
 * 开一张表情面板（所有通用面板都从这里出去）。
 *
 * @returns 面板是否真的挂上了（false = 平台不支持 / 开关关着 / 消息没发出去）
 */
const openEmojiPanel = async (
  e: any,
  spec: EmojiChoiceSpec,
  settle?: (pick: EmojiPick | null) => void
): Promise<boolean> => {
  if (!isEmojiPanelEnabled()) return false
  if (!isReactionPanelCapable(e)) return false
  const options = (spec.options ?? []).filter((item) => item && String(item.label ?? '').trim())
  if (!options.length) return false

  const channelId = String(e?.contact?.peer ?? e?.guildId ?? e?.session?.channelId ?? e?.session?.guildId ?? '')
  if (!channelId) return false

  /** 表情只有 {@link CHOICE_EMOJI_IDS} 那么多个，多了也只能截掉（贴不上去的选项是假的） */
  const shown = options.slice(0, CHOICE_EMOJI_IDS.length)
  const choices: Choice[] = shown
    .map((item, index) => ({
      emojiId: String(item.emojiId ?? CHOICE_EMOJI_IDS[index]),
      label: String(item.label),
      value: item.value === undefined ? index : item.value
    }))
    /**
     * **按表情 id 升序重排**：QQ 那条消息下面的一排表情是**按 id 排序**显示的，
     * 谁给了自定义 id（比如「提取封面图」要贴 ✅️ = 478）就可能乱序，
     * 一乱「第 N 个表情 = 第 N 行」这条就断了。排完序号和那排永远一致。
     */
    .sort((a, b) => Number(a.emojiId) - Number(b.emojiId))
  const anyEmoji = choices.length === 1 && spec.anyEmoji !== false
  const repeatable = spec.repeatable === true
  const bot = e?.bot ?? e?.session?.bot
  /** 挂在已有消息上时不新发消息（见 EmojiChoiceSpec.attachTo） */
  const attached = !!spec.attachTo

  /** 要自己拼一条消息时才用得上排法 —— 挂在已有消息上时只贴表情，不改文字 */
  const layout: FaceLayout = attached ? 'trailing' : await faceLayoutOf(e)

  /** 挂在已有消息上时不新发消息（见 EmojiChoiceSpec.attachTo） */
  let messageId = String(spec.attachTo ?? '')
  if (!messageId) {
    /**
     * 拼面板消息。
     *
     * 两种排法，按协议端选（见 {@link faceLayoutOf}）：
     *   - `inline`（只有确认是 NapCat 才用）：**表情排在每行数字前面** `[表情]1. 选项`；
     *   - `trailing`（LLOneBot 等）：文字收进**一个** text 段、表情排在最后一行，
     *     再补一句「从左到右数第几个」。
     *
     * ⚠️ `inline` 是 **face 段和 text 段交错**的排法。实测过
     * 「face → 1.… → face → 2.…」这种结构在 LLOneBot 上 QQ 会吞掉中间几行文字
     * （5 行选项只剩首尾两行），所以不能拿它当默认；
     * 真出问题时的退路是下面 `withFace = false` 那条（纯文字 + 数字，照旧能用）。
     */
    const build = (withFace: boolean): any[] => {
      const head: string[] = []
      if (spec.title) head.push(spec.title)
      if (choices.length > 1) {
        if (head.length) head.push('')
        head.push('点这条消息下面的表情，选一个：')
      } else {
        if (head.length) head.push('')
        head.push('给这条消息贴个表情就能：' + String(choices[0].label))
        head.push(anyEmoji
          ? '（贴哪个表情都行；也可以引用本条消息回 1）'
          : '（下面那个表情，贴它就行；也可以引用本条消息回 1）')
      }
      if (spec.tip) head.push(spec.tip)

      if (!withFace) {
        const body = [...head]
        if (choices.length > 1) {
          choices.forEach((choice, index) => body.push((index + 1) + '. ' + String(choice.label)))
          body.push('')
          body.push(NUMBER_HINT)
        }
        return [segment.text(body.join('\n'))]
      }
      /** 单选项：表情跟在文字后面（只有一个，不存在对不上号的问题） */
      if (choices.length === 1) {
        return [segment.text(head.join('\n') + '\n'), segment.face(choices[0].emojiId)]
      }
      if (layout === 'trailing') {
        const body = [...head]
        choices.forEach((choice, index) => body.push((index + 1) + '. ' + String(choice.label)))
        body.push('')
        body.push(COUNT_HINT)
        return [segment.text(body.join('\n')), ...choices.map((choice) => segment.face(choice.emojiId))]
      }
      const list: any[] = [segment.text(head.join('\n') + '\n')]
      choices.forEach((choice, index) => {
        list.push(segment.face(choice.emojiId))
        list.push(segment.text((index + 1) + '. ' + String(choice.label) + (index === choices.length - 1 ? '' : '\n')))
      })
      return list
    }
    try {
      messageId = String((await e.reply(build(true)))?.messageId ?? '')
    } catch (error: any) {
      logger.debug('[表情面板] 带表情的面板发送失败（协议端可能不认 face 段），退回纯文本: ' + String(error?.message ?? error))
    }
    if (!messageId) {
      try {
        messageId = String((await e.reply(build(false)))?.messageId ?? '')
      } catch (error: any) {
        logger.debug('[表情面板] 发送面板消息失败: ' + String(error?.message ?? error))
      }
    }
    if (!messageId) return false
  }

  sweep()
  const panel: PendingPanel = {
    key: keyOf(channelId, messageId),
    channelId,
    messageId,
    kind: 'choice',
    subject: spec.subject,
    onTrigger: spec.onTrigger,
    repeatable,
    anyEmoji,
    recallOnFinish: spec.recallOnFinish === true,
    requester: String(e?.userId ?? e?.sender?.userId ?? e?.session?.userId ?? ''),
    choices,
    baseline: new Map(choices.map((choice) => [choice.emojiId, 1])),
    /** 认任意表情时轮询要多问几个（否则用户随手贴的那个永远问不到） */
    pollIds: anyEmoji
      ? [...new Set([...choices.map((choice) => choice.emojiId), ...ANY_EMOJI_POLL_IDS])]
      : undefined,
    session: e?.session ?? e,
    bot,
    recallIds: [],
    createdAt: Date.now()
  }
  panel.settle = settle
  pending.set(panel.key, panel)

  let stuck = 0
  for (const choice of choices) {
    if (await setReaction(bot, panel.channelId, messageId, choice.emojiId, true)) stuck++
  }
  logger.mark('[表情面板] 已发出「%s」面板（%d 项%s%s），贴表情成功 %d/%d，面板 key = %s',
    spec.subject ?? '选择', choices.length,
    spec.attachTo ? '，挂在已有消息上' : '',
    repeatable ? '，可反复触发' : '',
    stuck, choices.length, panel.key)

  /**
   * 一次性面板**必须**有超时：调用方在 `await` 它，
   * 没有这一步「用户一直不点」就会让那条解析链路永远挂着。
   * 反复触发的面板给到 {@link PANEL_TTL_MS}（它本来就会到点被 sweep 掉）。
   */
  const timeoutMs = Number(spec.timeoutMs ?? (repeatable ? PANEL_TTL_MS : CHOICE_TIMEOUT_MS))
  if (timeoutMs > 0) {
    panel.timer = setTimeout(() => {
      if (pending.get(panel.key) !== panel) return
      logger.debug('[表情面板] 「%s」面板等了 %d 秒没人点，放弃（%s）',
        spec.subject ?? '选择', Math.round(timeoutMs / 1000), panel.key)
      settlePanel(panel, null)
    }, timeoutMs)
    /** 别让这个定时器把进程吊着（探针跑完要能自己退出） */
    panel.timer?.unref?.()
  }

  if (stuck) trackPanelForPolling(bot, panel)
  return true
}

/**
 * 发一张「几选一」的表情面板，**等用户选完再往下走**。
 *
 * @returns 选中的那一项；`null` = 平台不支持 / 开关关着 / 发不出去 / 等超时
 *          （调用方拿到 null 就该按老办法继续，比如退回纯文字提示）。
 */
export const sendEmojiChoicePanel = async (
  e: any,
  spec: EmojiChoiceSpec
): Promise<EmojiPick | null> => {
  if (!isEmojiPanelEnabled() || !isReactionPanelCapable(e)) return null
  return await new Promise<EmojiPick | null>((resolve) => {
    openEmojiPanel(e, { ...spec, repeatable: false }, resolve)
      .then((ok) => { if (!ok) resolve(null) })
      .catch((error: any) => {
        logger.debug('[表情面板] 通用面板发送失败: ' + String(error?.message ?? error))
        resolve(null)
      })
  })
}

/**
 * 发一张「点一下就执行个动作」的表情面板，**不等**（发出去就返回）。
 *
 * 结果走 `spec.onTrigger`。`repeatable: true` 时必须用这个
 * —— 那种面板不会被消费掉，没有「一次性结果」可以给 Promise。
 * @returns 面板是否挂上了
 */
export const sendEmojiActionPanel = async (e: any, spec: EmojiChoiceSpec): Promise<boolean> => {
  if (!isEmojiPanelEnabled() || !isReactionPanelCapable(e)) return false
  try {
    return await openEmojiPanel(e, spec, undefined)
  } catch (error: any) {
    logger.debug('[表情面板] 通用面板发送失败: ' + String(error?.message ?? error))
    return false
  }
}

/**
 * 把表情按钮**挂到一条已经发出去的消息上**（不新发消息），**等用户选完再往下走**。
 *
 * 卡片、「收到请求，开始下载」这类提示都是别处发的，按钮本来就该在**那条**消息下面。
 * 用它的前提是那条消息自己已经把选项和玩法写清楚了 —— 挂上去只会多一排表情，不加文字。
 *
 * @returns 选中的那一项；`null` = 平台不支持 / 开关关着 / 贴不上去 / 等超时
 */
export const attachEmojiChoicePanel = async (
  e: any,
  messageId: string,
  spec: EmojiChoiceSpec
): Promise<EmojiPick | null> => {
  if (!messageId) return null
  if (!isEmojiPanelEnabled() || !isReactionPanelCapable(e)) return null
  return await new Promise<EmojiPick | null>((resolve) => {
    openEmojiPanel(e, { ...spec, repeatable: false, attachTo: String(messageId) }, resolve)
      .then((ok) => { if (!ok) resolve(null) })
      .catch((error: any) => {
        logger.debug('[表情面板] 挂载面板失败: ' + String(error?.message ?? error))
        resolve(null)
      })
  })
}

/**
 * 把表情选项**挂到一条已经发出去的消息上**（不新发消息），**不等**。
 *
 * 「查询下载进度」这类可反复触发的动作走这个（结果走 `spec.onTrigger`）。
 * @returns 面板是否挂上了
 */
export const attachEmojiActionPanel = async (
  e: any,
  messageId: string,
  spec: EmojiChoiceSpec
): Promise<boolean> => {
  if (!messageId) return false
  return await sendEmojiActionPanel(e, { ...spec, attachTo: String(messageId) })
}

/**
 * 这一张面板按顺序会用哪几个表情 id。
 *
 * 给「选项文字要自己拼」的调用方用（比如互动视频那条消息本来就要列出 A / B / C，
 * 表情只是**再**印一遍在末尾）：面板内部按 {@link CHOICE_EMOJI_IDS} 的顺序分配，
 * 这里取同样的前 n 个，两边才对得上号。
 */
export const choiceEmojiIds = (count: number): string[] =>
  CHOICE_EMOJI_IDS.slice(0, Math.max(0, Math.min(Math.floor(count) || 0, CHOICE_EMOJI_IDS.length)))

/* ------------------------------------------------------------------ *
 * 卡片 / 提示类消息上的表情按钮
 *
 * 「提取封面图」「查询下载进度」这些在 QQ 上是 markdown 文字链 / 原生按钮，
 * OneBot 上就只能拿表情顶。它们和画质面板的区别是：**消息是别的模块发的**
 * （卡片是解析链路发的，「收到请求，开始下载」是下载提示），
 * 所以这里全是「挂到已有消息上」，不再多发一条。
 * ------------------------------------------------------------------ */

/** 一个「点一下就跑一条指令」的动作 */
export interface EmojiCommandAction {
  /** 给用户看的名字 */
  label: string
  /** 要跑的指令原文（含参数） */
  command: string
  /**
   * **指定**贴哪个表情（不写就按顺序分配）。
   *
   * 「提取封面图」贴 ✅️（= {@link YES_EMOJI_ID} 478「对的」）—— 一眼就知道是「要这个」，
   * 比贴一个看不出含义的小黄脸强。同样受「按 id 升序重排」约束（见 `EmojiChoiceOption`）。
   */
  emojiId?: string
}

/** 把「点一下就跑一条指令」的表情按钮挂到一条已经发出去的消息上 */
export const attachEmojiCommandPanel = async (
  e: any,
  messageId: string,
  options: {
    subject: string
    actions: EmojiCommandAction[]
    /** 每次贴都再跑一次（查询下载进度这类） */
    repeatable?: boolean
    /** 只有一个动作时贴什么表情都算 */
    anyEmoji?: boolean
    timeoutMs?: number
  }
): Promise<boolean> => {
  const actions = (options.actions ?? []).filter((item) => item && item.command)
  if (!messageId || !actions.length) return false
  return await attachEmojiActionPanel(e, messageId, {
    subject: options.subject,
    options: actions.map((item, index) => ({
      label: item.label,
      value: item.command ?? index,
      emojiId: item.emojiId
    })),
    anyEmoji: options.anyEmoji,
    repeatable: options.repeatable,
    timeoutMs: options.timeoutMs,
    /** 跑指令用的是**原来那条消息**的会话（信息比回应事件的会话全） */
    onTrigger: async (pick) => { await runCommandText(e?.session ?? e, String(pick.value ?? '')) }
  })
}

/**
 * 「收到请求，开始下载」那条提示下面挂一个「查询下载进度」按钮。
 *
 * **可反复点**（用户要求：添加几个就执行几次）—— 下载要跑一会儿，用户会想多问几次；
 * 面板不会被消费掉，同一个人贴**同一个**表情不会再触发，再贴一个**别的**才算新的一次。
 * **贴任意表情都行**（只有一个动作，不存在点错这回事）。
 */
export const attachDownloadProgressPanel = async (
  e: any,
  messageId: string,
  taskId: string
): Promise<boolean> => {
  const command = commandInvocation('下载进度') + (taskId ? ' ' + taskId : '')
  return await attachEmojiCommandPanel(e, messageId, {
    subject: '查询下载进度',
    actions: [{ label: '查询下载进度', command }],
    repeatable: true,
    anyEmoji: true
  })
}

/**
 * 卡片下面的「提取封面图 / 提取评论区图片」→ OneBot 上的表情按钮。
 *
 * **只能点一次**（用户要求）：面板是一次性的，点完就把自己摘掉、把那排表情撤掉，
 * 之后在这张卡上再贴什么都不会再把图发一遍 —— 否则随手贴个表情就会重复刷图。
 *
 * **封面那个贴 ✅️**（478「对的」）：只有一个动作时贴什么表情都行，
 * 与其贴一个看不出含义的小黄脸，不如贴个一眼就懂的「对，就要这个」。
 * 两个动作（封面 + 评论）时不换 —— 那时得靠「第 1 个 / 第 2 个」区分，
 * 换成一个大 id 会把那排表情的顺序打乱（那排是按 id 升序排的），反而对不上号。
 *
 * @param messageId 卡片消息 id；给了就挂在卡片上（不另发消息）
 */
export const attachCardImageEmojiPanel = async (
  e: any,
  messageId: string,
  options: { cover?: boolean, comment?: boolean, key?: string }
): Promise<boolean> => {
  const actions = cardImageCommands(options)
  if (!actions.length) return false
  const single = actions.length === 1
  const picks = actions.map((item, index) => ({
    label: item.label,
    value: item.command ?? index,
    emojiId: single ? item.emojiId : undefined
  }))
  /**
   * 卡片上的按钮**等多久**。
   *
   * 画质面板是一次性的、卡着解析往下走，3 分钟没点就该放弃（{@link CHOICE_TIMEOUT_MS}）；
   * 卡片不一样：它**一直挂在群里**，用户翻回去想存封面是几分钟以后的事了 ——
   * 3 分钟一过，贴上去的表情还在、点了却没反应（用户反馈「手动添加了也没有反应」）。
   * 所以这里给到 {@link PANEL_TTL_MS}（10 分钟，和 sweep 清场的上限一致）：
   * 反正它不阻塞任何流程，超时也只是「之后再点没反应」，不会有任何副作用。
   */
  const timeoutMs = PANEL_TTL_MS
  if (messageId) {
    return await attachEmojiCommandPanel(e, messageId, {
      subject: '提取图片',
      actions: picks.map((item) => ({ label: item.label, command: String(item.value ?? ''), emojiId: item.emojiId })),
      /** 只有一项时贴什么表情都行；两项（封面 + 评论）才要点对那一个 */
      anyEmoji: single,
      repeatable: false,
      timeoutMs
    })
  }
  /**
   * 拿不到卡片消息 id（长图是切片发出去的）时**不再另发一条短消息**。
   *
   * 以前这里会自己发一条「上面那张卡片 / 贴个表情就能…」，用户反馈
   * 「不要再单独发一条消息了」—— 为了一个按钮在群里多占一条消息不值当，
   * 何况封面入口已经并进清晰度面板（见 {@link sendQualityReactionPanel} 里那个 ✅️）。
   * 卡片正文那句「引用这条消息发送 kkk封面 …」还在，功能没丢。
   */
  return false
}

/** 「提取封面图 / 提取评论区图片」对应的指令（缓存里没图就不给按钮，见 hasCardImage） */
const cardImageCommands = (
  options: { cover?: boolean, comment?: boolean, key?: string }
): EmojiCommandAction[] => {
  const key = String(options.key ?? '')
  if (!key) return []
  const actions: EmojiCommandAction[] = []
  if (options.cover && hasCardImage(key, 'cover')) {
    /** ✅️ = 478「对的」：一眼就知道「点它就能拿到这张封面」 */
    actions.push({ label: '提取封面图', command: EXTRACT_COVER_COMMAND + ' ' + key, emojiId: YES_EMOJI_ID })
  }
  if (options.comment && hasCardImage(key, 'comment')) {
    actions.push({ label: '提取评论区图片', command: EXTRACT_COMMENT_COMMAND + ' ' + key })
  }
  return actions
}

/**
 * 跑一条指令文本（表情按钮点下去之后真正执行的那一步）。
 *
 * 和 QQ 按钮走的是同一条路：按钮里本来就是一串指令文本，
 * 用户的变量全在这一串里，交给宿主的命令入口就够了。
 */
const runCommandText = async (session: any, text: string): Promise<void> => {
  if (!text) return
  const runCommand = (tryGetRuntime() as any)?.runCommand
  if (!runCommand) {
    logger.debug('[表情面板] 没有可用的命令入口，放弃这次执行：%s', text)
    return
  }
  try {
    await runCommand(session, text)
  } catch (error: any) {
    logger.debug('[表情面板] 执行「%s」失败: ' + String(error?.message ?? error), text)
  }
}

/**
 * 往消息上贴 / 取消一个表情。
 *
 * 注意**不经过 EmojiReaction.setEmojiReaction**：那个函数受 `Config.app.EmojiReply`
 * 控制（它只是「处理中/完成」的提示开关），而这个 emoji 是面板的按钮本体，必须独立于它。
 *
 * @param channelId 群号。**Milky 必须给**：它的 `createReaction(channelId, messageId, emojiId)`
 *   第一参数就是它，而且要从里面解出 `peerId` / `messageSeq`；OneBot 那套用不到，
 *   但要传就都传，省得到处判平台。
 */
const setReaction = async (
  bot: any,
  channelId: string,
  messageId: string,
  emojiId: string,
  isAdd: boolean
): Promise<boolean> => {
  try {
    return await kkkBotOf(bot).setMsgReaction(
      channelId, messageId, reactionIdOf(platformOf({ bot }), emojiId), isAdd)
  } catch (error: any) {
    logger.debug('[表情面板] 贴表情失败（已忽略）: ' + String(error?.message ?? error))
    return false
  }
}

/** 把机器人自己贴的那排表情全部取消，并把面板消息撤回 */
const clearPanel = async (bot: any, panel: PendingPanel): Promise<void> => {
  for (const choice of panel.choices) {
    await setReaction(bot, panel.channelId, panel.messageId, choice.emojiId, false)
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
const clearReactions = async (bot: any, channelId: string, messageId: string, emojiIds: string[]): Promise<void> => {
  for (const emojiId of emojiIds) {
    await setReaction(bot, channelId, messageId, emojiId, false)
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
 * 发一条「选清晰度」的选择消息 —— **所有平台**都走这里。
 *
 * ## 谁用哪种面板
 *   - **QQ 系 + 「用表情当按钮」开着 + 群聊**：表情按钮（下面一排表情点一下就选），
 *     排法再按协议端分 `inline` / `trailing`（见 {@link faceLayoutOf}）；
 *   - **其它一切情况**（Telegram / 微信 / Discord / Milky / 私聊 / 关了表情的 OneBot）：
 *     **纯文字数字列表**，回序号选。以前这些平台只能按配置里的默认画质直接解析，
 *     用户根本没得选（用户反馈：「所有平台都有数字列表」）。
 *
 * ## 总开关
 * 通用里那个「发链接后先问清晰度」是**总开关**：关掉它就**完全不问**，
 * 直接按配置里的默认画质解析 —— 用户反馈过「没勾选为什么还是要求选择清晰度」，
 * 那就是这个开关加了字段却没接进运行时导致的。
 *
 * ## 超时
 * 面板一发出，这条链接就不会再走正常解析了，所以「没人选」不能什么都不做：
 * 到点撤回列表、按默认画质继续解析（见 {@link fireTimeout}）。
 *
 * @param e 原始解析事件
 * @param request 作品信息
 * @returns true = 面板已发出，本次不再直接解析
 */
export async function sendQualityReactionPanel (e: Message, request: PanelRequest): Promise<boolean> {
  if (!isQualityListEnabled()) return false
  /**
   * **这次压根不发视频就别问清晰度。**
   *
   * 「解析时发送的内容」里没勾「视频文件」（比如只勾了「评论图片」）时，
   * 问「选哪档」是纯打扰 —— 走正常解析，该发的卡片照发。见 {@link willSendVideo}。
   */
  if (!willSendVideo(request?.platform)) {
    logger.debug('[表情面板] 本次不发视频（%s），跳过清晰度面板', String(request?.platform))
    return false
  }

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
  const shown = (visible.length ? visible : [info.options[info.options.length - 1]]).slice(0, CHOICE_EMOJI_IDS.length)

  /**
   * 令牌的作用和 QQ 面板一样：按钮里只放 `--p=<令牌>`，链接（和各档体积）留在内存里，
   * 解析时它能反查出这一档的预估体积，好提示「超过 30MB 会以文件发送」。
   */
  const sizes: Record<string, number> = {}
  for (const option of info.options) sizes[String(option.id)] = option.sizeMB
  const token = rememberPanelRequest(request, sizes)

  const channelId = String(e.contact?.peer ?? '')
  if (!channelId) return false

  const choices: Choice[] = shown.map((option, index) => ({
    emojiId: CHOICE_EMOJI_IDS[index],
    qualityId: String(option.id),
    label: option.label
  }))

  /**
   * 「提取封面图」**并进这张面板**（用户要求：不要再单独发一条消息）。
   *
   * ## 为什么放在这里
   * 详情卡在面板路径下是不发的（`fromPanel`），封面入口原本只能挂在评论区那条长图上，
   * 而那条消息是切片发的、拿不到消息 id —— 表情只能靠**另外发一条短消息**挂上去，
   * 于是群里多一条「上面那张卡片…」的面板，用户嫌它多余。
   * 合进清晰度面板之后：同一个 ✅️ 既能提封面，面板本身也还在，选完清晰度照旧解析。
   *
   * ## 封面要**在这里**就记进缓存
   * 面板是解析之前发的，此刻缓存里还没有封面 —— 不记的话 `hasCardImage` 是 false，
   * ✅️ 就不会出现（和 `sendQqParsePanel` 用同一个函数，两边口径一致）。
   */
  const panelKey = cardImageKeyOf(request.platform, request.id)
  rememberCardImages(panelKey, { cover: String(panelCoverUrl(request.platform, info?.detail) ?? '') })
  rememberLastCardKey(e, panelKey)
  const coverCommand = hasCardImage(panelKey, 'cover')
    ? EXTRACT_COVER_COMMAND + ' ' + panelKey
    : ''
  if (coverCommand) {
    /**
     * ✅️（478）比所有清晰度表情 id 都大 → 排在那排的最右边，
     * 「左边第几个 = 第几档」这条不受影响。
     */
    choices.push({ emojiId: YES_EMOJI_ID, label: '提取封面图', extra: true })
  }

  /** 表情按钮只在「QQ 系 + 开关开着 + 群聊」时用；其余一律纯文字数字列表 */
  const useEmoji = canUseEmojiButtons(e)
  const layout: FaceLayout = useEmoji ? await faceLayoutOf(e) : 'trailing'

  /**
  /**
   * 开着「解析结果合并转发」时**先不渲染卡片**（用户要求：「这种情况下先不要渲染图片，
   * 先询问清晰度，后面再合成一条」）。
   *
   * ## 为什么
   * 面板这条消息为了拿到真实消息 id 必须 {@link withoutForwardCollect}（见下面 {@link send}），
   * 也就是**被排除在转发之外** —— 卡片跟着它一起发，就注定进不了那条转发。
   * 更要命的是它会把一次解析劈成**两条**转发：面板发出去 handler 就返回了，
   * 那个空袋子立刻被冲刷一次；等用户选完画质、真正解析完再冲刷第二次。
   *
   * 所以合并转发模式下这里只出**纯提示**，卡片留到真正解析那一步去渲染：
   * `fromPanel` 在那边会因为 {@link isForwardCollecting} 而不再挡住详情卡
   * （见 `bilibili.ts` / `douyin.ts`），于是卡片和视频、评论卡一起攒进**同一个**袋子，
   * 最后合成一条转发。
   */
  const forwardMode = isForwardCollecting()
  let card: { url: string; width: number; height: number } | null = null
  if (!forwardMode) {
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
        /** 同 {@link send}：过程提示也不能被收进转发（收进去就再也撤不掉了） */
        const tip: any = await withoutForwardCollect(() => e.reply('正在加载卡片…'))
        loadingId = String(tip?.messageId ?? '')
      } catch (error: any) {
        logger.debug('[表情面板] 「加载中」提示发送失败（不影响面板）: ' + String(error?.message ?? error))
      }
    }
    try {
      card = await uploadPanelCard(e, request, info.detail, info.hotDanmaku ?? [])
    } catch (error: any) {
      logger.debug('[表情面板] 渲染卡片失败（退回纯文字面板）: ' + String(error?.message ?? error))
    }

    /**
     * **卡片单独发一条**（用户要求：「渲染的那个封面视频详情卡片要和那个解析清晰度的提示分开发送」）。
     *
     * ## 为什么不能并进面板那条消息
     * 面板消息在选完清晰度之后是要**撤回**的 —— 卡片跟着一起没了，用户什么都没留下；
     * 而且开着「解析结果合并转发」时，面板那条消息为了拿到真实的消息 id
     * 必须 {@link withoutForwardCollect}（见下面 {@link send}），也就是**被排除在转发之外**，
     * 卡片于是**既被撤回、又不在转发里**，彻底消失（用户反馈：「合并转发里面也没有那个卡片啊」）。
     *
     * 所以这里走**普通发送**：不开合并转发时它就是群里一条独立的卡片（不会被撤），
     * 开着时它照常进转发（属于 `image`，默认就在「合并转发内容」里）。
     *
     * ⚠️ 面板路径下正式解析是**不重发**详情卡的（`fromPanel`），这张就是用户能看到的唯一一张。
     */
    if (card?.url) {
      try {
        await e.reply(segment.image(card.url))
      } catch (error: any) {
        logger.debug('[表情面板] 详情卡片单独发送失败（不影响面板）: ' + String(error?.message ?? error))
      }
    }
    /** 卡片已经发出去了，「加载中」那句就没用了 */
    await recallQuietly(e.bot, channelId, loadingId)
  }

  /**
   * 标题 / UP / 时长：有卡片时这些已经在卡里了，文字里再发一遍是重复（用户反馈），
   * 所以只有**没有卡片**时才发。
   */
  const head: string[] = []
  if (!card?.url) {
    if (info.title) head.push('《' + info.title + '》')
    const meta = [info.author && 'UP：' + info.author, info.duration && info.duration].filter(Boolean).join(' · ')
    if (meta) head.push(meta)
    if (head.length) head.push('')
  }
  const numberLines = shown.map((option, index) =>
    (index + 1) + '. ' + option.label + ' · ' + sizeText(option.sizeMB))

  /**
   * 三种排法（顺序 = 尝试顺序，前一种发不出去就用下一种）。
   *
   * ## 纯文字数字列表（`buildText`）
   * 所有平台都能发的那一版：序号 + 一句「回序号就行」的用法说明。
   * 没有表情可点的协议端上，这句提示是**唯一**告诉用户「还能选」的地方，
   * 所以必须写（用户反馈：「可以发数字的提示也没有」）。
   *
   * ## 表情在每行数字前面（`buildInline`，只在 NapCat 上用）
   * `[表情]1. 1080P · <1MB` / `[表情]2. 720P · <1MB` …
   * ⚠️ 这是 **face 段和 text 段交错**的排法。实测「face → 1.… → face → 2.…」
   * 在 LLOneBot 上 QQ 会吞掉中间几行文字（5 行选项只剩首尾两行），
   * 所以**只有确认是 NapCat 时才这么排**，别的协议端一律走下一种。
   *
   * ## 文字一段 + 末尾一排表情（`buildTrailing`）
   * 文字全部收进**一个** text 段、表情排在消息最后一行 —— 中间没有文本段可吞。
   * 那排表情和上面的 1 / 2 / 3 不挨着，所以要多写一句「从左到右数第几个」。
   */
  /**
   * 「提取封面图」那一项在文本里的写法（数字列表用）。
   *
   * 它**排在清晰度后面**、占一个序号，和表情那排的最右边那个 ✅️ 是同一件事 ——
   * 没有表情可点的协议端上，回这个序号同样能把封面提出来。
   */
  const coverLines = coverCommand ? ['', (shown.length + 1) + '. 提取封面图'] : []
  /** 卡片已经在上面**单独发过一条**了，面板这条消息只放选择提示 */
  const buildText = (): any[] => {
    return [segment.text([...head, '回复序号选一档清晰度：', ...numberLines, ...coverLines, '', NUMBER_HINT].join('\n'))]
  }
  const buildInline = (): any[] => {
    const list: any[] = []
    list.push(segment.text([...head, '点这条消息下面的表情，选一档清晰度（也可以直接回序号）：'].join('\n') + '\n'))
    shown.forEach((option, index) => {
      /** 最后一行也要换行：不换的话 ✅️ 那一行会**粘在最后一档后面** */
      const tail = (index === shown.length - 1 && !coverCommand) ? '' : '\n'
      list.push(segment.face(CHOICE_EMOJI_IDS[index]))
      list.push(segment.text(numberLines[index] + tail))
    })
    /**
     * 封面那一项用**真表情段**（478「对的对的」），紧跟在最后一档后面。
     *
     * ⚠️ 文字里**不许写 ✅️ 这类表情字符**（用户要求）：那个字符在 QQ 上会被渲染成
     * 另一个图案，跟下面真贴上去的那个表情对不上，用户照着找就找错了。
     * 这里能写 face 段是因为 **inline 排法只给 NapCat 用**（它不吞中间的文字）。
     */
    if (coverCommand) {
      list.push(segment.face(YES_EMOJI_ID))
      list.push(segment.text('（贴它 = 提取封面图）'))
    }
    return list
  }
  const buildTrailing = (): any[] => {
    const list: any[] = []
    /**
     * 这一版是给 **LLOneBot 这类会吞文字的协议端**用的：文字必须收进**一个** text 段，
     * 中间插 face 段又会被吞，所以封面那一项**只能在文字里点名**。
     *
     * ⚠️ 同样不写 ✅️ 字符（用户要求「ll 还是去 ✅️」）—— 写表情名「对的对的」，
     * 它和那排最右边真贴上去的 478 是同一个表情，用户照着名字找就行。
     */
    const hint = coverCommand ? [COUNT_HINT, '（最右边那个「对的对的」= 提取封面图）'] : [COUNT_HINT]
    list.push(segment.text([...head, '点这条消息下面的表情，选一档清晰度：', ...numberLines, '', ...hint].join('\n')))
    for (const choice of choices) list.push(segment.face(choice.emojiId))
    return list
  }

  /**
   * 面板这条消息**必须真的发出去**。
   *
   * 开着「解析结果合并转发」时，`e.reply()` 会把内容收进转发缓冲区、
   * 回一个**假的**消息 id（`forward-collected`）—— 面板拿着这个假 id 去贴表情、
   * 去等回应，当然**永远等不到**（用户反馈「贴了表情也没有反应」就是这个）。
   * 所以这里一律 `withoutForwardCollect`：选择提示是真消息，选完再撤回，
   * 解析产生的内容才进合并转发（用户要求：「先不要处理…选择完毕之后再撤回所有的，
   * 再把所有内容加到合并转发里面转发出来」）。
   */
  const send = async (): Promise<string> => {
    if (useEmoji) {
      try {
        const id = String((await withoutForwardCollect(() => e.reply(layout === 'inline' ? buildInline() : buildTrailing())))?.messageId ?? '')
        if (id) return id
      } catch (error: any) {
        /**
         * 个别协议端不认 `face` 段 —— 那时整条消息会发送失败。
         * **面板本身比表情重要**，所以一定要退回纯文字版再发一次。
         */
        logger.debug('[表情面板] 带表情的面板发送失败（协议端可能不认 face 段），退回纯文本: '
          + String(error?.message ?? error))
      }
    }
    try {
      return String((await withoutForwardCollect(() => e.reply(buildText())))?.messageId ?? '')
    } catch (error: any) {
      logger.debug('[表情面板] 发送选择消息失败: ' + String(error?.message ?? error))
    }
    return ''
  }

  const messageId = await send()
  if (!messageId) return false

  sweep()
  const timeoutMs = qualityPanelTimeoutMs()
  const panel: PendingPanel = {
    key: keyOf(channelId, messageId),
    channelId,
    messageId,
    kind: 'quality',
    requester: String(e.userId ?? (e as any).sender?.userId ?? ''),
    step: 'quality',
    choices,
    token,
    baseline: new Map(choices.map((choice) => [choice.emojiId, 1])),
    request,
    session: (e as any).session,
    bot: e.bot,
    recallIds: [],
    createdAt: Date.now(),
    withFaces: useEmoji,
    faceLayout: layout,
    /** 贴 ✅️ = 提取封面图；**点了面板不摘**，还能接着选清晰度 */
    extraActions: coverCommand
      ? new Map([[YES_EMOJI_ID, async () => { await runCommandText(panel.session ?? e, coverCommand) }]])
      : undefined
  }
  pending.set(panel.key, panel)

  /**
   * 超时兜底（用户要求：「超时了就自动按默认、直接解析的流程处理发送视频」）。
   *
   * 面板一发出，这条链接就不再走正常解析 —— 什么都不做等于把用户的链接吞掉。
   * 所以到点收掉面板（撤消息 + 撤那排表情），再**不带画质参数**跑一次解析，
   * 也就是「按配置里的默认画质」。
   */
  panel.onTimeout = async () => {
    logger.mark('[表情面板] 清晰度面板等了 %d 秒没人选，按默认清晰度继续解析（%s）',
      Math.round(timeoutMs / 1000), panel.key)
    await clearReactions(e.bot, channelId, messageId, choices.map((choice) => choice.emojiId))
    await recallQuietly(e.bot, channelId, messageId)
    await runParse(panel.session, panel, false, '')
  }
  armTimeout(panel, timeoutMs)

  if (!useEmoji) {
    logger.mark('[表情面板] 已发出清晰度数字列表（%d 档%s%s，平台 %s），等 %d 秒，面板 key = %s',
      shown.length, card ? '，带卡片图' : '', coverCommand ? '，含提取封面' : '',
      platformOf(e) || '未知', Math.round(timeoutMs / 1000), panel.key)
    return true
  }

  /**
   * 贴表情放在登记之后：万一这两个通知发得比登记早，处理函数已经能查到面板了。
   * 有一个贴失败不影响其它 —— 少一个按钮用户还能少选一档，不至于整个面板失效。
   *
   * **贴成功的个数要打出来**：这是判断「协议端到底支不支持表情」的唯一直接证据。
   * 一个都贴不上去（`set_msg_emoji_like` 这个方法不存在）时，点击事件也一定不会来 ——
   * 那种情况下只有**回序号**能用，日志里必须说清楚，否则又是一轮「点了没反应」的猜谜。
   */
  let stuck = 0
  for (const choice of choices) {
    if (await setReaction(e.bot, channelId, messageId, choice.emojiId, true)) stuck++
  }
  logger.mark('[表情面板] 已发出清晰度面板（%d 档%s%s，排法 %s），贴表情成功 %d/%d，等 %d 秒，面板 key = %s',
    shown.length, card ? '，带卡片图' : '', coverCommand ? '，含提取封面' : '',
    layout, stuck, choices.length, Math.round(timeoutMs / 1000), panel.key)
  if (!stuck) {
    logger.warn('[表情面板] 一个表情都没贴上去：这个协议端不支持 set_msg_emoji_like '
      + '（NapCat 要 v4.12.1+）。用户没有表情可点，只能回序号 —— 或升级协议端')
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
  if (!isEmojiPanelEnabled()) return false

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
  /** 只有一个动作时「贴什么表情都算」（见 PendingPanel.anyEmoji） */
  /** 只有一个动作时「贴什么表情都算」（见 PendingPanel.anyEmoji） */
  if (!picked && panel.anyEmoji && panel.choices.length === 1 && reactions.length) picked = panel.choices[0]
  if (!picked) return false

  return await dispatchPicked(panel, picked, session.bot, session,
    picked.emojiId + ':' + String(session.userId ?? '-'))
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
  if (!isEmojiPanelEnabled()) return false
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
  /**
   * 只有一个动作时「贴什么表情都算」：用户贴的不是我们贴的那一个（甚至 likes 里
   * 根本没带上 id）也照样执行 —— 只有一个动作就不会点错。
   */
  if (!picked && panel.anyEmoji && panel.choices.length === 1) picked = panel.choices[0]
  if (!picked) return false

  logger.mark(
    '[表情面板] 用户点中表情 %s → %s',
    picked.emojiId,
    panel.kind === 'choice'
      ? String(picked.label ?? '')
      : panel.step === 'quality'
        ? String(picked.label ?? picked.qualityId ?? '')
        : picked.onlineWatch ? '在线播放' : '直接发视频'
  )

  /** 反复触发的面板靠这个去重：用户贴的是**哪一个**表情，从 likes 里取（认任意表情时可能是别的 id） */
  const tapped = String(likes[0]?.emoji_id ?? picked.emojiId)
  return await dispatchPicked(panel, picked, session.bot, session, tapped + ':' + (who || '-'))
}

/**
 * **Satori 标准形状**的表情回应：`reaction-added` / `reaction-removed`。
 *
 * Milky 的适配器（`koishi-plugin-adapter-milky`）把 `group_message_reaction`
 * 转成这两个标准事件名，形状是：
 *
 *   | 字段                      | 值                                   |
 *   |---------------------------|--------------------------------------|
 *   | `session.type`            | `reaction-added` / `reaction-removed` |
 *   | `session.channelId`       | 群号                                 |
 *   | `session.messageId`       | `group:<群号>:<seq>` 编码出来的那条   |
 *   | `session.event.emoji.id`  | `face\|301`（Milky 自己带类型前缀）  |
 *
 * 跟 NapCat 那套（`session.onebot.notice_type = group_msg_emoji_like` + `likes[]` 快照）
 * 完全不同，所以单开一个函数。`{@link parseReactionId}` 负责把 `face|301` 还原成 `301`
 * —— 面板里存的是不带前缀的，不还原就永远匹配不上。
 *
 * @param emojiId **已经**过 {@link parseReactionId} 的表情 id
 */
const handleReactionAdded = async (
  session: any,
  channelId: string,
  messageId: string,
  emojiId: string
): Promise<boolean> => {
  /** 机器人自己贴/撤那排表情时协议端**也会上报**，不算用户点的 */
  const selfId = String(session.selfId ?? session.bot?.selfId ?? '')
  const who = String(session.userId ?? '')
  if (selfId && who && who === selfId) return false

  const panel = pending.get(keyOf(channelId, messageId))
  if (!panel) {
    const sameChannel = [...pending.values()].some((item) => item.channelId === channelId)
    if (sameChannel) {
      logger.mark('[表情面板] 收到 reaction 事件，但消息对不上：收到 %s；在等的是 %s',
        keyOf(channelId, messageId), describePending())
    } else {
      logger.debug('[表情面板] 收到 reaction 事件（%s），但没有在等的面板', keyOf(channelId, messageId))
    }
    return false
  }

  let picked = panel.choices.find((choice) => choice.emojiId === emojiId)
  /** 只有一个动作时「贴什么都算」：用户贴的不是我们贴的那个也照样执行（不会点错） */
  if (!picked && panel.anyEmoji && panel.choices.length === 1) picked = panel.choices[0]
  if (!picked) return false

  logger.mark('[表情面板] 用户点中表情 %s → %s（%s）', emojiId,
    String(picked.label ?? picked.qualityId ?? ''), panel.subject ?? panel.key)
  return await dispatchPicked(panel, picked, session.bot, session, emojiId + ':' + (who || '-'))
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
    /**
     * 认** Milky 那套标准形状。
     *
     * 认不出来就把载荷**原样打出来**（各家字段位置不一样，拿到真实载荷才能补精确映射）；
     * 认出来了就交给 {@link handleReactionAdded}。
     */
    /**
     * 标准形状里 reaction 事件**必需** `emoji` + `message` 两个资源，
     * 但各家把它们挂在会话的哪一层不一样：`session.messageId` 有时是空的，
     * 得再往下翻 `session.event.message.id` / `session.event.channel.id`。
     */
    const channelId = String(
      session.channelId ?? session.guildId
      ?? session.event?.channel?.id ?? session.event?.message?.channel?.id ?? '')
    const messageId = String(session.messageId ?? session.event?.message?.id ?? '')
    const rawEmoji = String(session.event?.emoji?.id ?? '')
    const isAdd = !/removed|cancel|delete/i.test(String(session.type ?? ''))
    if (channelId && messageId && rawEmoji && isAdd) {
      const handled = await handleReactionAdded(session, channelId, messageId, parseReactionId(rawEmoji))
      if (handled) return true
    }
    logger.mark('[表情面板] 收到 reaction 类事件（type=%s channel=%s message=%s emoji=%s），原始载荷：%s',
      String(session.type ?? '-'), channelId || '-', messageId || '-', rawEmoji || '-',
      brief(session.event ?? data))
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
  /**
   * 两个开关都要看：**数字列表**在所有平台上都可能有面板在等（它不依赖表情），
   * 只看「表情当按钮」那个开关的话，Telegram / 微信 / 关了表情的 OneBot 上
   * 回序号就完全没人接了。
   */
  if (!isSelectPanelEnabled()) return false

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
      /**
       * 同一个群里可能同时有**好几张**面板在等（选画质 + 查询下载进度…）。
       *
       * 取「这个序号对得上」的那一张，而不是简单取最新 —— 最新那张只有 1 项、
       * 而用户回的是 2 时，老写法在这里就 `return false` 了，
       * 于是「回复序号」这条退路在有多张面板时**整条失效**。
       */
      panel = mine.find((item) => !!item.choices[index - 1])
      if (panel) key = panel.key
    }
  }
  if (!panel) return false
  const picked = panel.choices[index - 1]
  if (!picked) return false

  logger.mark('[表情面板] 用户用**文字**选了第 %d 项%s → %s', index,
    quoteId ? '（引用）' : '（直接回数字）',
    panel.kind === 'choice'
      ? String(picked.label ?? '')
      : panel.step === 'quality'
        ? String(picked.label ?? picked.qualityId ?? '')
        : picked.onlineWatch ? '在线播放' : '直接发视频')

  return await dispatchPicked(panel, picked, session.bot, session,
    picked.emojiId + ':' + String(session.userId ?? '-'))
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
   * ## 排法跟第一步走
   * 第一步是数字列表（没有表情）时这里也必须是纯文字 —— 突然冒出一排表情，
   * 而那排表情在这个协议端上可能压根点不动。
   * 有表情时再按 {@link faceLayoutOf} 决定「表情在每行前面」还是「末尾一排」。
   */
  const rows = [
    { emojiId: YES_EMOJI_ID, text: '在线播放 —— 发一个链接，视频不占群空间' },
    { emojiId: NO_EMOJI_ID, text: '直接发视频 —— 把视频文件发到群里' }
  ]
  const withFaces = previous.withFaces === true && isEmojiPanelEnabled()
  const layout: FaceLayout = previous.faceLayout ?? 'trailing'
  const numberLines = ['1. ' + rows[0].text, '2. ' + rows[1].text]

  const buildAskText = (): any[] => {
    const head = ['已选 ' + qualityIdLabel, '', '回复序号，选怎么给你：']
    return [segment.text([...head, ...numberLines, '', NUMBER_HINT].join('\n'))]
  }
  const buildAskInline = (): any[] => [
    segment.text(['已选 ' + qualityIdLabel, '', '点这条消息下面的表情，选怎么给你（也可以直接回序号）：'].join('\n') + '\n'),
    segment.face(rows[0].emojiId),
    segment.text(numberLines[0] + '\n'),
    segment.face(rows[1].emojiId),
    segment.text(numberLines[1])
  ]
  const buildAskTrailing = (): any[] => [
    segment.text(['已选 ' + qualityIdLabel, '', '点这条消息下面的表情，选怎么给你：',
      ...numberLines, '', COUNT_HINT].join('\n')),
    segment.face(rows[0].emojiId),
    segment.face(rows[1].emojiId)
  ]
  const buildAsk = (withFace: boolean): any[] => {
    if (!withFace) return buildAskText()
    return layout === 'inline' ? buildAskInline() : buildAskTrailing()
  }

  let messageId = ''
  const idsOf = (sent: any): string => String((Array.isArray(sent) ? sent[0] : sent) ?? '')
  try {
    messageId = idsOf(await session.send(buildAsk(withFaces)))
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
    kind: 'watch',
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
    createdAt: Date.now(),
    withFaces,
    faceLayout: layout
  }
  pending.set(panel.key, panel)

  /**
   * 第二步也要超时兜底：画质已经选好了，没人回答「怎么给」就按**直接发视频**继续
   * —— 那是这一步的默认答案（在线播放是要用户主动要的）。
   */
  const timeoutMs = qualityPanelTimeoutMs()
  panel.onTimeout = async () => {
    logger.mark('[表情面板] 「是否在线播放」等了 %d 秒没人选，按「直接发视频」继续解析（%s）',
      Math.round(timeoutMs / 1000), panel.key)
    await clearReactions(panel.bot ?? bot, channelId, messageId, YES_NO_CHOICES.map((choice) => choice.emojiId))
    await recallQuietly(panel.bot ?? bot, channelId, messageId)
    await runParse(panel.session, panel, false)
  }
  armTimeout(panel, timeoutMs)

  let stuck = 0
  if (withFaces) {
    for (const choice of YES_NO_CHOICES) {
      if (await setReaction(session.bot, channelId, messageId, choice.emojiId, true)) stuck++
    }
  }
  logger.mark('[表情面板] 已发出「是否在线播放」（%s%s），%s等 %d 秒，面板 key = %s',
    qualityIdLabel, withFaces ? '，排法 ' + layout : '（纯文字数字列表）',
    withFaces ? '贴表情成功 ' + stuck + '/' + YES_NO_CHOICES.length + '，' : '',
    Math.round(timeoutMs / 1000), panel.key)
  if (stuck) trackPanelForPolling(panel.bot, panel)

  /**
   * 清掉上一条「选画质」那排表情。
   *
   * 那条消息**本身也要撤回**，但撤回可能被权限挡下来（机器人不是管理员时全部失败），
   * 留着一排点不动的表情比留一条文字难看得多 —— 所以这一排无论如何都要自己收掉。
   */
  await clearReactions(session.bot, previous.channelId, previous.messageId, previous.choices.map((choice) => choice.emojiId))
  return true
}

/**
 * 把「选好的画质 + 要不要在线播放」拼成一条解析命令跑起来。
 *
 * 走的和 QQ 按钮完全同一条路：按钮里本来就是一串 `解析 <链接> --p=<token> --qn=<画质>`，
 * 用户的变量全在这一串文本里，这里复用 `runCommand`（index.ts 里的 `runTextCommand`）就够了。
 *
 * ## 画质可以为空 = 按配置里的默认
 * 超时兜底走的就是这条路（`qualityId` 传空串）：命令里**不带** `--qn=` / `--q=`，
 * 解析自然就用配置里写的那一档 —— 这正是用户要的「超时了就按默认直接解析发视频」。
 * 所以这里**不能**因为画质为空就放弃（老代码有一句 `if (!qualityId) return`）。
 *
 * @param qualityId 画质标识；不传 / 空串 = 用配置默认
 */
const runParse = async (
  session: any,
  panel: PendingPanel,
  onlineWatch: boolean,
  qualityId?: string
): Promise<void> => {
  const runtime = tryGetRuntime()
  const runCommand = (runtime as any)?.runCommand
  const quality = String(qualityId ?? panel.qualityId ?? '')
  if (!runCommand) {
    logger.debug('[表情面板] 没有可用的命令入口，放弃这次选择（%s）', panel.qualityLabel ?? quality)
    return
  }
  const qualityFlag = panel.request?.platform === 'bilibili' ? '--qn=' : '--q='
  const parts: string[] = [commandInvocation('解析')]
  if (panel.request?.url && panel.request.url.length <= 120) parts.push(panel.request.url)
  if (panel.token) parts.push('--p=' + panel.token)
  if (quality) parts.push(qualityFlag + quality)
  if (onlineWatch) parts.push('--play=1')
  try {
    await runCommand(session, parts.join(' '))
  } catch (error: any) {
    logger.debug('[表情面板] 执行解析命令失败: ' + String(error?.message ?? error))
  }
}

/** 探针用：看现在有几个面板在等着被点 */
export const debugPendingCount = (): number => pending.size
/** 探针用：强制清空（避免用例之间互相干扰；面板上挂着的 setTimeout 也一起清掉） */
export const debugClear = (): void => {
  for (const panel of [...pending.values()]) settlePanel(panel, null)
  pending.clear()
  stopPollTimerIfIdle()
}

/**
 * 探针用：把**所有**在等的面板的超时立刻触发（真等 60 秒太慢）。
 *
 * 和 `debugClear` 的区别是它会跑 `onTimeout` ——
 * 也就是「没人选就按默认画质继续解析」那条兜底，探针靠它断言这一条真的会跑。
 */
export const debugFireTimeouts = async (): Promise<void> => {
  for (const panel of [...pending.values()]) await fireTimeout(panel)
  stopPollTimerIfIdle()
}

export default sendQualityReactionPanel
