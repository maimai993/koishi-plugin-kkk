/**
 * QQ 分享卡片解析 + 「无链接卡片」还原。
 *
 * ## 背景
 * QQ 官方适配器（koishi-plugin-adapter-qq-crack，platform=\`qqguild\`）把卡片消息**整段塞进文本**，
 * 不同来源的卡片长的也不一样，常见三种：
 *
 * \`\`\`text
 * // 1. 小程序卡片（B站/抖音），meta.detail_1 里带 qqdocurl
 * {"app":"com.tencent.structmsg","meta":{"detail_1":{"qqdocurl":"https:\\/\\/b23.tv\\/xxxx"}}}
 * // 2. 新版分享卡片，链接在 meta.news.jumpUrl
 * {"app":"com.tencent.structmsg","view":"news","meta":{"news":{"tag":"哔哩哔哩","title":"...","jumpUrl":"..."}}}
 * // 3. 只有标题和封面，**一个链接都没有**（QQ 端把跳转吞了）
 * {"app":"com.tencent.miniapp_01","desc":"哔哩哔哩","meta":{"detail_1":{"appid":"1109937557","title":"..."}}}
 * \`\`\`
 *
 * 第 3 种是纯解析链路救不回来的：插件拿到的文本里没有 URL，各平台的链接正则必然匹配不到。
 * koishi-plugin-qq-chat 的做法是「标题 + 封面 OCR 出的 UP 主」去 B 站搜索匹配；
 * 这里做得更直接 —— 卡片封面往往就是 B 站图床的稿件封面，
 * 直接用**封面哈希**和搜索结果里的 \`pic\` 对齐（见 platform/bilibili/search.ts），
 * 哈希认不出来再退化成标题/作者打分。
 *
 * 因此本模块只做两件事：
 *   1. {@link parseQqCards}：把消息文本里的卡片 JSON 挖出来，归一化成 {@link QqCard}；
 *   2. {@link resolveCardsInText}：对「没有链接的 B 站卡片」做搜索还原，把规范链接追加到文本末尾，
 *      让下游的解析命令照常命中（命令本身仍按前缀匹配，不受影响）。
 */

/** 平台标识 */
export type QqCardPlatform = 'bilibili' | 'douyin' | 'kuaishou' | 'xiaohongshu' | 'unknown'

/** 归一化后的 QQ 卡片 */
export interface QqCard {
  /** ark 的 app 字段，例如 com.tencent.structmsg */
  app: string
  /** ark 的 view 字段，例如 news */
  view: string
  /** 归一化出的平台 */
  platform: QqCardPlatform
  /** 标题（优先 meta 里的 title，其次 desc / prompt） */
  title: string
  /** 描述文本 */
  desc: string
  /** UP 主 / 作者（卡片里有就取，没有留空） */
  author: string
  /** 封面图地址 */
  cover: string
  /** 卡片里能挖到的所有 http(s) 链接 */
  urls: string[]
  /** 原始 JSON 对象 */
  raw: any
}

/** 小程序 appid → 平台 */
const APPID_PLATFORM: Record<string, QqCardPlatform> = {
  // 哔哩哔哩小程序
  '1109937557': 'bilibili',
  // 抖音小程序
  '1109937556': 'douyin',
  '1110083189': 'douyin',
  // 快手小程序
  '1109937559': 'kuaishou'
}

/** 文本特征 → 平台 */
const TEXT_PLATFORM: Array<{ platform: QqCardPlatform; pattern: RegExp }> = [
  { platform: 'bilibili', pattern: /哔哩哔哩|bilibili|b23\.tv|bili2233|\bBV[0-9A-Za-z]{10}\b/i },
  { platform: 'douyin', pattern: /抖音|douyin|iesdouyin/i },
  { platform: 'kuaishou', pattern: /快手|kuaishou/i },
  { platform: 'xiaohongshu', pattern: /小红书|xiaohongshu|xhslink/i }
]

/** 取字段用的键名表 */
const TITLE_KEYS = /^(title|desc|description|summary|subtitle|prompt|tag|source|from|appname)$/i
/**
 * 「真标题」键名。
 *
 * 必须和 {@link TITLE_KEYS} 区分开：ark 里 `desc`/`tag` 是「哔哩哔哩」这种来源名，
 * 而它们**排在 title 前面**，混在一起取第一个字段会把来源名当成视频标题
 * （后果是拿「哔哩哔哩」去搜索，匹配到完全无关的视频）。
 */
const REAL_TITLE_KEY = /^title$/i
const COVER_KEYS = /^(preview|icon|image|imageurl|picurl|pic|cover|coverurl|thumb|thumbnail|img|imgurl|headimg)$/i
const URL_KEYS = /^(jumpurl|qqdocurl|url|contenturl|shareurl|link|targeturl|weburl|h5url|pageurl|sourceurl)$/i
const AUTHOR_KEYS = /^(author|nickname|nick|upname|up_name|username|name|uploader)$/i

/** JSON 转义还原（与 compat/text.ts 保持同一套规则，但这里要能解析回对象） */
function unescapeJson (input: string): string {
  return input
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/\\u0026/gi, '&')
}

/**
 * 从一段文本里挖出所有「括号配平」的 JSON 对象字面量。
 *
 * 不能用 \`/\{[^{}]*\}/\` 这类正则：ark 是嵌套结构，正则只能匹配到最内层；
 * 也不能按 \`{"app"\` 切分：一张卡片里可能同时出现多个对象（实测有 \`meta\` 和 \`config\`）。
 * 所以老老实实扫一遍括号，并且**跳过字符串内部的括号**（卡片里就有标题带花括号的）。
 * @param text 原始文本
 * @returns JSON 子串数组
 */
