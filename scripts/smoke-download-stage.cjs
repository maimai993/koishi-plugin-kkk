/**
 * 冒烟测试：解析阶段（「下载进度」指令看到的状态）。
 *
 * 覆盖：
 *   1. 阶段条目的语义：同一次解析只占一条（后一个阶段覆盖前一个）、解析结束能清干净；
 *   2. 真实字节进度开始时会把阶段条目收掉（不会出现「正在烧录」和「已下载 3MB」并排）；
 *   3. 四个平台的名字都能登记出「正在获取下载链接」；
 *   4. 共用出口各自登记：合并音轨（mergeVideoAudio）、发送（uploadFile）；
 *   5. 端到端（B站 真烧录模式）：正在获取下载链接 → 正在烧录 → 正在发送，结束时清空；
 *   6. 端到端（B站 播放器模式）：正在获取下载链接 → 正在准备在线播放，结束时清空；
 *   7. 端到端（抖音 真烧录模式）：同样的「获取 → 烧录 → 发送」三段，结束时清空。
 *
 * 视频源是本机起的小服务（不依赖外网），烧录用真实的小 mp4 + 真 ffmpeg 跑一遍。
 *
 * 用法：node scripts/smoke-download-stage.cjs
 */
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { Context } = require('koishi')

const pluginRoot = path.resolve(__dirname, '..')
const dataRoot = path.resolve(pluginRoot, 'data-smoke-stage')
const cfgDir = path.join(dataRoot, 'koishi-plugin-kkk', 'config')
const PLAYER_PORT = 15210
const VIDEO_SOURCE_PORT = 15211
const VIDEO_URL = 'http://127.0.0.1:' + VIDEO_SOURCE_PORT + '/video.mp4'
const BILI_URL = 'https://www.bilibili.com/video/BV1xx411c7mD'
const DOUYIN_URL = 'https://www.douyin.com/video/7123456789012345678'

fs.rmSync(dataRoot, { recursive: true, force: true })
fs.mkdirSync(cfgDir, { recursive: true })

/* ------------------------------------------------------------------ *
 * 本地「视频源」：真实的小 mp4（烧录那一步要 ffprobe/ffmpeg 真读它）
 * ------------------------------------------------------------------ */
const assetDir = path.join(dataRoot, 'assets')
fs.mkdirSync(assetDir, { recursive: true })
const sampleVideo = path.join(assetDir, 'sample.mp4')
execFileSync('ffmpeg', [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=15:d=3',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', sampleVideo
])
const sampleBytes = fs.readFileSync(sampleVideo)
const videoServer = http.createServer((req, res) => {
  const headers = { 'Content-Type': 'video/mp4', 'Content-Length': String(sampleBytes.length) }
  if (String(req.method).toUpperCase() === 'HEAD') { res.writeHead(200, headers); res.end(); return }
  res.writeHead(200, headers)
  res.end(sampleBytes)
})
videoServer.listen(VIDEO_SOURCE_PORT)

/* ------------------------------------------------------------------ *
 * 上游配置（必须在 require(plugin) 之前写：Config 发现文件不存在会拷一份默认值）
 * ------------------------------------------------------------------ */
const upstream = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'config/default_config/config.json'), 'utf8'))
upstream.app.parseTip = false
upstream.app.removeCache = true
// 关掉全局体积限制：这个用例只关心阶段，不想被「太大了」提前拦掉
upstream.app.usefilelimit = false
upstream.bilibili.sendContent = ['video']
upstream.bilibili.videoQuality = 32
upstream.bilibili.burnDanmaku = true
// 用 h264 烧录，测试机上最稳、也最快
upstream.bilibili.videoCodec = 'h264'
upstream.douyin.sendContent = ['video']
upstream.douyin.burnDanmaku = true
upstream.douyin.videoCodec = 'h264'
upstream.douyin.switch = true
upstream.pushlist = { douyin: [], bilibili: [] }
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(upstream, null, 2))

/* ------------------------------------------------------------------ *
 * 接口打桩（必须在 require(plugin) 之前）
 * ------------------------------------------------------------------ */
