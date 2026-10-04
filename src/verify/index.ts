/**
 * 人机验证页（`/kkk/geetest`）。
 *
 * 平台风控（目前是 B站 -352）时要让用户过一次人机验证，以前发的是写死的第三方地址，
 * 国内经常打不开。现在由插件自己挂一张页面（HTML 见 `./page.ts`），
 * 公网地址走新增的配置项 `verifyBaseUrl` —— 和在线播放的「播放器公网地址」一个用法。
 *
 * ## 和在线播放的关系
 * 两个功能都要「给用户一条能点开的链接」，所以共用 `compat/net.ts` 里那两个
 * 取本机 IP / Koishi 端口的小工具。但**路由是各挂各的**：
 * 在线播放可能跑在自己那个独立端口上，验证页一律挂在 **Koishi 自己的端口**，
 * 所以「验证页公网地址」要指向（或反代到）Koishi 的端口，不要填播放器的域名。
 */
import { logger } from 'node-karin'

import { koishiPort, localAddress } from '../compat/net'
import { tryGetRuntime } from '../compat/runtime'
import { renderRiskPage, renderVerifyPage } from './page'

export { renderRiskPage, renderVerifyPage }

/** 验证页的挂载路径（B站风控的极验页） */
export const VERIFY_ROUTE = '/kkk/geetest'
/** 通用风控中转页的路径（平台直接给了验证页地址时用，目前是快手滑块） */
export const RISK_ROUTE = '/kkk/verify'

/**
 * 允许被中转页打开的验证页域名。
 *
 * ⚠️ 这个地址会被**拼进 `<iframe src>` 和 `<a href>`**，不做白名单就是个开放重定向 /
 * 任意页面注入 —— 谁都能拿我们的域名去套一个钓鱼页。所以只认「平台自己的验证码域名」，
 * 而且必须 https。新增平台时**在这里加一行并写清出处**。
 */
const ALLOWED_CAPTCHA_HOSTS = [
  /** 快手滑块（amagi `parseKuaishouCaptcha` 里的 `CAPTCHA_HOST`） */
  'captcha.zt.kuaishou.com'
]

/**
 * 这个地址是不是「平台给的验证页」。
 *
 * @param url 待检查的地址
 * @returns 可以安全地放进中转页
 */
export function isAllowedCaptchaUrl (url: unknown): boolean {
  const text = String(url ?? '').trim()
  if (!text) return false
  try {
    const parsed = new URL(text)
    if (parsed.protocol !== 'https:') return false
    return ALLOWED_CAPTCHA_HOSTS.includes(parsed.hostname)
  } catch {
    return false
  }
}

/**
 * 拼「通用风控中转页」的链接。
 *
 * @param options.url 平台给的验证页地址（不过白名单就返回空串，别把来路不明的地址交出去）
 * @param options.platform 平台名（显示用）
 * @param options.bizName 风控业务名（显示用）
 * @returns 一条可以直接点开的链接；地址不合法时返回空串
 */
export function buildRiskLink (
  options: { url: string, platform?: string, bizName?: string }
): string {
  const url = String(options?.url ?? '')
  if (!isAllowedCaptchaUrl(url)) return ''
  const query = '?url=' + encodeURIComponent(url)
    + (options?.platform ? '&p=' + encodeURIComponent(String(options.platform)) : '')
    + (options?.bizName ? '&biz=' + encodeURIComponent(String(options.bizName)) : '')
  const base = publicBase()
  if (base) return base + RISK_ROUTE + query
  if (!routeReady) return ''
  return 'http://' + localAddress() + ':' + koishiPort() + RISK_ROUTE + query
}

/** 公网地址（末尾斜杠去掉）；没配返回空串 */
const publicBase = (): string =>
  String((tryGetRuntime()?.config as any)?.verifyBaseUrl ?? '').trim().replace(/\/+$/, '')

/** 处理一次通用风控页请求（抽出来给探针直接调） */
export function handleRiskRequest (query: string): { status: number, headers: Record<string, string>, body: string } {
  const params = new URLSearchParams(String(query ?? '').replace(/^\?/, ''))
  const url = String(params.get('url') ?? '')
  if (!isAllowedCaptchaUrl(url)) {
    return {
      status: 400,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: '验证页地址不合法（只接受平台自己的验证码域名，且必须 https）'
    }
  }
  return {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    body: renderRiskPage({
      url,
      platform: String(params.get('p') ?? ''),
      bizName: String(params.get('biz') ?? '')
    })
  }
}

/**
 * **抓样本**：把一次风控失败的原始材料打进日志。
 *
 * ## 为什么要有它
 * 「抖音偶尔触发人机验证」这条路现在**做不了代理** —— amagi 的抖音没装挑战提取器，
 * `error.challenge` 恒为 `undefined`，我们手上只有一段反爬 HTML（`error.data`）。
 * 那段 HTML 里到底有没有验证页地址、长什么样，得看真实样本才知道，**不能猜**。
 *
 * 所以先在每次风控失败时把材料打出来，用户复现一次贴给我们，再照着写提取。
 */
export function logRiskSample (tag: string, detail: Record<string, unknown>): void {
  try {
    const brief = (value: unknown, limit = 600): string => {
      if (value === undefined || value === null) return '-'
      if (typeof value === 'string') return value.length > limit ? value.slice(0, limit) + '…' : value
      try {
        const text = JSON.stringify(value)
        return text && text.length > limit ? text.slice(0, limit) + '…' : String(text ?? '-')
      } catch {
        return String(value)
      }
    }
    logger.warn('[风控样本] ' + tag
      + ' kind=' + brief(detail.kind, 40)
      + ' amagiCode=' + brief(detail.amagiCode, 40)
      + ' code=' + brief(detail.code, 40)
      + ' http=' + brief(detail.httpStatus, 10)
      + ' reason=' + brief(detail.reason, 200)
      + ' challenge=' + brief(detail.challenge, 300)
      + ' raw=' + brief(detail.raw, 600))
  } catch { /* 打日志不能把主流程带崩 */ }
}

