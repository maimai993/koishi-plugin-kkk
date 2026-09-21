/**
 * 「解析结果合并转发」——把**一次解析产生的所有内容**合并成一条转发消息发出去。
 *
 * ## 需求（用户要求）
 *   - **合并转发开关打开时**（通用 →「解析结果合并转发」，也就是 `app.fakeForward`）：
 *     一次解析产生的所有信息合并成一条转发发出（**支持的平台**才有这个概念：
 *     QQ 官方适配器没有合并转发能力），转发用**触发者**身份展示；
 *   - **开关关掉就不合并**：内容照旧一条一条发（用户实测反馈：
 *     「关闭合并转发 还是合并的」—— 关掉就该回到逐条发送）；
 *   - **转发里不包含过程提示**（「检测到链接，开始解析」「收到请求，开始下载」「加载中…」「发送中…」这些）。
 *
 * ## 怎么做到的
 * 兼容层的发送漏斗（Message.reply / karin.sendMsg / bot.uploadFile / sendForwardMsg）会把
 * **发往本次解析频道**的内容收进缓冲区（见 compat/forward-collect），这里负责：
 *   1. `withParseForward()` 把平台 handler 包一层：**开关打开**且适配器支持合并转发时才开收集，
 *      解析结束（含错误卡片）后在 `finally` 里冲刷；
 *   2. `flushParseForward()` 把攒下来的元素交给 compat 的 `sendForwardMsg` 发出去
 *      （发送本身用 `withoutForwardCollect` 包住，避免自己吞自己）；
 *   3. 过程提示由各自的发送点用 `withoutForwardCollect()` 标记（QqPanel / Base）。
 *
 * 开关关掉、或者平台不支持合并转发（QQ 官方适配器）时**完全不收集**，
 * 保持原来的「一边解析一边逐条发」，行为与以前一模一样。
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
 * 「解析结果合并转发」开关是否打开（通用里的 `app.fakeForward`，**默认开**）。
 *
 * 关掉之后**不合并**：解析内容照旧一条一条发（用户实测反馈：「关闭合并转发 还是合并的」，
 * 关掉就该回到逐条发送）。缺省即开，老配置里没有这个键时行为与以前一致。
 */
export function isParseForwardEnabled (): boolean {
  try {
    return (Config.app as any)?.fakeForward !== false
  } catch {
    return true
  }
}

/**
 * 把攒下来的解析结果发成一条转发。
 *
 * 没攒到东西就什么都不做（例如这条消息其实没解析成功、或者已经在不支持的平台上）。
 */
export async function flushParseForward (e: Message): Promise<void> {
  const elements = drainForward()
  if (!elements.length) return
  const bot: any = (e as any)?.bot
  const sender: any = (e as any)?.sender ?? {}
  /**
   * 走进来就说明「合并转发」开关是开着的，转发按**触发者**身份展示
   * （以前这里还分「开关关着用机器人身份」，但开关现在同时管「要不要合并」，
   * 关掉根本不会有这条转发，那个分支已经是死代码了）。
   */
  const botId = String(sender.userId ?? '')
  const botName = String(sender.nick ?? sender.card ?? sender.name ?? '')
  logger.info('[合并转发] 本次解析产生 ' + elements.length + ' 条内容，合并成一条转发发出（身份：触发者 '
    + (botName || botId || '（未知）') + '）')
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
 *   - **开关开着 + 适配器支持合并转发** → 解析期间产生的所有内容（卡片 / 图片 / 视频 / 评论…）先攒着，
 *     handler 跑完（**包括错误卡片**）后合并成一条转发发出；
 *   - **开关关掉**（通用 →「解析结果合并转发」）→ 原样执行，什么都不收集，内容一条一条发；
 *   - 不支持合并转发的平台（QQ 官方适配器）→ 同样原样执行。
 */
export function withParseForward<F extends (e: any, next?: any) => any> (handler: F): F {
  const wrapped = async (e: any, next?: any): Promise<any> => {
    if (!isParseForwardEnabled()) {
      logger.debug('[合并转发] 「解析结果合并转发」关着，本次按逐条发送处理')
      return await handler(e, next)
    }
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
