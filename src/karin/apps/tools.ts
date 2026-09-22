import karin, { logger, segment, type Message } from 'node-karin'
import { cmdInput } from '@/module/utils/QqPanel'
import { replyReplacing } from '@/module/utils/QqPanel'
import { resolveCardToUrl } from '@/module/utils/CardParser'

import { Common, downloadVideo } from '@/module'
import { getStatisticsDB, type ParsePlatform, type ParseWorkType } from '@/module/db'
import { Config } from '@/module/utils/Config'
import { acquireParseLock } from '@/module/utils/ParseLock'

/**
 * 「同一条消息」级别的去重：一次发送被投递多遍时，**在提示和网络请求之前**就挡住。
 *
 * 用户实测「发一遍提示三次」：QQ 会把同一次发送投递多遍（指令按钮是「消息 + 交互事件」两条，
 * 客户端重发、群里的连点也一样），每个副本都会走到平台 handler。
 * 原来的作品级去重（biliKey / douyinKey 这些）**只挡得住解析本身**，挡不住「检测到 X 链接，开始解析」
 * 这句提示 —— 于是群里看到三条提示、实际只解析一次。这里用「会话 + 用户 + 消息原文」当键，
 * 在最前面就把它拦下（开关仍是通用里的「短时间不重复解析」，关掉即恢复原样）。
 * @param e 消息事件
 * @param platform 平台名（只用于日志）
 * @returns true = 这条消息可以处理；false = 短时间内已经处理过同一条，忽略
 */
const acquireMessageLock = (e: any, platform: string): boolean => {
  const content = String(e?.msg ?? '').replace(/\s+/g, ' ').trim()
  const key = ['msg', platform, e?.contact?.peer ?? e?.channelId ?? '', e?.userId ?? '', content].join(':')
  if (acquireParseLock(key)) return true
  logger.debug('短时间内重复的同一条消息（%s），已忽略: %s', platform, key)
  return false
}
// 注意路径必须用相对写法：@/ 别名在这个仓库里指向 karin/，写 @/compat/... 会解析成 karin/compat/...
// 那个目录不存在，会让整个 tools 应用加载失败（解析指令全部消失）。
import { parseParseFlags, runWithParseOverride } from '@/module/utils/ParseOverride'
import {
  resolvePanelQualitySize,
  resolvePanelToken,
  sendQqParsePanel,
  type PanelRequest
} from '@/module/utils/QqPanel'
import { isBurnDanmakuForbidden, isBurnDanmakuSupported } from '@/module/utils/DanmakuPolicy'
// 解析结果合并转发（支持的平台）：把一次解析产生的所有内容合并成一条转发，过程提示不进去
import { withParseForward } from '@/module/utils/ParseForward'
// 注意路径同样不能用 @/：@/ 指向 karin/，而播放器在 src/player（见 src/player/index.ts）
// 这里在 src/karin/apps/ 下，到 src/ 是两级；写成三级会解析到仓库根，tools 整个应用会加载失败
import { isOnlinePlayerEnabled } from '../../player'
import { wrapWithErrorHandler } from '@/module/utils/ErrorHandler'
import { Bilibili, getBilibiliID } from '@/platform/bilibili'
import { DouYin, getDouyinID } from '@/platform/douyin'
import { fetchKuaishouData, getKuaishouID, Kuaishou } from '@/platform/kuaishou'
import { getXiaohongshuID, Xiaohongshu } from '@/platform/xiaohongshu'

const reg = {
  douyin: /(https?:\/\/)?(www|v|jx|m|jingxuan)\.(douyin|iesdouyin)\.com/i,
  douyinCDN: /https:\/\/aweme\.snssdk\.com\/aweme\/v1\/play/i, // 抖音 CDN 下载链接
  bilibili: /(bilibili\.com|b23\.tv|t\.bilibili\.com|bili2233\.cn|\bBV[1-9a-zA-Z]{10}\b|\bav\d+\b)/i,
  kuaishou: /(快手.*快手|v\.kuaishou\.com|kuaishou\.com)/,
  xiaohongshu: /(xiaohongshu\.com|xhslink\.(?:com|cn))/
}

