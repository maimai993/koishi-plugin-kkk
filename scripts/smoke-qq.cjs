/**
 * QQ 平台适配性冒烟测试（不需要真实 QQ，也不需要外网）。
 *
 * 覆盖两个 QQ 场景：
 *   1. **分享卡片解析**：QQ 官方适配器把卡片原始 JSON（URL 里斜杠被转义成 \/）当纯文本塞进 content，
 *      导致各平台链接正则匹配不到。这里验证归一化后能正常触发解析。
 *   2. **合并转发退化**：QQ 官方适配器（platform=qqguild）没有合并转发能力，
 *      sendForwardMsg 必须退化成直接发送内容；OneBot 系仍走 <message> 元素。
 *
 * 用法：node scripts/smoke-qq.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { Context } = require('koishi')

const pluginRoot = path.resolve(__dirname, '..')
const dataRoot = path.resolve(pluginRoot, 'data-smoke-qq')
fs.mkdirSync(path.join(dataRoot, 'koishi-plugin-kkk', 'config'), { recursive: true })

const VIDEO_URL = 'https://www.w3schools.com/html/mov_bbb.mp4'
const COVER_URL = 'https://www.w3schools.com/html/pic_trulli.jpg'
const AWEME_ID = '7123456789012345678'

// 配置：只收视频，避免评论/渲染等分支干扰
const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'config/default_config/config.json'), 'utf8'))
config.app.parseTip = false
config.app.removeCache = true
config.douyin.videoQuality = '720p'
config.douyin.sendContent = ['video']
config.pushlist = { douyin: [], bilibili: [] }
fs.writeFileSync(path.join(dataRoot, 'koishi-plugin-kkk', 'config', 'config.json'), JSON.stringify(config, null, 2))

// 1) 短链解析不走外网
/** 依赖可能在本包 node_modules，也可能被提升到宿主 node_modules，两处都试 */
const resolveDep = (name) => {
  try {
    return require(path.join(pluginRoot, 'node_modules', name))
  } catch {
    return require(name)
  }
}
const axios = resolveDep('axios')
const LONG_URL = 'https://www.douyin.com/video/' + AWEME_ID
axios.get = async () => ({ request: { res: { responseUrl: LONG_URL } }, data: '' })

// 2) 抖音接口用固定数据
const amagi = require('@ikenxuan/amagi')
const realFactory = amagi.default
function bitRate (definition, w, h) {
  return { gear_name: definition, quality_type: 28, bit_rate: 1000000, FPS: 30, format: 'mp4', video_extra: JSON.stringify({ definition }), play_addr: { uri: 'v', url_list: [VIDEO_URL], data_size: 700000, width: w, height: h } }
}
amagi.default = function (options) {
  const client = realFactory(options)
  client.douyin.fetcher.parseWork = async () => ({
    success: true, code: 200, message: 'OK',
    data: { aweme_detail: {
      aweme_id: AWEME_ID, aweme_type: 0, is_slides: false,
      desc: 'QQ 卡片解析测试', preview_title: 'QQ 卡片解析测试',
      create_time: Math.floor(Date.now() / 1000) - 600, share_url: LONG_URL,
      author: { uid: '1', sec_uid: 'SEC', nickname: '测试作者', unique_id: 't', signature: '', avatar_thumb: { url_list: [COVER_URL] }, avatar_larger: { url_list: [COVER_URL] }, follower_count: 1 },
      statistics: { digg_count: 1, comment_count: 2, share_count: 3, collect_count: 4, play_count: 5 },
      images: null, music: null,
      video: { play_addr: { uri: 'v', url_list: [VIDEO_URL], data_size: 700000, width: 1280, height: 720 }, play_addr_h264: { uri: 'v', url_list: [VIDEO_URL], data_size: 700000, width: 1280, height: 720 }, cover: { url_list: [COVER_URL] }, origin_cover: { url_list: [COVER_URL] }, dynamic_cover: { url_list: [COVER_URL] }, duration: 15000, ratio: '720p', bit_rate: [bitRate('720p', 1280, 720)] }
    } }
  })
  client.douyin.fetcher.fetchWorkComments = async () => ({ success: true, code: 200, message: 'OK', data: { comments: [], cursor: 0, has_more: 0, total: 0 } })
  client.douyin.fetcher.fetchEmojiList = async () => ({ success: true, code: 200, message: 'OK', data: { emoji_list: [] } })
  client.douyin.fetcher.fetchUserProfile = async () => ({ success: true, code: 200, message: 'OK', data: { user: { uid: '1', sec_uid: 'SEC', nickname: '测试作者', avatar_thumb: { url_list: [COVER_URL] }, follower_count: 1 } } })
  return client
}

