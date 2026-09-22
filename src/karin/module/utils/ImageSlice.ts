/**
 * 超长图片的「切片 + markdown 拼接」发送。
 *
 * 背景：评论区卡片会把「主评论 + 楼中楼」全部渲染进一张图，实测能长到 **2880×40000**
 * （1.15 亿像素、7MB）—— QQ 直接拒收（报 `[40093011] 上传文件大小超过限制`），
 * 表现就是「评论卡发不出来」。
 *
 * 解法：把长图按固定高度切成若干片，每片单独上传，再用 **一条 markdown 消息** 拼起来：
 *
 *   ![#2880px #6000px](url1)
 *   ![#2880px #6000px](url2)
 *
 * QQ 对同一 markdown 里连续的图片是**紧贴渲染**的，所以视觉上仍然是一整张卡片（严丝合缝），
 * 而每片都在 QQ 的预览尺寸内，不会再被拒。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { logger, resolveFfmpegBin, segment, type Message } from 'node-karin'

import { isForwardCollecting } from '../../../compat/forward-collect'
import { commandInvocation, tryGetRuntime } from '../../../compat/runtime'
import { getImageMetadata } from '@/module/utils/Render'
import { classifySendFailure, describeSendFailure, failureFromReplyResult, type SendFailure } from '../../../compat/sendError'

/**
 * 每片的**目标**高度。
 *
 * 一开始用的 6000：QQ 会把这么高的图整体缩小显示，结果前几片字小到看不清；
 * 而最后一片因为短，反而被按宽度铺满，看起来比别的「宽」。
 * 现在改成 2000 —— 每片都在 QQ 的舒适区内，字够大；同时下面的算法保证**每片等长**。
 */
const SLICE_HEIGHT = 2000

/** 切片前先把宽度压到这个值（卡片本来 2880 宽，QQ 显示用不到，缩一半解码量降到 1/4） */
const SLICE_WIDTH = 1440

/**
 * 当前事件所在平台的适配器名（兼容层里真实 Bot 挂在 \`bot.bot\` 上）。
 */
export const platformOf = (e: any): string =>
  String(e?.bot?.bot?.platform ?? e?.platform ?? e?.bot?.platform ?? '')

/**
 * **OneBot 系（NapCat / Lagrange / go-cqhttp / Chronocat…）**。
 *
 * 它们的 QQ 图片限制和官方 bot 一样（所以要切片），但**不渲染 markdown 消息** ——
 * 实测切片后用 \`segment.markdown('![#1440px #2000px](url)…')\` 发出去，
 * 群里只看到一串 URL 文字、图片根本出不来（用户反馈：「onebot 平台给我评论区图片发不出来」）。
 * 所以这条链路要改发**普通图片段**。
 */
const ONEBOT_LIKE = /onebot|napcat|lagrange|go-?cqhttp|chronocat|mirai/i
const isOneBotLike = (platform: string): boolean => ONEBOT_LIKE.test(platform)

/**
 * 官方 QQ 适配器（qq-crack / adapter-qq）：markdown 里的连续图片**紧贴渲染**，
 * 是「视觉上仍是一整张卡片」的正解，所以这条链路上继续用 markdown。
 */
const isOfficialQq = (platform: string): boolean => /^qq/i.test(platform)

/** OneBot 一条消息里最多塞几片（每片 1440x2000 的 jpeg ≈ 200KB，base64 后 ≈ 270KB） */
const SLICES_PER_MESSAGE = 5

/** 按条数把元素分组（OneBot 一次发太多图容易被客户端/适配器截断） */
const chunkElements = <T>(items: T[], size: number): T[][] => {
  const groups: T[][] = []
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size))
  return groups
}

/** 把 data URI 或本地路径读成 Buffer */
const readImage = (source: string): Buffer | null => {
  try {
    if (source.startsWith('data:')) {
      const comma = source.indexOf(',')
      return Buffer.from(source.slice(comma + 1), 'base64')
    }
    if (fs.existsSync(source)) return fs.readFileSync(source)
    return null
  } catch {
    return null
  }
}

