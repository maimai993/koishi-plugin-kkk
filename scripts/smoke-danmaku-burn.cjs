/**
 * 冒烟测试：B站弹幕烧录（burnBiliDanmaku）。
 *
 * 用一段纯黑测试视频 + 样条弹幕跑真实烧录链路，然后用「画面亮度」判断弹幕到底有没有进画面：
 * 黑底上如果弹幕烧录成功，取帧的平均亮度一定明显大于源视频。
 *
 * 用法：node scripts/smoke-danmaku-burn.cjs [h264|h265|av1]
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const pluginRoot = path.resolve(__dirname, '..')
const work = path.join(os.tmpdir(), 'kkk-smoke-danmaku')
fs.mkdirSync(work, { recursive: true })

const codec = process.argv[2] || 'h264'
const src = path.join(work, 'src.mp4')
const out = path.join(work, 'out-' + codec + '.mp4')

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe'
const run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

if (!fs.existsSync(src)) {
  run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src])
}
if (fs.existsSync(out)) fs.unlinkSync(out)

/** 取某一秒画面上半部分的平均亮度 */
const luma = (file, at) => {
  const text = run(ffmpeg, ['-hide_banner', '-ss', String(at), '-i', file, '-frames:v', '1',
    '-vf', 'crop=iw:ih/2:0:0,signalstats,metadata=print:file=-', '-f', 'null', '-'])
  const m = text.match(/lavfi\.signalstats\.YAVG=([\d.]+)/)
  return m ? Number(m[1]) : NaN
}

const danmaku = [
  { progress: 300, mode: 1, fontsize: 25, color: 16777215, content: '弹幕烧录测试' },
  { progress: 900, mode: 1, fontsize: 25, color: 16711680, content: '红色滚动弹幕' },
  { progress: 1500, mode: 5, fontsize: 25, color: 16777215, content: '顶部固定弹幕' },
  { progress: 2100, mode: 4, fontsize: 25, color: 16777215, content: '底部固定弹幕' },
  { progress: 2700, mode: 1, fontsize: 36, color: 65280, content: '大字绿色弹幕' },
  { progress: 3600, mode: 1, fontsize: 18, color: 16777215, content: '小字弹幕' }
]

let failures = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? ' | ' + extra : ''))
  if (!ok) failures++
}

;(async () => {
  try {
    const { burnBiliDanmaku, generateBiliASS } = require(path.join(pluginRoot, 'lib/karin/platform/bilibili/danmaku.js'))

    fs.writeFileSync(path.join(work, 'preview.ass'), generateBiliASS(danmaku, 640, 360, {}))
    console.log('样本 ASS 已生成：' + path.join(work, 'preview.ass'))

    const srcLuma = luma(src, 1)
    console.log('源视频 1s 上半部分亮度：' + srcLuma)

    const ok = await burnBiliDanmaku(src, danmaku, out, { videoCodec: codec, danmakuArea: 0.5 })
    check('burnBiliDanmaku 返回成功', ok === true, 'status=' + ok)

    if (!fs.existsSync(out)) {
      check('输出文件存在', false, out + ' 不存在')
    } else {
      const info = run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration,size', '-of', 'json', out])
      const parsed = JSON.parse(info).format
      const dstLuma = luma(out, 1)
      console.log('输出文件：' + (parsed.size / 1024).toFixed(0) + 'KB，时长 ' + Number(parsed.duration).toFixed(2) + 's，1s 亮度 ' + dstLuma)
      check('输出文件存在且非空', Number(parsed.size) > 10240, String(parsed.size) + ' 字节')
      check('时长与原片接近', Math.abs(Number(parsed.duration) - 6) < 1, parsed.duration + 's')
      const hasAudio = run(ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', out]).trim()
      check('音轨保留', hasAudio.length > 0, hasAudio)
      check('弹幕真的烧进了画面（亮度上升）', dstLuma > srcLuma + 1,
        '源 ' + srcLuma + ' → 输出 ' + dstLuma)
    }
  } catch (error) {
    console.error('弹幕烧录冒烟测试异常:', error && error.stack ? error.stack : error)
    failures++
  }
  console.log('')
  console.log(failures ? '失败 ' + failures + ' 项' : '全部通过')
  process.exit(failures ? 1 : 0)
})()
