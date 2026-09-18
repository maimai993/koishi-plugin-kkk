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

import { logger, segment, type Message } from 'node-karin'

import { commandInvocation, tryGetRuntime } from '../../../compat/runtime'
import { getImageMetadata } from '@/module/utils/Render'

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
  const runtime: any = tryGetRuntime()
  const ffmpeg: any = runtime?.ctx?.ffmpeg
  const args = ['-y', '-i', input, '-vf', filter, '-frames:v', '1', output]
  /**
   * **不要用宿主的 ffmpeg 服务** —— 实测 `ffmpeg.builder()...run()` 会**卡住不返回**
   * （既没有 ffmpeg 进程、也没有 CPU 占用、更没有任何日志，表现就是「怎么没反应了」）。
   * 命令行方式已经验证可用，直接用它。
   */
  try {
    const { spawn } = await import('node:child_process')
    const bin = process.env.FFMPEG_PATH || 'ffmpeg'
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
const uploadSlice = async (buffer: Buffer, name: string): Promise<string | null> => {
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
   *   - 发出去**没有消息 ID**（QQ 拒收时就是这样，不抛异常）或抛异常 → 才切片重发；
   *   - 图片本身就超过 20MB → 直接切片，不用白试一次。
   * 关掉开关就一律普通发送（超高的卡会被 QQ 拒收，但这是用户的选择）。
   */
  const runtimeConfig: any = (tryGetRuntime()?.config as any) ?? {}
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
   * 普通发送：**收到消息 ID 才算成功**（QQ 拒收时不抛异常、只返回空）。
   *
   * 另外加了超时 —— 超高图片（实测 2880×15520）上传时适配器会**长时间卡住不返回**，
   * 不加超时整条流程就停在这里，用户看到的就是「没反应」。15 秒没结果就当作失败去切片。
   */
  const tryNormalSend = async (): Promise<boolean> => {
    const sendPromise = (async () => {
      try {
        const result: any = await e.reply(segment.image(source))
        return Boolean(result?.messageId)
      } catch (error: any) {
        logger.debug('[图片切片] 普通发送抛错: ' + String(error?.message ?? error))
        return false
      }
    })()
    const timeoutPromise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 15000)
      timer.unref?.()
    })
    return await Promise.race([sendPromise, timeoutPromise])
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
  if (oversized) {
    logger.mark('[图片切片] 图片 ' + (buffer.length / 1024 / 1024).toFixed(1) + 'MB 超过 20MB 限制，直接切片')
  } else if (await tryNormalSend()) {
    return true
  } else {
    logger.mark('[图片切片] 普通发送没有拿到消息 ID（多为 QQ 拒收），改走切片')
  }
  if (!width || !height || height <= sliceHeight) {
    // 尺寸本身就在范围内、只是发不出去：没得切，原样再试一次
    await e.reply(segment.image(source))
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
      const url = await uploadSlice(fs.readFileSync(output), 'kkk-slice-' + index + '.jpg')
      if (!url) break
      // 尺寸写死成实际像素：QQ 会按这个尺寸渲染，连续图片紧贴 = 视觉上仍是一整张
      parts.push('![#' + useWidth + 'px #' + sliceHeight + 'px](' + url + ')')
    }

    if (!parts.length) {
      // 切片失败就退回原图，至少不是完全没反应
      await e.reply(segment.image(source))
      return true
    }
    logger.mark('[图片切片] 长图 ' + width + 'x' + height + ' 已切成 ' + parts.length + ' 片，用 markdown 拼接发送')
    await e.reply(segment.markdown(parts.join(String.fromCharCode(10))))
    return true
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 清理失败无所谓 */ }
  }
}