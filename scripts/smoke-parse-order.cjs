/**
 * 冒烟测试：解析流程的顺序与容错。
 *
 * 验证两条约定（用户要求）：
 *   1. **先下载视频，再渲染卡片** —— 面板选完清晰度后，最慢、最不能失败的下载先做掉；
 *   2. **中间步骤失败只跳过**，后面的步骤照常跑完，最后才渲染一张错误卡片。
 *
 * 注入方式：把用户资料接口（信息卡要用）改成抛错 —— 卡片那一步必失败，
 * 而视频此时应该已经下好了，所以视频必须照常发出去，错误卡片必须出现在最后。
 *
 * 用法：node scripts/smoke-parse-order.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { Context } = require('koishi')

const pluginRoot = path.resolve(__dirname, '..')
const dataRoot = path.resolve(pluginRoot, 'data-smoke-order')
const cfgDir = path.join(dataRoot, 'koishi-plugin-kkk', 'config')
fs.mkdirSync(cfgDir, { recursive: true })

const VIDEO_URL = 'https://www.w3schools.com/html/mov_bbb.mp4'
const COVER_URL = 'https://www.w3schools.com/html/pic_trulli.jpg'

const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'config/default_config/config.json'), 'utf8'))
config.app.parseTip = false
config.app.removeCache = true
config.douyin.videoQuality = '720p'
config.douyin.sendContent = ['info', 'video']
config.douyin.switch = true
config.douyin.videoInfoMode = 'image'
config.bilibili.sendContent = ['info', 'video']
config.bilibili.videoQuality = 32
config.bilibili.showDanmakuInVideoInfo = false
config.pushlist = { douyin: [], bilibili: [] }
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(config, null, 2))

const resolveDep = (name) => {
  try {
    return require(path.join(pluginRoot, 'node_modules', name))
  } catch {
    return require(name)
  }
}
const axios = resolveDep('axios')
const LONG_URL = 'https://www.douyin.com/video/7123456789012345678'
axios.get = async () => ({ request: { res: { responseUrl: LONG_URL } }, data: '' })

const amagi = require('@ikenxuan/amagi')
const realFactory = amagi.default

const makeBitRate = (definition, width, height) => ({
  gear_name: definition,
  quality_type: 28,
  bit_rate: 1000000,
  FPS: 30,
  format: 'mp4',
  video_extra: JSON.stringify({ definition }),
  play_addr: { uri: 'v', url_list: [VIDEO_URL], data_size: 700000, width, height }
})

const makeDetail = () => ({
  aweme_id: '7123456789012345678',
  aweme_type: 0,
  is_slides: false,
  desc: '【顺序验证】抖音视频解析测试',
  preview_title: '【顺序验证】抖音视频解析测试',
  create_time: Math.floor(Date.now() / 1000) - 3600,
  share_url: LONG_URL,
  share_info: { share_url: LONG_URL },
  author: {
    uid: '1234567890',
    sec_uid: 'SEC_UID_TEST',
    nickname: '测试作者',
    unique_id: 'test_author',
    signature: '这里是签名',
    avatar_thumb: { url_list: [COVER_URL] },
    avatar_larger: { url_list: [COVER_URL] },
    follower_count: 12345
  },
  statistics: { digg_count: 1234, comment_count: 56, share_count: 78, collect_count: 910, play_count: 111213 },
  images: null,
  music: null,
  video: {
    play_addr: { uri: 'v', url_list: [VIDEO_URL], data_size: 700000, width: 1280, height: 720 },
    play_addr_h264: { uri: 'v', url_list: [VIDEO_URL], data_size: 700000, width: 1280, height: 720 },
    cover: { url_list: [COVER_URL] },
    origin_cover: { url_list: [COVER_URL] },
    dynamic_cover: { url_list: [COVER_URL] },
    duration: 15000,
    ratio: '720p',
    bit_rate: [makeBitRate('1080p', 1920, 1080), makeBitRate('720p', 1280, 720), makeBitRate('540p', 960, 540)]
  }
})

/** 记录接口调用顺序，用来确认「先下载、后渲染」 */
const calls = []
amagi.default = function (options) {
  const client = realFactory(options)
  client.douyin.fetcher.parseWork = async () => ({ success: true, code: 200, message: 'OK', data: { aweme_detail: makeDetail() } })
  client.douyin.fetcher.fetchWorkComments = async () => ({ success: true, code: 200, message: 'OK', data: { comments: [], cursor: 0, has_more: 0, total: 0 } })
  client.douyin.fetcher.fetchEmojiList = async () => ({ success: true, code: 200, message: 'OK', data: { emoji_list: [] } })
  // 信息卡要用的用户资料：故意抛错，制造「中间步骤失败」
  client.douyin.fetcher.fetchUserProfile = async () => {
    calls.push('fetchUserProfile(抛错)')
    throw new Error('用户资料接口故障（测试注入）')
  }
  // B站：单视频解析要用的几个接口（免登录，走 durl 直链分支）
  const biliInfo = {
    aid: 12345,
    bvid: 'BV1xx411c7mD',
    cid: 67890,
    title: '【顺序验证】B站视频解析测试',
    desc: '这里是简介',
    desc_v2: [],
    pic: COVER_URL,
    ctime: Math.floor(Date.now() / 1000) - 3600,
    duration: 15,
    pages: [{ cid: 67890, duration: 15 }],
    owner: { mid: 1, name: '测试UP', face: COVER_URL },
    stat: { view: 1, danmaku: 2, reply: 3, like: 4, coin: 5, share: 6, favorite: 7 }
  }
  client.bilibili.fetcher.fetchVideoInfo = async () => ({ code: 0, message: 'OK', data: { code: 0, data: biliInfo } })
  client.bilibili.fetcher.fetchVideoStreamUrl = async () => ({
    code: 0,
    message: 'OK',
    data: {
      code: 0,
      data: {
        accept_description: ['360P'],
        accept_quality: [16],
        // 没有 dash → 走免登录直链分支（不需要 Cookie）
        durl: [{ order: 1, length: 15000, size: 700000, url: VIDEO_URL }]
      }
    }
  })
  // 信息卡要用的 UP 名片：故意抛错，制造「中间步骤失败」（和抖音那条对称）
  client.bilibili.fetcher.fetchUserCard = async () => {
    calls.push('fetchUserCard(抛错)')
    throw new Error('UP 名片接口故障（测试注入）')
  }
  client.bilibili.fetcher.fetchComments = async () => ({ code: 0, message: 'OK', data: { replies: [], cursor: {} } })
  client.bilibili.fetcher.fetchVideoDanmaku = async () => ({ code: 0, message: 'OK', data: { data: { elems: [] } } })
  return client
}

