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
 *   9. 面板文案随开关动态选：默认（播放器开启）写「弹幕」，关掉后写「烧录弹幕」；
 *  10. 「在线播放最大文件」留空跟随全局、超限拒绝且文件不动；「超限转在线播放」的判定与覆盖项标记；
 *  11. 端到端：视频超过全局上限 + 开着转播开关 → 真的被转到在线播放（B站链路，视频源是本机小服务）；
 *  12. 弹幕设置：任意百分比（字号 / 透明度）、颜色解析与「彩色弹幕」开关、三类弹幕开关与位置
 *      （顶部贴顶 / 底部贴底 / 滚动自上而下）、默认值（显示区域 1/4 · 透明度 50 · 字号小）与全屏拦截。
 *  13. 面板「在线看」：列与按钮（`--play=1`）、超过 QQ 档位上限（200MB）的画质档照样出现、
 *      「在线播放最大文件」上限对它的约束、以及「面板显示「在线看」按钮」开关；
 *  14. 端到端「在线看」：视频不发到 QQ、弹幕功能关着也带弹幕；
 *  15. 播放页下载按钮 + `?download=1` / `/download` 的 Content-Disposition 与文件名清洗。
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

/**
 * 上游那份 config.json（全局「文件大小限制」等）。
 *
 * 上游 `Config` / `Common.tempDri` 用的是 `node-karin/root` 里的模块级常量 `karinPathBase`：
 * 运行时已绑定时等于 `dataPath`，没绑定时退化成 `<当前工作目录>/data`。
 * 本脚本用的是后者之外的正常路径 —— 也就是自己的 `data-smoke-player` 目录，
 * 所以这里先把配置写进去（Config 发现文件不存在时会拷一份打包默认值，会盖住测试要的数值）。
 */
const upstreamCfgDir = path.join(dataRoot, 'koishi-plugin-kkk', 'config')
fs.mkdirSync(upstreamCfgDir, { recursive: true })
const upstreamConfig = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'config/default_config/config.json'), 'utf8'))
upstreamConfig.app.parseTip = false
upstreamConfig.app.removeCache = true
// 全局上限压到 1MB：下面第 [11] 节那条 5MB 的视频必然「超限」
upstreamConfig.app.usefilelimit = true
upstreamConfig.app.filelimit = 1
upstreamConfig.bilibili.sendContent = ['video']
upstreamConfig.bilibili.videoQuality = 32
upstreamConfig.douyin.sendContent = ['info', 'video']
upstreamConfig.douyin.switch = true
upstreamConfig.pushlist = { douyin: [], bilibili: [] }
fs.writeFileSync(path.join(upstreamCfgDir, 'config.json'), JSON.stringify(upstreamConfig, null, 2))

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
/**
 * 本机「视频源」：第 [11] 节的下载直接从本机拿，不依赖任何外网
 * （其它冒烟脚本是去 w3schools 下测试片，这里为了稳定改成自建小服务）。
 */
const VIDEO_SOURCE_PORT = 15201
const VIDEO_SOURCE_URL = 'http://127.0.0.1:' + VIDEO_SOURCE_PORT + '/video.mp4'
const VIDEO_SOURCE_BYTES = Buffer.alloc(4096)
for (let i = 0; i < VIDEO_SOURCE_BYTES.length; i++) VIDEO_SOURCE_BYTES[i] = i % 251
const VIDEO_SOURCE_SIZE_MB = 5
/** 一张 8x8 透明 PNG：给 B站 stub 当封面（同源取的，不依赖外网） */
const COVER_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=',
  'base64')
const videoSourceServer = http.createServer((req, res) => {
  // 封面也从这个本机服务取（播放页那边会把它下到会话目录，走同源地址）
  if (String(req.url ?? '').includes('cover')) {
    const coverHeaders = { 'Content-Type': 'image/png', 'Content-Length': String(COVER_BYTES.length) }
    res.writeHead(200, coverHeaders)
    if (String(req.method).toUpperCase() === 'HEAD') { res.end(); return }
    res.end(COVER_BYTES)
    return
  }
  const headers = { 'Content-Type': 'video/mp4', 'Content-Length': String(VIDEO_SOURCE_BYTES.length) }
  if (String(req.method).toUpperCase() === 'HEAD') {
    res.writeHead(200, headers)
    res.end()
    return
  }
  res.writeHead(200, headers)
  res.end(VIDEO_SOURCE_BYTES)
})
videoSourceServer.listen(VIDEO_SOURCE_PORT)

/**
 * B站 info 接口的固定数据（第 [11] 节用）。
 *
 * 两个 bvid：插件对「短时间内重复的同一作品请求」会去重（日志里那句「已忽略」），
 * 第 [11] / [11b] 节要连跑两次解析，第二次必须换个 ID 才不会被去重吃掉。
 */
const BILI_BVID = 'BV1xx411c7mD'
const BILI_BVID_ALT = 'BV1yy411c7mE'
const biliInfoFixture = {
  aid: 12345,
  bvid: 'BV1xx411c7mD',
  cid: 67890,
  title: '【超限转播验证】B站视频',
  desc: '这里是简介',
  desc_v2: [],
  pic: 'http://127.0.0.1:' + VIDEO_SOURCE_PORT + '/cover.png',
  ctime: Math.floor(Date.now() / 1000) - 3600,
  duration: 1172,
  pages: [{ cid: 67890, duration: 1172 }],
  owner: { mid: 1, name: '测试UP主', face: '' },
  // 统计数字给大一点，顺便验证「528.1万」这种B站口径的缩写
  stat: { view: 5281000, danmaku: 4097, reply: 35000, like: 418000, coin: 146000, share: 145000, favorite: 223000 }
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
/**
 * 抖音的档位列表**可替换**：默认两档（都在 QQ 的 200MB 上限之内），
 * 第 [9d] 节会临时插一个 300MB 的 4K 档，验证「超过 200MB 的档位在线播放模式下也要出现」。
 */
let douyinBitRates = [makeBitRate('1080p', 80), makeBitRate('720p', 20)]
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
          bit_rate: douyinBitRates
        }
      }
    }
  })
  /**
   * B站那条链路（第 [11] 节「超限转在线播放」）用的接口。
   * 免登录分支不会走 amagi 取流，真正决定「解析到的体积」的是下面第 [11] 节里
   * 对 `Networks.getData` 的打桩（html5 直链接口），这里只把 info 接口固定住。
   */
  client.bilibili.fetcher.fetchVideoInfo = async () => ({ code: 0, message: 'OK', data: { code: 0, data: biliInfoFixture } })
  client.bilibili.fetcher.fetchVideoStreamUrl = async () => ({
    code: 0,
    message: 'OK',
    data: { code: 0, data: { accept_description: ['360P'], accept_quality: [16], durl: [{ order: 1, length: 15000, size: 5 * 1024 * 1024, url: VIDEO_SOURCE_URL }] } }
  })
  client.bilibili.fetcher.fetchVideoDanmaku = async () => ({
    code: 0,
    message: 'OK',
    data: { data: { elems: [{ progress: 800, mode: 1, fontsize: 25, color: 16777215, content: '超限转播弹幕' }] } }
  })
  client.bilibili.fetcher.fetchComments = async () => ({ code: 0, message: 'OK', data: { replies: [], cursor: {} } })
  client.bilibili.fetcher.fetchUserCard = async () => ({ code: 0, message: 'OK', data: { code: 0, data: { card: { mid: 1, name: '测试UP' } } } })
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

/**
 * 等插件把在线播放器初始化完（存储 + 路由）再开跑。
 *
 * 原来是写死 setTimeout 5 秒 —— 机器一忙（比如宿主 koishi 同时在跑）插件还没初始化完，
 * 就会出现「[在线播放] 存储尚未初始化」和 15200 端口连不上这种假失败。
 * playerStoreDir() 在 setupPlayerStore 之前是空串，正好当就绪信号用。
 */
const waitForPlayerReady = async (store, timeoutMs = 90000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (store.playerStoreDir()) return true
    } catch { /* 还没准备好 */ }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

