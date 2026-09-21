/**
 * 「解析结果合并转发」——把**一次解析产生的所有内容**合并成一条转发消息发出去。
 *
 * ## 需求（用户要求）
 *   - 解析产生的所有信息都要合并转发（**支持的平台**才有这个概念：QQ 官方适配器没有合并转发能力）；
 *   - **转发里不包含过程提示**（「检测到链接，开始解析」「收到请求，开始下载」「加载中…」「发送中…」这些）；
 *   - 转发的展示身份沿用 `app.fakeForward`：开着用触发者身份，关着用机器人身份。
 *
 * ## 怎么做到的
 * 兼容层的发送漏斗（Message.reply / karin.sendMsg / bot.uploadFile / sendForwardMsg）会把
 * **发往本次解析频道**的内容收进缓冲区（见 compat/forward-collect），这里负责：
 *   1. `withParseForward()` 把平台 handler 包一层：支持转发的平台才开收集，
 *      解析结束（含错误卡片）后在 `finally` 里冲刷；
 *   2. `flushParseForward()` 把攒下来的元素交给 compat 的 `sendForwardMsg` 发出去
 *      （发送本身用 `withoutForwardCollect` 包住，避免自己吞自己）；
 *   3. 过程提示由各自的发送点用 `withoutForwardCollect()` 标记（QqPanel / Base）。
 *
 * 不支持合并转发的平台（QQ 官方适配器）**完全不收集**，保持原来的「一边解析一边逐条发」，
 * 行为与以前一模一样。
 */
import { drainForward, isForwardSupported, logger, makeForward, runWithForwardBag, withoutForwardCollect, type Message } from 'node-karin'

import { Config } from './Config'

/** 本次消息要发到哪个频道（合并转发的目标） */
export function parseForwardPeer (e: any): string {
  return String(e?.contact?.peer ?? e?.channelId ?? '')
}

/** 取适配器平台名：兼容层的 bot 把真实 Bot 放在 .bot 上 */
function platformOf (e: any): string {
  return String(e?.bot?.bot?.platform ?? e?.bot?.platform ?? '')
}

/** 这台部署的适配器支不支持合并转发 */
export function canForwardParseResult (e: any): boolean {
  return isForwardSupported({ platform: platformOf(e) })
}

/**
 * 把攒下来的解析结果发成一条转发。
 *
 * 没攒到东西就什么都不做（例如这条消息其实没解析成功、或者已经在不支持的平台上）。
 */
export async function flushParseForward (e: Message): Promise<void> {
  const elements = drainForward()
  if (!elements.length) return
  const fake = Config.app?.fakeForward === true
  const bot: any = (e as any)?.bot
  const sender: any = (e as any)?.sender ?? {}
  const botId = fake ? String(sender.userId ?? '') : String(bot?.account?.selfId ?? (e as any)?.selfId ?? '')
  const botName = fake ? String(sender.nick ?? sender.card ?? sender.name ?? '') : String(bot?.account?.name ?? '')
  logger.info('[合并转发] 本次解析产生 ' + elements.length + ' 条内容，合并成一条转发发出（身份：'
    + (fake ? '触发者 ' + (botName || botId || '（未知）') : '机器人 ' + (botName || botId || '（未知）')) + '）')
  /**
   * 发送这一步必须**跳过收集**：不然 sendForwardMsg 自己会又被收进缓冲区，
   * 冲刷时再次触发，来回死循环。
   */
  await withoutForwardCollect(() => bot.sendForwardMsg(parseForwardPeer(e) || e.contact, makeForward(elements, botId || undefined, botName || undefined), {
    source: '解析结果',
    summary: '查看解析结果',
    prompt: '解析结果',
    news: [{ text: '点击查看解析结果' }]
  }))
}

/**
 * 把一个平台 handler 包成「解析结果合并转发」模式。
 *
 *   - 适配器支持合并转发 → 解析期间产生的所有内容（卡片 / 图片 / 视频 / 评论…）先攒着，
 *     handler 跑完（**包括错误卡片**）后合并成一条转发发出；
 *   - 不支持（QQ 官方适配器）→ 原样执行，什么都不收集。
 */
export function withParseForward<F extends (e: any, next?: any) => any> (handler: F): F {
  const wrapped = async (e: any, next?: any): Promise<any> => {
    if (!parseForwardPeer(e) || !canForwardParseResult(e)) return await handler(e, next)
    return await runWithForwardBag(parseForwardPeer(e), async () => {
      try {
        return await handler(e, next)
      } finally {
        try {
          await flushParseForward(e)
        } catch (error: any) {
          logger.warn('[合并转发] 发送转发失败（内容已经按原样发过或已丢失）: ' + String(error?.message ?? error))
        }
      }
    })
  }
  return wrapped as F
}
