/**
 * QQ 卡片消息解析（小程序卡片 / 分享卡片）。
 *
 * **为什么需要它**：群里转发的 B站/抖音卡片大多**没有链接**，只有标题和封面。
 * kkk 的解析入口靠正则找 URL，这类消息就完全没反应（用户看到的就是「卡片信息没办法解析」）。
 *
 * **思路**（照搬 qq-chat 的 OCR 方案）：
 *   1. 先把卡片里的字段挖出来（标题 / 描述 / 作者 / 封面 / 跳转链接）；
 *   2. 有链接的直接用；
 *   3. 没链接但有封面 → **OCR 封面**（OCR.space 免费接口）拿到文字；
 *   4. 从 OCR 文本里认 UP 主名 / 标题 → 去平台**搜索**定位到唯一作品 → 得到规范链接；
 *   5. 拿到链接后走原有的解析流程，后面的面板/画质/发送全部复用。
 *
 * B站没有现成的搜索接口（amagi 只给了抖音搜索），所以这里自带一份 **Wbi 签名搜索**实现。
 */
import { createHash } from 'node:crypto'

import { logger } from 'node-karin'

import { tryGetRuntime } from '../../../compat/runtime'
import { Config } from './Config'

/** 卡片里挖出来的信息 */
export type CardInfo = {
  /** 卡片标题 */
  title: string
  /** 卡片描述（可能是空的） */
  desc: string
  /** 作者 / 来源名 */
  author: string
  /** 封面图 URL */
  cover: string
  /** 卡片自带的跳转链接（有就不能浪费） */
  link: string
  /** 卡片来源（如「哔哩哔哩」） */
  source?: string
  /** 原始 JSON（调试用） */
  raw?: any
}

/** Wbi 签名的置换表（B站前端固定的那一份） */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52
]

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

/** 还原 JSON 转义（卡片文本里 URL 的斜杠是转义过的） */
const unescapeJson = (input: string): string =>
  String(input ?? '')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\"/g, '"')

/** 从任意字符串里扒出第一个 JSON 对象（卡片消息就是一大坨 JSON） */
const pickJsonObject = (text: string): any | null => {
  const source = unescapeJson(text)
  const start = source.indexOf('{')
  if (start < 0) return null
  // 括号配对找结尾，避免 JSON 后面还跟着别的文本
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (inString) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try { return JSON.parse(source.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  return null
}

/** 深度优先找一个键对应的值（卡片 JSON 结构五花八门，别硬编码路径） */
const deepFind = (node: any, keys: string[], depth = 0): string => {
  if (!node || depth > 6) return ''
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = deepFind(item, keys, depth + 1)
      if (hit) return hit
    }
    return ''
  }
  if (typeof node !== 'object') return ''
  for (const key of keys) {
    const value = node[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const hit = deepFind(value, keys, depth + 1)
      if (hit) return hit
    }
  }
  return ''
}

/**
 * QQ 把卡片转成的**摘要文本**长这样（实测）：
 * ```
 * [卡片消息] 小程序
 * 摘要: [QQ小程序]四不相被鬼压床，了？
 * source: 哔哩哔哩
 * source_logo: http://miniapp.gtimg.cn/...
 * title: 四不相被鬼压床，了？
 * preview: https://qq.ugcimg.cn/v1/...
 * ```
 * 注意它**不是 JSON**（早期版本是 JSON 卡片，现在的适配器直接给摘要），
 * 所以按行解析；source 那一行还直接告诉了我们平台，比猜准得多。
 */
const parseCardSummary = (text: string): CardInfo | null => {
  if (!text.includes('[卡片消息]')) return null
  const pick = (label: string): string => {
    const matched = text.match(new RegExp('^\\s*' + label + '\\s*[:：]\\s*(.+)$', 'm'))
    return matched ? matched[1].trim() : ''
  }
  const summary = pick('摘要')
  const source = pick('source')
  const title = pick('title')
  const preview = pick('preview')
  if (!title && !preview && !summary) return null
  return {
    title: title || summary.replace(/^\[QQ小程序\]/, ''),
    desc: summary,
    author: '',
    cover: preview,
    link: '',
    source
  }
}

