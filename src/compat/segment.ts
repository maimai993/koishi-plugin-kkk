/**
 * karin `segment` 的 Koishi 兼容实现。
 *
 * karin 的 segment 与 Koishi 的 `h`（Satori element）语义接近，
 * 这里主要补两件事：把 `base64://` / `file://` / 本地路径统一成适配器能发的资源，以及补上残留的 QQ 专有段。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { h } from 'koishi'

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.silk': 'audio/silk',
  '.amr': 'audio/amr'
}

const guessMime = (filePath: string, kind: 'image' | 'video' | 'audio' | 'file') => {
  const ext = path.extname(filePath).toLowerCase()
  if (MIME[ext]) return MIME[ext]
  if (kind === 'image') return 'image/png'
  if (kind === 'video') return 'video/mp4'
  if (kind === 'audio') return 'audio/mpeg'
  return 'application/octet-stream'
}

const asBuffer = (src: string, kind: 'image' | 'video' | 'audio' | 'file') => {
  if (src.startsWith('base64://')) {
    const raw = Buffer.from(src.slice('base64://'.length), 'base64')
    return { data: raw, type: guessMime('.' + (kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'mp3'), kind) }
  }
  if (src.startsWith('data:')) return null
  if (/^[a-z]+:\/\//i.test(src) && !src.startsWith('file://')) return null
  const filePath = src.startsWith('file://') ? fileURLToPath(src) : src
  if (!fs.existsSync(filePath)) return null
  return { data: fs.readFileSync(filePath), type: guessMime(filePath, kind) }
}

/** 把 karin 支持的资源写法统一成 Satori 元素可用的资源 */
function resource (src: any, kind: 'image' | 'video' | 'audio' | 'file'): any {
  if (Buffer.isBuffer(src) || src instanceof ArrayBuffer) return src
  if (typeof src !== 'string') return String(src ?? '')
  const buf = asBuffer(src, kind)
  if (buf) return buf.data
  if (src.startsWith('base64://')) return 'data:' + guessMime('', kind) + ';base64,' + src.slice(9)
  return src
}

/**
 * karin 的媒体段是 `{ type, file }`，而 Koishi 的元素把内容放在 `attrs.src`。
 * 上游 karin 代码经常直接读 `segment.file`（例如登录二维码：`qrimg[0].file` →
 * 落盘 + 发送），在 Koishi 下这个属性根本不存在，于是「生成二维码图片失败」。
 *
 * 这里给元素补一个**只读的 `file` 兼容属性**（不可枚举，不会进 JSON / 不会影响发送）：
 *   - data URL → 还原成 karin 习惯的 `base64://xxx`
 *   - 其它（http 链接 / 路径）原样返回
 */
function withKarinFile<T extends Record<string, any>> (element: T): T {
  if (!element || typeof element !== 'object' || 'file' in element) return element
  Object.defineProperty(element, 'file', {
    enumerable: false,
    configurable: true,
    get () {
      const src = element.attrs?.src ?? element.attrs?.url
      if (typeof src === 'string' && src.startsWith('data:')) {
        const comma = src.indexOf(',')
        return comma >= 0 ? 'base64://' + src.slice(comma + 1) : src
      }
      return src
    }
  })
  return element
}

function resElement (type: 'image' | 'video' | 'audio', src: any, ...rest: any[]) {
  if (Buffer.isBuffer(src) || src instanceof ArrayBuffer) {
    return withKarinFile(h[type](src as any, rest[0] ?? guessMime('', type === 'audio' ? 'audio' : type)))
  }
  const buf = typeof src === 'string' ? asBuffer(src, type) : null
  if (buf) return withKarinFile(h[type](buf.data as any, buf.type))
  if (typeof src === 'string' && src.startsWith('base64://')) {
    return withKarinFile(h[type](('data:' + guessMime('', type === 'audio' ? 'audio' : type) + ';base64,' + src.slice(9)) as any))
  }
  return withKarinFile(h[type](src as any))
}

/**
 * QQ 原生按钮的属性名修复。
 *
 * Koishi 的 `h()` 会把**顶层属性名** camelize（`render_data` → `renderData`），
 * 而 koishi-plugin-adapter-qq-crack 是按 snake_case 读的（`attrs.render_data`）。
 * 不改回来的话按钮渲染数据整个丢失，适配器会退化成「按钮文字 = action.data」——
 * 也就是按钮上直接糊一整条 `#解析 https://… --qn=80`。
 * 嵌套对象不会被 camelize，所以只需要补顶层这一层。
 * @param element 按钮元素
 */
function restoreButtonAttrs<T extends { attrs: Record<string, any> }> (element: T): T {
  const attrs = element.attrs
  if (attrs.renderData && !attrs.render_data) attrs.render_data = attrs.renderData
  if (attrs.visitedLabel && !attrs.visited_label) attrs.visited_label = attrs.visitedLabel
  return element
}

export const segment = {
  text: (value: any) => h.text(String(value ?? '')),
  image: (src: any, ..._rest: any[]) => resElement('image', src),
  video: (src: any, ..._rest: any[]) => resElement('video', src),
  audio: (src: any, ..._rest: any[]) => resElement('audio', src),
  record: (src: any, ..._rest: any[]) => resElement('audio', src),
  reply: (id: any) => h.quote(String(id)),
  at: (id: any) => h.at(String(id)),
  face: (id: any) => h('face', { id: String(id) }),
  file: (src: any, name?: string) => {
    // base64:// 与本地路径都要转成真正的资源再交给适配器：
    // 直接把 `base64://xxx` 字符串塞进 h.file()，适配器会去 fetch 这个地址而失败
    // （日志里就是「QQ 消息发送失败 fetch base64://AAAAHGZ0eXBpc29t…」——那是 mp4 的头）
    if (typeof src === 'string' && src.startsWith('base64://')) {
      return withKarinFile(h.file(
        Buffer.from(src.slice('base64://'.length), 'base64') as any,
        guessMime(name ?? '', 'file'),
        name ? { title: name } : undefined
      ))
    }
    if (typeof src === 'string' && fs.existsSync(src.startsWith('file://') ? fileURLToPath(src) : src)) {
      const filePath = src.startsWith('file://') ? fileURLToPath(src) : src
      return withKarinFile(h.file(fs.readFileSync(filePath) as any, guessMime(filePath, 'file'), { title: name ?? path.basename(filePath) }))
    }
    if (Buffer.isBuffer(src) || src instanceof ArrayBuffer) {
      return withKarinFile(h.file(src as any, guessMime(name ?? '', 'file'), name ? { title: name } : undefined))
    }
    return withKarinFile(h.file(src, name ? { title: name } : undefined))
  },
  /** markdown：传字符串等价于 `h('markdown', text)`；传对象则作为 attrs（如 `{ content, stream }`） */
  markdown: (content: any, ...rest: any[]) =>
    h('markdown', ...(rest.length ? rest : [content && typeof content === 'object' ? content : String(content ?? '')])),
  button: (...args: any[]) => restoreButtonAttrs(h('button', ...args) as any),
  /** QQ 原生按钮换行分组：一行最多 5 个按钮 */
  buttonGroup: (children: any[]) => h('button-group', {}, Array.isArray(children) ? children : [children]),
  count: (value: any) => h.text(String(value ?? '')),
  raw: (type: string, data: Record<string, any>) => h(type, data),
  /** 兼容 karin 的 segment 常量表 */
  Image: 'image',
  Video: 'video',
  Text: 'text',
  Reply: 'reply'
}

export default segment
