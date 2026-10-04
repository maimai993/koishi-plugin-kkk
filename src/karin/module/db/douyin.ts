import { Context } from 'koishi'
import { logger } from 'node-karin'

import { Config } from '@/module/utils/Config'
import { DouyinWorkPushItem } from '@/platform/douyin/push'
import { douyinPushItem } from '@/types/config/pushlist'

import {
  TABLE,
  type AwemeCacheRow,
  type DouyinFilterTagRow,
  type DouyinFilterWordRow,
  type DouyinSubscriptionRow,
  type DouyinUserRow,
  type GroupRow
} from './model'

/**
 * 机器人接口 - 存储机器人信息
 */
interface Bot {
  /** 机器人ID */
  id: string
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
}

/**
 * 群组接口 - 存储群组信息
 */
interface Group {
  /** 群组ID */
  id: string
  /** 所属机器人ID */
  botId: string
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
}

/**
 * 抖音用户接口 - 存储抖音用户信息
 */
interface DouyinUser {
  /** 抖音用户sec_uid */
  sec_uid: string
  /** 抖音号 */
  short_id?: string
  /** 抖音用户昵称 */
  remark?: string
  /** 是否正在直播 */
  living: boolean
  /** 过滤模式：黑名单或白名单 */
  filterMode: 'blacklist' | 'whitelist'
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
}

/**
 * 群组用户订阅关系接口 - 存储群组订阅的抖音用户关系
 */
interface GroupUserSubscription {
  /** 群组ID */
  groupId: string
  /** 抖音用户sec_uid */
  sec_uid: string
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
}

/**
 * 作品缓存接口 - 存储已推送的作品ID
 */
interface AwemeCache {
  /** 缓存ID */
  id: number
  /** 作品ID */
  aweme_id: string
  /** 抖音用户sec_uid */
  sec_uid: string
  /** 群组ID */
  groupId: string
  /** 推送类型：post(作品列表)、favorite(喜欢列表)、recommend(推荐列表)、live(直播) */
  pushType: string
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
}

/**
 * 过滤词接口 - 存储过滤词
 */
interface FilterWord {
  /** 过滤词ID */
  id: number
  /** 抖音用户sec_uid */
  sec_uid: string
  /** 过滤词 */
  word: string
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
}

/**
 * 过滤标签接口 - 存储过滤标签
 */
interface FilterTag {
  /** 过滤标签ID */
  id: number
  /** 抖音用户sec_uid */
  sec_uid: string
  /** 过滤标签 */
  tag: string
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
}

/** 当前时间戳（ISO 字符串，与旧版 sqlite 里的口径一致） */
const now = () => new Date().toISOString()

/** 数据库操作类（基于 Koishi 原生数据库服务） */
export class DouyinDBBase {
  private ctx: Context

  constructor(ctx: Context) {
    this.ctx = ctx
  }

  private get db() {
    return this.ctx.database
  }

  /**
   * 初始化数据库
   */
  async init(): Promise<DouyinDBBase> {
    try {
      logger.debug(logger.green('--------------------------[DouyinDB] 开始初始化数据库--------------------------'))
      logger.debug('[DouyinDB] 使用 Koishi 原生数据库服务，表已由 ctx.model.extend 注册')
      logger.debug('[DouyinDB] 数据库模型同步成功')

      logger.debug('[DouyinDB] 正在同步配置订阅...')
      logger.debug('[DouyinDB] 配置项数量:', Config.pushlist.douyin?.length || 0)
      await this.syncConfigSubscriptions(Config.pushlist.douyin)
      logger.debug('[DouyinDB] 配置订阅同步成功')
      logger.debug(logger.green('--------------------------[DouyinDB] 初始化数据库完成--------------------------'))
    } catch (error) {
      logger.error('[DouyinDB] 数据库初始化失败:', error)
      throw error
    }

    return this
  }

  /**
   * 获取或创建机器人记录
   * @param botId 机器人ID
   */
  async getOrCreateBot(botId: string): Promise<Bot> {
    const [bot] = await this.db.get(TABLE.douyinBot, { id: botId })
    if (bot) return bot

    const time = now()
    return await this.db.create(TABLE.douyinBot, { id: botId, createdAt: time, updatedAt: time })
  }

