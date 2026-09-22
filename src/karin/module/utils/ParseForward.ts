/**
 * 「解析结果合并转发」——把**一次解析产生的所有内容**合并成一条转发消息发出去。
 *
 * ## 需求（用户要求）
 *   - **合并转发开关打开时**（通用 →「解析结果合并转发」，也就是 `app.fakeForward`）：
 *     一次解析产生的所有信息合并成一条转发发出（**支持的平台**才有这个概念：
 *     QQ 官方适配器没有合并转发能力），转发用**触发者**身份展示；
 *   - **开关关掉就不合并**：内容照旧一条一条发（用户实测反馈：
 *     「关闭合并转发 还是合并的」—— 关掉就该回到逐条发送）；
 *   - **转发里不包含过程提示**（「检测到链接，开始解析」「收到请求，开始下载」「加载中…」「发送中…」这些）。
 *
 * ## 怎么做到的
 * 兼容层的发送漏斗（Message.reply / karin.sendMsg / bot.uploadFile / sendForwardMsg）会把
 * **发往本次解析频道**的内容收进缓冲区（见 compat/forward-collect），这里负责：
 *   1. `withParseForward()` 把平台 handler 包一层：**开关打开**且适配器支持合并转发时才开收集，
 *      解析结束（含错误卡片）后在 `finally` 里冲刷；
 *   2. `flushParseForward()` 把攒下来的元素交给 compat 的 `sendForwardMsg` 发出去
 *      （发送本身用 `withoutForwardCollect` 包住，避免自己吞自己）；
 *   3. 过程提示由各自的发送点用 `withoutForwardCollect()` 标记（QqPanel / Base）。
 *
 * 开关关掉、或者平台不支持合并转发（QQ 官方适配器）时**完全不收集**，
 * 保持原来的「一边解析一边逐条发」，行为与以前一模一样。
 */
import { drainForwardGroups, isForwardSupported, logger, makeForward, runWithForwardBag, withoutForwardCollect, type Message } from 'node-karin'

import { Config } from './Config'

/** 本次消息要发到哪个频道（合并转发的目标） */
export function parseForwardPeer (e: any): string {
  return String(e?.contact?.peer ?? e?.channelId ?? '')
}

/** 取适配器平台名：兼容层的 bot 把真实 Bot 放在 .bot 上 */
function platformOf (e: any): string {
  return String(e?.bot?.bot?.platform ?? e?.bot?.platform ?? '')
}

/**
 * OneBot 系适配器（NapCat / Lagrange / go-cqhttp / Chronocat…）：它们真的有「聊天记录」这个概念。
 *
 * 注意这份名单是**白名单**：compat 那边的 isForwardSupported 是黑名单（只排除 QQ 官方），
 * 于是**任何自定义适配器都会被当成支持** —— 线上真实故障就是这样：
 * B站私聊适配器（koishi-plugin-adapter-bilibili-dm，platform 就是 bilibili）被认成支持合并转发，
 * 结果整条转发发出去「没有拿到消息 ID」（适配器根本没有聊天记录这种东西），
 * 连退回来的逐条发送也失败了 —— 用户什么都没收到。
 */
const ONEBOT_LIKE = /onebot|napcat|lagrange|go-?cqhttp|chronocat|mirai/i

/** 这台部署的适配器支不支持合并转发（**只有明确支持才算支持**） */
export function canForwardParseResult (e: any): boolean {
  const raw: any = e?.bot?.bot ?? e?.bot
  /**
   * ① 适配器自己带合并转发 API（OneBot 系的 sendGroupForwardMsg / sendPrivateForwardMsg）
   *    —— 这条最可靠，不依赖平台名怎么写。
   */
  const internal: any = raw?.internal ?? e?.bot?.internal
  if (internal && (typeof internal.sendGroupForwardMsg === 'function' || typeof internal.sendPrivateForwardMsg === 'function')) return true
  /** ② 其余只认 OneBot 系的平台名 */
  const platform = platformOf(e)
  if (!platform) return false
  return ONEBOT_LIKE.test(platform)
}

/** 平台名 → 配置段名（合并转发的平台开关就写在各自的平台段里） */
const PLATFORM_SECTIONS: Record<string, string> = {
  douyin: 'douyin',
  bilibili: 'bilibili',
  kuaishou: 'kuaishou',
  xiaohongshu: 'xiaohongshu'
}

/** 取某个配置段（读不到就当空对象，绝不让配置问题把解析链路带崩） */
const sectionOf = (name: string): any => {
  try {
    return (Config as any)?.[name] ?? {}
  } catch {
    return {}
  }
}

