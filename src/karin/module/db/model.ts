/**
 * Koishi 原生数据库（minato ORM）的表定义。
 *
 * 之前这个插件自己开三个 sqlite 文件（douyin.db / bilibili.db / statistics.db），
 * 现在统一走 `ctx.database`：表建在 Koishi 自己的数据库里，跟着宿主走（sqlite / mysql / postgres 都行），
 * 插件不再碰任何 sqlite 文件、也不再自己建表。
 *
 * 表名统一加 `kkk.` 前缀（Koishi 的惯例，避免和别的插件撞表）。
 *
 * `createdAt` / `updatedAt` **仍然存 ISO 字符串**（而不是 timestamp / Date）：
 * 上层几百处读的都是字符串（比如 `createdAt < 截止日期` 这种字典序比较），
 * 换成 Date 要全改一遍，没必要。
 *
 * ## 为什么索引字段都写了明确长度
 *
 * MySQL InnoDB 的单个索引总长上限是 3072 字节，utf8mb4 下每个字符 4 字节，
 * 也就是**一个索引最多 768 个字符**。字符串字段不给长度时，驱动按 VARCHAR(255) 建，
 * 复合索引很容易爆：比如作品缓存表原本 `aweme_id + sec_uid + groupId + pushType`
 * 四个 255 字段就是 1020 字符 = 4080 字节，直接 `ER_TOO_LONG_KEY`。
 * 所以凡是进了 primary / unique 的字段，都按实际数据长度写死（群号、QQ 号这类
 * 给 64 已经很宽裕），不进索引的字段（备注、昵称之类）保持默认。
 */
import { Context } from 'koishi'

/** 表名常量表 */
export const TABLE = {
  douyinBot: 'kkk.douyin.bot',
  douyinGroup: 'kkk.douyin.group',
  douyinUser: 'kkk.douyin.user',
  douyinSubscription: 'kkk.douyin.subscription',
  douyinAwemeCache: 'kkk.douyin.awemeCache',
  douyinFilterWord: 'kkk.douyin.filterWord',
  douyinFilterTag: 'kkk.douyin.filterTag',
  douyinListSnapshot: 'kkk.douyin.listSnapshot',

  bilibiliBot: 'kkk.bilibili.bot',
  bilibiliGroup: 'kkk.bilibili.group',
  bilibiliUser: 'kkk.bilibili.user',
  bilibiliSubscription: 'kkk.bilibili.subscription',
  bilibiliDynamicCache: 'kkk.bilibili.dynamicCache',
  bilibiliFilterWord: 'kkk.bilibili.filterWord',
  bilibiliFilterTag: 'kkk.bilibili.filterTag',

  statsParse: 'kkk.statistics.parse',
  statsHistory: 'kkk.statistics.history',
  statsGlobal: 'kkk.statistics.global',
  statsGroupHistory: 'kkk.statistics.groupHistory',
  statsHour: 'kkk.statistics.hour',
  statsWorkType: 'kkk.statistics.workType',
  statsMetric: 'kkk.statistics.metric',
} as const

/* ------------------------------ 行类型 ------------------------------ */

export interface BotRow {
  id: string
  createdAt: string
  updatedAt: string
}

export interface GroupRow {
  id: string
  botId: string
  createdAt: string
  updatedAt: string
}

export interface DouyinUserRow {
  sec_uid: string
  short_id: string
  remark: string
  living: boolean
  filterMode: 'blacklist' | 'whitelist'
  createdAt: string
  updatedAt: string
}

export interface DouyinSubscriptionRow {
  groupId: string
  sec_uid: string
  createdAt: string
  updatedAt: string
}

export interface AwemeCacheRow {
  id: number
  aweme_id: string
  sec_uid: string
  groupId: string
  pushType: string
  createdAt: string
  updatedAt: string
}

export interface DouyinFilterWordRow {
  id: number
  sec_uid: string
  word: string
  createdAt: string
  updatedAt: string
}

export interface DouyinFilterTagRow {
  id: number
  sec_uid: string
  tag: string
  createdAt: string
  updatedAt: string
}

export interface ListSnapshotRow {
  id: number
  sec_uid: string
  pushType: string
  aweme_id: string
  createdAt: string
  updatedAt: string
}

export interface BilibiliUserRow {
  host_mid: number
  remark: string
  filterMode: 'blacklist' | 'whitelist'
  createdAt: string
  updatedAt: string
}

export interface BilibiliSubscriptionRow {
  groupId: string
  host_mid: number
  createdAt: string
  updatedAt: string
}

export interface DynamicCacheRow {
  id: number
  dynamic_id: string
  host_mid: number
  groupId: string
  dynamic_type: string
  createdAt: string
  updatedAt: string
}

export interface BilibiliFilterWordRow {
  id: number
  host_mid: number
  word: string
  createdAt: string
  updatedAt: string
}

