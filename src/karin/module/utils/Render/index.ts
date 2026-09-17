/**
 * 渲染模块（Koishi 移植版）。
 *
 * 上游链路：ktr（\`@karinjs/template-react\`）把 \`template/**\` 打成 SSR 外壳 → 出 HTML → Karin render 截图。
 * Koishi 侧不引入 ktr 的构建管线（需要 vite/tailwind 打包），改为：
 *   1. 直接用 **react-dom/server** 对上游模板组件做 SSR（模板只依赖 \`{ data, ctx }\` props）；
 *   2. 内联上游构建产物 \`resources/template/style.css\`（tailwind 编译结果，省掉 tailwind 构建）；
 *   3. 用 koishi-plugin-puppeteer 截图。
 * 路由不在注册表里、或 SSR 失败时，回退到内置通用信息卡片，保证解析结果始终有图。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { getKoishiContext, logger, segment } from 'node-karin'
import { karinPathHtml } from 'node-karin/root'
import { PassThrough } from 'node:stream'

import React from 'react'
import { renderToPipeableStream } from 'react-dom/server'

import { importEsm } from '../../../../compat/esm'
import { loadTemplate } from '../../../../ktr/registry'
import { Root } from '@/module/utils'
import { Config } from '@/module/utils/Config'

import { resolveUseDarkTheme } from './coverTheme'

type ImageMetadata = { width?: number; height?: number }

/* ------------------------------------------------------------------ *
 * 样式
 * ------------------------------------------------------------------ */

let cachedCss: string | null = null