const plugin = require(path.join(pluginRoot, 'lib/index.js'))
const { KkkBot, makeForward } = require(path.join(pluginRoot, 'lib/compat/node-karin.js'))

const sent = []
const makeBot = (platform) => ({
  selfId: '10000', platform, status: 1, user: { id: '10000', name: 'test' },
  sendMessage: async (channel, content) => { sent.push({ platform, channel, content }); return ['msg-1'] },
  getGuild: async () => ({ name: 'g' }), getFriendList: async () => []
})

const qqBot = makeBot('qqguild')
const ctx = new Context()
Object.defineProperty(ctx, 'bots', { get: () => [qqBot] })
const middlewares = []
const originalMiddleware = ctx.middleware.bind(ctx)
ctx.middleware = (fn, ...rest) => { middlewares.push(fn); return originalMiddleware(fn, ...rest) }
// qqPanel 关掉：本用例验证的是「卡片链接识别」和「合并转发退化」，
// 面板会把解析截胡（那是 scripts/smoke-qqpanel.cjs 的用例），这里只要原行为
ctx.plugin(plugin, { dataPath: dataRoot, debug: true, masters: ['12345'], webui: false, qqPanel: false })

const makeSession = (content) => ({
  content, selfId: '10000', userId: '12345', guildId: '456', channelId: '456',
  messageId: 'm1', bot: qqBot, author: { nick: 'smoke' }, username: 'smoke', event: {},
  send: async (c) => { sent.push({ platform: 'qqguild', channel: '456', content: c }); return ['msg-2'] }
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

setTimeout(async () => {
  try {
    // === 1. QQ 分享卡片（URL 斜杠被 JSON 转义） ===
    const card = '{"app":"com.tencent.structmsg","meta":{"detail_1":{"qqdocurl":"https:\\/\\/www.douyin.com\\/video\\/' + AWEME_ID + '"}},"prompt":"[分享] 抖音"}'
    console.log('=== 1) QQ 卡片消息解析 ===')
    console.log('卡片原文: ' + card.slice(0, 100))
    const before = sent.length
    await dispatch(card)
    const produced = sent.slice(before)
    const hasVideo = produced.some((item) => JSON.stringify(item.content).includes('video/mp4'))
    check('卡片里的链接被识别并触发抖音解析', hasVideo, hasVideo ? '发出了视频消息' : '没有任何输出')

    // 对照：把转义还原关掉（模拟旧行为）应当匹配不到，这里只做说明性输出
    const raw = card
    check('原样文本匹配不到链接（说明转义是根因）', !/(https?:\/\/)(www\.)?douyin\.com/.test(raw), '')

    // === 2. 合并转发退化 ===
    console.log('')
    console.log('=== 2) 合并转发 ===')
    const payload = makeForward(['第一段', '第二段'], '10000', '测试Bot')
    sent.length = 0
    await new KkkBot(qqBot).sendForwardMsg('456', payload)
    const qqSent = sent.slice()
    check('QQ（qqguild）退化为直接发送内容', qqSent.length > 0 && !JSON.stringify(qqSent).includes('"message"'),
      '发出 ' + qqSent.length + ' 条，元素类型 ' + qqSent.map((s) => (Array.isArray(s.content) ? s.content.map((e) => e.type || typeof e).join(',') : typeof s.content)).join(' / '))

    const onebotBot = makeBot('onebot')
    sent.length = 0
    await new KkkBot(onebotBot).sendForwardMsg('456', payload)
    const obSent = sent.slice()
    check('OneBot 仍使用合并转发元素', JSON.stringify(obSent).includes('"message"'),
      '元素类型 ' + obSent.map((s) => (Array.isArray(s.content) ? s.content.map((e) => e.type || typeof e).join(',') : typeof s.content)).join(' / '))
  } catch (error) {
    console.error('QQ 冒烟测试失败:', error && error.stack ? error.stack : error)
    failures++
  }
  process.exit(failures ? 1 : 0)
}, 5000)
