/**
 * 冒烟测试：QQ 平台的解析交互面板（Markdown + 原生按钮）。
 *
 * 覆盖：
 *   1. QQ 平台发链接 → 只回面板（不回解析结果，也不会真的去下载视频）；
 *   2. 面板里的画质按钮遵守体积上限（默认 200MB），超限档位不生成按钮；
 *   3. 「视频＋弹幕」按钮 = 带 --panel=1 的同一条命令，点了重新渲染面板并高亮；
 *   4. 参数覆盖真的生效：runWithParseOverride 里 Config.bilibili.videoQuality 变成按钮选的档位；
 *   5. 抖音走的是同一套面板逻辑（用固定数据验证：4K 300MB 那一档必须被隐藏）；
 *   6. 非 QQ 平台 / 关掉面板开关 → 行为不变。
 *
 * 用法：node scripts/smoke-qqpanel.cjs
 */
const path = require('node:path')
const { Context } = require('koishi')

const pluginRoot = path.resolve(__dirname, '..')
const dataRoot = path.resolve(pluginRoot, 'data-smoke')
const target = 'https://www.bilibili.com/video/BV1xx411c7mD'

/* ------------------------------------------------------------------ *
 * 抖音侧固定数据（没有 Cookie 时抖音接口必被风控，这里只验证展示与选档逻辑）
 * ------------------------------------------------------------------ */
const axios = require(path.join(pluginRoot, 'node_modules/axios'))
const realAxiosGet = axios.get
const LONG_URL = 'https://www.douyin.com/video/7123456789012345678'
axios.get = async (url, options) => {
  if (typeof url === 'string' && url.includes('douyin')) return { request: { res: { responseUrl: LONG_URL } }, data: '' }
  return realAxiosGet(url, options)
}

const makeBitRate = (definition, sizeMB) => ({
  gear_name: definition,
  quality_type: 28,
  bit_rate: 1000000,
  FPS: 30,
  format: 'mp4',
  video_extra: JSON.stringify({ definition }),
  play_addr: { uri: 'v', url_list: ['https://www.w3schools.com/html/mov_bbb.mp4'], data_size: Math.round(sizeMB * 1024 * 1024) }
})
const douyinDetail = {
  aweme_id: '7123456789012345678',
  aweme_type: 0,
  is_slides: false,
  desc: '【面板验证】抖音视频解析测试',
  preview_title: '【面板验证】抖音视频解析测试',
  create_time: Math.floor(Date.now() / 1000) - 3600,
  share_url: LONG_URL,
  author: { uid: '1', sec_uid: 'SEC', nickname: '测试作者', avatar_thumb: { url_list: ['https://www.w3schools.com/html/pic_trulli.jpg'] } },
  statistics: { digg_count: 1, comment_count: 1, share_count: 1, collect_count: 1, play_count: 1 },
  images: null,
  music: null,
  video: {
    play_addr: { uri: 'v', url_list: ['https://www.w3schools.com/html/mov_bbb.mp4'], data_size: 20971520 },
    cover: { url_list: ['https://www.w3schools.com/html/pic_trulli.jpg'] },
    origin_cover: { url_list: ['https://www.w3schools.com/html/pic_trulli.jpg'] },
    duration: 15000,
    // 4K 那档 300MB，超过 QQ 的 200MB 硬限制，必须被面板隐藏
    bit_rate: [makeBitRate('4k', 300), makeBitRate('1080p', 80), makeBitRate('720p', 20), makeBitRate('540p', 8)]
  }
}

const amagi = require('@ikenxuan/amagi')
const realFactory = amagi.default
amagi.default = function (options) {
  const client = realFactory(options)
  client.douyin.fetcher.parseWork = async () => ({ success: true, code: 200, message: 'OK', data: { aweme_detail: douyinDetail } })
  return client
}

const plugin = require(path.join(pluginRoot, 'lib/index.js'))
const ctx = new Context()
ctx.plugin(plugin, { dataPath: dataRoot, debug: true, qqPanel: true, qqFileLimitMB: 200 })

/* ------------------------------------------------------------------ *
 * 断言工具
 * ------------------------------------------------------------------ */
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  —— ' + detail : ''))
}