/** 读取并修正模板样式（上游产物里的字体指向 Karin 本地服务，换成相对路径，加载失败则回退系统字体） */
function loadTemplateCss (): string {
  if (cachedCss !== null) return cachedCss
  try {
    const cssPath = path.resolve(Root.pluginPath, 'resources', 'template', 'style.css')
    const raw = fs.readFileSync(cssPath, 'utf8')
    cachedCss = raw.replace(/url\("?http:\/\/localhost:\d+\/config\/commonResource\//g, 'url("./template-fonts/')
  } catch (error: any) {
    logger.debug('[Render] 读取模板样式失败，将使用无样式渲染: ' + String(error?.message ?? error))
    cachedCss = ''
  }
  return cachedCss
}

/* ------------------------------------------------------------------ *
 * 兜底卡片
 * ------------------------------------------------------------------ */

const escapeHtml = (input: unknown): string =>
  String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** 递归时不往里看的键（Koishi 的 ctx / 适配器实例等，读属性会触发「未注册」警告且毫无意义） */
const PICK_SKIP_KEYS = new Set([
  'ctx', 'app', 'root', 'scope', 'bot', 'session', 'event', 'logger', 'config',
  '_events', '_eventsCount', 'adapter', 'http', 'internal', 'socket', 'parser',
  'target', 'parent', 'children', 'prototype', 'constructor'
])

/** 只递归纯对象与数组：类实例（ctx / Bot / Session…）一律不深入 */
const isPlainSource = (value: any): boolean => {
  if (Array.isArray(value)) return true
  if (!value || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const pickFirst = (source: any, keys: string[], depth = 3, seen: Set<any> = new Set()): any => {
  if (!source || typeof source !== 'object' || depth < 0) return undefined
  // 防环（对象互相引用时会无限递归）
  if (seen.has(source)) return undefined
  seen.add(source)
  for (const key of keys) {
    if (PICK_SKIP_KEYS.has(key)) continue
    const value = source[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  for (const [key, value] of Object.entries(source)) {
    if (PICK_SKIP_KEYS.has(key)) continue
    if (isPlainSource(value)) {
      const found = pickFirst(value, keys, depth - 1, seen)
      if (found !== undefined) return found
    }
  }
  return undefined
}

const asText = (value: any): string => {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) {
    const parts = value.map((item) => (item && typeof item === 'object' ? item.text ?? item.desc ?? '' : item)).filter(Boolean)
    return parts.join('')
  }
  return String(value.text ?? value.desc ?? value.title ?? '')
}

const formatCount = (value: any): string => {
  const num = Number(value)
  if (!Number.isFinite(num)) return ''
  if (num >= 100000000) return (num / 100000000).toFixed(1) + '亿'
  if (num >= 10000) return (num / 10000).toFixed(1) + '万'
  return String(num)
}

/** 从渲染数据里尽力提取通用卡片需要的字段 */
function extractCardData (data: any) {
  const title = asText(pickFirst(data, ['title', 'desc', 'dynamicTitle', 'name']))
  const author = asText(pickFirst(data, ['nickname', 'nick', 'author', 'name', 'uname']))
  const avatar = asText(pickFirst(data, ['avatar', 'face', 'avatarUrl', 'head_url']))
  const cover = asText(pickFirst(data, ['cover', 'coverUrl', 'originCover', 'pic', 'dynamicCover', 'image']))
  const description = asText(pickFirst(data, ['desc', 'description', 'dynamicText', 'summary', 'content']))
  const stats = [
    ['点赞', pickFirst(data, ['digg_count', 'like', 'likes'])],
    ['评论', pickFirst(data, ['comment_count', 'comments', 'reply'])],
    ['收藏', pickFirst(data, ['collect_count', 'favorite', 'favorites'])],
    ['分享', pickFirst(data, ['share_count', 'share', 'repost'])],
    ['播放', pickFirst(data, ['play', 'view', 'views', 'playCount'])]
  ]
    .map(([label, value]) => [label as string, formatCount(value)] as const)
    .filter(([, value]) => !!value)

  return { title, author, avatar, cover, description, stats }
}

/** 兜底卡片：不依赖模板，直接用通用字段渲染一张信息卡 */
export function buildFallbackHtml (route: string, data: any, dark: boolean, scale: number): string {
  const card = extractCardData(data)
  const bg = dark ? '#101014' : '#f4f5f7'
  const fg = dark ? '#f7f8fa' : '#1c1f23'
  const sub = dark ? '#a7abb3' : '#6b7280'
  const coverHtml = card.cover ? '<div class="cover" style="background-image:url(' + escapeHtml(card.cover) + ')"></div>' : ''
  const statsHtml = card.stats.length
    ? '<div class="stats">' + card.stats.map(([label, value]) => '<span><b>' + escapeHtml(value) + '</b>' + escapeHtml(label) + '</span>').join('') + '</div>'
    : ''

  return '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8"><style>\n' +
    '  * { box-sizing: border-box; margin: 0; padding: 0; }\n' +
    '  body { background: ' + bg + '; color: ' + fg + '; font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif; }\n' +
    '  #container { width: 720px; padding: 20px; }\n' +
    '  .card { border-radius: 18px; background: ' + (dark ? '#1b1c20' : '#ffffff') + '; overflow: hidden; box-shadow: 0 12px 32px rgba(0,0,0,.12); zoom: ' + scale + '; }\n' +
    '  .cover { width: 100%; height: 380px; background-size: cover; background-position: center; background-color: #2a2c31; }\n' +
    '  .body { padding: 20px 24px 26px; }\n' +
    '  .route { font-size: 13px; color: ' + sub + '; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 10px; }\n' +
    '  .title { font-size: 26px; font-weight: 700; line-height: 1.35; word-break: break-word; }\n' +
    '  .author { display: flex; align-items: center; gap: 10px; margin-top: 14px; color: ' + sub + '; font-size: 16px; }\n' +
    '  .author img { width: 34px; height: 34px; border-radius: 50%; object-fit: cover; }\n' +
    '  .desc { margin-top: 16px; font-size: 16px; line-height: 1.7; color: ' + sub + '; white-space: pre-wrap; word-break: break-word; }\n' +
    '  .stats { display: flex; gap: 26px; margin-top: 20px; font-size: 14px; color: ' + sub + '; }\n' +
    '  .stats b { display: block; font-size: 20px; color: ' + fg + '; }\n' +
    '  .footer { margin-top: 18px; font-size: 12px; color: ' + sub + '; }\n' +
    '</style></head>\n<body><div id="container"><div class="card">\n' +
    coverHtml +
    '\n  <div class="body">\n' +
    '    <div class="route">' + escapeHtml(route) + '</div>\n' +
    '    <div class="title">' + escapeHtml(card.title || '解析结果') + '</div>\n' +
    (card.author
      ? '    <div class="author">' + (card.avatar ? '<img src="' + escapeHtml(card.avatar) + '" />' : '') + '<span>' + escapeHtml(card.author) + '</span></div>\n'
      : '') +
    (card.description ? '    <div class="desc">' + escapeHtml(card.description.slice(0, 600)) + '</div>\n' : '') +
    (statsHtml ? '    ' + statsHtml + '\n' : '') +
    '    <div class="footer">koishi-plugin-kkk v' + escapeHtml(Root.pluginVersion) + ' · 模板渲染未启用，当前为内置通用卡片</div>\n' +
    '  </div>\n</div></div></body></html>'
}

/* ------------------------------------------------------------------ *
 * 模板 SSR
 * ------------------------------------------------------------------ */

/**
 * 页脚那个「框架 logo」。
 *
 * 上游 karin 是起 HTTP 服务把 `/image/frame-logo.png` 喂给浏览器的；
 * Koishi 移植版渲染的是**本地 HTML 文件**，绝对路径 `/image/...` 会指向磁盘根目录，
 * 于是卡片页脚只剩下一个裂图（alt 文字 `logo`）。这里直接内联成 data URI。
 */
let frameLogoCache: string | null = null
function resolveFrameLogo (): string {
  if (frameLogoCache !== null) return frameLogoCache
  /**
   * 页脚 logo：用 **Koishi 自己的图标**（@koishijs/plugin-console 里那张，
   * 也就是控制台左上角那个），而不是上游 karin 的 frame-logo。
   */
  const candidates = [
    path.join(Root.pluginPath, '..', '@koishijs', 'plugin-console', 'dist', 'logo.png'),
    path.join(Root.pluginPath, '..', '@koishijs', 'client', 'app', 'assets', 'logo.png'),
    path.join(Root.pluginPath, 'resources', 'image', 'frame-logo.png')
  ]
  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue
      frameLogoCache = 'data:image/png;base64,' + fs.readFileSync(filePath).toString('base64')
      return frameLogoCache
    } catch { /* 换下一个 */ }
  }
  frameLogoCache = ''
  return frameLogoCache
}

/** 组装模板上下文（与上游 Render/index.ts 一致） */
export function buildPosterContext (dark: boolean) {
  return {
    scale: Math.min(2, Math.max(0.5, Number(Config.app?.renderScale ?? 100) / 100)),
    theme: { mode: dark ? ('dark' as const) : ('light' as const) },
    version: {
      plugin: 'koishi-plugin',
      pluginName: 'kkk',
      pluginVersion: Root.pluginVersion,
      releaseType: /^\d+\.\d+\.\d+$/.test(Root.pluginVersion) ? ('Stable' as const) : ('Preview' as const),
      poweredBy: 'Koishi',
      frameworkVersion: Root.karinVersion,
      // 页脚 logo（data URI，见 resolveFrameLogo）
      frameLogo: resolveFrameLogo(),
      hasUpdate: false
    },
    ambientCover: {
      coverOpacity: (Config.app as any)?.ambientCover?.coverOpacity,
      overlayEdgeOpacity: (Config.app as any)?.ambientCover?.overlayEdgeOpacity,
      overlayMiddleOpacity: (Config.app as any)?.ambientCover?.overlayMiddleOpacity
    }
  }
}

/** 二维码生成器只加载一次（ESM-only 包，只能在 SSR 前异步 import） */
let qrcodeReady: Promise<void> | null = null

async function ensureQrcodeGenerator (): Promise<void> {
  if (!qrcodeReady) {
    qrcodeReady = (async () => {
      const [qrcode, utils] = await Promise.all([
        importEsm<any>('@ikenxuan/qrcode'),
        Promise.resolve(require('../../../../ktr/utils/QRcode'))
      ])
      if (typeof qrcode.generateSync === 'function') {
        (utils as any).setQrcodeGenerator(qrcode.generateSync)
      }
    })().catch((error: any) => {
      logger.debug('[Render] 二维码生成器加载失败: ' + String(error?.message ?? error))
    })
  }
  return qrcodeReady
}

/**
 * 把 React 元素渲染成 HTML 字符串。
 *
 * 用流式 API 而不是同步的 renderToStaticMarkup：部分上游模板会 suspend
 * （React 19 的 `use()` / 异步资源），同步渲染会直接抛
 * "A component suspended while responding to synchronous input" 而整块回退成通用卡片。
 * 流式渲染会等挂起的内容就绪（onAllReady）再产出完整 HTML。
 */
async function renderToHtml (element: React.ReactElement, timeoutMs = 15000): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let html = ''
    const stream = new PassThrough()
    stream.on('data', (chunk) => { html += chunk.toString() })
    stream.on('end', () => resolve(html))
    stream.on('error', reject)

    let settled = false
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    const { pipe, abort } = renderToPipeableStream(element, {
      onError: (error) => logger.debug('[Render] SSR 渲染期错误: ' + String((error as any)?.message ?? error)),
      onShellError: fail,
      onAllReady: () => {
        if (settled) return
        settled = true
        pipe(stream)
      }
    })

    setTimeout(() => {
      if (settled) return
      abort()
      fail(new Error('SSR 渲染超时'))
    }, timeoutMs).unref?.()
  })
}