  /**
   * 获取或创建群组记录
   * @param groupId 群组ID
   * @param botId 机器人ID
   */
  async getOrCreateGroup(groupId: string, botId: string): Promise<Group> {
    await this.getOrCreateBot(botId)

    const [group] = await this.db.get(TABLE.douyinGroup, { id: groupId, botId })
    if (group) return group

    const time = now()
    return await this.db.create(TABLE.douyinGroup, {
      id: groupId,
      botId,
      createdAt: time,
      updatedAt: time
    })
  }

  /**
   * 获取或创建抖音用户记录
   * @param sec_uid 抖音用户sec_uid
   * @param short_id 抖音号
   * @param remark 用户昵称
   */
  async getOrCreateDouyinUser(sec_uid: string, short_id: string = '', remark: string = ''): Promise<DouyinUser> {
    const [user] = await this.db.get(TABLE.douyinUser, { sec_uid })

    if (!user) {
      const time = now()
      const created = await this.db.create(TABLE.douyinUser, {
        sec_uid,
        short_id,
        remark,
        living: false,
        filterMode: 'blacklist',
        createdAt: time,
        updatedAt: time
      })
      return created as DouyinUser
    }

    // 如果提供了新的信息，更新用户记录
    const patch: Record<string, any> = {}
    if (remark && user.remark !== remark) patch.remark = remark
    if (short_id && user.short_id !== short_id) patch.short_id = short_id

    if (Object.keys(patch).length === 0) return user as DouyinUser

    const time = now()
    patch.updatedAt = time
    await this.db.set(TABLE.douyinUser, { sec_uid }, patch)
    return { ...user, ...patch } as DouyinUser
  }

  /**
   * 订阅抖音用户
   * @param groupId 群组ID
   * @param botId 机器人ID
   * @param sec_uid 抖音用户sec_uid
   * @param short_id 抖音号
   * @param remark 用户昵称
   */
  async subscribeDouyinUser(
    groupId: string,
    botId: string,
    sec_uid: string,
    short_id: string = '',
    remark: string = ''
  ): Promise<GroupUserSubscription> {
    await this.getOrCreateGroup(groupId, botId)
    await this.getOrCreateDouyinUser(sec_uid, short_id, remark)

    const [subscription] = await this.db.get(TABLE.douyinSubscription, { groupId, sec_uid })
    if (subscription) return subscription

    const time = now()
    return await this.db.create(TABLE.douyinSubscription, {
      groupId,
      sec_uid,
      createdAt: time,
      updatedAt: time
    })
  }

  /**
   * 取消订阅抖音用户
   * @param groupId 群组ID
   * @param sec_uid 抖音用户sec_uid
   */
  async unsubscribeDouyinUser(groupId: string, sec_uid: string): Promise<boolean> {
    const result = await this.db.remove(TABLE.douyinSubscription, { groupId, sec_uid })

    // 清除相关的作品缓存
    await this.db.remove(TABLE.douyinAwemeCache, { groupId, sec_uid })

    // 检查该用户是否还有其他群组订阅
    const remaining = await this.db.get(TABLE.douyinSubscription, { sec_uid }, { limit: 1 })

    // 如果没有任何群组订阅该用户，删除用户记录及相关数据
    if (remaining.length === 0) {
      logger.info(`[DouyinDB] 用户 ${sec_uid} 已无任何群组订阅，清理相关数据`)

      await this.db.remove(TABLE.douyinUser, { sec_uid })
      await this.db.remove(TABLE.douyinFilterWord, { sec_uid })
      await this.db.remove(TABLE.douyinFilterTag, { sec_uid })
      // 删除所有相关的作品缓存（所有群组的）
      await this.db.remove(TABLE.douyinAwemeCache, { sec_uid })
    }

    return (result.removed ?? 0) > 0
  }

  /**
   * 添加作品缓存
   * @param aweme_id 作品ID
   * @param sec_uid 抖音用户sec_uid
   * @param groupId 群组ID
   * @param pushType 推送类型：post(作品列表)、favorite(喜欢列表)、recommend(推荐列表)、live(直播)
   */
  async addAwemeCache(aweme_id: string, sec_uid: string, groupId: string, pushType: string = 'post'): Promise<AwemeCache> {
    const [cache] = await this.db.get(TABLE.douyinAwemeCache, { aweme_id, sec_uid, groupId, pushType })
    if (cache) return cache

    const time = now()
    return await this.db.create(TABLE.douyinAwemeCache, {
      aweme_id,
      sec_uid,
      groupId,
      pushType,
      createdAt: time,
      updatedAt: time
    })
  }

