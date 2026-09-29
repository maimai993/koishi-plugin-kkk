import { $, Context } from 'koishi'
import { logger } from 'node-karin'

import {
  TABLE,
  type GroupParseHistoryRow,
  type ParseHistoryRow,
  type ParseHourStatsRow,
  type ParseMetric,
  type ParseMetricStatsRow,
  type ParsePlatform,
  type ParseStatisticsRow,
  type ParseWorkType,
  type ParseWorkTypeStatsRow
} from './model'

export type { ParseMetric, ParsePlatform, ParseWorkType } from './model'
export type {
  GroupParseHistoryRow as GroupParseHistory,
  ParseHourStatsRow as ParseHourStats,
  ParseWorkTypeStatsRow as ParseWorkTypeStats
} from './model'

/**
 * 指标的分桶边界（左闭右开）。`duration` 单位毫秒。
 *
 * 每条桶有两个标签：
 * - `label` 是**区间**口径（「这一档是什么范围」）
 * - `upper` 是**累计**口径，画累计曲线时用它 —— 「≤5s」可以直接读成「5 秒内跑完的占多少」；
 *   最后一档是兜底档，累计标签写「全部」（累计到这里必然是 100%，写 `>10min` 会被读反）
 *
 * 档位刻意拉宽到 `10min+`：早先只到 `30s+`，只要部署环境整体偏慢，
 * 所有数据就都掉进最后一格，累计曲线退化成「左边一长条 0%、右边直接 100%」，整张图作废。
 * 加密到 12 档是因为累计曲线要有足够折点，档太少那条线会变成几段直线。
 * 读侧会把两端没数据的档裁掉（见 `buildMetricDistributions`），所以档多不会让图变挤。
 */
export const METRIC_BUCKETS: Record<ParseMetric, Array<{ label: string; upper: string; max: number }>> = {
  duration: [
    { label: '<0.5s', upper: '≤0.5s', max: 500 },
    { label: '0.5-1s', upper: '≤1s', max: 1000 },
    { label: '1-2s', upper: '≤2s', max: 2000 },
    { label: '2-3s', upper: '≤3s', max: 3000 },
    { label: '3-5s', upper: '≤5s', max: 5000 },
    { label: '5-10s', upper: '≤10s', max: 10000 },
    { label: '10-20s', upper: '≤20s', max: 20000 },
    { label: '20-30s', upper: '≤30s', max: 30000 },
    { label: '30-60s', upper: '≤60s', max: 60000 },
    { label: '1-3min', upper: '≤3min', max: 180000 },
    { label: '3-10min', upper: '≤10min', max: 600000 },
    // 兜底档没有上界，累计口径上它代表「其余全部」，写成「>10min」会被误读成「100% 都超过 10 分钟」
    { label: '10min+', upper: '全部', max: Number.MAX_SAFE_INTEGER }
  ]
}

/**
 * 取数值落在哪个桶。负数与 NaN 都归到第一桶 —— 采到脏数据时宁可低估也不要抛错。
 * @param metric 指标名
 * @param value 原始数值
 */
export const resolveMetricBucket = (metric: ParseMetric, value: number): string => {
  const buckets = METRIC_BUCKETS[metric]
  if (!Number.isFinite(value) || value < 0) return buckets[0].label
  return (buckets.find((bucket) => value < bucket.max) ?? buckets[buckets.length - 1]).label
}

/** 指标分布的一行（群海报与全局海报共用） */
export interface ParseMetricBucketRow {
  /** 指标名 */
  metric: ParseMetric
  /** 分桶标签 */
  bucket: string
  /** 次数 */
  count: number
}

/**
 * 解析统计接口 - 存储各平台解析统计数据
 */
interface ParseStatistics {
  /** 统计ID */
  id: number
  /** 群组ID */
  groupId: string
  /** 用户ID */
  userId: string
  /** 平台类型：douyin、bilibili、kuaishou、xiaohongshu */
  platform: ParsePlatform
  /** 解析次数 */
  parseCount: number
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
}

/**
 * 解析历史接口 - 存储每日解析统计数据
 */
interface ParseHistory {
  /** 统计ID */
  id: number
  /** 日期 (YYYY-MM-DD) */
  date: string
  /** 总解析次数 */
  totalParses: number
  /** 抖音解析次数 */
  douyin: number
  /** 哔哩哔哩解析次数 */
  bilibili: number
  /** 快手解析次数 */
  kuaishou: number
  /** 小红书解析次数 */
  xiaohongshu: number
  /** 创建时间 */
  createdAt: string
}

