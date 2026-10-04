/**
 * 通用风控策略：**任何**平台的人机验证都在这里接一道。
 *
 * ## 为什么不再只写「B站 -352」那一支
 * 以前只有 B站风控（-352，极验）有专门处理，其它平台命中风控时用户拿到的是
 * 一张满屏英文的错误卡片，或者一句含糊的「Cookie 失效、被风控」——
 * 于是「偶尔触发人机验证」看上去就像插件坏了。
 *
 * 现在按 amagi 的统一契约 `kind === 'risk'` 收口，分两种：
 *
 *   1. **平台给了验证页地址**（`error.challenge.url`）→ 发一条我们自己托管的中转链接，
 *      用户点开过验证，回来重新解析。目前只有**快手**走得到这里 —— amagi 的
 *      `PLATFORM_RUNTIME` 里只有快手装了挑战提取器。
 *   2. **平台没给地址**（抖音 / 小红书）→ 不编造链接，改成把「触发了什么、该怎么办」
 *      说清楚，并把原始材料打进日志（见 `logRiskSample`）等真实样本。
 *
 * ## ⚠️ 注册顺序：必须在 B站那一支之后
 * ErrorHandler 是「先匹配先赢」。B站 -352 的 `kind` 也可能是 `risk`，
 * 如果本策略排在前面，B站的极验流程会被这里截走（拿不到 `v_voucher`，验证就走不通了）。
 * 所以 `src/karin/setup.ts` 里这一行必须写在 `import '@/platform/bilibili/riskControl'` 之后。
 */
import { logger } from 'node-karin'

import { type ErrorStrategy, registerErrorStrategy } from '@/module/utils/ErrorHandler'

import { buildRiskLink, isAllowedCaptchaUrl, logRiskSample } from './index'

export const riskChallengeStrategy: ErrorStrategy = {
  name: 'RiskChallenge',

  match: (ctx) => {
    const error: any = ctx.error
    if (!ctx.event) return false
    return error?.kind === 'risk' || !!error?.challenge?.url
  },

  async handle (ctx) {
    const event: any = ctx.event
    const error: any = ctx.error
    const challenge: any = error?.challenge ?? {}
    const url = String(challenge.url ?? '')
    const platform = String(ctx.options?.businessName ?? '').trim() || '平台'

    if (url && isAllowedCaptchaUrl(url)) {
      const link = buildRiskLink({ url, platform, bizName: String(challenge.bizName ?? '') })
      if (link) {
        logger.warn('[风控] ' + platform + ' 命中人机验证，已发中转页给用户（'
          + String(challenge.bizName ?? '未给业务名') + '）')
        try {
          await event.reply([
            platform + '这次要人机验证了，点下面的链接过去过一下：\n' + link,
            '\n过完验证回到群里重新发一次链接就能解析。（链接里带本次的验证票据，别发给别人）'
          ])
        } catch (replyError: any) {
          logger.debug('[风控] 发送验证链接失败: ' + String(replyError?.message ?? replyError))
        }
        return 'handled'
      }
    }

    /**
     * 走到这里 = **平台没给验证页地址**。
     *
     * 典型的是抖音：amagi 只判 `kind:'risk'` + `ANTIBOT_PAGE`（响应是一段反爬 HTML），
     * 没有提取地址。这时候**不能编一个链接给用户** —— 先把原始材料打出来，
     * 等拿到真实样本再补提取逻辑。
     */
    logRiskSample(platform, {
      kind: error?.kind,
      amagiCode: error?.amagiCode,
      code: error?.code,
      httpStatus: error?.httpStatus,
      reason: error?.reason ?? error?.message,
      challenge,
      raw: error?.data
    })
    try {
      await event.reply([
        platform + '这次触发了人机验证（风控），需要先过一次验证才能继续。\n',
        '可以试试：用浏览器打开' + platform + '网页版随便刷两页（有验证就过一下），'
        + '或者重新扫码登录一次，然后回来重新发链接。\n',
        '（amagi 这次没给出验证页地址，已把原始响应记进日志）'
      ])
    } catch (replyError: any) {
      logger.debug('[风控] 发送风控提示失败: ' + String(replyError?.message ?? replyError))
    }
    return 'handled'
  }
}

registerErrorStrategy(riskChallengeStrategy)