  /**
   * 检查作品是否已推送
   * @param aweme_id 作品ID
   * @param sec_uid 抖音用户sec_uid
   * @param groupId 群组ID
   * @param pushType 推送类型：post(作品列表)、favorite(喜欢列表)、recommend(推荐列表)、live(直播)
   */
  async isAwemePushed(aweme_id: string, sec_uid: string, groupId: string, pushType: string = 'post'): Promise<boolean> {
    const rows = await this.db.get(TABLE.douyinAwemeCache, { aweme_id, sec_uid, groupId, pushType }, { limit: 1 })
    return rows.length > 0
  }

  /**
   * 检查群组是否有推送历史（用于判断是否为新订阅）
   * @param sec_uid 抖音用户sec_uid
   * @param groupId 群组ID
   * @param pushType 推送类型
   */
  async hasHistory(sec_uid: string, groupId: string, pushType: string): Promise<boolean> {
    const rows = await this.db.get(TABLE.douyinAwemeCache, { sec_uid, groupId, pushType }, { limit: 1 })
    return rows.length > 0
  }

  /**
   * 获取机器人管理的所有群组
   * @param botId 机器人ID
   */
  async getBotGroups(botId: string): Promise<Group[]> {
    return await this.db.get(TABLE.douyinGroup, { botId })
  }

  /**
   * 更新群组的机器人ID
   * @param groupId 群组ID
   * @param oldBotId 旧的机器人ID
   * @param newBotId 新的机器人ID
   */
  async updateGroupBotId(groupId: string, oldBotId: string, newBotId: string): Promise<void> {
    await this.getOrCreateBot(newBotId)
    await this.db.set(TABLE.douyinGroup, { id: groupId, botId: oldBotId }, {
      botId: newBotId,
      updatedAt: now()
    })
  }

  /**
   * 获取群组订阅的所有抖音用户
   * @param groupId 群组ID
   */
  async getGroupSubscriptions(groupId: string): Promise<(GroupUserSubscription & { douyinUser: DouyinUser })[]> {
    const subscriptions: DouyinSubscriptionRow[] = await this.db.get(TABLE.douyinSubscription, { groupId })
    if (!subscriptions.length) return []

    const secUids = [...new Set(subscriptions.map((item) => item.sec_uid))]
    const users: DouyinUserRow[] = await this.db.get(TABLE.douyinUser, { sec_uid: { $in: secUids } })
    const userMap = new Map(users.map((user) => [user.sec_uid, user]))

    return subscriptions.map((sub) => {
      const user = userMap.get(sub.sec_uid)
      return {
        groupId: sub.groupId,
        sec_uid: sub.sec_uid,
        createdAt: sub.createdAt,
        updatedAt: sub.updatedAt,
        douyinUser: {
          sec_uid: sub.sec_uid,
          short_id: user?.short_id ?? '',
          remark: user?.remark ?? '',
          living: !!user?.living,
          filterMode: (user?.filterMode ?? 'blacklist') as 'blacklist' | 'whitelist',
          createdAt: user?.createdAt ?? sub.createdAt,
          updatedAt: user?.updatedAt ?? sub.updatedAt
        }
      }
    })
  }

  /**
   * 获取抖音用户的所有订阅群组
   * @param sec_uid 抖音用户sec_uid
   */
  async getUserSubscribedGroups(sec_uid: string): Promise<Group[]> {
    const subscriptions: DouyinSubscriptionRow[] = await this.db.get(TABLE.douyinSubscription, { sec_uid })
    if (!subscriptions.length) return []

    const groupIds = [...new Set(subscriptions.map((item) => item.groupId))]
    return (await this.db.get(TABLE.douyinGroup, { id: { $in: groupIds } })) as GroupRow[]
  }

  /**
   * 检查群组是否已订阅抖音用户
   * @param sec_uid 抖音用户sec_uid
   * @param groupId 群组ID
   */
  async isSubscribed(sec_uid: string, groupId: string): Promise<boolean> {
    const rows = await this.db.get(TABLE.douyinSubscription, { sec_uid, groupId }, { limit: 1 })
    return rows.length > 0
  }

  /**
   * 获取抖音用户信息
   * @param sec_uid 抖音用户sec_uid
   * @returns 返回用户信息，如果不存在则返回null
   */
  async getDouyinUser(sec_uid: string): Promise<DouyinUser | null> {
    const [user] = await this.db.get(TABLE.douyinUser, { sec_uid })
    if (!user) return null
    return { ...user, living: !!user.living } as DouyinUser
  }

