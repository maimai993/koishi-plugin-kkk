/**
 * 把整张剧情图爬下来（给「剧情图」卡片画思维导图用）。
 *
 * 接口只有「按节点问」这一种（x/stein/edgeinfo_v2），所以要自己从根节点宽度优先展开：
 * 每个节点问一次，拿到它的选项；每个选项的 cid 就是落点，再问落点，直到没有分支。
 * 一张图动辄几十个节点，所以带**节点数 / 时间预算**：超了就停下并在卡片上标注「还有分支未展开」，
 * 绝不让用户等着一张图渲不出来。
 *
 * 结果按 bvid + 剧情图版本号缓存 30 分钟（GRAPH_TTL）：剧情图是静态的，同一个人反复玩不用重复爬。
 */
import { logger } from 'node-karin'

import { cleanChoiceText, choiceLabel, type InteractiveRequest } from '@/module/utils/InteractiveVideo'

/** 卡片上画的一个分支 */
export interface GraphChoice {
  label: string
  text: string
  isDefault: boolean
  edgeId: number
  cid: number
  /** 选它之后落到的那一段（卡片要的就是这个嵌套结构） */
  children?: GraphNode[]
}

/** 卡片上画的一段剧情 */
export interface GraphNode {
  cid: number
  /** 这一段的题目，B站 可能给空串 */
  question: string
  isLeaf: boolean
  choices: GraphChoice[]
  /** 预算用尽，这一段下面的分支没展开 */
  truncated?: boolean
}

export interface InteractiveGraph {
  root: GraphNode
  nodeCount: number
  truncated: boolean
  /** 这张图里画进来的节点 cid（用户走到图外的分支时要重新画） */
  cids: number[]
}

interface CacheEntry { at: number; graph: InteractiveGraph }

const GRAPH_CACHE = new Map<string, CacheEntry>()
const GRAPH_TTL = 30 * 60 * 1000

const EDGE_INFO_URL = 'https://api.bilibili.com/x/stein/edgeinfo_v2'

/** 解析一个节点（edgeinfo_v2 的一份响应） */
const parseNode = (payload: any, cid: number): GraphNode | null => {
  const data = payload?.data
  if (!data || typeof data !== 'object') return null
  const question = (data.edges?.questions ?? [])[0] ?? {}
  const raw: any[] = Array.isArray(question.choices) ? question.choices : []
  const usable = raw
    .map((choice) => ({
      edgeId: Number(choice?.id),
      cid: Number(choice?.cid),
      rawText: String(choice?.option ?? ''),
      isDefault: Boolean(choice?.is_default)
    }))
    .filter((item) => Number.isFinite(item.edgeId) && item.edgeId > 0 && Number.isFinite(item.cid) && item.cid > 0)
  const choices: GraphChoice[] = usable.map((item, index) => ({
    label: choiceLabel(index),
    text: cleanChoiceText(item.rawText) || item.rawText.trim() || choiceLabel(index),
    isDefault: item.isDefault,
    edgeId: item.edgeId,
    cid: item.cid
  }))
  return {
    cid,
    question: String(question.title ?? '').trim(),
    isLeaf: Number(data.is_leaf) === 1 || choices.length === 0,
    choices
  }
}

/**
 * 爬整张剧情图。
 *
 * @param params 基本信息 + 请求实现 + 预算
 * @returns 爬到的图；连根节点都取不到时返回 null
 */
