/**
 * API 路由注册
 */
import { authMiddleware } from 'node-karin'
import express from 'node-karin/express'

import { ROUTES } from '../constants/routes'
import { getBotGroupInfo, getBotGroups, getBotInfo, getBots, getGroupsBatch } from '../controllers/bots'
import { getAllConfig, updateAllConfig } from '../controllers/config'
import { getVideoEvents, getVideoStream } from '../controllers/video'

const apiRouter = express.Router()

/**
 * 认证中间件。
 *
 * Koishi 移植：上游这里是 `[authMiddleware, signatureVerificationMiddleware]` ——
 * 前者校验 Karin 控制台会话，后者校验 Karin APP 客户端的 HMAC 签名（密钥取自会话 token）。
 * 这两个客户端在 Koishi 侧都不存在，而控制台页面是零构建的静态页，做 HMAC 只会平添复杂度。
 * 因此只保留 `authMiddleware`（我们实现为 apiToken / 本机放行）。
 * 需要签名校验的场景可以自行把 `signatureVerificationMiddleware` 加回来（文件仍在 middlewares/auth.ts）。
 */
const authMiddlewares = [authMiddleware]

// Bot 管理
apiRouter.get(ROUTES.BOTS, ...authMiddlewares, getBots)
apiRouter.get(ROUTES.BOT_INFO, ...authMiddlewares, getBotInfo)
apiRouter.get(ROUTES.BOT_GROUPS, ...authMiddlewares, getBotGroups)
apiRouter.get(ROUTES.BOT_GROUP_INFO, ...authMiddlewares, getBotGroupInfo)

// 群组管理
apiRouter.post(ROUTES.GROUPS_BATCH, ...authMiddlewares, getGroupsBatch)

// 配置管理
apiRouter.get(ROUTES.CONFIG, ...authMiddlewares, getAllConfig)
apiRouter.post(ROUTES.CONFIG, ...authMiddlewares, updateAllConfig)

// 视频流
apiRouter.get(ROUTES.VIDEO_STREAM, getVideoStream)
apiRouter.get(ROUTES.VIDEO_EVENTS, getVideoEvents)

export { apiRouter }
