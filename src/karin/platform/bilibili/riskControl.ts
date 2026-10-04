import util from 'node:util'

import karin, { logger, segment } from 'node-karin'

import { AmagiError, bilibiliFetcher } from '@/module/utils/amagiClient'
import {
  type ErrorStrategy,
  registerErrorStrategy,
  renderErrorImage,
  sendErrorToAllMasters,
  sendErrorToMaster
} from '@/module/utils/ErrorHandler'
import { buildVerifyLink } from '../../../verify'

/**
 * B站风控验证策略
 * 处理 -352 错误码，引导用户完成人机验证
 */
export const bilibiliRiskControlStrategy: ErrorStrategy = {
  name: 'BilibiliRiskControl',

  match: (ctx) => {
    const { error, event } = ctx
    return error instanceof AmagiError && error.code === -352 && !!error.data?.data?.v_voucher && !!event
  },

  async handle(ctx) {
    const { error, event } = ctx
    if (!event) return 'continue'

    const amagiError = error as AmagiError
    logger.info('[BilibiliRiskControl] 检测到B站风控(-352)，开始申请验证码...')

    // 申请验证码
    const verification = await bilibiliFetcher.requestCaptchaFromVoucher({
      v_voucher: amagiError.data.data.v_voucher
    })

    if (!verification.data?.data?.geetest) {
      logger.error('[BilibiliRiskControl] 申请验证码失败')
      return 'continue'
    }

    const geetest = verification.data.data.geetest
    const token = verification.data.data.token
    /**
     * 验证页现在由**插件自己**托管（挂 Koishi 端口的 `/kkk/geetest`），
     * 公网地址走配置项「验证页公网地址」。
     *
     * 以前写死的是一个第三方站点，国内经常连不上 —— 用户打不开验证页，
     * 风控就变成「无解」，只能干等。自带页面之后唯一的外部依赖是极验自己的 CDN。
     * 宿主没有 server 服务时 `buildVerifyLink` 会退回那个第三方页面（并在日志里说清楚）。
     */
    const verifyUrl = buildVerifyLink({ gt: geetest.gt, challenge: geetest.challenge })

    // 渲染带二维码的验证图片
    const img = await renderErrorImage(ctx, {
      platform: 'bilibili',
      errorName: 'BilibiliRiskControl',
      errorMessage: 'B站风控验证',
      stack: util
        .inspect(error, { depth: 1, colors: true })
        // oxlint-disable-next-line no-control-regex
        .replace(/\x1b\[90m/g, '\x1b[90;2m')
        // oxlint-disable-next-line no-control-regex
        .replace(/\x1b\[32m/g, '\x1b[31m'),
      isVerification: true,
      verificationUrl: verifyUrl,
      share_url: verifyUrl
    })

    // 发送给触发者
    await event.reply([segment.text('检测到B站风控，请在「120 秒内」扫描二维码完成验证后发送验证结果\n'), ...img])

    // 发送给主人（单个或所有）
    await sendErrorToMaster(ctx, img)
    await sendErrorToAllMasters(ctx, img)

    const resultCtx = await karin.ctx(event)
    if (!resultCtx) return 'continue'

    const params = new URLSearchParams(resultCtx.msg)
    const validate = params.get('validate')
    const seccode = params.get('seccode')

    if (!validate || !seccode) {
      event.reply('验证参数不完整，请确保包含 validate 和 seccode')
      return 'handled'
    }

    try {
      const verifyResult = await bilibiliFetcher.validateCaptchaResult({
        challenge: geetest.challenge,
        token,
        validate,
        seccode
      })

      if (verifyResult.success && verifyResult.data?.data?.grisk_id) {
        logger.info(`[BilibiliRiskControl] 验证成功，grisk_id: ${verifyResult.data.data.grisk_id}`)
        event.reply('✅ 验证成功！请重新发送命令')
        return 'handled'
      }
      event.reply('❌ 验证失败，请重试')
    } catch (err) {
      logger.error(`[BilibiliRiskControl] 验证请求失败: ${err}`)
      if (err instanceof AmagiError) {
        // csrf 校验失败
        if (err.code === -111) {
          event.reply('❌ 验证失败，建议使用「#B站登录」重新配置 ck 以绕过风控')
          return 'handled'
        }
        event.reply(`❌ 验证失败: ${err.reason}`)
      } else {
        event.reply(`❌ 验证失败: ${(err as Error).message}`)
      }
    }
    return 'handled'
  }
}

// 注册策略
registerErrorStrategy(bilibiliRiskControlStrategy)
