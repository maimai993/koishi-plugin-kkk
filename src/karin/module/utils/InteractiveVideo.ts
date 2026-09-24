/**
 * B站互动视频（互动视频 / stein gate）支持。
 *
 * ## 这类视频和普通视频差在哪
 *
 * 普通视频只有一个 cid，下完就发；互动视频是一张剧情图：每个节点有自己的 cid，
 * 播完要给用户几个选项（选项文本由 B站 下发，且**自带 A/B/C 前缀**），
 * 用户选了之后才跳到下一个节点的视频。
 *
 * ## 拿数据要三个接口（amagi 里没有这三个，所以自己拼 URL）
 *
 * 1. `x/web-interface/view?bvid=` → `data.rights.is_stein_gate === 1` 说明是互动视频；
 * 2. `x/player/wbi/v2?bvid=&cid=` → `data.interaction.graph_version`（剧情图版本号，
 *    必须带它才能查剧情；同一个视频改了剧情，这个号会变）；
 * 3. `x/stein/edgeinfo_v2?bvid=&graph_version=&cid=[&edge_id=]` → 当前节点的题目与选项，
 *    `edge_id` 是要走的那条边的 id；不给 edge_id 就是根节点。
 *
 * ## 选项文字为什么要洗一遍
 *
 * B站 下发的 option 实测长这样：`"A 向左走"`、`"B 向右挖"`、`"（1）向左走"`，
 * 有的还会拖着 `"A.B.C"`、`"1 2 3"` 这类纯编号噪音。我们统一**去掉自带编号**、
 * 自己按顺序发 A/B/C，这样按钮显示的文字干净，用户回 A / 1 / 选项原文都能对上。
 */
import { logger } from 'node-karin'

import { Networks } from '@/module/utils/Network'

/** 互动视频的一次选择 */
export interface InteractiveChoice {
  /** 我们自己的序号（0 开始） */
  index: number
  /** 展示用标签：A / B / C …（超过 26 个退回数字） */
  label: string
  /** 洗过的选项文字（发按钮、发文字都用它） */
  text: string
  /** B站 原始文字（日志、排查用） */
  rawText: string
  /** 继续剧情用的边 id，请求 edgeinfo_v2 时带上 */
  edgeId: number
  /** 该选项对应的视频 cid */
  cid: number
  /** B站 标记的默认分支（自动跳转的那条） */
  isDefault: boolean
}

/** 剧情图的一个节点（= 一段视频 + 一道题） */
export interface InteractiveNode {
  bvid: string
  graphVersion: number
  /** 当前节点的视频 cid */
  cid: number
  /** 剧情图标题（就是视频标题） */
  title: string
  /** 题目文本，B站 有时给空串 */
  question: string
  /** 洗完、过滤后的选项；空数组表示到结局了 */
  choices: InteractiveChoice[]
  /** 结局节点（没有选项可选） */
  isLeaf: boolean
  /** B站 的提示语，例如「登录后才能体验全部结局哦～」 */
  notice: string
}

/** 互动视频的剧情图信息（来自播放器接口） */
export interface InteractiveInfo {
  /** 剧情图版本号 */
  graphVersion: number
  /** B站 给的提示语，可能为空 */
  notice: string
}

/** 注入式请求：默认走插件的 Networks（带重试与代理），测试里换成假实现 */
export type InteractiveRequest = (url: string, headers?: Record<string, string>) => Promise<any>

const PLAYER_INFO_URL = 'https://api.bilibili.com/x/player/wbi/v2'
const EDGE_INFO_URL = 'https://api.bilibili.com/x/stein/edgeinfo_v2'

/** 默认请求实现：复用插件的网络层（它会带默认请求头、失败重试） */
export const interactiveRequest: InteractiveRequest = async (url, headers) => {
  const data = await new Networks({ url, headers, timeout: 15000 }).getData()
  // Networks 失败时返回 false（它自己已经打过日志），这里统一成 null
  return data === false ? null : data
}

/**
 * 选项文字里要去掉的「自带编号」。
 *
 * 必须要求编号后面跟分隔符（空格 / 点 / 顿号 / 括号 / 冒号）才认为是编号：
 * 否则「Block 摆放」这种以字母开头的正常文字会被吃掉首字母。
 */
const LABEL_PREFIX = /^(?:\s*[（(]?\s*(?:[A-Za-z]|\d{1,2}|[一二三四五六七八九十]+)\s*[)）.、,，:：\-—]+\s*|[A-Za-z]\s+|\d{1,2}\s+|[一二三四五六七八九十]+[、.．]\s*)+/

