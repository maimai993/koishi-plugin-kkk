/**
 * QQ 发送失败的「判错」—— **按错误码判，并对齐 qq-chat 的判法**。
 *
 * ## 两条失败信号（缺一不可）
 *
 * 1. **适配器抛异常**：QQ 适配器把失败写进异常里，形如
 *    `QQ 消息发送失败 [40093011] 上传文件大小超过限制`，
 *    并且用 `AggregateError` 抛出（每条错误在 `error.errors[]` 里）。
 *    错误码要从 `error.errors[]` / `error.message` / `error.response.data` 三处找
 *    —— 和 `koishi-plugin-qq-chat` 的做法一致（见它的 `api-handlers.ts`：
 *    `error?.code ?? error?.err_code ?? error?.response?.data?.code`，并递归 AggregateError）。
 * 2. **发送后没有拿到消息 ID**：适配器不抛异常，但也**没有**把消息塞进结果里。
 *    qq-chat 就是这么判的（`api-handlers.ts:710`）：
 *
 *        // 适配器没抛异常但也没给消息 id：QQ 那边其实没发出去
 *        if (!messageId) return { success: false, error: '发送失败：QQ 没有返回消息 ID' }
 *
 *    这条同样适用于 kkk：**没 ID ≠ 成功**。以前这里反过来当成成功了，
 *    结果「发送失败」被静默吞掉（卡片没发出去，插件却当成功继续往下跑）。
 *
 * ## 为什么不能只看「有没有 ID」而不看错误码
 *
 * 「没 ID」只说明**没确认发出**，说不出**为什么**。真正可动作的信息在错误码里：
 * 体积超限要去切片、被动回复超限要换通道、被禁言/无权限就该放弃。所以两者配合用：
 * 异常里的错误码决定「怎么办」，没 ID 决定「确实没发出去」。
 */

/** 失败的类别，决定下一步动作 */
export type SendFailureKind =
  /** 体积/尺寸超限：重试没有意义，直接切片或降级 */
  | 'oversize'
  /** 被动回复时间窗/次数用尽：换主动消息通道 */
  | 'passive-limit'
  /** 平台层面发不出去（无主动消息权限 / 被禁言 / 接口无权限 / 机器人不是管理员）：重试无意义 */
  | 'permission'
  /** 瞬时故障（网络抖动、TLS、超时）：值得重试 */
  | 'transient'
  /** 适配器没报错，但发送后没有拿到消息 ID —— 消息没有被确认发出 */
  | 'unconfirmed'
  /** 拿不到更多信息的失败：当作可重试 */
  | 'unknown'

export interface SendFailure {
  kind: SendFailureKind
  /** QQ 错误码，拿得到才有 */
  code?: number
  /** 原始错误信息（多条用 " | " 连起来） */
  message: string
  /** 是否值得原样重试 */
  retryable: boolean
}

/**
 * 错误码表。
 *
 * 只列我们**真的会分支处理**的码；其余码一律走关键词兜底或当作未知失败，
 * 免得把不认识的码误判成「可以重试」而白白重传一遍大文件。
 */
const OVERSIZE_CODES = new Set([
  40093011, // 上传文件大小超过限制
])

const PASSIVE_LIMIT_CODES = new Set([
  40034128, // 回复消息失败，被动回复时间或者次数超过限制
])

/** 平台层面发不出去（对齐 qq-chat 已知的几个码） */
const PERMISSION_CODES = new Set([
  40034105, // 机器人无主动消息权限（主动推送被拒）
  40054002, // 机器人被禁言
  11253, // 无接口权限（如群成员查询）
  40012010, // 无接口权限（err_code 形态）
  11703, // 机器人不是群管理员
  40011030, // 机器人不是群管理员（err_code 形态）
])

const TRANSIENT_CODES = new Set([
  40054005, // msg_seq 重复（适配器自己会换 msg_seq 重试）
])

const OVERSIZE_TEXT = /上传文件大小|文件过大|图片过大|视频过大|超过限制|超出限制|too large|payload too large|entity too large|\b413\b/i
const PASSIVE_LIMIT_TEXT = /被动回复|msg_seq/i
const PERMISSION_TEXT = /无权限|没有权限|权限不足|被禁言|禁言|主动消息|proactive/i
const TRANSIENT_TEXT = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|timeout|超时|证书|certificate|TLS|网络异常/i

/** 适配器把错误码写在方括号里：`QQ 消息发送失败 [40093011] …` */
const CODE_IN_TEXT = /\[(\d{4,})\]/g
/**
 * OneBot 的写法：`Error with request send_group_msg, args: {…}, retcode: 1200`。
 *
 * 适配器 `koishi-plugin-adapter-onebot` 会把 retcode 同时挂在 `error.code` 上，
 * 但 message 里这份更好用（args 里的 base64 会先把 code 那个 getter 挤掉的情况也存在）。
 */
const RETCODE_IN_TEXT = /retcode\s*[:=]\s*(\d+)/gi

/**
 * 「发送后没有拿到消息 ID」专用的错误。
 *
 * 兼容层在**没有异常但也没有 ID** 时抛它，让调用方（切片逻辑、上传逻辑…）按失败处理，
 * 而不是把没发出去的消息当成成功继续往下跑。
 */
export class UnconfirmedSendError extends Error {
  readonly sendFailureKind: SendFailureKind = 'unconfirmed'

  constructor (detail?: string) {
    super('发送失败：没有拿到消息 ID（适配器没抛异常，但消息没有发出去）' + (detail ? '（' + detail + '）' : ''))
    this.name = 'UnconfirmedSendError'
  }
}