/**
 * 「解析结果合并转发」要不要生效（**默认全关**）。
 *
 * 两级开关，**全局优先**（用户要求）：
 *   1. 全局 \`app.fakeForward\` 打开 → **所有平台**都合并，平台开关被忽略；
 *   2. 全局关着 → 看平台自己的 \`<平台>.forward\`（抖音 / B站 / 快手 / 小红书 各自一个）。
 *
 * 以前这里是「缺省即开」（\`!== false\`），现在改成「必须显式打开」——
 * 默认值全部是关，装完不配置就一条一条发。
 *
 * @param platform 解析的平台名（douyin / bilibili / kuaishou / xiaohongshu）
 */
export function isParseForwardEnabled (platform?: string): boolean {
  const app = sectionOf('app')
  // ① 全局优先
  if (app.fakeForward === true) return true
  // ② 平台自己的开关
  const section = platform ? sectionOf(PLATFORM_SECTIONS[platform] ?? '') : {}
  return section.forward === true
}

/**
 * **合并转发里包含哪些内容**（配置项 \`app.forwardContent\`，写法参照各平台的「发送内容」）：
 *
 *   - \`text\`  文字提示 / 过程说明
 *   - \`image\` 图片（信息卡、评论卡、图集、切片后的评论卡都算这一类）
 *   - \`video\` 视频（体积大的会被硬上限挡下，见 HARD_INLINE_LIMIT）
 *   - \`file\`  文件（群文件等）
 *
 * **没列出来的内容一律单独直发**（不进转发节点）。默认只合并文字和图片。
 *
 * ## 为什么可选项里没有「语音」和「markdown」
 *
 *   - **语音进不了合并转发**：QQ 的聊天记录（合并转发）不支持语音气泡，
 *     OneBot / NapCat 的 \`send_group_forward_msg\` 节点里放 \`record\` 段也一样不认
 *     （用户实测反馈：「所有平台语音也不支持合并转发」）。所以语音**永远单独直发**，
 *     选项里干脆不给，免得配了不生效。
 *   - **markdown 卡片也用不上合并转发**：markdown 只有 QQ **官方 bot** 认，
 *     而官方适配器（qq / qqguild / qqbot）**没有合并转发能力**（见 compat 的 supportsForward）——
 *     两边永远不会同时成立，这个选项是死的，一并去掉。
 *
 * 另外 OneBot / NapCat 的转发节点对体积敏感：实测 10.3MB 的视频（\`base64://\` 之后约 13.7MB）
 * 会让整条转发被拒（\`Error with request send_group_forward_msg …\`），所以默认只合并文字和图片；
 * 想要视频也进去就勾上 \`video\` —— 真发不出去时下面的兜底会逐条直发，不会丢内容。
 */
const FORWARD_KINDS = ['text', 'image', 'video', 'file']
const DEFAULT_FORWARD_CONTENT = ['text', 'image']

/**
 * **永远不进转发节点**的元素类型。
 *
 * 语音（record/audio）在 QQ 的聊天记录里不支持；markdown 只有官方 bot 认，
 * 而官方 bot 没有合并转发能力 —— 两头都堵死，直接排除，配置里写了也不生效。
 */
const NEVER_FORWARD_TYPES = /^(record|audio|markdown)$/

/**
 * 单个元素塞进节点的**硬上限**（约 30MB）。
 *
 * 就算把 \`video\` 打开了，也不该把一条上百 MB 的 base64 丢进一个转发节点 —— 那会直接把
 * 适配器的请求撑爆。到这一步就回退成单独直发。
 */
const HARD_INLINE_LIMIT = 30 * 1024 * 1024

/** 把元素归到一个可配置的类别（\`other\` 是 at / 引用这类轻量装饰，永远跟着转发走） */
const kindOfElement = (element: any): string => {
  const type = String(element?.type ?? '')
  if (type === 'img' || type === 'image') return 'image'
  if (type === 'record' || type === 'audio') return 'audio'
  if (type === 'video') return 'video'
  if (type === 'file') return 'file'
  if (type === 'markdown') return 'markdown'
  if (type === 'text') return 'text'
  return 'other'
}

/** 把配置里的一串类别洗干净；不是数组 / 洗完全是空 → 返回 null（表示「没配」） */
function normalizeKinds (value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const valid = value
    .map((item) => String(item).toLowerCase())
    .filter((item) => FORWARD_KINDS.includes(item))
  return valid.length ? valid : null
}