// 管理类命令本身内嵌平台链接（如 #kkk推送全局忽略{url}），需放行给对应命令处理，
// 否则会被「默认解析」(videoTool 开启时优先级为 -Infinity) 的解析器抢先消费
const passthroughCommandReg = /^#kkk推送全局忽略/

/**
 * 记录一次解析统计。
 *
 * 只统计群聊（私聊没有 groupId），且统计写失败不能影响解析结果投递，所以整体兜住只记日志。
 *
 * **`durationMs` 的口径**：从「链接解析开始」到「handler 返回」的整段墙钟时间，
 * 也就是用户感知的「发链接到收到回复」。它包含接口请求、下载、渲染、发送 —— 不是单纯的接口延迟。
 * 另外它只统计**成功**的解析：handler 抛错时走不到这里（失败率是另一个维度，本次没做）。
 * @param e 消息事件
 * @param platform 平台
 * @param stats 本次解析采到的统计维度；取不到的留空，对应维度不计数，总量照常累计
 */
const recordParseStat = async (
  e: Message,
  platform: ParsePlatform,
  stats: { workType?: ParseWorkType; durationMs?: number } = {}
): Promise<void> => {
  const groupId = e.isGroup ? e.contact?.peer || '' : ''
  const userId = e.userId || ''
  if (!groupId || !userId) return

  try {
    const statisticsDB = await getStatisticsDB()
    await statisticsDB.recordParse(groupId, userId, platform, stats)
  } catch (error) {
    logger.debug(`[统计] 记录${platform}解析统计失败:`, error)
  }
}

/**
 * 弹幕烧录在当前部署能不能真的跑。
 *
 * 优先级从高到低：通用里的「强制不烧录弹幕」（默认开，开了连指令都烧不了）→
 * 机器上有没有 ffmpeg → 这次用户有没有主动要。降级时只回一句话说明，不丢报错卡片。
 *
 * 注意：**在线播放模式不走这里**（调用方直接按 false 处理）—— 它不需要 ffmpeg，
 * 也不该给用户弹一句「本部署已关闭弹幕烧录」的降级提示。
 * @param e 消息事件
 * @param requested 用户或配置是否要了弹幕
 * @returns 是否仍然按弹幕解析
 */
const resolveBurnDanmaku = async (e: Message, requested: boolean): Promise<boolean> => {
  if (!requested) return false
  let tip = ''
  if (isBurnDanmakuForbidden()) tip = '本部署已关闭弹幕烧录（通用设置里的「强制不烧录弹幕」），本次按纯视频解析'
  else if (!isBurnDanmakuSupported()) tip = '当前部署未接入 ffmpeg，弹幕烧录暂不可用，本次按纯视频解析'
  if (!tip) return true
  try {
    await e.reply(tip)
  } catch (error) {
    logger.debug('发送弹幕不可用提示失败: ' + String(error))
  }
  return false
}

/**
 * 面板按钮的短令牌 → 真实链接。
 *
 * 按钮里只放 \`--p=abc123\`（见 QqPanel），链接存在插件内存里；这里把它拼回消息文本，
 * 后面的链接识别照常工作。令牌过期/无效时什么都不做，等于「没找到链接」。
 * @param e 消息事件（会被就地修改）
 * @param flags 已经解析出来的参数
 */
const expandPanelToken = (e: Message, flags: ReturnType<typeof parseParseFlags>): void => {
  if (!flags.panelToken) return
  const url = resolvePanelToken(flags.panelToken)
  if (!url || e.msg.includes(url)) return
  e.msg = e.msg + ' ' + url
}

/**
 * QQ 平台：解析前先发一次交互面板（解析内容 + 画质）。
 *
 * 面板按钮发出的是「带参数的同一条解析命令」，点一下走的就是下面这条正常解析链路，
 * 所以这里只需要判断「要不要先问一句」：
 *   - 明确说了「#弹幕解析」的不用问；
 *   - 已经带参数的（画质/弹幕/面板切换）说明用户已经选过或正在切换，直接往下走；
 *   - 剩下的裸链接消息在 QQ 上先出面板，其它平台原样返回 false（行为不变）。
 * @param e 消息事件
 * @param request 作品信息（按钮指令里带着它的规范链接）
 * @param flags 已经从消息里解析出来的参数
 * @returns true 表示面板已发出，本次不再解析
 */