/** 用上游模板做 SSR；路由不支持或失败时返回 null */
export async function renderTemplateHtml (route: string, data: any, dark: boolean): Promise<string | null> {
  await ensureQrcodeGenerator()
  let template: any
  try {
    template = await loadTemplate(route)
  } catch (error: any) {
    logger.debug('[Render] 模板 ' + route + ' 加载失败（可能缺少依赖）: ' + String(error?.message ?? error))
    return null
  }
  if (!template?.component) return null
  if (typeof template.validate === 'function' && !template.validate(data)) {
    logger.debug('[Render] 模板 ' + route + ' 的数据校验未通过，回退通用卡片')
    return null
  }

  try {
    const ctx = buildPosterContext(dark)
    const element = React.createElement(template.component, { data, ctx })
    const body = await renderToHtml(React.createElement('div', { id: 'container' }, element))
    const css = loadTemplateCss()
    const themeClass = dark ? 'dark' : ''
    /**
     * 截图专用的覆盖样式：
     *   - 页面不要外边距/内边距，也不要白色背景（否则卡片圆角外面会透出白边、底部会多一条空白）；
     *   - 卡片**不要圆角** —— 圆角会让四个角露出页面底色，看起来就是卡片缺了一角。
     * 只压掉最外层的圆角，内部小元素（头像、标签）保持原样。
     */
    const shotCss = 'html,body{margin:0!important;padding:0!important;background:transparent!important;overflow:hidden!important}'
      + '#container{margin:0!important;padding:0!important;border-radius:0!important}'
      + '#container>div,#container>div>div{border-radius:0!important}'
      + 'body{display:inline-block}'
    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>' + css + shotCss + '</style></head>'
      + '<body class="' + themeClass + '">' + body + '</body></html>'
  } catch (error: any) {
    logger.warn('[Render] 模板 ' + route + ' SSR 失败，回退通用卡片: ' + String(error?.message ?? error))
    return null
  }
}

