/**
 * 冒烟测试：**播放页按需下分段**时，playurl 的 dash 挂在哪一层都能取到流。
 *
 * 真实事故：播放页点选项后报
 * `没有拿到视频流直链（playurl 返回里没有 base_url）` ⇒ 分段 404 ⇒ 页面上是
 * 「这一段没准备好」/「链接已过期」。
 * 原因是 amagi 的 playurl 响应里 dash 有时在 `data.dash`、有时在 `data.data.dash`，
 * 而 `prepareVideo` 只读了一层 —— 构建是 noCheck，没有任何编译期提示。
 *
 * 这里把 `downloadFile` / `fixM4sFile` / `Common` 打桩，**真的把 prepareVideo 跑一遍**，
 * 两种形状各验一次：选出来的那一路必须被交给下载器。
 *
 * 用法：node scripts/smoke-player-segment-shape.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const pluginRoot = path.resolve(__dirname, '..')

let failures = 0
const check = (name, ok, detail) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  —— ' + detail : ''))
  if (!ok) failures++
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kkk-shape-'))
/**
 * 注意：**不能**在 `module/utils/index.js` 上打桩 —— tsc 的 `__exportStar` 是用 getter 转出去的，
 * 赋值会被静默丢掉（真下载器照样跑，测试还以为自己打好了桩）。
 * 直接改定义它们的那个模块（index.js 的 getter 会读到新值）。
 */
const utils = require(path.join(pluginRoot, 'lib/karin/module/utils/index.js'))
const baseModule = require(path.join(pluginRoot, 'lib/karin/module/utils/Base.js'))
const ffmpegModule = require(path.join(pluginRoot, 'lib/karin/module/utils/FFmpeg.js'))
const commonModule = require(path.join(pluginRoot, 'lib/karin/module/utils/Common.js'))

/** 打桩：下载器只记下「被要求下载哪个直链」，然后给一个假文件 */
const downloads = []
baseModule.downloadFile = async (url, opt) => {
  downloads.push(url)
  const file = path.join(tmp, (opt && opt.title) || 'x.m4s')
  fs.writeFileSync(file, Buffer.alloc(1024, 7))
  return { filepath: file, totalBytes: 1024 }
}
/** m4s → mp4 的修复在 FFmpeg 模块里（别打错模块：打错了会真的去跑 ffmpeg） */
ffmpegModule.fixM4sFile = async (from, to) => {
  fs.copyFileSync(from, to || from)
  return true
}
/** 临时视频目录换成本次测试的目录，别去动插件自己的 data/temp */
const realCommon = commonModule.Common
if (realCommon && realCommon.tempDri) realCommon.tempDri.video = tmp + path.sep
realCommon.removeFile = async () => true
void utils

const bilibiliPath = path.join(pluginRoot, 'lib/karin/platform/bilibili/bilibili.js')
const { Bilibili } = require(bilibiliPath)

const fakeEvent = { reply: async () => ({ messageId: 'm1' }), contact: { peer: 'group:1' } }

/** 造一份 amagi 形状的 playurl；layers 决定 dash 挂在哪一层 */
const makePlayUrl = (layers) => {
  const dash = {
    video: [
      { id: 80, base_url: 'https://upos.example/video-1080.m4s', width: 1920, height: 1080 },
      { id: 32, base_url: 'https://upos.example/video-480.m4s', width: 852, height: 480 }
    ],
    audio: [{ id: 30280, base_url: 'https://upos.example/audio.m4s' }],
    accept_description: ['高清 1080P', '清晰 480P']
  }
  return layers === 2
    ? { code: 0, message: '0', data: { code: 0, message: '0', data: { dash, accept_description: dash.accept_description } } }
    : { code: 0, message: '0', data: { code: 0, message: '0', dash, accept_description: dash.accept_description } }
}

const runCase = async (layers) => {
  downloads.length = 0
  const story = new Bilibili(fakeEvent, { type: 'one_video', bvid: 'BVTESTSHAPE1' }, { storyOnly: true })
  story.islogin = true
  story.downloadfilename = 'shape-' + layers
  const ok = await story.prepareVideo({
    infoData: { data: { data: { bvid: 'BVTESTSHAPE1' } } },
    playUrlData: makePlayUrl(layers),
    danmakuList: [],
    keepAudioSeparate: true
  })
  const prepared = story.takePreparedVideo()
  return { ok, prepared, downloads: [...downloads] }
}

const main = async () => {
  for (const layers of [1, 2]) {
    console.log('[dash 挂在 ' + (layers === 1 ? 'data.dash' : 'data.data.dash') + ']')
    const result = await runCase(layers)
    check('prepareVideo 成功', result.ok === true, JSON.stringify({ ok: result.ok }))
    check('下载器拿到了选好的画面直链（不是空手而归）',
      result.downloads.some((u) => u.includes('video-')), result.downloads.join(' | ') || '（一次下载都没发生）')
    check('画面 + 音轨都交了出来（音轨单独一份，不合成）',
      !!result.prepared?.filepath && !!result.prepared?.audioPath,
      JSON.stringify(result.prepared))
  }

  console.log('[两种形状下选出来的都是同一档（按配置画质挑流没被形状带歪）]')
  const a = await runCase(1)
  const b = await runCase(2)
  const pick = (r) => r.downloads.find((u) => u.includes('video-')) || ''
  check('两条路径选中的视频流一致', pick(a) && pick(a) === pick(b), pick(a) + ' / ' + pick(b))

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('')
  console.log(failures ? '失败 ' + failures + ' 项' : '全部通过')
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error('冒烟测试失败:', error && error.stack ? error.stack : error)
  process.exit(1)
})
