/**
 * 互动视频的「发选项 → 等选择 → 播下一段」这一段流程。
 *
 * 数据与清洗逻辑在 module/utils/InteractiveVideo.ts，这里只管**怎么问、怎么等、怎么续**：
 *
 *   · QQ（官方适配器）发 markdown，每个选项一个 `<qqbot-…-input>` 按钮，点一下等于发出字母；
 *   · 其它适配器发纯文字（A / B / C 各一行），用户回字母或数字；
 *   · 等回复用 karin.ctx（同频道同用户的下一句话），默认 180 秒，超时就体面收尾；
 *   · 每次只留最新一条选项消息（下一条发出前撤回上一条），不给群里刷屏。
 *
 * 播放下一段视频交给上层注入的 play 回调（走现成的解析/下载/发送链路），
 * 这样这里完全不依赖 bilibili 平台代码，可以用假实现直接测。
 */
import karin, { logger, Message, segment, withForwardKind, withoutForwardCollect } from 'node-karin'

import { Render } from '@/module'
import { crawlInteractiveGraph, peekCachedGraph, type InteractiveGraph } from '@/module/utils/InteractiveGraph'
import { cmdInput, isQqPlatform } from '@/module/utils/QqPanel'
import { commandInvocation } from '../../../compat/runtime'
import { wrapWithErrorHandler } from '@/module/utils/ErrorHandler'
import {
  clearInteractiveSession,
  fetchInteractiveNode,
  formatInteractivePath,
  getInteractiveSession,
  interactiveKey,
  interactiveRequest,
  parseChoiceInput,
  rememberInteractiveSession,
  type InteractiveChoice,
  type InteractiveNode,
  type InteractiveRequest
} from '@/module/utils/InteractiveVideo'

/** 等用户选择的时间：太长会挂着等待，太短用户还没看完视频 */
export const CHOICE_WAIT_SECONDS = 180

/** 重新渲染流程图的指令（按钮点的就是它） */
export const RENDER_CHART_COMMAND = '渲染流程图'

/** 每个频道最近一条「选项消息」，用于发下一条之前撤回 */
const lastChoiceMessages = new Map<string, string>()

/**
 * 每个频道最近一条「剧情视频」的消息 ID。
 *
 * 用户要求：点一下选项，**上一段视频也要撤回** —— 不然玩几段之后群里躺着一串视频。
 * 视频是解析链路发的（不是这里发的），所以由那边把它发出去的消息 ID 记进来。
 */
const lastStoryVideos = new Map<string, string>()

/** 记下刚发出去的剧情视频（由解析链路在上传成功时调用） */
export const rememberStoryVideo = (e: Message, messageId: string | undefined): void => {
  if (!messageId) return
  lastStoryVideos.set(sessionKeyOf(e), String(messageId))
}

/**
 * 取出并清掉「上一条剧情视频」的消息 ID。
 *
 * 取出来就删：这条只该被撤回一次，撤回失败也不能反复去点。
 */
const takeStoryVideo = (e: Message): string | undefined => {
  const key = sessionKeyOf(e)
  const messageId = lastStoryVideos.get(key)
  if (messageId) lastStoryVideos.delete(key)
  return messageId
}

/** 撤回某条消息（失败只记日志，绝不影响剧情） */
const recallMessage = async (e: Message, messageId: string | undefined): Promise<void> => {
  if (!messageId) return
  try {
    await (e.bot as any)?.recallMsg?.(messageId, channelOf(e))
  } catch (error: any) {
    logger.debug('[互动视频] 撤回消息失败: ' + String(error?.message ?? error))
  }
}

const platformOf = (e: any): string =>
  String(e?.bot?.bot?.platform ?? e?.bot?.platform ?? e?.platform ?? '')

const channelOf = (e: any): string => String(e?.contact?.peer ?? e?.guildId ?? '')

/** 剧情会话 key（和 InteractiveVideo 里的口径一致） */
const sessionKeyOf = (e: Message): string => interactiveKey(platformOf(e), channelOf(e))

