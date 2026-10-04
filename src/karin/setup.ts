import '@/module/server'
import '@/platform/bilibili/riskControl'
/**
 * 通用风控策略（任何平台的人机验证）。
 *
 * ⚠️ **必须排在 B站那一支之后**：ErrorHandler 先匹配先赢，B站 -352 的 kind 也是 risk，
 * 被这里先截走就拿不到 `v_voucher`、极验流程会断。
 */
import '../verify/riskStrategy'
import karin, { AdapterType, BOT_CONNECT, config, ImageElement, logger, Message, mkdirSync, SendMessage } from 'node-karin'
import { karinPathBase } from 'node-karin/root'

import { Common, Render, Root } from '@/module'

import { isSemverGreater } from './module/utils/semver'

declare const __REQUIRE_KARIN_VERSION__: string

// ----------------- VERSION CHECK -----------------
const requireVersion = typeof __REQUIRE_KARIN_VERSION__ !== 'undefined' ? __REQUIRE_KARIN_VERSION__ : '1.1145.14'
// const requireVersion = '1.14514.1'
if (process.env.NODE_ENV !== 'development' && isSemverGreater(requireVersion, Root.karinVersion)) {
  const msg = `[koishi-plugin-kkk] 插件构建时的 karin 版本 (${requireVersion}) 高于当前运行版本 (${Root.karinVersion})，可能会出现兼容性问题！`
  logger.warn(msg)

  /** 已发送通知的 Bot ID 和主人 ID 组合，格式：`${botId}:${master}` */
  const notifiedSet = new Set<string>()

  karin.on(BOT_CONNECT, async (bot: AdapterType) => {
    const botId = bot.selfId

    // 跳过 console Bot
    if (botId === 'console') return

    // 增加延迟，确保 bot 完全初始化
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const masters = config.master()

    logger.info(`[koishi-plugin-kkk] 监测到 Bot 连接: ${botId}, 准备发送版本警告`)

    // 生成警告图片
    let warningImage: ImageElement[] | null = null

    for (const master of masters) {
      if (master === 'console') continue

      try {
        warningImage = await Render({ bot: karin.getBot(botId) } as Message, 'other/version_warning', {
          requireVersion,
          currentVersion: Root.karinVersion
        })
      } catch (error) {
        logger.error(`[koishi-plugin-kkk] 生成版本警告图片失败: ${error}`)
      }

      const key = `${botId}:${master}`
      if (notifiedSet.has(key)) continue

      try {
        const elements: SendMessage = []
        if (warningImage) {
          elements.push(...warningImage)
        }

        await karin.sendMaster(botId, master, elements)
        notifiedSet.add(key)
        logger.info(`[koishi-plugin-kkk] 已发送版本警告给主人: ${master} (via ${botId})`)
      } catch (error) {
        logger.error(`[koishi-plugin-kkk] 发送版本警告给主人 (${master}) 失败: ${error}`)
      }
    }
  })
}

// ----------------- DATABASE INIT -----------------
// 数据库走 Koishi 原生服务（ctx.database），由插件入口在 apply 阶段调用
// bootstrapDatabases(ctx) 引导，这里不再初始化任何自有的 sqlite 文件。

// ------------------- MAIN INIT -------------------
mkdirSync(`${karinPathBase}/${Root.pluginName}/data`)
mkdirSync(Common.tempDri.images)
mkdirSync(Common.tempDri.video)
