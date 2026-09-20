/**
 * 单条消息的解析参数覆盖（画质 / 弹幕）。
 *
 * ## 为什么需要它
 * QQ 平台的交互面板（见 module/utils/QqPanel.ts）让用户点按钮选画质，
 * 但画质是**深埋在**业务代码里的全局配置读取：\`Config.bilibili.videoQuality\` 在
 * 取流、选流、下载各写了一次，把参数一层层传下去要改十几个函数签名。
 *
 * 这里用 AsyncLocalStorage 把「本次解析的选择」挂在异步上下文上，
 * Config 的 Proxy 读取时优先取覆盖值 —— 业务代码一行都不用改，
 * 定时推送、其它会话也不会被串味（上下文只在本条消息的处理链里生效）。
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/** 一次解析的参数覆盖 */
export interface ParseOverride {
  /** B站画质 qn（见 bilibili.yaml 的 videoQuality） */
  bilibiliQuality?: number
  /** 抖音画质档位（4k / 2k / 1080p / 720p / 540p / adapt） */
  douyinQuality?: string
  /** 小红书画质档位 */
  xiaohongshuQuality?: string
  /** 强制烧录弹幕（等价于用「#弹幕解析」触发） */
  burnDanmaku?: boolean
  /**
   * 本次走「在线播放」：不烧录弹幕，改成把视频登记成播放会话再把链接回给用户。
   *
   * 由 apps/tools.ts 在「用户要弹幕 + 播放器总开关打开」时置为 true，
   * 平台 handler 与弹幕策略都读它（见 src/player/index.ts）。
   */
  onlinePlayer?: boolean
  /**
   * 本次解析是**从 QQ 面板按钮点进来的**。
   *
   * 面板已经把卡片图发过了，所以解析时不再重复发提示语和预览卡片，
   * 只回一句「收到请求，开始下载」，再直接给下载结果。
   */
  fromPanel?: boolean
  /** 面板里这一档画质的预估体积（MB），用于提示「超过 30MB 会以文件发送」 */
  estimatedSizeMB?: number
  /** 番剧分集表格要出第几页（面板上的「上一页 / 下一页」） */
  bangumiPage?: number
}

const storage = new AsyncLocalStorage<ParseOverride>()

/**
 * 在参数覆盖的上下文里执行解析。
 * @param override 覆盖项（空对象则直接执行）
 * @param fn 解析逻辑
 */
export function runWithParseOverride<T> (override: ParseOverride, fn: () => Promise<T>): Promise<T> {
  if (!override || !Object.keys(override).length) return fn()
  return storage.run(override, fn)
}

/** 当前上下文里的覆盖项（不在解析链路里时返回 undefined） */
export function getParseOverride (): ParseOverride | undefined {
  return storage.getStore()
}

/** 从消息文本里解析出来的参数 */
export interface ParseFlags {
  /** 面板按钮的短令牌（\`--p=xxx\`），调用方用它换回真实链接 */
  panelToken?: string
  /** 覆盖项 */
  override: ParseOverride
  /** 去掉参数后的消息文本 */
  cleaned: string
  /** 是否出现了任何参数（用于判断这条消息是不是面板点出来的） */
  hasAny: boolean
  /** 面板重新渲染请求：0 纯视频 / 1 带弹幕；undefined 表示不是面板切换 */
  panel?: 0 | 1
  /** 番剧分集表格翻页：页码（配合 --p=<番剧令牌> 使用） */
  bangumiPage?: number
}

/**
 * 解析消息里的 \`--xxx\` 参数。
 *
 * 约定（按钮 action.data 与手工输入通用，所以刻意做得短、好敲）：
 *   - \`--qn=80\`    B站画质
 *   - \`--q=1080p\`  抖音/小红书画质
 *   - \`--dm=1\`     烧录弹幕
 *   - \`--panel=1\`  只重发面板（1 = 带弹幕，0 = 纯视频）
 *   - \`--p=abc123\` 面板按钮的短令牌（真实链接存在插件内存里，见 QqPanel）
 * @param msg 消息文本
 * @returns 解析结果
 */
export function parseParseFlags (msg: string): ParseFlags {
  const text = String(msg ?? '')
  const override: ParseOverride = {}
  let hasAny = false
  let panel: 0 | 1 | undefined
  let panelToken: string | undefined
  let bangumiPage: number | undefined

  const cleaned = text
    .replace(/\s*--p=([0-9a-z]+)/i, (_all, value: string) => {
      panelToken = value
      hasAny = true
      return ''
    })
    .replace(/\s*--qn=(\d+)/gi, (_all, value: string) => {
      override.bilibiliQuality = Number(value)
      hasAny = true
      return ''
    })
    .replace(/\s*--q=([0-9a-z]+)/gi, (_all, value: string) => {
      override.douyinQuality = value
      override.xiaohongshuQuality = value
      hasAny = true
      return ''
    })
    .replace(/\s*--dm=1/gi, () => {
      override.burnDanmaku = true
      hasAny = true
      return ''
    })
    .replace(/\s*--panel=([01])/gi, (_all, value: string) => {
      panel = value === '1' ? 1 : 0
      hasAny = true
      return ''
    })
    .replace(/\s*--bgp=(\d+)/gi, (_all, value: string) => {
      bangumiPage = Number(value)
      hasAny = true
      return ''
    })
    .trim()

  return { override, cleaned, hasAny, panel, panelToken, bangumiPage }
}

export default parseParseFlags