/**
 * 组装选项消息。
 *
 * 标题、进度、题目、B站 的提示语都会带上；QQ 走 markdown + 按钮，其它平台走纯文字。
 *
 * @param node 当前剧情节点
 * @param options 标题 / 已走过的剧情 / 等待秒数 / 是否加按钮
 * @returns 要发送的文本
 */
export const buildChoiceMessage = (
  node: InteractiveNode,
  options: { title?: string; path?: string[]; waitSeconds?: number; buttons: boolean; detailed?: boolean }
): string => {
  const { title, path = [], waitSeconds = CHOICE_WAIT_SECONDS, buttons, detailed = true } = options
  const lines: string[] = []

  /**
   * **只有第一次带标题、题目和「怎么回复」的说明**。
   *
   * 用户要求：后面的每一次都只发选项本身 —— 一是群里不刷屏，
   * 二是 QQ 官方适配器的被动回复窗口有限，正文越长越容易整条发不出去（40034128）。
   */
  if (detailed) {
    const heading = [title || node.title || '互动视频', path.length ? '剧情：' + formatInteractivePath(path) : '']
      .filter(Boolean)
      .join('　·　')
    lines.push(buttons ? '**' + heading + '**' : '🎬 ' + heading)
    lines.push('')
    lines.push(node.question || '请选择接下来的剧情')
    lines.push('')
  }

  for (const choice of node.choices) {
    if (!buttons) {
      lines.push(choice.label + ' ' + choice.text)
      continue
    }
    /**
     * 按钮文案也带字母：用户看到的和「回 A」是同一套编号，不会两套编号打架。
     * 选项文字里的引号/括号由 cmdInput 自己编码。
     */
    lines.push(cmdInput(choice.label, choice.label + ' ' + choice.text))
  }

  /** 重新画一张流程图的按钮：走到图外的分支、或者想再看一眼时随手点 */
  lines.push(buttons
    ? cmdInput(commandInvocation(RENDER_CHART_COMMAND), '渲染流程图')
    : '回复「' + RENDER_CHART_COMMAND + '」可以重新画一张流程图')

  if (detailed) {
    lines.push('')
    if (node.notice) lines.push(node.notice)
    lines.push(buttons
      ? '点上面的按钮，或者直接回复字母（' + waitSeconds + ' 秒内有效）'
      : '回复上面的字母或数字继续（' + waitSeconds + ' 秒内有效）')
  }
  return lines.join(String.fromCharCode(10))
}

/** 撤掉这个频道上一条选项消息（撤不掉就算了，绝不让它影响剧情） */
const recallLastChoices = async (e: Message): Promise<void> => {
  const key = sessionKeyOf(e)
  const messageId = lastChoiceMessages.get(key)
  if (!messageId) return
  lastChoiceMessages.delete(key)
  try {
    await (e.bot as any)?.recallMsg?.(messageId, channelOf(e))
  } catch (error: any) {
    logger.debug('[互动视频] 撤回上一条选项消息失败: ' + String(error?.message ?? error))
  }
}

/**
 * 发一条剧情选项消息。
 *
 * QQ 上先试 markdown（能出按钮），失败就退回纯文字 —— 按钮只是体验，剧情不能因为发不出去而中断。
 * 纯文本会被「合并转发」收集，所以统一用 withoutForwardCollect 包起来。
 */
export const sendInteractiveChoices = async (
  e: Message,
  node: InteractiveNode,
  options: { title?: string; path?: string[]; waitSeconds?: number; detailed?: boolean } = {}
): Promise<string | undefined> => {
  await recallLastChoices(e)
  const useButtons = isQqPlatform(e) && node.choices.length > 0
  const send = async (content: any) => withoutForwardCollect(() => e.reply(content))

  let sent: any
  try {
    sent = await send(useButtons
      ? segment.markdown(buildChoiceMessage(node, { ...options, buttons: true }))
      : buildChoiceMessage(node, { ...options, buttons: false }))
  } catch (error: any) {
    if (!useButtons) throw error
    logger.warn('[互动视频] markdown 按钮消息发送失败（' + String(error?.message ?? error).slice(0, 120) + '），改用文字发送')
    sent = await send(buildChoiceMessage(node, { ...options, buttons: false }))
  }
  const messageId = String(sent?.messageId ?? '')
  if (messageId) lastChoiceMessages.set(sessionKeyOf(e), messageId)
  return messageId || undefined
}

