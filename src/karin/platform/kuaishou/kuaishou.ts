import type { KuaishouVideoWorkResponse } from '@ikenxuan/amagi'
import { logger, type Message } from 'node-karin'

import { Base, downloadVideoFile, extractTotalBytesFromHeaders, Networks, Render, uploadFile } from '@/module'
import { ParseSteps, SendTasks } from '@/module/utils/ParseSteps'
// sendParseTip 单独导入：它在一个无依赖的叶子模块里，避免和平台模块形成循环 import
import { sendParseTip } from '@/module/utils/parseTip'
import type { ParseWorkType } from '@/module/db'
import { cardImageActions, kuaishouShareUrl, sendCopyJumpMessage } from '@/module/utils/QqPanel'
import { cardImageKeyOf, imageSourcesOf, rememberCardImages, rememberLastCardKey } from '@/module/utils/CardImageCache'
import { sendSlicedImage } from '@/module/utils/ImageSlice'
import { Config } from '@/module/utils/Config'
// 注意用相对写法：@/ 别名在仓库里指向 karin/，@/player 会被解析成不存在的 karin/player
import { applyForceOnlinePlayer } from '../../../player'
import { kuaishouComments, type KuaishouDataResult, type KuaishouOneWorkPayload } from '@/platform/kuaishou'
import type { ExtendedKuaishouOptionsType, KuaishouDataTypes } from '@/types'

/**
 * 从作品详情里挑一条视频直链。
 *
 * PC GraphQL 那条有现成的 `photo.photoUrl`，H5 `photo/info` **没有这个字段**，
 * 只能按 amagi 类型里写明的分发规则自己挑：优先 `manifest.adaptationSet` 的档位
 * （`defaultSelect` 是平台自己标的默认清晰度），没有 `manifest` 再回落到单档的
 * `mainMvUrls`。
 *
 * 图集 / 单图作品这两处都是空的（原图在 `atlas` / `single`，本插件目前只解析视频），
 * 所以取不到时返回空串，交给调用方走原有的「不支持解析」分支，而不是拿空串去发请求。
 * @param work - `fetchVideoWork` 的响应体
 * @returns 视频直链；取不到时为空串
 */
const pickVideoUrl = (work: KuaishouVideoWorkResponse): string => {
  const representations = work.photo?.manifest?.adaptationSet?.flatMap((set) => set.representation ?? []) ?? []
  const preferred = representations.find((item) => item.defaultSelect) ?? representations[0]
  return preferred?.url ?? work.photo?.mainMvUrls?.[0]?.url ?? ''
}

/**
 * 快手评论里**用户自己贴的图**（评论区那种表情包 / 图片附件）。
 *
 * 位置是 `rootComments[i].attachments[] → content.smallUrl[]`（多 CDN 列表，取第一条；
 * 见 amagi 的 `KsAttachmentRaw`）。这类附件**实测出现率不高**（约 500 条评论里 7 个），
 * 所以所有字段都按可选处理，另外几种见过的回退形状（单数 `attachment`、
 * `pictures`、模板里的 `commentimage`）也一并兜住，扫不到就是空数组。
 * @param rootComments 评论响应里的 `rootComments`
 * @returns 图片原始地址（去重）
 */
const kuaishouCommentPics = (rootComments: any): string[] => {
  const urls: string[] = []
  const push = (value: any) => {
    if (typeof value === 'string' && value) urls.push(value)
  }
  for (const comment of Array.isArray(rootComments) ? rootComments : []) {
    const attachments = [comment?.attachment, ...(Array.isArray(comment?.attachments) ? comment.attachments : [])]
    for (const attachment of attachments) {
      if (!attachment) continue
      const smallUrls = attachment?.content?.smallUrl ?? attachment?.smallUrls
      if (Array.isArray(smallUrls)) {
        for (const item of smallUrls) push(typeof item === 'string' ? item : item?.url)
      }
      push(attachment?.content?.url)
      push(attachment?.url)
    }
    push(comment?.commentimage)
    const pictures = comment?.pictures ?? comment?.imageUrls
    if (Array.isArray(pictures)) {
      for (const picture of pictures) {
        push(typeof picture === 'string' ? picture : (picture?.url ?? picture?.url_default))
      }
    }
  }
  return [...new Set(urls)]
}

export class Kuaishou extends Base {
  e: Message
  type: KuaishouDataTypes[keyof KuaishouDataTypes]
  /**
   * 本次解析的内容形态，供统计埋点读取。
   * 本插件只解析视频，图集/单图会在下面提前返回，那时保持 undefined。
   */
  workType?: ParseWorkType
  /** ID 解析结果：里面的 photoId 用来兜底拼作品页链接 */
  private readonly iddata: ExtendedKuaishouOptionsType
  /**
   * **用户消息里原样提取出来的链接**（`v.kuaishou.com/xxx` 这类 App 分享短链）。
   * 「复制后打开快手自动跳转」优先用这条 —— 它是快手 App 自己生成的，识别率最高；
   * 我们拼的长链接（哪怕只是 `short-video/<photoId>`）App 未必认。
   */
  private readonly originUrl: string
  constructor(e: Message, iddata: ExtendedKuaishouOptionsType, originUrl = '') {
    super(e)
    this.e = e
    this.type = iddata?.type
    this.iddata = iddata
    this.originUrl = String(originUrl ?? '')
  }