/** 用 ffmpeg 裁一段出来（项目本来就依赖 ffmpeg，不额外引图像库） */
const cropWithFfmpeg = async (
  input: string,
  output: string,
  width: number,
  height: number,
  y: number,
  /** 自定义 filter（给缩放步骤用）；不传就是按宽度/高度/偏移裁剪 */
  customFilter?: string
): Promise<boolean> => {
  const filter = customFilter ?? ('crop=' + width + ':' + height + ':0:' + y)
  const args = ['-y', '-i', input, '-vf', filter, '-frames:v', '1', output]
  /**
   * **不要用宿主的 ffmpeg 服务自带的 builder** —— 实测 `ffmpeg.builder()...run()` 会**卡住不返回**
   * （既没有 ffmpeg 进程、也没有 CPU 占用、更没有任何日志，表现就是「怎么没反应了」）。
   * 命令行方式已经验证可用，直接用它。
   *
   * 但**可执行文件要走兼容层那一套候选**（Koishi 服务 → ffmpegPath → 环境变量 → PATH，
   * 每份都校验存在与可执行）：以前这里直接读 `process.env.FFMPEG_PATH`，
   * 拿到一份相对路径/没 +x 的 ffmpeg 时同样会 EACCES（和 m4s 那条链路一个坑）。
   */
  try {
    const { spawn } = await import('node:child_process')
    const bin = resolveFfmpegBin()
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(bin, args, { stdio: 'ignore' })
      proc.on('error', reject)
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code))))
    })
    return true
  } catch (error: any) {
    logger.warn('[图片切片] ffmpeg 裁剪失败: ' + String(error?.message ?? error))
    return false
  }
}

/** 上传到宿主 assets，拿到 QQ 能访问的 https 地址 */
const uploadSlice = async (buffer: Buffer, name: string, attempts = 3): Promise<string | null> => {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const url = await uploadSliceOnce(buffer, name)
    if (url) return url
    if (attempt < attempts) {
      logger.mark('[图片切片] 上传第 ' + attempt + ' 次失败，' + attempt * 1000 + 'ms 后重试')
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
    }
  }
  return null
}

/** 单次上传（重试逻辑在外面） */
const uploadSliceOnce = async (buffer: Buffer, name: string): Promise<string | null> => {
  try {
    const assets: any = (tryGetRuntime() as any)?.ctx?.assets
    if (!assets?.upload) return null
    const uploaded: any = await assets.upload('data:image/jpeg;base64,' + buffer.toString('base64'), name)
    const url = typeof uploaded === 'string' ? uploaded : uploaded?.url
    return url && /^https?:\/\//i.test(String(url)) ? String(url) : null
  } catch (error: any) {
    logger.warn('[图片切片] 上传失败: ' + String(error?.message ?? error))
    return null
  }
}

/**
 * 发送可能超长的图片：短图直接发，长图切片后用一条 markdown 拼接。
 *
 * @param e 消息事件
 * @param source data URI 或本地图片路径
 * @returns 是否已发送
 */
