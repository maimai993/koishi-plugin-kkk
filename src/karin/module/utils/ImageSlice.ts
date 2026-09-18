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

/** 每片的最大高度：留在 QQ 预览舒适区内，太大一样会被压缩得糊 */
const SLICE_HEIGHT = 6000

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
const cropWithFfmpeg = async (input: string, output: string, width: number, height: number, y: number): Promise<boolean> => {
  const runtime: any = tryGetRuntime()
  const ffmpeg: any = runtime?.ctx?.ffmpeg
  const args = ['-y', '-i', input, '-vf', 'crop=' + width + ':' + height + ':0:' + y, '-frames:v', '1', output]
  try {
    if (typeof ffmpeg?.builder === 'function') {
      await ffmpeg.builder().input(input).outputOption('-vf', 'crop=' + width + ':' + height + ':0:' + y, '-frames:v', '1').output(output).run('utf-8')
      return true
    }
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
  // 既接受 data URI / 本地路径，也接受 segment.image(...) 造出来的元素
  const source: string = typeof input === 'string'
    ? input
    : String(input?.attrs?.src ?? input?.data?.file ?? input?.data?.url ?? '')
  const buffer = readImage(source)
  if (!buffer) return false
  const meta = getImageMetadata(buffer)
  const width = Number(meta.width) || 0
  const height = Number(meta.height) || 0
  // 不高的图按原样发，别给所有卡片都加一层 md
  if (!width || !height || height <= SLICE_HEIGHT) {
    await e.reply(segment.image(source))
    return true
  }

  const runtime: any = tryGetRuntime()
  const tmpDir = path.join(os.tmpdir(), 'kkk-slice-' + Date.now())
  try {
    fs.mkdirSync(tmpDir, { recursive: true })
    const input = path.join(tmpDir, 'full.jpg')
    fs.writeFileSync(input, buffer)

    const parts: string[] = []
    const total = Math.ceil(height / SLICE_HEIGHT)
    for (let index = 0; index < total; index++) {
      const sliceHeight = Math.min(SLICE_HEIGHT, height - index * SLICE_HEIGHT)
      const output = path.join(tmpDir, 'slice-' + index + '.jpg')
      const ok = await cropWithFfmpeg(input, output, width, sliceHeight, index * SLICE_HEIGHT)
      if (!ok || !fs.existsSync(output)) break
      const url = await uploadSlice(fs.readFileSync(output), 'kkk-slice-' + index + '.jpg')
      if (!url) break
      // 尺寸写死成实际像素：QQ 会按这个尺寸渲染，连续图片紧贴 = 视觉上仍是一整张
      parts.push('![#' + width + 'px #' + sliceHeight + 'px](' + url + ')')
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