/**
 * 兜底用的第三方验证页（就是以前写死在代码里那个）。
 *
 * 只有**宿主没有 server 服务**（验证页根本挂不出去）时才退回它 ——
 * 有个打不开的地址也比没有强，至少用户知道要做什么。
 */
const HOSTED_FALLBACK = 'https://koishi-plugin-kkk-docs.vercel.app/geetest'

/** 路由挂上了没有（没挂 → 链接不能指向本机） */
let routeReady = false

/** 探针用：把「路由已挂载」这个状态清掉 */
export function resetVerifyRoutes (): void {
  routeReady = false
  warnedLocalBase = false
}

/** 配了「验证页公网地址」没有 */
export function hasVerifyBaseUrl (): boolean {
  try {
    return !!String((tryGetRuntime()?.config as any)?.verifyBaseUrl ?? '').trim()
  } catch {
    return false
  }
}

/** 路由挂上了没有（导出给探针和「该不该退回第三方页面」判断用） */
export function isVerifyRouteReady (): boolean {
  return routeReady
}

/** 只警告一次「没配公网地址」，不然每次风控都刷一行 */
let warnedLocalBase = false

/**
 * 拼给用户的验证链接。
 *
 * @param options.gt 极验的 gt
 * @param options.challenge 极验的 challenge
 * @returns 一条可以直接点开的链接
 */
export function buildVerifyLink ({ gt, challenge }: { gt: string, challenge: string }): string {
  const query = '?gt=' + encodeURIComponent(String(gt ?? ''))
    + '&challenge=' + encodeURIComponent(String(challenge ?? ''))

  /** 没挂上路由：本机的地址用户点不开，第三方页面还能碰碰运气 */
  if (!routeReady) {
    if (!hasVerifyBaseUrl()) {
      logger.warn('[人机验证] 宿主没有 server 服务，验证页挂不出去 —— 本次退回第三方验证页 '
        + HOSTED_FALLBACK + '（国内可能打不开）。想自己托管请给 Koishi 配上 server 插件')
    }
    return HOSTED_FALLBACK + '?v=3' + query.replace('?', '&')
  }

  const base = String((tryGetRuntime()?.config as any)?.verifyBaseUrl ?? '').trim().replace(/\/+$/, '')
  if (base) return base + VERIFY_ROUTE + query

  /**
   * 没配公网地址：退化成 `http://本机IP:端口/kkk/geetest?...`。
   * 内网 / 同一台机器上能用，群里的人多半打不开 —— 说一次，别每条链接都刷。
   */
  if (!warnedLocalBase) {
    warnedLocalBase = true
    logger.warn('[人机验证] 未配置「验证页公网地址」：验证链接会退化成 http://<本机 IP>:'
      + koishiPort() + VERIFY_ROUTE + ' 的形式（群里的人点不开）。'
      + '公网部署请在「通用 → 人机验证设置」里填上，例如 https://kkk.example.com')
  }
  return 'http://' + localAddress() + ':' + koishiPort() + VERIFY_ROUTE + query
}

/** 处理一次验证页请求（抽出来是为了探针能直接调，不用起真服务） */
export function handleVerifyRequest (query: string): { status: number, headers: Record<string, string>, body: string } {
  const params = new URLSearchParams(String(query ?? '').replace(/^\?/, ''))
  const gt = String(params.get('gt') ?? '')
  const challenge = String(params.get('challenge') ?? '')
  return {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    body: renderVerifyPage(gt, challenge)
  }
}

/**
 * 挂上 `/kkk/geetest` 路由。
 * @param ctx Koishi 上下文
 * @returns 卸载函数
 */
export function registerVerifyRoutes (ctx: any): () => void {
  const server: any = ctx?.server
  if (!server || typeof server.get !== 'function') {
    logger.warn('[人机验证] 当前宿主没有 server 服务，验证页挂不出去；'
      + '遇到风控时只能退回第三方验证页（国内可能打不开）')
    routeReady = false
    return () => {}
  }
  const write = (koa: any, response: { status: number, headers: Record<string, string>, body: string }): void => {
    koa.status = response.status
    for (const [key, value] of Object.entries(response.headers)) koa.set(key, value)
    koa.body = response.body
  }
  server.get(VERIFY_ROUTE, (koa: any) => {
    write(koa, handleVerifyRequest(String(koa.search ?? koa.querystring ?? '')))
  })
  /** 通用风控中转页：平台直接给了验证页地址时走这里 */
  server.get(RISK_ROUTE, (koa: any) => {
    write(koa, handleRiskRequest(String(koa.search ?? koa.querystring ?? '')))
  })
  routeReady = true
  logger.info('[人机验证] 验证页已挂到 Koishi 端口：' + VERIFY_ROUTE
    + (hasVerifyBaseUrl() ? '（公网地址已配置 ' + String((tryGetRuntime()?.config as any)?.verifyBaseUrl).trim() + '）'
      : '（未配置公网地址，链接只有本机 / 内网能打开）'))
  return () => { routeReady = false }
}

/**
 * 插件启动时调用：挂路由。
 *
 * 和在线播放不同，这一项**没有总开关** —— 路由本身零成本（不占端口、不起定时器），
 * 而且「真遇到风控了才发现挂不出去」就晚了，所以无条件挂上。
 */
export function setupVerifyPage (ctx: any): () => void {
  return registerVerifyRoutes(ctx)
}
