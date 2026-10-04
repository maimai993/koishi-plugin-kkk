/**
 * 探针：抖音推送取用户信息的口径（上游 f4b5312 的移植验证）
 *
 * 背景：`fetchUserProfile()` 返回的是信封 `{ data: { user: {...} }, ... }`，
 * 各推送流程一律传 `.data` 当 `user_info`（见 push.ts:893 传 `userinfo.data`），
 * 所以 `Detail_Data.user_info` 顶层就有 `.user`，**没有** `.data`。
 * 历史上 render.ts 有 3 处写成 `user_info?.data?.user`，恒为 undefined 而静默兜底：
 *   - 527 行：订阅者昵称/头像 → 退化成作品作者（上游本次修的就是这处）
 *   -  54 行：共创信息里「订阅者的协作身份」→ 退化成作者
 *   - 374 行：博主 IP 属地 → 退化成作品自带的 ip_location
 *
 * 做法：打桩 `Render` 截获交给模板的 data，再用「用户资料 vs 作品字段」故意冲突的两组值，
 * 看最终到底采信了谁 —— 这样能真正区分「修好了」和「看着像修好了」。
 *
 * 用法：node scripts/probe-dy-user-info.cjs
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

const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

/** 一个够用的抖音用户对象 */
const makeUser = (tag) => ({
  uid: tag + '-uid',
  sec_uid: tag + '-sec',
  nickname: tag,
  unique_id: tag + '_unique',
  avatar_larger: { url_list: ['https://example.com/' + tag + '.jpg'], uri: tag + '-uri' },
  follower_count: 11,
  total_favorited: 22,
  following_count: 33
})

const main = async () => {
  const { bindRuntime } = require(path.join(LIB, 'compat/runtime.js'))
  const dataRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kkk-dyuser-')), 'data')
  bindRuntime({
    ctx: { config: { port: 5200 } },
    config: { app: {}, errorNoCard: true },
    pluginRoot: ROOT,
    dataRoot
  })
  require(path.join(LIB, 'compat/logger.js')).setLogger({ debug () {}, info () {}, warn () {}, error () {} })

  // ---------------- 1. 源码守卫：三处都不再读 .data?.user ----------------
  console.log('\n[1] 源码守卫：render.ts 里 user_info 一律直接取 .user')
  const s = src('src/karin/platform/douyin/push/render.ts')
  const stale = s.match(/user_info\?\.data\?\.user/g) || []
  ok('已经没有 user_info?.data?.user 残留', stale.length === 0, { 数量: stale.length })
  const good = s.match(/user_info\?\.user/g) || []
  ok('user_info?.user 至少出现 3 次（527/54/374 三处）', good.length >= 3, { 数量: good.length })

  // ---------------- 2. 打桩 Render，截获模板数据 ----------------
  const renderMod = require(path.join(LIB, 'karin/module/utils/Render/index.js'))
  const baseMod = require(path.join(LIB, 'karin/module/utils/Base.js'))
  let captured = null
  renderMod.Render = async (e, route, data) => {
    captured = { route, data }
    return []
  }
  baseMod.Count = (n) => String(n)

  const { renderWorkImage } = require(path.join(LIB, 'karin/platform/douyin/push/render.js'))

  /** 造一份 VIDEO 作品详情；作者与订阅者刻意用不同的值，好分辨采信了谁 */
  const buildDetail = (userInfo) => ({
    aweme_type: 0,
    desc: '这是作品简介',
    text_extra: [],
    duration: 15000,
    statistics: { digg_count: 1, comment_count: 2, share_count: 3, collect_count: 4 },
    music: { title: 'BGM', author: '歌手' },
    video: {
      cover: { url_list: ['https://example.com/cover.jpg'], uri: 'cover-uri' },
      play_addr: { width: 1080, height: 1920 },
      bit_rate: []
    },
    // 作品自带 IP 属地：故意与用户资料里的不同
    ip_location: 'IP属地：北京',
    cooperation_info: {
      co_creator_nums: 1,
      co_creators: [
        { uid: '订阅者-uid', sec_uid: '订阅者-sec', nickname: '订阅者', role_title: '联合创作' }
      ]
    },
    user_info: userInfo,
    author: makeUser('作品作者')
  })

  const render = async (userInfo) => {
    captured = null
    await renderWorkImage({
      e: {},
      Detail_Data: buildDetail(userInfo),
      create_time: 1700000000,
      shareLink: 'https://v.douyin.com/abcdef/',
      videoSource: undefined
    })
    return captured
  }

  // ---------------- 3. 正常形态：user_info 顶层就是 .user ----------------
  console.log('\n[2] 正常形态（user_info = fetchUserProfile().data）')
  const subscriber = { ...makeUser('订阅者'), ip_location: 'IP属地：重庆' }
  const r1 = await render({ user: subscriber })
  ok('Render 真的被调到了，路由是 douyin/video-work', !!r1 && r1.route === 'douyin/video-work', r1 && r1.route)
  const d1 = r1 ? r1.data : {}

  ok('★ 昵称取订阅者而不是作者', d1.username === '订阅者', { 实际: d1.username })
  ok('抖音号取订阅者', d1.抖音号 === '订阅者_unique', { 实际: d1.抖音号 })
  ok('★ IP 属地取用户资料的「重庆」，不是作品自带的「北京」',
    d1.ip_location === '重庆', { 实际: d1.ip_location, 作品自带: '北京' })
  ok('共创信息里认出了订阅者的协作身份',
    !!d1.cooperation_info && d1.cooperation_info.subscriber_role === '联合创作',
    d1.cooperation_info && d1.cooperation_info.subscriber_role)

  // ---------------- 4. 反向对照：历史信封形态不再被读取 ----------------
  console.log('\n[3] 对照：把 user_info 塞成历史信封形态 { data: { user } }')
  const r2 = await render({ data: { user: subscriber } })
  const d2 = r2 ? r2.data : {}
  ok('这种情况下顶层没有 .user，昵称兜底回作品作者', d2.username === '作品作者', { 实际: d2.username })
  ok('IP 属地也兜底回作品自带的「北京」', d2.ip_location === '北京', { 实际: d2.ip_location })
  ok('即：现在要求的是解包后的形态，与 push.ts 传 userinfo.data 一致',
    d2.username !== d1.username && d2.ip_location !== d1.ip_location)

  // ---------------- 5. 兜底不被破坏：user_info 缺失仍能出图 ----------------
  console.log('\n[4] user_info 缺失时仍退回作者，不出空卡')
  const r3 = await render(undefined)
  const d3 = r3 ? r3.data : {}
  ok('没有 user_info 时用作者当展示主体', d3.username === '作品作者', { 实际: d3.username })
  ok('IP 属地走作品自带值', d3.ip_location === '北京', { 实际: d3.ip_location })

  console.log('\n' + (failed === 0 ? '全部通过' : '✘ 有 ' + failed + ' 项没通过'))
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('探针自身出错：', err)
  process.exitCode = 2
})