const plugin = require(path.join(pluginRoot, 'lib/index.js'))
const ctx = new Context()
const sent = []
const fakeBot = {
  selfId: '10000', platform: 'smoke', status: 1, user: { id: '10000', name: 'smoke' }, ctx,
  sendMessage: async (channel, content) => { sent.push({ channel, content }); return ['msg-1'] },
  getGuild: async () => ({ name: 'smoke-guild' }),
  getFriendList: async () => []
}
Object.defineProperty(ctx, 'bots', { get: () => [fakeBot] })

const middlewares = []
const originalMiddleware = ctx.middleware.bind(ctx)
ctx.middleware = (fn, ...rest) => { middlewares.push(fn); return originalMiddleware(fn, ...rest) }

ctx.plugin(plugin, { dataPath: dataRoot, debug: true, masters: ['12345'], webui: false })

const makeSession = (content) => ({
  content, selfId: '10000', userId: '12345', guildId: '456', channelId: '456',
  messageId: 'm1', bot: fakeBot, author: { nick: 'smoke' }, username: 'smoke', event: {},
  send: async (c) => { sent.push({ channel: '456', content: c }); return ['msg-2'] }
})

async function dispatch (content) {
  const session = makeSession(content)
  let index = 0
  const run = async () => {
    while (index < middlewares.length) {
      const middleware = middlewares[index++]
      let continued = false
      await middleware(session, () => { continued = true; return run() })
      if (!continued) return
    }
  }
  await run()
}

let failures = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? ' | ' + extra : ''))
  if (!ok) failures++
}

const flatOf = (item) => (Array.isArray(item.content) ? item.content : [item.content])
const typeOf = (el) => (el && el.type ? el.type : typeof el)
const hasVideo = (item) => flatOf(item).some((el) => typeOf(el) === 'video' || JSON.stringify(el).includes('video/mp4'))
const textOf = (item) => flatOf(item).map((el) => (typeof el === 'string' ? el : (el?.attrs?.content ?? ''))).join(' ')

