/**
 * 解析出来的**卡片图**（封面 / 评论区）暂存处。
 *
 * ## 为什么需要它
 * 群里的卡片图都是 markdown 图片（`![...](url)`），在 QQ 上是**叠在一条消息里**的：
 * 用户想单独保存封面、或者只看评论区那张长图时，得自己去长按存图、还得在几张切片里翻。
 * 所以在卡片下面放两个按钮（「提取封面图」/「提取评论区图片」），点一下就把那张图**单独发一遍**。
 *
 * 单独发需要**再拿到一次图**，而重新解析一遍（拉接口 + 渲染）太贵了 ——
 * 这里把解析用到的图源记下来，点按钮直接发，不重新解析、不重新渲染。
 *
 * ## 缓存口径：**按「平台 + 作品 id」存，不按会话**
 * 最早是按会话（`peer`）存「最近一条」的，结果有个硬伤：
 * 群里**又有人发了另一条链接**之后，缓存就被那条覆盖了 ——
 * 这时回头点上一张卡片下面的按钮，发出来的是**另一个作品的图**。
 *
 * 所以改成按作品存：
 *   - 键是 `平台:作品id`（`bilibili:BV1JSan6GEFW` / `douyin:7123456789`），
 *     **按钮把这个键当参数带上**（`kkk封面 bilibili:BV1JSan6GEFW`），
 *     点哪张卡片下面的按钮就取哪个作品，跟后来发了什么链接无关；
 *   - 同一作品的**封面**和**评论区**是分两次记的（详情页先记封面，评论渲染完再补评论区），
 *     后一次只补自己那一项，不会把前一次抹掉；
 *   - 另外单独记一份「本会话最近解析的作品」：用户**手敲** `kkk封面` 不带参数时用得上；
 *   - **15 分钟过期**：渲染出来的评论图是本地临时文件，会被定时清理，放太久点了也是发不出来。
 */
/** 一个作品记下来的图 */
export interface CardImages {
  /** 缓存键（`平台:作品id`） */
  key: string
  /** 封面图地址（接口给的原图，稳定、不会过期） */
  cover?: string
  /** 评论区卡片图的地址（渲染产物，可能是本地临时文件，会被清理） */
  comment?: string[]
  /**
   * **评论里用户自己发的图**（`bilibiliComments` 解析出来的 `image_urls`，原始地址）。
   *
   * 和上面的 `comment` 是两回事：`comment` 是插件**渲染出来的那张评论长图**，
   * 而这个是评论区里用户贴的图。按钮要的是后者。
   */
  commentPics?: string[]
  /** 记录时间 */
  at: number
}

/** 缓存有效期：评论图是临时文件，别放太久 */
const TTL_MS = 15 * 60 * 1000

/** 作品 → 图 */
const store = new Map<string, CardImages>()
/** 会话 → 最近一次解析的作品键（不带参数手敲指令时的兜底） */
const lastBySession = new Map<string, string>()

/** 会话键 */
function sessionKeyOf (e: any): string {
  return String(e?.contact?.peer ?? e?.channelId ?? '')
}

/**
 * 作品缓存键：`平台:作品id`。
 * @param platform 平台（bilibili / douyin …）
 * @param workId 作品 id（B站 bvid、抖音 aweme_id、动态 id）
 */
export function cardImageKeyOf (platform: string, workId: unknown): string {
  const id = String(workId ?? '').trim()
  if (!id) return ''
  return String(platform ?? '') + ':' + id
}

/** 清掉过期的条目（评论图是临时文件，留着也没用） */
function sweep (): void {
  const now = Date.now()
  for (const [key, item] of store) {
    if (now - item.at > TTL_MS) store.delete(key)
  }
}

/**
 * 记下本次解析的图。
 *
 * **只补传进来的那几项**：详情页发完先记封面，评论渲染完再补评论区，
 * 后一次调用不会把前一次记的封面抹掉。
 * @param key {@link cardImageKeyOf}
 * @param patch 要记录的内容
 */
export function rememberCardImages (key: string, patch: { cover?: string, comment?: string[], commentPics?: string[] }): void {
  if (!key) return
  sweep()
  const prev = store.get(key)
  const next: CardImages = prev ?? { key, at: Date.now() }
  next.at = Date.now()
  if (patch.cover) next.cover = patch.cover
  if (patch.comment?.length) next.comment = patch.comment
  if (patch.commentPics?.length) next.commentPics = patch.commentPics
  store.set(key, next)
}

/**
 * 记下「这个会话最近解析的是哪个作品」。
 * 用户手敲 `kkk封面`（不带参数）时用它兜底 —— 按钮自己是带参数的，不走这条路。
 * @param e 消息事件
 * @param key {@link cardImageKeyOf}
 */
export function rememberLastCardKey (e: any, key: string): void {
  const session = sessionKeyOf(e)
  if (!session || !key) return
  lastBySession.set(session, key)
}

/**
 * 把用户在指令里带的参数还原成缓存键。
 *
 * 参数一般是按钮塞进去的完整键（`bilibili:BV1JSan6GEFW`）；手敲时也允许只给作品 id
 * （`kkk封面 BV1JSan6GEFW`）—— 这时在缓存里反查一条 id 对得上的。
 * @param arg 指令参数；空则回退到「本会话最近解析的作品」
 */
export function resolveCardImageKey (e: any, arg?: string): string {
  const raw = String(arg ?? '').trim()
  if (raw) {
    // 完整键（带平台前缀）：直接用，哪怕缓存里没有（让调用方能提示「过期了」而不是「没这条」）
    if (raw.includes(':')) return raw
    // 只给了作品 id：反查
    const hit = [...store.keys()].find((key) => key.split(':').slice(1).join(':') === raw)
    if (hit) return hit
    return raw
  }
  return lastBySession.get(sessionKeyOf(e)) ?? ''
}

/**
 * 取出这个作品记下来的图（过期返回 undefined）。
 * @param key {@link cardImageKeyOf}
 */
export function recallCardImages (key: string): CardImages | undefined {
  if (!key) return undefined
  const item = store.get(key)
  if (!item) return undefined
  if (Date.now() - item.at > TTL_MS) {
    store.delete(key)
    return undefined
  }
  return item
}

/**
 * 从渲染结果里把图片地址抠出来。
 *
 * 渲染出来的既可能是 `img` 段（`{ type: 'img', attrs: { src } }`），
 * 也可能是已经转好的 markdown 段（`![...](url)`），两种都要认。
 * @param elements 渲染结果（单个元素或数组）
 */
export function imageSourcesOf (elements: any): string[] {
  const list = Array.isArray(elements) ? elements : [elements]
  const urls: string[] = []
  for (const item of list) {
    if (!item) continue
    const src = item?.attrs?.src ?? item?.attrs?.url ?? item?.src ?? item?.url
    if (typeof src === 'string' && src) { urls.push(src); continue }
    /** markdown 段：`![...](url)` */
    const text = typeof item === 'string' ? item : String(item?.attrs?.content ?? item?.content ?? '')
    for (const match of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) urls.push(match[1])
  }
  return [...new Set(urls)]
}