/** 发一条剧情提示（不参与合并转发、默认不撤回） */
export const sendStoryTip = async (e: Message, text: string): Promise<void> => {
  try {
    await withoutForwardCollect(() => e.reply(text))
  } catch (error: any) {
    logger.debug('[互动视频] 提示发送失败: ' + String(error?.message ?? error))
  }
}

export interface StoryOptions {
  /** 当前消息事件（发送与等待都用它） */
  e: Message
  bvid: string
  /** 剧情图版本号（来自播放器接口的 data.interaction.graph_version） */
  graphVersion: number
  /** 根节点的 cid（就是刚发出的那段视频） */
  rootCid: number
  /** 剧情图标题，用于消息标题 */
  title?: string
  /** B站 的提示语（例如「登录后才能体验全部结局哦～」，来自播放器接口） */
  notice?: string
  /** 请求头（带上 Cookie 能解锁更多结局） */
  headers?: Record<string, string>
  /** 请求实现（测试用） */
  request?: InteractiveRequest
  /**
   * 播放某个节点的视频（上层注入；失败只记日志，不中断剧情）。
   *
   * 第二个参数是**要拿哪条消息去回复** —— 必须用用户刚发的那句，
   * 否则视频是在「很久以前那条链接消息」的被动回复窗口外发的，QQ 会直接拒收。
   */
  play?: (cid: number, e: Message) => Promise<void>
  /**
   * 等用户回一句。
   *
   * 默认用 karin.ctx，返回用户发的 Message（拿它当回复目标）；
   * 返回字符串（测试里这么写）或者 null（超时）都支持。
   */
  wait?: (seconds: number) => Promise<any>
  waitSeconds?: number
  /**
   * 每一段剧情开始时问一次：要不要渲一张「剧情图」卡片（上层注入；失败不影响剧情）。
   *
   * 返回 true 表示卡片已经发出去了 —— 那选项消息就不再重复标题与说明（用户要求：卡片长文只留一份）。
   * 上层会自己判断：第一段一定画，之后只在「用户走到上一张图没画过的分支」时才补画。
   */
  onNode?: (node: InteractiveNode, e: Message, path: string[], isFirst: boolean, entry: { fromCid: number; edgeId: number } | null) => Promise<boolean | void>
}

export interface StoryResult {
  /** leaf=走到结局、timeout=等超时、unavailable=剧情图取不到 */
  ended: 'leaf' | 'timeout' | 'unavailable'
  /** 走过的选项文字 */
  path: string[]
  /** 一共走了几个节点 */
  nodes: number
}

/**
 * 跑完一次互动剧情：把所有选项、等待、续播串起来。
 *
 * 这个函数是**长跑**的：它会一直等到用户选完或者超时，所以调用方应该放到后台跑
 * （不要 await 在解析主流程里，否则解析结果要等到剧情结束才算完成）。
 *
 * @param options 见 {@link StoryOptions}
 */