export const extractCardInfo = (content: string): CardInfo | null => {
  const text = unescapeJson(content ?? '')
  // 现在的适配器给的是摘要文本，老版本才是 JSON 卡片 —— 两种都认
  const fromSummary = parseCardSummary(text)
  if (fromSummary) return fromSummary
  if (!text.includes('{')) return null
  const json = pickJsonObject(text)
  if (!json) return null

  const title = deepFind(json, ['title', 'prompt'])
  const desc = deepFind(json, ['desc', 'description'])
  const author = deepFind(json, ['nickname', 'author', 'name', 'source'])
  const cover = deepFind(json, ['preview', 'cover', 'imageUrl', 'image_url', 'picture', 'icon'])
  const link = deepFind(json, ['jumpUrl', 'jump_url', 'qqdocurl', 'url', 'targetUrl', 'webUrl'])
  if (!title && !cover && !link) return null
  // URL 可能被 JSON 转义拆散，统一再还原一次
  return {
    title,
    desc,
    author,
    cover: unescapeJson(cover),
    link: unescapeJson(link),
    raw: json
  }
}

/* ------------------------------------------------------------------ *
 * OCR
 * ------------------------------------------------------------------ */

const ocrCache = new Map<string, string>()

/**
 * 识别图片里的文字（OCR.space 免费接口，key 可在配置里覆盖）。
 * @param imageUrl 图片地址
 */
export const ocrImageText = async (imageUrl: string): Promise<string> => {
  const url = String(imageUrl ?? '').trim()
  if (!url) return ''
  if (ocrCache.has(url)) return ocrCache.get(url)!

  /**
   * OCR 密钥的取值顺序：
   *   1. Koishi 控制台里的插件配置项 ocrApiKey
   *   2. 上游 config.json 的 app.ocrApiKey
   *   3. 公共测试 key helloworld（极容易被限流、返回空结果，仅兜底）
   */
  const fromKoishi = String((tryGetRuntime()?.config as any)?.ocrApiKey ?? '').trim()
  const key = String(fromKoishi || (Config.app as any)?.ocrApiKey || 'helloworld').trim() || 'helloworld'
  logger.debug('[卡片解析] OCR key: ' + (key === 'helloworld' ? 'helloworld（公共测试 key）' : key.slice(0, 4) + '****'))
  /**
   * OCR.space 的免费 key（helloworld）**会被限流**：短时间连打几次就返回 200 但 ParsedText 为空
   * （实测同一个 URL 单独调能识别出「UP主 / 粉丝 / 播放」那几行）。所以空结果要重试一次，
   * 并把原始响应打进日志，避免下次又只能看到一行空的「OCR 结果:」。
   */
  const callOnce = async (): Promise<{ text: string; raw: any }> => {
    const api =
      'https://api.ocr.space/parse/imageurl?apikey=' + encodeURIComponent(key) +
      '&language=chs&isOverlayRequired=false&scale=true&url=' + encodeURIComponent(url)
    const response = await fetch(api, { headers: { 'User-Agent': UA } })
    const json: any = await response.json()
    if (json?.IsErroredOnProcessing) throw new Error(String(json?.ErrorMessage || 'OCR 处理失败'))
    const text = String((json?.ParsedResults ?? []).map((item: any) => item?.ParsedText ?? '').join('\n')).trim()
    return { text, raw: json }
  }

  try {
    let { text, raw } = await callOnce()
    if (!text) {
      // 限流最常见：等一下再试一次
      await new Promise((resolve) => setTimeout(resolve, 2500))
      const retry = await callOnce()
      text = retry.text
      raw = retry.raw
      if (!text) {
        logger.warn('[卡片解析] OCR 两次都返回空，原始响应: ' + JSON.stringify(raw).slice(0, 300))
      }
    }
    if (text) logger.mark('[卡片解析] OCR 结果: ' + text.replace(/\s+/g, ' ').slice(0, 120))
    if (ocrCache.size > 200) ocrCache.clear()
    ocrCache.set(url, text)
    return text
  } catch (error: any) {
    logger.warn('[卡片解析] OCR 失败: ' + String(error?.message ?? error))
    return ''
  }
}

/**
 * 从 OCR 文本里认 UP 主名。
 * B站个人卡片的排版是「昵称 / UP主 / 粉丝数…」，所以拿「UP主」上一行最稳。
 */
export const extractUpName = (text: string): string => extractUpNames(text)[0] ?? ''

/** 明显不是昵称的标签词 */
const NICK_LABELS = new Set(['up', 'up主', 'upzhu', 'v', '粉丝', '关注', '获赞', '播放', '点赞', '弹幕', '投币', '收藏', '转发', '评论', '分享', '投稿', '作品', '简介', '主页', '更多', '展开', '未知', '半身像'])

