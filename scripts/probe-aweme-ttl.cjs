/**
 * 探针：抖音作品缓存的「滑动 TTL」续期去重（上游 ff54ba5 的移植验证）
 *
 * 要验证的用户可见行为：
 *   1. 喜欢/推荐列表里**还在列表**的作品，去重记录不会过期（不会被重推）；
 *   2. 掉出列表的作品，保留期后被回收（缓存表不会无限涨）；
 *   3. 老记录升级上来时，**只要本轮还在列表里就会被续期**，不会被误清；
 *   4. 清理判据读的是 `updatedAt`（不是 `createdAt`）—— 这条是 ff54ba5 的核心，
 *      也是最容易漏的：写成 createdAt 的话，长期在列表里的作品会被按「创建时间」清掉 → 重推。
 *
 * 用临时 sqlite，跑完即删。用法：
 *   node scripts/probe-aweme-ttl.cjs
 *   KKK_LIB=E:/devkoishi/node_modules/koishi-plugin-kkk/lib node scripts/probe-aweme-ttl.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
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

/** 把某条缓存记录的 updatedAt 直接改到 N 天前（模拟「很久没在列表里出现过」） */
const ageRecord = async (ctx, aweme_id, sec_uid, pushType, days) => {
  const t = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString()
  await ctx.database.set('kkk.douyin.awemeCache', { aweme_id, sec_uid, pushType }, { updatedAt: t, createdAt: t })
}

