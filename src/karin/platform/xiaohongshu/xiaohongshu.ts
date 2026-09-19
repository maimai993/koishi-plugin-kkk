import fs from 'node:fs'
import { buildMarkdownImageMessage, sendParseTip } from '@/module/utils/QqPanel'

import type { NoteComments, XiaohongshuEmojiListResponse } from '@ikenxuan/amagi'
import type { RichTextEmojiDefinition } from '@kkk/richtext'
import { format } from 'date-fns'
import { common, type Elements, type Message, segment } from 'node-karin'
import { logger } from 'node-karin'

import {
  Base,
  baseHeaders,
  buildGoogleMotionPhoto,
  Common,
  downloadFile,
  type downLoadFileOptions,
  downloadVideo,
  type LiveImageMergeOptions,
  loopVideoWithTransition,
  processLocalImageFile,
  processImageUrl,
  Render
} from '@/module'
import type { ParseWorkType } from '@/module/db'
import { Config } from '@/module/utils/Config'

import { buildXiaohongshuRichText, xiaohongshuComments } from './comments'
import { XiaohongshuIdData } from './getID'

// 定义小红书视频流类型
export type XhsVideoStream = {
  height: number
  width: number
  size: number
  video_bitrate: number
  audio_bitrate: number
  fps: number
  master_url: string
  backup_urls: string[]
  video_codec: string
  audio_codec: string
  format: string
  quality_type: string
  stream_desc: string
  duration: number
  avg_bitrate: number
}

export class Xiaohongshu extends Base {
  e: Message
  type: XiaohongshuIdData['type']
  /**
   * 本次解析的内容形态，供统计埋点读取。
   * 笔记详情拿到之前无法判定，所以留到 `XiaohongshuHandler` 里赋值。
   */
  workType?: ParseWorkType

  constructor(e: Message, iddata: XiaohongshuIdData) {
    super(e)
    this.e = e
    this.type = iddata?.type
  }

  /**
   * 取够配置条数的笔记评论。
   *
   * v7 的 `noteComments` 端点自带声明式翻页：只传目标条数 `number`，游标由管线
   * 携带、跨页条目由端点的 `normalize` 回填到最后一页原位 —— 所以这里不再手写
   * cursor 循环（v6 时代那 30 行）。
   *
   * 这条端点在 amagi 那边还没有生成响应类型（声明回退 `any`），形状仍按手写快照树的
   * `NoteComments` 断言；等它补上样本、生成类型之后换成生成的那份。
   * @param data - 笔记 id 与 xsec_token
   * @returns 响应体（fetcher 失败即抛），`data.comments` 已是合并后的全部评论
   */
  private async fetchConfiguredNoteComments(data: XiaohongshuIdData): Promise<NoteComments> {
    return (
      await this.amagi.xiaohongshu.fetcher.fetchNoteComments({
        note_id: data.note_id,
        xsec_token: data.xsec_token,
        number: Math.max(1, Config.xiaohongshu.numcomment)
      })
    ).data
  }