export const sendSlicedImage = async (e: Message, input: any): Promise<boolean> => {
  /**
   * 入参形态有三种，全都要认：
   *   1. data URI / 本地路径（字符串）
   *   2. segment.image(...) 造出来的元素（src 在 attrs 上）
   *   3. 上面两种的**数组** —— Render() 对多图模板返回的就是数组。
   * 之前只处理前两种，数组进来时取不到 src 会静默失败（切片一直没生效就是这个原因）。
   */
  const first = Array.isArray(input) ? input[0] : input
  const source: string = typeof first === 'string'
    ? first
    : String(first?.attrs?.src ?? first?.data?.file ?? first?.data?.url ?? '')
  const buffer = readImage(source)
  if (!buffer) {
    logger.warn('[图片切片] 取不到图片内容（入参 ' + (Array.isArray(input) ? 'array' : typeof input) + '），回退原逻辑')
    return false
  }
  /**
   * **按需切片**（默认开，配置项 sliceImageOnDemand）：
   *   - 图片 ≤ 20MB 且不超高 → 先按普通图片发一次；
   *   - 这次发送**失败** → 才切片重发。失败有两种：适配器抛异常（带错误码，例如
   *     `[40093011] 上传文件大小超过限制`），或兼容层发现**没拿到消息 ID**
   *     （说明消息没发出去，见 compat/sendError 的 UnconfirmedSendError）；
   *   - 图片本身就超过 20MB → 直接切片，不用白试一次。
   * 关掉开关就一律普通发送（超高的卡会被 QQ 拒收，但这是用户的选择）。
   */
  const runtimeConfig: any = (tryGetRuntime()?.config as any) ?? {}
  /**
   * **切片只在「QQ 那条链路」上生效**。
   *
   * 切片是为了绕开 QQ 的图片上传限制（单图体积/像素上限），其它平台没这个问题，
   * 硬切只会增加消息条数、破坏观感。
   *
   * ⚠️ **OneBot 也是 QQ**：用户的机器人跑在 NapCat / Lagrange / go-cqhttp 上时，
   * 适配器报的平台名是 `onebot`，底下的限制和 QQ 官方一模一样 ——
   * 实测 2880x35862 的评论卡直接发会拿到 `Error with request send_group_msg … retcode: 1200`，
   * 而这里以前只认 `/qq/`，于是**跳过切片**、把大图原样发出去，结果就是「评论卡发不出来」。
   * 现在把 QQ 协议的常见平台名都算进来。
   */
  const platform = String((e as any)?.bot?.bot?.platform ?? (e as any)?.platform ?? (e as any)?.bot?.platform ?? '')
  const QQ_LIKE_PLATFORM = /^(qq|qqguild|onebot|napcat|lagrange|go-?cqhttp|chronocat|mirai)/i
  if (platform && !QQ_LIKE_PLATFORM.test(platform)) {
    logger.debug('[图片切片] 当前平台 ' + platform + ' 不是 QQ 链路，按普通图片发送')
    await e.reply(segment.image(source))
    return true
  }
  const onDemand = runtimeConfig.sliceImageOnDemand !== false
  const sliceHeight = Math.max(300, Number(runtimeConfig.sliceImageHeight) || SLICE_HEIGHT)
  const IMAGE_SIZE_LIMIT = 20 * 1024 * 1024

  const meta = getImageMetadata(buffer)
  let width = Number(meta.width) || 0
  let height = Number(meta.height) || 0
  // 读不出尺寸时用 ffprobe 兜一次，绝不因为读不到尺寸就放弃切片
  if (!width || !height) {
    try {
      const { spawnSync } = await import('node:child_process')
      const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', '-'], { input: buffer })
      const parts = String(probe.stdout ?? '').trim().split(',')
      width = Number(parts[0]) || 0
      height = Number(parts[1]) || 0
    } catch { /* 兜底失败按 0 处理 */ }
  }
  logger.mark('[图片切片] 收到图片 ' + width + 'x' + height + '（' + (buffer.length / 1024).toFixed(0) + ' KB）')
  /**
   * 普通发送：失败判定与「为什么失败」分开看（见 compat/sendError）。
   *
   *   - **是不是失败**：适配器抛异常 / 返回体带 error / 兼容层发现没拿到消息 ID
   *     （没 ID = 没发出去，对齐 qq-chat 的判法）—— 这三种都算失败；
   *   - **为什么失败**：看错误码。`[40093011] 上传文件大小超过限制` 这类确定性失败
   *     重试没有意义，直接去切片；网络/TLS/超时才是值得重试的。
   *
   * 仍然保留超时 —— 超高图片（实测 2880×15520）上传时适配器会**长时间卡住不返回**，
   * 不加超时整条流程就停在这里，用户看到的就是「没反应」。
   */
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  const tryNormalSendOnce = async (): Promise<SendFailure | null> => {
    const sendPromise = (async (): Promise<SendFailure | null> => {
      try {
        const result: any = await e.reply(segment.image(source))
        const failure = failureFromReplyResult(result)
        if (failure) logger.mark('[图片切片] 普通发送返回错误：' + describeSendFailure(failure))
        return failure
      } catch (error: any) {
        // 这里不打日志：失败原因由外层统一输出一次（避免同一个失败连打三行）
        return classifySendFailure(error)
      }
    })()
    const timeoutPromise = new Promise<SendFailure>((resolve) => {
      const timer = setTimeout(() => resolve({
        kind: 'transient', message: '发送超过 15s 没有返回', retryable: true
      }), 15000)
      timer.unref?.()
    })
    return await Promise.race([sendPromise, timeoutPromise])
  }

  /**
   * 带**重试**的普通发送（用户要求）。
   *
   * 只重试**瞬时**失败：DNS 抖动、连接被重置、TLS 证书对不上
   * （你环境里就有把 COS 域名解析到错服务器、返回「只有 IP 的证书」的情况）——
   * 这类一失败就切片属于过度反应。
   *
   * 而 `[40093011] 上传文件大小超过限制` 这类**确定性**失败（体积/尺寸超限）重试没有任何意义：
   * 同样的字节再传一遍还是超，只会让用户多等两轮大文件上传 —— 拿到码就直接去切片。
   */
  const tryNormalSend = async (attempts = 3): Promise<SendFailure | null> => {
    let last: SendFailure | null = null
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const failure = await tryNormalSendOnce()
      if (!failure) return null
      last = failure
      if (!failure.retryable) return failure
      if (attempt < attempts) {
        logger.mark('[图片切片] 普通发送第 ' + attempt + ' 次失败（' + describeSendFailure(failure) + '），' + attempt * 800 + 'ms 后重试')
        await sleep(attempt * 800)
      }
    }
    return last
  }

  // 开关关闭 → 永远普通发送
  if (!onDemand) {
    await e.reply(segment.image(source))
    return true
  }
  /**
   * 顺序就是用户要的：**先按普通图片发一次**，
   *   - 拿到消息 ID → 成功，结束（大多数卡片都走这里，不会多此一举切片）
   *   - 拿不到消息 ID（QQ 拒收就是这样，不抛异常）/ 抛异常 → 再切片重发
   * 只有图片本身就超过 20MB 才跳过这次尝试，直接切。
   */
  const oversized = buffer.length > IMAGE_SIZE_LIMIT
  /**
   * **大图失败后不重试**：重传一次就是几 MB 起步（这张评论卡 4.6MB / 1.03 亿像素），
   * 而失败原因基本是「尺寸/体积超限」这类确定性问题，重试只是让用户白等。
   * 小图（<2MB）才值得为瞬时抖动重试。
   */
  const heavyImage = buffer.length > 2 * 1024 * 1024 || height > sliceHeight * 6
  /**
   * **合并转发模式下不能靠「试发一次」判断**。
   *
   * 收集模式里 `e.reply()` 只是把元素攒进缓冲区、回一个**假的消息 ID**，
   * 拿不到任何成功/失败反馈（见 compat/forward-collect 的 isForwardCollecting）。
   * 以前这里因此把 2880×35862 的评论卡当成「发送成功」，整张塞进转发节点，
   * `send_group_forward_msg` 直接因节点内容过大失败。
   * 所以这种模式下**按尺寸自己判断**：超过一片的高度就切。
   */
  const collecting = isForwardCollecting()
  const tooTall = !!height && height > sliceHeight
  if (oversized) {
    logger.mark('[图片切片] 图片 ' + (buffer.length / 1024 / 1024).toFixed(1) + 'MB 超过 20MB 限制，直接切片')
  } else if (collecting && tooTall) {
    logger.mark('[图片切片] 合并转发模式：' + width + 'x' + height + ' 超过单片高度 ' + sliceHeight + '，直接切片（转发时不试发，试了也拿不到反馈）')
  } else {
    const failure = await tryNormalSend(heavyImage ? 1 : 3)
    if (!failure) return true
    logger.mark('[图片切片] 普通发送未成功（' + describeSendFailure(failure) + '）' +
      (heavyImage ? '，大图不重试' : '') + '，改走切片')
  }
  if (!width || !height || height <= sliceHeight) {
    // 尺寸本身就在范围内、只是发不出去：没得切，原样再发一次（再失败也如实报出来）
    try {
      const failure = failureFromReplyResult(await e.reply(segment.image(source)))
      if (failure) logger.warn('[图片切片] 重发仍未成功：' + describeSendFailure(failure))
    } catch (error: any) {
      logger.warn('[图片切片] 重发失败：' + describeSendFailure(classifySendFailure(error)))
    }
    return true
  }

  const runtime: any = tryGetRuntime()
  const tmpDir = path.join(os.tmpdir(), 'kkk-slice-' + Date.now())
  try {
    fs.mkdirSync(tmpDir, { recursive: true })
    const original = path.join(tmpDir, 'full.jpg')
    fs.writeFileSync(original, buffer)

    /**
     * **先整体缩一次再从缩略图切片** —— 这一步是性能关键。
     *
     * 卡片实测 2880×40000（1.15 亿像素）：直接在原图上裁 7 刀，每刀都要把整图重新解码一遍，
     * 实测要跑好几分钟（用户会看到「怎么没反应了」）。缩到一半宽再裁，
     * 解码量降到 1/4，7 刀总共一两秒，而且 QQ 显示尺寸本来就不需要 2880 宽。
     */
    const scaleWidth = Math.min(width, SLICE_WIDTH)
    const input = path.join(tmpDir, 'small.jpg')
    const scaled = scaleWidth < width
      ? await cropWithFfmpeg(original, input, 0, 0, 0, 'scale=' + scaleWidth + ':-1')
      : true
    const useInput = scaled && fs.existsSync(input) ? input : original
    const useHeight = scaled && scaleWidth < width ? Math.round((height * scaleWidth) / width) : height
    const useWidth = scaled && scaleWidth < width ? scaleWidth : width
    if (useInput !== original) {
      logger.mark('[图片切片] 已缩放到 ' + useWidth + 'x' + useHeight + ' 再切片')
    }

    /**
     * **两条发送链路**（平台决定，见文件头的说明）：
     *
     *   - 官方 QQ：每片先传到 assets 拿 https 地址，再拼成**一条 markdown**（连续图片紧贴渲染）；
     *   - OneBot：**不传 assets、不拼 markdown**，直接按普通图片段发 —— 省掉整轮上传（更快），
     *     而且 markdown 在 NapCat 这类客户端上根本渲染不出来。
     */
    const oneBotMode = isOneBotLike(platform)
    const markdownMode = !oneBotMode
    const slices: Buffer[] = []
    const parts: string[] = []
    /**
     * **每片等长**：先按最大高度算出片数，再把总高平均分配。
     * 这样最后一片不会因为矮而被 QQ 按宽度铺开（用户说的「最后一张太宽」）。
     * 除不尽时最后一片会与前一片重叠几个像素，视觉上几乎看不出来，比留白干净。
     */
    const total = Math.max(1, Math.ceil(useHeight / sliceHeight))
    const each = Math.ceil(useHeight / total)
    for (let index = 0; index < total; index++) {
      const sliceHeight = each
      // 最后一片贴底裁，保证高度一致（宁可重叠几像素，也不要短一截）
      const offset = index === total - 1 ? Math.max(0, useHeight - each) : index * each
      const output = path.join(tmpDir, 'slice-' + index + '.jpg')
      const ok = await cropWithFfmpeg(useInput, output, useWidth, sliceHeight, offset)
      if (!ok || !fs.existsSync(output)) break
      const slice = fs.readFileSync(output)
      slices.push(slice)
      if (markdownMode) {
        const url = await uploadSlice(slice, 'kkk-slice-' + index + '.jpg')
        if (!url) break
        // 尺寸写死成实际像素：QQ 会按这个尺寸渲染，连续图片紧贴 = 视觉上仍是一整张
        parts.push('![#' + useWidth + 'px #' + sliceHeight + 'px](' + url + ')')
      }
    }

    const usable = oneBotMode ? slices.length : parts.length
    if (!usable) {
      // 切片失败就退回原图，至少不是完全没反应
      await e.reply(segment.image(source))
      return true
    }

    if (markdownMode) {
      logger.mark('[图片切片] 长图 ' + width + 'x' + height + ' 已切成 ' + parts.length + ' 片，用 markdown 拼接发送')
      await e.reply(segment.markdown(parts.join(String.fromCharCode(10))))
      return true
    }

    /**
     * OneBot：按普通图片段发（base64 直接给适配器，不需要公网地址）。
     * 一次 5 片，避免单条消息过大被客户端截断；视觉上依旧是「一条卡片的若干段」。
     */
    const groups = chunkElements(slices, SLICES_PER_MESSAGE)
    logger.mark('[图片切片] 长图 ' + width + 'x' + height + ' 已切成 ' + slices.length + ' 片，按图片段分 '
      + groups.length + ' 条发送（' + (platform || 'onebot') + ' 不渲染 markdown）')
    for (const group of groups) {
      /**
       * 用**带 mime 的 data URI**，别用 \`base64://\`：兼容层把 \`base64://\` 一律当
       * \`image/png\`（compat/segment.ts 的 guessMime 拿不到扩展名就默认 png），
       * 而切片是 ffmpeg 出的 jpeg —— 标错 mime 会让适配器把 .png 扩展名的 jpeg 交给客户端。
       */
      await e.reply(group.map((slice) => segment.image('data:image/jpeg;base64,' + slice.toString('base64'))))
    }
    return true
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 清理失败无所谓 */ }
  }
}

