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

/** 连续多长的「无分隔符长串」算载荷（base64 / hash / 转义过的 JSON） */
const LONG_RUN = 256

/**
 * 折叠超长载荷串。
 * @param text - 原始文本
 * @returns 折叠后的文本（长度不变的部分原样保留）
 */
export const foldLongRuns = (text: string | undefined): string =>
  String(text ?? '')
    // data URI / base64:// 后面的载荷
    .replace(/((?:data:[\w/.+-]+;)?base64:\/\/)[A-Za-z0-9+/=]{64,}/gi, (_all, head: string) => head + '…')
    // 兜底：任何没有分隔符的超长串（JSON 里被转义过的载荷也走这条）
    .replace(/[A-Za-z0-9+/=]{256,}/g, (all) => '…[省略 ' + all.length + ' 字符的长串]…')

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
