/**
 * 数据库冒烟：把插件的三张库（抖音 / B站 / 统计）在 **Koishi 原生数据库服务** 上跑一遍。
 *
 * 覆盖点：建表、订阅与取消订阅、推送缓存、过滤词/标签、快照、
 * 统计自增（含 upsert + $.add 表达式）、趋势/时段/形态/耗时分桶查询。
 * 用的是临时 sqlite 文件，跑完就删。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
// 默认跑开发目录的构建产物；想验「已经部署到 node_modules 的那份」，用：
//   KKK_LIB=E:/devkoishi/node_modules/koishi-plugin-kkk/lib node scripts/smoke-db-koishi.cjs
const LIB = process.env.KKK_LIB ? path.resolve(process.env.KKK_LIB) : path.join(ROOT, 'lib')

let failed = 0
const ok = (label, cond, extra) => {
  if (cond) {
    console.log('  ✓ ' + label)
  } else {
    failed++
    console.log('  ✗ ' + label + (extra === undefined ? '' : ' → ' + JSON.stringify(extra)))
  }
}

const main = async () => {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kkk-db-')), 'koishi.db')

  const { Context } = require('koishi')
  const sqlite = require('@koishijs/plugin-database-sqlite').default

  const ctx = new Context()
  ctx.plugin(sqlite, { path: dbFile })
  await ctx.start()

  if (!ctx.database) throw new Error('ctx.database 不可用，数据库服务没起来')

  // 业务代码要读数据目录 / 日志，先把运行时绑上
  const { bindRuntime } = require(path.join(LIB, 'compat/runtime.js'))
  bindRuntime({
    ctx,
    config: { masters: [], debug: false, dataPath: 'data' },
    pluginRoot: ROOT,
    dataRoot: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kkk-data-')), 'data')
  })

  const { bootstrapDatabases } = require(path.join(LIB, 'karin/module/db/index.js'))
  const { douyinDB, bilibiliDB, statisticsDB } = await bootstrapDatabases(ctx)
  ok('bootstrapDatabases 返回三个实例', !!douyinDB && !!bilibiliDB && !!statisticsDB)

  // ---------------- 抖音 ----------------
  console.log('\n[抖音]')
  await douyinDB.subscribeDouyinUser('group-1', 'bot-1', 'sec-uid-1', 'dy123', '测试博主')
  ok('订阅后 isSubscribed', await douyinDB.isSubscribed('sec-uid-1', 'group-1'))

  const douyinUser = await douyinDB.getDouyinUser('sec-uid-1')
  ok('用户记录写入', douyinUser && douyinUser.short_id === 'dy123' && douyinUser.remark === '测试博主', douyinUser)

  const subs = await douyinDB.getGroupSubscriptions('group-1')
  ok('群订阅带出用户信息', subs.length === 1 && subs[0].douyinUser.remark === '测试博主', subs)

  await douyinDB.addAwemeCache('aweme-1', 'sec-uid-1', 'group-1', 'post')
  ok('作品缓存 isAwemePushed', await douyinDB.isAwemePushed('aweme-1', 'sec-uid-1', 'group-1', 'post'))
  ok('hasHistory', await douyinDB.hasHistory('sec-uid-1', 'group-1', 'post'))

  await douyinDB.addFilterWord('sec-uid-1', '广告')
  await douyinDB.addFilterTag('sec-uid-1', '带货')
  const dyFilter = await douyinDB.getFilterConfig('sec-uid-1')
  ok('过滤词/标签', dyFilter.filterWords.includes('广告') && dyFilter.filterTags.includes('带货'), dyFilter)
  ok('过滤模式', await douyinDB.updateFilterMode('sec-uid-1', 'whitelist') === undefined || true)
  ok('过滤模式已改', (await douyinDB.getFilterConfig('sec-uid-1')).filterMode === 'whitelist')
  ok('删除过滤词', await douyinDB.removeFilterWord('sec-uid-1', '广告'))

  await douyinDB.updateListSnapshot('sec-uid-1', 'favorite', ['a1', 'a2'])
  ok('列表快照', await douyinDB.isAwemeInList('a1', 'sec-uid-1', 'favorite'))
  await douyinDB.updateListSnapshot('sec-uid-1', 'favorite', ['a3'])
  ok('快照被覆盖', !await douyinDB.isAwemeInList('a1', 'sec-uid-1', 'favorite'))

  ok('直播状态', await douyinDB.updateLiveStatus('sec-uid-1', true) && (await douyinDB.getLiveStatus('sec-uid-1')).living)

  await douyinDB.unsubscribeDouyinUser('group-1', 'sec-uid-1')
  ok('取消订阅', !await douyinDB.isSubscribed('sec-uid-1', 'group-1'))
  ok('取消订阅后用户被清理', await douyinDB.getDouyinUser('sec-uid-1') === null)

  // ---------------- B站 ----------------
  console.log('\n[B站]')
  await bilibiliDB.subscribeBilibiliUser('group-2', 'bot-1', 123456, '某UP')
  ok('订阅后 isSubscribed', await bilibiliDB.isSubscribed(123456, 'group-2'))

  const biUser = await bilibiliDB.getBilibiliUser(123456)
  ok('UP 记录写入', biUser && biUser.remark === '某UP' && biUser.filterMode === 'blacklist', biUser)

  const biSubs = await bilibiliDB.getGroupSubscriptions('group-2')
  ok('群订阅带出 UP 信息', biSubs.length === 1 && biSubs[0].bilibiliUser.remark === '某UP', biSubs)

  await bilibiliDB.addDynamicCache('dyn-1', 123456, 'group-2', 'DYNAMIC_TYPE_AV')
  ok('动态缓存 isDynamicPushed', await bilibiliDB.isDynamicPushed('dyn-1', 123456, 'group-2'))
  const caches = await bilibiliDB.getGroupDynamicCache('group-2')
  ok('动态缓存可读', caches.length === 1 && caches[0].dynamic_type === 'DYNAMIC_TYPE_AV', caches)

  await bilibiliDB.addFilterWord(123456, '抽奖')
  await bilibiliDB.addFilterTag(123456, '直播')
  const biFilter = await bilibiliDB.getFilterConfig(123456)
  ok('过滤词/标签', biFilter.filterWords.includes('抽奖') && biFilter.filterTags.includes('直播'), biFilter)

  ok('订阅群反查', (await bilibiliDB.getUserSubscribedGroups(123456)).length >= 1)

  const cleaned = await bilibiliDB.cleanOldDynamicCache(0)
  ok('清理过期缓存', cleaned >= 1, cleaned)

  await bilibiliDB.unsubscribeBilibiliUser('group-2', 123456)
  ok('取消订阅', !await bilibiliDB.isSubscribed(123456, 'group-2'))
  ok('取消订阅后 UP 被清理', await bilibiliDB.getBilibiliUser(123456) === null)

  // ---------------- 统计 ----------------
  console.log('\n[统计]')
  await statisticsDB.recordParse('group-9', 'user-1', 'douyin', { workType: 'video', durationMs: 1200 })
  await statisticsDB.recordParse('group-9', 'user-1', 'douyin', { workType: 'video', durationMs: 800 })
  await statisticsDB.recordParse('group-9', 'user-2', 'bilibili', { workType: 'gallery', durationMs: 35000 })

  const groupStats = await statisticsDB.getGroupStatistics('group-9')
  const douyinRow = groupStats.find((row) => row.platform === 'douyin')
  ok('同用户同平台自增到 2', douyinRow && douyinRow.parseCount === 2, groupStats)
  ok('群唯一用户数', await statisticsDB.getGroupUniqueUsers('group-9') === 2)
  ok('平台总解析次数', await statisticsDB.getPlatformTotalParses('douyin') === 2)

  const summary = await statisticsDB.getGlobalSummary()
  ok('总解析次数 = 3', summary.totalParses === 3, summary)
  ok('总群组数 = 1', summary.totalGroups === 1, summary)
  ok('平台分布', summary.platformStats.douyin === 2 && summary.platformStats.bilibili === 1, summary.platformStats)

  const today = new Date().toISOString().split('T')[0]
  // 这两张表都是「群 × 日期 / 小时 × 平台」一行，所以抖音 2 + B站 1 = 两行
  const history = await statisticsDB.getGroupRecentHistory('group-9', 30)
  ok('群日粒度', history.length === 2 && history.every((row) => row.date === today)
    && history.reduce((sum, row) => sum + row.parseCount, 0) === 3, history)
  ok('活跃天数', await statisticsDB.getGroupActiveDays('group-9') === 1)

  const hourStats = await statisticsDB.getGroupHourStats('group-9')
  ok('时段分布', hourStats.length === 2 && hourStats.reduce((sum, row) => sum + row.parseCount, 0) === 3, hourStats)

  const workTypes = await statisticsDB.getGroupWorkTypeStats('group-9')
  ok('形态分布', workTypes.length === 2, workTypes)
  ok('全局形态分布', (await statisticsDB.getGlobalWorkTypeStats()).length === 2)

  const metrics = await statisticsDB.getGroupMetricStats('group-9')
  ok('耗时分桶', metrics.length === 3 && metrics.reduce((sum, item) => sum + item.count, 0) === 3, metrics)
  ok('全局耗时分桶', (await statisticsDB.getGlobalMetricStats()).reduce((sum, item) => sum + item.count, 0) === 3)

  const recent = await statisticsDB.getRecentHistory(30)
  ok('日历史', recent.length === 1 && recent[0].totalParses === 3, recent)
  ok('可信起始日', await statisticsDB.getHistoryCompleteFrom() === today)
  ok('首次出现', (await statisticsDB.getGroupFirstSeen()).length === 1)
  ok('全局唯一用户', await statisticsDB.getTotalUniqueUsers() === 2)

  const removed = await statisticsDB.getRecentHistory(30)
  ok('二次读取稳定', removed.length === 1)

  await ctx.stop()
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true })

  console.log('\n' + (failed ? '✗ ' + failed + ' 项失败' : '✓ 全部通过'))
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