/** 结尾的编号噪音：`向左走 A.B.C`、`向右挖 1 2 3` */
const LABEL_SUFFIX = /[\s.、,，]*(?:[A-Za-z]|\d{1,2})(?:[\s.、,，]+(?:[A-Za-z]|\d{1,2}))+\s*$/

/** 只有字母序列的噪音：`A.B.C` / `A B C` */
const JUNK_LETTERS = /^(?:[A-Za-z][\s.、,，)）(（]*){2,}$/
/** 只有数字/标点的噪音：`1 2 3` / `1.` */
const JUNK_DIGITS = /^[\d\s.、,，()（）]{1,12}$/
/** 纯标点 */
const JUNK_PUNCT = /^[.·•\-—_…,，、;；:：!！?？\s]+$/
/** 零宽字符等看不见的东西 */
const INVISIBLE = /[\u200b-\u200f\ufeff\u2060]/g

/**
 * 洗选项文字：去零宽字符、去自带编号、去结尾编号噪音、压多余空格。
 *
 * @param raw B站 下发的 option 原文
 */
export const cleanChoiceText = (raw: string): string => {
  let text = String(raw ?? '').replace(INVISIBLE, '').trim()
  text = text.replace(LABEL_PREFIX, '').trim()
  text = text.replace(LABEL_SUFFIX, '').trim()
  return text.replace(/\s{2,}/g, ' ')
}

/**
 * 判断一个选项是不是「只剩编号」的噪音。
 *
 * 用户反馈的 `A.B.C`、`1 2 3` 就是这类：留着只会让按钮上出现一堆没意义的字。
 */
export const isJunkChoice = (text: string): boolean => {
  const value = String(text ?? '').trim()
  if (!value) return true
  return JUNK_LETTERS.test(value) || JUNK_DIGITS.test(value) || JUNK_PUNCT.test(value)
}

/** 选项标签：A、B、…、Z，超过 26 个用数字，避免出现 `[` 这种字符 */
export const choiceLabel = (index: number): string =>
  index >= 0 && index < 26 ? String.fromCharCode(65 + index) : String(index + 1)

/**
 * 把 B站 的 edgeinfo_v2 响应解析成节点。
 *
 * 纯函数：不联网、不改数据，方便直接拿真实响应做测试。
 *
 * @param payload edgeinfo_v2 的响应体
 * @param base 本次请求用到的 bvid / 剧情图版本 / cid
 */
export const parseInteractiveNode = (
  payload: any,
  base: { bvid: string; graphVersion: number; cid: number }
): InteractiveNode | null => {
  const data = payload?.data ?? payload
  if (!data || typeof data !== 'object') return null

  const question = (data.edges?.questions ?? [])[0] ?? {}
  const rawChoices: any[] = Array.isArray(question.choices) ? question.choices : []

  /** 先按「能继续对话」的硬条件过滤：边 id 和 cid 必须都是有效数字 */
  const usable = rawChoices
    .map((choice, order) => ({
      order,
      edgeId: Number(choice?.id),
      cid: Number(choice?.cid),
      rawText: String(choice?.option ?? ''),
      isDefault: Boolean(choice?.is_default)
    }))
    .filter((item) => Number.isFinite(item.edgeId) && item.edgeId > 0 && Number.isFinite(item.cid) && item.cid > 0)

  const cleaned = usable.map((item) => ({
    ...item,
    text: cleanChoiceText(item.rawText),
    /**
     * 噪音判断要看**原始文字**。
     *
     * `A.B.C` 洗掉前缀之后只剩一个 `C`，光看洗过的结果它一点都不像噪音，
     * 于是这种选项会被留下来，按钮上就出现一串没意义的字母数字。
     */
    junk: isJunkChoice(cleanChoiceText(item.rawText)) || isJunkChoice(item.rawText)
  }))
  /**
   * 噪音选项只在「还有正经选项」时才丢：万一一整道题都是噪音，
   * 那就原样留着 —— 有得选总比没得选好。
   */
  const meaningful = cleaned.filter((item) => !item.junk)
  const kept = meaningful.length ? meaningful : cleaned

  const choices: InteractiveChoice[] = kept.map((item, index) => ({
    index,
    label: choiceLabel(index),
    /**
     * 洗不干净（洗完还是编号）时退回原文：`A.B.C` 这种至少让用户看得出
     * 「这是 B站 给的一条坏选项」，而不是一个莫名其妙的 `C`。
     */
    text: item.junk ? item.rawText.trim() || item.text || choiceLabel(index) : item.text || item.rawText.trim() || choiceLabel(index),
    rawText: item.rawText,
    edgeId: item.edgeId,
    cid: item.cid,
    isDefault: item.isDefault
  }))

  return {
    bvid: base.bvid,
    graphVersion: base.graphVersion,
    cid: base.cid,
    title: String(data.title ?? ''),
    question: String(question.title ?? '').trim(),
    choices,
    isLeaf: Number(data.is_leaf) === 1 || choices.length === 0,
    notice: ''
  }
}

