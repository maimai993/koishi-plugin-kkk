import type { ApiErrorData } from '@template/template/other/handlerError/components/types'
import { logger, type Message } from 'node-karin'

import { getBuildMetadata } from '@/module'
import { EmojiReactionManager } from '@/module/utils/EmojiReaction'

import { uploadErrorReport, type ErrorReportResult } from '../ErrorReport'
import { platformOf, sliceImageToElements } from '../ImageSlice'
import { renderErrorImage } from './render'
import { sendErrorToAdmins, sendErrorToAllMasters, sendErrorToConfiguredIds, sendErrorToMaster, sendErrorToTrigger } from './sender'
import { getStrategies } from './strategy'
import type { ErrorContext, ErrorHandlerOptions } from './types'
import { injectBotToEventForPushTask, isPushTask, parseLogsToStructured } from './utils'

export const handleBusinessError = async (
  error: Error,
  options: ErrorHandlerOptions,
  logs: ApiErrorData['logs'],
  event: Message
): Promise<'handled' | undefined> => {
  try {
    logger.debug(`[ErrorHandler] 开始处理业务错误: ${options.businessName}`)

    const buildMetadata = getBuildMetadata()
    const adapterInfo = event.bot?.adapter ? event.bot.adapter : undefined

    /**
     * **先上报，再渲染卡片**：上报编号要印在卡片上、也要拼进消息里，
     * 让用户拿着编号进群提问。上传失败/被关掉都只是返回 null，不挡流程。
     */
    let report: ErrorReportResult | null = null
    try {
      report = await uploadErrorReport({
        error,
        business: options.businessName,
        event,
        adapterInfo,
        // 本次请求捕获到的日志行：structuredLogs 里带着原始串（已在 parseLogsToStructured 里逐行折叠 + 截断）
        logs: (logs ?? []).map((entry: any) => String(entry?.raw ?? entry?.message ?? ''))
      })
    } catch (reportError: any) {
      // 用 warn：这一条以前写成 debug，结果一个 ReferenceError 被静静吞掉，只有「上传失败」四个字能看到
      logger.warn('[ErrorHandler] 错误上报异常（忽略，不影响报错本身）: ' + String(reportError?.message ?? reportError))
    }

    const ctx: ErrorContext = {
      error,
      options,
      logs,
      event,
      buildMetadata,
      adapterInfo,
      report
    }

    for (const strategy of getStrategies()) {
      if (strategy.match(ctx)) {
        logger.debug(`[ErrorHandler] 匹配策略: ${strategy.name}`)
        const result = await strategy.handle(ctx)
        if (result === 'handled') return 'handled'
      }
    }

    let img = await renderErrorImage(ctx)
    /**
     * 错误卡片也会超长（实测 2880×40000 / 45MB），直接发必被 QQ 拒收 ——
     * 统一切片：官方 QQ 切成一条 markdown，OneBot 切成若干图片段（它不渲染 markdown），
     * 失败就退回原图。
     */
    try {
      const sliced = await sliceImageToElements(img, platformOf(event))
      if (sliced?.length) img = sliced
    } catch (sliceError: any) {
      logger.debug('[ErrorHandler] 错误卡片切片失败，按原图发送: ' + String(sliceError?.message ?? sliceError))
    }
    await sendErrorToTrigger(ctx, img)
    await sendErrorToMaster(ctx, img)
    await sendErrorToAllMasters(ctx, img)
    // 「管理员」= 权限等级 > 4（Koishi 的主人档）
    await sendErrorToAdmins(ctx, img).catch((err) => logger.warn('[ErrorHandler] 发送给管理员失败: ' + String(err)))
    await sendErrorToConfiguredIds(ctx, img).catch((err) => logger.warn('[ErrorHandler] 发送给指定账号失败: ' + String(err)))

    if (options.customErrorHandler) {
      try {
        await options.customErrorHandler(error, logs)
      } catch (err) {
        logger.error(`[ErrorHandler] 自定义错误处理失败: ${err}`)
      }
    }
  } catch (handlerError) {
    logger.error(`[ErrorHandler] 错误处理器本身发生错误: ${handlerError}`)
    throw handlerError
  }
  return undefined
}

export const wrapWithErrorHandler = <R>(fn: (e: Message, next: () => unknown) => R | Promise<R>, options: ErrorHandlerOptions) => {
  return async (e?: Message, next?: () => unknown): Promise<R> => {
    const rawEvent = e
    const normalizedEvent = await injectBotToEventForPushTask(rawEvent, options.businessName)
    const normalizedNext = next ?? (() => undefined)
    const shouldHandleEmoji = Boolean(rawEvent) && !isPushTask(rawEvent, options.businessName)
    const emojiManager = shouldHandleEmoji ? new EmojiReactionManager(rawEvent as Message) : undefined
    let processingTimer: NodeJS.Timeout | null = null
    let successTimer: NodeJS.Timeout | null = null

    if (emojiManager) {
      await emojiManager.add('EYES')
      processingTimer = setTimeout(() => {
        emojiManager.add('PROCESSING').catch(() => {})
      }, 1500)
    }

    const ctx = logger.runContext(async () => fn(normalizedEvent, normalizedNext))

    try {
      const result = await ctx.run()

      if (emojiManager) {
        successTimer = setTimeout(() => {
          emojiManager.replace('PROCESSING', 'SUCCESS').catch(() => {})
        }, 1500)
      }

      return result
    } catch (error) {
      if (processingTimer) clearTimeout(processingTimer)
      if (successTimer) clearTimeout(successTimer)

      if (emojiManager) {
        const processingEmojiId = emojiManager['getPlatformEmojiId']('PROCESSING')
        if (emojiManager.has(processingEmojiId)) {
          await emojiManager.remove('PROCESSING')
        }
        await emojiManager.add('ERROR')
      }

      logger.debug('[ErrorHandler] 原始错误: ' + ((error as any)?.stack ?? String(error)))
      await new Promise((resolve) => setTimeout(resolve, 100))
      const structuredLogs = parseLogsToStructured(ctx.logs())

      const result = await handleBusinessError(error as Error, options, structuredLogs, normalizedEvent)
      if (result === 'handled') return undefined as R
      throw error
    }
  }
}
