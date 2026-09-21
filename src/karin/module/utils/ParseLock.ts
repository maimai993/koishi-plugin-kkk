/**
 * 解析去重锁（「短时间不重复解析」）。
 *
 * 同一次点击可能被 QQ 投递两遍（指令按钮既发消息又发交互事件、用户连点、客户端重发），
 * 而解析本身是重活（取流 + 下载 + 发送），跑两遍的后果是：
 * 用户看到两次「检测到链接，开始解析」，第二次还会因为缓存已被清理而失败。
 *
 * 这里按「会话 + 作品 + 画质 + 弹幕开关」在一段时间内只放行一次；
 * 换画质/换解析内容属于不同的键，不会被误伤。
 *
 * 两个配置项都在「通用」里（见 src/qqFields.json）：
 *   - `parseDedupe`（默认开）：总开关，关掉后每次都放行（方便反复调试同一条链接）；
 *   - `parseDedupeMinutes`（默认 1，1~60）：去重窗口，单位分钟，只在开关打开时生效。
 */
import { logger } from 'node-karin'

import { tryGetRuntime } from '../../../compat/runtime'

/** 默认窗口（分钟）：配置没填 / 填歪了就用它 */
const DEFAULT_WINDOW_MINUTES = 1
/** 允许的范围（分钟）：太大会让人以为「插件不理我了」 */
const MIN_WINDOW_MINUTES = 1
const MAX_WINDOW_MINUTES = 60

const recent = new Map<string, number>()

/** 读一个配置值（读不到运行时 / 配置时返回 undefined） */
function readConfig (key: string): any {
  try {
    return (tryGetRuntime()?.config as any)?.[key]
  } catch {
    return undefined
  }
}

/**
 * 「短时间不重复解析」开关是否打开。
 *
 * 缺省即开（老配置里没有这个键时行为与以前一致）；读不到运行时（例如单元测试）也按开处理。
 */
export function isParseDedupeEnabled (): boolean {
  return readConfig('parseDedupe') !== false
}

/**
 * 去重窗口（毫秒）。
 *
 * 取 `parseDedupeMinutes`（分钟，默认 1）：填歪了（非数字 / 空）就是默认值 1；
 * 超出范围**夹到最近的边界**（填 0 → 1 分钟，填 90 → 60 分钟），
 * 免得一个手滑把窗口设成 0（等于没去重）或者 100000（等于再也不解析同一条链接）。
 */
export function parseDedupeWindowMs (): number {
  const raw = Number(readConfig('parseDedupeMinutes'))
  if (!Number.isFinite(raw)) return DEFAULT_WINDOW_MINUTES * 60 * 1000
  const minutes = Math.min(MAX_WINDOW_MINUTES, Math.max(MIN_WINDOW_MINUTES, raw))
  return Math.round(minutes * 60 * 1000)
}

/** 关掉开关时只提示一次，别把日志刷爆 */
let loggedDisabled = false

/**
 * 尝试取得一次解析许可。
 * @param key 去重键（建议包含会话、作品 ID、画质与弹幕开关）
 * @returns true = 可以解析；false = 刚刚已经跑过一次，忽略
 */
export function acquireParseLock (key: string): boolean {
  /** 开关关掉：每次都放行（只提示一次，免得每条消息都刷一行） */
  if (!isParseDedupeEnabled()) {
    if (!loggedDisabled) {
      loggedDisabled = true
      logger.debug('[解析去重] 「短时间不重复解析」已关闭，本次不限制重复解析')
    }
    return true
  }
  const window = parseDedupeWindowMs()
  const now = Date.now()
  for (const [item, at] of recent) {
    if (now - at > window) recent.delete(item)
  }
  const last = recent.get(key)
  if (last !== undefined && now - last < window) return false
  recent.set(key, now)
  return true
}

export default acquireParseLock