export const runInteractiveStory = async (options: StoryOptions): Promise<StoryResult> => {
  const { e, bvid, graphVersion, rootCid, title, notice, headers, request, play, onNode } = options
  const waitSeconds = options.waitSeconds ?? CHOICE_WAIT_SECONDS
  const wait = options.wait ?? (async (seconds: number) => {
    const context = await karin.ctx(e, { time: seconds * 1000, reply: true, throwOnTimeout: false })
    return context ?? null
  })
  /**
   * 当前用来发消息的事件。
   *
   * 一开始是用户发链接那条消息；用户每回一次，就换成**那句回复** ——
   * QQ 官方适配器只能在「用户刚说完话」的时间窗里被动回复，
   * 一直拿最初那条链接消息去发，后面每一条都会撞 40034128（被动回复超限）然后退化成主动消息。
   */
  let target: Message = e
  /** 只有第一组选项带标题与说明 */
  let firstChoices = true
  const key = sessionKeyOf(e)
  const path: string[] = []
  let nodes = 0

  const finish = (ended: StoryResult['ended']): StoryResult => {
    clearInteractiveSession(key)
    return { ended, path, nodes }
  }

  /**
   * 当前所在节点的视频 cid。
   *
   * 注意 edgeinfo_v2 的两个 cid 不是一回事：**请求**要带你现在这一段的 cid，
   * 而落地那一段的 cid 是选项自己带的（choice.cid）—— 一开始这里搞混了，
   * 结果每次「下一段」都重复播了当前这一段。
   */
  let currentCid = rootCid
  /** 进入当前段的那条边（第一段没有）：剧情图里选项 id 会重复，靠它才能定位用户在哪 */
  let entry: { fromCid: number; edgeId: number } | null = null
  let failures = 0
  let node = await fetchInteractiveNode({ bvid, graphVersion, cid: currentCid, headers, request })
  if (!node) {
    logger.warn('[互动视频] 取不到剧情节点（graph_version=' + graphVersion + ' cid=' + rootCid + '）')
    return finish('unavailable')
  }

  while (node) {
    nodes++
    rememberInteractiveSession(key, {
      bvid,
      graphVersion,
      cid: node.cid,
      title: node.title || title || '',
      choices: node.choices,
      path: [...path],
      notice: node.notice,
      entry: entry ?? undefined,
      updatedAt: Date.now()
    })

    if (node.isLeaf || !node.choices.length) {
      /**
       * 结局同样给上层一次画图的机会：用户要求「走到最后一个选项也要在当前位置渲染」，
       * 走到结尾时把完整路径画出来，比只丢一句「走到结局了」清楚得多。
       */
      if (onNode) {
        try {
          await onNode({ ...node, isLeaf: true }, target, path, false, entry)
        } catch (error: any) {
          logger.warn('[互动视频] 结局剧情图渲染失败: ' + String(error?.message ?? error).slice(0, 160))
        }
      }
      await recallLastChoices(target)
      await sendStoryTip(target, '🎬 互动视频走到结局了' + (path.length ? '\n剧情：' + formatInteractivePath(path) : ''))
      return finish('leaf')
    }

    /** B站 的提示语来自播放器接口，edgeinfo 里没有，所以在这里补进去 */
    const currentNode: InteractiveNode = node.notice ? node : { ...node, notice: notice ?? '' }
    /**
     * 第一段额外渲染一张剧情图卡片（和作品信息卡同一套样式，页脚版本信息由 DefaultLayout 带）。
     * 卡片发出去了，选项消息就只发选项本身；卡片没发出去，才用长文本兜底。
     */
    let cardSent = false
    if (onNode) {
      try {
        cardSent = (await onNode(currentNode, target, path, firstChoices, entry)) === true
      } catch (error: any) {
        logger.warn('[互动视频] 剧情图卡片渲染失败: ' + String(error?.message ?? error).slice(0, 160))
      }
    }
    await sendInteractiveChoices(target, currentNode, {
      title: title || node.title,
      path,
      waitSeconds,
      detailed: firstChoices && !cardSent
    })
    firstChoices = false

    /**
     * 等用户选出这一段的走向。
     *
     * **认不出来就什么都不发，继续等**：群里别人正常聊天、或者用户自己随便说句话，
     * 都不该被机器人插一句「没认出你的选择」—— 之前那样做，群一热闹就一直刷提示。
     * 也不重发选项（选项就在上面那条消息里，重复发同样是在刷屏）。
     */
    let choice: InteractiveChoice | null = null
    while (!choice) {
      const answer = await wait(waitSeconds)
      /** 拿用户那句回复当新的发送目标（被动回复窗口就在它身上） */
      const answerMessage: Message | null = answer && typeof answer === 'object' ? answer : null
      const answerText = answerMessage ? String((answerMessage as any).msg ?? '') : String(answer ?? '')
      if (answerMessage) target = answerMessage
      if (!answerText.trim()) {
        await recallLastChoices(target)
        await sendStoryTip(target, '互动视频先玩到这里～想接着玩就再发一次链接（等了 ' + waitSeconds + ' 秒没等到你的选择）')
        return finish('timeout')
      }
      const index = parseChoiceInput(answerText, node.choices)
      if (index < 0) continue
      choice = node.choices[index]
    }
    path.push(choice.text)
    /** 用「当前节点 cid + 这条边」问下一组选项，返回的就是落地节点 */
    const next = await fetchInteractiveNode({ bvid, graphVersion, cid: currentCid, edgeId: choice.edgeId, headers, request })
    if (!next) {
      /**
       * 取不到下一段时**先别结束**：实测多数是接口抖了一下。
       * 把选项再发一次，等用户重新选（内部已经重试过一次请求）。
       */
      failures++
      if (failures > 1) {
        await sendStoryTip(target, '剧情图一直取不到下一段（可能剧情被 UP 主改过了），这次就到这里')
        return finish('unavailable')
      }
      await sendStoryTip(target, '刚刚没取到下一段，再选一次试试～')
      path.pop()
      continue
    }
    /** 落地那一段的视频就是选项带的 cid */
    entry = { fromCid: currentCid, edgeId: choice.edgeId }
    currentCid = choice.cid

    if (play) {
      /**
       * 用户要求：点一下选项，**上一段视频也要撤回**（群里只留当前这一段）。
       *
       * 顺序是「发新的 → 撤旧的」：先取走旧 ID（新的那条发出去时会被重新记上），
       * 新的发完再撤旧的 —— 中间不会出现「一段视频都没有」的空档。
       */
      const previousVideo = takeStoryVideo(target)
      try {
        await play(currentCid, target)
      } catch (error: any) {
        logger.warn('[互动视频] 播放下一段失败（cid=' + currentCid + '）: ' + String(error?.message ?? error))
      }
      await recallMessage(target, previousVideo)
    }
    node = { ...next, cid: currentCid }
  }

  return finish('leaf')
}