/**
 * 当前允许进转发的类别。
 *
 * 跟开关一样分两级：**全局打开时用 \`app.forwardContent\`**；
 * 全局关着、平台开关打开时用 \`<平台>.forwardContent\`，没配就退回全局那份，再没有就用默认。
 */
export function forwardContentKinds (platform?: string): string[] {
  const globalList = normalizeKinds(sectionOf('app').forwardContent)
  if (sectionOf('app').fakeForward === true) return globalList ?? DEFAULT_FORWARD_CONTENT
  const section = platform ? sectionOf(PLATFORM_SECTIONS[platform] ?? '') : {}
  return normalizeKinds(section.forwardContent) ?? globalList ?? DEFAULT_FORWARD_CONTENT
}

/** 分成「能进转发的」和「要单独发的」两份 */
/** 单个元素能不能进转发节点 */
function canForward (element: any, kinds: string[]): boolean {
  const kind = kindOfElement(element)
  const type = String(element?.type ?? '')
  const src = String(element?.attrs?.src ?? element?.attrs?.url ?? element?.data?.file ?? '')
  // 语音 / markdown 无论怎么配都不进转发（见 NEVER_FORWARD_TYPES）
  const allowed = !NEVER_FORWARD_TYPES.test(type) && (kind === 'other' || kinds.includes(kind))
  return allowed && src.length <= HARD_INLINE_LIMIT
}

/** 拍平版本（保持老签名，便于单测/复用） */
export function splitForwardableElements (elements: any[], platform?: string): { forwardable: any[]; direct: any[] } {
  const kinds = forwardContentKinds(platform)
  const forwardable: any[] = []
  const direct: any[] = []
  for (const element of elements) (canForward(element, kinds) ? forwardable : direct).push(element)
  return { forwardable, direct }
}

/**
 * **按「每次发送」分组分流**：能进转发的组原样保留分组（一组 = 一个聊天记录条目），
 * 不能进的元素拍平进 \`direct\` 单独直发。
 */
export function splitForwardableGroups (groups: any[][], platform?: string): { forwardGroups: any[][]; direct: any[] } {
  const kinds = forwardContentKinds(platform)
  const forwardGroups: any[][] = []
  const direct: any[] = []
  for (const group of groups) {
    const keep: any[] = []
    for (const element of group) {
      if (canForward(element, kinds)) keep.push(element)
      else direct.push(element)
    }
    if (keep.length) forwardGroups.push(keep)
  }
  return { forwardGroups, direct }
}

/**
 * 把攒下来的解析结果发成一条转发。
 *
 * 没攒到东西就什么都不做（例如这条消息其实没解析成功、或者已经在不支持的平台上）。
 */