  async XiaohongshuHandler(data: XiaohongshuIdData) {
    // 诊断：把入参和每一步的结果打出来，定位「只提示不解析」卡在哪
    logger.mark('[小红书] 开始解析: note_id=' + String(data?.note_id ?? '（空）') + ' xsec_token=' + (data?.xsec_token ? '有' : '（空）') + ' type=' + String(this.type))
    if (Config.amagi.cookies.xiaohongshu === '') {
      throw new Error('我还没有小红书的 Cookies，暂时无法解析呢 ~')
    }
    await sendParseTip(this.e, '小红书')
    let NoteData: any
    try {
      NoteData = await this.amagi.xiaohongshu.fetcher.fetchNoteDetail({
        note_id: data.note_id,
        xsec_token: data.xsec_token
      })
    } catch (error: any) {
      logger.error('[小红书] 拉取笔记详情失败: ' + String(error?.message ?? error))
      throw error
    }
    const noteItems = NoteData?.data?.data?.items
    logger.mark('[小红书] 笔记详情返回: items=' + (Array.isArray(noteItems) ? noteItems.length : '（不是数组 ✗）'))
    /**
     * **卡片数据的取值要容错**：实测 items[0].note_card 经常取不到
     * （接口层级与我们预期的不一致），一取不到就在这行抛 TypeError，
     * 后面的卡片渲染完全轮不到 —— 用户看到的就是「提示解析中，然后没反应」。
     * 这里把可能的两层都兜住，并把真实键名打出来（下次即可精确修改）。
     */
    const rawItem: any = Array.isArray(noteItems) ? noteItems[0] : undefined
    const noteCard: any = rawItem?.note_card ?? rawItem?.noteCard ?? rawItem
    logger.mark('[小红书] 条目键名: ' + JSON.stringify(Object.keys(rawItem ?? {}).slice(0, 12)) +
      ' / note_card 键名: ' + JSON.stringify(Object.keys(rawItem?.note_card ?? {}).slice(0, 16)))
    if (!noteCard) {
      logger.warn('[小红书] 拿不到笔记内容，无法渲染卡片')
      return
    }
    logger.mark('[小红书] 准备判定内容形态…')
    // 统计用的内容形态：有视频流算视频笔记，否则算图文（与 noteInfo/comment 模板里的判定一致）
    this.workType = noteCard.video ? 'video' : 'gallery'
    logger.mark('[小红书] 内容形态=' + this.workType + '，接下来拉表情列表')
    /**
     * 表情列表**失败不能让整条解析中断** ——
     * 实测这个接口经常报错，而它在卡片渲染之前，一抛异常就变成
     * 「详情明明拿到了，卡片却一张都不发」（用户看到的就是「提示解析中然后没反应」）。
     * 拿不到就用空表情表继续，卡片照样渲染，只是表情不做转换。
     */
    /**
     * 表情表先用**空的**，卡片立刻渲染 —— 这是关键。
     *
     * 实测 `fetchEmojiList()` 会把整个流程卡死（既不返回也不报错，连 Promise.race
     * 的超时都触发不了，说明事件循环被它拖住了），而它在卡片渲染**之前**，
     * 结果就是「提示解析中，然后没反应，卡片一张都没有」。
     * 现在把表情拉取挪到卡片发完之后，卡片不受影响，评论区再单独尝试。
     */
    // 注意必须是**数组**：buildXiaohongshuRichText 会直接迭代它（给 {} 会报 emojiData is not iterable）
    let formattedEmojis: any[] = []

    // 笔记信息
    if (Config.xiaohongshu.sendContent.some((item) => item === 'info')) {
      logger.mark('[小红书] 准备渲染详情卡片: title=' + String(noteCard.title ?? '').slice(0, 20) +
        ' 图片数=' + (Array.isArray(noteCard.image_list) ? noteCard.image_list.length : 0))
      let noteInfoImg: any
      try {
        noteInfoImg = await Render(this.e, 'xiaohongshu/noteInfo', {
        title: noteCard.title,
        desc: buildXiaohongshuRichText(noteCard.desc, formattedEmojis, [], {
          stripTopicMarker: true
        }),
        statistics: noteCard.interact_info,
        note_id: noteCard.note_id,
        author: noteCard.user,
        image_url: noteCard.image_list[0].url_default,
        time: noteCard.time,
        ip_location: noteCard.ip_location,
        share_url: `https://www.xiaohongshu.com/discovery/item/${data.note_id}?source=webshare&xhsshare=pc_web&xsec_token=${data.xsec_token}&xsec_source=pc_share`,
        image_list: noteCard.image_list?.map((image) => image.url_default) ?? [],
        is_video: Boolean(noteCard.video)
        })
      } catch (error: any) {
        // 渲染失败要看得见，别又变成「提示解析中然后没反应」
        logger.error('[小红书] 详情卡片渲染失败: ' + String(error?.message ?? error))
        throw error
      }
      logger.mark('[小红书] 详情卡片渲染完成，准备发送')
      await this.e.reply(noteInfoImg)
      logger.mark('[小红书] 详情卡片已发送')
    }

    /**
     * **图文笔记的图片要发出来**（用户要求）。
     *
     * 之前只发了详情卡片，正文里的图片一张都没发 —— 用户看到的就是
     * 「解析出来了图文，但图呢？」。这里和抖音图集一样：合并成**一条 markdown**
     * （图片紧贴渲染，一条消息装完整套图）。
     */
    const noteImages: string[] = (noteCard.image_list ?? [])
      .map((image: any) => String(image?.url_default ?? image?.url ?? ''))
      .filter(Boolean)
    if (!noteCard.video && noteImages.length) {
      try {
        const mdMessage = await buildMarkdownImageMessage(noteImages)
        if (mdMessage) {
          await this.e.reply(mdMessage)
          logger.mark('[小红书] 图文图片已用一条 markdown 发送，共 ' + noteImages.length + ' 张')
        } else {
          // md 生成失败就逐张发，总比一张不发好
          for (const imageUrl of noteImages) await this.e.reply(segment.image(imageUrl))
          logger.mark('[小红书] md 生成失败，图文图片改为逐张发送，共 ' + noteImages.length + ' 张')
        }
      } catch (error: any) {
        logger.warn('[小红书] 发送图文图片失败: ' + String(error?.message ?? error).slice(0, 120))
      }
    }

    /**
     * 卡片发完后再去拉表情表（给评论区做表情转换用）。
     * 这里挂掉/超时都不影响已经发出去的卡片。
     */
    try {
      const EmojiList = await Promise.race([
        this.amagi.xiaohongshu.fetcher.fetchEmojiList(),
        new Promise((resolve) => setTimeout(() => resolve(null), 8000))
      ]) as any
      if (EmojiList) {
        formattedEmojis = XiaohongshuEmoji(EmojiList.data)
        logger.mark('[小红书] 表情表已获取，共 ' + (Array.isArray(formattedEmojis) ? formattedEmojis.length : 0) + ' 条')
      } else {
        logger.warn('[小红书] 表情表超时（8s），评论区将不做表情转换')
      }
    } catch (error: any) {
      logger.warn('[小红书] 表情表拉取失败（不影响卡片）: ' + String(error?.message ?? error).slice(0, 100))
      formattedEmojis = []
    }

    // 评论列表
    if (Config.xiaohongshu.sendContent.some((item) => item === 'comment')) {
      /**
       * 评论同样**非致命**：上游这条链路本来就常报错，
       * 但卡片（上面已经发过）不该因为评论拉不到就整条失败。
       */
      let CommentData: any
      try {
        // 评论同样加超时：上游这条链路本来就常挂，别把整条解析拖死
        CommentData = await Promise.race([
          this.fetchConfiguredNoteComments(data),
          new Promise((resolve) => setTimeout(() => resolve(null), 15000))
        ]) as any
        if (!CommentData) throw new Error('拉取评论超时（15s）')
      } catch (error: any) {
        logger.warn('[小红书] 拉取评论失败（卡片不受影响）: ' + String(error?.message ?? error).slice(0, 120))
        return
      }

      if (!CommentData?.data?.comments || CommentData.data.comments.length === 0) {
        await this.e.reply('这个笔记没有评论 ~')
      } else {
        // 使用简化的评论处理函数，直接返回评论数组
        const processedComments = await xiaohongshuComments(CommentData, formattedEmojis)

        const commentListImg = await Render(this.e, 'xiaohongshu/comment', {
          Type: noteCard.video ? '视频' : '图文',
          CommentsData: processedComments,
          CommentLength: processedComments.length,
          ImageLength: noteCard.image_list?.length || 0,
          share_url: `https://www.xiaohongshu.com/discovery/item/${data.note_id}?source=webshare&xhsshare=pc_web&xsec_token=${data.xsec_token}&xsec_source=pc_share`
        })
        this.e.reply(commentListImg)
      }
    }

    // 图片笔记
    if (!noteCard.video && Config.xiaohongshu.sendContent.includes('image')) {
      const processedImages: Elements[] = []
      const title = noteCard.title
      const temp: Array<{ filepath: string; totalBytes: number }> = []
      let hasGeneratedLivePhoto = false // 标记是否生成了实况图

      // 获取实况图配置
      const livePhotoMode = Config.app.livePhotoMode ?? 'video_and_livephoto'
      const shouldGenerateVideo = livePhotoMode === 'video_and_livephoto' || livePhotoMode === 'video_only'
      const shouldGenerateLivePhoto = livePhotoMode === 'video_and_livephoto' || livePhotoMode === 'livephoto_only'

      // 实况图合并配置
      const loopCount = 3 // 小红书实况图循环3次
      const mergeMode: LiveImageMergeOptions['mergeMode'] = 'continuous'
      let bgmContext: LiveImageMergeOptions['context'] | undefined = undefined

      for (const [index, item] of noteCard.image_list.entries()) {
        // 检查是否为实况图
        if (item.live_photo && item.stream && (shouldGenerateVideo || shouldGenerateLivePhoto)) {
          // 下载静态图片
          const staticImageUrl = item.url_default
          const staticImgTempPath = Common.tempDri.images + `static_${Date.now()}_${index}.jpg`
          const staticImg = await downloadFile(staticImageUrl, {
            title: `static_${Date.now()}_${index}.jpg`,
            filepath: staticImgTempPath,
            headers: {
              ...baseHeaders,
              Referer: 'https://www.xiaohongshu.com',
              Cookie: Config.amagi.cookies.xiaohongshu
            } as downLoadFileOptions['headers']
          })

          let staticImgPath = ''
          if (staticImg.filepath) {
            staticImgPath = staticImg.filepath
          }

          // 获取实况图视频流
          const livePhotoVideo = xiaohongshuGetLivePhotoVideo(item.stream)

          if (livePhotoVideo) {
            // 下载实况图视频
            const livePhotoPath = Common.tempDri.video + `livephoto_${Date.now()}_${index}.mp4`
            const livePhoto = await downloadFile(livePhotoVideo.master_url, {
              title: `livephoto_${Date.now()}_${index}.mp4`,
              filepath: livePhotoPath,
              headers: {
                ...baseHeaders,
                Referer: 'https://www.xiaohongshu.com',
                Cookie: Config.amagi.cookies.xiaohongshu
              }
            })

            if (livePhoto.filepath) {
              // 生成视频（优先）
              if (shouldGenerateVideo) {
                const outputPath = Common.tempDri.video + `xhs_live_${Date.now()}_${index}.mp4`
                const transitionEnabled = loopCount > 1 && Boolean(staticImgPath)
                const safeStaticPath = staticImgPath || livePhoto.filepath

                const result = await loopVideoWithTransition({
                  inputPath: livePhoto.filepath,
                  outputPath,
                  loopCount,
                  staticImagePath: safeStaticPath,
                  transitionEnabled,
                  mergeMode,
                  context: bgmContext ?? undefined
                })

                const success = result.success
                if (mergeMode === 'continuous' && result.context) {
                  bgmContext = result.context
                }

                if (success) {
                  const filePath = Common.tempDri.video + `tmp_${Date.now()}.mp4`
                  fs.renameSync(outputPath, filePath)
                  logger.mark(`小红书实况图视频文件重命名完成: ${outputPath.split('/').pop()} -> ${filePath.split('/').pop()}`)
                  temp.push({ filepath: filePath, totalBytes: 0 })
                  const videoPath =
                    Config.app.videoSendMode === 'base64'
                      ? `base64://${fs.readFileSync(filePath).toString('base64')}`
                      : `file://${filePath}`
                  processedImages.push(segment.video(videoPath))
                }
              }

              // 生成实况图（在视频之后）
              if (shouldGenerateLivePhoto) {
                let hasPushedMotionPhotoCover = false
                if (staticImgPath) {
                  const motionPhotoCoverPath = Common.tempDri.images + `MVIMG_${format(new Date(), 'yyyyMMdd_HHmmss_SSS')}_${index}.jpg`
                  const motionPhotoCreated = await buildGoogleMotionPhoto({
                    imagePath: staticImgPath,
                    videoPath: livePhoto.filepath,
                    outputPath: motionPhotoCoverPath
                  })

                  if (motionPhotoCreated) {
                    temp.push({ filepath: motionPhotoCoverPath, totalBytes: 0 })
                    const motionPhotoCover = processLocalImageFile(motionPhotoCoverPath)
                    processedImages.push(segment.image(motionPhotoCover))
                    hasPushedMotionPhotoCover = true
                    hasGeneratedLivePhoto = true // 标记已生成实况图
                    logger.debug(`小红书实况图生成成功: ${motionPhotoCoverPath}`)
                  }
                }

                // 如果实况图生成失败，使用普通图片
                if (!hasPushedMotionPhotoCover) {
                  const imageUrl = await processImageUrl(item.url_default, title, index)
                  processedImages.push(segment.image(imageUrl))
                }
              }

              // 清理临时视频文件
              logger.mark('正在尝试删除缓存文件')
              await Common.removeFile(livePhoto.filepath, true)
            }
          }

          // 清理临时静态图片文件
          if (staticImgPath) {
            temp.push({ filepath: staticImgPath, totalBytes: 0 })
          }
        } else {
          // 普通图片处理
          const imageUrl = await processImageUrl(item.url_default, title, index)
          processedImages.push(segment.image(imageUrl))
        }
      }

      // 如果生成了实况图，添加提示文字
      if (hasGeneratedLivePhoto) {
        const tipImg = await Render(this.e, 'other/live-photo-tip', {
          title: '实况照片已生成',
          description: '保存原图到相册即可识别为实况图'
        })
        processedImages.push(...tipImg)
      }

      const res = common.makeForward(
        processedImages,
        Config.app.fakeForward ? this.e.sender.userId : this.e.bot.account.selfId,
        Config.app.fakeForward ? this.e.sender.nick : this.e.bot.account.name
      )

      if (processedImages.length === 1) {
        await this.e.reply(processedImages[0])
      } else if (processedImages.length > 1) {
        try {
          await this.e.bot.sendForwardMsg(this.e.contact, res, {
            source: '图片合集',
            summary: `查看${res.length}张图片/视频消息`,
            prompt: '小红书图集解析结果',
            news: [{ text: '点击查看解析结果' }]
          })
        } finally {
          for (const item of temp) {
            await Common.removeFile(item.filepath, true)
          }
        }
      }
    }

    // 视频笔记
    if (noteCard.video && Config.xiaohongshu.sendContent.includes('video')) {
      const video = noteCard.video

      // 使用新的视频选择逻辑
      const selectedVideo = xiaohongshuProcessVideos(
        video.media?.stream,
        Config.xiaohongshu.videoQuality,
        Config.xiaohongshu.maxAutoVideoSize
      )

      if (selectedVideo) {
        await downloadVideo(
          this.e,
          {
            video_url: selectedVideo.master_url,
            title: {
              timestampTitle: `tmp_${Date.now()}.mp4`,
              originTitle: `${selectedVideo.stream_desc}.mp4`
            },
            headers: {
              ...baseHeaders,
              Referer: 'https://www.xiaohongshu.com',
              Cookie: Config.amagi.cookies.xiaohongshu
            }
          },
          {
            message_id: this.e.messageId
          }
        )
      } else {
        // 如果没有找到合适的视频，使用原来的逻辑作为备选
        await this.e.reply(segment.video(video.url_default))
      }
    }
    return true
  }
}

