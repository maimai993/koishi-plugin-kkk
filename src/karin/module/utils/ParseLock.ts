/**
 * 解析去重锁。
 *
 * 同一次点击可能被 QQ 投递两遍（指令按钮既发消息又发交互事件、用户连点、客户端重发），
 * 而解析本身是重活（取流 + 下载 + 发送），跑两遍的后果是：
 * 用户看到两次「检测到链接，开始解析」，第二次还会因为缓存已被清理而失败。
 *
 * 这里按「会话 + 作品 + 画质 + 弹幕开关」在短时间内只放行一次；
 * 换画质/换解析内容属于不同的键，不会被误伤。
 */

/** 去重窗口（毫秒） */
const WINDOW = 20 * 1000

const recent = new Map<string, number>()

/**
 * 尝试取得一次解析许可。
 * @param key 去重键（建议包含会话、作品 ID、画质与弹幕开关）
 * @returns true = 可以解析；false = 刚刚已经跑过一次，忽略
 */
export function acquireParseLock (key: string): boolean {
  const now = Date.now()
  for (const [item, at] of recent) {
    if (now - at > WINDOW) recent.delete(item)
  }
  const last = recent.get(key)
  if (last !== undefined && now - last < WINDOW) return false
  recent.set(key, now)
  return true
}

export default acquireParseLock
