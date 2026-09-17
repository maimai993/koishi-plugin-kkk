/**
 * 把「插件自己写进 config.json 的配置」反向同步到 Koishi 侧配置（koishi.yml）。
 *
 * kkk 有两套配置：
 *   - Koishi 控制台改的 `upstream` 字段 → 启动时由 configBridge 合并进
 *     `<数据目录>/koishi-plugin-kkk/config/config.json`（单向）
 *   - 插件运行时读写的是 config.json 本身
 *
 * 所以扫码登录这类「插件主动写入」的值（例如 B站 Cookie）在控制台里永远看不到，
 * 必须回写一次 koishi.yml，控制台表单才会显示真实取值。
 */
import { logger } from './logger'
import { tryGetRuntime } from './runtime'

const isPlainObject = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** 深合并：纯对象递归，其余（含数组）整体替换 */
function deepMerge<T extends Record<string, any>> (target: T, patch: Record<string, any>): T {
  const result: Record<string, any> = { ...target }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value)
    } else {
      result[key] = value
    }
  }
  return result as T
}

/**
 * 把一段配置合并进插件在 koishi.yml 里的 `upstream` 字段。
 * @param patch 要同步的内容，例如 `{ amagi: { cookies: { bilibili: 'SESSDATA=...' } } }`
 * @returns 是否同步成功（没有 scope / 写失败时返回 false，调用方降级即可）
 */
/** 日志本身也可能不可用（例如兼容层还没绑定 ctx），这里绝不能因为它再抛一次 */
const warn = (message: string) => {
  try {
    logger.warn(message)
  } catch {
    /* 忽略：同步失败本身不应该影响登录流程 */
  }
}

export async function syncUpstreamToKoishi (patch: Record<string, any>): Promise<boolean> {
  try {
    const ctx: any = tryGetRuntime()?.ctx
    const scope = ctx?.scope
    if (!scope || typeof scope.update !== 'function') {
      warn('[kkk] 当前环境不支持回写控制台配置（ctx.scope.update 不存在）')
      return false
    }
    const current: Record<string, any> = isPlainObject(scope.config) ? scope.config : {}
    const upstream = deepMerge(isPlainObject(current.upstream) ? current.upstream : {}, patch)
    await scope.update({ ...current, upstream })
    return true
  } catch (error: any) {
    warn('[kkk] 回写控制台配置失败: ' + (error?.message ?? error))
    return false
  }
}

export { deepMerge }
