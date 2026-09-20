/**
 * 冒烟测试：在线播放器（弹幕在线看）。
 *
 * 覆盖：
 *   1. **默认配置就是开启状态**（不传 playerEnabled 时总开关是开的，有效期默认 60 分钟）；
 *   2. 发布播放会话（真实走 publishOnlinePlayer）：文案、链接、视频文件被搬进播放器目录；
 *      没配公网地址时链接退化成「本机地址 + 端口」而不是报错；
 *   3. 播放页 GET /kkk/player/:token → 200，且页面上有「弹幕开关 / 字号 / 透明度」三个控件；
 *   4. 弹幕接口 → JSON，条数与注册时一致；
 *   5. 视频接口支持 HTTP Range：bytes=0-1023 回 206 + Content-Range；越界回 416；
 *   6. 令牌校验：随机令牌 404、路径穿越 404；
 *   7. 过期清理：把时间推到有效期之后 → 视频文件被删、链接变 404（页面提示「链接已过期」）；
 *   8. 手动删除会话同样会删文件；总开关关掉时不做任何事；
 *   9. 面板文案随开关动态选：默认（播放器开启）写「弹幕」，关掉后写「烧录弹幕」。
 *
 * 用独立端口 15200（不占 Koishi 的 5200），所以「播放器端口」这条链路也一并验证了。
 *
 * 用法：node scripts/smoke-player.cjs
 */
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { Context } = require('koishi')

const pluginRoot = path.resolve(__dirname, '..')
const dataRoot = path.resolve(pluginRoot, 'data-smoke-player')
const PORT = 15200
const BASE_URL = 'https://play.example.com'
const PLAYER_DIR = path.join(dataRoot, 'koishi-plugin-kkk', 'player')

// 干净起步：上次跑剩的播放器目录会让「过期清理」那一步看到的文件数不对
fs.rmSync(dataRoot, { recursive: true, force: true })
fs.mkdirSync(dataRoot, { recursive: true })

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  —— ' + detail : ''))
}

/**
 * 抖音接口打桩。
 *
 * **必须放在 require(plugin) 之前** —— 插件在 import 阶段就把 amagi client 建好了，
 * 之后再替换 amagi.default 已经不生效（section [9] 的面板就是用这份固定数据离线构造的）。
 */
const resolveDep = (name) => {
  try {
    return require(path.join(pluginRoot, 'node_modules', name))
  } catch {
    return require(name)
  }
}
const amagi = resolveDep('@ikenxuan/amagi')
const realFactory = amagi.default
const makeBitRate = (definition, sizeMB) => ({
  gear_name: definition,
  quality_type: 28,
  bit_rate: 1000000,
  FPS: 30,
  format: 'mp4',
  video_extra: JSON.stringify({ definition }),
  play_addr: { uri: 'v', url_list: ['https://www.w3schools.com/html/mov_bbb.mp4'], data_size: Math.round(sizeMB * 1024 * 1024) }
})
amagi.default = function (options) {
  const client = realFactory(options)
  client.douyin.fetcher.parseWork = async () => ({
    success: true,
    code: 200,
    message: 'OK',
    data: {
      aweme_detail: {
        aweme_id: '7123456789012345678',
        aweme_type: 0,
        is_slides: false,
        desc: '【播放器面板验证】',
        preview_title: '【播放器面板验证】',
        create_time: Math.floor(Date.now() / 1000) - 3600,
        share_url: 'https://www.douyin.com/video/7123456789012345678',
        author: { uid: '1', sec_uid: 'SEC', nickname: '测试作者', avatar_thumb: { url_list: ['https://www.w3schools.com/html/pic_trulli.jpg'] } },
        statistics: { digg_count: 1, comment_count: 1, share_count: 1, collect_count: 1, play_count: 1 },
        images: null,
        music: null,
        video: {
          play_addr: { uri: 'v', url_list: ['https://www.w3schools.com/html/mov_bbb.mp4'], data_size: 20971520 },
          cover: { url_list: ['https://www.w3schools.com/html/pic_trulli.jpg'] },
          origin_cover: { url_list: ['https://www.w3schools.com/html/pic_trulli.jpg'] },
          duration: 15000,
          bit_rate: [makeBitRate('1080p', 80), makeBitRate('720p', 20)]
        }
      }
    }
  })
  return client
}