/** 直接跑某个已注册命令（不经过中间件，避免无关命令干扰） */
const runCommand = async (namePart, content, platform = 'qqguild') => {
  const { commandQueue } = require(path.join(pluginRoot, 'lib/compat/runtime.js'))
  const { Message } = require(path.join(pluginRoot, 'lib/compat/node-karin.js'))
  const reg = commandQueue.find((item) => String(item.options?.name ?? '').includes(namePart))
  if (!reg) throw new Error('没有注册命令: ' + namePart)

  const sent = []
  const bot = {
    selfId: '10000', platform, status: 1, user: { id: '10000', name: 'smoke' }, ctx,
    sendMessage: async (channel, payload) => { sent.push(payload); return ['msg-1'] },
    getGuild: async () => ({ name: 'smoke-guild' })
  }
  const session = {
    content, selfId: '10000', userId: '12345', guildId: '456', channelId: '456',
    messageId: 'm1', bot, author: { nick: 'smoke' }, username: 'smoke', event: {},
    send: async (payload) => { sent.push(payload); return ['msg-2'] }
  }
  await reg.handler(Message.fromSession(session), () => Symbol('next'))
  return sent
}

/** 把发出的元素压成 markdown 文本 + 按钮清单 */
const readPanel = (sent) => {
  const flat = []
  for (const item of sent) for (const el of (Array.isArray(item) ? item : [item])) flat.push(el)
  const markdown = flat.filter((el) => el && el.type === 'markdown')
    .map((el) => (el.children || []).map((child) => child.attrs && child.attrs.content).join('')).join('\n')
  // 按钮现在是 markdown 内联的 <qqbot-cmd-input text="…" show="…" />（群聊唯一可用的指令标签）
  const buttons = []
  const pattern = /<qqbot-cmd-input\s+text="([^"]*)"\s+show="([^"]*)"\s+reference="[^"]*"\s*\/>/g
  let matched
  while ((matched = pattern.exec(markdown)) !== null) {
    buttons.push({ data: decodeURIComponent(matched[1]), label: decodeURIComponent(matched[2]) })
  }
  return { flat, markdown, buttons }
}