const resolveDep = (name) => {
  try { return require(path.join(pluginRoot, 'node_modules', name)) } catch { return require(name) }
}
const axios = resolveDep('axios')
axios.get = async () => ({ request: { res: { responseUrl: DOUYIN_URL } }, data: '' })

const douyinDetail = {
  aweme_id: '7123456789012345678',
  aweme_type: 0,
  is_slides: false,
  desc: '【阶段验证】抖音视频',
  preview_title: '【阶段验证】抖音视频',
  create_time: Math.floor(Date.now() / 1000) - 3600,
  share_url: DOUYIN_URL,
  author: { uid: '1', sec_uid: 'SEC', nickname: '测试作者', avatar_thumb: { url_list: [VIDEO_URL] } },
  statistics: { digg_count: 1, comment_count: 1, share_count: 1, collect_count: 1, play_count: 1 },
  images: null,
  music: null,
  video: {
    play_addr: { uri: 'v', url_list: [VIDEO_URL], data_size: sampleBytes.length },
    play_addr_h264: { uri: 'v', url_list: [VIDEO_URL], data_size: sampleBytes.length },
    cover: { url_list: [VIDEO_URL] },
    origin_cover: { url_list: [VIDEO_URL] },
    duration: 3000,
    bit_rate: [{
      gear_name: '720p',
      quality_type: 28,
      bit_rate: 1000000,
      FPS: 15,
      format: 'mp4',
      video_extra: JSON.stringify({ definition: '720p' }),
      play_addr: { uri: 'v', url_list: [VIDEO_URL], data_size: sampleBytes.length, width: 320, height: 180 }
    }]
  }
}

const biliInfo = {
  aid: 12345,
  bvid: 'BV1xx411c7mD',
  cid: 67890,
  title: '【阶段验证】B站视频',
  desc: '简介',
  desc_v2: [],
  pic: VIDEO_URL,
  ctime: Math.floor(Date.now() / 1000) - 3600,
  duration: 3,
  pages: [{ cid: 67890, duration: 3 }],
  owner: { mid: 1, name: '测试UP', face: VIDEO_URL },
  stat: { view: 1, danmaku: 2, reply: 3, like: 4, coin: 5, share: 6, favorite: 7 }
}

const amagi = resolveDep('@ikenxuan/amagi')
const realFactory = amagi.default
amagi.default = function (options) {
  const client = realFactory(options)
  client.douyin.fetcher.parseWork = async () => ({ success: true, code: 200, message: 'OK', data: { aweme_detail: douyinDetail } })
  client.douyin.fetcher.fetchDanmakuList = async () => ({
    success: true,
    code: 200,
    message: 'OK',
    data: { danmaku_list: [{ danmaku_id: '1', offset_time: 800, text: '阶段验证弹幕', danmaku_type: 1 }] }
  })
  client.douyin.fetcher.fetchWorkComments = async () => ({ success: true, code: 200, message: 'OK', data: { comments: [], cursor: 0, has_more: 0, total: 0 } })
  client.douyin.fetcher.fetchEmojiList = async () => ({ success: true, code: 200, message: 'OK', data: { emoji_list: [] } })
  client.douyin.fetcher.fetchUserProfile = async () => ({ success: true, code: 200, message: 'OK', data: { user: { uid: '1', sec_uid: 'SEC', nickname: '测试作者', avatar_thumb: { url_list: [VIDEO_URL] }, follower_count: 1 } } })
  client.bilibili.fetcher.fetchVideoInfo = async () => ({ code: 0, message: 'OK', data: { code: 0, data: biliInfo } })
  client.bilibili.fetcher.fetchVideoStreamUrl = async () => ({
    code: 0,
    message: 'OK',
    data: { code: 0, data: { accept_description: ['360P'], accept_quality: [16], durl: [{ order: 1, length: 3000, size: sampleBytes.length, url: VIDEO_URL }] } }
  })
  client.bilibili.fetcher.fetchVideoDanmaku = async () => ({
    code: 0,
    message: 'OK',
    data: { data: { elems: [{ progress: 800, mode: 1, fontsize: 25, color: 16777215, content: '阶段验证弹幕' }] } }
  })
  client.bilibili.fetcher.fetchComments = async () => ({ code: 0, message: 'OK', data: { replies: [], cursor: {} } })
  return client
}

