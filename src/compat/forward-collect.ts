/**
 * 「解析结果合并转发」的收集器（兼容层内部用）。
 *
 * ## 为什么放在兼容层
 * 插件里所有对外发送最后都会走到兼容层的几个漏斗上：
 *   `Message.reply()` / `karin.sendMsg()` / `KkkBot.uploadFile()` / `makeForward+sendForwardMsg()`。
 * 在这一层挂钩子，业务代码一行都不用改，就能把**一次解析产生的所有内容**攒起来，
 * 解析结束时合并成一条转发发出去（用户要求：解析产生的所有信息都要合并转发）。
 *
 * ## 规则
 *   - 只有在「适配器支持合并转发」时才会开收集（QQ 官方适配器没有这个能力，
 *     那边保持原样：一边解析一边逐条发，见 ParseForward.withParseForward）；
 *   - **只收发往本次解析那个频道的消息**：错误日志要发给主人（另一个频道/另一个 bot），
 *     那种不能被吞进触发者的转发里；
 *   - **过程提示不收**（用户要求：转发里不包含过程提示）：调 `withoutForwardCollect()`
 *     包一下那次发送即可，例如「收到请求，开始下载」「发送中…」「加载中…」；
 *   - **看不清类别的特殊内容**（互动视频的剧情流程图）用 `withForwardKind('chart', …)` 包一下，
 *     它照常被收集，只是带着类别标签，交给 ParseForward 按「合并转发内容」里勾没勾来分流。
 *
 * 收集用的 `AsyncLocalStorage` 是**按解析链路**隔离的：定时推送、其它会话同时解析
 * 都不会串味。
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/** 收集到的内容（一次解析一个） */
interface ForwardBag {
  /** 本次解析要发到哪个频道（只有发往这里的才收） */
  peer: string
  /** 已经攒下来的元素（拍平，给「哪些内容进转发」的判断用） */
  elements: any[]
  /**
   * **按「每次发送」分组的元素**（一次 `reply()` = 一组）。
   *
   * 合并转发里**一组 = 一个聊天记录条目**：用户实测「一个条目里塞卡片 + 评论 + 视频时，
   * QQ 只加载了视频」，所以每条消息要各自成条目；但**切片是同一张卡片的若干片，
   * 必须留在同一个条目里**（用户要求：「切片还是一条信息内」）——
   * 靠 `e.reply([...])` 的调用边界天然分组，正好两边都满足。
   */
  groups: any[][]
  /** >0 表示当前这一段是「过程提示」，不进转发 */
  bypass: number
  /**
   * 这一段发出去的东西**算什么内容类别**（见 {@link withForwardKind}）。
   *
   * 默认 null = 由 ParseForward 按段类型判断（图片/视频/文字…）；
   * 少数「段类型看不出来」的内容要自己说清楚 —— 目前只有互动视频的**剧情流程图**：
   * 它是图片，但用户在「合并转发内容」里可能单独勾/不勾它。
   */
  kind: string | null
  /**
   * 这一袋子已经冲刷过了（解析结束、转发已经发出去）。
   *
   * 冲刷之后**绝不能再收东西**：剧情图那类后台任务还在跑，收进一个已经被 drain 的袋子里
   * 就再也没有人去发它了 —— 表现是「内容凭空消失」（这是收集器最容易踩的坑）。
   */
  closed: boolean
}

const storage = new AsyncLocalStorage<ForwardBag>()

/**
 * 「这个元素属于哪一类内容」的标记表（见 {@link withForwardKind}）。
 *
 * 用 WeakMap 挂在**原对象**上：元素还要原样交给适配器发送，不能往段对象上加字段。
 */
const KIND_TAGS = new WeakMap<object, string>()

/** 被收集时给调用方回的假消息 ID：调用方普遍只判断「有没有拿到 ID」 */
export const COLLECTED_MESSAGE_ID = 'forward-collected'

/** 在收集上下文里执行（peer 为空则不收任何东西） */
export function runWithForwardBag<T> (peer: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ peer: String(peer ?? ''), elements: [], groups: [], bypass: 0, kind: null, closed: false }, fn)
}

/** 当前收集袋（不在解析链路里时是 undefined） */
export function currentForwardBag (): ForwardBag | undefined {
  return storage.getStore()
}