  /**
   * 更新用户直播状态
   * @param sec_uid 抖音用户sec_uid
   * @param living 是否正在直播
   */
  async updateLiveStatus(sec_uid: string, living: boolean): Promise<boolean> {
    const user = await this.getDouyinUser(sec_uid)
    if (!user) return false

    const result = await this.db.set(TABLE.douyinUser, { sec_uid }, { living, updatedAt: now() })
    return (result.matched ?? 0) > 0
  }

  /**
   * 获取用户直播状态
   * @param sec_uid 抖音用户sec_uid
   */
  async getLiveStatus(sec_uid: string): Promise<{ living: boolean }> {
    const user = await this.getDouyinUser(sec_uid)
    return { living: user?.living || false }
  }

  /**
   * 批量同步配置文件中的订阅到数据库
   * @param configItems 配置文件中的订阅项
   */
  async syncConfigSubscriptions(configItems: douyinPushItem[]): Promise<void> {
    const items = configItems ?? []

    // 1. 收集配置文件中的所有订阅关系
    const configSubscriptions: Map<string, Set<string>> = new Map()

    for (const item of items) {
      const sec_uid = item.sec_uid
      const short_id = item.short_id ?? ''
      const remark = item.remark ?? ''

      // 创建或更新抖音用户记录
      await this.getOrCreateDouyinUser(sec_uid, short_id, remark)

      for (const groupWithBot of item.group_id) {
        const [groupId, botId] = groupWithBot.split(':')
        if (!groupId || !botId) continue

        // 确保群组存在
        await this.getOrCreateGroup(groupId, botId)

        if (!configSubscriptions.has(groupId)) configSubscriptions.set(groupId, new Set())
        configSubscriptions.get(groupId)?.add(sec_uid)

        if (!await this.isSubscribed(sec_uid, groupId)) {
          await this.subscribeDouyinUser(groupId, botId, sec_uid, short_id, remark)
        }
      }
    }

    // 2. 删除数据库里存在、但配置文件里没有的订阅
    const allGroups: GroupRow[] = await this.db.get(TABLE.douyinGroup, {})

    for (const group of allGroups) {
      const groupId = group.id
      const configUsers = configSubscriptions.get(groupId) ?? new Set<string>()
      const dbSubscriptions: DouyinSubscriptionRow[] = await this.db.get(TABLE.douyinSubscription, { groupId })

      for (const subscription of dbSubscriptions) {
        if (configUsers.has(subscription.sec_uid)) continue
        await this.unsubscribeDouyinUser(groupId, subscription.sec_uid)
        logger.mark(`已删除群组 ${groupId} 对抖音用户 ${subscription.sec_uid} 的订阅`)
      }
    }

    // 3. 清理不再被任何群组订阅的抖音用户记录及其过滤词和过滤标签
    const allUsers: DouyinUserRow[] = await this.db.get(TABLE.douyinUser, {})

    for (const user of allUsers) {
      const subscribedGroups = await this.getUserSubscribedGroups(user.sec_uid)
      if (subscribedGroups.length > 0) continue

      await this.db.remove(TABLE.douyinFilterWord, { sec_uid: user.sec_uid })
      await this.db.remove(TABLE.douyinFilterTag, { sec_uid: user.sec_uid })
      await this.db.remove(TABLE.douyinUser, { sec_uid: user.sec_uid })

      logger.mark(`已删除抖音用户 ${user.sec_uid} 的记录及相关过滤设置（不再被任何群组订阅）`)
    }
  }

  /**
   * 通过ID获取群组信息
   * @param groupId 群组ID
   */
  async getGroupById(groupId: string): Promise<Group | null> {
    const [group] = await this.db.get(TABLE.douyinGroup, { id: groupId })
    return group ?? null
  }

  /**
   * 更新用户的过滤模式
   * @param sec_uid 抖音用户sec_uid
   * @param filterMode 过滤模式
   */
  async updateFilterMode(sec_uid: string, filterMode: 'blacklist' | 'whitelist'): Promise<DouyinUser> {
    const user = await this.getOrCreateDouyinUser(sec_uid)
    const time = now()

    await this.db.set(TABLE.douyinUser, { sec_uid }, { filterMode, updatedAt: time })

    return { ...user, filterMode, updatedAt: time }
  }