/* ------------------------------------------------------------------ *
 * 截图
 * ------------------------------------------------------------------ */

/**
 * 用 koishi-plugin-puppeteer 对一个 HTML 文件截图，返回 base64。
 *
 * `scale` 会作为 deviceScaleFactor（配置项 `app.renderScale`，100 = 1x，200 = 2x）：
 * 不设的话高分辨率卡片会被截成 1x，群里看着又小又糊；顺带把视口撑到整张卡片大小，
 * 否则比视口高的卡片会被裁掉一截（表现就是「截图只有一部分」）。
 */
async function screenshot (htmlPath: string, selector: string, timeout: number, scale = 1, format: 'png' | 'jpeg' = 'jpeg'): Promise<string> {
  const puppeteer: any = (getKoishiContext() as any)?.puppeteer
  if (!puppeteer) throw new Error('未安装 koishi-plugin-puppeteer，无法渲染图片')

  // 卡片是给手机看的：**低于 2x 会明显发虚**，所以下限锁 2（上限 3）。
  // 想更大更清晰就调 `app.renderScale`（100 → 2x，150 → 3x），配 100 时保持 2x 不出错。
  const requested = Number.isFinite(scale) && scale > 0 ? scale * 2 : 2
  let deviceScaleFactor = Math.min(3, Math.max(2, requested))
  // 安全阀：超大页面降一档缩放，避免单次渲染吃掉几 GB 内存（曾经把实例 OOM 崩掉）
  try {
    if (fs.statSync(htmlPath).size > 6 * 1024 * 1024) deviceScaleFactor = Math.max(1, deviceScaleFactor - 1)
  } catch { /* 忽略 */ }

  /**
   * 视口用卡片的**设计宽度**（模板都按 1440 排版），高度按内容量一次。
   *
   * 之前试过「量出内容自然尺寸再把视口撑到那么大」：Chrome 会为此分配超大帧缓冲，
   * 单次渲染把 node 堆吃到 3GB+ 并直接 OOM 崩掉实例。现在宽度固定、高度只增不减，
   * 并且不再用 `captureBeyondViewport`（它在大页面上内存表现同样很差）。
   */
  const DESIGN_WIDTH = 1440

  /** 在给定页面上完成「导航 → 量高度 → 截图」，返回 base64 */
  const capture = async (page: any): Promise<string> => {
    if (page.setViewport) {
      // 宽度就用卡片设计宽度：多给 24px 会多出一条白边（用户看到的「右边超出去一点」）
      await page.setViewport({ width: DESIGN_WIDTH, height: 900, deviceScaleFactor })
    }
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0', timeout })

    const metrics = await page.evaluate((sel: string) => {
      const node = document.querySelector(sel) || document.body
      const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : null
      return {
        // 用**元素自己的盒子**而不是整页 scrollHeight：整页量出来的高度会带上 body 边距，
        // 截图底部就多一条空白
        width: Math.ceil(rect?.width || node.scrollWidth || document.body.scrollWidth || 0),
        height: Math.ceil(rect?.height || node.scrollHeight || document.body.scrollHeight || 0)
      }
    }, selector).catch(() => ({ width: 0, height: 0 }))

    if (page.setViewport) {
      /**
       * 宽度按**内容实测**来：正常模板是 1440 宽，而兜底卡片只有 720 ——
       * 固定 1440 会让兜底卡片右边留一大片白。这里两者都能贴合，
       * 同时高度按内容撑够，避免长卡片被裁。
       */
      const width = Math.min(Math.max(metrics.width || DESIGN_WIDTH, 320), 1600)
      /**
       * 高度按卡片实际盒子取整（不留容差）。
       * 另外把 **页面底色设成卡片自己的底色** —— 视口哪怕只比卡片高一两个像素，
       * JPEG 里那一条也会是白色页面底，看起来就是「下面有个小白边」。
       */
      const height = Math.min(Math.max(Math.round(metrics.height), 200), 20000)
      await page.setViewport({ width, height, deviceScaleFactor })
      await page.evaluate((sel: string) => {
        try {
          const node = document.querySelector(sel) as HTMLElement | null
          if (!node) return
          const card = (node.firstElementChild as HTMLElement) || node
          const bg = getComputedStyle(card).backgroundColor
          if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
            document.documentElement.style.background = bg
            document.body.style.background = bg
          }
        } catch { /* 取不到就算了 */ }
      }, selector).catch(() => undefined)
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    }

    /**
     * 用「卡片元素自己的范围」裁切，而不是整屏截图。
     *
     * 视口宽度比卡片设计宽度多了 24px（给滚动条留余量），整屏截图会在右边多出一条白边，
     * 用户看到的就是「卡片右边超出了/有白边」。clip 只取 #container 的盒子，正好贴合卡片。
     */
    const handle = (await page.$(selector)) ?? (await page.$('body'))
    const clip = handle ? await handle.boundingBox() : null

    /**
     * 默认输出 JPEG：2x 的卡片 PNG 动辄十几 MB（带照片背景时尤其夸张），
     * 超过 QQ 的图片上传限制就会被**当成文件**发出去（用户看到的是「[文件]」而不是图片）。
     * 二维码那类需要像素级清晰的场景仍用 PNG（见 Render 里的判断）。
     */
    const buffer = await page.screenshot({
      omitBackground: format === 'png',
      type: format,
      quality: format === 'jpeg' ? 92 : undefined
    } as any)
    return buffer.toString('base64')
  }

  /**
   * 自己开一个页面截图，**不要走插件的 render() 包装**。
   *
   * 实测：1440x4895 的运行环境诊断卡片，走 `puppeteer.render()` 时仅导航一步
   * 就让 node 堆从 206MB 涨到 1407MB（首次渲染累计 +3GB，直接把宿主 OOM 崩掉）；
   * 自己 newPage + goto + 截图只涨几十 MB。所以这里优先直连浏览器，用完关掉页面。
   */
  const newPage = async (): Promise<any> => {
    try {
      if (typeof puppeteer.page === 'function') return await puppeteer.page()
      if (puppeteer.browser && typeof puppeteer.browser.newPage === 'function') return await puppeteer.browser.newPage()
    } catch (error: any) {
      logger.debug('[Render] 直连浏览器失败，退回插件 render(): ' + (error?.message ?? error))
    }
    return null
  }

  const page = await newPage()
  if (page) {
    try {
      return await capture(page)
    } finally {
      try {
        await page.close()
      } catch { /* 页面可能已被插件关掉，忽略 */ }
    }
  }

  logger.debug('[Render] 插件未暴露 page/browser，退回 puppeteer.render()')
  return await puppeteer.render('', async (page: any) => capture(page))
}