/**
 * 从 OCR 文本里认**所有可能**的 UP 主名（按可能性排序）。
 *
 * 为什么要多个：B站个人卡片实测长这样（OCR 把结构压扁了、顺序也不一定）——
 *
 *     雾小霜暗区突围 1,052 半身像 UP主 4993粉丝 1,087 *未知" 5.3万播放1806点赞 11弹幕
 *
 * 真名是**第一行的「雾小霜暗区突围」**，而「UP主」前一行是「半身像」（封面上的字）。
 * 只取「UP主前一行」这条老规则就会拿「半身像」去搜，标题又对不上，于是六个候选一个都不敢选。
 * 现在两条都当候选（首行 + UP主前后行），搜索端**任一命中**就算作者对上，
 * 谁真的搜得到就用谁 —— 不再赌某一种排版。
 */
export const extractUpNames = (text: string): string[] => {
  const raw = String(text ?? '')
  // OCR 有时整段只有一行（空格分隔），这时按空白切
  const byLine = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const tokens = byLine.length >= 2 ? byLine : raw.split(/[\s\u3000|/]+/).map((item) => item.trim()).filter(Boolean)
  const isStat = (line: string) =>
    /(粉丝|播放|点赞|弹幕|投币|收藏|关注|转发|评论|分享|投稿)/.test(line) ||
    /^[\d,.]+(\.\d+)?[万亿]?$/.test(line) ||
    /^[*＊·.]+$/.test(line)
  const clean = (line: string): string => line
    .replace(/^[*＊·\s]+/, '')
    .replace(/[*＊·\s]+$/, '')
    .replace(/["“”'']/g, '')
    .trim()
  const candidates: string[] = []
  const push = (line?: string) => {
    if (!line) return
    const value = clean(line)
    if (value.length < 2 || value.length > 20) return
    if (isStat(value)) return
    if (NICK_LABELS.has(value.toLowerCase())) return
    if (/^[\d,.万]+$/.test(value)) return
    if (!candidates.includes(value)) candidates.push(value)
  }
  // ① UP主 前后各一行/一个词
  const idx = tokens.findIndex((token) => /^(up主|up|upzhu)$/i.test(clean(token)))
  if (idx > 0) push(tokens[idx - 1])
  if (idx >= 0) push(tokens[idx + 1])
  // ② 第一行（B站卡片昵称就在最上面）
  push(tokens[0])
  // ③ 任何一行像「粉丝数」这种统计的**前面**一行
  const statIdx = tokens.findIndex((token) => /粉丝|关注/.test(token))
  if (statIdx > 0) push(tokens[statIdx - 1])
  return candidates
}

/* ------------------------------------------------------------------ *
 * B站搜索（自带 Wbi 签名）
 * ------------------------------------------------------------------ */

const normalizeText = (text: string): string =>
  String(text ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/[\s\u3000\-—_~·，。！？!?、（）()【】\[\]"'“”‘’]/g, '')
    .toLowerCase()

/** 二元组相似度（标题匹配用，够用且不引依赖） */
const titleSimilarity = (left: string, right: string): number => {
  const a = String(left ?? '')
  const b = String(right ?? '')
  if (!a || !b) return 0
  if (a === b) return 1
  const grams = (text: string): Set<string> => {
    const set = new Set<string>()
    for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2))
    return set
  }
  const setA = grams(a)
  const setB = grams(b)
  if (!setA.size || !setB.size) return 0
  let hit = 0
  for (const gram of setA) if (setB.has(gram)) hit++
  return (2 * hit) / (setA.size + setB.size)
}

/** 取 Wbi 签名用的 img_key / sub_key */
const getWbiKeys = async (): Promise<{ imgKey: string; subKey: string; buvid3: string }> => {
  const headers = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }
  let buvid3 = ''
  let imgKey = ''
  let subKey = ''
  try {
    const spi: any = await (await fetch('https://api.bilibili.com/x/frontend/finger/spi', { headers })).json()
    buvid3 = spi?.data?.b_3 ?? ''
  } catch { /* 拿不到就空着 */ }
  try {
    const nav: any = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { headers })).json()
    const imgUrl = String(nav?.data?.wbi_img?.img_url ?? '')
    const subUrl = String(nav?.data?.wbi_img?.sub_url ?? '')
    imgKey = imgUrl.slice(imgUrl.lastIndexOf('/') + 1, imgUrl.lastIndexOf('.'))
    subKey = subUrl.slice(subUrl.lastIndexOf('/') + 1, subUrl.lastIndexOf('.'))
  } catch { /* 同上 */ }
  if (!imgKey || !subKey) {
    imgKey = '7cd084941338484aae1ad9425b84077c'
    subKey = '4932caff0ff746eab6f01bf08b70ac45'
  }
  return { imgKey, subKey, buvid3 }
}

