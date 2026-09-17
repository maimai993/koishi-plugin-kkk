/**
 * \`@/module\` 桶文件。
 *
 * Koishi 移植说明：**不要只依赖 \`export *\`**。
 * tsc 对 CJS 的 \`export *\` 是「运行时枚举源模块的键名再绑定」，一旦存在环形依赖
 * （utils → Render → coverTheme → \`@/module\` → utils），barrel 被要求时 utils 可能还没加载完，
 * 于是只绑到前半截导出 —— 表现为 \`@/module\` 上缺少 \`Render\` / \`Common\`，
 * 消费方直接 \`not a function\`（抖音登录、推送等模块会中招）。
 *
 * 这里保留 \`export *\`（类型与新增导出照旧可用），同时对**运行时确实存在的值**显式再导出一次：
 * 显式再导出的绑定与加载顺序无关（tsc 会生成惰性 getter），从此不再受环形依赖影响。
 */
export * from './db'
export * from './utils'

// —— 显式兜底（值导出） ——
export {
  BilibiliDBBase, DouyinDBBase, METRIC_BUCKETS, StatisticsDBBase,
  bilibiliDB, bilibiliDBInstance, bootstrapDatabases, cleanOldDynamicCache,
  douyinDB, douyinDBInstance, getBilibiliDB, getDouyinDB,
  getStatisticsDB, initAllDatabases, resolveMetricBucket, statisticsDB,
  statisticsDBInstance,
} from './db'

export {
  BASE_HEADERS, Base, Common, Count,
  DEFAULT_THROTTLE_CONFIG, Downloader, EMOJI_IDS, EmojiReactionManager,
  Network, Networks, Render, Root,
  ThrottleStream, baseHeaders, buildFallbackHtml, buildGoogleMotionPhoto,
  compressVideo, downloadFile, downloadVideo, extractTotalBytesFromHeaders,
  fixM4sFile, formatBuildTime, formatBytes, getBuildMetadata,
  getEmojiId, getErrorDescription, getImageDownloader, getImageMetadata,
  getMediaDuration, getMediaFrameRate, isRecoverableNetworkError, isThrottlingError,
  loopVideo, loopVideoWithTransition, mergeVideoAudio, processImageUrl,
  processImageUrls, processLocalImageFile, sanitizeHeaders, setEmojiReaction,
  statBotId, uploadFile,
} from './utils'