  async KuaishouHandler(data: KuaishouDataResult) {
    // 入参是 fetchKuaishouData 的联合返回，本插件只解析视频，先收窄到 one_work 那一支：
    // H5 换形状后所有取值都得靠 tsc 检查，不能再裸读 any
    const payload = data as KuaishouOneWorkPayload
    /**
     * 快手 H5 的响应多包了一层 `data`：`{ data: { result, photo, … } }`。
     * 直接读 `work.result` / `work.photo` 会全是 undefined，于是每个链接都被判成「不支持解析的视频」
     * （诊断日志：顶层键=["data"]、photo键=[] ✓）。这里统一拆一层，两种形状都兼容。
     */
    const rawWork: any = payload.VideoData
    const work: any =
      rawWork?.data?.visionVideoDetail ??
      rawWork?.visionVideoDetail ??
      (rawWork?.data && typeof rawWork.data === 'object' && !rawWork.photo ? rawWork.data : rawWork)

    // H5 这条响应没有 `data.visionVideoDetail.status`（那是 PC GraphQL 的字段），
    // 顶层 `result` 才是接口状态位（1 = 成功）；再加一道「拿不到视频直链」，
    // 图集 / 单图落到这里也能给出原来那句提示而不是报错
    const video_url = pickVideoUrl(work)
    /**
     * 成功与否**以能否取到视频直链为准**：
     * H5 那版响应里状态字段叫 `status`，没有 `result`（PC GraphQL 才有）；
     * 死抠 `work.result !== 1` 会把所有能解析的作品都判成「不支持解析的视频」。
     * 只有状态位明确是失败（非 1）时才提前返回。
     */
    const statusOk = work?.result === undefined && work?.status === undefined
      ? true
      : (work?.result === 1 || work?.status === 1 || work?.status === true || work?.status === 'ok')
    if (!video_url && !statusOk) {
      await this.e.reply('接口没有返回视频直链，稍后再试试')
      return true
    }
    /**
     * **风控/验证码要单独说清楚**：快手有时直接返回带 `captcha` 的响应而不是作品数据
     * （本次诊断日志里就能看到 顶层键=["visionVideoDetail","captcha"]）。
     * 这种情况拿去当「不支持解析的视频」会让人以为链接有问题，其实等一会儿/换网络就好。
     */
    if (work?.captcha !== undefined || rawWork?.captcha !== undefined) {
      logger.warn('[快手] 接口返回了验证码（风控），本次无法解析')
      await this.e.reply('快手这次返回了验证码（风控拦截），过一会儿或换个网络再试试 ~')
      return true
    }
    if (!video_url) {
      // 诊断：把真实响应形状打出来，便于判断是「接口没给直链」还是「状态位字段变了」
      const reps = work?.photo?.manifest?.adaptationSet?.flatMap((set: any) => set.representation ?? []) ?? []
      logger.mark(
        '[快手] 判为不支持解析 → result=' + String(work?.result) +
        ' 顶层键=' + JSON.stringify(Object.keys(work ?? {}).slice(0, 12)) +
        ' photo键=' + JSON.stringify(Object.keys(work?.photo ?? {}).slice(0, 14)) +
        ' 码流数=' + reps.length +
        ' mainMvUrls=' + (work?.photo?.mainMvUrls?.length ?? 0)
      )
      await this.e.reply('不支持解析的视频')
      return true
    }
    this.workType = 'video'
    /**
     * 卡片右下角二维码与「复制后打开快手自动跳转」共用**同一条作品页链接**。
     *
     * 原来这里给模板的是 `video_url`（CDN 视频直链），扫出来是一段播放地址、
     * 不是作品页；快手 App 认的是自家域名下的链接，所以统一改成 `short-video/<photoId>`。
     */
    const photoId = String(work?.photo?.id ?? this.iddata?.photoId ?? '')
    /**
     * 取不到 photoId 时**不能给空串**：模板拿不到二维码内容会整张卡渲染不出来，
     * 那种情况下退回 CDN 直链（原来的行为），至少卡片照常出、只是二维码还是播放地址。
     * 「复制跳转」不受影响——它用自己的那份 shareUrl，取不到就不发。
     */
    const shareUrl = photoId ? kuaishouShareUrl(photoId) : ''
    const cardShareUrl = shareUrl || video_url
    /**
     * **卡片图下面那两个「提取」按钮的作品键**（`kuaishou:<photoId>`）。
     *
     * 快手这条链路**只有评论区一张卡**（没有单独的封面卡，工作信息本身就画在评论卡顶部），
     * 所以封面与评论区两个按钮都挂在它下面（见下面的 sends.add('渲染评论区')）。
     */
    const cardKey = cardImageKeyOf('kuaishou', photoId)
    /** 封面：`photo.coverUrls` 是 `[{ cdn, url }]`，取第一张原图 */
    rememberCardImages(cardKey, { cover: String(work?.photo?.coverUrls?.[0]?.url ?? '') })
    rememberLastCardKey(this.e, cardKey)
    /** 本次解析的步骤容器：单步失败只跳过、不中断，最后统一渲染一张错误卡片（见 ParseSteps） */
    const steps = new ParseSteps()
    /** 发送任务组：评论区与视频各走一条线，谁先就绪谁先发 */
    /** 强制在线播放名单里的平台：本次一律走在线播放（见 player/index.ts） */
    // 适配器在「强制在线播放的适配器」名单里（例如 B站私聊机器人 platform === 'bilibili'）
    applyForceOnlinePlayer(this.e)
    const sends = new SendTasks(steps)
    await sendParseTip(this.e, '快手')
    // 表情接口没换，还是 graphql 那条，`data.visionBaseEmoticons` 两层照旧
    const transformedData = Object.entries(payload.EmojiData.data.visionBaseEmoticons.iconUrls).map(([name, path]) => {
      return { name, url: `https:${path}` }
    })
    /**
     * 后台下载：**不再阻塞卡片**（用户要求：一边下载一边渲染，卡片先出来）。
     *
     * 以前这里是 `await`，评论区卡片得等视频下完才开始渲染；现在只登记任务，
     * 卡片照常渲、渲完就发，下载结果在发送之前才取（见下面的 await downloadTask）。
     */
    const downloadTask = steps.run('下载视频', () =>
      downloadVideoFile(this.e, {
        video_url,
        title: {
          timestampTitle: `tmp_${Date.now()}.mp4`,
          originTitle: `${work.photo.caption}.mp4`
        }
      })
    )

    sends.add('渲染评论区', async () => {
    const CommentsData = await kuaishouComments(payload.CommentsData, transformedData)
    const fileHeaders = await new Networks({ url: video_url, headers: this.headers }).getHeaders()
    const fileSizeContent = extractTotalBytesFromHeaders(fileHeaders)
    const fileSizeInMB = (fileSizeContent / (1024 * 1024)).toFixed(2)
    const img = await Render(this.e, 'kuaishou/comment', {
      Type: '视频',
      // 这两个计数在 GraphQL 那条是字符串，H5 直接给数字，正好对上模板声明的 number
      viewCount: work.photo.viewCount,
      CommentsData,
      CommentLength: CommentsData?.length ?? 0,
      share_url: cardShareUrl,
      VideoSize: fileSizeInMB,
      likeCount: work.photo.likeCount,
      AuthorAvatar: work.photo.headUrl
    })
    /**
     * 记下评论区那张长图（兜底用）与评论里用户贴的图（`commentPics`，按钮真正要发的）。
     *
     * 快手评论里的图片附件在 `attachments[].content.smallUrl`（见 {@link kuaishouCommentPics}），
     * 出现率不高；扫不到时 `commentPics` 是空数组，按钮点下去退回这张评论长图，不会报错。
     */
    rememberCardImages(cardKey, {
      comment: imageSourcesOf(img),
      commentPics: kuaishouCommentPics(payload?.CommentsData?.rootComments)
    })
    /**
     * 评论区这张卡是快手**唯一**的一张卡：封面与评论区两个按钮都挂它下面，同一条消息。
     */
    await sendSlicedImage(this.e, img, cardImageActions(this.e, { cover: true, comment: true, key: cardKey }))
    })

    /**
     * **视频单独一条线**：下载一好就发，不等评论区渲染
     * （用户要求：「所有东西的发送不需要等待全部完成」）。
     */
    sends.add('发送视频', async () => {
      const downloadedVideo = (await downloadTask) ?? null
      if (!downloadedVideo) {
        logger.warn('[快手] 视频没有下载成功，跳过发送')
        return
      }
      await uploadFile(this.e, downloadedVideo, video_url, { message_id: this.e.messageId })
    })

    await sends.settle()
    /**
     * 「打开原站」**单独发一条**：快手没有清晰度面板（那套面板只有 B站 / 抖音有，
     * 它们的跳转块挂在画质表格下面），所以这里在所有内容发完之后补一条同格式的消息。
     * 发不出去也不影响解析（详情见 sendCopyJumpMessage）。
     */
    await sendCopyJumpMessage(this.e, '快手', this.originUrl || shareUrl)
    steps.throwIfFailed()
    return true
  }
}
