import { DynamicType } from '@ikenxuan/amagi'
import { Context } from 'koishi'
import { logger } from 'node-karin'

import { Config } from '@/module/utils/Config'
import { BilibiliPushItem } from '@/platform/bilibili/push'
import { bilibiliPushItem } from '@/types/config/pushlist'

import {
  TABLE,
  type BilibiliFilterTagRow,
  type BilibiliFilterWordRow,
  type BilibiliSubscriptionRow,
  type BilibiliUserRow,
  type DynamicCacheRow,
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
 * B站用户接口 - 存储B站用户信息
 */
interface BilibiliUser {
  /** B站用户UID */
  host_mid: number
  /** B站用户昵称 */
  remark?: string
  /** 过滤模式：黑名单或白名单 */
  filterMode: 'blacklist' | 'whitelist'
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
}

/**
 * 群组用户订阅关系接口 - 存储群组订阅的B站用户关系
 */
interface GroupUserSubscription {
  /** 群组ID */
  groupId: string
  /** B站用户UID */
  host_mid: number
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
}

/**
 * 动态缓存接口 - 存储已推送的动态ID
 */
interface DynamicCache {
  /** 缓存ID */
  id: number
  /** 动态ID */
  dynamic_id: string
  /** B站用户UID */
  host_mid: number
  /** 群组ID */
  groupId: string
  /** 动态类型 */
  dynamic_type?: string
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
  /** B站用户UID */
  host_mid: number
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
  /** B站用户UID */
  host_mid: number
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
export class BilibiliDBBase {
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
  async init(): Promise<BilibiliDBBase> {
    try {
      logger.debug(logger.green('--------------------------[BilibiliDB] 开始初始化数据库--------------------------'))
      logger.debug('[BilibiliDB] 使用 Koishi 原生数据库服务，表已由 ctx.model.extend 注册')

      logger.debug('[BilibiliDB] 正在同步配置订阅...')
      logger.debug('[BilibiliDB] 配置项数量:', Config.pushlist.bilibili?.length || 0)
      await this.syncConfigSubscriptions(Config.pushlist.bilibili)
      logger.debug('[BilibiliDB] 配置订阅同步成功')
      logger.debug(logger.green('--------------------------[BilibiliDB] 初始化数据库完成--------------------------'))
    } catch (error) {
      logger.error('[BilibiliDB] 数据库初始化失败:', error)
      throw error
    }

    return this
  }

  /**
   * 获取或创建机器人记录
   * @param botId 机器人ID
   */
  async getOrCreateBot(botId: string): Promise<Bot> {
    const [bot] = await this.db.get(TABLE.bilibiliBot, { id: botId })
    if (bot) return bot

    const time = now()
    return await this.db.create(TABLE.bilibiliBot, { id: botId, createdAt: time, updatedAt: time })
  }

  /**
   * 获取或创建群组记录
   * @param groupId 群组ID
   * @param botId 机器人ID
   */
  async getOrCreateGroup(groupId: string, botId: string): Promise<Group> {
    await this.getOrCreateBot(botId)

    const [group] = await this.db.get(TABLE.bilibiliGroup, { id: groupId, botId })
    if (group) return group

    const time = now()
    return await this.db.create(TABLE.bilibiliGroup, {
      id: groupId,
      botId,
      createdAt: time,
      updatedAt: time
    })
  }

  /**
   * 获取B站用户记录
   * @param host_mid B站用户UID
   * @returns 返回用户信息，如果不存在则返回null
   */
  async getBilibiliUser(host_mid: number): Promise<BilibiliUser | null> {
    const [user] = await this.db.get(TABLE.bilibiliUser, { host_mid })
    return (user as BilibiliUser | undefined) ?? null
  }

  /**
   * 获取或创建B站用户记录
   * @param host_mid B站用户UID
   * @param remark UP主昵称
   */
  async getOrCreateBilibiliUser(host_mid: number, remark: string = ''): Promise<BilibiliUser> {
    const [row] = await this.db.get(TABLE.bilibiliUser, { host_mid })

    if (!row) {
      const time = now()
      const created = await this.db.create(TABLE.bilibiliUser, {
        host_mid,
        remark,
        filterMode: 'blacklist',
        createdAt: time,
        updatedAt: time
      })
      return created as BilibiliUser
    }

    // 如果提供了新的remark，更新用户记录
    if (remark && row.remark !== remark) {
      const time = now()
      await this.db.set(TABLE.bilibiliUser, { host_mid }, { remark, updatedAt: time })
      return { ...row, remark, updatedAt: time } as BilibiliUser
    }

    return row as BilibiliUser
  }

  /**
   * 订阅B站用户
   * @param groupId 群组ID
   * @param botId 机器人ID
   * @param host_mid B站用户UID
   * @param remark UP主昵称
   */
  async subscribeBilibiliUser(groupId: string, botId: string, host_mid: number, remark: string = ''): Promise<GroupUserSubscription> {
    await this.getOrCreateGroup(groupId, botId)
    await this.getOrCreateBilibiliUser(host_mid, remark)

    const [subscription] = await this.db.get(TABLE.bilibiliSubscription, { groupId, host_mid })
    if (subscription) return subscription

    const time = now()
    return await this.db.create(TABLE.bilibiliSubscription, {
      groupId,
      host_mid,
      createdAt: time,
      updatedAt: time
    })
  }

  /**
   * 取消订阅B站用户
   * @param groupId 群组ID
   * @param host_mid B站用户UID
   */
  async unsubscribeBilibiliUser(groupId: string, host_mid: number): Promise<boolean> {
    const result = await this.db.remove(TABLE.bilibiliSubscription, { groupId, host_mid })

    // 清除相关的动态缓存
    await this.db.remove(TABLE.bilibiliDynamicCache, { groupId, host_mid })

    // 检查该用户是否还有其他群组订阅
    const remaining = await this.db.get(TABLE.bilibiliSubscription, { host_mid }, { limit: 1 })

    // 如果没有任何群组订阅该用户，删除用户记录及相关数据
    if (remaining.length === 0) {
      logger.info(`[BilibiliDB] 用户 ${host_mid} 已无任何群组订阅，清理相关数据`)

      await this.db.remove(TABLE.bilibiliUser, { host_mid })
      await this.db.remove(TABLE.bilibiliFilterWord, { host_mid })
      await this.db.remove(TABLE.bilibiliFilterTag, { host_mid })
      // 删除所有相关的动态缓存（所有群组的）
      await this.db.remove(TABLE.bilibiliDynamicCache, { host_mid })
    }

    return (result.removed ?? 0) > 0
  }

  /**
   * 添加动态缓存
   * @param dynamic_id 动态ID
   * @param host_mid B站用户UID
   * @param groupId 群组ID
   * @param dynamic_type 动态类型
   */
  async addDynamicCache(dynamic_id: string, host_mid: number, groupId: string, dynamic_type: string): Promise<DynamicCache> {
    const [cache] = await this.db.get(TABLE.bilibiliDynamicCache, { dynamic_id, host_mid, groupId })
    if (cache) return cache

    const time = now()
    return await this.db.create(TABLE.bilibiliDynamicCache, {
      dynamic_id,
      host_mid,
      groupId,
      dynamic_type,
      createdAt: time,
      updatedAt: time
    })
  }

  /**
   * 检查动态是否已推送
   * @param dynamic_id 动态ID
   * @param host_mid B站用户UID
   * @param groupId 群组ID
   */
  async isDynamicPushed(dynamic_id: string, host_mid: number, groupId: string): Promise<boolean> {
    const rows = await this.db.get(TABLE.bilibiliDynamicCache, { dynamic_id, host_mid, groupId }, { limit: 1 })
    return rows.length > 0
  }

  /**
   * 获取机器人管理的所有群组
   * @param botId 机器人ID
   */
  async getBotGroups(botId: string): Promise<Group[]> {
    return await this.db.get(TABLE.bilibiliGroup, { botId })
  }

  /**
   * 更新群组的机器人ID
   * @param groupId 群组ID
   * @param oldBotId 旧的机器人ID
   * @param newBotId 新的机器人ID
   */
  async updateGroupBotId(groupId: string, oldBotId: string, newBotId: string): Promise<void> {
    await this.getOrCreateBot(newBotId)
    await this.db.set(TABLE.bilibiliGroup, { id: groupId, botId: oldBotId }, {
      botId: newBotId,
      updatedAt: now()
    })
  }

  /**
   * 获取群组订阅的所有B站用户
   * @param groupId 群组ID
   */
  async getGroupSubscriptions(groupId: string): Promise<(GroupUserSubscription & { bilibiliUser: BilibiliUser })[]> {
    const subscriptions: BilibiliSubscriptionRow[] = await this.db.get(TABLE.bilibiliSubscription, { groupId })
    if (!subscriptions.length) return []

    const hosts = [...new Set(subscriptions.map((item) => item.host_mid))]
    const users: BilibiliUserRow[] = await this.db.get(TABLE.bilibiliUser, { host_mid: { $in: hosts } })
    const userMap = new Map(users.map((user) => [user.host_mid, user]))

    return subscriptions.map((sub) => {
      const user = userMap.get(sub.host_mid)
      return {
        groupId: sub.groupId,
        host_mid: sub.host_mid,
        createdAt: sub.createdAt,
        updatedAt: sub.updatedAt,
        bilibiliUser: {
          host_mid: sub.host_mid,
          remark: user?.remark ?? '',
          filterMode: (user?.filterMode ?? 'blacklist') as 'blacklist' | 'whitelist',
          createdAt: user?.createdAt ?? sub.createdAt,
          updatedAt: user?.updatedAt ?? sub.updatedAt
        }
      }
    })
  }

  /**
   * 获取B站用户的所有订阅群组
   * @param host_mid B站用户UID
   */
  async getUserSubscribedGroups(host_mid: number): Promise<Group[]> {
    const subscriptions: BilibiliSubscriptionRow[] = await this.db.get(TABLE.bilibiliSubscription, { host_mid })
    if (!subscriptions.length) return []

    const groupIds = [...new Set(subscriptions.map((item) => item.groupId))]
    return (await this.db.get(TABLE.bilibiliGroup, { id: { $in: groupIds } })) as GroupRow[]
  }

  /**
   * 获取群组的动态缓存
   * @param groupId 群组ID
   * @param host_mid 可选的B站用户UID过滤
   */
  async getGroupDynamicCache(groupId: string, host_mid?: number): Promise<DynamicCache[]> {
    return await this.db.get(TABLE.bilibiliDynamicCache, host_mid ? { groupId, host_mid } : { groupId }, {
      sort: { createdAt: 'desc' }
    })
  }

  /**
   * 检查群组是否已订阅B站用户
   * @param host_mid B站用户UID
   * @param groupId 群组ID
   */
  async isSubscribed(host_mid: number, groupId: string): Promise<boolean> {
    const rows = await this.db.get(TABLE.bilibiliSubscription, { host_mid, groupId }, { limit: 1 })
    return rows.length > 0
  }

  /**
   * 批量同步配置文件中的订阅到数据库
   * @param configItems 配置文件中的订阅项
   */
  async syncConfigSubscriptions(configItems: bilibiliPushItem[]): Promise<void> {
    const items = configItems ?? []

    // 1. 收集配置文件中的所有订阅关系
    const configSubscriptions: Map<string, Set<number>> = new Map()

    for (const item of items) {
      const host_mid = item.host_mid
      const remark = item.remark ?? ''

      // 创建或更新B站用户记录
      await this.getOrCreateBilibiliUser(host_mid, remark)

      for (const groupWithBot of item.group_id) {
        const [groupId, botId] = groupWithBot.split(':')
        if (!groupId || !botId) continue

        // 确保群组存在
        await this.getOrCreateGroup(groupId, botId)

        if (!configSubscriptions.has(groupId)) configSubscriptions.set(groupId, new Set())
        configSubscriptions.get(groupId)?.add(host_mid)

        if (!await this.isSubscribed(host_mid, groupId)) {
          await this.subscribeBilibiliUser(groupId, botId, host_mid, remark)
        }
      }
    }

    // 2. 删除数据库里存在、但配置文件里没有的订阅
    const allGroups: GroupRow[] = await this.db.get(TABLE.bilibiliGroup, {})

    for (const group of allGroups) {
      const groupId = group.id
      const configUps = configSubscriptions.get(groupId) ?? new Set<number>()
      const dbSubscriptions: BilibiliSubscriptionRow[] = await this.db.get(TABLE.bilibiliSubscription, { groupId })

      for (const subscription of dbSubscriptions) {
        if (configUps.has(subscription.host_mid)) continue
        await this.unsubscribeBilibiliUser(groupId, subscription.host_mid)
        logger.mark(`已删除群组 ${groupId} 对UP主 ${subscription.host_mid} 的订阅`)
      }
    }

    // 3. 清理不再被任何群组订阅的UP主记录及其过滤词和过滤标签
    const allUsers: BilibiliUserRow[] = await this.db.get(TABLE.bilibiliUser, {})

    for (const user of allUsers) {
      const subscribedGroups = await this.getUserSubscribedGroups(user.host_mid)
      if (subscribedGroups.length > 0) continue

      await this.db.remove(TABLE.bilibiliFilterWord, { host_mid: user.host_mid })
      await this.db.remove(TABLE.bilibiliFilterTag, { host_mid: user.host_mid })
      await this.db.remove(TABLE.bilibiliUser, { host_mid: user.host_mid })

      logger.mark(`已删除UP主 ${user.host_mid} 的记录及相关过滤设置（不再被任何群组订阅）`)
    }
  }

  /**
   * 更新用户的过滤模式
   * @param host_mid B站用户UID
   * @param filterMode 过滤模式
   */
  async updateFilterMode(host_mid: number, filterMode: 'blacklist' | 'whitelist'): Promise<BilibiliUser> {
    const user = await this.getOrCreateBilibiliUser(host_mid)
    const time = now()

    await this.db.set(TABLE.bilibiliUser, { host_mid }, { filterMode, updatedAt: time })

    return { ...user, filterMode, updatedAt: time }
  }

  /**
   * 添加过滤词
   * @param host_mid B站用户UID
   * @param word 过滤词
   */
  async addFilterWord(host_mid: number, word: string): Promise<FilterWord> {
    await this.getOrCreateBilibiliUser(host_mid)

    const [existing] = await this.db.get(TABLE.bilibiliFilterWord, { host_mid, word })
    if (existing) return existing

    const time = now()
    return await this.db.create(TABLE.bilibiliFilterWord, { host_mid, word, createdAt: time, updatedAt: time })
  }

  /**
   * 删除过滤词
   * @param host_mid B站用户UID
   * @param word 过滤词
   */
  async removeFilterWord(host_mid: number, word: string): Promise<boolean> {
    const result = await this.db.remove(TABLE.bilibiliFilterWord, { host_mid, word })
    return (result.removed ?? 0) > 0
  }

  /**
   * 添加过滤标签
   * @param host_mid B站用户UID
   * @param tag 过滤标签
   */
  async addFilterTag(host_mid: number, tag: string): Promise<FilterTag> {
    await this.getOrCreateBilibiliUser(host_mid)

    const [existing] = await this.db.get(TABLE.bilibiliFilterTag, { host_mid, tag })
    if (existing) return existing

    const time = now()
    return await this.db.create(TABLE.bilibiliFilterTag, { host_mid, tag, createdAt: time, updatedAt: time })
  }

  /**
   * 删除过滤标签
   * @param host_mid B站用户UID
   * @param tag 过滤标签
   */
  async removeFilterTag(host_mid: number, tag: string): Promise<boolean> {
    const result = await this.db.remove(TABLE.bilibiliFilterTag, { host_mid, tag })
    return (result.removed ?? 0) > 0
  }

  /**
   * 获取用户的所有过滤词
   * @param host_mid B站用户UID
   */
  async getFilterWords(host_mid: number): Promise<string[]> {
    const rows: BilibiliFilterWordRow[] = await this.db.get(TABLE.bilibiliFilterWord, { host_mid })
    return rows.map((row) => row.word)
  }

  /**
   * 获取用户的所有过滤标签
   * @param host_mid B站用户UID
   */
  async getFilterTags(host_mid: number): Promise<string[]> {
    const rows: BilibiliFilterTagRow[] = await this.db.get(TABLE.bilibiliFilterTag, { host_mid })
    return rows.map((row) => row.tag)
  }

  /**
   * 获取用户的过滤配置
   * @param host_mid B站用户UID
   */
  async getFilterConfig(host_mid: number): Promise<{ filterMode: 'blacklist' | 'whitelist'; filterWords: string[]; filterTags: string[] }> {
    const user = await this.getOrCreateBilibiliUser(host_mid)
    const filterWords = await this.getFilterWords(host_mid)
    const filterTags = await this.getFilterTags(host_mid)

    return {
      filterMode: user.filterMode,
      filterWords,
      filterTags
    }
  }

  /**
   * 从动态中提取文本内容和标签
   * @param dynamicData 动态数据
   * @returns 提取的文本内容和标签
   */
  private async extractTextAndTags(dynamicData: any): Promise<{ text: string; tags: string[] }> {
    let text = ''
    const tags: string[] = []

    // 如果没有模块数据，返回空结果
    if (!dynamicData || !dynamicData.modules || !dynamicData.modules.module_dynamic) {
      return { text, tags }
    }

    const moduleDynamic = dynamicData.modules.module_dynamic

    // 提取直播标题和分区
    if (moduleDynamic.major && moduleDynamic.major.live_rcmd) {
      const content = JSON.parse(moduleDynamic.major.live_rcmd.content)
      text += content.live_play_info.title + ' '
      tags.push(content.live_play_info.area_name)
    }

    // 提取描述文本
    if (moduleDynamic.desc && moduleDynamic.desc.text) {
      text += moduleDynamic.desc.text + ' '
    }

    // 提取视频标题
    if (moduleDynamic.major && moduleDynamic.major.archive && moduleDynamic.major.archive.title) {
      text += moduleDynamic.major.archive.title + ' '
    }

    // 提取标签
    // 主动态
    if (moduleDynamic.desc && moduleDynamic.desc.rich_text_nodes) {
      for (const node of moduleDynamic.desc.rich_text_nodes) {
        if (node.type !== 'RICH_TEXT_NODE_TYPE_TEXT') {
          tags.push(node.orig_text)
        }
      }
    }
    // 若为转发动态，再检查子动态
    if (dynamicData.type === DynamicType.FORWARD && 'orig' in dynamicData) {
      if (dynamicData.orig.type === DynamicType.AV) {
        text += dynamicData.orig.modules.module_dynamic.major.archive.title + ''
      } else {
        logger.debug(`提取子动态文本和tag：https://t.bilibili.com/${dynamicData.id_str}`)
        try {
          text += dynamicData.orig.modules.module_dynamic.major.opus.summary.text + ' '
          for (const node of dynamicData.orig.modules.module_dynamic.major.opus.summary.rich_text_nodes) {
            tags.push(node.orig_text)
          }
        } catch (error) {
          logger.error(`提取子动态文本和tag失败：${error}`)
        }
      }
    }

    return { text: text.trim(), tags }
  }

  /**
   * 检查内容是否应该被过滤
   * @param PushItem 推送项
   * @param tags 额外的标签列表
   */
  async shouldFilter(PushItem: BilibiliPushItem, extraTags: string[] = []): Promise<boolean> {
    // 获取用户的过滤配置
    const { filterMode, filterWords, filterTags } = await this.getFilterConfig(PushItem.host_mid)
    logger.debug(`
      获取用户${PushItem.remark}（${PushItem.host_mid}）的过滤配置：
      过滤模式：${filterMode}
      过滤词：${filterWords}
      过滤标签：${filterTags}
      `)

    // 提取主动态的文本和标签
    const { text: mainText, tags: mainTags } = await this.extractTextAndTags(PushItem.Dynamic_Data)
    logger.debug(`
      提取主动态的文本和标签：
      文本：${mainText}
      标签：[${mainTags.join('][')}]
      `)

    // 合并所有标签
    let allTags = [...mainTags, ...extraTags]
    let allText = mainText

    // 如果是转发动态，还需要检查原动态
    if (PushItem.Dynamic_Data.type === DynamicType.FORWARD && 'orig' in PushItem.Dynamic_Data) {
      const { text: origText, tags: origTags } = await this.extractTextAndTags(PushItem.Dynamic_Data.orig)
      allText += ' ' + origText
      allTags = [...allTags, ...origTags]
    }

    // 检查内容中是否包含过滤词
    const hasFilterWord = filterWords.some((word: string) => allText.includes(word))

    // 检查标签中是否包含过滤标签
    const hasFilterTag = filterTags.some((filterTag: string) => allTags.some((tag) => tag.includes(filterTag)))

    logger.debug(`
    UP主UID：${PushItem.host_mid}
    检查内容：${allText}
    检查标签：${allTags.join(', ')}
    命中词：[${filterWords.join('], [')}]
    命中标签：[${filterTags.join('], [')}]
    过滤模式：${filterMode}
    是否过滤：${hasFilterWord || hasFilterTag ? logger.red(`${hasFilterWord || hasFilterTag}`) : logger.green(`${hasFilterWord || hasFilterTag}`)}
    动态地址：${logger.green(`https://t.bilibili.com/${PushItem.Dynamic_Data.id_str}`)}
    动态类型：${PushItem.dynamic_type}
    `)

    // 根据过滤模式决定是否过滤
    if (filterMode === 'blacklist') {
      // 黑名单模式：如果包含过滤词或过滤标签，则过滤
      if (hasFilterWord || hasFilterTag) {
        logger.warn(`
        动态内容命中黑名单规则，已过滤该动态不再推送
        动态地址：${logger.yellow(`https://t.bilibili.com/${PushItem.Dynamic_Data.id_str}`)}
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
        动态内容未命中白名单规则，已过滤该动态不再推送
        动态地址：${logger.yellow(`https://t.bilibili.com/${PushItem.Dynamic_Data.id_str}`)}
        当前白名单词：[${filterWords.join('], [')}]
        当前白名单标签：[${filterTags.join('], [')}]
      `)
      return true // 过滤
    }
  }

  /**
   * 清理旧的动态缓存记录
   * @param days 保留最近几天的记录
   * @returns 删除的记录数量
   */
  async cleanOldDynamicCache(days: number = 7): Promise<number> {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - days)

    const result = await this.db.remove(TABLE.bilibiliDynamicCache, {
      createdAt: { $lt: cutoffDate.toISOString() }
    })
    return result.removed ?? 0
  }

  /** 为了向后兼容，保留groupRepository和dynamicCacheRepository属性 */
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
        return (await this.db.get(TABLE.bilibiliGroup, {})) as GroupRow[]
      }
    }
  }

  get dynamicCacheRepository() {
    return {
      find: async <T = DynamicCache & { createdAt: Date; updatedAt: Date }>(
        options: {
          where?: {
            groupId?: string
            host_mid?: number
            dynamic_id?: string
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
        if (where.host_mid) query.host_mid = where.host_mid
        if (where.dynamic_id) query.dynamic_id = where.dynamic_id

        // 构建排序（minato 只认 asc / desc）
        const sort: Record<string, 'asc' | 'desc'> = {}
        const allowedFields = ['id', 'dynamic_id', 'host_mid', 'groupId', 'dynamic_type', 'createdAt', 'updatedAt']
        for (const [field, direction] of Object.entries(order ?? {})) {
          if (!allowedFields.includes(field)) continue
          sort[field] = String(direction).toLowerCase() === 'asc' ? 'asc' : 'desc'
        }

        const cursor: Record<string, any> = {}
        if (Object.keys(sort).length) cursor.sort = sort
        if (take) cursor.limit = take

        const caches: DynamicCacheRow[] = await this.db.get(TABLE.bilibiliDynamicCache, query, cursor)

        // 如果需要关联bilibiliUser数据
        if (relations && relations.includes('bilibiliUser')) {
          const result = []
          for (const cache of caches) {
            const bilibiliUser = await this.getBilibiliUser(cache.host_mid)
            result.push({
              ...cache,
              bilibiliUser,
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
      delete: async (conditions: { groupId?: string; host_mid?: number; dynamic_id?: string }) => {
        const { groupId, host_mid, dynamic_id } = conditions

        // 优先处理 dynamic_id + groupId 的精确删除（单条记录）
        if (dynamic_id && groupId) {
          const result = await this.db.remove(TABLE.bilibiliDynamicCache, { dynamic_id, groupId })
          return { affected: result.removed ?? 0 }
        }
        if (groupId && host_mid) {
          const result = await this.db.remove(TABLE.bilibiliDynamicCache, { groupId, host_mid })
          return { affected: result.removed ?? 0 }
        }
        if (groupId) {
          const result = await this.db.remove(TABLE.bilibiliDynamicCache, { groupId })
          return { affected: result.removed ?? 0 }
        }
        if (host_mid) {
          const result = await this.db.remove(TABLE.bilibiliDynamicCache, { host_mid })
          return { affected: result.removed ?? 0 }
        }
        if (dynamic_id) {
          const result = await this.db.remove(TABLE.bilibiliDynamicCache, { dynamic_id })
          return { affected: result.removed ?? 0 }
        }
        return { affected: 0 }
      }
    }
  }
}