/**
 * 取某个编码下的流列表。
 *
 * `image_list[].stream` 与 `video.media.stream` 在生成树里都只有索引签名（样本没录到编码键），
 * 值统一在这里收成 {@link XhsVideoStream}，别让 `any` 顺着调用链传下去。
 */
const codecVideos = (streamData: unknown, codec: string): XhsVideoStream[] => {
  if (!streamData || typeof streamData !== 'object') {
    return []
  }

  const value: unknown = (streamData as Record<string, unknown>)[codec]
  return Array.isArray(value) ? (value as XhsVideoStream[]) : []
}

/**
 * 获取小红书实况图视频流
 * @param streamData 视频流数据
 * @returns 选择的视频流
 */
export const xiaohongshuGetLivePhotoVideo = (streamData: unknown): XhsVideoStream | null => {
  if (!streamData) {
    logger.warn('没有找到实况图视频流数据')
    return null
  }

  // 按兼容性优先级收集所有视频流：h264 > h265 > av1 > h266
  const codecPriority = ['h264', 'h265', 'av1', 'h266']

  for (const codec of codecPriority) {
    const videos = codecVideos(streamData, codec)
    if (videos.length > 0) {
      // 选择第一个可用的视频流（实况图通常只有一个流）
      const video = videos[0]
      logger.debug(`选择实况图视频流: 编码=${codec}, 大小=${(video.size || 0) / (1024 * 1024)}MB`)
      return video
    }
  }

  logger.warn('未找到可用的实况图视频流')
  return null
}