export const crawlInteractiveGraph = async (params: {
  bvid: string
  graphVersion: number
  rootCid: number
  headers?: Record<string, string>
  request: InteractiveRequest
  /** 从这条边进入的节点开始画（不传就是从 graph_version 的根节点开始） */
  rootEdge?: { fromCid: number; edgeId: number }
  /** 最多爬多少个节点（默认 400：一次性爬完整张图，不再截断） */
  maxNodes?: number
  /** 最多花多少毫秒（默认 30000） */
  timeoutMs?: number
}): Promise<InteractiveGraph | null> => {
  const { bvid, graphVersion, rootCid, headers, request } = params
  const maxNodes = params.maxNodes ?? 400
  const deadline = Date.now() + (params.timeoutMs ?? 30000)
/** 缓存的是**整张图**（和从哪一段起画无关），所以 key 里不带 rootCid */
  const cacheKey = bvid + ':' + graphVersion
  const cached = GRAPH_CACHE.get(cacheKey)
  if (cached && Date.now() - cached.at < GRAPH_TTL) return cached.graph

  const byCid = new Map<number, GraphNode>()
  let truncated = false
  /** 抓失败的节点数：有失败就不写缓存，下次重新抓，不留断头的图 */
  let failed = 0

  /** 单个节点最多问两次：接口抖动一次不该在图里留一个断头分支 */
  const fetchNode = async (cid: number, edgeId?: number): Promise<GraphNode | null> => {
    let url = EDGE_INFO_URL + '?bvid=' + bvid + '&graph_version=' + graphVersion + '&cid=' + cid
    if (edgeId) url += '&edge_id=' + edgeId
    for (let attempt = 1; attempt <= 2; attempt++) {
      const payload: any = await request(url, headers)
      if (payload && Number(payload.code) === 0) {
        const node = parseNode(payload, cid)
        if (node) return node
      } else if (attempt === 1) {
        logger.debug('[互动视频] 剧情图节点取失败（cid=' + cid + ' edge=' + String(edgeId ?? '-') + ' code=' + String(payload?.code ?? '无响应') + '），重试一次')
      }
      if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 300))
    }
    return null
  }

  /** 一次进队列的「待展开」任务：从 fromCid 出发走这条选项，落点就是这条选项的 cid */
  const queue: Array<{ fromCid: number; choice: GraphChoice }> = []
  /**
   * 根节点。
   *
   * **不带 edge_id 地问接口会拿到整张图的根**，所以「从当前位置起画」必须带上进入那条边：
   * 用户走到第 5 段时，我们要的是第 5 段那一段，而不是回到开场。
   */
  const rootEdge = params.rootEdge
  const rootUrl = EDGE_INFO_URL + '?bvid=' + bvid + '&graph_version=' + graphVersion
    + '&cid=' + (rootEdge ? rootEdge.fromCid : rootCid)
    + (rootEdge ? '&edge_id=' + rootEdge.edgeId : '')
  const rootPayload = await request(rootUrl, headers)
  if (!rootPayload || Number(rootPayload.code) !== 0) return null
  const root = parseNode(rootPayload, rootCid)
  if (!root) return null
  byCid.set(rootCid, root)
  for (const choice of root.choices) queue.push({ fromCid: rootCid, choice })

  /** 宽度优先：三个一波并发，节点数或时间到顶就停 */
  while (queue.length) {
    if (byCid.size >= maxNodes || Date.now() > deadline) {
      truncated = true
      break
    }
    const wave = queue.splice(0, 3)
    const results = await Promise.all(wave.map(async (task) => ({ task, node: await fetchNode(task.fromCid, task.choice.edgeId) })))
    for (const { task, node } of results) {
      if (!node) {
        failed++
        continue
      }
      /** 落点那一段的 cid 就是选项自己带的 cid（请求用的 cid 是「从哪出发」） */
      const landed: GraphNode = { ...node, cid: task.choice.cid }
      /** 挂到卡片要的嵌套结构上：选项 → 落到的那一段 */
      task.choice.children = [landed]
      /**
       * 同一个 cid 可能被多条路走到（剧情图不是纯树），只展开一次：
       * 既省请求，也避免环把爬取变成死循环。
       */
      const seenBefore = byCid.has(task.choice.cid)
      byCid.set(task.choice.cid, landed)
      if (seenBefore || !landed.choices.length) continue
      for (const choice of landed.choices) {
        if (byCid.has(choice.cid)) continue
        if (queue.some((item) => item.choice.cid === choice.cid)) continue
        queue.push({ fromCid: task.choice.cid, choice })
      }
    }
  }

  const result: InteractiveGraph = { root: byCid.get(rootCid) ?? root, nodeCount: byCid.size, truncated, cids: [...byCid.keys()] }
  /** 有缺口（预算用尽或有节点没抓到）就不缓存：否则下次画出来还是同样缺分支 */
  if (!truncated && !failed) GRAPH_CACHE.set(cacheKey, { at: Date.now(), graph: result })
  logger.info('[互动视频] 剧情图已爬取：' + result.nodeCount + ' 个节点'
    + (truncated ? '（预算用尽，还有分支未展开）' : '')
    + (failed ? '（' + failed + ' 个节点没抓到，会在用户走到那里时重画）' : ''))
  return result
}

/** 取缓存里的整张图（点「渲染流程图」时直接用它，不再请求接口） */
export const peekCachedGraph = (bvid: string, graphVersion: number): InteractiveGraph | null => {
  const hit = GRAPH_CACHE.get(bvid + ':' + graphVersion)
  if (!hit) return null
  if (Date.now() - hit.at >= GRAPH_TTL) return null
  return hit.graph
}

/** 清理剧情图缓存（测试用） */
export const clearInteractiveGraphCache = (): void => GRAPH_CACHE.clear()