const plugin = require(path.join(pluginRoot, 'lib/index.js'))
const ctx = new Context()
ctx.plugin(plugin, { dataPath: dataRoot, debug: true, qq: { playerPort: PLAYER_PORT } })

/* ------------------------------------------------------------------ *
 * 断言与工具
 * ------------------------------------------------------------------ */
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  —— ' + detail : ''))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

setTimeout(async () => {
  try {
    const stages = require(path.join(pluginRoot, 'lib/karin/module/utils/Network/Downloader.js'))
    const { DOWNLOAD_STAGES, listActiveDownloads, updateDownloadStage, clearParseStage, withDownloadStage, reportDownloadProgress } = stages
    const { beginParseStage } = require(path.join(pluginRoot, 'lib/karin/module/utils/parseTip.js'))
    const { uploadFile } = require(path.join(pluginRoot, 'lib/karin/module/utils/Base.js'))
    const { mergeVideoAudio } = require(path.join(pluginRoot, 'lib/karin/module/utils/FFmpeg.js'))
    const { burnBiliDanmaku } = require(path.join(pluginRoot, 'lib/karin/platform/bilibili/danmaku.js'))
    const { config: runtime } = require(path.join(pluginRoot, 'lib/compat/runtime.js')).getRuntime()

    /** 当前进度表里的阶段文案 */
    const stageNow = () => listActiveDownloads().filter((task) => task.stage).map((task) => task.stage)
    /** 当前进度表里的阶段条目（进度表里可能还有字节进度的条目） */
    const stageEntry = () => listActiveDownloads().find((task) => task.stage)
    /** 记录一段时间内出现过的阶段顺序（10ms 采一次，阶段之间不会漏） */
    let timeline = []
    let timer = null
    const recordStart = () => {
      timeline = []
      timer = setInterval(() => {
        for (const task of listActiveDownloads()) {
          if (!task.stage) continue
          if (timeline[timeline.length - 1] !== task.stage) timeline.push(task.stage)
        }
      }, 10)
    }
    const recordStop = () => {
      if (timer) clearInterval(timer)
      timer = null
      return timeline.slice()
    }

    console.log('\n[1] 阶段条目语义：一次解析只占一条，结束能清干净')
    await beginParseStage('测试平台')
    check('开始解析就有「正在获取下载链接」', stageNow().includes(DOWNLOAD_STAGES.fetching), stageNow().join(' / '))
    check('条目名带平台名', stageEntry()?.name === '测试平台解析', stageEntry()?.name)
    updateDownloadStage(DOWNLOAD_STAGES.burning)
    const afterBurn = listActiveDownloads().filter((task) => task.stage)
    check('下一个阶段是覆盖（不会并排出现两条）', afterBurn.length === 1 && afterBurn[0].stage === DOWNLOAD_STAGES.burning,
      afterBurn.map((task) => task.name + ':' + task.stage).join(' / '))
    check('覆盖后仍然沿用原来的任务名', afterBurn[0].name === '测试平台解析', afterBurn[0].name)
    updateDownloadStage(DOWNLOAD_STAGES.sending)
    check('阶段可以连续切换', listActiveDownloads().filter((task) => task.stage).length === 1 &&
      stageNow()[0] === DOWNLOAD_STAGES.sending, stageNow().join(' / '))
    clearParseStage()
    check('清理后阶段条目为空', stageNow().length === 0, JSON.stringify(stageNow()))
    await withDownloadStage(DOWNLOAD_STAGES.burning, async () => { await sleep(30) })
    check('withDownloadStage 结束后会自动清理（失败也不残留）',
      stageNow().length === 0,
      JSON.stringify(stageNow()))
    try {
      await withDownloadStage(DOWNLOAD_STAGES.burning, async () => { throw new Error('故意失败') })
    } catch { /* 预期 */ }
    check('withDownloadStage 里抛错也清理干净', stageNow().length === 0, JSON.stringify(stageNow()))

    console.log('\n[2] 真实字节进度开始时收掉阶段条目')
    await beginParseStage('测试平台')
    reportDownloadProgress('/tmp/kkk-stage-smoke.mp4', 1024, 2048)
    check('开始传字节后不再显示阶段', stageNow().length === 0, JSON.stringify(stageNow()))
    check('同时显示的是字节进度', listActiveDownloads().some((task) => !task.stage && task.bytes > 0),
      JSON.stringify(listActiveDownloads().map((task) => task.name)))
    clearParseStage()
    stages.clearDownloadProgress('/tmp/kkk-stage-smoke.mp4')

    console.log('\n[3] 四个平台都能登记「正在获取下载链接」')
    const platformNames = ['B站', '抖音', '快手', '小红书']
    const recorded = []
    for (const name of platformNames) {
      await beginParseStage(name)
      const entry = stageEntry()
      recorded.push(name + '→' + (entry?.name ?? '无') + ':' + (entry?.stage ?? '无'))
      clearParseStage()
    }
    check('四个平台名都登记成功', recorded.every((line) => line.includes('解析:' + DOWNLOAD_STAGES.fetching)),
      recorded.join(' | '))

    console.log('\n[4] 共用出口自己登记阶段')
    // 合并音轨：真跑一次 ffmpeg（本机小视频 + 本机小视频当音轨）
    const mergePart = path.join(assetDir, 'part.mp4')
    const mergeOut = path.join(assetDir, 'merged.mp4')
    recordStart()
    await mergeVideoAudio(sampleVideo, sampleVideo, mergeOut)
    const mergeTimeline = recordStop()
    check('合成期间显示「正在合并音轨」', mergeTimeline.includes(DOWNLOAD_STAGES.merging), mergeTimeline.join(' → ') || '（没记录到）')
    check('合成结束后清掉', stageNow().length === 0, JSON.stringify(stageNow()))
    // 烧录：真跑一次 ffmpeg
    const burnOut = path.join(assetDir, 'burned.mp4')
    recordStart()
    await withDownloadStage(DOWNLOAD_STAGES.burning, () =>
      burnBiliDanmaku(sampleVideo, [{ progress: 500, mode: 1, fontsize: 25, color: 16777215, content: '阶段验证' }], burnOut, { videoCodec: 'h264' })
    )
    const burnTimeline = recordStop()
    check('烧录期间显示「正在烧录」', burnTimeline.includes(DOWNLOAD_STAGES.burning), burnTimeline.join(' → ') || '（没记录到）')
    check('烧录结束后清掉', stageNow().length === 0, JSON.stringify(stageNow()))
    // 发送：uploadFile 走一遍（假 event，和 smoke-groupfile 一样的做法）
    // 注意：假上传要刻意慢一点（真实上传本来就是几秒），否则阶段刚登记就结束了，采样不到
    const uploadEvent = {
      selfId: '10000', userId: '12345', guildId: '456', channelId: '456', messageId: 'm1',
      bot: Object.assign({ platform: 'qqguild', uploadFile: async () => { await sleep(200); return true }, recallMsg: async () => true }, {}),
      contact: { peer: 'group:456' },
      reply: async () => { await sleep(200); return { messageId: 'tip-1' } }
    }
    recordStart()
    await uploadFile(uploadEvent, { filepath: mergeOut, totalBytes: 1, originTitle: 'stage-smoke' }, '')
    const sendTimeline = recordStop()
    check('上传期间显示「正在发送」', sendTimeline.includes(DOWNLOAD_STAGES.sending), sendTimeline.join(' → ') || '（没记录到）')
    check('上传结束后清掉', stageNow().length === 0, JSON.stringify(stageNow()))

    /* ---------------- 端到端 ---------------- */
    const { Networks } = require(path.join(pluginRoot, 'lib/karin/module/utils/Network/index.js'))
    Networks.prototype.getData = async () => ({
      data: { durl: [{ order: 1, length: 3000, size: sampleBytes.length, url: VIDEO_URL }], quality: 16, accept_description: ['360P'] }
    })
    Networks.prototype.getHeaders = async () => ({ 'content-length': String(sampleBytes.length), 'content-type': 'video/mp4' })

    const { commandQueue } = require(path.join(pluginRoot, 'lib/compat/runtime.js'))
    const { Message } = require(path.join(pluginRoot, 'lib/compat/node-karin.js'))
    /**
     * 每次调用换一个会话 id。
     *
     * 去重键是「会话 + 用户 + 消息原文」（见 tools.ts 的 acquireMessageLock），
     * 而这个脚本会在 [5] 真烧录 与 [6] 播放器模式里跑**同一条命令原文** ——
     * 会话写死的话第二次会被「短时间不重复解析」直接吃掉，阶段自然一条都记录不到。
     */
    let commandSeq = 0
    const runCommand = async (namePart, content) => {
      const reg = commandQueue.find((item) => String(item.options?.name ?? '').includes(namePart))
      if (!reg) throw new Error('没有注册命令: ' + namePart)
      commandSeq++
      const sent = []
      // 发送侧刻意慢一点：真实上传要几秒，太快的话「正在发送」阶段会被采样漏掉
      const bot = {
        selfId: '10000', platform: 'qqguild', status: 1, user: { id: '10000', name: 'smoke' }, ctx,
        sendMessage: async (channel, payload) => { sent.push(payload); await sleep(150); return ['msg-1'] },
        getGuild: async () => ({ name: 'smoke-guild' })
      }
      const session = {
        content, selfId: '10000', userId: '12345', guildId: '456', channelId: '456-' + commandSeq,
        messageId: 'm1-' + commandSeq,
        bot, author: { nick: 'smoke' }, username: 'smoke', event: {},
        send: async (payload) => { sent.push(payload); await sleep(150); return ['msg-2'] }
      }
      try {
        await reg.handler(Message.fromSession(session), () => Symbol('next'))
      } catch (error) {
        // 渲染类步骤（没装 puppeteer）会在最后聚合成一个错误抛出，阶段断言不受影响
        console.log('     （解析流程最后聚合抛错，属预期：' + String(error && error.message).slice(0, 60) + '）')
      }
      return sent
    }
    const textOf = (sent) => sent.map((item) => (Array.isArray(item) ? item : [item])).flat()
      .map((el) => (typeof el === 'string' ? el : JSON.stringify(el?.attrs ?? el))).join('\n')

    console.log('\n[5] 端到端 · B站真烧录模式：获取下载链接 → 正在烧录 → 正在发送')
    runtime.playerEnabled = false
    runtime.forceNoDanmaku = false
    runtime.qqPanel = false
    recordStart()
    const biliSent = await runCommand('B站', '解析 ' + BILI_URL + ' --dm=1')
    const biliTimeline = recordStop()
    check('阶段顺序是 获取下载链接 → 正在烧录 → 正在发送',
      biliTimeline.includes(DOWNLOAD_STAGES.fetching) &&
      biliTimeline.includes(DOWNLOAD_STAGES.burning) &&
      biliTimeline.includes(DOWNLOAD_STAGES.sending),
      biliTimeline.join(' → ') || '（没记录到）')
    check('阶段先后顺序正确',
      biliTimeline.indexOf(DOWNLOAD_STAGES.fetching) < biliTimeline.indexOf(DOWNLOAD_STAGES.burning) &&
      biliTimeline.indexOf(DOWNLOAD_STAGES.burning) < biliTimeline.indexOf(DOWNLOAD_STAGES.sending),
      biliTimeline.join(' → '))
    check('解析结束时阶段全部清空', stageNow().length === 0, JSON.stringify(stageNow()))
    check('B站链路确实发出去了视频', /video/.test(textOf(biliSent)), textOf(biliSent).slice(0, 60))

    console.log('\n[6] 端到端 · B站播放器模式：获取下载链接 → 正在准备在线播放')
    runtime.playerEnabled = true
    runtime.forceNoDanmaku = false
    recordStart()
    const playerSent = await runCommand('B站', '解析 ' + BILI_URL + ' --dm=1')
    const playerTimeline = recordStop()
    check('阶段顺序是 获取下载链接 → 正在准备在线播放',
      playerTimeline.includes(DOWNLOAD_STAGES.fetching) && playerTimeline.includes(DOWNLOAD_STAGES.preparingPlayer),
      playerTimeline.join(' → ') || '（没记录到）')
    check('播放器模式不出现「正在烧录」', !playerTimeline.includes(DOWNLOAD_STAGES.burning), playerTimeline.join(' → '))
    check('用户拿到了播放链接', /\/kkk\/player\/[0-9a-z]+/.test(textOf(playerSent)), textOf(playerSent).slice(0, 70))
    check('解析结束时阶段全部清空', stageNow().length === 0, JSON.stringify(stageNow()))

    console.log('\n[7] 端到端 · 抖音真烧录模式：获取下载链接 → 正在烧录 → 正在发送')
    runtime.playerEnabled = false
    runtime.forceNoDanmaku = false
    recordStart()
    const douyinSent = await runCommand('抖音', '解析 https://v.douyin.com/iStageTest/ --dm=1')
    const douyinTimeline = recordStop()
    check('阶段顺序是 获取下载链接 → 正在烧录 → 正在发送',
      douyinTimeline.includes(DOWNLOAD_STAGES.fetching) &&
      douyinTimeline.includes(DOWNLOAD_STAGES.burning) &&
      douyinTimeline.includes(DOWNLOAD_STAGES.sending),
      douyinTimeline.join(' → ') || '（没记录到）')
    check('抖音链路确实发出去了视频', /video/.test(textOf(douyinSent)), textOf(douyinSent).slice(0, 60))
    check('解析结束时阶段全部清空', stageNow().length === 0, JSON.stringify(stageNow()))

    console.log('\n[8] 「下载进度」指令的输出')
    // 这条指令是直接注册到 Koishi 的（不在 karin 的 commandQueue 里），走 $commander 调它的 action
    const progressCommand = ctx.$commander._commandList.find((item) => item.name === '下载进度')
    const runProgressCommand = async () => {
      const sent = []
      const session = {
        content: '下载进度', selfId: '10000', userId: '12345', guildId: '456', channelId: '456', messageId: 'm9',
        bot: { selfId: '10000', platform: 'qqguild', status: 1, user: { id: '10000' }, sendMessage: async () => ['m'] },
        author: { nick: 'smoke' }, username: 'smoke', event: {},
        send: async (payload) => { sent.push(payload); return ['msg-9'] }
      }
      await progressCommand._actions[progressCommand._actions.length - 1]({ session, options: {}, args: [] })
      return textOf(sent)
    }
    check('指令已注册', !!progressCommand)
    const progressText = await runProgressCommand()
    check('没有任务时给一句明确说明', /当前没有正在进行的下载/.test(progressText), progressText.slice(0, 60))
    await beginParseStage('B站')
    const progressText2 = await runProgressCommand()
    check('有阶段时显示「任务名 + 阶段」', /B站解析/.test(progressText2) && /正在获取下载链接/.test(progressText2),
      progressText2.slice(0, 80))
    // 「下载进度」是只读指令，不该动阶段状态（清理是解析流程自己收尾的事）
    check('只读指令不会清掉阶段', stageNow().length === 1, JSON.stringify(stageNow()))
    clearParseStage()
    check('手动清理后恢复为空', stageNow().length === 0, JSON.stringify(stageNow()))

    videoServer.close()
    const failed = results.filter((item) => !item.ok)
    console.log('\n=== ' + (results.length - failed.length) + '/' + results.length + ' 通过 ===')
    process.exitCode = failed.length ? 1 : 0
  } catch (error) {
    console.error('冒烟测试失败:', error && error.stack ? error.stack : error)
    process.exitCode = 1
  }
  process.exit(process.exitCode || 0)
}, 6000)