const main = async () => {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kkk-ttl-')), 'koishi.db')

  const { Context } = require('koishi')
  const sqlite = require('@koishijs/plugin-database-sqlite').default

  const ctx = new Context()
  ctx.plugin(sqlite, { path: dbFile })
  await ctx.start()
  if (!ctx.database) throw new Error('ctx.database 不可用')

  const { bindRuntime } = require(path.join(LIB, 'compat/runtime.js'))
  bindRuntime({
    ctx,
    config: { masters: [], debug: false, dataPath: 'data' },
    pluginRoot: ROOT,
    dataRoot: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kkk-data-')), 'data')
  })

  const { bootstrapDatabases } = require(path.join(LIB, 'karin/module/db/index.js'))
  const { douyinDB } = await bootstrapDatabases(ctx)

  const SEC = 'sec-ttl'
  const BOT = 'bot-ttl'
  const GROUP = 'group-ttl'

  // ---------------- 1. touchAwemeCache 存在且能续期 ----------------
  console.log('\n[1] touchAwemeCache：把仍在列表里的作品续期')
  ok('产物里有 touchAwemeCache', typeof douyinDB.touchAwemeCache === 'function')
  ok('产物里 cleanOldAwemeCache 还在', typeof douyinDB.cleanOldAwemeCache === 'function')

  await douyinDB.subscribeDouyinUser(GROUP, BOT, SEC, 'ttl123', 'TTL测试')

  // 造两条 30 天前的老记录：一条仍在列表（keep）、一条掉出列表（drop）
  for (const id of ['keep-1', 'drop-1']) {
    await douyinDB.addAwemeCache(id, SEC, GROUP, 'favorite')
  }
  await ageRecord(ctx, 'keep-1', SEC, 'favorite', 30)
  await ageRecord(ctx, 'drop-1', SEC, 'favorite', 30)

  const aged = await ctx.database.get('kkk.douyin.awemeCache', { sec_uid: SEC, pushType: 'favorite' })
  const allAged = aged.every((r) => Date.now() - new Date(r.updatedAt).getTime() > 20 * 24 * 3600 * 1000)
  ok('前置条件：两条记录都已经是 30 天前的', allAged, aged.map((r) => r.aweme_id + '@' + r.updatedAt))

  // 只有 keep-1 还在列表里 → 续期
  await douyinDB.touchAwemeCache(SEC, 'favorite', ['keep-1'])

  const afterTouch = await ctx.database.get('kkk.douyin.awemeCache', { sec_uid: SEC, pushType: 'favorite' })
  const keep = afterTouch.find((r) => r.aweme_id === 'keep-1')
  const drop = afterTouch.find((r) => r.aweme_id === 'drop-1')
  ok('keep-1 的 updatedAt 被刷成了「现在」',
    keep && Date.now() - new Date(keep.updatedAt).getTime() < 60 * 1000,
    keep && keep.updatedAt)
  ok('keep-1 的 createdAt 保持原样（续期不该动创建时间）',
    keep && Date.now() - new Date(keep.createdAt).getTime() > 20 * 24 * 3600 * 1000,
    keep && keep.createdAt)
  ok('drop-1 没被续期（不在列表里就不动它）',
    drop && Date.now() - new Date(drop.updatedAt).getTime() > 20 * 24 * 3600 * 1000,
    drop && drop.updatedAt)

  // ---------------- 2. 清理判据是 updatedAt ----------------
  console.log('\n[2] cleanOldAwemeCache：按 updatedAt 清理')
  const removed = await douyinDB.cleanOldAwemeCache(7)
  ok('清理有删除记录', removed > 0, removed)

  const left = await ctx.database.get('kkk.douyin.awemeCache', { sec_uid: SEC, pushType: 'favorite' })
  const ids = left.map((r) => r.aweme_id)
  ok('★ 仍在列表的 keep-1 没被清掉（否则会被重推）', ids.includes('keep-1'), ids)
  ok('掉出列表的 drop-1 被清了', !ids.includes('drop-1'), ids)

  // ---------------- 3. 判据必须读 updatedAt 而不是 createdAt（源码守卫） ----------------
  console.log('\n[3] 源码守卫：清理判据是 updatedAt')
  const dbSrc = fs.readFileSync(path.join(ROOT, 'src/karin/module/db/douyin.ts'), 'utf8')
  const cleanBody = dbSrc.slice(dbSrc.indexOf('async cleanOldAwemeCache'))
  ok('cleanOldAwemeCache 用的是 updatedAt',
    /\$lt: cutoffDate\.toISOString\(\)/.test(cleanBody) &&
    cleanBody.slice(0, cleanBody.indexOf('$lt')).lastIndexOf('updatedAt') > cleanBody.slice(0, cleanBody.indexOf('$lt')).lastIndexOf('createdAt'),
    '判据字段')
  ok('touchAwemeCache 写的是 updatedAt',
    /touchAwemeCache[\s\S]{0,400}updatedAt:\s*now\(\)/.test(dbSrc))

  // ---------------- 4. 清理时机：必须在 getDynamicList 之后 ----------------
  console.log('\n[4] 源码守卫：清理时机在续期之后')
  const pushSrc = fs.readFileSync(path.join(ROOT, 'src/karin/platform/douyin/push.ts'), 'utf8')
  const actionBody = pushSrc.slice(pushSrc.indexOf('async action()'))
  const idxGet = actionBody.indexOf('getDynamicList')
  const idxClean = actionBody.indexOf('cleanOldDynamicCache')
  ok('cleanOldDynamicCache 出现在 getDynamicList 之后',
    idxGet !== -1 && idxClean !== -1 && idxClean > idxGet,
    { idxGet, idxClean })
  ok('清理块在 push.ts 里只出现一次（没有留在 action 开头）',
    (actionBody.match(/cleanOldDynamicCache/g) || []).length === 1)

  // ---------------- 5. 两个列表处理器都换成了 touch ----------------
  console.log('\n[5] favorite / recommend 都改用 touchAwemeCache')
  for (const f of ['favorite', 'recommend']) {
    const src = fs.readFileSync(path.join(ROOT, `src/karin/platform/douyin/push/${f}.ts`), 'utf8')
    ok(`${f}.ts 调用了 touchAwemeCache`, /touchAwemeCache\(/.test(src))
    ok(`${f}.ts 不再调用 updateListSnapshot`, !/updateListSnapshot\(/.test(src))
  }

  // ---------------- 6. 空列表 / 重复 id 不炸 ----------------
  console.log('\n[6] 边界')
  await douyinDB.touchAwemeCache(SEC, 'favorite', [])
  ok('空数组不炸', true)
  await douyinDB.touchAwemeCache(SEC, 'favorite', ['keep-1', 'keep-1', 'keep-1'])
  ok('重复 id 不炸（内部去重）', true)
  await douyinDB.touchAwemeCache(SEC, 'favorite', ['不存在的作品id'])
  ok('续期不存在的记录不炸', true)

  await ctx.stop()

  console.log(failed === 0 ? '\n✔ 全部通过' : `\n✘ 有 ${failed} 项没通过`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