setTimeout(async () => {
  const logs = []
  const originalLog = console.log
  console.log = (...args) => { logs.push(args.map((item) => String(item)).join(' ')) }
  try {
    await dispatch('https://www.douyin.com/video/7123456789012345678')
  } catch (error) {
    logs.push('ERR ' + (error && error.message))
  }
  console.log = originalLog
  const joined = logs.join('\n')

  console.log('=== 本次共发出 ' + sent.length + ' 条消息 ===')
  sent.forEach((item, index) => {
    console.log('[' + index + '] ' + flatOf(item).map((el) => {
      if (typeof el === 'string') return el.slice(0, 120)
      return '[' + typeOf(el) + '] ' + JSON.stringify(el.attrs ?? {}).slice(0, 100)
    }).join(' | ').slice(0, 240))
  })

  const videoIndex = sent.findIndex(hasVideo)
  const failLogIndex = logs.findIndex((line) => line.includes('步骤「渲染作品信息卡」失败'))
  console.log('')
  check('用户资料接口确实抛错了（制造出的失败）', calls.length > 0, calls.join(' / '))
  check('中间步骤失败被记录（不中断）', /步骤「渲染作品信息卡」失败，已跳过/.test(joined),
    (logs.find((l) => l.includes('渲染作品信息卡')) || '（没有对应日志）').slice(0, 140))
  check('视频仍然发出去了（下载在前、卡片失败不连累视频）', videoIndex >= 0,
    videoIndex >= 0 ? '第 ' + videoIndex + ' 条消息是视频' : '（没有视频消息）')
  check('失败发生在视频发送之前（说明是跳过而不是中断）', failLogIndex >= 0 && videoIndex >= 0, '失败日志序号 ' + failLogIndex)
  check('最后统一报错：错误信息里列出了失败的步骤', /解析过程中有 1 个步骤失败（渲染作品信息卡）/.test(joined),
    (logs.find((l) => l.includes('解析过程中有')) || '（没有聚合报错）').slice(0, 160))
  check('报错发生在整个流程跑完之后', (() => {
    const aggIndex = logs.findIndex((l) => l.includes('解析过程中有'))
    return aggIndex > failLogIndex && videoIndex >= 0
  })(), '')

  // ================= B站：同一套约定 =================
  const douyinSent = sent.length
  console.log('')
  console.log('=== B站：解析过程中卡片接口抛错 ===')
  const biliLogs = []
  const originalLog2 = console.log
  console.log = (...args) => { biliLogs.push(args.map((item) => String(item)).join(' ')) }
  try {
    await dispatch('https://www.bilibili.com/video/BV1xx411c7mD')
  } catch (error) {
    biliLogs.push('ERR ' + (error && error.message))
  }
  console.log = originalLog2
  const biliJoined = biliLogs.join('\n')
  const biliSent = sent.slice(douyinSent)
  console.log('=== B站共发出 ' + biliSent.length + ' 条消息 ===')
  biliSent.forEach((item, index) => {
    console.log('[' + index + '] ' + flatOf(item).map((el) => {
      if (typeof el === 'string') return el.slice(0, 120)
      return '[' + typeOf(el) + '] ' + JSON.stringify(el.attrs ?? {}).slice(0, 100)
    }).join(' | ').slice(0, 240))
  })

  const biliVideoIndex = biliSent.findIndex(hasVideo)
  check('B站：UP 名片接口确实抛错了', /fetchUserCard\(抛错\)/.test(calls.join(' ')), calls.join(' / '))
  check('B站：卡片步骤失败被记录（不中断）', /步骤「渲染作品信息卡」失败，已跳过/.test(biliJoined),
    (biliLogs.find((l) => l.includes('渲染作品信息卡')) || '（没有对应日志）').slice(0, 140))
  check('B站：视频仍然发出去了（先下载、卡片失败不连累视频）', biliVideoIndex >= 0,
    biliVideoIndex >= 0 ? '第 ' + biliVideoIndex + ' 条消息是视频' : '（没有视频消息）')
  check('B站：最后统一报错并列出失败步骤', /解析过程中有 1 个步骤失败（渲染作品信息卡）/.test(biliJoined),
    (biliLogs.find((l) => l.includes('解析过程中有')) || '（没有聚合报错）').slice(0, 160))
  /** 下载日志（下载器写的）必须排在卡片步骤之前 —— 这就是「先下载、后渲染」的直接证据 */
  const downloadAt = biliLogs.findIndex((l) => l.includes('开始下载流'))
  const downloadedAt = biliLogs.findIndex((l) => l.includes('文件下载并写入完成'))
  const cardAt = biliLogs.findIndex((l) => l.includes('步骤「渲染作品信息卡」失败'))
  check('B站：下载日志排在卡片步骤之前（先下载、后渲染）',
    downloadAt >= 0 && cardAt >= 0 && downloadAt < cardAt,
    '下载@' + downloadAt + ' 写入完成@' + downloadedAt + ' 卡片失败@' + cardAt)

  console.log('')
  console.log(failures ? '失败 ' + failures + ' 项' : '全部通过')
  process.exit(failures ? 1 : 0)
}, 6000)