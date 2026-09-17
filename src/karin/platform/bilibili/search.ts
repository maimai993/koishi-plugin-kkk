/**
 * B 站视频搜索（按标题 / UP 主定位视频）。
 *
 * 用途：QQ 的 B 站小程序卡片**经常不带链接**（只有标题和封面图），解析命令拿不到 URL。
 * 这里按标题搜索 → 用「作者命中 + 标题命中 + 标题相似度」打分排序，挑出最可能的那条视频，
 * 再交给正常的解析链路。
 *
 * 实现参考了 koishi-plugin-qq-chat 的 \`biliSearchVideos\` / \`getBiliWbiKeys\` / \`encWbi\`：
 * B 站搜索接口需要 **Wbi 签名**（nav 取 img_key/sub_key，按固定表重排成 mixinKey，再拼参数算 w_rid），
 * 并带一个 buvid3 Cookie，否则返回 -412 风控。
 */
import crypto from 'node:crypto'

import { logger } from 'node-karin'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'

/** Wbi mixinKey 重排表（B 站前端固定表，与 qq-chat 一致） */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52
]

interface WbiKeys { imgKey: string; subKey: string; buvid3: string }

let wbiCache: WbiKeys | null = null
let wbiFetchedAt = 0

/** 取 Wbi 签名用的 key（缓存 1 小时；失败时退回内置 key） */
async function getWbiKeys (force = false): Promise<WbiKeys> {
  if (!force && wbiCache && Date.now() - wbiFetchedAt < 60 * 60 * 1000) return wbiCache
  const headers = { 'User-Agent': UA, Referer: REFERER }
  let buvid3 = ''
  let imgKey = ''
  let subKey = ''

  try {
    const spi = await fetch('https://api.bilibili.com/x/frontend/finger/spi', { headers })
    const json: any = await spi.json()
    buvid3 = json?.data?.b_3 ?? ''
  } catch (error) {
    logger.debug('[B站搜索] 取 buvid3 失败: ' + String(error))
  }

  try {
    const nav = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers })
    const json: any = await nav.json()
    const imgUrl: string = json?.data?.wbi_img?.img_url ?? ''
    const subUrl: string = json?.data?.wbi_img?.sub_url ?? ''
    imgKey = imgUrl.slice(imgUrl.lastIndexOf('/') + 1, imgUrl.lastIndexOf('.'))
    subKey = subUrl.slice(subUrl.lastIndexOf('/') + 1, subUrl.lastIndexOf('.'))
  } catch (error) {
    logger.debug('[B站搜索] 取 wbi key 失败: ' + String(error))
  }

  if (!imgKey || !subKey) {
    imgKey = '7cd084941338484aae1ad9425b84077c'
    subKey = '4932caff0ff746eab6f01bf08b70ac45'
  }
  wbiCache = { imgKey, subKey, buvid3 }
  wbiFetchedAt = Date.now()
  return wbiCache
}