const tryQqPanel = async (
  e: Message,
  request: PanelRequest,
  flags: ReturnType<typeof parseParseFlags>
): Promise<boolean> => {
  // 番剧分集按钮发的是 \`解析 <链接> --panel=1\`，它只是想重发一次面板，不该直接开解析
  if (flags.panel !== undefined) return await sendQqParsePanel(e, request)
  if (/^#?弹幕解析/.test(e.msg)) return false
  if (flags.hasAny) return false
  return await sendQqParsePanel(e, request)
}

// 包装抖音处理函数
const handleDouyin = withParseForward(wrapWithErrorHandler(
  async (e, next) => {
    /**
     * 平台解析总开关（配置里的「抖音解析」）：关掉时这个平台**什么都不做** ——
     * 不回提示、不报缺 Cookie、不记统计，也不去碰消息（用户要求：
     * 「关闭平台解析，这个平台的逻辑不要做任何处理」）。
     */
    if (!Config.douyin.switch) {
      logger.debug('[抖音] 平台解析已关闭，忽略这条消息')
      return next()
    }
    /** 同一条消息被投递多遍时只处理一次（详见 acquireMessageLock 的说明） */
    if (!acquireMessageLock(e, 'douyin')) return next()
    // 面板指令里的参数先摘掉，避免污染后面的链接匹配
    const flags = parseParseFlags(e.msg)
    e.msg = flags.cleaned
    expandPanelToken(e, flags)

    if (e.msg.startsWith('#测试') || passthroughCommandReg.test(e.msg)) {
      return next()
    }

    /**
     * 本次要不要「带弹幕」以及在哪落地，一共有三个入口：
     *   - **面板上的「在线看」（命令里带 `--play=1`）**：要的是播放页，视频压根不发到群里，
     *     所以它**不看弹幕总开关**（面板弹幕列关着、强制不烧录开着都照样带弹幕），
     *     只看播放器总开关 —— 见下面的 onlineWatch；
     *   - 指令 `弹幕解析 <链接>`，或者解析面板里点了带弹幕的那一档（命令里带 `--dm=1`）：
     *     通用里「在线播放器」开着 → **在线播放**（不烧录，登记播放会话后回一条链接）；
     *     关着 → 老流程，交给 resolveBurnDanmaku 判定能不能真烧（没 ffmpeg 就提示一句并降级成纯视频）。
     */
    const requestBurnDanmaku = flags.override.burnDanmaku === true || /^#?弹幕解析/.test(e.msg)
    /**
     * 面板上的「在线看」（`--play=1`）：语义是「视频别发到群里，直接给我一个带弹幕的播放页」，
     * 因此**不经过弹幕总开关**（配置里弹幕功能关着也一定带弹幕），只要播放器总开关开着就成立。
     */
    const onlineWatch = flags.override.onlineWatch === true && isOnlinePlayerEnabled()
    const onlinePlayer = onlineWatch || (requestBurnDanmaku && isOnlinePlayerEnabled())

    const urlMatch = e.msg.match(/(https?:\/\/[^\s]*\.(douyin|iesdouyin)\.com[^\s]*)/gi)
    if (!urlMatch) {
      logger.warn(`未能在消息中找到有效的抖音链接: ${e.msg}`)
      return next()
    }
    const url = String(urlMatch[0])
    const startedAt = Date.now()
    const iddata = await getDouyinID(e, url)

    /**
     * 面板按钮里继续用**原始分享链接**：`getDouyinID` 是靠跟随跳转拿 aweme_id 的，
     * 换成 `www.douyin.com/video/{id}` 反而可能撞上抖音的验证页。
     */
    if (iddata.type === 'one_work' && await tryQqPanel(e, { platform: 'douyin', url, id: String(iddata.aweme_id) }, flags)) {
      return
    }

    // 真的开始解析了才提示「本部署烧不了弹幕」——切换面板时要重发面板，那时提示是多余的
    // 在线播放模式直接按「不烧」处理（它压根不需要 ffmpeg，也不该弹降级提示）
    const forceBurnDanmaku = onlinePlayer ? false : await resolveBurnDanmaku(e, requestBurnDanmaku)
    // 同一次点击可能被投递两遍（指令按钮 + 交互事件、连点），这里只放行一次
    const douyinKey = ['douyin', e.contact?.peer ?? '', e.userId, iddata.aweme_id, flags.override.douyinQuality ?? '', String(forceBurnDanmaku), onlinePlayer ? 'player' : ''].join(':')
    if (!acquireParseLock(douyinKey)) {
      logger.debug('短时间内重复的抖音解析请求，已忽略: %s', douyinKey)
      return
    }
    const douyin = new DouYin(e, iddata, { forceBurnDanmaku })
    await runWithParseOverride(
      {
        ...flags.override,
        /**
         * 面板按钮点出来的要单独标记：这时画质面板已经发过了，
         * 只该回一句「收到请求，开始下载」，不再走「检测到链接，开始解析」。
         * 判据是面板专有参数：--p（画质按钮令牌）、--panel（选集）、--bgp（翻页）。
         */
        fromPanel: flags.panelToken !== undefined || flags.panel !== undefined || flags.bangumiPage !== undefined,
        /** 在线播放模式：平台 handler 据此「取弹幕但不烧录」，下载完登记播放会话并回链接 */
        onlinePlayer
      },
      () => douyin.DouyinHandler(iddata)
    )

    // 记录解析统计
    await recordParseStat(e, 'douyin', { workType: douyin.workType, durationMs: Date.now() - startedAt })

    return
  },
  {
    businessName: '抖音视频解析'
  }
), 'douyin')

// 包装B站处理函数
const handleBilibili = withParseForward(wrapWithErrorHandler(
  async (e, next) => {
    /** 平台解析总开关（「哔哩哔哩解析」）：关掉时这个平台什么都不做（详见 handleDouyin 上的说明） */
    if (!Config.bilibili.switch) {
      logger.debug('[B站] 平台解析已关闭，忽略这条消息')
      return next()
    }
    /** 同一条消息被投递多遍时只处理一次（必须放在提示和取数据之前，否则群里会看到三条提示） */
    if (!acquireMessageLock(e, 'bilibili')) return next()
    // 面板指令里的参数先摘掉，避免污染后面的链接匹配（BV 号是整串匹配，多一个参数就匹配不上）
    const flags = parseParseFlags(e.msg)
    e.msg = flags.cleaned
    expandPanelToken(e, flags)

    // 管理类命令内嵌B站链接（如 #kkk推送全局忽略{url}），放行给对应命令，避免被自动解析抢占
    if (passthroughCommandReg.test(e.msg)) {
      return next()
    }

    e.msg = e.msg.replace(/\\/g, '') // 移除消息中的反斜杠

    /**
     * 本次要不要「带弹幕」以及在哪落地，一共有三个入口：
     *   - **面板上的「在线看」（命令里带 `--play=1`）**：要的是播放页，视频压根不发到群里，
     *     所以它**不看弹幕总开关**（面板弹幕列关着、强制不烧录开着都照样带弹幕），
     *     只看播放器总开关 —— 见下面的 onlineWatch；
     *   - 指令 `弹幕解析 <链接>`，或者解析面板里点了带弹幕的那一档（命令里带 `--dm=1`）：
     *     通用里「在线播放器」开着 → **在线播放**（不烧录，登记播放会话后回一条链接）；
     *     关着 → 老流程，交给 resolveBurnDanmaku 判定能不能真烧（没 ffmpeg 就提示一句并降级成纯视频）。
     */
    const requestBurnDanmaku = flags.override.burnDanmaku === true || /^#?弹幕解析/.test(e.msg)
    /**
     * 面板上的「在线看」（`--play=1`）：语义是「视频别发到群里，直接给我一个带弹幕的播放页」，
     * 因此**不经过弹幕总开关**（配置里弹幕功能关着也一定带弹幕），只要播放器总开关开着就成立。
     */
    const onlineWatch = flags.override.onlineWatch === true && isOnlinePlayerEnabled()
    const onlinePlayer = onlineWatch || (requestBurnDanmaku && isOnlinePlayerEnabled())

    const urlRegex = /(https?:\/\/(?:(?:www\.|m\.|t\.)?bilibili\.com|b23\.tv|bili2233\.cn)\/[a-zA-Z0-9_\-.~:/?#[\]@!$&'()*+,;=]+)/
    const bvRegex = /^BV[1-9a-zA-Z]{10}$/
    const avRegex = /^av\d+$/i
    let url: string | null = null
    const urlMatch = e.msg.match(urlRegex)

    if (urlMatch) {
      url = urlMatch[0]
    } else if (bvRegex.test(e.msg)) {
      url = `https://www.bilibili.com/video/${e.msg}`
    } else if (avRegex.test(e.msg)) {
      url = `https://www.bilibili.com/video/${e.msg}`
    }
    if (!url) {
      logger.warn(`未能在消息中找到有效的B站分享链接、BV号或AV号: ${e.msg}`)
      return next()
    }
    const startedAt = Date.now()
    const iddata = await getBilibiliID(url)

    // QQ 平台：单视频先发交互面板，按钮里的规范链接（BV 号 + 分P）点一次就是一条完整命令
    if (
      iddata.type === 'one_video' && iddata.bvid &&
      await tryQqPanel(e, {
        platform: 'bilibili',
        url: 'https://www.bilibili.com/video/' + iddata.bvid + (iddata.p ? '?p=' + iddata.p : ''),
        id: String(iddata.bvid),
        page: iddata.p
      }, flags)
    ) {
      return
    }

    // 真的开始解析了才提示「本部署烧不了弹幕」——切换面板时要重发面板，那时提示是多余的
    // 在线播放模式直接按「不烧」处理（它压根不需要 ffmpeg，也不该弹降级提示）
    const forceBurnDanmaku = onlinePlayer ? false : await resolveBurnDanmaku(e, requestBurnDanmaku)
    // 同一次点击可能被投递两遍（指令按钮 + 交互事件、连点），这里只放行一次
    const biliKey = ['bilibili', e.contact?.peer ?? '', e.userId, iddata.bvid ?? '', flags.override.bilibiliQuality ?? '', String(forceBurnDanmaku), onlinePlayer ? 'player' : ''].join(':')
    if (!acquireParseLock(biliKey)) {
      logger.debug('短时间内重复的B站解析请求，已忽略: %s', biliKey)
      return
    }
    const bilibili = new Bilibili(e, iddata, { forceBurnDanmaku })
    /**
     * flags.panelToken 有值 = 这条消息是面板按钮点出来的：解析时不再发提示语和预览卡片。
     * 顺带把「这一档画质的预估体积」带下去 —— 「收到请求，开始下载」里要据此提示会以文件形式发送。
     */
    const estimatedSizeMB = resolvePanelQualitySize(flags.panelToken, flags.override.bilibiliQuality)
    await runWithParseOverride(
      {
        ...flags.override,
        /**
         * 只有**面板按钮点出来的**才算 fromPanel（这时才跳过提示语和预览卡片）。
         * 判据是面板专有的参数：--p（画质按钮带的令牌）、--panel（选集按钮）、--bgp（翻页）。
         * 手工敲的 `解析 <链接> --qn=32` 不带这些，仍然是正常解析流程。
         */
        fromPanel: flags.panelToken !== undefined || flags.panel !== undefined || flags.bangumiPage !== undefined,
        /** 在线播放模式：平台 handler 据此「取弹幕但不烧录」，下载完登记播放会话并回链接 */
        onlinePlayer,
        estimatedSizeMB,
        bangumiPage: flags.bangumiPage
      },
      () => bilibili.BilibiliHandler(iddata)
    )

    // 记录解析统计
    await recordParseStat(e, 'bilibili', { workType: bilibili.workType, durationMs: Date.now() - startedAt })

    return
  },
  {
    businessName: 'B站视频解析'
  }
), 'bilibili')

// 包装快手处理函数
const handleKuaishou = withParseForward(wrapWithErrorHandler(
  async (e) => {
    /** 平台解析总开关（「快手解析」）：关掉时这个平台什么都不做（详见 handleDouyin 上的说明）。
     *  快手这条链路没有 next()，直接返回即可。 */
    if (!Config.kuaishou.switch) {
      logger.debug('[快手] 平台解析已关闭，忽略这条消息')
      return
    }
    /** 同一条消息被投递多遍时只处理一次（详见 acquireMessageLock 的说明） */
    if (!acquireMessageLock(e, 'kuaishou')) return
    const kuaishouUrl = e.msg.replaceAll('\\', '').match(/(https:\/\/v\.kuaishou\.com\/\w+|https:\/\/www\.kuaishou\.com\/f\/[a-zA-Z0-9]+)/g)
    const startedAt = Date.now()
    // 解析参数（--q= 画质等）：之前这个分支没解析参数，面板选的画质从来没生效过
    const flags = parseParseFlags(e)
    /**
     * 短时间不重复解析（通用 →「短时间不重复解析」，默认开）：
     * 连点 / 重复投递的同一条链接只放行一次；用链接本身当作品标识，
     * 这样连「跟随短链」的那次请求都能省掉。
     */
    const kuaishouKey = ['kuaishou', e.contact?.peer ?? '', e.userId, String(kuaishouUrl), flags.override.xiaohongshuQuality ?? ''].join(':')
    if (!acquireParseLock(kuaishouKey)) {
      logger.debug('短时间内重复的快手解析请求，已忽略: %s', kuaishouKey)
      return
    }
    const iddata = await getKuaishouID(String(kuaishouUrl))
    const WorkData = await fetchKuaishouData(iddata.type, iddata)
    const kuaishou = new Kuaishou(e, iddata)
    await runWithParseOverride(
      {
        ...flags.override,
        /** 面板按钮点出来的：只回「收到请求，开始下载」，不再发「检测到链接，开始解析」 */
        fromPanel: flags.panelToken !== undefined || flags.panel !== undefined
      },
      () => kuaishou.KuaishouHandler(WorkData)
    )

    // 记录解析统计
    await recordParseStat(e, 'kuaishou', { workType: kuaishou.workType, durationMs: Date.now() - startedAt })
  },
  {
    businessName: '快手视频解析'
  }
), 'kuaishou')

// 包装小红书处理函数
const handleXiaohongshu = withParseForward(wrapWithErrorHandler(
  async (e, next) => {
    /**
     * 平台解析总开关（「小红书解析」）：关掉时**必须**在这里拦住 ——
     * 以前只在「自动解析」那条命令上判断，走 #解析 / 引用解析进来的链接照样会跑到底，
     * 于是用户关了小红书仍会收到「我还没有小红书的 Cookies」（线上反馈就是这个）。
     */
    if (!Config.xiaohongshu.switch) {
      logger.debug('[小红书] 平台解析已关闭，忽略这条消息')
      return next()
    }
    /** 同一条消息被投递多遍时只处理一次（详见 acquireMessageLock 的说明） */
    if (!acquireMessageLock(e, 'xiaohongshu')) return next()
    const cleaned = e.msg.replaceAll('\\', '')
    const m = cleaned.match(/https?:\/\/[^\s"'<>]+/)
    const url = m?.[0]
    if (!url) {
      logger.warn(`未能在消息中找到有效链接: ${e.msg}`)
      return next()
    }
    const startedAt = Date.now()
    // 同上：补上解析参数与面板标记
    const flags = parseParseFlags(e)
    /** 短时间不重复解析（通用 →「短时间不重复解析」，默认开）：同一条笔记只放行一次 */
    const xiaohongshuKey = ['xiaohongshu', e.contact?.peer ?? '', e.userId, url, flags.override.xiaohongshuQuality ?? ''].join(':')
    if (!acquireParseLock(xiaohongshuKey)) {
      logger.debug('短时间内重复的小红书解析请求，已忽略: %s', xiaohongshuKey)
      return
    }
    const iddata = await getXiaohongshuID(url)
    const xiaohongshu = new Xiaohongshu(e, iddata)
    await runWithParseOverride(
      {
        ...flags.override,
        fromPanel: flags.panelToken !== undefined || flags.panel !== undefined
      },
      () => xiaohongshu.XiaohongshuHandler(iddata)
    )

    // 记录解析统计
    await recordParseStat(e, 'xiaohongshu', { workType: xiaohongshu.workType, durationMs: Date.now() - startedAt })

    return
  },
  {
    businessName: '小红书视频解析',
    silentErrorReport: true
  }
), 'xiaohongshu')

// 包装引用解析函数（支持 #解析 和 #弹幕解析）
const handlePrefix = wrapWithErrorHandler(
  async (e, next) => {
    const originalMsg = e.msg
    const replyMsg = await Common.getReplyMessage(e)

    // 优先使用引用消息内容；无引用时回退到命令本身去掉前缀后的内容
    e.msg = replyMsg || originalMsg.replace(/^#?(解析|kkk解析|弹幕解析)\s*/, '')

    // 保留原始命令前缀，用于判断是否为弹幕解析
    if (/^#?弹幕解析/.test(originalMsg)) {
      e.msg = '#弹幕解析 ' + e.msg
    }

    // 面板按钮发来的是 \`解析 --p=xxx --qn=80\`：先把令牌换回链接，
    // 否则下面按平台分流时根本认不出这是哪个平台的链接
    expandPanelToken(e, parseParseFlags(e.msg))

    // 检查是否是抖音 CDN 下载链接（推送配置中渲染的二维码）
    if (reg.douyinCDN.test(e.msg)) {
      // 这是一个 CDN 下载链接，需要直接下载而不是解析
      logger.debug('检测到抖音 CDN 下载链接，直接下载视频')
      const videoIdMatch = e.msg.match(/video_id=([^&]+)/)
      const videoId = videoIdMatch ? videoIdMatch[1] : Date.now().toString()

      await downloadVideo(e, {
        video_url: e.msg,
        title: {
          timestampTitle: `tmp_${Date.now()}.mp4`,
          originTitle: `抖音视频_${videoId}.mp4`
        }
      })
      return true
    } else if (reg.douyin.test(e.msg)) {
      // 正常的抖音分享链接
      return await handleDouyin(e, next)
    } else if (reg.bilibili.test(e.msg)) {
      return await handleBilibili(e, next)
    } else if (reg.kuaishou.test(e.msg)) {
      return await handleKuaishou(e, next)
    } else if (reg.xiaohongshu.test(e.msg)) {
      return await handleXiaohongshu(e, next)
    }
  },
  {
    businessName: '引用解析'
  }
)

// 注册命令
/**
 * 卡片消息解析（**必须排在平台命令之前**，否则轮不到它）。
 *
 * 群里转发的分享卡片 / 小程序卡片大多没有链接，平台正则匹配不到，插件就完全没反应。
 * 这里先用 OCR + 平台搜索把作品定位出来，再把消息文本**换成规范链接**并 next()，
 * 后面的抖音/B站命令就能照常命中，画质面板、评论区等全部复用既有流程。
 */
/**
 * 卡片流程里回话：不同入口拿到的对象不一样 —— karin 风格的是 Message（有 reply），
 * Koishi 中间件那条链路给的是 Session（只有 send）。两种都兜上，否则会报 e.reply is not a function。
 */
const cardReply = async (target: any, content: any): Promise<void> => {
  try {
    if (typeof target?.reply === 'function') { await target.reply(content); return }
    if (typeof target?.send === 'function') { await target.send(content); return }
  } catch (error: any) {
    logger.debug('[卡片解析] 回话失败: ' + String(error?.message ?? error))
  }
}

const handleCardParse = wrapWithErrorHandler(
  async (e, next) => {
    const text = String(e.msg ?? '')
    // 诊断：这条中间件到底有没有被调用（确认后再降级为 debug）
    logger.mark('[卡片解析] 中间件收到消息: ' + text.replace(/\s+/g, ' ').slice(0, 90))
    /**
     * 卡片消息的形态（实测）：适配器给的**不是 JSON**，而是一段摘要文本 ——
     *   [卡片消息] 小程序 / 摘要: … / source: 哔哩哔哩 / title: … / preview: https://…
     * 老版本才是 JSON 卡片，所以两种都要认。有链接的直接放行走原流程。
     */
    /**
     * 只判断「这是不是一张卡片」。
     *
     * **千万不要再加「文本里有 http 就放行」** —— 卡片本身一定带 preview / source_logo
     * 两个图片链接，那样写会让所有卡片都在这行被挡回去（表现就是用户说的「没反应」）。
     * 有真实作品链接的消息不会带 `[卡片消息]` 前缀，自然走原流程。
     */
    // 卡片逻辑统一由 index.ts 的兜底中间件处理（那里才能改写文本继续匹配）——这里直接放行
    const looksCard = false
    if (!looksCard) return next()
    logger.mark('[卡片解析] 收到卡片消息: ' + text.replace(/\s+/g, ' ').slice(0, 130))

    // 提取 + OCR + 搜索要几秒，先给个反馈，免得用户以为插件没反应
    await cardReply(e, '正在提取卡片信息…')

    const resolved = await resolveCardToUrl(text)
    if (!resolved) {
      await cardReply(e, '没能从这张卡片里认出作品，直接发链接给我吧')
      return
    }
    // ① 唯一命中：把消息文本换成链接，后面的平台解析照常跑
    if (resolved.url) {
      ;(e as any).msg = resolved.url
      logger.mark('[卡片解析] 已定位到作品，转交平台解析: ' + resolved.url)
      return next()
    }
    // ② 不确定：发一张 md 表格让用户自己挑（每行一个按钮）
    const lines = ['| # | 标题 | UP / 作者 | 操作 |', '| :---: | :--- | :--- | :---: |']
    resolved.candidates.slice(0, 6).forEach((item, index) => {
      const link =
        item.platform === 'bilibili'
          ? 'https://www.bilibili.com/video/' + item.id
          : 'https://www.douyin.com/video/' + item.id
      const title = item.title.replace(/[|\n]/g, ' ').slice(0, 26) || '（无标题）'
      const author = (item.author || '-').replace(/[|\n]/g, ' ').slice(0, 12)
      lines.push('| ' + (index + 1) + ' | ' + title + ' | ' + author + ' | ' + cmdInput('解析 ' + link, '解析') + ' |')
    })
    const tip =
      '没找到唯一匹配（识别到：' + (resolved.upName || resolved.card.title || '未知') + '），下面是搜到的候选，点右侧按钮直接解析：'
    await cardReply(e, segment.markdown(tip + '\n' + lines.join('\n')))
    logger.mark('[卡片解析] 已发出候选表格，共 ' + resolved.candidates.length + ' 条')
  },
  { businessName: '卡片解析' }
)

/**
 * 卡片消息（摘要形态 / 老版 JSON 卡片）专用正则。
 *
 * **不要用 /./** ——通配正则会把命令注册表搅乱（实测指令数从 32 掉到 30，
 * 解析/kkk解析 直接消失）。这里只匹配卡片的特征文本。
 */
/**
 * 注意正则的写法：**必须能推导出指令名**，否则 index.ts 的注册循环会直接 continue，
 * 连中间件都不会挂上去（这就是卡片功能一直没反应的原因）。
 * `卡片消息` 是可推导的中文名，放最前面。
 */
export const cardAPP = karin.command(/卡片消息/, handleCardParse, { name: 'kkk-卡片解析' })

const douyin = karin.command(reg.douyin, handleDouyin, {
  name: 'kkk-视频功能-抖音',
  priority: Config.app.videoTool ? -Infinity : 800
})

const bilibili = karin.command(reg.bilibili, handleBilibili, {
  name: 'kkk-视频功能-B站',
  priority: Config.app.videoTool ? -Infinity : 800
})

const kuaishou = karin.command(reg.kuaishou, handleKuaishou, {
  name: 'kkk-视频功能-快手',
  priority: Config.app.videoTool ? -Infinity : 800
})

const xiaohongshu = karin.command(reg.xiaohongshu, handleXiaohongshu, {
  name: 'kkk-视频功能-小红书',
  priority: Config.app.videoTool ? -Infinity : 800
})

export const prefix = karin.command(/^#?(解析|kkk解析|弹幕解析)/, handlePrefix, {
  name: 'kkk-视频功能-引用解析'
})

export const douyinAPP = Config.douyin.switch && douyin
export const bilibiliAPP = Config.bilibili.switch && bilibili
export const kuaishouAPP = Config.kuaishou.switch && kuaishou
export const xiaohongshuAPP = Config.xiaohongshu.switch && xiaohongshu
