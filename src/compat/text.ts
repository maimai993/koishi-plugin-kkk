/**
 * 消息文本归一化（QQ 平台分享卡片）。
 *
 * QQ 官方适配器（koishi-plugin-adapter-qq-crack，platform=\`qqguild\`）解码消息时是
 * \`message.elements = [h.text(data.content)]\` —— 不做卡片解析，把原始内容整段当文本塞进来。
 * 于是分享卡片/小程序消息在插件眼里是这样一串：
 *
 * \`\`\`text
 * {"app":"com.tencent.structmsg","meta":{"detail_1":{"qqdocurl":"https:\\/\\/v.douyin.com\\/xxxx\\/"}}}
 * \`\`\`
 *
 * 注意 URL 里的斜杠是 **JSON 转义过的** \`\\/\`，直接拿 \`https?:\\/\\/\` 去匹配当然匹配不到；
 * 这正是「QQ 卡片解析不了」的原因。这里做两件事：
 *   1. 还原 JSON 转义（\`\\/\` → \`/\`、\`\\u0026\` → \`&\`、\`\\"\` → \`"\`）；
 *   2. 把从卡片里挖出来的 URL **追加到文本末尾**，让各平台解析命令的正则能照常命中 ——
 *      命令本身仍按前缀匹配，不受影响。
 */

/** 从任意文本里收集 http(s) 链接（会先还原 JSON 转义） */
export function extractUrls (input: string): string[] {
  if (!input || !input.includes('http')) return []
  const unescaped = unescapeJsonText(input)
  const matched = unescaped.match(/https?:\/\/[^\s"'<>\\\]\[}{]+/gi) ?? []
  const result: string[] = []
  for (const raw of matched) {
    // 去掉 JSON 里常见的尾随符号
    const url = raw.replace(/[),.;:'"]+$/, '')
    if (!result.includes(url)) result.push(url)
  }
  return result
}

/** 还原 JSON 字符串里的转义（只处理会影响 URL 识别的几种） */
export function unescapeJsonText (input: string): string {
  if (!input || !input.includes('\\')) return input
  return input
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/\\u0026/gi, '&')
}

/**
 * 归一化一段消息文本：卡片消息会额外附带「从中提取出的链接」。
 * 普通文本原样返回（不改变已有行为）。
 */
export function normalizeMessageText (content: string): string {
  const text = (content ?? '').trim()
  if (!text) return ''
  // 纯文本、里面没有 JSON 转义/花括号时不必处理
  if (!text.includes('\\') && !text.includes('{')) return text
  const urls = extractUrls(text)
  if (!urls.length) return unescapeJsonText(text)
  const missing = urls.filter((url) => !text.includes(url))
  return missing.length ? text + ' ' + missing.join(' ') : text
}

export default normalizeMessageText
