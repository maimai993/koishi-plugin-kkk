/**
 * 扫码登录会话（Koishi 迁移补充）。
 *
 * 上游 koishi-plugin-kkk 依赖 amagi **v7** 的登录会话 API：
 *   \`client.bilibili.login.qrcode()\` / \`client.douyin.login.qrcode()\` → \`session.watch({ onQrcode, onScanned, onSuccess })\`
 * 而已发布的 amagi 6.6.0 只提供 fetcher（requestLoginQrcode / checkQrcodeStatus / passport 系列），
 * client 上没有 \`login\` 命名空间。这里按 v7 的会话契约在本地补一层：
 * 取码 → 轮询 → 扫码/确认回调 → 领取凭证，使移植后的登录命令可以直接复用。
 *
 * 回调语义与 v7 保持一致（上游依赖这一点）：
 *   - **调用方回调抛错 → watch reject**，由上层登录命令自己 catch 并提示；
 *   - **中止 / 轮询失败 / 二维码过期 → watch resolve 失败态**，上层按 \`outcome.error\` 分流。
 */
import axios from 'node-karin/axios'
import { logger } from 'node-karin'

/** 登录凭证 */
export interface LoginCredential {
  /** 完整登录 cookie（name=value; ...） */
  cookie: string
  /** B站：refresh_token */
  refreshToken?: string
}

/** 二维码信息 */
export interface LoginQrcode {
  /** 二维码承载的内容（拿去生成图片） */
  content: string
  /** 剩余有效秒数 */
  expiresInSec?: number
  /** 轮询令牌（抖音：token；B站：qrcode_key） */
  key?: string
}

export interface LoginWatchOptions {
  signal?: AbortSignal
  /** 总超时，默认 180 秒 */
  timeoutMs?: number
  onQrcode?: (qrcode: LoginQrcode) => unknown | Promise<unknown>
  onScanned?: () => unknown | Promise<unknown>
  onSuccess?: (credential: LoginCredential) => unknown | Promise<unknown>
  /** 抖音的短信二次验证（当前未实现，触发时按失败结束） */
  onChallenge?: (challenge: unknown) => unknown | Promise<unknown>
}

export type LoginOutcome = { ok: true } | { ok: false; error: LoginSessionError }

/** 与 AmagiError 结构兼容的登录错误（kind / code / message 会被上层读取） */
export class LoginSessionError extends Error {
  kind: string
  code: string
  constructor (kind: string, code: string, message: string) {
    super(message)
    this.name = 'LoginSessionError'
    this.kind = kind
    this.code = code
  }
}

export interface WatchableSession {
  watch: (options?: LoginWatchOptions) => Promise<LoginOutcome>
}

