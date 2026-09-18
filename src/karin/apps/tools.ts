import karin, { logger, type Message } from 'node-karin'

import { Common, downloadVideo } from '@/module'
import { getStatisticsDB, type ParsePlatform, type ParseWorkType } from '@/module/db'
import { Config } from '@/module/utils/Config'
import { acquireParseLock } from '@/module/utils/ParseLock'
// 注意路径必须用相对写法：@/ 别名在这个仓库里指向 karin/，写 @/compat/... 会解析成 karin/compat/...
// 那个目录不存在，会让整个 tools 应用加载失败（解析指令全部消失）。
import { parseParseFlags, runWithParseOverride } from '@/module/utils/ParseOverride'
import {
  DANMAKU_SUPPORTED,
  resolvePanelQualitySize,
  resolvePanelToken,
  sendQqParsePanel,
  type PanelRequest
} from '@/module/utils/QqPanel'
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
 * 弹幕烧录在当前部署是否真的可用。
 *
 * 上游走的是 `node-karin` 的 ffmpeg 封装，Koishi 兼容层里它是抛错的占位实现，
 * 所以这里直接把请求降级成「纯视频」并提示一句 —— 比丢一张看不懂的报错卡片强。
 * @param e 消息事件
 * @returns 是否仍然按弹幕解析
 */
const resolveBurnDanmaku = async (e: Message, requested: boolean): Promise<boolean> => {
  if (!requested || DANMAKU_SUPPORTED) return requested
  try {
    await e.reply('⚠️ 当前部署未接入 ffmpeg，弹幕烧录暂不可用，本次按纯视频解析')
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
  // 面板按钮的「切换解析内容」必须排在「弹幕解析」判断之前：
  // 按钮发的是 \`弹幕解析 <链接> --panel=1\`，它只是想换个面板，不该直接开解析
  if (flags.panel !== undefined) return await sendQqParsePanel(e, request, { danmaku: flags.panel === 1 })
  if (/^#?弹幕解析/.test(e.msg)) return false
  if (flags.hasAny) return false
  return await sendQqParsePanel(e, request, { danmaku: false })
}

// 包装抖音处理函数
const handleDouyin = wrapWithErrorHandler(
  async (e, next) => {
    // 面板指令里的参数先摘掉，避免污染后面的链接匹配
    const flags = parseParseFlags(e.msg)
    e.msg = flags.cleaned
    expandPanelToken(e, flags)

    if (e.msg.startsWith('#测试') || passthroughCommandReg.test(e.msg)) {
      return next()
    }

    // 是否为弹幕解析：用 \`弹幕解析\` 指令触发，或面板按钮里带了 --dm=1
    /**
     * 弹幕功能已整体移除：这里恒为 false，无论指令、--dm=1 还是配置都不会触发烧录。
     * （卡片上方的热门弹幕是另一条链路，不受影响）
     */
    const requestBurnDanmaku = false

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
    const forceBurnDanmaku = await resolveBurnDanmaku(e, requestBurnDanmaku)
    // 同一次点击可能被投递两遍（指令按钮 + 交互事件、连点），这里只放行一次
    const douyinKey = ['douyin', e.contact?.peer ?? '', e.userId, iddata.aweme_id, flags.override.douyinQuality ?? '', String(forceBurnDanmaku)].join(':')
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
        fromPanel: flags.panelToken !== undefined || flags.panel !== undefined || flags.bangumiPage !== undefined
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
)

// 包装B站处理函数
const handleBilibili = wrapWithErrorHandler(
  async (e, next) => {
    // 面板指令里的参数先摘掉，避免污染后面的链接匹配（BV 号是整串匹配，多一个参数就匹配不上）
    const flags = parseParseFlags(e.msg)
    e.msg = flags.cleaned
    expandPanelToken(e, flags)

    // 管理类命令内嵌B站链接（如 #kkk推送全局忽略{url}），放行给对应命令，避免被自动解析抢占
    if (passthroughCommandReg.test(e.msg)) {
      return next()
    }

    e.msg = e.msg.replace(/\\/g, '') // 移除消息中的反斜杠

    // 是否为弹幕解析（通过 #弹幕解析 命令触发，或面板里选了「视频＋弹幕」）
    /** 弹幕功能已移除：恒为 false */
    const requestBurnDanmaku = false

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
    const forceBurnDanmaku = await resolveBurnDanmaku(e, requestBurnDanmaku)
    // 同一次点击可能被投递两遍（指令按钮 + 交互事件、连点），这里只放行一次
    const biliKey = ['bilibili', e.contact?.peer ?? '', e.userId, iddata.bvid ?? '', flags.override.bilibiliQuality ?? '', String(forceBurnDanmaku)].join(':')
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
)

// 包装快手处理函数
const handleKuaishou = wrapWithErrorHandler(
  async (e) => {
    const kuaishouUrl = e.msg.replaceAll('\\', '').match(/(https:\/\/v\.kuaishou\.com\/\w+|https:\/\/www\.kuaishou\.com\/f\/[a-zA-Z0-9]+)/g)
    const startedAt = Date.now()
    // 解析参数（--q= 画质等）：之前这个分支没解析参数，面板选的画质从来没生效过
    const flags = parseParseFlags(e)
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
)

// 包装小红书处理函数
const handleXiaohongshu = wrapWithErrorHandler(
  async (e, next) => {
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
    businessName: '小红书视频解析'
  }
)

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
