/**
 * 弹幕烧录的总策略。
 *
 * 三条链路（面板的「烧录弹幕」列、`--dm=1` / `#弹幕解析` 指令、上游配置里的 burnDanmaku）
 * 都要先过这里，避免出现「面板关掉了、指令还能烧」这种半开状态。
 *
 * 优先级从高到低：
 *   1. `forceNoDanmaku`（通用分组，默认开启）—— 打开时一律不烧，指令也压不过它；
 *   2. 机器上有没有 ffmpeg —— 没有就烧不出来；
 *   3. 用户这次有没有主动要烧（指令 / 面板按钮 / 平台配置）。
 */
import { isFfmpegAvailable } from 'node-karin'

import { tryGetRuntime } from '../../../compat/runtime'

/**
 * 是否被全局强制关闭了弹幕烧录。
 * 配置项默认就是「开启强制关闭」—— 不装 ffmpeg、也不看弹幕的部署不用管它。
 */
export const isBurnDanmakuForbidden = (): boolean => {
  try {
    return (tryGetRuntime()?.config as any)?.forceNoDanmaku !== false
  } catch {
    return true
  }
}

/** 现在到底能不能烧弹幕：没被强制关掉，并且机器上真的有 ffmpeg */
export const isBurnDanmakuSupported = (): boolean => !isBurnDanmakuForbidden() && isFfmpegAvailable()

/**
 * 本次解析要不要烧弹幕。
 * @param requested 用户是否主动要了（指令 / 面板按钮 / 平台配置，三者任一为真即可）
 */
export const shouldBurnDanmaku = (requested: boolean): boolean => !!requested && isBurnDanmakuSupported()

export default shouldBurnDanmaku