/**
 * 只切片、不发送：把可能超长的图片切成**可以直接发给适配器的元素数组**（调用方自己决定怎么发）。
 *
 * 错误卡片就用它 —— 实测错误卡片能到 2880x40000 / 45MB（堆栈越长越夸张），
 * 直接发必然被 QQ 拒收，等于「报错本身也发不出来」。
 *
 * 返回什么由平台决定（见文件头）：
 *   - 官方 QQ：一个 \`markdown\` 元素（里面的连续图片紧贴渲染，视觉上仍是一整张）；
 *   - OneBot：若干 \`image\` 元素（NapCat 这类客户端不渲染 markdown，只发图片段）。
 *
 * @param input 图片（data URI / 本地路径 / 消息元素）
 * @param platform 适配器平台名，缺省按官方 QQ 处理
 */
export const sliceImageToElements = async (input: any, platform = ''): Promise<any[] | null> => {
  const first = Array.isArray(input) ? input[0] : input
  const source: string = typeof first === 'string'
    ? first
    : String(first?.attrs?.src ?? first?.data?.file ?? first?.data?.url ?? '')
  if (!source) return null
  const runtimeConfig: any = (tryGetRuntime()?.config as any) ?? {}
  /**
   * 注意：这里以前混进来一段**从 sendSlicedImage 复制过来的**非 QQ 分支，
   * 里面用了这个函数根本没有的 `e` 和 `valid` —— 函数每次一调用就
   * `ReferenceError: e is not defined`，错误卡片的切片永远失败，
   * 最后那张 8.9MB 的长图直接原样发出去（还可能被 QQ 拒收）。
   * 这个函数只负责「切片」，平台判断交给调用方，所以整段删掉。
   */
  const sliceHeight = Math.max(300, Number(runtimeConfig.sliceImageHeight) || SLICE_HEIGHT)
  const tmpDir = path.join(os.tmpdir(), 'kkk-sliceonly-' + Date.now())
  try {
    fs.mkdirSync(tmpDir, { recursive: true })
    const buffer = readImage(source)
    if (!buffer) return null
    const meta = getImageMetadata(buffer)
    let width = Number(meta.width) || 0
    let height = Number(meta.height) || 0
    if (!width || !height) {
      try {
        const { spawnSync } = await import('node:child_process')
        const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', '-'], { input: buffer })
        const ps = String(probe.stdout ?? '').trim().split(',')
        width = Number(ps[0]) || 0
        height = Number(ps[1]) || 0
      } catch { /* 忽略 */ }
    }
    if (!width || !height) return null
    /**
     * OneBot 不渲染 markdown：直接把图当普通图片段返回（也不需要先传 assets）。
     * 官方 QQ 才走「上传 → markdown 拼接」。
     */
    const oneBotMode = isOneBotLike(platform)
    if (height <= sliceHeight) {
      // 带 mime 的 data URI（见上面 sendSlicedImage 里的说明）
      if (oneBotMode) return [segment.image('data:image/jpeg;base64,' + buffer.toString('base64'))]
      const url = await uploadSlice(buffer, 'kkk-one.jpg')
      return url ? [segment.markdown('![#' + width + 'px #' + height + 'px](' + url + ')')] : null
    }
    // 超高：先缩放再等分切片
    const original = path.join(tmpDir, 'full.jpg')
    fs.writeFileSync(original, buffer)
    const scaleWidth = Math.min(width, SLICE_WIDTH)
    const small = path.join(tmpDir, 'small.jpg')
    const scaled = scaleWidth < width ? await cropWithFfmpeg(original, small, 0, 0, 0, 'scale=' + scaleWidth + ':-1') : false
    const useInput = scaled && fs.existsSync(small) ? small : original
    const useWidth = scaled ? scaleWidth : width
    const useHeight = scaled ? Math.round((height * scaleWidth) / width) : height
    const total = Math.max(1, Math.ceil(useHeight / sliceHeight))
    const each = Math.ceil(useHeight / total)
    const slices: Buffer[] = []
    const parts: string[] = []
    for (let index = 0; index < total; index++) {
      const offset = index === total - 1 ? Math.max(0, useHeight - each) : index * each
      const output = path.join(tmpDir, 'slice-' + index + '.jpg')
      const ok = await cropWithFfmpeg(useInput, output, useWidth, each, offset)
      if (!ok || !fs.existsSync(output)) break
      const slice = fs.readFileSync(output)
      slices.push(slice)
      if (!oneBotMode) {
        const url = await uploadSlice(slice, 'kkk-slice-' + index + '.jpg')
        if (!url) break
        parts.push('![#' + useWidth + 'px #' + each + 'px](' + url + ')')
      }
    }
    if (oneBotMode) {
      if (!slices.length) return null
      logger.mark('[图片切片] 错误卡片等超长图已切成 ' + slices.length + ' 段（图片段，' + (platform || 'onebot') + ' 不渲染 markdown）')
      return chunkElements(slices, SLICES_PER_MESSAGE)
        .map((group) => group.map((slice) => segment.image('data:image/jpeg;base64,' + slice.toString('base64'))))
        .flat()
    }
    if (!parts.length) return null
    logger.mark('[图片切片] 错误卡片等超长图已切成 ' + parts.length + ' 段（markdown）')
    return [segment.markdown(parts.join(String.fromCharCode(10)))]
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}