/** 拼 Wbi 签名查询串 */
function encWbi (params: Record<string, string>, imgKey: string, subKey: string): string {
  const mixinKey = MIXIN_KEY_ENC_TAB.map((index) => (imgKey + subKey)[index]).join('').slice(0, 32)
  const wts = Math.round(Date.now() / 1000)
  const signed: Record<string, string> = { ...params, wts: String(wts) }
  const query = Object.keys(signed)
    .sort()
    .map((key) => key + '=' + encodeURIComponent(String(signed[key]).replace(/[!'()*]/g, '')))
    .join('&')
  const wRid = crypto.createHash('md5').update(query + mixinKey).digest('hex')
  return query + '&w_rid=' + wRid
}

/** 去 HTML 标签与转义 */
export function stripHtml (text: unknown): string {
  return String(text ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

/** 标题/昵称归一化：去空白、标点、大小写（用于比对） */
export function normalizeBiliText (text: unknown): string {
  return stripHtml(text).replace(/[\s\u3000\-—_~·，。！？!?、（）()【】\[\]"'“”‘’]/g, '').toLowerCase()
}

/** 标题相似度：字符二元组 Dice 系数 */
export function biliTitleSimilarity (left: unknown, right: unknown): number {
  const a = String(left ?? '')
  const b = String(right ?? '')
  if (!a || !b) return 0
  if (a === b) return 1
  const grams = (text: string) => {
    const set = new Set<string>()
    for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2))
    return set
  }
  const setA = grams(a)
  const setB = grams(b)
  if (!setA.size || !setB.size) return 0
  let hit = 0
  for (const gram of setA) if (setB.has(gram)) hit += 1
  return (2 * hit) / (setA.size + setB.size)
}

export interface BiliSearchItem {
  bvid: string
  title: string
  author: string
  pic: string
  play?: number
  duration?: string
  score: number
  titleMatch: boolean
  authorMatch: boolean
  /** 封面哈希与卡片封面一致（B 站稿件封面就是 `/bfs/archive/<hash>.jpg`，比标题匹配硬得多） */
  coverMatch: boolean
}

export interface BiliSearchOptions {
  /** 搜索关键词（一般传标题） */
  keyword: string
  /** 期望标题，用于打分 */
  title?: string
  /** 期望 UP 主，用于打分 */
  author?: string
  /** 期望封面地址（QQ 卡片封面），命中的结果直接置顶 */
  cover?: string
  limit?: number
}

/** 封面地址归一化成哈希（`//i0.hdslb.com/bfs/archive/xxx.jpg` → `xxx`） */
export function biliPicHash (url: unknown): string {
  const matched = String(url ?? '').match(/\/bfs\/archive\/([0-9a-f]+)(?:\.\w+)?/i)
  return matched ? matched[1].toLowerCase() : ''
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 调一次搜索接口。
 *
 * 实测这个接口偶发返回空列表（同一关键词隔 2 秒再打就有结果），也会因为签名过期返回 -412，
 * 所以失败要**换一份 wbi key 重试**，而不是直接把「没搜到」当成结论 ——
 * 卡片还原只有一次机会，静默返回空等于用户侧「卡片还是解析不了」。
 * @param keyword 关键词
 * @returns 结果条目（失败时返回空数组）
 */
async function requestSearch (keyword: string): Promise<any[]> {
  const attempts = 3
  for (let index = 0; index < attempts; index++) {
    try {
      const { buvid3, imgKey, subKey } = await getWbiKeys(index > 0)
      const headers: Record<string, string> = { 'User-Agent': UA, Referer: REFERER }
      if (buvid3) headers.Cookie = 'buvid3=' + buvid3
      const signed = encWbi({ search_type: 'video', keyword }, imgKey, subKey)
      const response = await fetch('https://api.bilibili.com/x/web-interface/wbi/search/type?' + signed, { headers })
      const json: any = await response.json()
      if (json?.code !== 0) {
        logger.debug('[B站搜索] 接口返回错误: ' + (json?.message ?? json?.code) + '（第 ' + (index + 1) + ' 次）')
      } else {
        const list: any[] = Array.isArray(json?.data?.result) ? json.data.result : []
        if (list.length) return list
        logger.debug('[B站搜索] 返回空结果（第 ' + (index + 1) + ' 次）')
      }
    } catch (error) {
      logger.debug('[B站搜索] 请求失败: ' + String(error) + '（第 ' + (index + 1) + ' 次）')
    }
    if (index < attempts - 1) await sleep(600 * (index + 1))
  }
  return []
}

/**
 * 按关键词搜索视频并打分排序。
 * @returns 排序后的结果（第一条最可能是目标视频）
 */
export async function searchBilibiliVideos (options: BiliSearchOptions): Promise<BiliSearchItem[]> {
  const keyword = String(options.keyword ?? '').trim()
  if (!keyword) return []
  let raw = await requestSearch(keyword)
  if (!raw.length) return []

  const titleKey = normalizeBiliText(options.title || keyword)
  const authorKey = normalizeBiliText(options.author || '')
  const coverKey = biliPicHash(options.cover)

  /**
   * 封面哈希是「同一稿件」最硬的证据，但搜索接口的 `pic` 字段偶发下发占位图
   * （`static.hdslb.com/images/transparent.gif`），这时无论卡片封面是什么都比不上。
   * 只要请求里还有条目根本没带封面，就再取一次 —— 拿到真封面就走硬匹配，
   * 还是占位图才退回标题/作者打分。只多花一次请求，代价可控。
   */
  if (coverKey) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const hit = raw.some((item) => biliPicHash(item?.pic) === coverKey)
      const missing = raw.some((item) => !biliPicHash(item?.pic))
      if (hit || !missing) break
      const retry = await requestSearch(keyword)
      if (retry.length) raw = retry
    }
  }

  const scored = raw
    .filter((item) => item && item.bvid)
    .map((item, index) => {
      const titleText = stripHtml(item.title)
      const authorText = String(item.author ?? '')
      const t = normalizeBiliText(titleText)
      const a = normalizeBiliText(authorText)
      let score = 0
      let titleMatch = false
      let authorMatch = false
      let coverMatch = false

      // 封面哈希一致 = 同一张稿件封面，直接给到压倒性权重，后面标题怎么算都不会翻盘
      if (coverKey && biliPicHash(item.pic) === coverKey) {
        score += 200
        coverMatch = true
      }
      if (authorKey && a) {
        if (a === authorKey) { score += 120; authorMatch = true }
        else if (a.includes(authorKey) || authorKey.includes(a)) { score += 70; authorMatch = true }
      }
      if (titleKey && t) {
        if (t === titleKey) { score += 100; titleMatch = true }
        else {
          /**
           * 包含关系只在关键词**足够长**时才算命中。
           * 「哔哩哔哩」这种 3~4 字的泛词能被任何标题包含，一旦按 60 分放行，
           * 卡片还原就会稳定地解析出别人的视频 —— 泛词只走相似度分支，拿不到高分。
           */
          const contained = titleKey.length >= 6 && (t.includes(titleKey) || titleKey.includes(t))
          if (contained) { score += 60; titleMatch = true }
          else {
            const sim = biliTitleSimilarity(t, titleKey)
            if (sim >= 0.5) titleMatch = true
            score += Math.round(sim * 40)
          }
        }
      }
      return {
        bvid: item.bvid as string,
        title: titleText,
        author: authorText,
        pic: item.pic ? (String(item.pic).startsWith('http') ? String(item.pic) : 'https:' + item.pic) : '',
        play: item.play,
        duration: item.duration,
        score: score - index,
        titleMatch,
        authorMatch,
        coverMatch
      }
    })
    .sort((left, right) => right.score - left.score)

  return scored.slice(0, Math.max(1, Math.min(20, options.limit ?? 8)))
}

/**
 * 把各种 B 站输入规范成 \`https://www.bilibili.com/video/BVxxxx[?p=n]\`。
 * b23.tv 短链会自己跟一次跳转（只拿 canonical URL，不依赖后续接口）。
 */
export async function resolveBiliCanonicalUrl (input: unknown): Promise<string> {
  const raw = String(input ?? '').trim()
  if (!raw) return ''
  const pickId = (text: string): string => {
    const bv = text.match(/BV[0-9A-Za-z]{10}/)
    if (bv) return bv[0]
    const av = text.match(/\bav(\d+)\b/i)
    return av ? 'av' + av[1] : ''
  }
  const withPage = (base: string, source: string): string => {
    const p = source.match(/[?&]p=(\d+)/)
    return p ? base + '?p=' + p[1] : base
  }

  if (!/^https?:/i.test(raw)) {
    const id = pickId(raw) || raw.replace(/[^0-9A-Za-z]/g, '')
    return withPage('https://www.bilibili.com/video/' + id, raw)
  }

  let url = raw
  if (/b23\.tv/i.test(url)) {
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA, Referer: REFERER } })
      if (res.url && /bilibili\.com/i.test(res.url)) url = res.url
    } catch (error) {
      logger.debug('[B站搜索] 短链跳转失败: ' + String(error))
    }
  }
  const id = pickId(url)
  return id ? withPage('https://www.bilibili.com/video/' + id, url) : url
}