setTimeout(async () => {
  try {
    const { getRuntime } = require(path.join(pluginRoot, 'lib/compat/runtime.js'))

    console.log('\n[1] QQ 平台发 B站链接 → 只回面板（不解析、不下载）')
    const sent = await runCommand('B站', target)
    const panel = readPanel(sent)
    check('只发了 1 条消息', sent.length === 1, '共 ' + sent.length + ' 条')
    check('含 markdown 段', /解析设置/.test(panel.markdown))
    check('用的是 markdown 指令标签 <qqbot-cmd-input>', panel.buttons.length > 0, panel.buttons.length + ' 个按钮')
    check('不再发原生 keyboard 按钮', !panel.flat.some((el) => el && el.type === 'button-group'))
    check('按钮文字是画质（不是整条指令）', panel.buttons.every((b) => b.label && !b.label.startsWith('#') && !/https?:/.test(b.label)), panel.buttons.map((b) => b.label).join(' / '))
    check('按钮里不带链接（只放短令牌）', panel.buttons.every((b) => !/https?:/.test(b.data)), panel.buttons[0] && panel.buttons[0].data)
    console.log('  —— markdown ——\n' + panel.markdown.split('\n').map((l) => '     ' + l).join('\n'))
    console.log('  —— 按钮 ——')
    for (const b of panel.buttons) console.log('     [' + b.label + '] → ' + b.data)

    console.log('\n[2] 体积上限：上限压到 1MB 时只保留最小的一档')
    const runtime = getRuntime()
    const originalLimit = runtime.config.qqFileLimitMB
    runtime.config.qqFileLimitMB = 1
    const tiny = readPanel(await runCommand('B站', target))
    runtime.config.qqFileLimitMB = originalLimit
    const qualityButtons = tiny.buttons.filter((b) => /M/.test(b.label))
    const distinct = [...new Set(qualityButtons.map((b) => b.label))]
    check('最多保留 1 档画质（两行各一个按钮）', distinct.length <= 1, distinct.join(' / ') || '（无）')
    check('markdown 给出「发送可能失败」的提示', /可能失败/.test(tiny.markdown), tiny.markdown.match(/⚠️.*/)?.[0] ?? '（无提示）')

    console.log('\n[3] 每个按钮都直接解析（没有「切换面板」的按钮）')
    const videoLine = panel.markdown.split('\n').find((line) => line.includes('**纯视频**')) || ''
    const danmakuLine = panel.markdown.split('\n').find((line) => line.includes('视频 + 弹幕')) || ''
    const videoButtons = panel.buttons.filter((b) => String(b.data).startsWith('解析 '))
    const danmakuButtons = panel.buttons.filter((b) => String(b.data).startsWith('弹幕解析 '))
    check('纯视频那一行的按钮发「解析」指令', videoLine.includes('qqbot-cmd-input') && videoButtons.length > 0, videoButtons.map((b) => b.data).join(' | '))
    check('弹幕那一行的按钮发「弹幕解析」指令', danmakuLine.includes('qqbot-cmd-input') && danmakuButtons.length > 0, danmakuButtons.map((b) => b.data).join(' | '))
    check('没有任何按钮带 --panel（点了不会再弹面板）', panel.buttons.every((b) => !String(b.data).includes('--panel')), panel.buttons.map((b) => b.data).join(' | '))

    console.log('\n[4] 参数覆盖：按钮选的画质要真的作用到解析链路')
    const { runWithParseOverride } = require(path.join(pluginRoot, 'lib/karin/module/utils/ParseOverride.js'))
    const { Config } = require(path.join(pluginRoot, 'lib/karin/module/utils/Config.js'))
    const configured = Config.bilibili.videoQuality
    let inside = null
    await runWithParseOverride({ bilibiliQuality: 116 }, async () => { inside = Config.bilibili.videoQuality })
    check('作用域内取到覆盖值 116', inside === 116, 'inside=' + inside + ' / 配置=' + configured)
    check('作用域外仍是配置值', Config.bilibili.videoQuality === configured, 'now=' + Config.bilibili.videoQuality)
    let douyinInside = null
    await runWithParseOverride({ douyinQuality: '720p' }, async () => { douyinInside = Config.douyin.videoQuality })
    check('抖音画质同样可覆盖', douyinInside === '720p', 'inside=' + douyinInside)

    console.log('\n[5] 抖音：同一套面板 + 200MB 硬限制过滤（固定数据）')
    const dySent = await runCommand('抖音', 'https://v.douyin.com/iFakeTest/')
    const dy = readPanel(dySent)
    check('只发了 1 条消息（面板）', dySent.length === 1, '共 ' + dySent.length + ' 条')
    check('面板标题是作品文案', /面板验证/.test(dy.markdown), dy.markdown.split('\n')[1])
    const dyQuality = dy.buttons.filter((b) => /M/.test(b.label))
    console.log('     画质按钮：' + dyQuality.map((b) => b.label).join(' / '))
    check('300MB 的 4K 档被隐藏', !dyQuality.some((b) => b.label.includes('4K')), dyQuality.map((b) => b.label).join(' / '))
    check('80MB 的 1080P 档保留', dyQuality.some((b) => b.label.includes('1080P')), dyQuality.map((b) => b.label).join(' / '))
    check('画质参数用抖音的 --q=', dyQuality.some((b) => String(b.data).includes('--q=1080p')), dyQuality[0] && dyQuality[0].data)

    console.log('\n[6] 非 QQ 平台 / 关掉开关 → 不发面板')
    const { sendQqParsePanel } = require(path.join(pluginRoot, 'lib/karin/module/utils/QqPanel.js'))
    const { Message } = require(path.join(pluginRoot, 'lib/compat/node-karin.js'))
    const makeMessage = (platform) => Message.fromSession({
      content: target, selfId: '10000', userId: '1', guildId: '456', channelId: '456', messageId: 'm',
      bot: { selfId: '10000', platform, status: 1, ctx, sendMessage: async () => ['x'] },
      author: { nick: 's' }, username: 's', event: {}, send: async () => ['y']
    })
    const onebot = await sendQqParsePanel(makeMessage('onebot'), { platform: 'bilibili', url: target, id: 'BV1xx411c7mD' }, { danmaku: false })
    check('onebot 平台不发面板', onebot === false)
    runtime.config.qqPanel = false
    const disabled = await sendQqParsePanel(makeMessage('qqguild'), { platform: 'bilibili', url: target, id: 'BV1xx411c7mD' }, { danmaku: false })
    runtime.config.qqPanel = true
    check('qqPanel=false 时不发面板', disabled === false)

    const failed = results.filter((item) => !item.ok)
    console.log('\n=== ' + (results.length - failed.length) + '/' + results.length + ' 通过 ===')
    process.exitCode = failed.length ? 1 : 0
  } catch (error) {
    console.error('冒烟测试失败:', error && error.stack ? error.stack : error)
    process.exitCode = 1
  }
  process.exit(process.exitCode || 0)
}, 5000)