export async function flushParseForward (e: Message, platform?: string): Promise<void> {
  const groups = drainForwardGroups()
  const elements = groups.flat()
  if (!elements.length) return
  const bot: any = (e as any)?.bot
  const sender: any = (e as any)?.sender ?? {}
  /**
   * 走进来就说明「合并转发」开关是开着的，转发按**触发者**身份展示
   * （以前这里还分「开关关着用机器人身份」，但开关现在同时管「要不要合并」，
   * 关掉根本不会有这条转发，那个分支已经是死代码了）。
   */
  const botId = String(sender.userId ?? '')
  const botName = String(sender.nick ?? sender.card ?? sender.name ?? '')
  /**
   * 重媒体（视频 / 语音 / 文件）不进转发节点：NapCat 会因为节点内容过大整条拒绝，
   * 结果是「转发失败 → 用户什么都收不到」。它们单独直发，其余照旧合并成一条转发。
   */
  const { forwardGroups, direct } = splitForwardableGroups(groups, platform)
  const forwardable = forwardGroups.flat()
  /** 转发节点里所有载荷的总大小（base64 后的估算值）：OneBot 那条链路对节点体积敏感 */
  const payloadMB = forwardable.reduce((sum: number, item: any) => {
    const src = String(item?.attrs?.src ?? item?.attrs?.url ?? item?.data?.file ?? '')
    return sum + src.length
  }, 0) / 1048576
  logger.info('[合并转发] 本次解析产生 ' + elements.length + ' 条内容'
    + (direct.length ? '（其中 ' + direct.length + ' 条按 app.forwardContent 配置改为单独发送）' : '')
    + '，合并成一条转发发出（身份：触发者 ' + (botName || botId || '（未知）') + '）'
    + '｜合并内容 = ' + forwardContentKinds().join(',') + '｜节点载荷约 ' + payloadMB.toFixed(2) + 'MB')
  /**
   * 发送这一步必须**跳过收集**：不然 sendForwardMsg 自己会又被收进缓冲区，
   * 冲刷时再次触发，来回死循环。
   */
  const target = parseForwardPeer(e) || e.contact
  const sendDirect = async (list: any[]): Promise<number> => {
    let sent = 0
    for (const element of list) {
      try {
        await withoutForwardCollect(() => bot.sendMsg(target, [element]))
        sent += 1
      } catch (error: any) {
        logger.warn('[合并转发] 单独发送第 ' + (sent + 1) + ' 条失败: ' + String(error?.message ?? error).slice(0, 160))
      }
    }
    return sent
  }

  if (!forwardable.length) {
    // 全是重媒体：没有可合并的东西，直接逐条发
    const sent = await sendDirect(direct)
    logger.mark('[合并转发] 本次内容都不在 app.forwardContent 里，已逐条直发 ' + sent + '/' + direct.length + ' 条')
    return
  }

  try {
    await withoutForwardCollect(() => bot.sendForwardMsg(target, makeForward(forwardable, botId || undefined, botName || undefined, forwardGroups), {
      source: '解析结果',
      summary: '查看解析结果',
      prompt: '解析结果',
      news: [{ text: '点击查看解析结果' }]
    }))
    if (direct.length) {
      const sent = await sendDirect(direct)
      logger.mark('[合并转发] 另有 ' + sent + '/' + direct.length + ' 条内容单独发送'
        + '（未包含在 app.forwardContent 里，或单个超过 30MB 硬上限）')
    }
    return
  } catch (error: any) {
    /**
     * **转发发不出去时不能把内容吞掉**。
     *
     * 开着合并转发时，解析期间的元素全都攒在缓冲区里、一条都没发过；
     * 如果这里直接失败返回，用户会**什么都收不到**（以前就是这么写的：
     * 「内容已经按原样发过或已丢失」）。所以退回**逐条直发**，至少把卡片/视频送出去。
     */
    logger.warn('[合并转发] 转发发送失败，改为逐条发送（' + elements.length + ' 条）: '
      + String(error?.message ?? error).slice(0, 200))
  }
  try {
    await withoutForwardCollect(() => bot.sendMsg(target, forwardable))
    if (direct.length) await sendDirect(direct)
    return
  } catch (error: any) {
    logger.warn('[合并转发] 整条直发也失败，改为逐个元素发送: ' + String(error?.message ?? error).slice(0, 200))
  }
  const sent = await sendDirect([...forwardable, ...direct])
  logger.mark('[合并转发] 已退回逐条发送，成功 ' + sent + '/' + elements.length + ' 条')
}

/**
 * 把一个平台 handler 包成「解析结果合并转发」模式。
 *
 *   - **开关开着 + 适配器支持合并转发** → 解析期间产生的所有内容（卡片 / 图片 / 视频 / 评论…）先攒着，
 *     handler 跑完（**包括错误卡片**）后合并成一条转发发出；
 *   - **开关关掉**（通用 →「解析结果合并转发」）→ 原样执行，什么都不收集，内容一条一条发；
 *   - 不支持合并转发的平台（QQ 官方适配器）→ 同样原样执行。
 */
export function withParseForward<F extends (e: any, next?: any) => any> (handler: F, platform?: string): F {
  const wrapped = async (e: any, next?: any): Promise<any> => {
    if (!isParseForwardEnabled(platform)) {
      logger.debug('[合并转发] 本次不合并（全局 app.fakeForward 与 ' + (platform ?? '未知平台')
        + '.forward 都没打开），按逐条发送处理')
      return await handler(e, next)
    }
    if (!parseForwardPeer(e)) return await handler(e, next)
    if (!canForwardParseResult(e)) {
      // 说明白为什么没合并：以前这里静默退化，用户只看到「转发了但没收到」
      logger.mark('[合并转发] 适配器 ' + (platformOf(e) || '未知') + ' 不支持合并转发（不是 OneBot 系、也没有 forward API），本次逐条发送')
      return await handler(e, next)
    }
    return await runWithForwardBag(parseForwardPeer(e), async () => {
      try {
        return await handler(e, next)
      } finally {
        try {
          await flushParseForward(e, platform)
        } catch (error: any) {
          logger.warn('[合并转发] 冲刷转发时出错: ' + String(error?.message ?? error))
        }
      }
    })
  }
  return wrapped as F
}
