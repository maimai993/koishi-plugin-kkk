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
 *     包一下那次发送即可，例如「收到请求，开始下载」「发送中…」「加载中…」。
 *
 * 收集用的 `AsyncLocalStorage` 是**按解析链路**隔离的：定时推送、其它会话同时解析
 * 都不会串味。
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/** 收集到的内容（一次解析一个） */
interface ForwardBag {
  /** 本次解析要发到哪个频道（只有发往这里的才收） */
  peer: string
  /** 已经攒下来的元素 */
  elements: any[]
  /** >0 表示当前这一段是「过程提示」，不进转发 */
  bypass: number
}

const storage = new AsyncLocalStorage<ForwardBag>()

/** 被收集时给调用方回的假消息 ID：调用方普遍只判断「有没有拿到 ID」 */
export const COLLECTED_MESSAGE_ID = 'forward-collected'

/** 在收集上下文里执行（peer 为空则不收任何东西） */
export function runWithForwardBag<T> (peer: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ peer: String(peer ?? ''), elements: [], bypass: 0 }, fn)
}

/** 当前收集袋（不在解析链路里时是 undefined） */
export function currentForwardBag (): ForwardBag | undefined {
  return storage.getStore()
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
 * 发送漏斗。
 * @param peer 这条消息要发到哪个频道
 * @param content 元素 / 元素数组
 * @returns true 表示已经收进转发缓冲区，调用方**不要再发**
 */
export function collectForward (peer: string, content: any): boolean {
  const bag = storage.getStore()
  if (!bag || bag.bypass > 0) return false
  const target = String(peer ?? '')
  if (!bag.peer || !target || target !== bag.peer) return false
  const list = Array.isArray(content) ? content : [content]
  let added = 0
  for (const element of list) {
    if (element === undefined || element === null || element === '') continue
    bag.elements.push(element)
    added += 1
  }
  return added > 0
}

/** 取出并清空收集到的内容 */
export function drainForward (): any[] {
  const bag = storage.getStore()
  if (!bag || !bag.elements.length) return []
  const elements = bag.elements
  bag.elements = []
  return elements
}