setTimeout(async () => {
  try {
    const store = require(path.join(pluginRoot, 'lib/player/index.js'))
    const runtime = require(path.join(pluginRoot, 'lib/compat/runtime.js')).getRuntime()
    const ready = await waitForPlayerReady(store)
    console.log('  在线播放器就绪: ' + ready + '（存储目录 ' + (store.playerStoreDir() || '（空）') + '）')
    const { QQ_DEFAULTS } = require(path.join(pluginRoot, 'lib/qqOptions.js'))

    console.log('\n[1] 默认配置：总开关就是开启的')
    check('表单默认值里「在线播放器」是开启', QQ_DEFAULTS.playerEnabled === true, 'default=' + QQ_DEFAULTS.playerEnabled)
    check('不传 playerEnabled 时运行时也是开启', store.isOnlinePlayerEnabled() === true,
      'runtime.config.playerEnabled=' + runtime.config.playerEnabled)
    check('链接有效期默认 60 分钟', store.playerExpireMinutes() === 60, 'expire=' + store.playerExpireMinutes())
    // 用户要求：新增「面板显示「在线看」按钮」，**默认开启**（他要的就是这个按钮）
    check('「面板显示「在线看」按钮」默认开启', QQ_DEFAULTS.playerWatchButton === true, 'default=' + QQ_DEFAULTS.playerWatchButton)
    check('播放器端口按配置生效（独立端口 15200）', Number(runtime.config.playerPort) === PORT, 'port=' + runtime.config.playerPort)

    console.log('\n[2] 发布播放会话：文案 + 链接 + 视频落地')
    const danmaku = [
      { progress: 1000, mode: 1, fontsize: 25, color: 16777215, content: '滚动弹幕' },
      { progress: 2000, mode: 5, fontsize: 36, color: 16711680, content: '顶部弹幕' },
      { progress: 3000, mode: 4, fontsize: 18, color: 65280, content: '底部弹幕' },
      { progress: 4000, mode: 1, fontsize: 25, color: 255, content: '第四条' },
      // 黑色（0）最容易被「假值判断」吃成白色，特意留一条
      { progress: 5000, mode: 4, fontsize: 25, color: 0, content: '黑色弹幕' }
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
    // 用户要求：留空时回复里要说清楚「未配置公网地址，仅本机可访问」
    check('没配公网地址时回复里带一句「未配置公网地址，仅本机可访问」',
      /未配置公网地址，仅本机可访问/.test(linkLine), linkLine.split('\n').slice(-1)[0])
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
    /**
     * 用户要求：播放页照 **B站播放页**（夜间模式）的 UI 做，而且**必须零外网依赖**
     * （不引 CDN、不引第三方库、图标一律内联 SVG、封面走同源）。
     */
    check('弹幕开关 + 「弹幕设置」按钮',
      /id="dmOn"/.test(html) && html.includes('弹幕设置') && !/id="dmOn"[^>]*type="range"/.test(html),
      '开关是样式化的 switch（.sw-track/.sw-thumb）')
    check('自己的 H5 播放器：没有用浏览器原生 controls',
      !/<video[^>]*\scontrols/.test(html) && /id="ctrl"/.test(html) && /id="playBtn"/.test(html) &&
      /id="prog"/.test(html) && /id="progBuf"/.test(html) && /id="timeLabel"/.test(html) &&
      /id="muteBtn"/.test(html) && /id="fullscreenBtn"/.test(html),
      '播放 / 暂停 · 时间 · 进度条（带缓冲）· 静音 · 弹幕设置 · 全屏')
    check('进度条可拖可点可键盘微调',
      html.includes("prog.addEventListener('pointerdown'") && html.includes('seekToRate') &&
      html.includes("prog.addEventListener('keydown'"))
    check('点画面中间能播放 / 暂停（大播放按钮）',
      /id="bigPlay"/.test(html) && html.includes("video.addEventListener('click', togglePlay)") &&
      /bigplay/.test(html))
    check('弹幕设置面板默认收起（点一下才展开）',
      /id="dmPanel"[^>]*hidden/.test(html) && html.includes("getElementById('dmPanel')") &&
      html.includes("settingsPanel.hidden = !open"))
    // 用户要求：设置要放进播放器里（全屏时跟着一起进去）
    check('控制条和设置面板都在播放器容器里面',
      html.indexOf('id="videoWrap"') > -1 && html.indexOf('id="dmPanel"') > html.indexOf('id="videoWrap"') &&
      html.indexOf('id="dmPanel"') < html.indexOf('class="foot"'),
      '面板浮在画面上，不是视频下面单独一块')
    check('三类控件齐备：字号 / 透明度 / 显示区域',
      /id="dmSize"/.test(html) && html.includes('字号') &&
      /id="dmOpacity"/.test(html) && html.includes('透明度') &&
      /id="dmArea"/.test(html) && html.includes('显示区域'))
    check('B站那片标题区 + 数据行', html.includes('class="title"') && html.includes('class="stats"') &&
      /class="stat /.test(html), '标题 + 统计行（图标 + 浅灰字）')
    // 这条会话没有作品信息：**绝不编数据** —— 不显示操作按钮排，也不显示假播放量
    check('没有作品信息时不编造数据（不出现操作按钮 / 假统计）',
      !html.includes('class="actions"') && !html.includes('播放量'))
    check('图标是内联 SVG（没有 emoji 图标）',
      html.includes('<svg viewBox="0 0 24 24"') &&
      !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html))
    {
      // 零外网依赖：页面里不能有任何 http(s) 外链资源
      const externals = html.match(/https?:\/\/[^"'\s)]+/g) || []
      check('零外网依赖（HTML 里没有任何 http/https 外链）', externals.length === 0,
        externals.length ? externals.slice(0, 3).join(' ') : '一共 0 条')
      check('弹幕仍是 canvas 自绘', html.includes("getContext('2d')") && html.includes('strokeText'))
    }
    {
      // 内联脚本有一万多字符，语法错了整页就白屏 —— 直接拿 node 解析一遍
      const matched = /<script>([\s\S]*?)<\/script>/.exec(html)
      const scriptFile = path.join(dataRoot, 'inline-player-script.js')
      let syntaxOk = false
      if (matched) {
        fs.writeFileSync(scriptFile, matched[1])
        try {
          /**
           * `stdio: 'ignore'` 而不是 'pipe'：受限环境（沙箱）里**管道是禁的**，
           * `stdio: 'pipe'` 会直接 EPERM，把一条好脚本误判成语法错误；
           * 这里只需要退出码，不需要子进程输出。
           */
          require('node:child_process').execFileSync(process.execPath, ['--check', scriptFile], { stdio: 'ignore' })
          syntaxOk = true
        } catch (error) {
          console.log('     ' + String(error?.stderr ?? error?.message ?? error).slice(0, 200))
        }
      }
      check('内联脚本语法正确（node --check）', syntaxOk, matched ? matched[1].length + ' 字符' : '（没找到内联脚本）')
    }
    check('视频地址按令牌拼成绝对路径', html.includes('/kkk/player/' + token + '/video'))
    check('播放页上也带「未配置公网地址，仅本机可访问」', html.includes('未配置公网地址，仅本机可访问'),
      (html.match(/<div class="warnlocal">[\s\S]{0,70}/) || ['（没有提示条）'])[0])

    console.log('\n[4c] 弹幕设置：任意百分比 / 颜色 / 位置 / 全屏')
    {
      /**
       * 用户要求：「弹幕设置可以自由调整百分比并且可以解析颜色还有位置」。
       * 页面脚本里 KKK-DANMAKU-PURE 那段是纯计算（类型判定 / 颜色 / 轨道位置 / 尺寸比例），
       * 抠出来在 Node 里直接断言，不用起浏览器。
       */
      const pureBlock = /\* KKK-DANMAKU-PURE-START \*\/([\s\S]*?)\/\* KKK-DANMAKU-PURE-END \*\//.exec(html)
      let PURE = null
      try {
        PURE = pureBlock ? new Function(pureBlock[1] + '\n return KKK_DANMAKU_PURE')() : null
      } catch (error) {
        console.log('     ' + String(error?.message ?? error).slice(0, 200))
      }
      check('能抠出纯计算段（KKK-DANMAKU-PURE）', !!PURE && typeof PURE.classify === 'function')
      if (PURE) {
        // 类型：B站 1/2/3 滚动、4 底部、5 顶部
        check('mode 1/2/3 → 滚动，4 → 底部，5 → 顶部',
          PURE.classify(1) === 'scroll' && PURE.classify(2) === 'scroll' && PURE.classify(3) === 'scroll' &&
          PURE.classify(4) === 'bottom' && PURE.classify(5) === 'top',
          [1, 2, 3, 4, 5].map((m) => m + ':' + PURE.classify(m)).join(' '))
        // 颜色：十进制 RGB → #rrggbb，黑 0 不能丢
        check('颜色解析：十进制 RGB → #rrggbb（含黑 0 / 白 / 纯色）',
          PURE.colorOf(16777215, true) === '#ffffff' && PURE.colorOf(16711680, true) === '#ff0000' &&
          PURE.colorOf(255, true) === '#0000ff' && PURE.colorOf(0, true) === '#000000',
          [0, 255, 16711680, 16777215].map((c) => PURE.colorOf(c, true)).join(' '))
        check('关掉彩色弹幕 → 一律白字', PURE.colorOf(16711680, false) === '#ffffff' && PURE.colorOf(0, false) === '#ffffff')
        check('描边按底色明暗选（深色配白描边）',
          PURE.isDark(0) === true && PURE.isDark(16777215) === false,
          '黑=' + PURE.isDark(0) + ' 白=' + PURE.isDark(16777215))
        check('三类弹幕各自可关',
          PURE.visible(5, { top: false }) === false && PURE.visible(5, { bottom: false }) === true &&
          PURE.visible(1, null) === true)
        // 位置：顶部贴顶、底部贴底、滚动自上而下
        const H = 400
        const LH = 40
        const N = 10
        check('位置：顶部贴顶 / 底部贴底 / 滚动自上而下',
          PURE.laneY(5, 0, H, LH, N) === 0 && PURE.laneY(4, 0, H, LH, N) === H - LH &&
          PURE.laneY(4, 1, H, LH, N) === H - 2 * LH && PURE.laneY(1, 2, H, LH, N) === 2 * LH,
          'top0=' + PURE.laneY(5, 0, H, LH, N) + ' bottom0=' + PURE.laneY(4, 0, H, LH, N) +
          ' scroll2=' + PURE.laneY(1, 2, H, LH, N))
        check('轨道越界也不会画到画面外',
          PURE.laneY(5, 99, H, LH, N) === (N - 1) * LH && PURE.laneY(4, 99, H, LH, N) === H - N * LH)
        // 字号：任意百分比 → 缩放系数（夹在 0.5~2）
        check('字号百分比换算：小 75% / 中 100% / 大 135% / 越界夹紧',
          PURE.sizeScaleOf(75) === 0.75 && PURE.sizeScaleOf(100) === 1 && PURE.sizeScaleOf(135) === 1.35 &&
          PURE.sizeScaleOf(500) === 2 && PURE.sizeScaleOf(1) === 0.5 && PURE.sizeScaleOf('abc') === 1)
        // 透明度：0~100 任意整数
        check('百分比输入夹紧（任意整数，含小数 / 非数字 / 越界）',
          PURE.clampInt('50', 0, 100, 100) === 50 && PURE.clampInt(37.6, 0, 100, 100) === 38 &&
          PURE.clampInt('120', 0, 100, 100) === 100 && PURE.clampInt('-5', 0, 100, 100) === 0 &&
          PURE.clampInt('abc', 0, 100, 100) === 100)
      }
      // 面板控件：两个百分比数字框 + 三档区域 + 三类开关 + 彩色开关
      check('透明度是「滑块 + 任意百分比数字框」',
        /type="range" id="dmOpacity"/.test(html) &&
        /<input type="number" id="dmOpacityValue"[^>]*min="0"[^>]*max="100"/.test(html),
        '滑块 + 0~100 数字框，双向同步')
      check('字号是「档位 + 任意百分比数字框」',
        /<input type="number" id="dmSizeValue"[^>]*min="50"[^>]*max="200"/.test(html) &&
        html.includes('data-value="small"') && html.includes('data-value="medium"') && html.includes('data-value="large"'))
      check('显示区域三档：1/4 · 半屏 · 全屏',
        html.includes('data-value="quarter"') && html.includes('data-value="half"') &&
        html.includes('data-value="full"') && html.includes('AREA_RATE'))
      check('弹幕类型三开关（滚动 / 顶部 / 底部）',
        /id="dmType"/.test(html) && html.includes('data-type="scroll"') && html.includes('data-type="top"') &&
        html.includes('data-type="bottom"') && html.includes('aria-pressed'))
      check('彩色弹幕开关默认打开', /<input type="checkbox" id="dmColored" checked>/.test(html))
      check('默认值：显示区域 1/4 · 透明度 50 · 字号 小 75%',
        /var areaRate = 0\.25/.test(html) && /var opacityPercent = 50/.test(html) &&
        /var sizePercent = 75/.test(html) &&
        /class="segbtn active" data-value="quarter"/.test(html) &&
        /id="dmOpacity" min="0" max="100" step="1" value="50"/.test(html) &&
        /id="dmOpacityValue"[^>]*value="50"/.test(html) &&
        /id="dmSizeValue"[^>]*value="75"/.test(html))
      // 全屏：浏览器自带 controls 的全屏按钮只能让 video 元素自己全屏，
      // 弹幕 canvas / 控制条都是它的兄弟节点 → 改成整个 .video-wrap 全屏，大家一起进去
      check('全屏按钮全屏的是整个播放器容器（弹幕和控制条一起进去）',
        /id="fullscreenBtn"/.test(html) &&
        /if \(fullscreenBtn\) fullscreenBtn\.addEventListener\('click', toggleFullscreen\)/.test(html) &&
        html.includes('wrapEl.requestFullscreen') && html.includes('.video-wrap:fullscreen'))
      // 曾经在 fullscreenchange 里「先退出、再请求容器全屏」：用户手势只能授权一次全屏，
      // 第二次请求会被浏览器拒掉 —— 结果就是「全屏闪一下就退出来」（用户实测反馈）
      check('全屏不会「先退出再请求」（那会让全屏直接失败）',
        !/exitFullscreen\(\)\s*\.then/.test(html),
        '进全屏只请求一次，退出走 exitFullscreen')
      check('全屏前后重新量一次画布尺寸', /window\.setTimeout\(fitCanvas, 60\)/.test(html))
    }

    console.log('\n[4b] 作品信息（B站那套：标题 / UP 主 / 播放量 / 封面 / 操作按钮排）')
    {
      // 一张 8x8 的透明 PNG 当封面（不依赖外网，也不依赖 ffmpeg）
      const coverFile = path.join(dataRoot, 'cover-src.png')
      fs.writeFileSync(coverFile, Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=',
        'base64'))
      const workSent = []
      const workOk = await store.publishOnlinePlayer(collector(workSent), {
        videoPath: makeVideo('tmp_player_work.mp4'),
        title: '【独家】《凡人修仙传之慕兰之战》第16集',
        platform: 'bilibili',
        danmaku: [
          { progress: 1000, mode: 1, fontsize: 25, color: 16777215, content: '第一条' },
          { progress: 2000, mode: 5, fontsize: 36, color: 16711680, content: '顶部' }
        ],
        work: {
          author: '哔哩哔哩番剧',
          coverUrl: undefined,
          views: 5281000,
          platformDanmaku: 4097,
          likes: 418000,
          coins: 146000,
          favorites: 223000,
          shares: 145000,
          comments: 35000,
          publishedAt: Date.now() - 3 * 86400000,
          durationSeconds: 1172
        },
        coverPath: coverFile
      })
      const workLink = /(https?:\/\/[^\s]+\/kkk\/player\/[0-9a-z]+)/.exec(workSent[1] || '')
      const workToken = workLink ? workLink[1].split('/').pop() : ''
      const workSession = workToken ? store.getPlayerSession(workToken) : undefined
      check('带作品信息的会话登记成功', workOk === true && !!workSession &&
        workSession.author === '哔哩哔哩番剧' && workSession.views === 5281000 && workSession.cover === 'cover.png',
        workSession ? JSON.stringify({ author: workSession.author, views: workSession.views, cover: workSession.cover }) : '（没有会话）')
      const workPage = await request('/kkk/player/' + workToken)
      const workHtml = workPage.body.toString('utf-8')
      check('页面显示标题 / UP 主 / 统计（按B站口径缩写）',
        workHtml.includes('凡人修仙传') && workHtml.includes('哔哩哔哩番剧') &&
        workHtml.includes('528.1万') && workHtml.includes('4097') && workHtml.includes('19:32'),
        '标题 + UP 主 + 播放量 528.1万 + 时长 19:32')
      check('页面显示操作按钮排（只用真实数据）',
        workHtml.includes('class="actions"') && /点赞 41.8万/.test(workHtml) &&
        /投币 14.6万/.test(workHtml) && /收藏 22.3万/.test(workHtml) && /分享 14.5万/.test(workHtml))
      check('封面走同源地址（不引外链）',
        workHtml.includes('/kkk/player/' + workToken + '/cover') &&
        !/https?:\/\//.test(workHtml.match(/<img[^>]+>/)?.[0] ?? 'https://x'))
      const coverRes = await request('/kkk/player/' + workToken + '/cover')
      check('封面接口能取到图', coverRes.status === 200 && /image\/png/.test(String(coverRes.headers['content-type'])) &&
        coverRes.body.length > 0, 'status=' + coverRes.status + ' ' + coverRes.headers['content-type'])
      if (workToken) await store.deletePlayerSession(workToken)
    }

    console.log('\n[5] 弹幕接口')
    const dm = await request('/kkk/player/' + token + '/danmaku')
    let parsed = null
    try { parsed = JSON.parse(dm.body.toString('utf-8')) } catch { /* 下面会报错 */ }
    check('返回 200 + JSON', dm.status === 200 && !!parsed, 'status=' + dm.status)
    check('弹幕条数正确（5 条）', !!parsed && parsed.total === 5 && parsed.items.length === 5,
      parsed ? 'total=' + parsed.total : '解析失败')
    check('弹幕字段归一正确', !!parsed && parsed.items[0].text === '滚动弹幕' && parsed.items[0].time === 1000 &&
      parsed.items[1].mode === 5 && parsed.items[2].mode === 4 && parsed.items[2].size === 18,
      parsed ? JSON.stringify(parsed.items.map((item) => [item.time, item.mode, item.size, item.text])) : '')
    // 播放页要按弹幕自带的颜色渲染，所以服务端这条链路必须把十进制 RGB 原样带过来（黑色 0 也不能丢）
    check('弹幕自带颜色原样保留（黑 0 / 白 16777215 / 红 16711680）',
      !!parsed && parsed.items[0].color === 16777215 && parsed.items[1].color === 16711680 &&
      parsed.items[2].color === 65280 && parsed.items[4].color === 0,
      parsed ? parsed.items.map((item) => item.color).join(' ') : '')

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
    /**
     * 过期页也要有「直接跳转 / 手动复制」两个按钮（用户要求）：用户多是点聊天记录里的旧链接进来的，
     * 这时能直接复制这条链接去别处重试、或换浏览器打开。
     */
    const expiredHtml = expiredPage.body.toString('utf-8')
    check('过期页有「直接跳转」与「手动复制」两个按钮',
      /id="pageLinkJump"/.test(expiredHtml) && /id="pageLinkCopy"/.test(expiredHtml) &&
      expiredHtml.includes('直接跳转') && expiredHtml.includes('手动复制'),
      (expiredHtml.match(/<div class="linkrow">[\s\S]{0,180}/) || ['（没有链接行）'])[0].replace(/\s+/g, ' ').slice(0, 160))
    check('过期页的按钮用剪贴板 + 降级方案（不依赖外网脚本）',
      expiredHtml.includes('navigator.clipboard') && expiredHtml.includes('execCommand') &&
      !/https?:\/\/[^"']*\.js/.test(expiredHtml))
    const expiredVideo = await request('/kkk/player/' + token + '/video')
    check('过期后的视频接口 → 404', expiredVideo.status === 404, 'status=' + expiredVideo.status)

    console.log('\n[9] 面板文案随开关动态选')
    const { sendQqParsePanel } = require(path.join(pluginRoot, 'lib/karin/module/utils/QqPanel.js'))
    const { Message } = require(path.join(pluginRoot, 'lib/compat/node-karin.js'))
    /** 面板会先发「加载中…」再原地替换，所以这里收到的可能是多条（和 smoke-qqpanel 一样的写法） */
    /**
     * 造一次面板。
     * @param id 作品 id：面板信息有 5 分钟缓存（同一 id 复用），换了 id 才会重新取接口 ——
     *   第 [9d] 节要临时换档位，必须用新 id 才能看到新数据
     */
    const collect = async (id = '7123456789012345678') => {
      const sentList = []
      const message = Message.fromSession({
        content: 'https://www.douyin.com/video/' + id,
        selfId: '10000', userId: '1', guildId: '456', channelId: '456', messageId: 'm',
        bot: { selfId: '10000', platform: 'qqguild', status: 1, ctx, sendMessage: async (channel, payload) => { sentList.push(payload); return ['m-1'] } },
        author: { nick: 's' }, username: 's', event: {},
        send: async (payload) => { sentList.push(payload); return ['m-2'] }
      })
      await sendQqParsePanel(message, {
        platform: 'douyin',
        url: 'https://www.douyin.com/video/' + id,
        id
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

    /**
     * 用户实测反馈：打开了「弹幕重定向在线播放器」，面板里却没有「弹幕」按钮 ——
     * 因为这一列当时还被 QQ 适配器里的「面板显示「烧录弹幕」列」（默认关）管着。
     * 现在在线播放模式下这一列只跟播放器开关走，所以下面**故意不设置 qqPanelDanmaku**。
     */
    runtime.config.qqPanelDanmaku = savedPanelDanmaku
    /**
     * 本文件的全局「文件大小限制」被压到 1MB（上面写进上游配置的），
     * 而面板里的画质动辄几十 MB —— 不放开「在线播放最大文件」的话，
     * 每一档都会按新规则标成「超上限」（见下面的 [9c]），这一节就看不到「弹幕」按钮了。
     */
    const savedMaxForPanel = runtime.config.playerMaxFileMB
    runtime.config.playerMaxFileMB = 2048
    const playerPanel = await collect()
    // 显式关掉播放器 + 允许烧录 → 列头写「烧录弹幕」（这时才轮到 qqPanelDanmaku 决定）
    runtime.config.playerEnabled = false
    runtime.config.forceNoDanmaku = false
    runtime.config.qqPanelDanmaku = true
    // 「在线看」按钮开关也要关掉：它开着时烧录模式会多一列「在线看」（下一节单独验证那一列）
    runtime.config.playerWatchButton = false
    const burnPanel = await collect()
    /**
     * 只开「在线看」按钮（弹幕重定向关着、烧录列也关着）→ 面板上单独一列「在线看」。
     * 这是「播放器设置里的总开关只有打开才显示在线看按钮」那条需求的落点。
     */
    runtime.config.qqPanelDanmaku = false
    runtime.config.playerWatchButton = true
    const watchPanel = await collect()
    // 关掉播放器、关掉在线看按钮、也不开「面板显示烧录弹幕列」→ 回到两列（老行为）
    runtime.config.playerWatchButton = false
    const burnPanelOff = await collect()

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
    /** 「在线看」按钮：命令里带 --play=1（独立标志，不拿 --dm=1 冒充） */
    const watchButtons = (panel) => panel.buttons.filter((button) => String(button.data).includes('--play=1'))
    // 用户要求：播放器开着时「弹幕」和「在线看」是同一个动作 → 合并成一个按钮，不再并排两个
    check('播放器开着：合并成一列「弹幕」',
      headerOf(playerPanel) === '| 清晰度 | 弹幕 | 大小 |', headerOf(playerPanel))
    check('合并后没有单独的「在线看」按钮', watchButtons(playerPanel).length === 0,
      watchButtons(playerPanel).map((button) => button.data).join(' | ') || '（没有）')
    check('只开「在线看」按钮时单独一列「在线看」，参数是 --play=1（没拿 --dm=1 冒充）',
      headerOf(watchPanel) === '| 清晰度 | 在线看 | 大小 |' && watchButtons(watchPanel).length > 0 &&
      watchButtons(watchPanel).every((button) =>
        button.label === '在线看' && /--play=1/.test(button.data) && !/--dm=1/.test(button.data)),
      headerOf(watchPanel) + ' ｜ ' + watchButtons(watchPanel).map((button) => button.data).join(' | '))
    check('关掉播放器 + 关掉在线看按钮 + 不开烧录列开关 → 回到两列',
      headerOf(burnPanelOff) === '| 清晰度 | 大小 |', headerOf(burnPanelOff))
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

    console.log('\n[9c] 面板：超过「在线播放最大文件」的档位不给「弹幕」按钮，直接标「超上限」')
    /**
     * 用户实测要求：某档预估体积超过「在线播放最大文件」时，点「弹幕」也只会退回原来的发送流程，
     * 不如别给按钮（markdown 按钮没有 disabled 状态，不给才是真的点不了）。
     */
    runtime.config.playerEnabled = savedEnabled
    runtime.config.playerMaxFileMB = 1
    const limitedPanel = await collect()
    runtime.config.playerMaxFileMB = savedMaxForPanel
    const limitedButtons = burnButtons(limitedPanel)
    check('超上限的档位不再提供「弹幕」按钮', limitedButtons.length === 0,
      limitedButtons.map((button) => button.label).join(' / ') || '（一个都没有，符合预期）')
    check('超上限的档位在表格里标成「超上限」', /\| 超上限 \|/.test(limitedPanel.markdown),
      (limitedPanel.markdown.split('\n').find((line) => line.includes('超上限')) || '（没有标注）').slice(0, 90))
    check('面板上说清楚为什么（并指出点「清晰度」仍可发送）',
      /在线播放的体积上限/.test(limitedPanel.markdown) && /原来的方式发送/.test(limitedPanel.markdown),
      (limitedPanel.markdown.match(/标「超上限」[^\n]*/) || ['（没有说明）'])[0].slice(0, 110))
    check('放开上限后「弹幕」按钮回来了', burnButtons(playerPanel).length > 0,
      burnButtons(playerPanel).length + ' 个')

    console.log('\n[9d] 超过 QQ 档位上限（200MB）的画质档：在线播放模式下必须出现，并且能「在线看」')
    /**
     * 用户实测反馈：「还是没有出现画质超过 200mb 的按钮」。
     * 在线播放的视频**根本不发到 QQ**，所以 qqFileLimitMB（= QQ 能发多大）不该再把档位藏掉：
     * 超限的档位照样列出来，只是「清晰度」（发到 QQ）那一格标「超上限」，右边的「在线看」可用。
     */
    const savedRates = douyinBitRates
    const savedQqLimit = runtime.config.qqFileLimitMB
    const savedMaxFile = runtime.config.playerMaxFileMB
    const savedWatch = runtime.config.playerWatchButton
    douyinBitRates = [makeBitRate('4k', 300), makeBitRate('1080p', 80), makeBitRate('720p', 20)]
    runtime.config.playerEnabled = true
    runtime.config.playerWatchButton = true
    runtime.config.qqFileLimitMB = 200
    runtime.config.playerMaxFileMB = 2048
    // 换一个 id：面板信息是按 id 缓存的，用同一个 id 会拿到上面那次的旧档位
    const bigPanel = await collect('7123456789012345901')
    const row4k = bigPanel.markdown.split('\n').find((line) => line.includes('4K')) || ''
    check('面板里出现了 300MB 的 4K 档（不再被 QQ 的 200MB 上限藏掉）', /4K/.test(row4k) && /300M/.test(row4k), row4k || '（没有这一行）')
    check('4K 那一行的「清晰度」（= 发到 QQ）标成「超上限」、不给按钮',
      /超上限/.test(row4k) && !bigPanel.buttons.some((button) => String(button.label).indexOf('4K') === 0),
      bigPanel.buttons.map((button) => button.label).join(' / ') || '（没有按钮）')
    check('4K 那一行仍然有可用的合并按钮（--dm=1 + --q=4k；播放器模式下它就是在线播放）',
      bigPanel.buttons.some((button) => button.label === '弹幕' && /--dm=1/.test(button.data) && /--q=4k/.test(button.data)),
      bigPanel.buttons.map((button) => button.data).join(' | ') || '（没有按钮）')
    check('上限之内的档位照常能发到 QQ（1080P / 720P 还是按钮）',
      bigPanel.buttons.some((button) => button.label.indexOf('1080P') === 0) &&
      bigPanel.buttons.some((button) => button.label.indexOf('720P') === 0))
    check('面板上说清楚「超上限的画质发不到 QQ」', /QQ 的档位上限/.test(bigPanel.markdown),
      (bigPanel.markdown.match(/标「超上限」[^\n]*/) || ['（没有说明）'])[0].slice(0, 120))
    /**
     * 文案里的按钮名必须跟着**实际列名**：合并模式下没有「在线看」列，
     * 再写「点右边的「在线看」」用户在面板上根本找不到那个按钮（用户实测指出）。
     */
    check('合并模式下提示指向「弹幕」而不是不存在的「在线看」',
      /同一行的「弹幕」/.test(bigPanel.markdown) && !/「在线看」/.test(bigPanel.markdown),
      (bigPanel.markdown.match(/标「超上限」[^\n]*/) || ['（没有说明）'])[0].slice(0, 140))
    // 播放器上限压到 100MB：4K 那一档连「在线看」也不给（它受「在线播放最大文件」约束）
    runtime.config.playerMaxFileMB = 100
    const smallWatchPanel = await collect('7123456789012345902')
    check('「在线播放最大文件」约束：4K 档连「弹幕」（= 在线播放）也不给按钮',
      !smallWatchPanel.buttons.some((button) => /--q=4k/.test(button.data)) &&
      /在线播放的体积上限/.test(smallWatchPanel.markdown),
      (smallWatchPanel.markdown.split('\n').find((line) => line.includes('4K')) || '').slice(0, 100))
    check('上限之内的 720P 档依然能在线播放（合并按钮还在）',
      smallWatchPanel.buttons.some((button) => button.label === '弹幕' && /--q=720p/.test(button.data)),
      smallWatchPanel.buttons.map((button) => button.data).join(' | '))
    runtime.config.qqFileLimitMB = savedQqLimit
    runtime.config.playerMaxFileMB = savedMaxFile
    runtime.config.playerWatchButton = savedWatch
    douyinBitRates = savedRates

    console.log('\n[9e] 新开关「面板显示「在线看」按钮」：关掉就不出现那一列')
    runtime.config.playerEnabled = true
    runtime.config.playerMaxFileMB = 2048
    runtime.config.playerWatchButton = false
    const watchOffPanel = await collect()
    runtime.config.playerWatchButton = true
    runtime.config.playerMaxFileMB = savedMaxForPanel
    check('关掉后回到「清晰度 | 弹幕 | 大小」三列', headerOf(watchOffPanel) === '| 清晰度 | 弹幕 | 大小 |', headerOf(watchOffPanel))
    check('关掉后没有任何 --play=1 按钮（也没有「在线看」字样）',
      watchButtons(watchOffPanel).length === 0 && !/在线看/.test(watchOffPanel.markdown))

    console.log('\n[9b] 播放器端口：浏览器禁止访问的要能识别出来')
    // 用户实测：端口配成 6666 之后，链接在浏览器里直接 ERR_UNSAFE_PORT（服务端其实是好的）
    check('6666 / 6665-6669 这批 IRC 段端口判为不安全',
      store.isUnsafePlayerPort(6666) === true && store.isUnsafePlayerPort(6665) === true &&
      store.isUnsafePlayerPort(6669) === true && store.isUnsafePlayerPort(8888) === false,
      '6666=' + store.isUnsafePlayerPort(6666) + ' 8888=' + store.isUnsafePlayerPort(8888))
    check('常规端口（5140 / 8080 / 15200 / 65535）都判为安全',
      [5140, 8080, 15200, 65535].every((port) => store.isUnsafePlayerPort(port) === false))
    check('不安全端口列表用的是浏览器那份黑名单（含 1 / 22 / 5060 / 10080）',
      [1, 22, 5060, 10080].every((port) => store.isUnsafePlayerPort(port) === true))
    // 退回 Koishi 端口时，端口号要取「真实监听的端口」（这台部署是 server 插件作用域里的 5200，
    // 只读 ctx.config.port 会拿到默认值 5140，链接就指错了）
    const savedServer = ctx.server
    const savedPort = runtime.config.playerPort
    const savedBase = runtime.config.playerBaseUrl
    ctx.server = { port: 12345 }
    runtime.config.playerPort = 0
    runtime.config.playerBaseUrl = ''
    const fallbackLink = store.buildPlayerLink('abcdefgh1234')
    check('退回 Koishi 端口时用的是 ctx.server.port（真实监听端口）',
      fallbackLink.includes(':12345/kkk/player/abcdefgh1234'), fallbackLink)
    ctx.server = savedServer
    runtime.config.playerPort = savedPort
    runtime.config.playerBaseUrl = savedBase

    console.log('\n[10] 在线播放最大文件：留空跟随全局，超限就不走在线播放')
    const { QQ_FIELDS } = require(path.join(pluginRoot, 'lib/qqOptions.js'))
    const playerFields = QQ_FIELDS.filter((field) => field.key.startsWith('player'))
    /**
     * 用户实测反馈的 bug：这一组原来**全都被**绑到「强制不烧录弹幕」上，
     * 而且判断还写反了（关掉强制不烧录反而变灰）。现在只有总开关联动，其余字段随时可改。
     */
    const gated = playerFields.filter((field) => field.editableWhen === 'danmaku')
    check('只有「在线播放器总开关」这一个字段和「强制不烧录弹幕」联动',
      playerFields.length === 7 && gated.length === 1 && gated[0].key === 'playerEnabled',
      playerFields.map((field) => field.key + ':' + (field.editableWhen || '-')).join(' | '))
    /**
     * 用户要求：这一组要有自己的**总开关** —— playerEnabled 就是它，标题写清总开关语义，
     * 它关掉时组内其它字段（面板显示在线看 / 公网地址 / 端口 / 有效期 / 最大文件 / 超限转播）全部变灰。
     */
    check('组内第一个字段就是「在线播放器总开关」（总开关语义的标题）',
      playerFields[0]?.key === 'playerEnabled' && playerFields[0]?.label === '在线播放器总开关',
      playerFields.map((field) => field.label).join(' / '))
    check('总开关自己的说明写清了「关掉这一组其它设置都会变灰」',
      /总开关/.test(playerFields.find((field) => field.key === 'playerEnabled')?.description ?? '') &&
      /变灰/.test(playerFields.find((field) => field.key === 'playerEnabled')?.description ?? ''),
      (playerFields.find((field) => field.key === 'playerEnabled')?.description ?? '').slice(0, 90))
    check('新增「面板显示「在线看」按钮」（默认开、不参与联动、说明写清了两个开关的关系）',
      (() => {
        const field = playerFields.find((item) => item.key === 'playerWatchButton')
        return !!field && field.default === true && field.type === 'boolean' &&
          field.section === '在线播放器设置' && field.editableWhen === undefined &&
          /在线看/.test(field.description) && /在线播放器总开关/.test(field.description)
      })(),
      JSON.stringify(playerFields.find((item) => item.key === 'playerWatchButton') || {}).slice(0, 160))
    // WebUI 面板里的门控是 patch-webui 生成到前端包里的，这里直接检查产物：
    // 方向必须是「开着强制不烧录弹幕时锁住」（===!0），写反了就会复现用户报的那个 bug
    const webAssetsDir = path.join(pluginRoot, 'assets', 'web', 'assets')
    const bundleName = fs.readdirSync(webAssetsDir).find((name) => /^index-.*\.js$/.test(name))
    const bundleText = bundleName ? fs.readFileSync(path.join(webAssetsDir, bundleName), 'utf-8') : ''
    const BT = '`'
    const lockedMarker = 'Q(e,[' + BT + 'qq' + BT + ',' + BT + 'forceNoDanmaku' + BT + '],!0)===!0'
    const openMarker = 'Q(e,[' + BT + 'qq' + BT + ',' + BT + 'forceNoDanmaku' + BT + '],!0)===!1'
    check('WebUI 里「强制不烧录弹幕」开着时该开关是锁住的（方向正确）',
      !!bundleText && bundleText.split(lockedMarker).length - 1 === 1 && !bundleText.includes(openMarker),
      '锁住表达式 ' + (bundleText.split(lockedMarker).length - 1) + ' 处 / 反向 ' + (bundleText.split(openMarker).length - 1) + ' 处')
    check('其余在线播放字段没有被「强制不烧录弹幕」灰掉（那套锁只作用在总开关上）',
      !!bundleText && bundleText.split('disabled:' + lockedMarker).length - 1 === 0,
      '（文本框/数字框都不带那条锁）')
    /**
     * 用户要求：这一组要有自己的总开关，关掉时组内其它字段全部变灰。
     * 门控表达式是 patch-webui 生成到前端包里的，这里直接数产物里的出现次数。
     */
    const playerOffMarker = 'Q(e,[' + BT + 'qq' + BT + ',' + BT + 'playerEnabled' + BT + '],!0)===!1'
    /**
     * 组内字段数：**7 个**（开关 2 个 + 文本框 5 个）。
     * 2026-09 加了「强制在线播放的适配器」（文本框，也在这一组里）之后，
     * 这里从 6/4 变成 7/5 —— 断言跟着更新，别把新增的合法字段当成漏门控。
     */
    check('WebUI 里「在线播放器总开关」关掉时组内 7 个字段全部变灰（开关 2 个 + 输入框 5 个）',
      !!bundleText && bundleText.split(playerOffMarker).length - 1 === 7,
      '门控表达式 ' + (bundleText.split(playerOffMarker).length - 1) + ' 处')
    check('其中文本框/数字框用的是 options.disabled（5 个）',
      !!bundleText && bundleText.split('disabled:' + playerOffMarker).length - 1 === 5,
      'disabled: 形式 ' + (bundleText.split('disabled:' + playerOffMarker).length - 1) + ' 处')
    check('总开关自己不带这条门控（它只受「强制不烧录弹幕」锁）',
      !!bundleText && bundleText.split(BT + 'playerEnabled' + BT + '],!0)===!1,').length - 1 === 0)
    /**
     * 样式修复的回归守卫：「在线播放器设置」必须是「交互设置」的**兄弟**分组。
     * 以前它被注入到「交互设置」的 children 里，于是被渲染成卡片内的 grid 子卡片，
     * 外框内缩、字段挤成两列（用户反馈「和其它分组样式不一致」）。
     */
    const appEndAt = bundleText.indexOf('/*KKK-APP-END*/')
    const sectAt = bundleText.indexOf('/*KKK-SECTION-START*/')
    check('「在线播放器设置」插在「交互设置」之后（是兄弟分组，不再嵌在它里面）',
      appEndAt > 0 && sectAt > appEndAt && /\]\}\)\)/.test(bundleText.slice(appEndAt, sectAt)),
      JSON.stringify(bundleText.slice(appEndAt, sectAt)).slice(0, 80))
    check('「在线播放最大文件」默认 0 = 跟随全局', QQ_DEFAULTS.playerMaxFileMB === 0,
      'default=' + QQ_DEFAULTS.playerMaxFileMB)
    check('「面板显示「在线看」按钮」默认 true（用户要的就是这个按钮）', QQ_DEFAULTS.playerWatchButton === true,
      'default=' + QQ_DEFAULTS.playerWatchButton)
    check('「超限转在线播放」默认关', QQ_DEFAULTS.playerOnOversize === false,
      'default=' + QQ_DEFAULTS.playerOnOversize)

    const savedMax = runtime.config.playerMaxFileMB
    runtime.config.playerMaxFileMB = 0
    check('留空时跟随全局（全局没开限制就是不限制）',
      store.effectivePlayerSizeLimitMB(200) === 200 && store.effectivePlayerSizeLimitMB(0) === 0,
      'effective(200)=' + store.effectivePlayerSizeLimitMB(200) + ' effective(0)=' + store.effectivePlayerSizeLimitMB(0))
    runtime.config.playerMaxFileMB = 50
    check('填了就用自己填的值（优先于全局）', store.effectivePlayerSizeLimitMB(200) === 50,
      'effective(200)=' + store.effectivePlayerSizeLimitMB(200))
    runtime.config.playerMaxFileMB = 0
    const globalLimit = await store.globalFileLimitMB()
    check('能读到全局的「文件大小限制」', Number.isFinite(globalLimit) && globalLimit >= 0,
      '全局 ' + globalLimit + 'MB，在线播放实际生效 ' + (await store.resolvePlayerSizeLimitMB()) + 'MB')

    // 把上限压到 1KB（视频是 4096 字节）→ 必须拒绝在线播放并把文件留在原地
    runtime.config.playerMaxFileMB = 0.001
    const overSent = []
    const overVideo = makeVideo('tmp_player_over.mp4')
    const overOk = await store.publishOnlinePlayer(collector(overSent), {
      videoPath: overVideo,
      title: '超限验证',
      platform: 'bilibili',
      danmaku: []
    })
    check('超过上限时不登记会话，并回一句说明', overOk === false && overSent.length === 1 &&
      /超过在线播放的体积上限/.test(overSent[0]), overSent[0] || '（没有回复）')
    check('超限时视频文件原地不动（调用方退回原来的发送流程）',
      fs.existsSync(overVideo) && store.listPlayerSessions().length === 0,
      'sessions=' + store.listPlayerSessions().length)
    runtime.config.playerMaxFileMB = savedMax

    console.log('\n[10b] 超限转在线播放开关：判定与覆盖项标记')
    const savedOnOversize = runtime.config.playerOnOversize
    const savedEnabledFlag = runtime.config.playerEnabled
    runtime.config.playerOnOversize = false
    check('开关关着时不转播（维持原来的「太大了」）', store.shouldRedirectOversizeToPlayer() === false)
    runtime.config.playerOnOversize = true
    check('开关打开 + 播放器可用时才转播', store.shouldRedirectOversizeToPlayer() === true)
    runtime.config.playerEnabled = false
    check('播放器总开关关掉后即使开了转播也不生效', store.shouldRedirectOversizeToPlayer() === false)
    runtime.config.playerEnabled = savedEnabledFlag
    runtime.config.playerOnOversize = true
    runtime.config.playerMaxFileMB = 0
    /**
     * 用户实测要求：以前开了转播、留空就按「不限制」处理，
     * 结果几十 GB 的视频会被原样搬进播放器目录、把机器磁盘塞满。
     * 现在改成「转播也不能突破这条上限」。
     */
    check('开了转播也不会突破上限：留空依旧跟随全局（不再按不限制处理）',
      store.effectivePlayerSizeLimitMB(200) === 200, 'effective=' + store.effectivePlayerSizeLimitMB(200))
    runtime.config.playerMaxFileMB = 50
    check('显式填了上限时仍然以上限为准', store.effectivePlayerSizeLimitMB(200) === 50)
    runtime.config.playerMaxFileMB = 0
    check('withinPlayerSizeLimit：上限 0 = 不限制', store.withinPlayerSizeLimit(99999, 0) === true)
    check('withinPlayerSizeLimit：超过上限 false，正好等于上限算通过',
      store.withinPlayerSizeLimit(50, 50) === true && store.withinPlayerSizeLimit(50.1, 50) === false)

    /**
     * 磁盘保护：判定必须发生在「把文件搬进播放器目录」之前 ——
     * 超限的视频连搬都不会搬，播放器目录一个条目都不该多。
     * （这里同时把「超限转在线播放」打开：转播也吃这条上限。）
     */
    const dirsBeforeDisk = fs.existsSync(PLAYER_DIR) ? fs.readdirSync(PLAYER_DIR).length : 0
    runtime.config.playerMaxFileMB = 0.001
    runtime.config.playerOnOversize = true
    const diskSent = []
    const diskVideo = makeVideo('tmp_player_disk.mp4')
    const diskOk = await store.publishOnlinePlayer(collector(diskSent), {
      videoPath: diskVideo,
      title: '磁盘保护验证',
      platform: 'bilibili',
      danmaku: []
    })
    const dirsAfterDisk = fs.existsSync(PLAYER_DIR) ? fs.readdirSync(PLAYER_DIR).length : 0
    check('超限时判定早于搬文件（播放器目录一个条目都没多、源文件还在原处）',
      diskOk === false && dirsAfterDisk === dirsBeforeDisk && fs.existsSync(diskVideo) &&
      /超过在线播放的体积上限/.test(diskSent[0] || ''),
      '目录 ' + dirsBeforeDisk + ' -> ' + dirsAfterDisk + ' / ' + (diskSent[0] || '（没有回复）').slice(0, 70))
    runtime.config.playerMaxFileMB = 0
    // markOnlinePlayerOverride 的链路：下载那一步标记之后，handler 这边就该按在线播放处理
    const { runWithParseOverride } = require(path.join(pluginRoot, 'lib/karin/module/utils/ParseOverride.js'))
    // 注意：runWithParseOverride 传**空对象**会直接执行（不进 ALS 作用域），这里给个真实键
    const insideFlags = await runWithParseOverride({ fromPanel: false }, async () => {
      const before = store.isOnlinePlayerRequest()
      store.markOnlinePlayerOverride()
      return { before, after: store.isOnlinePlayerRequest() }
    })
    check('markOnlinePlayerOverride 能把本次解析改成在线播放',
      insideFlags.before === false && insideFlags.after === true, JSON.stringify(insideFlags))
    check('标记只作用于本次解析（作用域外不受影响）', store.isOnlinePlayerRequest() === false)
    runtime.config.playerOnOversize = savedOnOversize

    console.log('\n[11] 端到端：超过全局上限的视频真的被转到在线播放（B站链路）')
    const { Networks } = require(path.join(pluginRoot, 'lib/karin/module/utils/Network/index.js'))
    /**
     * 免登录分支的体积和直链都来自 html5 直链接口，这里把它打桩到**本机**视频源：
     * 声明 5MB（超过第 [10] 节写进配置的 1MB 全局上限），实际下载的是本机那 4KB 小文件 —— 整段不碰外网。
     */
    Networks.prototype.getData = async () => ({
      data: {
        durl: [{ order: 1, length: 15000, size: VIDEO_SOURCE_SIZE_MB * 1024 * 1024, url: VIDEO_SOURCE_URL }],
        quality: 16,
        accept_description: ['360P']
      }
    })
    Networks.prototype.getHeaders = async () => ({
      'content-length': String(VIDEO_SOURCE_BYTES.length),
      'content-type': 'video/mp4'
    })
    const { commandQueue } = require(path.join(pluginRoot, 'lib/compat/runtime.js'))
    const { Message: CompatMessage } = require(path.join(pluginRoot, 'lib/compat/node-karin.js'))
    const biliReg = commandQueue.find((item) => String(item.options?.name ?? '').includes('B站'))
    check('B站解析命令已注册', !!biliReg, biliReg ? String(biliReg.options?.name) : '（没找到）')

    /**
     * 跑一次完整的B站解析，把用户实际收到的内容拼成一段文本（bvid 换一个，避免被去重）。
     * @param extra 追加到消息后面的参数（例如「 --play=1」= 面板上的「在线看」）
     */
    const runBiliParse = async (bvid = BILI_BVID, extra = '') => {
      biliInfoFixture.bvid = bvid
      const sent = []
      const bot = {
        selfId: '10000', platform: 'qqguild', status: 1, user: { id: '10000', name: 'smoke' }, ctx,
        sendMessage: async (channel, payload) => { sent.push(payload); return ['msg-1'] },
        getGuild: async () => ({ name: 'smoke-guild' })
      }
      const session = {
        content: 'https://www.bilibili.com/video/' + bvid + extra,
        selfId: '10000', userId: '12345', guildId: '456', channelId: '456', messageId: 'm1',
        bot, author: { nick: 'smoke' }, username: 'smoke', event: {},
        send: async (payload) => { sent.push(payload); return ['msg-2'] }
      }
      try {
        await biliReg.handler(CompatMessage.fromSession(session), () => Symbol('next'))
      } catch (error) {
        // 渲染类步骤在没装 puppeteer 的机器上会失败，流程最后按约定聚合成一个错误抛出；
        // 这里只记一笔，判断仍然基于用户实际收到的消息。
        console.log('     （解析流程最后聚合抛错，属预期：' + String(error && error.message).slice(0, 70) + '）')
      }
      const text = sent
        .map((item) => (Array.isArray(item) ? item : [item])).flat()
        .map((el) => (typeof el === 'string' ? el : JSON.stringify(el?.attrs ?? el)))
        .join('\n')
      const link = /(https?:\/\/[^\s]+\/kkk\/player\/[0-9a-z]+)/.exec(text)
      return { text, link: link ? link[1] : '', token: link ? link[1].split('/').pop() : '' }
    }

    const savedQqPanelFlag = runtime.config.qqPanel
    runtime.config.qqPanel = false // 直接跑解析，不要先发面板
    runtime.config.playerOnOversize = true
    /**
     * 上限之内才转播：全局上限是 1MB（第 [10] 节写进配置的），视频声明 5MB →
     * 超过全局上限、但没超过「在线播放最大文件」10MB → 走「超限转在线播放」。
     */
    runtime.config.playerMaxFileMB = 10
    const converted = await runBiliParse()
    const biliToken = converted.token
    const biliPlayerSession = biliToken ? store.getPlayerSession(biliToken) : undefined
    check('超限视频没有被拒绝（没有「视频太大了」）', !/太大了/.test(converted.text), converted.text.split('\n')[0].slice(0, 80))
    check('超限视频没有走「已取消上传」', !/已取消上传/.test(converted.text))
    check('用户收到了在线播放链接', !!converted.link, converted.link || '（没有链接）')
    check('播放会话已登记、视频落在播放器目录', !!biliPlayerSession && fs.existsSync(biliPlayerSession.filePath),
      biliPlayerSession ? biliPlayerSession.filePath : '（没有会话）')
    check('弹幕也一起存了下来（这次用户并没有主动要弹幕）',
      !!biliPlayerSession && biliPlayerSession.danmakuCount > 0,
      biliPlayerSession ? biliPlayerSession.danmakuCount + ' 条' : '-')
    const biliPage = biliToken ? await request('/kkk/player/' + biliToken) : { status: 0, body: Buffer.from('') }
    check('这条链接可以直接打开（200）', biliPage.status === 200, 'status=' + biliPage.status)
    /**
     * 作品信息一路带到页面上：解析链路里的 owner / stat / pic / ctime 都要落到会话里，
     * 页面上按B站那样显示（标题、UP 主、播放量 528.1万、封面）。
     */
    check('会话里带着 UP 主 / 播放量 / 封面 / 时长',
      !!biliPlayerSession && biliPlayerSession.author === '测试UP主' && biliPlayerSession.views === 5281000 &&
      biliPlayerSession.cover === 'cover.png' && biliPlayerSession.durationSeconds === 1172,
      biliPlayerSession ? JSON.stringify({
        author: biliPlayerSession.author,
        views: biliPlayerSession.views,
        cover: biliPlayerSession.cover,
        duration: biliPlayerSession.durationSeconds
      }) : '（没有会话）')
    const biliHtml = biliPage.body.toString('utf-8')
    check('播放页按B站那样展示标题 / UP 主 / 播放量 / 时长',
      biliHtml.includes('测试UP主') && biliHtml.includes('528.1万') && biliHtml.includes('19:32') &&
      biliHtml.includes('/kkk/player/' + biliToken + '/cover'), '标题 + UP 主 + 528.1万 + 19:32 + 同源封面')
    if (biliToken) await store.deletePlayerSession(biliToken)

    console.log('\n[11b] 转播也有上限：超过「在线播放最大文件」就不转播，按原来的方式处理')
    /**
     * 用户实测要求：开着「超限转在线播放」时同样要受「在线播放最大文件」约束，
     * 免得几十 GB 的视频被搬进播放器目录、把机器磁盘塞满。
     * 这里把上限压到 2MB（视频声明 5MB）→ 不转播，回到原来的「太大了」拒绝流程。
     */
    runtime.config.playerMaxFileMB = 2
    const dirsBefore = fs.existsSync(PLAYER_DIR) ? fs.readdirSync(PLAYER_DIR) : []
    const refused = await runBiliParse(BILI_BVID_ALT)
    const dirsAfter = fs.existsSync(PLAYER_DIR) ? fs.readdirSync(PLAYER_DIR) : []
    check('超过在线播放上限时不转播（没有给用户任何播放链接）', !refused.link,
      refused.link ? refused.link : '（没有链接，符合预期）')
    check('按原来的方式拒绝，并说明「超过在线播放的体积上限、按原来的方式处理」',
      /太大了/.test(refused.text) && /在线播放的体积上限/.test(refused.text) && /按原来的方式处理/.test(refused.text),
      (refused.text.match(/[^\n]*太大[^\n]*/) || ['（没有说明）'])[0].slice(0, 140))
    check('播放器目录没有被塞进新会话（一个文件都没多）',
      dirsAfter.length === dirsBefore.length, '目录项 ' + dirsBefore.length + ' -> ' + dirsAfter.length)
    check('超限的这次没有登记任何播放会话', store.listPlayerSessions().length === 0,
      'sessions=' + store.listPlayerSessions().length)

    console.log('\n[11c] 端到端：面板「在线看」（--play=1）不发视频、弹幕关着也照样带弹幕')
    /**
     * 用户要求：「在线看」= 直接在线播放（带弹幕、视频不发群），而且**不管有没有选择弹幕都默认有弹幕**。
     * 这里故意把「强制不烧录弹幕」打开、面板弹幕列关掉 —— 在线看仍然要带弹幕。
     */
    const savedRoleFlag = runtime.config.playerEnabled
    const savedDanmakuFlag = runtime.config.qqPanelDanmaku
    const savedForceFlag = runtime.config.forceNoDanmaku
    runtime.config.playerEnabled = true
    runtime.config.playerOnOversize = false
    runtime.config.playerMaxFileMB = 10
    runtime.config.forceNoDanmaku = true
    runtime.config.qqPanelDanmaku = false
    const watched = await runBiliParse('BV1zz411c7mF', ' --play=1')
    const watchSession = watched.token ? store.getPlayerSession(watched.token) : undefined
    check('在线看：用户拿到播放链接，视频没有被拒绝（也没有「太大了」）',
      !!watched.link && !/太大了|已取消上传/.test(watched.text), watched.link || '（没有链接）')
    check('在线看：视频进了播放器目录（不发到 QQ）', !!watchSession && fs.existsSync(watchSession.filePath),
      watchSession ? watchSession.filePath : '（没有会话）')
    check('在线看：即使「强制不烧录弹幕」开着（弹幕功能关着）也照样带弹幕',
      !!watchSession && watchSession.danmakuCount > 0, watchSession ? watchSession.danmakuCount + ' 条' : '（没有会话）')
    check('在线看：不弹「本部署已关闭弹幕烧录 / 未接入 ffmpeg」的降级提示',
      !/已关闭弹幕烧录|未接入 ffmpeg/.test(watched.text))
    check('在线看：播放页能直接打开（200）',
      watched.token ? (await request('/kkk/player/' + watched.token)).status === 200 : false)
    if (watched.token) await store.deletePlayerSession(watched.token)
    runtime.config.playerEnabled = savedRoleFlag
    runtime.config.qqPanelDanmaku = savedDanmakuFlag
    runtime.config.forceNoDanmaku = savedForceFlag

    runtime.config.qqPanel = savedQqPanelFlag
    runtime.config.playerOnOversize = savedOnOversize
    runtime.config.playerMaxFileMB = savedMax
    console.log('\n[12] 会话索引 / 弹幕带 BOM 也能读回来（Windows 上写文件很容易带 BOM）')
    const bomDir = path.join(dataRoot, 'bom-check')
    const bomToken = 'bomcheck00000001'
    const bomSessionDir = path.join(bomDir, bomToken)
    const bomVideo = path.join(bomSessionDir, 'video.mp4')
    fs.rmSync(bomDir, { recursive: true, force: true })
    fs.mkdirSync(bomSessionDir, { recursive: true })
    fs.writeFileSync(bomVideo, VIDEO_BYTES)
    fs.writeFileSync(path.join(bomSessionDir, 'danmaku.json'),
      '\uFEFF' + JSON.stringify({ total: 1, items: [{ time: 10, mode: 1, size: 25, color: 16777215, text: 'BOM 弹幕' }] }))
    fs.writeFileSync(path.join(bomDir, 'sessions.json'), '\uFEFF' + JSON.stringify([{
      token: bomToken,
      title: 'BOM 验证',
      platform: 'bilibili',
      dir: bomSessionDir,
      filePath: bomVideo,
      sizeBytes: VIDEO_BYTES.length,
      danmakuCount: 1,
      createdAt: Date.now(),
      expireAt: Date.now() + 10 * 60 * 1000
    }]))
    store.setupPlayerStore(bomDir)
    check('带 BOM 的 sessions.json 能读回来', store.listPlayerSessions().length === 1,
      JSON.stringify(store.listPlayerSessions().map((item) => item.token)))
    check('带 BOM 的 danmaku.json 也能读', (store.readPlayerDanmaku(bomToken)?.total ?? 0) === 1,
      'total=' + store.readPlayerDanmaku(bomToken)?.total)
    check('恢复出来的会话能打开播放页', (await request('/kkk/player/' + bomToken)).status === 200)
    await store.deletePlayerSession(bomToken)

    console.log('\n[13] 下载：播放页按钮 + ?download=1 / /download + Content-Disposition')
    /**
     * 用户要求：「网页界面要求可以下载」—— 页面上要有一个明显的下载按钮，
     * 服务端的下载响应要带 `Content-Disposition: attachment` 且文件名做过安全处理。
     */
    const savedDlEnabled = runtime.config.playerEnabled
    const savedDlMax = runtime.config.playerMaxFileMB
    runtime.config.playerEnabled = true
    runtime.config.playerMaxFileMB = 10
    // 标题故意带路径分隔符 / 反斜杠 / 控制字符：文件名必须被清洗，头里也必须只有 Latin-1
    const dlTitle = '【下载验证】B站视频/第 1 集 \\ 测试\u0007标题'
    const dlSent = []
    const dlOk = await store.publishOnlinePlayer(collector(dlSent), {
      videoPath: makeVideo('tmp_player_download.mp4'),
      title: dlTitle,
      platform: 'bilibili',
      danmaku: [{ progress: 1000, mode: 1, fontsize: 25, color: 16777215, content: '下载验证弹幕' }]
    })
    const dlLink = /(https?:\/\/[^\s]+\/kkk\/player\/[0-9a-z]+)/.exec(dlSent[1] || '')
    const dlToken = dlLink ? dlLink[1].split('/').pop() : ''
    check('准备好了一条待下载的会话', dlOk === true && !!dlToken, dlToken || '（没有令牌）')
    const dlPage = await request('/kkk/player/' + dlToken)
    const dlHtml = dlPage.body.toString('utf-8')
    check('播放页上有明显的「下载」按钮（指向 /video?download=1，图标是内联 SVG）',
      /id="downloadBtn"/.test(dlHtml) && dlHtml.includes('下载视频') &&
      dlHtml.includes('href="/kkk/player/' + dlToken + '/video?download=1"') &&
      /class="dlbtn"[^>]*>\s*<svg viewBox="0 0 24 24"/.test(dlHtml),
      (dlHtml.match(/<a class="dlbtn"[^>]*>/) || ['（没有下载按钮）'])[0])
    check('播放页也有「直接跳转 / 手动复制」两个按钮',
      /id="pageLinkJump"/.test(dlHtml) && /id="pageLinkCopy"/.test(dlHtml) &&
      dlHtml.includes('本页链接') && dlHtml.includes('手动复制'),
      (dlHtml.match(/<div class="linkrow">[\s\S]{0,180}/) || ['（没有链接行）'])[0].replace(/\s+/g, ' ').slice(0, 160))
    check('下载按钮不引外链（页面依旧零外网依赖）',
      !/https?:\/\//.test((dlHtml.match(/<a class="dlbtn"[^>]*>/) || [''])[0]))
    const dl = await request('/kkk/player/' + dlToken + '/video?download=1')
    const disposition = String(dl.headers['content-disposition'] ?? '')
    check('?download=1 返回 200 + Content-Disposition: attachment',
      dl.status === 200 && /^attachment;/.test(disposition), 'status=' + dl.status + ' / ' + disposition)
    check('响应头是 Latin-1 安全的（中文不会让 Node 抛 ERR_INVALID_CHAR）',
      /^[\x20-\x7e]*$/.test(disposition), JSON.stringify(disposition))
    const starName = (() => {
      const hit = /filename\*=UTF-8''([^;]+)/.exec(disposition)
      try { return hit ? decodeURIComponent(hit[1]) : '' } catch { return '' }
    })()
    check('filename* 解出来就是「清洗过的标题.mp4」',
      starName === '【下载验证】B站视频 第 1 集 测试标题.mp4', starName || '（没有 filename*）')
    const asciiName = (/filename="([^"]*)"/.exec(disposition) || ['', ''])[1]
    check('ASCII 兜底文件名：没有路径分隔符 / 控制字符，且以 .mp4 结尾',
      !!asciiName && !/[\\/]/.test(asciiName) && !/[\u0000-\u001f]/.test(asciiName) && /\.mp4$/.test(asciiName),
      asciiName)
    const dlAlt = await request('/kkk/player/' + dlToken + '/download')
    check('/download 独立路由与 ?download=1 等价',
      dlAlt.status === 200 && /^attachment;/.test(String(dlAlt.headers['content-disposition'] ?? '')) &&
      dlAlt.body.length === 4096, 'status=' + dlAlt.status)
    const dlPlain = await request('/kkk/player/' + dlToken + '/video')
    check('普通 /video 不带 Content-Disposition（页面里照常播放）',
      dlPlain.status === 200 && !dlPlain.headers['content-disposition'] && dlPlain.body.length === 4096,
      'status=' + dlPlain.status)
    const dlRange = await request('/kkk/player/' + dlToken + '/video', { Range: 'bytes=0-1023' })
    check('/video 的 Range 行为不受影响（206 + Content-Range + 1024 字节）',
      dlRange.status === 206 && String(dlRange.headers['content-range']) === 'bytes 0-1023/4096' &&
      dlRange.body.length === 1024)
    const dlRangeDownload = await request('/kkk/player/' + dlToken + '/video?download=1', { Range: 'bytes=4000-' })
    check('带 download 时也保留 Range（下载工具续传用得上）',
      dlRangeDownload.status === 206 && String(dlRangeDownload.headers['content-range']) === 'bytes 4000-4095/4096' &&
      /^attachment;/.test(String(dlRangeDownload.headers['content-disposition'] ?? '')))
    check('下载路由同样认过期令牌（先删会话再取 → 404）',
      (await store.deletePlayerSession(dlToken)) === true &&
      (await request('/kkk/player/' + dlToken + '/download')).status === 404)
    // 文件名清洗 / 头拼装这两件事单独验一遍（不依赖某个具体会话）
    const nasty = store.sanitizeDownloadName('../../etc/passwd\u0000\u0007')
    check('文件名清洗：去掉路径分隔符 / 控制字符 / 开头的点',
      !/[\\/]/.test(nasty) && !nasty.startsWith('.') && nasty.includes('passwd'), JSON.stringify(nasty))
    check('文件名清洗：空标题兜底 + 超长截断到 80 字符',
      store.sanitizeDownloadName('') === 'video' && store.sanitizeDownloadName('x'.repeat(200)).length === 80,
      store.sanitizeDownloadName('x'.repeat(200)).length + ' 字符')
    check('纯中文标题的 ASCII 兜底名不会变成一排下划线',
      /filename="[a-z0-9-]+\.mp4"/.test(store.downloadDisposition('纯中文标题')),
      store.downloadDisposition('纯中文标题'))
    check('downloadDisposition：附件 + 两个文件名齐全',
      /^attachment; filename="[^"]*\.mp4"; filename\*=UTF-8''/.test(store.downloadDisposition('中文标题')),
      store.downloadDisposition('中文标题'))
    runtime.config.playerEnabled = savedDlEnabled
    runtime.config.playerMaxFileMB = savedDlMax

    videoSourceServer.close()

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