/**
 * 处理小红书视频流选择逻辑
 * @param streamData 视频流数据
 * @param videoQuality 画质偏好
 * @param maxAutoVideoSize 自动模式下的最大文件大小（MB）
 * @returns 选择的视频流
 */
export const xiaohongshuProcessVideos = (streamData: unknown, videoQuality: string, maxAutoVideoSize?: number): XhsVideoStream | null => {
  if (!streamData) {
    logger.warn('没有找到视频流数据')
    return null
  }

  // 按兼容性优先级收集所有视频流：h265 > h264 > av1 > h266
  const codecPriority = ['h265', 'h264', 'av1', 'h266']
  const allVideos: XhsVideoStream[] = []

  for (const codec of codecPriority) {
    allVideos.push(...codecVideos(streamData, codec))
  }

  if (allVideos.length === 0) {
    logger.warn('没有找到可用的视频流')
    return null
  }

  logger.debug(`找到 ${allVideos.length} 个视频流`)

  // 定义画质等级映射，根据分辨率判断画质
  const getQualityLevel = (width: number, height: number): string => {
    const pixels = width * height
    // 4K 画质 (3840x2160 或更高)
    if (pixels >= 3840 * 2160) return '4k'
    // 2K/1440p 画质 (2560x1440)
    if (pixels >= 2560 * 1440) return '2k'
    // 1080p 画质 (1920x1080)
    if (pixels >= 1920 * 1080) return '1080p'
    // 720p 画质 (1280x720)
    if (pixels >= 1280 * 720) return '720p'
    // 540p 画质及以下
    return '540p'
  }

  // 按画质分组，并在每组内按文件大小排序（大的在前）
  const videosByQuality = new Map<string, XhsVideoStream[]>()

  allVideos.forEach((video) => {
    const quality = getQualityLevel(video.width, video.height)
    if (!videosByQuality.has(quality)) {
      videosByQuality.set(quality, [])
    }
    videosByQuality.get(quality)!.push(video)
  })

  // 对每个画质组内的视频按文件大小排序（大的在前）
  videosByQuality.forEach((videos) => {
    videos.sort((a, b) => b.size - a.size)
  })

  // 如果是自动模式
  if (videoQuality === 'adapt') {
    const sizeLimitBytes = (maxAutoVideoSize || Config.app.filelimit) * 1024 * 1024

    // 按画质优先级排序：4k > 2k > 1080p > 720p > 540p
    const qualityPriority = ['4k', '2k', '1080p', '720p', '540p']

    for (const quality of qualityPriority) {
      const qualityVideos = videosByQuality.get(quality)
      if (qualityVideos && qualityVideos.length > 0) {
        // 选择该画质下文件大小最大但不超过限制的视频
        const suitableVideo = qualityVideos.find((video) => video.size <= sizeLimitBytes)
        if (suitableVideo) {
          logger.debug(
            `自动选择画质: ${quality}, 文件大小: ${(suitableVideo.size / (1024 * 1024)).toFixed(2)}MB, 编码: ${suitableVideo.video_codec}`
          )
          return suitableVideo
        }
      }
    }

    // 如果没有找到符合大小限制的视频，选择最小的视频
    let smallestVideo = allVideos[0]
    allVideos.forEach((video) => {
      if (video.size < smallestVideo.size) {
        smallestVideo = video
      }
    })
    logger.debug(
      `未找到符合大小限制的视频，选择最小视频: ${(smallestVideo.size / (1024 * 1024)).toFixed(2)}MB, 编码: ${smallestVideo.video_codec}`
    )
    return smallestVideo
  }

  // 固定画质模式
  const targetQuality = videoQuality
  const targetVideos = videosByQuality.get(targetQuality)

  if (targetVideos && targetVideos.length > 0) {
    // 选择该画质下文件大小最大的视频（通常意味着更高的码率和质量）
    logger.debug(
      `选择固定画质: ${targetQuality}, 文件大小: ${(targetVideos[0].size / (1024 * 1024)).toFixed(2)}MB, 编码: ${targetVideos[0].video_codec}`
    )
    return targetVideos[0]
  }

  // 如果没有找到目标画质，选择最接近的画质
  const qualityPriority = ['4k', '2k', '1080p', '720p', '540p']
  const targetIndex = qualityPriority.indexOf(targetQuality)

  // 先尝试向下找（更低画质）
  for (let i = targetIndex + 1; i < qualityPriority.length; i++) {
    const fallbackVideos = videosByQuality.get(qualityPriority[i])
    if (fallbackVideos && fallbackVideos.length > 0) {
      logger.debug(`目标画质 ${targetQuality} 不可用，降级到: ${qualityPriority[i]}, 编码: ${fallbackVideos[0].video_codec}`)
      return fallbackVideos[0]
    }
  }

  // 再尝试向上找（更高画质）
  for (let i = targetIndex - 1; i >= 0; i--) {
    const fallbackVideos = videosByQuality.get(qualityPriority[i])
    if (fallbackVideos && fallbackVideos.length > 0) {
      logger.debug(`目标画质 ${targetQuality} 不可用，升级到: ${qualityPriority[i]}, 编码: ${fallbackVideos[0].video_codec}`)
      return fallbackVideos[0]
    }
  }

  // 如果都没找到，返回第一个可用视频
  logger.warn('未找到任何匹配的画质，返回默认视频')
  return allVideos[0]
}

/**
 * 格式化小红书表情列表
 * @param data 表情接口的响应体（`fetchEmojiList` 的 `data`）
 * @returns 格式化后的表情数组
 */
export const XiaohongshuEmoji = (data: XiaohongshuEmojiListResponse): RichTextEmojiDefinition[] => {
  const list: RichTextEmojiDefinition[] = []

  for (const tab of data.data.emoji.tabs ?? []) {
    for (const collection of tab.collection ?? []) {
      for (const emoji of collection.emoji ?? []) {
        list.push({ name: emoji.image_name, url: emoji.image })
      }
    }
  }

  return list
}