interface CollectedError {
  codes: number[]
  text: string[]
}

/**
 * 把一个异常（可能是 AggregateError）摊平成「错误码 + 文本」。
 *
 * 深度限制 3 层，够覆盖 `AggregateError → Error → cause` 这条链，也不会被自引用的
 * 错误对象绕进去。
 */
function collectError (error: any, depth = 0): CollectedError {
  const codes: number[] = []
  const text: string[] = []
  if (!error || depth > 3) return { codes, text }

  const pushCode = (value: any) => {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) codes.push(value)
    else if (typeof value === 'string' && /^\d{4,}$/.test(value)) codes.push(Number(value))
  }

  pushCode(error.code)
  pushCode(error.errCode)
  pushCode(error.err_code)
  pushCode(error.status)
  pushCode(error.retcode)

  const data = error.response?.data ?? error.data
  if (data && typeof data === 'object') {
    pushCode(data.err_code)
    pushCode(data.code)
    pushCode(data.retcode)
    if (typeof data.message === 'string') text.push(data.message)
    if (typeof data.msg === 'string') text.push(data.msg)
    if (typeof data.err_msg === 'string') text.push(data.err_msg)
  }

  if (typeof error.message === 'string' && error.message) text.push(error.message)
  if (typeof error.msg === 'string' && error.msg) text.push(error.msg)
  if (typeof error.reason === 'string' && error.reason) text.push(error.reason)
  if (typeof error === 'string' && error) text.push(error)

  // satori 的适配器用 AggregateError 抛出，每条真实错误在 errors[] 里
  const inner = Array.isArray(error.errors) ? error.errors : []
  for (const item of inner) {
    const sub = collectError(item, depth + 1)
    codes.push(...sub.codes)
    text.push(...sub.text)
  }
  if (error.cause) {
    const sub = collectError(error.cause, depth + 1)
    codes.push(...sub.codes)
    text.push(...sub.text)
  }
  return { codes, text }
}

/** 判断一个异常属于哪一类失败，并给出「能不能原样重试」 */
export function classifySendFailure (error: unknown): SendFailure {
  if (error instanceof UnconfirmedSendError) {
    return { kind: 'unconfirmed', message: error.message, retryable: false }
  }
  const { codes, text } = collectError(error)
  const joined = text.join(' | ')

  // 文本里可能还藏着错误码：QQ 官方适配器写 `[40093011]`，OneBot 写 `retcode: 1200`
  for (const match of joined.matchAll(CODE_IN_TEXT)) codes.push(Number(match[1]))
  for (const match of joined.matchAll(RETCODE_IN_TEXT)) codes.push(Number(match[1]))

  const hit = (set: Set<number>) => codes.find((code) => set.has(code))
  const oversizeCode = hit(OVERSIZE_CODES)
  const passiveCode = hit(PASSIVE_LIMIT_CODES)
  const permissionCode = hit(PERMISSION_CODES)
  const transientCode = hit(TRANSIENT_CODES)
  const code = oversizeCode ?? passiveCode ?? permissionCode ?? transientCode ?? codes[0]

  // 错误码优先：码是确定的，文本只是兜底
  if (oversizeCode !== undefined) return { kind: 'oversize', code: oversizeCode, message: joined, retryable: false }
  if (passiveCode !== undefined) return { kind: 'passive-limit', code: passiveCode, message: joined, retryable: false }
  if (permissionCode !== undefined) return { kind: 'permission', code: permissionCode, message: joined, retryable: false }
  if (OVERSIZE_TEXT.test(joined)) return { kind: 'oversize', code, message: joined, retryable: false }
  if (PASSIVE_LIMIT_TEXT.test(joined)) return { kind: 'passive-limit', code, message: joined, retryable: false }
  if (PERMISSION_TEXT.test(joined)) return { kind: 'permission', code, message: joined, retryable: false }
  if (transientCode !== undefined || TRANSIENT_TEXT.test(joined)) return { kind: 'transient', code: transientCode ?? code, message: joined, retryable: true }
  return { kind: 'unknown', code, message: joined, retryable: true }
}

/**
 * 从 `reply()` 的返回值里找失败。
 *
 * 只有返回值里显式带 `error`、或者 message 里写着失败才判定失败；
 * 「没拿到消息 ID」由兼容层直接抛 {@link UnconfirmedSendError}，不走这里。
 */
export function failureFromReplyResult (result: any): SendFailure | null {
  if (!result || typeof result !== 'object') return null
  if (result.error) return classifySendFailure(result.error)
  const text = typeof result.message === 'string' ? result.message : ''
  if (text && /error|fail|失败|超过|限制|拒绝|invalid|denied/i.test(text)) return classifySendFailure(text)
  return null
}

/** 日志里用的短描述：`[40093011] 上传文件大小超过限制`（文本里已经有码就不重复写） */
export function describeSendFailure (failure: SendFailure): string {
  const text = String(failure.message ?? '')
    .split(' | ')[0]
    .trim()
    .replace(/^QQ 消息发送失败\s*/, '')
    .slice(0, 160)
  const hasCode = failure.code !== undefined && text.startsWith('[' + failure.code + ']')
  const code = failure.code !== undefined && !hasCode ? '[' + failure.code + '] ' : ''
  return code + (text || failure.kind)
}

/** 是不是「换主动消息通道就能救」的那种失败（只有被动回复超限算） */
export function isPassiveLimitFailure (failure: SendFailure): boolean {
  return failure.kind === 'passive-limit'
}