  /**
   * 添加过滤词
   * @param sec_uid 抖音用户sec_uid
   * @param word 过滤词
   */
  async addFilterWord(sec_uid: string, word: string): Promise<FilterWord> {
    await this.getOrCreateDouyinUser(sec_uid)

    const [existing] = await this.db.get(TABLE.douyinFilterWord, { sec_uid, word })
    if (existing) return existing

    const time = now()
    return await this.db.create(TABLE.douyinFilterWord, { sec_uid, word, createdAt: time, updatedAt: time })
  }

  /**
   * 删除过滤词
   * @param sec_uid 抖音用户sec_uid
   * @param word 过滤词
   */
  async removeFilterWord(sec_uid: string, word: string): Promise<boolean> {
    const result = await this.db.remove(TABLE.douyinFilterWord, { sec_uid, word })
    return (result.removed ?? 0) > 0
  }

  /**
   * 添加过滤标签
   * @param sec_uid 抖音用户sec_uid
   * @param tag 过滤标签
   */
  async addFilterTag(sec_uid: string, tag: string): Promise<FilterTag> {
    await this.getOrCreateDouyinUser(sec_uid)

    const [existing] = await this.db.get(TABLE.douyinFilterTag, { sec_uid, tag })
    if (existing) return existing

    const time = now()
    return await this.db.create(TABLE.douyinFilterTag, { sec_uid, tag, createdAt: time, updatedAt: time })
  }

  /**
   * 删除过滤标签
   * @param sec_uid 抖音用户sec_uid
   * @param tag 过滤标签
   */
  async removeFilterTag(sec_uid: string, tag: string): Promise<boolean> {
    const result = await this.db.remove(TABLE.douyinFilterTag, { sec_uid, tag })
    return (result.removed ?? 0) > 0
  }

  /**
   * 获取用户的所有过滤词
   * @param sec_uid 抖音用户sec_uid
   */
  async getFilterWords(sec_uid: string): Promise<string[]> {
    const rows: DouyinFilterWordRow[] = await this.db.get(TABLE.douyinFilterWord, { sec_uid })
    return rows.map((row) => row.word)
  }

  /**
   * 获取用户的所有过滤标签
   * @param sec_uid 抖音用户sec_uid
   */
  async getFilterTags(sec_uid: string): Promise<string[]> {
    const rows: DouyinFilterTagRow[] = await this.db.get(TABLE.douyinFilterTag, { sec_uid })
    return rows.map((row) => row.tag)
  }

  /**
   * 获取用户的过滤配置
   * @param sec_uid 抖音用户sec_uid
   */
  async getFilterConfig(sec_uid: string): Promise<{ filterMode: 'blacklist' | 'whitelist'; filterWords: string[]; filterTags: string[] }> {
    const user = await this.getOrCreateDouyinUser(sec_uid)
    const filterWords = await this.getFilterWords(sec_uid)
    const filterTags = await this.getFilterTags(sec_uid)

    return {
      filterMode: user.filterMode,
      filterWords,
      filterTags
    }
  }