export interface BilibiliFilterTagRow {
  id: number
  host_mid: number
  tag: string
  createdAt: string
  updatedAt: string
}

export type ParsePlatform = 'douyin' | 'bilibili' | 'kuaishou' | 'xiaohongshu'

export type ParseWorkType = 'video' | 'gallery' | 'collection' | 'article' | 'live' | 'bangumi' | 'dynamic' | 'music' | 'unknown'

export type ParseMetric = 'duration'

export interface ParseStatisticsRow {
  id: number
  groupId: string
  userId: string
  platform: string
  parseCount: number
  createdAt: string
  updatedAt: string
}

export interface ParseHistoryRow {
  id: number
  date: string
  totalParses: number
  douyin: number
  bilibili: number
  kuaishou: number
  xiaohongshu: number
  createdAt: string
}

export interface GlobalStatisticsRow {
  key: string
  value: number
  updatedAt: string
}

export interface GroupParseHistoryRow {
  groupId: string
  date: string
  platform: string
  parseCount: number
  updatedAt: string
}

export interface ParseHourStatsRow {
  groupId: string
  hour: number
  platform: string
  parseCount: number
  updatedAt: string
}

export interface ParseWorkTypeStatsRow {
  groupId: string
  platform: string
  workType: string
  parseCount: number
  updatedAt: string
}

export interface ParseMetricStatsRow {
  groupId: string
  metric: string
  bucket: string
  parseCount: number
  updatedAt: string
}

declare module 'koishi' {
  interface Tables {
    'kkk.douyin.bot': BotRow
    'kkk.douyin.group': GroupRow
    'kkk.douyin.user': DouyinUserRow
    'kkk.douyin.subscription': DouyinSubscriptionRow
    'kkk.douyin.awemeCache': AwemeCacheRow
    'kkk.douyin.filterWord': DouyinFilterWordRow
    'kkk.douyin.filterTag': DouyinFilterTagRow
    'kkk.douyin.listSnapshot': ListSnapshotRow

    'kkk.bilibili.bot': BotRow
    'kkk.bilibili.group': GroupRow
    'kkk.bilibili.user': BilibiliUserRow
    'kkk.bilibili.subscription': BilibiliSubscriptionRow
    'kkk.bilibili.dynamicCache': DynamicCacheRow
    'kkk.bilibili.filterWord': BilibiliFilterWordRow
    'kkk.bilibili.filterTag': BilibiliFilterTagRow

    'kkk.statistics.parse': ParseStatisticsRow
    'kkk.statistics.history': ParseHistoryRow
    'kkk.statistics.global': GlobalStatisticsRow
    'kkk.statistics.groupHistory': GroupParseHistoryRow
    'kkk.statistics.hour': ParseHourStatsRow
    'kkk.statistics.workType': ParseWorkTypeStatsRow
    'kkk.statistics.metric': ParseMetricStatsRow
  }
}

/* ------------------------------ 建表 ------------------------------ */

/**
 * 定长字符串字段。
 *
 * 走索引的字段必须给长度（见文件头「为什么索引字段都写了明确长度」），
 * 这里的数字都是按实际数据留的余量：群号 / QQ 号 / 作品 id 这类最多几十个字符，
 * 抖音 sec_uid 最长见过 76，给 128。
 */
const str = (length: number) => ({ type: 'string', length }) as const

/** 进程内只建一次（插件热重载时 apply 会再跑一遍，重复 extend 没意义） */
let modelsReady = false

/**
 * 注册插件用到的所有表。
 * 在数据库实例初始化之前调用一次即可；实际建表由 Koishi 的数据库服务负责。
 */