/**
 * 查剧情图版本号（顺便带回 B站 的提示语）。
 *
 * 只有互动视频的播放器接口里才有 `data.interaction`，所以这个函数也是「是不是互动视频」的判断依据。
 *
 * @param params bvid / 当前 cid / 请求头 / 请求实现
 */
export const fetchInteractiveInfo = async (params: {
  bvid: string
  cid: number
  headers?: Record<string, string>
  request?: InteractiveRequest
}): Promise<InteractiveInfo | null> => {
  const { bvid, cid, headers, request = interactiveRequest } = params
  if (!bvid || !cid) return null
  const payload: any = await request(PLAYER_INFO_URL + '?bvid=' + bvid + '&cid=' + cid, headers)
  const interaction = payload?.data?.interaction
  const graphVersion = Number(interaction?.graph_version)
  if (!Number.isFinite(graphVersion) || graphVersion <= 0) {
    // 普通视频本来就没有 interaction，这里只记 debug；真的要排查时再看
    logger.debug('[互动视频] 播放器接口没有剧情图版本号（code=' + String(payload?.code ?? '无响应') + '），按普通视频处理')
    return null
  }
  return { graphVersion, notice: String(interaction?.msg ?? '').trim() }
}

/**
 * 拉取一个剧情节点（不给 edgeId 就是根节点）。
 *
 * @param params bvid / 剧情图版本 / cid / 要走的边（可选）/ 请求头 / 请求实现
 */
export const fetchInteractiveNode = async (params: {
  bvid: string
  graphVersion: number
  cid: number
  edgeId?: number
  headers?: Record<string, string>
  request?: InteractiveRequest
}): Promise<InteractiveNode | null> => {
  const { bvid, graphVersion, cid, edgeId, headers, request = interactiveRequest } = params
  if (!bvid || !graphVersion || !cid) return null
  let url = EDGE_INFO_URL + '?bvid=' + bvid + '&graph_version=' + graphVersion + '&cid=' + cid
  if (edgeId) url += '&edge_id=' + edgeId

  /**
   * 重试两次。
   *
   * 线上实测：用户在群里选完选项，偶尔会遇到一次接口抖动 —— 之前只问一次、
   * 失败就当作「剧情图取不到下一段」把剧情结束掉，用户明明回对了却被踢出剧情。
   * 这种一次性的失败重试一次就好了，同时把真实原因（code / message / 没响应）打进日志。
   */
  let lastReason = '没有响应（网络层返回 false）'
  for (let attempt = 1; attempt <= 2; attempt++) {
    const payload: any = await request(url, headers)
    const code = Number(payload?.code)
    if (payload && code === 0) {
      const node = parseInteractiveNode(payload, { bvid, graphVersion, cid })
      if (node) return node
      lastReason = '响应里没有剧情数据'
    } else {
      lastReason = 'code=' + String(payload?.code ?? '无') + ' message=' + JSON.stringify(payload?.message ?? '')
    }
    if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 400))
  }
  logger.warn('[互动视频] 取剧情节点失败（' + (edgeId ? '选项 edge_id=' + edgeId : '根节点') + ' cid=' + cid + '）：' + lastReason)
  return null
}

/**
 * 把用户回的那句话解析成选项序号。
 *
 * 支持：`A` / `a` / 全角 `Ａ`、`1`、`选A`、`选择 2`、直接回选项原文（可只回其中几个字）。
 *
 * @param input 用户消息文本
 * @param choices 当前节点可选的选项
 * @returns 命中的序号；没命中返回 -1
 */
export const parseChoiceInput = (input: string, choices: InteractiveChoice[]): number => {
  if (!Array.isArray(choices) || !choices.length) return -1
  /**
   * 先剥掉消息里的元素标记。
   *
   * 线上实测：用户点了 @ 之后发「A」，拿到的文本是 `<at id="661867728489"/>A`，
   * 直接被当成「不认识的内容」—— 用户明明回对了却不认。CQ 码形态（`[CQ:at,qq=…]`）同理。
   */
  const stripped = String(input ?? '')
    .replace(ELEMENT_TAG, '')
    .replace(CQ_CODE, '')
  // 全角字母数字先归一化成半角，手机上很容易打出全角
  const normalized = stripped
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return -1

  const hit = matchChoice(normalized, choices)
  if (hit >= 0) return hit
  /** 再来一次：这次把开头的 @某某 也去掉（有的客户端把提醒当纯文本发过来） */
  const withoutMention = normalized.replace(LEADING_MENTION, '').trim()
  return withoutMention && withoutMention !== normalized ? matchChoice(withoutMention, choices) : -1
}

