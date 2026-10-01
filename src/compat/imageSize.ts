/**
 * 从图片**二进制头**里读出真实像素尺寸 —— QQ markdown 的 `![#宽px #高px](url)` 全靠它。
 *
 * ## 为什么要单独抽一个模块
 *
 * 「读尺寸」这件事在插件里有**四个消费方**，它们以前各写各的、能力还不一样：
 *   - `compat/imageMarkdown.ts`：图片段 → md 时算 `#宽px #高px`（认 PNG/JPEG/GIF/WebP）；
 *   - `Render/index.ts` 的 `getImageMetadata`：卡片渲染后取尺寸（**只认 PNG/JPEG**）；
 *   - `QqPanel.toMarkdownImage` / `ImageSlice`：取不到就退到 ffprobe，再取不到就**猜**一个。
 *
 * 各写各的直接后果：**同一张 WebP 在一条链路上能读出来、在另一条上读不出来**，读不出来的
 * 那条只能猜个尺寸填进去 —— 用户看到的就是「图片被强制拉伸了」（猜的框和真实比例对不上）。
 *
 * 所以这里收成一个**无依赖的叶子模块**（只碰 Buffer，不 import 任何东西），
 * 四条链路共用它，格式覆盖一次就全都覆盖。放在 `compat/` 是因为
 * `karin/module/**` 引用 `compat/**` 是本仓库既有的方向（见 ImageSlice、Render 的 import）。
 *
 * ## 覆盖的格式
 *
 * PNG / JPEG / GIF / WebP 四种 —— 这四个是实测在群里出现过的：卡片是 JPEG、
 * 二维码与渲染图是 PNG、实况图封面是 WebP、表情包偶有 GIF。
 * 认不出的（AVIF、HEIC 这类）返回 0，调用方按「尺寸未知」处理，
 * **绝不要拿猜出来的尺寸去发 markdown 图片**（那就会拉伸）。
 */
/** 读出来的尺寸；认不出的格式两个字段都是 0 */
export interface ImageSize {
  width: number
  height: number
}

const UNKNOWN: ImageSize = { width: 0, height: 0 }

/** PNG 的魔数（8 字节） */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const isPng = (buffer: Buffer): boolean =>
  buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_MAGIC)

const isJpeg = (buffer: Buffer): boolean =>
  buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8

const isGif = (buffer: Buffer): boolean =>
  buffer.length >= 10 && buffer.toString('latin1', 0, 3) === 'GIF'

const isWebp = (buffer: Buffer): boolean =>
  buffer.length >= 30 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP'

/**
 * JPEG 里找 SOF 段。
 *
 * 尺寸在 SOF0..SOF15 的 `height(2) / width(2)` 上，但中间夹着 DHT / DAC / RST 这些
 * **不是 SOF** 的段（0xC4 / 0xC8 / 0xCC 要跳过），所以得逐段跳着找。
 */
function readJpegSize (buffer: Buffer): ImageSize {
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = buffer[offset + 1]
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
    }
    const length = buffer.readUInt16BE(offset + 2)
    if (length <= 0) break
    offset += 2 + length
  }
  return UNKNOWN
}

/**
 * WebP 三种头的写法完全不一样：
 *   - `VP8X`（扩展）：24 位小端，值 = 真实值 - 1；
 *   - `VP8L`（无损）：21 位起 14 位宽 + 14 位高，都 = 真实值 - 1；
 *   - `VP8 `（有损）：帧头里两个 16 位小端，取低 14 位。
 * 少了任何一种，那类 WebP 的尺寸就会「读不出来」。
 */
function readWebpSize (buffer: Buffer): ImageSize {
  const format = buffer.toString('latin1', 12, 16)
  if (format === 'VP8X') {
    return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) }
  }
  if (format === 'VP8L') {
    const bits = buffer.readUInt32LE(21)
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
  }
  if (format === 'VP8 ') {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
  }
  return UNKNOWN
}

/**
 * 读图片真实像素尺寸（认不出返回 `{ width: 0, height: 0 }`）。
 *
 * @param buffer 图片二进制
 * @returns 尺寸；未知时为 0
 */
export function readImageSize (buffer: Buffer): ImageSize {
  try {
    if (!buffer || !buffer.length) return UNKNOWN
    // PNG：IHDR 就在固定偏移（8 字节魔数 + 4 长度 + 4 类型 = 16）
    if (isPng(buffer) && buffer.length >= 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
    }
    if (isJpeg(buffer)) return readJpegSize(buffer)
    // GIF：逻辑屏幕描述符，小端
    if (isGif(buffer)) return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
    if (isWebp(buffer)) return readWebpSize(buffer)
    /**
     * 都不认：退一格试 **APNG / 带前置噪声的 JPEG**（有些图床会在前面塞一小段数据）。
     * 这一步只是「在 buffer 里找 PNG/JPEG 签名」，找到就从那里重新解析 —— 成本极低，
     * 但能救回「明明是很普通的图却说尺寸未知」的情况。
     */
    const pngAt = buffer.indexOf(PNG_MAGIC)
    if (pngAt > 0 && buffer.length >= pngAt + 24) {
      return { width: buffer.readUInt32BE(pngAt + 16), height: buffer.readUInt32BE(pngAt + 20) }
    }
    const jpegAt = buffer.indexOf(Buffer.from([0xff, 0xd8, 0xff]))
    if (jpegAt > 0) return readJpegSize(buffer.subarray(jpegAt))
    return UNKNOWN
  } catch {
    // 截断的图片（下载到一半）会让 readUInt* 抛 RangeError —— 当成「读不出」处理
    return UNKNOWN
  }
}

/** 尺寸是否可用（两个值都是正整数） */
export const isUsableSize = (size: ImageSize | undefined | null): boolean =>
  !!size && Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0

/**
 * 按**真实比例**把尺寸缩到目标宽度以内。
 *
 * 这是「不许拉伸」的唯一出口：宽高**必须来自同一次测量**、并按同一个比例缩放，
 * 绝不能一边用真实值、一边用猜的值（那样必然拉伸）。
 * @param size 真实尺寸
 * @param maxWidth 显示宽度上限（不放大，只缩小）
 */
export const scaleToWidth = (size: ImageSize, maxWidth: number): ImageSize => {
  const width = Math.min(size.width, maxWidth)
  return { width, height: Math.max(1, Math.round((size.height * width) / size.width)) }
}
