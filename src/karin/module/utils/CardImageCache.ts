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

/** 按钮种类：封面 / 评论区 */
export type CardImageKind = 'cover' | 'comment'

/** 作品 → 图 */
const store = new Map<string, CardImages>()
/** 会话 → 最近一次解析的作品键（不带参数手敲指令时的兜底） */
const lastBySession = new Map<string, string>()

/**
 * 回调按钮的「已经点过了」记录：`${作品键}|${种类}` → 谁点的、什么时候。
 *
 * ## 为什么需要它（用户要求）
 *
 * 「提取封面图 / 提取评论区图片」是 **QQ 原生回调按钮**：点一下就把载荷回调给机器人，
 * QQ 那边不会记住「已经点过」，**按钮一直可以点**。于是有人会一直点，
 * 群里就被同一张图刷屏（用户原话：「最多只能触发一次，不然点一直点，不知道谁在刷屏」）。
 *
 * 所以这里记一笔：**同一张卡片上的同一个按钮只放行一次**，后面的点击静默忽略、只记日志。
 *   - 作用域是「作品 + 种类」，不是「人」：封面和评论区是两个按钮，互不影响；
 *   - **重新解析会重新武装**：新卡片发出去时会 {@link rememberCardImages}（顺便清掉旧记录），
 *     所以「想再要一次」只要重发链接，不会被永久锁死；
 *   - 手敲指令（`kkk封面 bilibili:BV…`）**不走这里**，随时都能用，留一条明确的路；
 *   - 跟着 {@link TTL_MS} 一起过期：图都过期了，记录留着也没意义。
 */
const extracted = new Map<string, { at: number, by: string }>()

/** 记录键 */
function extractedKeyOf (key: string, kind: CardImageKind): string {
  return String(key ?? '') + '|' + kind
}

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
  for (const [key, item] of extracted) {
    if (now - item.at > TTL_MS) extracted.delete(key)
  }
}

/**
 * 记下本次解析的图。
 *
 * **只补传进来的那几项**：详情页发完先记封面，评论渲染完再补评论区，
 * 后一次调用不会把前一次记的封面抹掉。
 *
 * 顺带**重新武装**这次记的那几种图对应的按钮：新卡片要发出去了，
 * 它下面的按钮应该可以再点一次（旧卡片上的那次点击不作数）。
 * @param key {@link cardImageKeyOf}
 * @param patch 要记录的内容
 */
export function rememberCardImages (key: string, patch: { cover?: string, comment?: string[], commentPics?: string[] }): void {
  if (!key) return
  sweep()
  const prev = store.get(key)
  const next: CardImages = prev ?? { key, at: Date.now() }
  next.at = Date.now()
  if (patch.cover) {
    next.cover = patch.cover
    extracted.delete(extractedKeyOf(key, 'cover'))
  }
  if (patch.comment?.length) {
    next.comment = patch.comment
    extracted.delete(extractedKeyOf(key, 'comment'))
  }
  if (patch.commentPics?.length) {
    next.commentPics = patch.commentPics
    extracted.delete(extractedKeyOf(key, 'comment'))
  }
  store.set(key, next)
}

/**
 * 占一次「卡片按钮已经点过了」。**只有 QQ 回调按钮走这里**（手敲指令不调）。
 *
 * 先占后发、发失败再 {@link releaseCardImageExtract}：
 * 反过来「先发成功再记」的话，快速连点会有几次同时通过检查，照样能刷出好几条。
 * @param key 作品键（{@link cardImageKeyOf}）
 * @param kind 封面还是评论区
 * @param by 点击者（用于日志里认出「谁在刷屏」）
 * @returns 第一次点返回 `true`（放行）；之前已经点过返回 `false`
 */
export function claimCardImageExtract (key: string, kind: CardImageKind, by: string): boolean {
  if (!key) return true
  sweep()
  const id = extractedKeyOf(key, kind)
  if (extracted.has(id)) return false
  extracted.set(id, { at: Date.now(), by: String(by ?? '') })
  return true
}

/** 撤销一次占用（这次没发出去 —— 过期、没图、发送报错 —— 不该算「点过了」） */
export function releaseCardImageExtract (key: string, kind: CardImageKind): void {
  if (!key) return
  extracted.delete(extractedKeyOf(key, kind))
}

/**
 * 这个按钮是不是已经点过了（日志用：带上是谁点的）。
 * @param key 作品键
 * @param kind 封面还是评论区
 */
export function recallCardImageExtract (key: string, kind: CardImageKind): { at: number, by: string } | undefined {
  if (!key) return undefined
  return extracted.get(extractedKeyOf(key, kind))
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