/** B站关键词搜索，返回按「标题 + 作者」打分排序的结果 */
export const searchBiliVideos = async (
  keyword: string,
  title = '',
  author: string | string[] = '',
  limit = 8
): Promise<Array<{ bvid: string; title: string; author: string; score: number; titleMatch: boolean; authorMatch: boolean; matchedAuthor: string }>> => {
  try {
    const { imgKey, subKey, buvid3 } = await getWbiKeys()
    const mixinKey = MIXIN_KEY_ENC_TAB.map((n) => (imgKey + subKey)[n]).join('').slice(0, 32)
    const wts = Math.round(Date.now() / 1000)
    const params: Record<string, string> = { search_type: 'video', keyword: String(keyword ?? '').trim(), wts: String(wts) }
    const query = Object.keys(params)
      .sort()
      .map((key) => encodeURIComponent(key) + '=' + encodeURIComponent(params[key].replace(/[!'()*]/g, '')))
      .join('&')
    const wRid = createHash('md5').update(query + mixinKey).digest('hex')
    const headers: Record<string, string> = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }
    if (buvid3) headers.Cookie = 'buvid3=' + buvid3
    const json: any = await (
      await fetch('https://api.bilibili.com/x/web-interface/wbi/search/type?' + query + '&w_rid=' + wRid, { headers })
    ).json()
    if (json?.code !== 0) {
      logger.warn('[卡片解析] B站搜索失败: ' + String(json?.message ?? json?.code))
      return []
    }
    const raw = Array.isArray(json?.data?.result) ? json.data.result : []
    const titleKey = normalizeText(title || keyword)
    /**
     * 作者可以有**多个候选**（卡片摘要里的那个 + OCR 认出来的那几个），
     * 结果只要命中任意一个就算作者对上了，用命中的那个算分。
     */
    const authorKeys = (Array.isArray(author) ? author : [author])
      .map((item) => normalizeText(item))
      .filter((item, index, list) => item.length >= 2 && list.indexOf(item) === index)
    return raw
      .filter((item: any) => item?.bvid)
      .map((item: any, index: number) => {
        const itemTitle = String(item.title ?? '').replace(/<[^>]*>/g, '')
        const itemAuthor = String(item.author ?? '')
        const t = normalizeText(itemTitle)
        const a = normalizeText(itemAuthor)
        let score = 0
        let titleMatch = false
        let authorMatch = false
        let matchedAuthor = ''
        for (const authorKey of authorKeys) {
          if (!a) break
          if (a === authorKey) { score += 120; authorMatch = true; matchedAuthor = authorKey; break }
          if (a.includes(authorKey) || authorKey.includes(a)) {
            // 模糊命中：分少一点，并且只取最好的那次
            if (!authorMatch) { score += 70; matchedAuthor = authorKey }
            authorMatch = true
          }
        }
        if (titleKey && t) {
          if (t === titleKey) { score += 100; titleMatch = true }
          else if (t.includes(titleKey) || titleKey.includes(t)) { score += 60; titleMatch = true }
          else {
            const sim = titleSimilarity(t, titleKey)
            if (sim >= 0.5) titleMatch = true
            score += Math.round(sim * 40)
          }
        }
        return { bvid: String(item.bvid), title: itemTitle, author: itemAuthor, score: score - index, titleMatch, authorMatch, matchedAuthor }
      })
      .sort((left: any, right: any) => right.score - left.score)
      .slice(0, Math.max(1, Math.min(20, limit)))
  } catch (error: any) {
    logger.warn('[卡片解析] B站搜索异常: ' + String(error?.message ?? error))
    return []
  }
}

/* ------------------------------------------------------------------ *
 * 对外入口
 * ------------------------------------------------------------------ */

/**
 * 把一条**卡片消息**变成可解析的链接。
 *
 * 有链接直接返回；没有链接就 OCR 封面，再按平台搜索定位作品。
 * 任何一步失败都返回 null（调用方据此走原来的「未找到链接」逻辑，不影响已有功能）。
 */
export type CardCandidate = {
  /** 卡片解析只可能落在 B站上（抖音没有卡片消息） */
  platform: 'bilibili' | 'douyin'
  id: string
  title: string
  author: string
  score: number
}

export const resolveCardToUrl = async (
  content: string
): Promise<{
  url?: string
  platform: 'bilibili' | 'douyin'
  card: CardInfo
  /** 搜到但不确定唯一时的候选（交给用户用 md 表格挑） */
  candidates: CardCandidate[]
  ocrText: string
  upName: string
} | null> => {
  const card = extractCardInfo(content)
  if (!card) return null

  // ① 卡片自带链接：最省事
  if (card.link && /^https?:\/\//i.test(card.link)) {
    const platform = /bilibili\.com|b23\.tv|bili2233/i.test(card.link) ? 'bilibili' : 'douyin'
    return { url: card.link, platform, card }
  }
  if (!card.cover) {
    logger.mark('[卡片解析] 卡片既没有链接也没有封面，无法解析: ' + card.title)
    return null
  }

  // ② OCR 封面拿文字线索
  const ocrText = await ocrImageText(card.cover)
  /**
   * UP 主名可以有好几个来源：卡片摘要里的 author、OCR 里「UP主」前后行、OCR 首行。
   *
   * 实测踩过的坑：卡片摘要给的是「半身像」（封面上的字），OCR 首行才是真昵称
   * 「雾小霜暗区突围」—— 只认一个来源时，作者永远匹配不上，六个候选一个都不敢选。
   * 这里全部当候选，谁匹配上算谁的。
   */
  const upNames = [card.author, ...extractUpNames(ocrText)]
    .map((item) => String(item ?? '').trim())
    .filter((item, index, list) => item.length >= 2 && list.indexOf(item) === index)
  const upName = upNames[0] ?? ''
  const keyword = card.title || upName || ocrText.replace(/\s+/g, ' ').slice(0, 40)
  if (!keyword) {
    logger.mark('[卡片解析] OCR 没有给出可用关键词')
    return null
  }

  // ③ B站搜一把：标题 + 作者都对上才自动继续，否则把候选交给用户挑
  const tryBili = async (): Promise<{ url?: string; candidates: CardCandidate[]; matchedAuthor?: string }> => {
    const hits = await searchBiliVideos(keyword, card.title, upNames, 8)
    const candidates = hits.slice(0, 6).map((item) => ({
      platform: 'bilibili' as const, id: item.bvid, title: item.title, author: item.author, score: item.score
    }))
    const strict = hits.filter((item) => item.authorMatch || item.titleMatch)
    // 只有「标题和作者都命中」才敢自动继续，否则交给用户挑
    const best = (strict.length ? strict : hits)[0]
    if (best && best.titleMatch && best.authorMatch) {
      logger.mark('[卡片解析] 作者命中「' + (best.matchedAuthor || '') + '」：' + best.author + '，标题: ' + best.title)
      return { url: 'https://www.bilibili.com/video/' + best.bvid, candidates, matchedAuthor: best.author }
    }
    return { candidates }
  }
  /**
   * **只搜 B站**：抖音没有卡片消息这种玩法（那条「当前接口库没有抖音搜索能力」的日志就是
   * 以前多此一举地搜抖音留下的）。卡片解析这条链路只处理 B站卡片（入口处已经按 source 过滤过），
   * 少搜一个平台就少一次风控风险、也少几秒等待。
   */
  const hit = await tryBili()
  const candidates: CardCandidate[] = hit.candidates
  if (hit.url) {
    logger.mark('[卡片解析] 定位成功: ' + hit.url)
    // 提示语里报「真正匹配上的那个 UP 名」，而不是卡片摘要里那个不准的
    return { url: hit.url, platform: 'bilibili', card, candidates, ocrText, upName: hit.matchedAuthor || upName }
  }

  logger.mark('[卡片解析] 没能唯一定位（标题: ' + card.title + '，UP: ' + upName + '），候选 ' + candidates.length + ' 条')
  if (candidates.length) {
    return { platform: candidates[0].platform, card, candidates, ocrText, upName }
  }
  return null
}

/* ------------------------------------------------------------------ *
 * B站搜索（自带 Wbi 签名）
 * ------------------------------------------------------------------ */