  /**
   * 检查内容是否应该被过滤
   * @param PushItem 推送项
   * @param tags 标签列表
   */
  async shouldFilter(PushItem: DouyinWorkPushItem, tags: string[] = []): Promise<boolean> {
    // 使用 PushItem.sec_uid 而不是 PushItem.Detail_Data.sec_uid
    const sec_uid = PushItem.sec_uid
    if (!sec_uid) {
      logger.warn(`推送项缺少 sec_uid 参数: ${JSON.stringify(PushItem)}`)
      return false // 如果没有 sec_uid，默认不过滤
    }

    const { filterMode, filterWords, filterTags } = await this.getFilterConfig(sec_uid)
    logger.debug(`
      获取用户${PushItem.remark}（${PushItem.sec_uid}）的过滤配置：
      过滤模式：${filterMode}
      过滤词：${filterWords}
      过滤标签：${filterTags}
      `)
    const desc = PushItem.Detail_Data.desc ?? ''

    // 检查内容中是否包含过滤词
    const hasFilterWord = filterWords.some((word) => desc.includes(word))

    // 检查标签中是否包含过滤标签
    const hasFilterTag = filterTags.some((filterTag) => tags.some((tag) => tag === filterTag))

    logger.debug(`
      作者：${PushItem.remark}
      检查内容：${desc}
      命中词：[${filterWords.join('], [')}]
      命中标签：[${filterTags.join('], [')}]
      过滤模式：${filterMode}
      是否过滤：${hasFilterWord || hasFilterTag ? logger.red(`${hasFilterWord || hasFilterTag}`) : logger.green(`${hasFilterWord || hasFilterTag}`)}
      作品地址：${logger.green(`https://www.douyin.com/video/${PushItem.Detail_Data.aweme_id}`)}
      `)

    // 根据过滤模式决定是否过滤
    if (filterMode === 'blacklist') {
      // 黑名单模式：如果包含过滤词或过滤标签，则过滤
      if (hasFilterWord || hasFilterTag) {
        logger.warn(`
          作品内容命中黑名单规则，已过滤该作品不再推送
          作品地址：${logger.yellow(PushItem.Detail_Data.share_url)}
          命中的黑名单词：[${filterWords.join('], [')}]
          命中的黑名单标签：[${filterTags.join('], [')}]
          `)
        return true
      }
      return false
    } else {
      // 白名单模式：如果不包含任何白名单词或白名单标签，则过滤
      // 注意：如果白名单为空，则不过滤任何内容
      if (filterWords.length === 0 && filterTags.length === 0) {
        return false
      }

      if (hasFilterWord || hasFilterTag) {
        return false // 不过滤
      }
      logger.warn(`
        作品内容未命中白名单规则，已过滤该作品不再推送
        作品地址：${logger.yellow(PushItem.Detail_Data.share_url)}
        命中的黑名单词：[${filterWords.join('], [')}]
        命中的黑名单标签：[${filterTags.join('], [')}]
        `)
      return true
    }
  }

  /**
   * 清理过期的作品缓存记录
   *
   * 判据用 `updatedAt`（最后一次仍出现在列表中的时间）而非 `createdAt`：喜欢/推荐列表会长期返回
   * 同一批作品，只要作品还在列表里，每轮推送都会通过 {@link touchAwemeCache} 续期，其去重记录就不会
   * 被清理，从而避免过往作品被反复重推；一旦作品掉出列表、不再续期，超过保留期后即回收，保证缓存表
   * 规模有界。作品列表(post)/直播(live)从不续期，行为与旧逻辑一致（且 post 另有 24h 闸门兜底）。
   * @param days 保留最近几天内仍出现过的记录
   * @returns 删除的记录数量
   */
  async cleanOldAwemeCache(days: number = 7): Promise<number> {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - days)

    const result = await this.db.remove(TABLE.douyinAwemeCache, {
      updatedAt: { $lt: cutoffDate.toISOString() }
    })
    return result.removed ?? 0
  }

  /**
   * 为「仍在列表中」的作品续期去重记录（滑动 TTL）
   *
   * 喜欢/推荐列表每轮都用当前返回的全部 aweme_id 调用此方法，把这些记录的 `updatedAt` 刷新到当前
   * 时间。配合 {@link cleanOldAwemeCache} 按 `updatedAt` 清理：仍在列表里的作品永不过期（不会重推），
   * 掉出列表的作品因不再续期而在保留期后被回收（缓存表规模有界）。
   * @param sec_uid 抖音用户sec_uid
   * @param pushType 推送类型
   * @param aweme_ids 当前列表中的全部作品ID
   */
  async touchAwemeCache(sec_uid: string, pushType: string, aweme_ids: string[]): Promise<void> {
    const ids = [...new Set(aweme_ids)]
    if (ids.length === 0) return

    await this.db.set(TABLE.douyinAwemeCache, {
      sec_uid,
      pushType,
      aweme_id: { $in: ids }
    }, {
      updatedAt: now()
    })
  }

  /** 为了向后兼容，保留groupRepository和awemeCacheRepository属性 */
  get groupRepository() {
    return {
      find: async (options?: {
        where?: {
          botId?: string
          id?: string
        }
      }) => {
        if (options?.where?.botId) {
          return await this.getBotGroups(options.where.botId)
        }
        return (await this.db.get(TABLE.douyinGroup, {})) as GroupRow[]
      }
    }
  }

  get awemeCacheRepository() {
    return {
      find: async <T = AwemeCache & { createdAt: Date; updatedAt: Date }>(
        options: {
          where?: {
            groupId?: string
            sec_uid?: string
            aweme_id?: string
          }
          order?: Record<string, 'ASC' | 'DESC'>
          take?: number
          relations?: string[]
        } = {}
      ): Promise<T[]> => {
        const { where = {}, order, take, relations } = options

        // 构建WHERE条件
        const query: Record<string, any> = {}
        if (where.groupId) query.groupId = where.groupId
        if (where.sec_uid) query.sec_uid = where.sec_uid
        if (where.aweme_id) query.aweme_id = where.aweme_id

        // 构建排序（minato 只认 asc / desc）
        const sort: Record<string, 'asc' | 'desc'> = {}
        const allowedFields = ['id', 'aweme_id', 'sec_uid', 'groupId', 'createdAt', 'updatedAt']
        for (const [field, direction] of Object.entries(order ?? {})) {
          if (!allowedFields.includes(field)) continue
          sort[field] = String(direction).toLowerCase() === 'asc' ? 'asc' : 'desc'
        }

        const cursor: Record<string, any> = {}
        if (Object.keys(sort).length) cursor.sort = sort
        if (take) cursor.limit = take

        const caches: AwemeCacheRow[] = await this.db.get(TABLE.douyinAwemeCache, query, cursor)

        // 如果需要关联douyinUser数据
        if (relations && relations.includes('douyinUser')) {
          const result = []
          for (const cache of caches) {
            const douyinUser = await this.getDouyinUser(cache.sec_uid)
            result.push({
              ...cache,
              douyinUser,
              createdAt: new Date(cache.createdAt), // 转换为Date对象
              updatedAt: new Date(cache.updatedAt)
            })
          }
          return result as T[]
        }

        // 转换日期字符串为Date对象
        return caches.map((cache) => ({
          ...cache,
          createdAt: new Date(cache.createdAt),
          updatedAt: new Date(cache.updatedAt)
        })) as T[]
      },
      delete: async (conditions: { groupId?: string; sec_uid?: string; aweme_id?: string }) => {
        const { groupId, sec_uid, aweme_id } = conditions

        // 优先处理 aweme_id + groupId 的精确删除（单条记录）
        if (aweme_id && groupId) {
          const result = await this.db.remove(TABLE.douyinAwemeCache, { aweme_id, groupId })
          return { affected: result.removed ?? 0 }
        }
        if (groupId && sec_uid) {
          const result = await this.db.remove(TABLE.douyinAwemeCache, { groupId, sec_uid })
          return { affected: result.removed ?? 0 }
        }
        if (groupId) {
          const result = await this.db.remove(TABLE.douyinAwemeCache, { groupId })
          return { affected: result.removed ?? 0 }
        }
        if (sec_uid) {
          const result = await this.db.remove(TABLE.douyinAwemeCache, { sec_uid })
          return { affected: result.removed ?? 0 }
        }
        if (aweme_id) {
          const result = await this.db.remove(TABLE.douyinAwemeCache, { aweme_id })
          return { affected: result.removed ?? 0 }
        }
        return { affected: 0 }
      }
    }
  }

  /**
   * 检查作品是否在列表快照中（用于喜欢列表和推荐列表）
   * @param aweme_id 作品ID
   * @param sec_uid 用户sec_uid
   * @param pushType 推送类型
   */
  async isAwemeInList(aweme_id: string, sec_uid: string, pushType: string): Promise<boolean> {
    const rows = await this.db.get(TABLE.douyinListSnapshot, { aweme_id, sec_uid, pushType }, { limit: 1 })
    return rows.length > 0
  }

  /**
   * 更新列表快照（用于喜欢列表和推荐列表）
   * @param sec_uid 用户sec_uid
   * @param pushType 推送类型
   * @param aweme_ids 作品ID列表
   */
  async updateListSnapshot(sec_uid: string, pushType: string, aweme_ids: string[]): Promise<void> {
    const time = now()

    // 先删除该用户该类型的所有旧快照
    await this.db.remove(TABLE.douyinListSnapshot, { sec_uid, pushType })

    // 插入新快照（去重）
    const existing = await this.db.get(TABLE.douyinListSnapshot, {
      sec_uid,
      pushType,
      aweme_id: { $in: [...new Set(aweme_ids)] }
    })
    const known = new Set(existing.map((row) => row.aweme_id))

    for (const aweme_id of new Set(aweme_ids)) {
      if (known.has(aweme_id)) continue
      await this.db.create(TABLE.douyinListSnapshot, {
        sec_uid,
        pushType,
        aweme_id,
        createdAt: time,
        updatedAt: time
      })
    }
  }
}
