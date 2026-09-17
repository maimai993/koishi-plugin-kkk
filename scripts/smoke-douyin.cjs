/**
 * 抖音解析链路冒烟测试：把 amagi 的抖音接口替换成固定数据，
 * 验证「链接识别 → 作品详情 → 清晰度选档 → 下载 → 发送」在 Koishi 侧是否跑得通。
 * 用途：本机没有抖音 Cookie（接口必被风控）时，仍能验证抖音解析这条最长的业务链路。
 *
 * 用法：node scripts/smoke-douyin.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { Context } = require('koishi')

const pluginRoot = path.resolve(__dirname, '..')
const dataRoot = path.resolve(pluginRoot, 'data-smoke-douyin')
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
config.pushlist = { douyin: [], bilibili: [] }
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(config, null, 2))

// 1) 让 getDouyinID 的短链解析不依赖外网（伪造重定向后的长链）
const axios = require(path.join(pluginRoot, 'node_modules/axios'))
const LONG_URL = 'https://www.douyin.com/video/7123456789012345678'
axios.get = async () => ({ request: { res: { responseUrl: LONG_URL } }, data: '' })

// 2) 替换 amagi 的客户端工厂（每个 Base 实例都会新建 client，必须包住工厂）
const amagi = require('@ikenxuan/amagi')
const realFactory = amagi.default

function makeBitRate (definition, width, height) {
  return {
    gear_name: definition,
    quality_type: 28,
    bit_rate: 1000000,
    FPS: 30,
    // 抖音 Web 端与下载都只认 mp4 封装，选档会按 format === 'mp4' 过滤
    format: 'mp4',
    video_extra: JSON.stringify({ definition }),
    play_addr: { uri: 'v', url_list: [VIDEO_URL], data_size: 700000, width, height }
  }
}

function makeDetail () {
  return {
    aweme_id: '7123456789012345678',
    aweme_type: 0,
    is_slides: false,
    desc: '【迁移验证】抖音视频解析测试',
    preview_title: '【迁移验证】抖音视频解析测试',
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
  }
}

amagi.default = function (options) {
  const client = realFactory(options)
  client.douyin.fetcher.parseWork = async () => ({ success: true, code: 200, message: 'OK', data: { aweme_detail: makeDetail() } })
  client.douyin.fetcher.fetchWorkComments = async () => ({ success: true, code: 200, message: 'OK', data: { comments: [], cursor: 0, has_more: 0, total: 0 } })
  client.douyin.fetcher.fetchEmojiList = async () => ({ success: true, code: 200, message: 'OK', data: { emoji_list: [] } })
  client.douyin.fetcher.fetchUserProfile = async () => ({
    success: true, code: 200, message: 'OK',
    data: {
      user: {
        uid: '1234567890',
        sec_uid: 'SEC_UID_TEST',
        nickname: '测试作者',
        unique_id: 'test_author',
        signature: '这里是签名',
        avatar_thumb: { url_list: [COVER_URL] },
        avatar_larger: { url_list: [COVER_URL] },
        follower_count: 12345,
        following_count: 66,
        total_favorited: 7890,
        aweme_count: 42,
        ip_location: '浙江'
      }
    }
  })
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

setTimeout(async () => {
  try {
    console.log('=== 抖音链接解析（固定数据） ===')
    await dispatch('https://www.douyin.com/video/7123456789012345678')
    console.log('\n=== 共发出 ' + sent.length + ' 条消息 ===')
    for (const item of sent) {
      const list = Array.isArray(item.content) ? item.content : [item.content]
      console.log('→ ' + list.map((el) => {
        if (typeof el === 'string') return el.slice(0, 160)
        const type = el && el.type ? el.type : typeof el
        const attrs = el && el.attrs ? JSON.stringify(el.attrs).slice(0, 120) : ''
        return '[' + type + '] ' + attrs
      }).join(' | ').slice(0, 400))
    }
  } catch (error) {
    console.error('抖音冒烟测试失败:', error && error.stack ? error.stack : error)
    process.exitCode = 1
  }
  process.exit(process.exitCode || 0)
}, 5000)