const plugin = require(path.join(pluginRoot, 'lib/index.js'))
const ctx = new Context()
/**
 * 只传端口，其余三项全部走默认值 —— 正好用来验证「在线播放器总开关默认开启」这条要求：
 * 默认开启 + 公网地址为空也必须是能用的组合（链接退化成本机地址，不报错、不拒绝服务）。
 */
ctx.plugin(plugin, {
  dataPath: dataRoot,
  debug: true,
  qq: { playerPort: PORT }
})

/** 发一个请求，拿到状态码 / 响应头 / 正文 */
const request = (urlPath, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method: 'GET', headers }, (res) => {
    const chunks = []
    res.on('data', (chunk) => chunks.push(chunk))
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
  })
  req.on('error', reject)
  req.end()
})

/** 等到条件成立（过期清理是异步删文件，得给它一点时间） */
const waitFor = async (fn, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

/** 造一个「视频」文件：路由只负责按 Range 把字节发出去，内容不重要但要确定性，方便逐字节比对 */
const VIDEO_BYTES = Buffer.alloc(4096)
for (let i = 0; i < VIDEO_BYTES.length; i++) VIDEO_BYTES[i] = i % 251
const work = path.join(dataRoot, 'work')
fs.mkdirSync(work, { recursive: true })
const makeVideo = (name) => {
  const file = path.join(work, name)
  fs.writeFileSync(file, VIDEO_BYTES)
  return file
}

/** 收集回复消息的假事件对象 */
const collector = (sent) => ({ reply: async (content) => { sent.push(String(content)) } })

setTimeout(async () => {
  try {
    const store = require(path.join(pluginRoot, 'lib/player/index.js'))
    const runtime = require(path.join(pluginRoot, 'lib/compat/runtime.js')).getRuntime()
    const { QQ_DEFAULTS } = require(path.join(pluginRoot, 'lib/qqOptions.js'))

    console.log('\n[1] 默认配置：总开关就是开启的')
    check('表单默认值里「在线播放器」是开启', QQ_DEFAULTS.playerEnabled === true, 'default=' + QQ_DEFAULTS.playerEnabled)
    check('不传 playerEnabled 时运行时也是开启', store.isOnlinePlayerEnabled() === true,
      'runtime.config.playerEnabled=' + runtime.config.playerEnabled)
    check('链接有效期默认 60 分钟', store.playerExpireMinutes() === 60, 'expire=' + store.playerExpireMinutes())
    check('播放器端口按配置生效（独立端口 15200）', Number(runtime.config.playerPort) === PORT, 'port=' + runtime.config.playerPort)

    console.log('\n[2] 发布播放会话：文案 + 链接 + 视频落地')
    const danmaku = [
      { progress: 1000, mode: 1, fontsize: 25, color: 16777215, content: '滚动弹幕' },
      { progress: 2000, mode: 5, fontsize: 36, color: 16711680, content: '顶部弹幕' },
      { progress: 3000, mode: 4, fontsize: 18, color: 65280, content: '底部弹幕' },
      { progress: 4000, mode: 1, fontsize: 25, color: 255, content: '第四条' }
    ]
    const sent = []
    const videoPath = makeVideo('tmp_player_smoke.mp4')
    const ok = await store.publishOnlinePlayer(collector(sent), {
      videoPath,
      title: '在线播放冒烟',
      platform: 'bilibili',
      danmaku
    })
    check('publishOnlinePlayer 返回成功', ok === true, 'sent=' + sent.length + ' 条')
    check('先回一句「下载完成，正在准备在线播放…」', /下载完成，正在准备在线播放/.test(sent[0] || ''), sent[0])
    const linkLine = sent[1] || ''
    const matched = /(https?:\/\/[^\s]+\/kkk\/player\/[0-9a-z]+)/.exec(linkLine)
    check('链接正常生成', !!matched, linkLine.split('\n')[0].slice(0, 96))
    const link = matched ? matched[1] : ''
    check('没配公网地址也能用：链接退化成 本机地址:端口', /^http:\/\/[\w.\-]+:15200\/kkk\/player\/[0-9a-z]+$/.test(link), link)
    const token = link.split('/').pop()
    check('令牌是随机串（8~64 位小写字母数字）', /^[0-9a-z]{8,64}$/.test(token), token)
    check('视频文件被搬进播放器目录', !fs.existsSync(videoPath) && fs.existsSync(path.join(PLAYER_DIR, token, 'video.mp4')),
      path.join('player', token, 'video.mp4'))
    check('会话已登记', store.listPlayerSessions().length === 1 && store.getPlayerSession(token) !== undefined)

    console.log('\n[3] 配了公网地址就用配置的地址；手动删除会话会连文件一起删')
    runtime.config.playerBaseUrl = BASE_URL
    const secondSent = []
    const secondOk = await store.publishOnlinePlayer(collector(secondSent), {
      videoPath: makeVideo('tmp_player_second.mp4'),
      title: '第二个会话',
      platform: 'douyin',
      danmaku: []
    })
    runtime.config.playerBaseUrl = ''
    const secondLink = /(https?:\/\/[^\s]+\/kkk\/player\/[0-9a-z]+)/.exec(secondSent[1] || '')
    const secondToken = secondLink ? secondLink[1].split('/').pop() : ''
    check('配了公网地址后链接用配置的地址', secondOk === true && !!secondLink &&
      secondLink[1].startsWith(BASE_URL + '/kkk/player/'), (secondSent[1] || '').split('\n')[0].slice(0, 80))
    const secondFile = path.join(PLAYER_DIR, secondToken, 'video.mp4')
    const removedManual = await store.deletePlayerSession(secondToken)
    check('手动删除会话：索引与文件一起清掉', removedManual === true && !fs.existsSync(secondFile) &&
      store.getPlayerSession(secondToken) === undefined, secondFile)

    console.log('\n[4] 播放页 /kkk/player/:token')
    const page = await request('/kkk/player/' + token)
    const html = page.body.toString('utf-8')
    check('返回 200', page.status === 200, 'status=' + page.status)
    check('是 HTML 页面', /text\/html/.test(String(page.headers['content-type'])), String(page.headers['content-type']))
    check('页面含「弹幕开关」控件', html.includes('弹幕开关'))
    check('页面含「字号」控件', html.includes('字号') && /id="dmSize"/.test(html))
    check('页面含「透明度」控件', html.includes('透明度') && /id="dmOpacity"/.test(html))
    check('页面自带 canvas 弹幕（不依赖外网弹幕库）', html.includes("getContext('2d')") && !/<script[^>]+src=/.test(html),
      '外链脚本数 ' + (html.match(/<script[^>]+src=/g) || []).length)
    check('视频地址按令牌拼成绝对路径', html.includes('/kkk/player/' + token + '/video'))

    console.log('\n[5] 弹幕接口')
    const dm = await request('/kkk/player/' + token + '/danmaku')
    let parsed = null
    try { parsed = JSON.parse(dm.body.toString('utf-8')) } catch { /* 下面会报错 */ }
    check('返回 200 + JSON', dm.status === 200 && !!parsed, 'status=' + dm.status)
    check('弹幕条数正确（4 条）', !!parsed && parsed.total === 4 && parsed.items.length === 4,
      parsed ? 'total=' + parsed.total : '解析失败')
    check('弹幕字段归一正确', !!parsed && parsed.items[0].text === '滚动弹幕' && parsed.items[0].time === 1000 &&
      parsed.items[1].mode === 5 && parsed.items[2].mode === 4 && parsed.items[2].size === 18,
      parsed ? JSON.stringify(parsed.items.map((item) => [item.time, item.mode, item.size, item.text])) : '')

    console.log('\n[6] 视频接口 + HTTP Range')
    const full = await request('/kkk/player/' + token + '/video')
    check('不带 Range 时返回 200 + video/mp4', full.status === 200 && String(full.headers['content-type']) === 'video/mp4',
      'status=' + full.status + ' type=' + full.headers['content-type'])
    check('声明支持 Range', full.headers['accept-ranges'] === 'bytes', String(full.headers['accept-ranges']))
    check('整段内容长度正确', Number(full.headers['content-length']) === 4096 && full.body.length === 4096,
      'content-length=' + full.headers['content-length'])

    const part = await request('/kkk/player/' + token + '/video', { Range: 'bytes=0-1023' })
    check('Range: bytes=0-1023 → 206', part.status === 206, 'status=' + part.status)
    check('Content-Range 正确', String(part.headers['content-range']) === 'bytes 0-1023/4096', String(part.headers['content-range']))
    check('只回 1024 字节且内容一致', part.body.length === 1024 && part.body.equals(VIDEO_BYTES.subarray(0, 1024)),
      'length=' + part.body.length)
    check('Content-Length 跟着 Range 走', Number(part.headers['content-length']) === 1024, String(part.headers['content-length']))

    const tail = await request('/kkk/player/' + token + '/video', { Range: 'bytes=4000-' })
    check('Range: bytes=4000- → 206 + 最后 96 字节', tail.status === 206 &&
      String(tail.headers['content-range']) === 'bytes 4000-4095/4096' && tail.body.length === 96,
      'status=' + tail.status + ' range=' + tail.headers['content-range'] + ' len=' + tail.body.length)

    const bad = await request('/kkk/player/' + token + '/video', { Range: 'bytes=99999-' })
    check('越界的 Range → 416', bad.status === 416, 'status=' + bad.status + ' range=' + bad.headers['content-range'])

    console.log('\n[7] 令牌校验 / 路径穿越')
    const unknown = await request('/kkk/player/abcdefgh12345678')
    check('不存在的令牌 → 404', unknown.status === 404, 'status=' + unknown.status)
    const travel = await request('/kkk/player/..%2f..%2fpackage.json')
    check('路径穿越尝试 → 404', travel.status === 404, 'status=' + travel.status)
    const badToken = await request('/kkk/player/ABC!!!')
    check('非法令牌（大写 + 符号）→ 404', badToken.status === 404, 'status=' + badToken.status)

    console.log('\n[8] 过期清理：文件被删、链接 404')
    const sessionFile = path.join(PLAYER_DIR, token, 'video.mp4')
    // 直接把「现在」推到有效期之后，等价于链接放了两小时
    const removed = await store.sweepExpiredPlayers(Date.now() + 2 * 60 * 60 * 1000)
    check('过期清理删掉了 1 个会话', removed === 1, 'removed=' + removed)
    check('视频文件被删除', await waitFor(() => !fs.existsSync(sessionFile)), sessionFile)
    check('会话目录被清空', await waitFor(() => !fs.existsSync(path.join(PLAYER_DIR, token))))
    const expiredPage = await request('/kkk/player/' + token)
    check('过期后的链接 → 404', expiredPage.status === 404, 'status=' + expiredPage.status)
    check('404 页面提示「链接已过期」', expiredPage.body.toString('utf-8').includes('链接已过期'))
    const expiredVideo = await request('/kkk/player/' + token + '/video')
    check('过期后的视频接口 → 404', expiredVideo.status === 404, 'status=' + expiredVideo.status)

    console.log('\n[9] 面板文案随开关动态选')
    const { sendQqParsePanel } = require(path.join(pluginRoot, 'lib/karin/module/utils/QqPanel.js'))
    const { Message } = require(path.join(pluginRoot, 'lib/compat/node-karin.js'))
    /** 面板会先发「加载中…」再原地替换，所以这里收到的可能是多条（和 smoke-qqpanel 一样的写法） */
    const collect = async () => {
      const sentList = []
      const message = Message.fromSession({
        content: 'https://www.douyin.com/video/7123456789012345678',
        selfId: '10000', userId: '1', guildId: '456', channelId: '456', messageId: 'm',
        bot: { selfId: '10000', platform: 'qqguild', status: 1, ctx, sendMessage: async (channel, payload) => { sentList.push(payload); return ['m-1'] } },
        author: { nick: 's' }, username: 's', event: {},
        send: async (payload) => { sentList.push(payload); return ['m-2'] }
      })
      await sendQqParsePanel(message, {
        platform: 'douyin',
        url: 'https://www.douyin.com/video/7123456789012345678',
        id: '7123456789012345678'
      })
      const flat = []
      for (const item of sentList) for (const el of (Array.isArray(item) ? item : [item])) flat.push(el)
      const markdown = flat.filter((el) => el && el.type === 'markdown')
        .map((el) => (el.children || []).map((child) => child.attrs && child.attrs.content).join('')).join('\n')
      const buttons = []
      const pattern = /<qqbot-cmd-input\s+text="([^"]*)"\s+show="([^"]*)"\s+reference="[^"]*"\s*\/>/g
      let hit
      while ((hit = pattern.exec(markdown)) !== null) {
        buttons.push({ data: decodeURIComponent(hit[1]), label: decodeURIComponent(hit[2]) })
      }
      return { markdown, buttons }
    }
    const savedEnabled = runtime.config.playerEnabled
    const savedPanelDanmaku = runtime.config.qqPanelDanmaku
    const savedForce = runtime.config.forceNoDanmaku

    // 默认状态（播放器开启，不显式设置）→ 列头写「弹幕」
    runtime.config.qqPanelDanmaku = true
    const playerPanel = await collect()
    // 显式关掉播放器 + 允许烧录 → 列头写「烧录弹幕」
    runtime.config.playerEnabled = false
    runtime.config.forceNoDanmaku = false
    const burnPanel = await collect()

    // 顺带验证：总开关关掉时「什么都不做」（不注册、不回复、也不动视频文件）
    const closedSent = []
    const closedVideo = makeFileForClosedCase()
    const closedOk = await store.publishOnlinePlayer(collector(closedSent), {
      videoPath: closedVideo,
      title: '关掉开关',
      platform: 'bilibili',
      danmaku: []
    })
    check('总开关关闭时 publishOnlinePlayer 直接返回 false（不注册、不回复、不动文件）',
      closedOk === false && closedSent.length === 0 && fs.existsSync(closedVideo), 'sent=' + closedSent.length)

    runtime.config.playerEnabled = savedEnabled
    runtime.config.qqPanelDanmaku = savedPanelDanmaku
    runtime.config.forceNoDanmaku = savedForce

    const headerOf = (panel) => panel.markdown.split('\n').find((line) => line.startsWith('| 清晰度')) || '（没有表格）'
    const burnButtons = (panel) => panel.buttons.filter((button) => String(button.data).includes('--dm=1'))
    check('默认（播放器开启）表头是「清晰度 | 弹幕 | 大小」', headerOf(playerPanel) === '| 清晰度 | 弹幕 | 大小 |', headerOf(playerPanel))
    check('默认（播放器开启）按钮文字是「弹幕」', burnButtons(playerPanel).length > 0 &&
      burnButtons(playerPanel).every((button) => button.label === '弹幕'),
      burnButtons(playerPanel).map((button) => button.label).join(' / ') || '（没有按钮）')
    check('关掉播放器后表头回到「清晰度 | 烧录弹幕 | 大小」', headerOf(burnPanel) === '| 清晰度 | 烧录弹幕 | 大小 |', headerOf(burnPanel))
    check('关掉播放器后按钮文字是「烧录弹幕」', burnButtons(burnPanel).length > 0 &&
      burnButtons(burnPanel).every((button) => button.label === '烧录弹幕'),
      burnButtons(burnPanel).map((button) => button.label).join(' / ') || '（没有按钮）')
    check('两种模式的按钮都还是走 --dm=1（内部参数不变）',
      burnButtons(playerPanel).every((button) => /--dm=1/.test(button.data)) &&
      burnButtons(burnPanel).every((button) => /--dm=1/.test(button.data)),
      burnButtons(playerPanel)[0] && burnButtons(playerPanel)[0].data)

    const failed = results.filter((item) => !item.ok)
    console.log('\n=== ' + (results.length - failed.length) + '/' + results.length + ' 通过 ===')
    process.exitCode = failed.length ? 1 : 0
  } catch (error) {
    console.error('冒烟测试失败:', error && error.stack ? error.stack : error)
    process.exitCode = 1
  }
  process.exit(process.exitCode || 0)
}, 5000)

/** 第 [9] 节用的小工具：造一个临时视频文件（开关关掉时不该被搬走） */
function makeFileForClosedCase () {
  return makeVideo('tmp_player_closed.mp4')
}
