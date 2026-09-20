/**
 * 弹幕烧录的总策略。
 *
 * 三条链路（面板的「弹幕」/「烧录弹幕」列、`--dm=1` / `#弹幕解析` 指令、上游配置里的 burnDanmaku）
 * 都要先过这里，避免出现「面板关掉了、指令还能烧」这种半开状态。
 *
 * 优先级从高到低：
 *   1. **在线播放模式**（通用里的「在线播放器」总开关打开 + 用户这次要了弹幕）——
 *      要的是网页里看弹幕，不是把弹幕画进画面，所以一律不烧，改为登记播放会话；
 *   2. `forceNoDanmaku`（通用分组，默认开启）—— 打开时一律不烧，指令也压不过它；
 *   3. 机器上有没有 ffmpeg —— 没有就烧不出来；
 *   4. 用户这次有没有主动要烧（指令 / 面板按钮 / 平台配置）。
 */
import { isFfmpegAvailable } from 'node-karin'

import { isOnlinePlayerRequest } from '../../../player'
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
 *
 * 在线播放模式下**永远不烧**：用户要的是「网页里带弹幕看」，烧进画面反而又慢又费 CPU，
 * 而且发出去的文件里弹幕是关不掉的。这时候平台 handler 会走 src/player 登记播放会话。
 * @param requested 用户是否主动要了（指令 / 面板按钮 / 平台配置，三者任一为真即可）
 */
export const shouldBurnDanmaku = (requested: boolean): boolean =>
  !isOnlinePlayerRequest() && !!requested && isBurnDanmakuSupported()

/**
 * 本次解析要不要去**取弹幕数据**。
 *
 * 烧录要取（要画进画面），在线播放也要取（要存给播放页）—— 两者的取数条件一样，
 * 差别只在取回来干什么。平台 handler 用这个函数决定要不要调弹幕接口。
 * @param requested 用户是否主动要了弹幕
 */
export const shouldFetchDanmaku = (requested: boolean): boolean =>
  isOnlinePlayerRequest() || shouldBurnDanmaku(requested)

/** 本次是不是「在线播放」（调试 / 文案判断用） */
export { isOnlinePlayerRequest }

export default shouldBurnDanmaku