/** UTC 日期（YYYY-MM-DD），与旧版 sqlite 里 `date('now')` 的口径一致 */
const today = (): string => new Date().toISOString().split('T')[0]

/** 当前时间戳（ISO 字符串） */
const now = () => new Date().toISOString()

/** 统计数据库操作类（基于 Koishi 原生数据库服务） */
export class StatisticsDBBase {
  private ctx: Context

  constructor(ctx: Context) {
    this.ctx = ctx
  }

  private get db() {
    return this.ctx.database
  }

  /**
   * 关闭数据库连接。
   *
   * 现在连接由 Koishi 的数据库服务统一管理，这里不需要做任何事；
   * 保留这个方法只是为了兼容老调用方（测试脚本会调）。
   */
  async close(): Promise<void> {
    /* 由 Koishi 托管，无需手动关闭 */
  }

  /**
   * 初始化数据库
   */
  async init(): Promise<StatisticsDBBase> {
    try {
      logger.debug(logger.green('--------------------------[StatisticsDB] 开始初始化数据库--------------------------'))
      logger.debug('[StatisticsDB] 使用 Koishi 原生数据库服务，表已由 ctx.model.extend 注册')
      logger.debug('[StatisticsDB] 数据库模型同步成功')

      // 初始化全局统计数据
      await this.initGlobalStatistics()

      // 同步历史数据（仅在首次迁移后执行）
      await this.syncHistoryFromStats()

      logger.debug(logger.green('--------------------------[StatisticsDB] 初始化数据库完成--------------------------'))
    } catch (error) {
      logger.error('[StatisticsDB] 数据库初始化失败:', error)
      throw error
    }

    return this
  }

  /**
   * 初始化全局统计数据
   */
  private async initGlobalStatistics(): Promise<void> {
    for (const key of ['totalGroups', 'totalParses']) {
      const [row] = await this.db.get(TABLE.statsGlobal, { key })
      if (row) continue
      await this.db.create(TABLE.statsGlobal, { key, value: 0, updatedAt: now() })
    }
  }

  /**
   * 记录解析统计
   * @param groupId 群组ID
   * @param userId 用户ID
   * @param platform 平台类型
   * @param options.workType 本次解析的内容形态，取不到时该维度不计数
   * @param options.durationMs 本次解析耗时（毫秒）
   */
  async recordParse(
    groupId: string,
    userId: string,
    platform: ParsePlatform,
    options: { workType?: ParseWorkType; durationMs?: number } = {}
  ): Promise<void> {
    const time = now()
    const date = today()

    // 检查是否已存在该用户在该群组的统计记录
    const [existing] = await this.db.get(TABLE.statsParse, { groupId, userId, platform })

    if (existing) {
      // 更新解析次数
      await this.db.set(TABLE.statsParse, { groupId, userId, platform }, (row: any) => ({
        parseCount: $.add($.ifNull(row.parseCount, 0), 1),
        updatedAt: time
      }))
    } else {
      // 创建新记录
      await this.db.create(TABLE.statsParse, {
        groupId,
        userId,
        platform,
        parseCount: 1,
        createdAt: time,
        updatedAt: time
      })

      // 检查是否是新群组
      const groupRows = await this.db.get(TABLE.statsParse, { groupId }, { limit: 2 })
      if (groupRows.length === 1) {
        await this.incrementTotalGroups()
      }
    }

    // 更新总解析次数
    await this.incrementTotalParses()

    // 更新每日历史记录
    await this.updateDailyHistory(date, platform)

    // 以下是本次新增的维度。任何一张写失败都不该让解析主流程或其它维度受影响，
    // 所以逐条兜住，只记日志。
    await this.safeIncrement('群维度日粒度', () => this.incrementGroupHistory(groupId, date, platform))
    await this.safeIncrement('活跃时段', () => this.incrementHourStats(groupId, new Date().getHours(), platform))
    if (options.workType) {
      await this.safeIncrement('内容形态', () => this.incrementWorkTypeStats(groupId, platform, options.workType!))
    }

    // 解析耗时按桶落库。取不到就跳过 —— handler 在埋点之前抛错时就没有这个值
    if (options.durationMs !== undefined) {
      await this.safeIncrement('解析耗时', () =>
        this.incrementMetricStats(groupId, 'duration', resolveMetricBucket('duration', options.durationMs!))
      )
    }
  }