/**
 * 在一张图里按「从哪条边进来」定位节点。
 *
 * 剧情图里选项 id / 落点会重复，所以优先用 fromCid:edgeId 这一对，
 * 实在对不上再按 cid 兜（有重复落点时会挑第一个）。
 */
export const findNode = (root: any, entry?: { fromCid: number; edgeId: number } | null, cid?: number): any => {
  let byCid: any = null
  const walk = (node: any, edgeId?: number): any => {
    if (!node) return null
    if (edgeId !== undefined && entry && Number(edgeId) === Number(entry.edgeId) && Number(node.cid) === Number(cid)) return node
    if (!byCid && cid !== undefined && Number(node.cid) === Number(cid)) byCid = node
    for (const choice of node.choices ?? []) {
      for (const child of choice.children ?? []) {
        const hit = walk(child, choice.edgeId)
        if (hit) return hit
      }
    }
    return null
  }
  const found = entry ? walk(root, undefined) : null
  return found ?? byCid ?? null
}

/** 卡片需要的嵌套结构（带递归上限，防止剧情图里的环把渲染卡死） */
export const toCardGraph = (node: any, depth = 0): any => {
  const choices = Array.isArray(node?.choices) ? node.choices : []
  return {
    question: String(node?.question ?? ''),
    isLeaf: Boolean(node?.isLeaf),
    truncated: Boolean(node?.truncated),
    choices: choices.map((choice: any) => ({
      label: choice.label,
      text: choice.text,
      isDefault: choice.isDefault,
      children: depth >= 6 || !Array.isArray(choice.children) || !choice.children.length
        ? undefined
        : choice.children.map((child: any) => toCardGraph(child, depth + 1))
    }))
  }
}

/** 清理某个频道的选项消息记录（解析失败等异常收尾时用） */
export const forgetChoiceMessage = (e: Message): void => {
  lastChoiceMessages.delete(sessionKeyOf(e))
}

