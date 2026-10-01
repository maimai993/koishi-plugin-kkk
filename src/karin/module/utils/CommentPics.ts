/**
 * 评论区里**用户自己贴的图** —— 「直接发出去」这一半。
 *
 * ## 为什么单独一个文件
 * 三个地方要用同一套逻辑（B站视频评论区 / B站动态评论区 / 抖音评论区），
 * 而「发了没发」这个结果还会**反过来决定卡片下面挂不挂「提取评论区图片」按钮**：
 *   - 配置 `commentImageCollection` 打开 → 这里**直接发**，按钮就**不挂**了（图已经在群里了）；
 *   - 配置关着 / 发失败 → 不直接发，按钮**照挂**（点一下单独发一遍）。
 * 复制三份的话，漏改一处就会出现「发了图还挂按钮」或者「没发图也没按钮」这种半截状态。
 *
 * ## 发送形式：优先合并成一条 markdown，退回合并转发
 * 配置文案写的是「以合并转发的形式返回」，但**官方 QQ bot 上合并转发经常发不出去**
 * （会退化成一张图一条消息，比转发还吵）。md 里连续图片是紧贴渲染的，
 * 一条消息就能装完整套图，所以**优先走 md**，md 不可用（非 markdown 适配器）时才退回 `makeForward`。
 *
 * ## 图片地址要先落地
 * `commentPics` 存的是接口给的**原始地址**，直接塞进 markdown 会踩外链防盗链 / 过期，
 * 所以统一过一遍 {@link processImageUrl}（按 `imageSendMode` 决定下载成本地还是保持 url）。
 */
import { common, logger, segment } from 'node-karin'

import { Config } from './Config'
import { processImageUrl } from './ImageHelper'
import { platformOf } from './ImageSlice'
import { buildMarkdownImageMessage } from './QqPanel'

/**
 * 把评论区的图**直接发出去**（一条消息装完整套图）。
 *
 * 调用方拿返回值决定要不要再挂「提取评论区图片」按钮：
 * **真的发出去了才返回 true** —— 一张图都没发出去（没图 / 下载全失败 / 发送报错）时返回 false，
 * 这时按钮还得留着，让用户有条后路。
 * @param e 消息事件
 * @param pics 评论里用户贴的图（原始地址，见 `CardImageCache` 的 `commentPics`）
 * @param options `title` 用于本地落地时的文件名；`prompt` 是退回合并转发时的标题
 * @returns 是否已经把图发出去
 */
export async function sendCommentPicsDirectly (
  e: any,
  pics: string[],
  options: { title?: string, prompt?: string } = {}
): Promise<boolean> {
  const list = (pics ?? []).filter(Boolean).map(String)
  /** 评论区一条图都没有：没什么可发的，也别记「发过了」 */
  if (!list.length) return false

  const elements: any[] = []
  for (const [index, url] of list.entries()) {
    const src = await processImageUrl(url, options.title, index)
    if (src) elements.push(segment.image(src))
  }
  /** 全都没落地成功（地址失效 / 下载失败）：当作没发，按钮照挂 */
  if (!elements.length) return false

  try {
    const md = await buildMarkdownImageMessage(
      elements.map((item: any) => String(item?.attrs?.src ?? '')).filter(Boolean),
      420,
      platformOf(e)
    )
    if (md) {
      await e.reply(md)
      return true
    }
    const res = common.makeForward(
      elements,
      Config.app.fakeForward ? e.sender.userId : e.bot.account.selfId,
      Config.app.fakeForward ? e.sender.nick : e.bot.account.name
    )
    await e.bot.sendForwardMsg(e.contact, res, {
      source: '评论图片收集',
      summary: `查看${elements.length}张图片`,
      prompt: options.prompt ?? '评论解析结果',
      news: [{ text: '点击查看解析结果' }]
    })
    return true
  } catch (error: any) {
    /**
     * 发送失败**不能把解析拖挂**（这条线在 `sends` 里，抛出去会让「发送视频」那条线继续，
     * 但日志里会多一条失败）。这里只记一条 warn，返回 false 让调用方把按钮挂上。
     */
    logger.warn('[评论图片] 直接发送失败，改为保留「提取评论区图片」按钮：' + String(error?.message ?? error))
    return false
  }
}