/**
 * 当前是不是「合并转发收集模式」（发出去的东西只会被攒起来，不会真的发）。
 *
 * 为什么需要它：收集模式下 `reply()` 会直接回一个**假的**消息 ID（`forward-collected`），
 * 调用方（尤其是 `ImageSlice` 的「先普通发一次、失败再切片」）看到非空 ID 就会以为发成功了 ——
 * 于是那张 2880×35862 的评论卡**根本没被切**、整张塞进了转发节点，
 * `send_group_forward_msg` 因为节点内容过大整条失败（用户实测就是这个现象）。
 * 收集模式下拿不到任何真实反馈，所以调用方要改成**按尺寸自己判断**。
 */
export function isForwardCollecting (): boolean {
  const bag = storage.getStore()
  return !!bag && !bag.closed && bag.bypass === 0
}

/**
 * 这段代码里的发送都不进转发（过程提示 / 兜底文本用）。
 * 不在收集上下文里时原样执行。
 */
export async function withoutForwardCollect<T> (fn: () => Promise<T> | T): Promise<T> {
  const bag = storage.getStore()
  if (!bag) return await fn()
  bag.bypass += 1
  try {
    return await fn()
  } finally {
    bag.bypass -= 1
  }
}

/**
 * 这一段发出去的东西标一个**内容类别**（例如互动视频的 `chart` 剧情流程图）。
 *
 * 为什么需要它：ParseForward 是按**段类型**判断内容的（img→图片、video→视频…），
 * 而剧情流程图和普通图片都是 `img`，用户却想在「合并转发内容」里分别控制 ——
 * 只好由发送方自己说清楚「这条是流程图」。
 *
 * 不在收集上下文里（或者袋子已经冲刷过了）时原样执行，
 * 于是**不会影响**「合并转发关着」这条常见路径：那些场景下它就是个普通的发送。
 *
 * @param kind 内容类别（`chart`）
 * @param fn 这一段里发出的内容都按这个类别记账
 */
export async function withForwardKind<T> (kind: string, fn: () => Promise<T> | T): Promise<T> {
  const bag = storage.getStore()
  if (!bag || bag.closed || bag.bypass > 0) return await fn()
  const previous = bag.kind
  bag.kind = kind
  try {
    return await fn()
  } finally {
    bag.kind = previous
  }
}

/** 取某个元素被标记的内容类别（没标记就是 undefined，由 ParseForward 按段类型判断） */
export function forwardKindOf (element: any): string | undefined {
  if (!element || typeof element !== 'object') return undefined
  return KIND_TAGS.get(element)
}

/**
 * 发送漏斗。
 * @param peer 这条消息要发到哪个频道
 * @param content 元素 / 元素数组
 * @returns true 表示已经收进转发缓冲区，调用方**不要再发**
 */
export function collectForward (peer: string, content: any): boolean {
  const bag = storage.getStore()
  if (!bag || bag.bypass > 0 || bag.closed) return false
  const target = String(peer ?? '')
  if (!bag.peer || !target || target !== bag.peer) return false
  const list = Array.isArray(content) ? content : [content]
  // 一次调用 = 一组（= 合并转发里的一个聊天记录条目）；空元素不进组
  const group: any[] = []
  for (const element of list) {
    if (element === undefined || element === null || element === '') continue
    /** 这一段带类别标记（见 withForwardKind）时记在元素上，供 ParseForward 分流 */
    if (bag.kind && element && typeof element === 'object') KIND_TAGS.set(element, bag.kind)
    bag.elements.push(element)
    group.push(element)
  }
  if (group.length) bag.groups.push(group)
  return group.length > 0
}

/** 取出并清空收集到的内容（拍平） */
export function drainForward (): any[] {
  const bag = storage.getStore()
  if (!bag || !bag.elements.length) return []
  const elements = bag.elements
  bag.elements = []
  bag.groups = []
  /** 取走 = 这次解析结束了：之后再发的东西一律直发，不许再进这个袋子 */
  bag.closed = true
  return elements
}

/**
 * 取出并清空收集到的内容，**按「每次发送」分组**（一次 `reply()` 一组）。
 *
 * 合并转发用它建节点：一组 = 一个聊天记录条目。
 */
export function drainForwardGroups (): any[][] {
  const bag = storage.getStore()
  if (!bag || !bag.groups.length) return []
  const groups = bag.groups
  bag.groups = []
  bag.elements = []
  /**
   * **取走就关袋子**：解析到这里已经结束，转发马上要发出去了。
   * 剧情图这类后台任务还在跑，之后发出来的内容必须直发 ——
   * 否则会被收进一个再也没人 drain 的袋子，用户什么都收不到（静默丢内容）。
   */
  bag.closed = true
  return groups
}