export const extendModels = (ctx: Context): void => {
  if (modelsReady) return
  modelsReady = true

  // ---------- 抖音 ----------
  ctx.model.extend(TABLE.douyinBot, {
    id: str(64),
    createdAt: str(32),
    updatedAt: str(32),
  }, { primary: 'id' })

  ctx.model.extend(TABLE.douyinGroup, {
    id: str(64),
    botId: str(64),
    createdAt: str(32),
    updatedAt: str(32),
  }, { primary: ['id', 'botId'] })

  ctx.model.extend(TABLE.douyinUser, {
    sec_uid: str(128),
    short_id: str(64),
    remark: 'string',
    living: 'boolean',
    filterMode: str(16),
    createdAt: str(32),
    updatedAt: str(32),
  }, { primary: 'sec_uid' })

  ctx.model.extend(TABLE.douyinSubscription, {
    groupId: str(64),
    sec_uid: str(128),
    createdAt: str(32),
    updatedAt: str(32),
  }, { primary: ['groupId', 'sec_uid'] })

  ctx.model.extend(TABLE.douyinAwemeCache, {
    id: 'unsigned',
    aweme_id: str(64),
    sec_uid: str(128),
    groupId: str(64),
    pushType: str(32),
    createdAt: str(32),
    updatedAt: str(32),
  }, { autoInc: true, unique: [['aweme_id', 'sec_uid', 'groupId', 'pushType']] })

  ctx.model.extend(TABLE.douyinFilterWord, {
    id: 'unsigned',
    sec_uid: str(128),
    word: str(128),
    createdAt: str(32),
    updatedAt: str(32),
  }, { autoInc: true, unique: [['sec_uid', 'word']] })

  ctx.model.extend(TABLE.douyinFilterTag, {
    id: 'unsigned',
    sec_uid: str(128),
    tag: str(128),
    createdAt: str(32),
    updatedAt: str(32),
  }, { autoInc: true, unique: [['sec_uid', 'tag']] })

  ctx.model.extend(TABLE.douyinListSnapshot, {
    id: 'unsigned',
    sec_uid: str(128),
    pushType: str(32),
    aweme_id: str(64),
    createdAt: str(32),
    updatedAt: str(32),
  }, { autoInc: true, unique: [['sec_uid', 'pushType', 'aweme_id']] })

  // ---------- B站 ----------
  ctx.model.extend(TABLE.bilibiliBot, {
    id: str(64),
    createdAt: str(32),
    updatedAt: str(32),
  }, { primary: 'id' })

  ctx.model.extend(TABLE.bilibiliGroup, {
    id: str(64),
    botId: str(64),
    createdAt: str(32),
    updatedAt: str(32),
  }, { primary: ['id', 'botId'] })

  ctx.model.extend(TABLE.bilibiliUser, {
    host_mid: 'unsigned',
    remark: 'string',
    filterMode: str(16),
    createdAt: str(32),
    updatedAt: str(32),
  }, { primary: 'host_mid' })

  ctx.model.extend(TABLE.bilibiliSubscription, {
    groupId: str(64),
    host_mid: 'unsigned',
    createdAt: str(32),
    updatedAt: str(32),
  }, { primary: ['groupId', 'host_mid'] })

  ctx.model.extend(TABLE.bilibiliDynamicCache, {
    id: 'unsigned',
    dynamic_id: str(64),
    host_mid: 'unsigned',
    groupId: str(64),
    dynamic_type: str(32),
    createdAt: str(32),
    updatedAt: str(32),
  }, { autoInc: true, unique: [['dynamic_id', 'host_mid', 'groupId']] })

  ctx.model.extend(TABLE.bilibiliFilterWord, {
    id: 'unsigned',
    host_mid: 'unsigned',
    word: str(128),
    createdAt: str(32),
    updatedAt: str(32),
  }, { autoInc: true, unique: [['host_mid', 'word']] })

  ctx.model.extend(TABLE.bilibiliFilterTag, {
    id: 'unsigned',
    host_mid: 'unsigned',
    tag: str(128),
    createdAt: str(32),
    updatedAt: str(32),
  }, { autoInc: true, unique: [['host_mid', 'tag']] })

  // ---------- 统计 ----------
  ctx.model.extend(TABLE.statsParse, {
    id: 'unsigned',
    groupId: str(64),
    userId: str(64),
    platform: str(32),
    parseCount: 'unsigned',
    createdAt: str(32),
    updatedAt: str(32),
  }, { autoInc: true, unique: [['groupId', 'userId', 'platform']] })

  ctx.model.extend(TABLE.statsHistory, {
    id: 'unsigned',
    date: str(16),
    totalParses: 'unsigned',
    douyin: 'unsigned',
    bilibili: 'unsigned',
    kuaishou: 'unsigned',
    xiaohongshu: 'unsigned',
    createdAt: str(32),
  }, { autoInc: true, unique: [['date']] })

  ctx.model.extend(TABLE.statsGlobal, {
    key: str(64),
    value: 'unsigned',
    updatedAt: str(32),
  }, { primary: 'key' })

  ctx.model.extend(TABLE.statsGroupHistory, {
    groupId: str(64),
    date: str(16),
    platform: str(32),
    parseCount: 'unsigned',
    updatedAt: str(32),
  }, { primary: ['groupId', 'date', 'platform'] })

  ctx.model.extend(TABLE.statsHour, {
    groupId: str(64),
    hour: 'unsigned',
    platform: str(32),
    parseCount: 'unsigned',
    updatedAt: str(32),
  }, { primary: ['groupId', 'hour', 'platform'] })

  ctx.model.extend(TABLE.statsWorkType, {
    groupId: str(64),
    platform: str(32),
    workType: str(32),
    parseCount: 'unsigned',
    updatedAt: str(32),
  }, { primary: ['groupId', 'platform', 'workType'] })

  ctx.model.extend(TABLE.statsMetric, {
    groupId: str(64),
    metric: str(32),
    bucket: str(32),
    parseCount: 'unsigned',
    updatedAt: str(32),
  }, { primary: ['groupId', 'metric', 'bucket'] })
}
