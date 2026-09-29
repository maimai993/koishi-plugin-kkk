import { Context } from 'koishi'

import { BilibiliDBBase } from './bilibili'
import { DouyinDBBase } from './douyin'
import { extendModels } from './model'
import { StatisticsDBBase } from './statistics'

export * from './bilibili'
export * from './douyin'
export * from './statistics'
export { TABLE, extendModels } from './model'

/** 抖音数据库实例 */
let douyinDB: DouyinDBBase | null = null
let douyinInitializing = false

/** B站数据库实例 */
let bilibiliDB: BilibiliDBBase | null = null
let bilibiliInitializing = false

/** 统计数据库实例 */
let statisticsDB: StatisticsDBBase | null = null
let statisticsInitializing = false

/**
 * 数据库用的是 **Koishi 原生数据库服务**（`ctx.database`），
 * 插件自己不再开 sqlite 文件。这里存的就是插件启动时传进来的那个 ctx。
 */
let dbCtx: Context | null = null

/**
 * 绑定数据库上下文并注册表结构。
 * 插件 apply 阶段调用一次；之后所有数据库实例都从这个 ctx 上取 `ctx.database`。
 */
export const setDatabaseContext = (ctx: Context): void => {
  dbCtx = ctx
  extendModels(ctx)
}

/** 取数据库上下文；还没绑定就抛一个说得清楚的错 */
const requireCtx = (name: string): Context => {
  if (!dbCtx) throw new Error('[' + name + '] 数据库尚未初始化，请先等待插件启动完成')
  return dbCtx
}

/**
 * 获取或初始化 DouyinDB 实例（单例模式）
 * @returns DouyinDB实例
 */
export const getDouyinDB = async (): Promise<DouyinDBBase> => {
  if (douyinDB) {
    return douyinDB
  }

  if (douyinInitializing) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    return douyinDB!
  }

  douyinInitializing = true
  try {
    douyinDB = await new DouyinDBBase(requireCtx('DouyinDB')).init()
    return douyinDB
  } finally {
    douyinInitializing = false
  }
}

/**
 * 获取或初始化 BilibiliDB 实例（单例模式）
 * @returns BilibiliDB实例
 */
export const getBilibiliDB = async (): Promise<BilibiliDBBase> => {
  if (bilibiliDB) {
    return bilibiliDB
  }

  if (bilibiliInitializing) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    return bilibiliDB!
  }

  bilibiliInitializing = true
  try {
    bilibiliDB = await new BilibiliDBBase(requireCtx('BilibiliDB')).init()
    return bilibiliDB
  } finally {
    bilibiliInitializing = false
  }
}

/**
 * 获取或初始化 StatisticsDB 实例（单例模式）
 * @returns StatisticsDB实例
 */
export const getStatisticsDB = async (): Promise<StatisticsDBBase> => {
  if (statisticsDB) {
    return statisticsDB
  }

  if (statisticsInitializing) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    return statisticsDB!
  }

  statisticsInitializing = true
  try {
    statisticsDB = await new StatisticsDBBase(requireCtx('StatisticsDB')).init()
    return statisticsDB
  } finally {
    statisticsInitializing = false
  }
}

/**
 * 初始化所有数据库
 * @returns 初始化后的数据库实例
 */
export const initAllDatabases = async () => {
  const [douyin, bilibili, statistics] = await Promise.all([getDouyinDB(), getBilibiliDB(), getStatisticsDB()])

  return { douyinDB: douyin, bilibiliDB: bilibili, statisticsDB: statistics }
}

// Koishi 移植说明：
// 原实现用顶层 await 立即初始化实例，CJS 构建下不支持，改为插件入口在 apply 阶段调用 bootstrapDatabases()。
// 但**不能**直接导出可变的 let 实例：`@/module`（module/index.ts）里是 `export * from './db'`，
// tsc 对 CJS 的 `export *` 是「复制属性」而非实时绑定，复制发生在模块首次加载时（此时实例还是 null），
// 之后即使重新赋值，消费方拿到的仍是旧的 null。
// 所以这里导出**稳定的代理对象**，内部始终转发到当前实例。
const createLazyInstance = <T extends object>(name: string, getter: () => T | null): T =>
  new Proxy({} as T, {
    get(_target, prop) {
      const instance = getter()
      if (!instance) throw new Error('[' + name + '] 数据库尚未初始化，请先等待插件启动完成')
      const value = Reflect.get(instance as object, prop)
      return typeof value === 'function' ? value.bind(instance) : value
    },
    has(_target, prop) {
      const instance = getter()
      return instance ? Reflect.has(instance as object, prop) : false
    }
  })

let douyinDBReal: DouyinDBBase | null = null
let bilibiliDBReal: BilibiliDBBase | null = null
let statisticsDBReal: StatisticsDBBase | null = null

/** 抖音数据库实例（稳定代理，转发到内部实例） */
export const douyinDB: DouyinDBBase = createLazyInstance('DouyinDB', () => douyinDBReal)
/** B站数据库实例（稳定代理，转发到内部实例） */
export const bilibiliDB: BilibiliDBBase = createLazyInstance('BilibiliDB', () => bilibiliDBReal)
/** 统计数据库实例（稳定代理，转发到内部实例） */
export const statisticsDB: StatisticsDBBase = createLazyInstance('StatisticsDB', () => statisticsDBReal)

// 向后兼容别名
export const douyinDBInstance: DouyinDBBase = douyinDB
export const bilibiliDBInstance: BilibiliDBBase = bilibiliDB
export const statisticsDBInstance: StatisticsDBBase = statisticsDB

/** 初始化并填充所有数据库实例（插件启动时调用一次） */
export const bootstrapDatabases = async (ctx: Context) => {
  setDatabaseContext(ctx)
  const result = await initAllDatabases()
  douyinDBReal = result.douyinDB
  bilibiliDBReal = result.bilibiliDB
  statisticsDBReal = result.statisticsDB
  return result
}

/**
 * 清理旧的动态缓存记录
 * @param platform 指定数据库，'douyin' | 'bilibili'
 * @param days 保留最近几天的记录，默认为7天
 * @returns 删除的记录数量
 */
export const cleanOldDynamicCache = async (platform: 'douyin' | 'bilibili', days: number = 7): Promise<number> => {
  if (platform === 'douyin') {
    const db = await getDouyinDB()
    return await db.cleanOldAwemeCache(days)
  } else {
    const db = await getBilibiliDB()
    return await db.cleanOldDynamicCache(days)
  }
}