export function extractJsonObjects (text: string): string[] {
  const result: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; continue }
    if (char === '{') {
      if (depth === 0) start = i
      depth += 1
      continue
    }
    if (char === '}') {
      if (depth > 0) {
        depth -= 1
        if (depth === 0 && start >= 0) result.push(text.slice(start, i + 1))
      }
      continue
    }
  }
  return result
}

/** 递归收集卡片里的文本 / 封面 / 链接 / 作者字段（保持出现顺序，去重） */
function collectFields (node: any, bucket: { titles: string[]; texts: string[]; covers: string[]; urls: string[]; authors: string[]; appids: string[] }, depth = 0): void {
  if (!node || typeof node !== 'object' || depth > 8) return
  if (Array.isArray(node)) {
    for (const item of node) collectFields(item, bucket, depth + 1)
    return
  }
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string') {
      const text = value.trim()
      if (!text) continue
      if (key === 'appid') { bucket.appids.push(text); continue }
      const isUrlLike = /^https?:\/\//i.test(text) || text.startsWith('//')

      // 判定顺序很关键：按「键名」判断必须早于「值长得像 URL」。
      // 卡片封面（preview/icon）的值本身就是 http 链接，先按值判会把封面当跳转链接收进 urls，
      // 结果就是 cover 永远是空 —— 封面哈希这条最硬的匹配路径直接失效。
      if (URL_KEYS.test(key) && !COVER_KEYS.test(key)) { bucket.urls.push(text); continue }
      if (COVER_KEYS.test(key)) {
        if (isUrlLike) bucket.covers.push(text)
        continue
      }
      if (REAL_TITLE_KEY.test(key)) { bucket.titles.push(text); continue }
      if (TITLE_KEYS.test(key)) { bucket.texts.push(text); continue }
      if (AUTHOR_KEYS.test(key)) { bucket.authors.push(text); continue }
      if (isUrlLike) { bucket.urls.push(text); continue }
      // 兜底：任何字符串里的 URL 也收进来（有的卡片把链接塞在 desc 里）
      const matched = text.match(/https?:\/\/[^\s"'<>\\]+/gi)
      if (matched) for (const url of matched) bucket.urls.push(url)
      continue
    }
    if (value && typeof value === 'object') collectFields(value, bucket, depth + 1)
  }
}

/** 判定平台：appid 优先，其次看所有文本里的平台特征 */
function detectPlatform (bucket: { titles: string[]; texts: string[]; covers: string[]; urls: string[]; appids: string[] }, app: string, view: string): QqCardPlatform {
  for (const appid of bucket.appids) {
    const platform = APPID_PLATFORM[appid]
    if (platform) return platform
  }
  const haystack = [...bucket.titles, ...bucket.texts, ...bucket.covers, ...bucket.urls, app, view].join(' ')
  for (const { platform, pattern } of TEXT_PLATFORM) {
    if (pattern.test(haystack)) return platform
  }
  return 'unknown'
}

/** 从已经 JSON.parse 好的对象里归一化出一张卡片 */
export function toQqCard (raw: any): QqCard | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.app !== 'string' && !raw.meta && !raw.prompt) return null

  const bucket = { titles: [] as string[], texts: [] as string[], covers: [] as string[], urls: [] as string[], authors: [] as string[], appids: [] as string[] }
  if (typeof raw.appid === 'string') bucket.appids.push(raw.appid)
  collectFields(raw, bucket)

  const app = typeof raw.app === 'string' ? raw.app : ''
  const view = typeof raw.view === 'string' ? raw.view : ''
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.replace(/^\[[^\]]*\]\s*/, '') : ''

  const unique = (list: string[]) => [...new Set(list.filter(Boolean))]
  const texts = unique(bucket.texts)
  const title = unique(bucket.titles)[0] ?? texts[0] ?? prompt
  const desc = texts.find((text) => text !== title) ?? ''

  return {
    app,
    view,
    platform: detectPlatform(bucket, app, view),
    title,
    desc,
    author: unique(bucket.authors)[0] ?? '',
    cover: unique(bucket.covers)[0] ?? '',
    urls: unique(bucket.urls),
    raw
  }
}

/**
 * 解析一段消息文本里的所有 QQ 卡片。
 * 普通聊天文本（没有 JSON 对象）返回空数组，代价只有一次括号扫描。
 * @param input 消息原文（可以是 JSON 转义过的）
 */
export function parseQqCards (input: string): QqCard[] {
  const text = String(input ?? '')
  if (!text.includes('{')) return []
  const cards: QqCard[] = []
  const seen = new Set<string>()

  for (const snippet of extractJsonObjects(text)) {
    for (const candidate of [snippet, unescapeJson(snippet)]) {
      try {
        const card = toQqCard(JSON.parse(candidate))
        if (!card) continue
        const key = card.app + '|' + card.title + '|' + card.urls.join(',')
        if (seen.has(key)) continue
        seen.add(key)
        cards.push(card)
        break
      } catch {
        // 不是合法 JSON 就换下一种写法
      }
    }
  }
  return cards
}

/** 从卡片封面里取出 B 站图床的稿件哈希（\`.../bfs/archive/<hash>.jpg\`） */
export function coverArchiveHash (url: unknown): string {
  const matched = String(url ?? '').match(/\/bfs\/archive\/([0-9a-f]+)(?:\.\w+)?/i)
  return matched ? matched[1].toLowerCase() : ''
}

export default parseQqCards