/** 消息元素标记：`<at id="…"/>`、`<img …/>`、`[CQ:at,qq=…]` 都算 */
const ELEMENT_TAG = /<\/?(?:at|img|face|mface|reply|quote|json|xml|button|markdown)\b[^>]*>/gi
const CQ_CODE = /\[CQ:[^\]]+\]/gi
/** 纯文本形态的提醒：`@麦芽糖bot A`（QQ 用的是全角空格，一并吃掉） */
const LEADING_MENTION = /^(?:@[^\s@]{1,32}[\s\u2005\u00a0]*)+/

/** 从一句话里认出选项：字母 / 数字 / 选项原文（完全相等或包含） */
const matchChoice = (text: string, choices: InteractiveChoice[]): number => {
  const bare = text.replace(/^(?:请|我)?(?:选择|选|回复|回|答案|答)\s*/, '').trim()
  if (!bare) return -1

  const letter = /^([A-Za-z])$/.exec(bare)
  if (letter) {
    const index = letter[1].toUpperCase().charCodeAt(0) - 65
    if (index >= 0 && index < choices.length) return index
  }

  const digit = /^(\d{1,2})$/.exec(bare)
  if (digit) {
    const index = Number(digit[1]) - 1
    if (index >= 0 && index < choices.length) return index
  }

  /** 回原文：完全相等优先，其次是「用户打了一半」的模糊匹配（至少两个字） */
  const exact = choices.findIndex((choice) => choice.text === bare)
  if (exact >= 0) return exact
  if (bare.length >= 2) {
    const partial = choices.findIndex((choice) => choice.text.includes(bare) || bare.includes(choice.text))
    if (partial >= 0) return partial
  }
  return -1
}

/** 一次互动剧情的会话状态（按频道保存，默认 15 分钟有效） */
export interface InteractiveSession {
  bvid: string
  graphVersion: number
  /** 用户当前正在看的那一段的 cid */
  cid: number
  /**
   * 进入当前段的那条边（从哪个 cid、走的哪条选项）。
   *
   * 剧情图里**很多选项的 id 会重复**，光靠 cid 定位不到「用户在哪」，
   * 必须记住「从 fromCid 走 edgeId 过来」这一对，才能从当前位置往下画。
   */
  entry?: { fromCid: number; edgeId: number }
  title: string
  choices: InteractiveChoice[]
  /** 已经走过的选项文字，用来显示进度 */
  path: string[]
  notice: string
  updatedAt: number
}

/** 会话有效期：超过就当作结束了（用户隔天再回 A 不该续上昨天的剧情） */
export const INTERACTIVE_TTL_MS = 15 * 60 * 1000

const sessions = new Map<string, InteractiveSession>()

/** 会话 key：一个频道一份（群里谁回 A 都算继续剧情，和面板按钮的行为一致） */
export const interactiveKey = (platform: string, channelId: string): string =>
  String(platform ?? '') + ':' + String(channelId ?? '')

/** 存一份会话（同时清理过期会话，避免 Map 越攒越大） */
export const rememberInteractiveSession = (key: string, session: InteractiveSession): void => {
  const now = Date.now()
  for (const [item, value] of sessions) {
    if (now - value.updatedAt > INTERACTIVE_TTL_MS) sessions.delete(item)
  }
  sessions.set(key, { ...session, updatedAt: now })
}

/** 取会话；过期或不存在都返回 null */
export const getInteractiveSession = (key: string): InteractiveSession | null => {
  const session = sessions.get(key)
  if (!session) return null
  if (Date.now() - session.updatedAt > INTERACTIVE_TTL_MS) {
    sessions.delete(key)
    return null
  }
  return session
}

/** 结束会话（走到结局、用户放弃、解析失败都调用它） */
export const clearInteractiveSession = (key: string): void => {
  sessions.delete(key)
}

/** 当前活着的会话数量（测试与排查用） */
export const interactiveSessionCount = (): number => sessions.size

/** 把一段剧情路径渲染成 `开场 → 向左走` 这种进度文本 */
export const formatInteractivePath = (path: string[]): string =>
  Array.isArray(path) && path.length ? path.join(' → ') : ''
