/**
 * QQ 卡片「无链接」还原。
 *
 * QQ 官方适配器把分享卡片整段当文本丢进来，而新版卡片**连跳转链接都没有**，
 * 于是各平台的链接正则一条都匹配不上 —— 用户侧的表现就是「卡片发出来没反应」。
 * 这里把卡片（详见 compat/qqcard.ts）还原成一条规范链接，追加到消息文本末尾，
 * 让原有的解析命令照常命中：命令本身仍按前缀匹配，普通消息完全不受影响。
 *
 * 匹配策略（强 → 弱）：
 *   1. 卡片自带 B 站链接（b23.tv / bilibili.com）→ 直接规范化；
 *   2. 卡片封面哈希 == 搜索结果的 \`pic\` 哈希 → 同一张稿件封面，直接认定；
 *   3. 标题包含/相等（打分 ≥ 60）→ 认定。
 * 认不出来就**不还原**，宁可让下游提示「未找到链接」，也不要猜错视频解析出别人的内容。
 */
import { logger } from 'node-karin'

import { parseQqCards, type QqCard } from '../../../compat/qqcard'
import { extractUrls, normalizeMessageText } from '../../../compat/text'
import { resolveBiliCanonicalUrl, searchBilibiliVideos } from '@/platform/bilibili/search'

/** B 站链接特征（消息里已经有链接就不用还原了） */
const BILI_URL = /bilibili\.com|b23\.tv|bili2233|\bBV[0-9A-Za-z]{10}\b/i

/** 还原结果缓存：同一条卡片消息会被匹配、命令、统计等多处读取，没必要重复搜索 */
const cache = new Map<string, string>()
const CACHE_LIMIT = 64

/** 认不认这条搜索结果 */
const isConfident = (item: { coverMatch: boolean; score: number }): boolean => item.coverMatch || item.score >= 60

/** 纯平台名/占位词，拿去搜索只会搜到无关视频 */
const GENERIC_TITLE = /^(哔哩哔哩|bilibili|视频|弹幕|分享|网页链接|抖音|快手|小红书)+$/i

/**
 * 标题是否值得拿去搜索。
 * 卡片字段缺失时标题可能是「哔哩哔哩」这类来源名，与其拿它赌一个视频，不如放弃还原。
 * @param title 卡片标题
 */
const isSearchableTitle = (title: string): boolean => {
  const key = String(title ?? '').replace(/\s+/g, '')
  return key.length >= 4 && !GENERIC_TITLE.test(key)
}

/**
 * 把一张 B 站卡片还原成规范视频链接。
 * @param card 卡片
 * @returns 规范链接；无法确定时返回空串
 */
export async function resolveBiliCard (card: QqCard): Promise<string> {
  const inline = card.urls.find((url) => BILI_URL.test(url) || /\bBV[0-9A-Za-z]{10}\b/.test(url))
  if (inline) return await resolveBiliCanonicalUrl(inline)
  if (!isSearchableTitle(card.title)) {
    logger.debug('[QQ卡片] 标题「' + card.title + '」过于宽泛，放弃搜索还原')
    return ''
  }

  const items = await searchBilibiliVideos({
    keyword: card.title,
    title: card.title,
    author: card.author,
    cover: card.cover,
    limit: 8
  })
  const best = items.find(isConfident)
  if (!best) {
    logger.debug('[QQ卡片] 标题「' + card.title + '」没有找到足够可信的B站视频，放弃还原' + (items[0] ? '（最高分 ' + items[0].score + '：' + items[0].title + '）' : ''))
    return ''
  }
  logger.debug('[QQ卡片] 还原B站视频: ' + best.title + ' → ' + best.bvid + '（分数 ' + best.score + (best.coverMatch ? '，封面命中' : '') + '）')
  return 'https://www.bilibili.com/video/' + best.bvid
}

/**
 * 归一化一条消息文本：JSON 转义还原 + 已有链接提取 + 无链接卡片搜索还原。
 *
 * 普通消息走同步快路径（一次 \`includes('{')\` 就返回），只有疑似卡片的文本才会触发网络搜索。
 * @param content 原始消息文本
 * @returns 可交给解析命令的文本
 */
export async function resolveQqCardContent (content: string): Promise<string> {
  const raw = String(content ?? '')
  const base = normalizeMessageText(raw)
  if (!raw || !raw.includes('{')) return base

  const cached = cache.get(raw)
  if (cached !== undefined) return cached

  const result = await resolveCards(raw, base)
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
  cache.set(raw, result)
  return result
}

/** 实际的还原逻辑（与缓存分开，便于阅读） */
async function resolveCards (raw: string, base: string): Promise<string> {
  const cards = parseQqCards(raw)
  if (!cards.length) return base
  // 已经有 B 站链接的消息不用还原：解析命令自己就能处理短链
  if (extractUrls(base).some((url) => BILI_URL.test(url))) return base

  const targets = cards.filter((card) => card.platform === 'bilibili' && isSearchableTitle(card.title)).slice(0, 2)
  if (!targets.length) return base

  const extra: string[] = []
  for (const card of targets) {
    try {
      const url = await resolveBiliCard(card)
      if (url && !base.includes(url) && !extra.includes(url)) extra.push(url)
    } catch (error) {
      logger.debug('[QQ卡片] 还原失败: ' + String(error))
    }
  }
  return extra.length ? base + ' ' + extra.join(' ') : base
}

export default resolveQqCardContent