export const getImageMetadata = (buffer: Buffer): ImageMetadata => {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  // JPEG：QQ 的 markdown 图片要写死「#宽px #高px」，所以必须能读出来
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue }
      const marker = buffer[offset + 1]
      // SOF0..SOF15（跳过 DHT/DAC 等非 SOF 标记）
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
      }
      const length = buffer.readUInt16BE(offset + 2)
      if (length <= 0) break
      offset += 2 + length
    }
  }
  return {}
}

/**
 * 渲染函数（上游签名）：\`Render(event, '平台/模板', data)\` → 图片消息段数组。
 */
/**
 * 把模板里的第三方图床代理换回原图地址。
 *
 * 上游模板给头像/装扮这类图套了一层 images.weserv.nl/?url=<encoded>（本意是绕开 B站的防盗链），
 * 但那个代理在有些网络下**根本连不上** —— 表现就是卡片里 UP 主头像是个裂图。
 * 实测 B站原图直连（i0/i2.hdslb.com）不带 Referer 也是 200，所以这里直接还原成原地址。
 */
function unwrapImageProxy (html: string): string {
  return html.replace(/https:\/\/images\.weserv\.nl\/\?url=([^"'&\s]+)/gi, (all: string, encoded: string) => {
    try {
      const decoded = decodeURIComponent(encoded)
      return /^https?:\/\//i.test(decoded) ? decoded : all
    } catch {
      return all
    }
  })
}

export const Render = async (_event: any, route: string, data: any): Promise<any[]> => {
  const dark = await resolveUseDarkTheme(route, data).catch(() => false)
  const scale = Math.min(2, Math.max(0.5, Number(Config.app?.renderScale ?? 100) / 100))

  let html = await renderTemplateHtml(route, data, dark)
  if (!html) {
    html = buildFallbackHtml(route, data, dark, scale)
  }
  html = unwrapImageProxy(html)

  const htmlPath = path.resolve(karinPathHtml, Root.pluginName, route.replace(/[\\/]/g, '_') + '.html')
  try {
    fs.mkdirSync(path.dirname(htmlPath), { recursive: true })
    fs.writeFileSync(htmlPath, html, 'utf8')
    // 二维码：必须像素级清晰（JPEG 压缩会影响扫码），继续用 PNG；其它卡片用 JPEG 压体积
    const isQrCode = /qrcode/i.test(route)
    const format: 'png' | 'jpeg' = isQrCode ? 'png' : 'jpeg'
    const base64 = await screenshot(htmlPath, '#container', Number(Config.app?.RenderWaitTime ?? 10) * 1000, scale, format)
    const buffer = Buffer.from(base64, 'base64')
    const meta = getImageMetadata(buffer)
    logger.debug('[Render] ' + route + ' 渲染完成 ' + format + ' ' + (meta.width ?? '?') + 'x' + (meta.height ?? '?') + ' ' + Math.round(buffer.length / 1024) + 'KB')
    // 用带 mime 的 data URL，适配器才知道按 JPEG 上传（base64:// 会被当成 PNG）
    return [segment.image('data:image/' + format + ';base64,' + base64)]
  } catch (error: any) {
    logger.warn('[Render] ' + route + ' 渲染失败：' + (error?.message ?? error))
    return []
  }
}

export default Render
