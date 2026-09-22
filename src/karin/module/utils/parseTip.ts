/**
 * 解析开始时的提示语。
 *
 * **为什么要单独一个文件**：这个函数原来放在 QqPanel 里，而 QqPanel 又依赖平台模块；
 * 平台模块反过来调用 sendParseTip → 形成循环 import，打包后函数绑定还没初始化，
 * 调用时直接报 `(0 , module_1.sendParseTip) is not a function`（快手整个解析挂掉就是这个原因）。
 * 这里只依赖 Config / ParseOverride / 基础段，彻底断开环。
 */
import { segment, withoutForwardCollect, type Message } from 'node-karin'

import { isParseDedupeEnabled } from './ParseLock'
import { getParseOverride } from './ParseOverride'

import { Config } from './Config'

/** 同一句提示的最小间隔（毫秒）：只用来压住「同一条消息被投递多遍」这种秒级重复 */
const TIP_WINDOW = 5000

/** 最近发过的提示：`会话|提示内容` → 时间戳 */
const recentTips = new Map<string, number>()

/**
 * 这句提示**现在该不该发**。
 *
 * 用户实测「发一遍提示三次」：一次发送被投递多遍时，每个副本都会走到提示这一行。
 * 解析本身有作品级去重（ParseLock）挡着，但提示在那之前就发出去了 ——
 * 所以这里再收一道口子：同一会话、同一句提示，5 秒内只发一次。
 * 开关「短时间不重复解析」关掉时不拦截（行为与以前一致）。
 * @param e 消息事件
 * @param content 提示内容
 */
export const shouldSendTip = (e: Message, content: any): boolean => {
  if (!isParseDedupeEnabled()) return true
  const key = String((e as any)?.contact?.peer ?? (e as any)?.channelId ?? '') + '|' + String(content)
  const now = Date.now()
  for (const [item, at] of recentTips) {
    if (now - at > TIP_WINDOW) recentTips.delete(item)
  }
  const last = recentTips.get(key)
  if (last !== undefined && now - last < TIP_WINDOW) return false
  recentTips.set(key, now)
  return true
}

/**
 * 登记「正在获取下载链接」阶段。
 *
 * 用户在「收到请求，开始下载」刚出现时点「查询下载进度」，这时还没开始传字节，
 * 以前只会显示「当前没有正在进行的下载」，很误导 —— 现在能看到真实阶段。
 * 真正开始下载时 Downloader 会清掉阶段条目（改成显示字节进度），
 * 后面的烧录 / 准备在线播放 / 发送等阶段会接着覆盖同一条记录。
 */
export const beginParseStage = async (platformName: string): Promise<void> => {
  try {
    const { reportDownloadStage, PARSE_STAGE_KEY, DOWNLOAD_STAGES } = await import('./Network/Downloader')
    reportDownloadStage(PARSE_STAGE_KEY, platformName + '解析', DOWNLOAD_STAGES.fetching)
  } catch { /* 观测失败不影响解析 */ }
}

/**
 * 撤回上一条机器人消息（拿不到就忽略）。
 *
 * **发送走 `withoutForwardCollect`**：过程提示不该被合并转发收进去
 * （用户实测反馈：「解析提示在合并转发里面」）—— 「检测到 xx 链接，开始解析」
 * 这种一句话是提示，不是解析结果。
 */
const recallPrevious = async (e: Message, content: any): Promise<void> => {
  try {
    const target: any = e as any
    const bot: any = target?.bot?.bot ?? target?.bot
    // 尽量撤掉上一条：群里的提示只留最新的一条
    const last: any = (target as any)?.__kkkLastPanelMessage
    if (last && typeof bot?.recallMsg === 'function') {
      await bot.recallMsg(last, String(target?.contact?.peer ?? target?.channelId ?? ''))
    }
  } catch { /* 撤回失败无所谓 */ }
  await withoutForwardCollect(() => e.reply(content))
}

/**
 * 解析开始时的提示语 —— 两种来源说两句话：
 *   - **面板按钮点出来的**：画质面板刚发过，这里只回「收到请求，开始下载」
 *   - 手工发链接的：仍然是「检测到 XX 链接，开始解析」
 */
export const sendParseTip = async (e: Message, platformName: string): Promise<void> => {
  // 解析一开始就登记阶段：用户这时候点「下载进度」能看到「正在获取下载链接」
  await beginParseStage(platformName)

  const fromPanel = getParseOverride()?.fromPanel === true
  if (fromPanel) {
    if (shouldSendTip(e, '收到请求，开始下载')) await recallPrevious(e, '收到请求，开始下载')
    return
  }
  if (Config.app.parseTip) {
    const tip = '检测到' + platformName + '链接，开始解析'
    if (shouldSendTip(e, tip)) await recallPrevious(e, tip)
  }
}

/** 兼容：某些地方可能还需要 markdown 段 */
export const parseTipSegment = () => segment