  /**
   * 跑一段自增写入，失败只记日志。
   * 新增维度都是「锦上添花」，不能反过来把解析统计主流程带崩。
   */
  private async safeIncrement(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
    } catch (error) {
      logger.error(`[StatisticsDB] 更新${label}统计失败:`, error)
    }
  }

  /**
   * 群维度日粒度自增
   */
  private async incrementGroupHistory(groupId: string, date: string, platform: ParsePlatform): Promise<void> {
    await this.db.upsert(TABLE.statsGroupHistory, (row: any) => [{
      groupId,
      date,
      platform,
      parseCount: $.add($.ifNull(row.parseCount, 0), 1),
      updatedAt: now()
    }])
  }

  /**
   * 小时粒度自增
   */
  private async incrementHourStats(groupId: string, hour: number, platform: ParsePlatform): Promise<void> {
    await this.db.upsert(TABLE.statsHour, (row: any) => [{
      groupId,
      hour,
      platform,
      parseCount: $.add($.ifNull(row.parseCount, 0), 1),
      updatedAt: now()
    }])
  }

  /**
   * 内容形态自增
   */
  private async incrementWorkTypeStats(groupId: string, platform: ParsePlatform, workType: ParseWorkType): Promise<void> {
    await this.db.upsert(TABLE.statsWorkType, (row: any) => [{
      groupId,
      platform,
      workType,
      parseCount: $.add($.ifNull(row.parseCount, 0), 1),
      updatedAt: now()
    }])
  }

  /**
   * 指标分桶自增
   */
  private async incrementMetricStats(groupId: string, metric: ParseMetric, bucket: string): Promise<void> {
    await this.db.upsert(TABLE.statsMetric, (row: any) => [{
      groupId,
      metric,
      bucket,
      parseCount: $.add($.ifNull(row.parseCount, 0), 1),
      updatedAt: now()
    }])
  }

  /**
   * 更新每日历史记录
   * @param date 日期 (YYYY-MM-DD)
   * @param platform 平台类型
   */
  private async updateDailyHistory(date: string, platform: ParsePlatform): Promise<void> {
    try {
      const [existing] = await this.db.get(TABLE.statsHistory, { date })

      if (existing) {
        await this.db.set(TABLE.statsHistory, { date }, (row: any) => ({
          totalParses: $.add($.ifNull(row.totalParses, 0), 1),
          [platform]: $.add($.ifNull(row[platform], 0), 1)
        }))
      } else {
        await this.db.create(TABLE.statsHistory, {
          date,
          totalParses: 1,
          douyin: platform === 'douyin' ? 1 : 0,
          bilibili: platform === 'bilibili' ? 1 : 0,
          kuaishou: platform === 'kuaishou' ? 1 : 0,
          xiaohongshu: platform === 'xiaohongshu' ? 1 : 0,
          createdAt: now()
        })
      }
    } catch (error) {
      logger.error('[StatisticsDB] 更新每日历史记录失败:', error)
    }
  }

  /**
   * 获取最近N天的解析历史
   * @param days 天数，默认30天
   */
  async getRecentHistory(days: number = 30): Promise<ParseHistory[]> {
    return (await this.db.get(TABLE.statsHistory, {}, {
      sort: { date: 'desc' },
      limit: days
    })) as ParseHistoryRow[]
  }

  /**
   * 从现有统计数据同步历史记录（用于迁移后的数据修复）
   */
  async syncHistoryFromStats(): Promise<void> {
    try {
      // 检查 ParseHistory 表是否为空
      const historyRows = await this.db.get(TABLE.statsHistory, {}, { limit: 1 })
      // 如果已有历史数据，不需要同步
      if (historyRows.length) return

      // 获取所有统计数据
      const allStats: ParseStatisticsRow[] = await this.db.get(TABLE.statsParse, {})

      // 按日期和平台聚合
      const dateMap = new Map<
        string,
        {
          douyin: number
          bilibili: number
          kuaishou: number
          xiaohongshu: number
        }
      >()

      for (const stat of allStats) {
        const date = stat.createdAt.split('T')[0]

        if (!dateMap.has(date)) {
          dateMap.set(date, { douyin: 0, bilibili: 0, kuaishou: 0, xiaohongshu: 0 })
        }

        const dateData = dateMap.get(date)!
        if (stat.platform in dateData) {
          (dateData as any)[stat.platform] += stat.parseCount ?? 0
        }
      }

      // 插入历史记录
      for (const [date, platforms] of dateMap.entries()) {
        const totalParses = platforms.douyin + platforms.bilibili + platforms.kuaishou + platforms.xiaohongshu

        await this.db.create(TABLE.statsHistory, {
          date,
          totalParses,
          douyin: platforms.douyin,
          bilibili: platforms.bilibili,
          kuaishou: platforms.kuaishou,
          xiaohongshu: platforms.xiaohongshu,
          createdAt: now()
        })
      }

      logger.info(`[StatisticsDB] 已同步 ${dateMap.size} 天的历史数据`)
    } catch (error) {
      logger.error('[StatisticsDB] 同步历史数据失败:', error)
    }
  }

  /**
   * 获取群组的解析统计
   * @param groupId 群组ID
   */
  async getGroupStatistics(groupId: string): Promise<ParseStatistics[]> {
    return (await this.db.get(TABLE.statsParse, { groupId }, {
      sort: { platform: 'asc', userId: 'asc' }
    })) as ParseStatisticsRow[]
  }

  /**
   * 获取群组的唯一用户数
   * @param groupId 群组ID
   */
  async getGroupUniqueUsers(groupId: string): Promise<number> {
    const rows: ParseStatisticsRow[] = await this.db.get(TABLE.statsParse, { groupId })
    return new Set(rows.map((row) => row.userId)).size
  }

  /**
   * 获取全局唯一用户数
   */
  async getTotalUniqueUsers(): Promise<number> {
    const rows: ParseStatisticsRow[] = await this.db.get(TABLE.statsParse, {})
    return new Set(rows.map((row) => row.userId)).size
  }

  /**
   * 获取所有群组的解析统计
   */
  async getAllStatistics(): Promise<ParseStatistics[]> {
    return (await this.db.get(TABLE.statsParse, {}, {
      sort: { groupId: 'asc', platform: 'asc' }
    })) as ParseStatisticsRow[]
  }

  /**
   * 获取平台总解析次数
   * @param platform 平台类型
   */
  async getPlatformTotalParses(platform: ParsePlatform): Promise<number> {
    const rows: ParseStatisticsRow[] = await this.db.get(TABLE.statsParse, { platform })
    return rows.reduce((sum, row) => sum + (Number(row.parseCount) || 0), 0)
  }

  /**
   * 获取某个群最近 N 天的日粒度记录（按日期升序，便于直接喂折线图）
   *
   * 日期口径与写入端一致，都取 `toISOString()` 的 UTC 日期。
   * @param groupId 群组ID
   * @param days 天数，默认 30 天
   */
  async getGroupRecentHistory(groupId: string, days: number = 30): Promise<GroupParseHistory[]> {
    const from = new Date()
    from.setUTCDate(from.getUTCDate() - Math.max(0, days - 1))
    const cutoff = from.toISOString().split('T')[0]

    return (await this.db.get(TABLE.statsGroupHistory, {
      groupId,
      date: { $gte: cutoff }
    }, { sort: { date: 'asc' } })) as GroupParseHistoryRow[]
  }

  /**
   * 获取某个群有解析记录的天数（不限于最近 N 天）
   * @param groupId 群组ID
   */
  async getGroupActiveDays(groupId: string): Promise<number> {
    const rows: GroupParseHistoryRow[] = await this.db.get(TABLE.statsGroupHistory, { groupId })
    return new Set(rows.map((row) => row.date)).size
  }

  /**
   * 获取某个群的小时粒度分布（0-23，缺失的小时由调用方补零）
   * @param groupId 群组ID
   */
  async getGroupHourStats(groupId: string): Promise<ParseHourStats[]> {
    return (await this.db.get(TABLE.statsHour, { groupId }, { sort: { hour: 'asc' } })) as ParseHourStatsRow[]
  }

  /**
   * 获取某个群的内容形态分布
   * @param groupId 群组ID
   */
  async getGroupWorkTypeStats(groupId: string): Promise<ParseWorkTypeStats[]> {
    return (await this.db.get(TABLE.statsWorkType, { groupId }, {
      sort: { parseCount: 'desc' }
    })) as ParseWorkTypeStatsRow[]
  }

  /**
   * 获取全局内容形态分布（按平台 × 形态聚合）
   */
  async getGlobalWorkTypeStats(): Promise<ParseWorkTypeStats[]> {
    const rows: ParseWorkTypeStatsRow[] = await this.db.get(TABLE.statsWorkType, {})
    const map = new Map<string, ParseWorkTypeStatsRow>()

    for (const row of rows) {
      const key = row.platform + ' ' + row.workType
      const current = map.get(key)
      if (current) {
        current.parseCount += Number(row.parseCount) || 0
        if ((row.updatedAt ?? '') > (current.updatedAt ?? '')) current.updatedAt = row.updatedAt
      } else {
        map.set(key, { ...row, parseCount: Number(row.parseCount) || 0 })
      }
    }

    return [...map.values()].sort((a, b) => {
      if (a.platform !== b.platform) return a.platform < b.platform ? -1 : 1
      return (Number(b.parseCount) || 0) - (Number(a.parseCount) || 0)
    })
  }

  /**
   * 获取某个群的指标分桶分布（耗时 / 作品时长 / 点赞）
   * @param groupId 群组ID
   */
  async getGroupMetricStats(groupId: string): Promise<ParseMetricBucketRow[]> {
    const rows: ParseMetricStatsRow[] = await this.db.get(TABLE.statsMetric, { groupId })
    return aggregateMetrics(rows)
  }

  /**
   * 获取全局指标分桶分布（耗时 / 作品时长 / 点赞）
   */
  async getGlobalMetricStats(): Promise<ParseMetricBucketRow[]> {
    const rows: ParseMetricStatsRow[] = await this.db.get(TABLE.statsMetric, {})
    return aggregateMetrics(rows)
  }

  /**
   * 取全局日粒度趋势里「数据可信」的起始日期。
   * @returns 可信起始日（YYYY-MM-DD）；一行可信数据都没有时返回 undefined
   */
  async getHistoryCompleteFrom(): Promise<string | undefined> {
    // 老库回填（syncHistoryFromStats）会把用户的历史总次数全记在他首次解析那天，
    // 那批行的特征是 date 与写入时间 createdAt 不在同一天；
    // 增量写入的行两者必然同天（都取 UTC）。据此切出可信区间的起点。
    const rows: ParseHistoryRow[] = await this.db.get(TABLE.statsHistory, {})
    let min: string | undefined
    for (const row of rows) {
      if (!row.date || row.date !== String(row.createdAt ?? '').slice(0, 10)) continue
      if (!min || row.date < min) min = row.date
    }
    return min
  }

  /**
   * 获取每个群首次被记录解析的日期（群增长曲线的数据源）
   */
  async getGroupFirstSeen(): Promise<Array<{ groupId: string; firstSeen: string }>> {
    const rows: ParseStatisticsRow[] = await this.db.get(TABLE.statsParse, {})
    const map = new Map<string, string>()
    for (const row of rows) {
      if (!row.createdAt) continue
      const current = map.get(row.groupId)
      if (!current || row.createdAt < current) map.set(row.groupId, row.createdAt)
    }
    return [...map.entries()].map(([groupId, firstSeen]) => ({ groupId, firstSeen }))
  }

  /**
   * 获取总群组数
   */
  async getTotalGroups(): Promise<number> {
    const rows: ParseStatisticsRow[] = await this.db.get(TABLE.statsParse, {})
    return new Set(rows.map((row) => row.groupId)).size
  }

  /**
   * 获取总解析次数
   */
  async getTotalParses(): Promise<number> {
    const [row] = await this.db.get(TABLE.statsGlobal, { key: 'totalParses' })
    return Number(row?.value ?? 0) || 0
  }

  /**
   * 增加总群组数
   */
  private async incrementTotalGroups(): Promise<void> {
    const totalGroups = await this.getTotalGroups()
    await this.db.set(TABLE.statsGlobal, { key: 'totalGroups' }, {
      value: totalGroups,
      updatedAt: now()
    })
  }

  /**
   * 增加总解析次数
   */
  private async incrementTotalParses(): Promise<void> {
    await this.db.set(TABLE.statsGlobal, { key: 'totalParses' }, (row: any) => ({
      value: $.add($.ifNull(row.value, 0), 1),
      updatedAt: now()
    }))
  }

  /**
   * 获取全局统计摘要
   */
  async getGlobalSummary(): Promise<{
    totalGroups: number
    totalParses: number
    platformStats: {
      douyin: number
      bilibili: number
      kuaishou: number
      xiaohongshu: number
    }
  }> {
    const totalGroups = await this.getTotalGroups()
    const totalParses = await this.getTotalParses()

    const platformStats = {
      douyin: await this.getPlatformTotalParses('douyin'),
      bilibili: await this.getPlatformTotalParses('bilibili'),
      kuaishou: await this.getPlatformTotalParses('kuaishou'),
      xiaohongshu: await this.getPlatformTotalParses('xiaohongshu')
    }

    return {
      totalGroups,
      totalParses,
      platformStats
    }
  }
}

/** 把指标分桶行按 `metric + bucket` 聚合求和 */
function aggregateMetrics (rows: ParseMetricStatsRow[]): ParseMetricBucketRow[] {
  const map = new Map<string, ParseMetricBucketRow>()
  for (const row of rows) {
    const key = row.metric + ' ' + row.bucket
    const current = map.get(key)
    if (current) current.count += Number(row.parseCount) || 0
    else map.set(key, { metric: row.metric as ParseMetric, bucket: row.bucket, count: Number(row.parseCount) || 0 })
  }
  return [...map.values()]
}
