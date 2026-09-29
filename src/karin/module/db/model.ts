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
    id: 'string',
    createdAt: 'string',
    updatedAt: 'string',
  }, { primary: 'id' })

  ctx.model.extend(TABLE.douyinGroup, {
    id: 'string',
    botId: 'string',
    createdAt: 'string',
    updatedAt: 'string',
  }, { primary: ['id', 'botId'] })

  ctx.model.extend(TABLE.douyinUser, {
    sec_uid: 'string',
    short_id: 'string',
    remark: 'string',
    living: 'boolean',
    filterMode: 'string',
    createdAt: 'string',
    updatedAt: 'string',
  }, { primary: 'sec_uid' })

  ctx.model.extend(TABLE.douyinSubscription, {
    groupId: 'string',
    sec_uid: 'string',
    createdAt: 'string',
    updatedAt: 'string',
  }, { primary: ['groupId', 'sec_uid'] })

  ctx.model.extend(TABLE.douyinAwemeCache, {
    id: 'unsigned',
    aweme_id: 'string',
    sec_uid: 'string',
    groupId: 'string',
    pushType: 'string',
    createdAt: 'string',
    updatedAt: 'string',
  }, { autoInc: true, unique: [['aweme_id', 'sec_uid', 'groupId', 'pushType']] })

  ctx.model.extend(TABLE.douyinFilterWord, {
    id: 'unsigned',
    sec_uid: 'string',
    word: 'string',
    createdAt: 'string',
    updatedAt: 'string',
  }, { autoInc: true, unique: [['sec_uid', 'word']] })

  ctx.model.extend(TABLE.douyinFilterTag, {
    id: 'unsigned',
    sec_uid: 'string',
    tag: 'string',
    createdAt: 'string',
    updatedAt: 'string',
  }, { autoInc: true, unique: [['sec_uid', 'tag']] })

  ctx.model.extend(TABLE.douyinListSnapshot, {
    id: 'unsigned',
    sec_uid: 'string',
    pushType: 'string',
    aweme_id: 'string',
    createdAt: 'string',
    updatedAt: 'string',
  }, { autoInc: true, unique: [['sec_uid', 'pushType', 'aweme_id']] })

  // ---------- B站 ----------
  ctx.model.extend(TABLE.bilibiliBot, {
    id: 'string',
    createdAt: 'string',
    updatedAt: 'string',
  }, { primary: 'id' })

  ctx.model.extend(TABLE.bilibiliGroup, {
    id: 'string',
    botId: 'string',
    createdAt: 'string',
    updatedAt: 'string',
  }, { primary: ['id', 'botId'] })

  ctx.model.extend(TABLE.bilibiliUser, {
    host_mid: 'unsigned',
    remark: 'string',
    filterMode: 'string',
    createdAt: 'string',
    updatedAt: 'string',
  }, { primary: 'host_mid' })

  ctx.model.extend(TABLE.bilibiliSubscription, {
    groupId: 'string',
    host_mid: 'unsigned',
    createdAt: 'string',
    updatedAt: 'string',
  }, { primary: ['groupId', 'host_mid'] })

  ctx.model.extend(TABLE.bilibiliDynamicCache, {
    id: 'unsigned',
    dynamic_id: 'string',
    host_mid: 'unsigned',
    groupId: 'string',
    dynamic_type: 'string',
    createdAt: 'string',
    updatedAt: 'string',
  }, { autoInc: true, unique: [['dynamic_id', 'host_mid', 'groupId']] })

  ctx.model.extend(TABLE.bilibiliFilterWord, {
    id: 'unsigned',
    host_mid: 'unsigned',
    word: 'string',
    createdAt: 'string',
    updatedAt: 'string',
  }, { autoInc: true, unique: [['host_mid', 'word']] })

  ctx.model.extend(TABLE.bilibiliFilterTag, {
    id: 'unsigned',
    host_mid: 'unsigned',
    tag: 'string',
    createdAt: 'string',
    updatedAt: 'string',
  }, { autoInc: true, unique: [['host_mid', 'tag']] })

  // ---------- 统计 ----------
  ctx.model.extend(TABLE.statsParse, {
    id: 'unsigned',
    groupId: 'string',
    userId: 'string',
    platform: 'string',
    parseCount: 'unsigned',
    createdAt: 'string',
    updatedAt: 'string',
  }, { autoInc: true, unique: [['groupId', 'userId', 'platform']] })

  ctx.model.extend(TABLE.statsHistory, {
    id: 'unsigned',
    date: 'string',
    totalParses: 'unsigned',
    douyin: 'unsigned',
    bilibili: 'unsigned',
    kuaishou: 'unsigned',
    xiaohongshu: 'unsigned',
    createdAt: 'string',
  }, { autoInc: true, unique: [['date']] })

  ctx.model.extend(TABLE.statsGlobal, {
    key: 'string',
    value: 'unsigned',
    updatedAt: 'string',
  }, { primary: 'key' })

  ctx.model.extend(TABLE.statsGroupHistory, {
    groupId: 'string',
    date: 'string',
    platform: 'string',
    parseCount: 'unsigned',
    updatedAt: 'string',
  }, { primary: ['groupId', 'date', 'platform'] })

  ctx.model.extend(TABLE.statsHour, {
    groupId: 'string',
    hour: 'unsigned',
    platform: 'string',
    parseCount: 'unsigned',
    updatedAt: 'string',
  }, { primary: ['groupId', 'hour', 'platform'] })

  ctx.model.extend(TABLE.statsWorkType, {
    groupId: 'string',
    platform: 'string',
    workType: 'string',
    parseCount: 'unsigned',
    updatedAt: 'string',
  }, { primary: ['groupId', 'platform', 'workType'] })

  ctx.model.extend(TABLE.statsMetric, {
    groupId: 'string',
    metric: 'string',
    bucket: 'string',
    parseCount: 'unsigned',
    updatedAt: 'string',
  }, { primary: ['groupId', 'metric', 'bucket'] })
}
