/**
 * 把「长得离谱的文本」折起来再截断 —— 错误卡片和错误上报共用的止血钳。
 *
 * 线上实测（2026-09-22，用户那条 send_group_msg 失败）：OneBot 适配器会把**整个请求参数**
 * 拼进错误信息，里面是一张 4.6MB 的 base64 图片：
 *
 *     Error with request send_group_msg, args: {"group_id":1050229473,"message":[{"type":"image","data":{"file":"base64://<4.6MB>"}}]}, retcode: 1200
 *
 * 于是：
 *   - 错误卡片的 HTML 被撑到 **9.1MB**（其中 6.3MB 就是这一行），渲染跑十几分钟都出不来；
 *   - 上报给服务器的日志同样会带上这 4.6MB，白占带宽和磁盘。
 * 两边都只需要「看出错在哪」，完整内容本来就在日志文件里。
 *
 * 先折叠**再**截断：不折的话前 N 个字符全是 base64，调用栈反而被挤没了。
 */

/** 连续多长的「无分隔符长串」算载荷（hash / 转义过的 JSON） */
const LONG_RUN = 256
/** `base64://` 后面的载荷从多长开始折（它一定是载荷，门槛可以低很多） */
const LONG_B64_RUN = 64

/**
 * 「无分隔符长串」里允许出现的字符：`[A-Za-z0-9+/=]`。
 *
 * 用 `charCodeAt` 而不是正则 —— 见 {@link foldLongRuns} 里那段爆栈的说明。
 */
const isRunChar = (code: number): boolean =>
  (code >= 48 && code <= 57) ||   // 0-9
  (code >= 65 && code <= 90) ||   // A-Z
  (code >= 97 && code <= 122) ||  // a-z
  code === 43 ||                  // +
  code === 47 ||                  // /
  code === 61                     // =

/**
 * 长串紧前面是不是 `base64:` / `base64://`（或 `data:image/png;base64://`）。
 *
 * ⚠️ `/` 本身属于「无分隔符长串」的字符集，所以 `base64://AAAA` 里那两个斜杠
 * 会被算进长串 —— 这里要认的是**长串之前**那截（`…base64:`），斜杠那部分单独补回去。
 */
const B64_PREFIX_AT_END = /(?:data:[\w/.+-]+;)?base64:(?:\/\/)?$/i
/** 往前看多少个字符找这个前缀（data: 的 mime 再长也不止于此） */
const PREFIX_LOOKBACK = 96

/**
 * 折叠超长载荷串 —— **先折叠再截断**（见文件头）。
 *
 * ## ⚠️ 为什么手写扫描而不用 `String.replace`
 * 最早是两条正则 `replace`，但 **V8 在「单次匹配极长」时会递归爆栈**：
 * 实测 600 万字符的一整段 base64 直接抛
 * `RangeError: Maximum call stack size exceeded at foldLongRuns`。
 *
 * 线上真出过：群文件发送失败时 OneBot 把**整个请求参数**拼进错误信息（一段几 MB 的 base64），
 * 错误卡片去折叠它，于是真错误被这个 RangeError **整个盖掉** ——
 * 用户只看到「发不出去」，永远查不到为什么（反馈：「nc 发群文件还是发不出去」）。
 *
 * 折中的做法是「只折前 N 个字符」，但**那会丢掉长串后面的内容**（错误码、调用栈往往就在后面），
 * 恰好违背了「先折叠再截断」的初衷。所以改成线性扫描：
 *   - 一次 `charCodeAt` 扫过去，**不构造超长匹配**，也就没有爆栈这回事；
 *   - 只在**真的要替换**时才 `slice`，短内容原样拼回去，长串只留长度；
 *   - 前缀判定只在长串**前面 96 个字符**上跑正则，同样不会踩到大输入。
 *
 * **这个函数保证不抛异常**（它是错误上报的止血钳，自己崩了等于把真错误吞掉）。
 *
 * @param text - 原始文本
 * @returns 折叠后的文本
 */
export const foldLongRuns = (text: string | undefined): string => {
  const value = String(text ?? '')
  const n = value.length
  if (n < LONG_B64_RUN) return value
  try {
    const parts: string[] = []
    /** 上一次处理到的位置：它到下一个长串起点之间的内容原样保留 */
    let last = 0
    let i = 0
    while (i < n) {
      if (!isRunChar(value.charCodeAt(i))) { i++; continue }
      let end = i + 1
      while (end < n && isRunChar(value.charCodeAt(end))) end++
      const length = end - i
      const isBase64 = B64_PREFIX_AT_END.test(value.slice(Math.max(0, i - PREFIX_LOOKBACK), i))
      const threshold = isBase64 ? LONG_B64_RUN : LONG_RUN
      if (length < threshold) { i = end; continue }
      if (isBase64) {
        /** `base64://` 那两个斜杠在长串里，要跟着前缀一起留下来（`…base64://…`） */
        let slash = 0
        while (slash < 2 && value.charCodeAt(i + slash) === 47) slash++
        parts.push(value.slice(last, i + slash))
        parts.push('…')
      } else {
        parts.push(value.slice(last, i))
        parts.push('…[省略 ' + length + ' 字符的长串]…')
      }
      last = end
      i = end
    }
    if (!parts.length) return value
    parts.push(value.slice(last))
    return parts.join('')
  } catch {
    /** 真出问题就直接截断：宁可少折一点，也不能让错误上报自己炸掉 */
    return value.length > 4000 ? value.slice(0, 4000) + '\n…（折叠失败，已截断；原文共 ' + value.length + ' 字符）' : value
  }
}

/**
 * 截断并注明原文长度。
 * @param text - 原始文本
 * @param limit - 保留的字符数
 * @returns 截断后的文本
 */
export const truncateWithNote = (text: string | undefined, limit: number): string => {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  return value.slice(0, limit) + '\n…（已截断，完整内容见日志；原文共 ' + value.length + ' 字符）'
}

/**
 * 折叠 + 截断，一步到位。
 * @param text - 原始文本
 * @param limit - 保留的字符数
 * @returns 安全的文本
 */
export const foldAndTruncate = (text: string | undefined, limit: number): string =>
  truncateWithNote(foldLongRuns(text), limit)

/** 日志缓冲区最多留多少行（超了丢最早的） */
export const MAX_CAPTURED_LOG_LINES = 400
/** 单条日志最多留多少字符 —— 4.6MB 的 base64 就是从这里进来的 */
export const MAX_CAPTURED_LOG_CHARS = 4000
/** 错误卡片上最多显示多少行日志 */
export const MAX_CARD_LOG_LINES = 200

export default { foldLongRuns, truncateWithNote, foldAndTruncate, MAX_CAPTURED_LOG_LINES, MAX_CAPTURED_LOG_CHARS, MAX_CARD_LOG_LINES }
