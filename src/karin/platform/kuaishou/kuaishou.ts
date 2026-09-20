import type { KuaishouVideoWorkResponse } from '@ikenxuan/amagi'
import { logger, type Message } from 'node-karin'

import { Base, downloadVideoFile, extractTotalBytesFromHeaders, Networks, Render, uploadFile } from '@/module'
import { ParseSteps } from '@/module/utils/ParseSteps'
// sendParseTip 单独导入：它在一个无依赖的叶子模块里，避免和平台模块形成循环 import
import { sendParseTip } from '@/module/utils/parseTip'
import type { ParseWorkType } from '@/module/db'
import { Config } from '@/module/utils/Config'
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

export class Kuaishou extends Base {
  e: Message
  type: KuaishouDataTypes[keyof KuaishouDataTypes]
  /**
   * 本次解析的内容形态，供统计埋点读取。
   * 本插件只解析视频，图集/单图会在下面提前返回，那时保持 undefined。
   */
  workType?: ParseWorkType
  constructor(e: Message, iddata: ExtendedKuaishouOptionsType) {
    super(e)
    this.e = e
    this.type = iddata?.type
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
    /** 本次解析的步骤容器：单步失败只跳过、不中断，最后统一渲染一张错误卡片（见 ParseSteps） */
    const steps = new ParseSteps()
    await sendParseTip(this.e, '快手')
    // 表情接口没换，还是 graphql 那条，`data.visionBaseEmoticons` 两层照旧
    const transformedData = Object.entries(payload.EmojiData.data.visionBaseEmoticons.iconUrls).map(([name, path]) => {
      return { name, url: `https:${path}` }
    })
    /**
     * **先把视频下下来，再渲染卡片**（用户要求，和抖音/B站/小红书同一套顺序）。
     * 下载最慢也最不能失败，放前面；卡片渲染失败不影响视频，最后统一报错。
     */
    const downloadedVideo = (await steps.run('下载视频', () =>
      downloadVideoFile(this.e, {
        video_url,
        title: {
          timestampTitle: `tmp_${Date.now()}.mp4`,
          originTitle: `${work.photo.caption}.mp4`
        }
      })
    )) ?? null

    await steps.run('渲染评论区', async () => {
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
      share_url: video_url,
      VideoSize: fileSizeInMB,
      likeCount: work.photo.likeCount
    })
    await this.e.reply(img)
    })

    if (downloadedVideo) {
      await steps.run('发送视频', () => uploadFile(this.e, downloadedVideo, video_url, { message_id: this.e.messageId }))
    } else {
      logger.warn('[快手] 视频没有下载成功，跳过发送')
    }

    steps.throwIfFailed()
    return true
  }
}