export interface LoginNamespace {
  qrcode: () => WatchableSession
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 把 set-cookie 数组归一化成 \`name=value; name2=value2\`（丢掉 Path/Domain/Expires 等属性） */
export function mergeSetCookie (setCookie?: string[] | string): string {
  if (!setCookie) return ''
  const list = Array.isArray(setCookie) ? setCookie : [setCookie]
  const pairs: string[] = []
  for (const item of list) {
    const [pair] = String(item).split(';')
    if (pair && pair.includes('=')) pairs.push(pair.trim())
  }
  return pairs.join('; ')
}

/** 从跨域跳转 URL 的 query 里取登录 cookie（B站扫码成功后的标准做法） */
export function cookieFromCrossDomainUrl (url: string): string {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    const names = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']
    const pairs = names
      .map((name) => {
        const value = parsed.searchParams.get(name)
        return value ? name + '=' + decodeURIComponent(value) : ''
      })
      .filter(Boolean)
    return pairs.join('; ')
  } catch {
    return ''
  }
}

/** 解开 amagi 信封：\`{success,data:{...}}\` → 内层数据 */
function unwrap (envelope: any): any {
  if (!envelope || typeof envelope !== 'object') return envelope
  if ('success' in envelope) return envelope.data
  return envelope
}

/**
 * B站扫码登录会话（v7 契约）。
 * 状态码：86101 未扫码 / 86090 已扫码未确认 / 0 成功 / 86038 已过期。
 */
export function createBilibiliLoginSession (fetcher: any): LoginNamespace {
  return {
    qrcode () {
      return {
        async watch (options: LoginWatchOptions = {}): Promise<LoginOutcome> {
          let qrcodeKey = ''
          let qrcodeContent = ''

          // 1) 取码：只把网络调用包在 try 里
          try {
            const body = unwrap(await fetcher.requestLoginQrcode({})) ?? {}
            const payload = body?.data ?? body
            qrcodeKey = payload?.qrcode_key ?? ''
            qrcodeContent = payload?.url ?? ''
          } catch (error: any) {
            return { ok: false, error: new LoginSessionError('api', 'QRCODE_FAILED', String(error?.message ?? error)) }
          }
          if (!qrcodeContent) {
            return { ok: false, error: new LoginSessionError('api', 'QRCODE_FAILED', 'B站未返回二维码地址') }
          }

          // 2) 回调：抛错直接向上传播（与 v7 一致）
          await options.onQrcode?.({ content: qrcodeContent, expiresInSec: 180, key: qrcodeKey })

          // 3) 轮询
          const deadline = Date.now() + (options.timeoutMs ?? 180_000)
          let scannedNotified = false
          while (Date.now() < deadline) {
            if (options.signal?.aborted) {
              return { ok: false, error: new LoginSessionError('aborted', 'ABORTED', '登录已取消') }
            }
            await sleep(2000)
            if (options.signal?.aborted) {
              return { ok: false, error: new LoginSessionError('aborted', 'ABORTED', '登录已取消') }
            }

            let pollCode = -1
            let inner: any = {}
            let payload: any = {}
            try {
              const body = unwrap(await fetcher.checkQrcodeStatus({ qrcode_key: qrcodeKey })) ?? {}
              inner = body?.data ?? {}
              payload = inner?.data ?? {}
              pollCode = Number(payload?.code ?? body?.code ?? -1)
            } catch (error: any) {
              return { ok: false, error: new LoginSessionError('api', 'POLL_FAILED', String(error?.message ?? error)) }
            }

            if (pollCode === 86101) continue
            if (pollCode === 86090) {
              if (!scannedNotified) {
                scannedNotified = true
                await options.onScanned?.()
              }
              continue
            }
            if (pollCode === 86038) {
              return { ok: false, error: new LoginSessionError('api', 'COOKIE_EXPIRED', '二维码已失效') }
            }
            if (pollCode === 0) {
              const cookie = mergeSetCookie(inner?.headers?.['set-cookie'] ?? inner?.headers?.['Set-Cookie'])
                || cookieFromCrossDomainUrl(payload?.url ?? '')
              if (!cookie) {
                return { ok: false, error: new LoginSessionError('api', 'COOKIE_MISSING', '登录成功但未取到 cookie') }
              }
              await options.onSuccess?.({ cookie, refreshToken: payload?.refresh_token })
              return { ok: true }
            }
          }
          return { ok: false, error: new LoginSessionError('timeout', 'TIMEOUT', '登录超时，未完成扫码') }
        }
      }
    }
  }
}

/**
 * 抖音扫码登录会话（v7 契约的精简版）。
 *
 * amagi 6.6.0 的 passport 流程：\`requestPassportQrcode\` 拿码与 session cookie，
 * \`checkPassportQrcode\` 轮询（new/scanned/confirmed/expired/verify/risk/busy），
 * confirmed 时需要跟随 \`redirectUrl\` 才能领到最终凭证。
 * 短信二次验证（verify）暂未实现，触发时以明确错误结束。
 */
export function createDouyinLoginSession (fetcher: any): LoginNamespace {
  return {
    qrcode () {
      return {
        async watch (options: LoginWatchOptions = {}): Promise<LoginOutcome> {
          let sessionCookie = ''
          let token = ''
          let content = ''
          let expiresInSec = 60

          try {
            const body = unwrap(await fetcher.requestPassportQrcode({})) ?? {}
            const payload = body?.data ?? body
            sessionCookie = payload?.cookie ?? ''
            token = payload?.token ?? ''
            content = payload?.content ?? payload?.qrcode ?? ''
            expiresInSec = payload?.expires_in ?? 60
          } catch (error: any) {
            return { ok: false, error: new LoginSessionError('api', 'QRCODE_FAILED', String(error?.message ?? error)) }
          }
          if (!content) {
            return { ok: false, error: new LoginSessionError('api', 'QRCODE_FAILED', '抖音未返回二维码内容') }
          }

          await options.onQrcode?.({ content, expiresInSec, key: token })

          const deadline = Date.now() + (options.timeoutMs ?? 180_000)
          let scannedNotified = false
          while (Date.now() < deadline) {
            if (options.signal?.aborted) {
              return { ok: false, error: new LoginSessionError('aborted', 'ABORTED', '登录已取消') }
            }
            await sleep(2000)
            if (options.signal?.aborted) {
              return { ok: false, error: new LoginSessionError('aborted', 'ABORTED', '登录已取消') }
            }

            let payload: any = {}
            try {
              const body = unwrap(await fetcher.checkPassportQrcode({ cookie: sessionCookie, token })) ?? {}
              payload = body?.data ?? body
            } catch (error: any) {
              return { ok: false, error: new LoginSessionError('api', 'POLL_FAILED', String(error?.message ?? error)) }
            }
            if (payload?.cookie) sessionCookie = payload.cookie

            switch (payload?.status) {
              case 'new':
              case 'busy':
                break
              case 'scanned':
                if (!scannedNotified) {
                  scannedNotified = true
                  await options.onScanned?.()
                }
                break
              case 'verify':
                return { ok: false, error: new LoginSessionError('unsupported', 'NEED_VERIFY', '抖音触发了短信二次验证，当前暂不支持') }
              case 'risk':
                return { ok: false, error: new LoginSessionError('risk', 'RISK', payload?.message ?? '登录请求被抖音风控拦截') }
              case 'expired':
                return { ok: false, error: new LoginSessionError('api', 'COOKIE_EXPIRED', '二维码已失效') }
              case 'confirmed': {
                const cookie = await followRedirect(payload?.redirectUrl, sessionCookie)
                const finalCookie = cookie || payload?.cookie || sessionCookie
                if (!finalCookie) {
                  return { ok: false, error: new LoginSessionError('api', 'COOKIE_MISSING', '登录成功但未取到 cookie') }
                }
                await options.onSuccess?.({ cookie: finalCookie })
                return { ok: true }
              }
              default:
                logger.debug('[抖音登录] 未识别的轮询状态: ' + JSON.stringify(payload).slice(0, 200))
            }
          }
          return { ok: false, error: new LoginSessionError('timeout', 'TIMEOUT', '登录超时，未完成扫码') }
        }
      }
    }
  }
}

/** 跟随 redirectUrl 领取抖音最终登录凭证 */
async function followRedirect (redirectUrl: string | undefined, sessionCookie: string): Promise<string> {
  if (!redirectUrl) return ''
  try {
    const response = await axios.get(redirectUrl, {
      headers: { Cookie: sessionCookie },
      maxRedirects: 0,
      validateStatus: () => true
    })
    return mergeSetCookie(response.headers?.['set-cookie'])
  } catch (error: any) {
    logger.debug('[抖音登录] 跟随 redirect 失败: ' + String(error?.message ?? error))
    return ''
  }
}
