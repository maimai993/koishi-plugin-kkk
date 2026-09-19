/**
 * 解析开始时的提示语。
 *
 * **为什么要单独一个文件**：这个函数原来放在 QqPanel 里，而 QqPanel 又依赖平台模块；
 * 平台模块反过来调用 sendParseTip → 形成循环 import，打包后函数绑定还没初始化，
 * 调用时直接报 `(0 , module_1.sendParseTip) is not a function`（快手整个解析挂掉就是这个原因）。
 * 这里只依赖 Config / ParseOverride / 基础段，彻底断开环。
 */
import { segment, type Message } from 'node-karin'

import { getParseOverride } from './ParseOverride'

/** 阶段登记用的固定 key（同一时间只可能有一个解析在跑） */
const STAGE_KEY = 'parse'
import { Config } from './Config'

/** 撤回上一条机器人消息（拿不到就忽略） */
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
  await e.reply(content)
}

/**
 * 解析开始时的提示语 —— 两种来源说两句话：
 *   - **面板按钮点出来的**：画质面板刚发过，这里只回「收到请求，开始下载」
 *   - 手工发链接的：仍然是「检测到 XX 链接，开始解析」
 */
export const sendParseTip = async (e: Message, platformName: string): Promise<void> => {
  /**
   * 登记一个「正在获取下载链接」的阶段。
   * 用户在「收到请求，开始下载」刚出现时点「查询下载进度」，这时还没开始传字节，
   * 以前只会显示「当前没有正在进行的下载」，很误导 —— 现在能看到真实阶段。
   * 真正开始下载时 Downloader 会清掉这个阶段条目。
   */
  try {
    const { reportDownloadStage } = await import('./Network/Downloader')
    reportDownloadStage(STAGE_KEY, platformName + '解析', '正在获取下载链接')
  } catch { /* 观测失败不影响解析 */ }

  const fromPanel = getParseOverride()?.fromPanel === true
  if (fromPanel) {
    await recallPrevious(e, '收到请求，开始下载')
    return
  }
  if (Config.app.parseTip) {
    await recallPrevious(e, '检测到' + platformName + '链接，开始解析')
  }
}

/** 兼容：某些地方可能还需要 markdown 段 */
export const parseTipSegment = () => segment