/**
 * 渲染并发送一张「剧情图」卡片。
 *
 * 三处会用到：第一段、走到图外分支时、以及用户点「渲染流程图」按钮时。
 * crawlInteractiveGraph 的 rootEdge 决定「从哪一段开始画」——剧情图里选项 id 会重复，
 * 只给 cid 不够，必须带上进入那条边。
 *
 * @returns 卡片是否真的发出去了
 */
export const renderInteractiveChart = async (params: {
  e: Message
  bvid: string
  graphVersion: number
  cid: number
  entry?: { fromCid: number; edgeId: number }
  title?: string
  path?: string[]
  notice?: string
  question?: string
  isEnding?: boolean
  request?: InteractiveRequest
  headers?: Record<string, string>
  /** 第一次画整张图用大预算，补画时用小预算 */
  full?: boolean
}): Promise<{ sent: boolean; complete: boolean }> => {
  const { e, bvid, graphVersion, cid, entry, title, path = [], notice, question, isEnding } = params
  /**
   * 优先用缓存里的整张图：第一次解析就整张爬完了，
   * 之后（结局、点渲染流程图）都是换个起点画同一份缓存，不再请求接口。
   */
  let whole: InteractiveGraph | null = peekCachedGraph(bvid, graphVersion)
  if (!whole) {
    whole = await crawlInteractiveGraph({
      bvid,
      graphVersion,
      rootCid: cid,
      rootEdge: entry,
      headers: params.headers,
      request: params.request ?? interactiveRequest
    }).catch(() => null)
  }
  if (!whole) return { sent: false, complete: false }
  /** 在整张图里定位「用户现在在哪一段」：先按进来的那条边找，找不到再按 cid 兜 */
  const located = findNode(whole.root, entry, cid) ?? whole.root
  const graph = { root: located, nodeCount: whole.nodeCount, truncated: whole.truncated, cids: whole.cids }

  const img = await Render(e, 'bilibili/interactive', {
    title: title || '互动视频',
    step: path.length + 1,
    rootLabel: params.full
      ? (question || '开场')
      : (isEnding ? ('结局 · ' + (question || '完')) : ('当前 · ' + (question || '这一段'))),
    path,
    notice,
    graph: toCardGraph(graph.root),
    truncated: graph.truncated
  })
  if (!img?.length) return { sent: false, complete: !graph.truncated }
  /**
   * 剧情图**不是过程提示**，所以不能再用 withoutForwardCollect 把它挡在合并转发之外：
   * 用 withForwardKind('chart', …) 标成「流程图」这一类，剩下的交给「合并转发内容」：
   *   - 勾了「流程图」→ 它进聊天记录；
   *   - 没勾 → 解析结束时单独直发（不会丢）；
   *   - 根本就没开合并转发（或者剧情是解析完才在后台画的，袋子已经关掉了）→ 就是普通发送。
   */
  await withForwardKind('chart', () => e.reply(img))
  return { sent: true, complete: !graph.truncated }
}

/**
 * 「渲染流程图」按钮/指令：重新画一张**当前位置**的图。
 *
 * 关键：**不撤回选项面板** —— 用户还在选，撤了就没得点了。
 */
const handleRenderChart = wrapWithErrorHandler(
  async (e: Message) => {
    const session = getInteractiveSession(sessionKeyOf(e))
    if (!session) {
      await sendStoryTip(e, '现在没有正在进行的互动视频，发一条互动视频链接就能玩')
      return true
    }
    const sent = await renderInteractiveChart({
      e,
      bvid: session.bvid,
      graphVersion: session.graphVersion,
      cid: session.cid,
      entry: session.entry,
      title: session.title,
      path: session.path,
      notice: session.notice
    })
    if (!sent.sent) await sendStoryTip(e, '流程图这次没画出来（接口没返回剧情数据），过一会儿再点一次试试')
    return true
  },
  { businessName: '互动视频流程图' }
)

export const interactiveChart = karin.command(new RegExp('^#?' + RENDER_CHART_COMMAND + '$'), handleRenderChart, {
  name: 'kkk-渲染流程图'
})
