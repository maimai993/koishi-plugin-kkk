/**
 * 在线播放页（单文件 HTML）。
 *
 * 页面刻意做成**完全自包含**：没有外网 CDN、没有第三方弹幕库，
 * 弹幕用 canvas 自己画（滚动 / 顶部 / 底部、颜色、字号、透明度），
 * 断网 / 内网部署也能正常打开。
 *
 * 页面上只有三件用户能调的东西（都是本地开关，不回传服务端）：
 *   - 弹幕开关
 *   - 字号（小 / 中 / 大）
 *   - 透明度（滑块）
 * 进度条直接用 video 的原生 controls —— 服务端支持 Range，拖到哪播到哪。
 *
 * 注意：内联脚本是**单引号 TS 字符串数组**拼出来的，所以脚本里一律用双引号，
 * 别在数组项里写单引号（会把这个文件自己的语法搞坏）。
 */

/** 页面上要显示的会话信息 */
export interface PlayerPageInfo {
  token: string
  title?: string
  platform?: string
  expireAt?: number
  danmakuCount?: number
}

/** HTML 文本转义（标题是用户内容，不能直接塞进标签里） */
function escapeHtml (value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 平台名换成中文（页脚显示） */
function platformLabel (platform?: string): string {
  const key = String(platform ?? '').toLowerCase()
  if (key === 'bilibili') return '哔哩哔哩'
  if (key === 'douyin') return '抖音'
  return '视频'
}

/** 到期时间按本地时区显示成 yyyy-MM-dd HH:mm */
function formatExpire (expireAt?: number): string {
  const time = Number(expireAt)
  if (!Number.isFinite(time) || time <= 0) return ''
  const date = new Date(time)
  const pad = (n: number) => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' '
    + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

/** 公共样式（播放页与过期提示页共用一份） */
const BASE_STYLE = [
  '*{box-sizing:border-box}',
  'html,body{margin:0;padding:0;background:#08090c;color:#e6e8ee;',
  'font-family:"PingFang SC","Microsoft YaHei","Segoe UI",system-ui,sans-serif;}',
  'body{min-height:100vh;-webkit-text-size-adjust:100%;}',
  'a{color:#6ea8fe}'
].join('')

/** 播放页样式 */
const PLAYER_STYLE = [
  BASE_STYLE,
  '.wrap{max-width:1080px;margin:0 auto;padding:12px 12px 32px;}',
  '.stage{position:relative;width:100%;background:#000;border-radius:12px;overflow:hidden;line-height:0;}',
  'video{display:block;width:100%;max-height:76vh;background:#000;}',
  '#danmaku{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;}',
  '.notice{position:absolute;left:0;right:0;top:0;bottom:0;display:flex;align-items:center;justify-content:center;',
  'line-height:1.6;padding:16px;text-align:center;color:#ffb4b4;background:rgba(0,0,0,.72);font-size:14px;}',
  '.notice[hidden]{display:none}',
  '.bar{display:flex;flex-wrap:wrap;align-items:center;gap:10px 18px;margin-top:12px;padding:12px 14px;',
  'background:#12141a;border:1px solid #1e2129;border-radius:12px;}',
  '.item{display:flex;align-items:center;gap:8px;font-size:14px;color:#c9cdd8;white-space:nowrap;}',
  '.switch{display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;user-select:none;color:#e6e8ee;}',
  '.switch input{width:18px;height:18px;accent-color:#3b82f6;cursor:pointer;}',
  'select{background:#1b1e26;color:#e6e8ee;border:1px solid #2a2f3a;border-radius:8px;padding:5px 8px;font-size:14px;}',
  'input[type=range]{width:120px;accent-color:#3b82f6;}',
  '.meta{margin-left:auto;color:#8b91a1;font-size:13px;}',
  '.foot{margin-top:10px;color:#8b91a1;font-size:13px;line-height:1.7;word-break:break-all;}',
  '.foot b{color:#c9cdd8;font-weight:600;}'
].join('')

/**
 * 播放页正文。
 *
 * token 只允许 [0-9a-z]，所以直接内联进脚本是安全的；接口地址按 token 拼成绝对路径 ——
 * 页面地址是 `/kkk/player/<token>`（没有结尾斜杠），用相对路径会被解析成
 * `/kkk/player/danmaku` 这种错地址。
 * @param info 会话信息
 */
export function renderPlayerPage (info: PlayerPageInfo): string {
  const token = String(info.token ?? '').replace(/[^0-9a-z]/g, '')
  const title = escapeHtml(info.title || '在线播放')
  const platform = escapeHtml(platformLabel(info.platform))
  const expire = formatExpire(info.expireAt)
  const count = Number(info.danmakuCount) || 0
  const script = PLAYER_SCRIPT.split('__KKK_TOKEN__').join(token)

  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n'
    + '<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    + '<meta name="referrer" content="no-referrer">\n'
    + '<title>' + title + '</title>\n'
    + '<style>' + PLAYER_STYLE + '</style>\n'
    + '</head>\n<body>\n'
    + '<div class="wrap">\n'
    + '  <div class="stage">\n'
    + '    <video id="video" src="/kkk/player/' + token + '/video" controls preload="metadata" playsinline webkit-playsinline></video>\n'
    + '    <canvas id="danmaku"></canvas>\n'
    + '    <div id="notice" class="notice" hidden></div>\n'
    + '  </div>\n'
    + '  <div class="bar">\n'
    + '    <label class="switch"><input type="checkbox" id="dmOn" checked><span>弹幕开关</span></label>\n'
    + '    <label class="item"><span>字号</span><select id="dmSize">'
    + '<option value="small">小</option><option value="medium" selected>中</option><option value="large">大</option>'
    + '</select></label>\n'
    + '    <label class="item"><span>透明度</span><input type="range" id="dmOpacity" min="10" max="100" step="5" value="100">'
    + '<span id="dmOpacityValue">100%</span></label>\n'
    + '    <span class="meta">共 <b id="dmCount">' + count + '</b> 条弹幕</span>\n'
    + '  </div>\n'
    + '  <div class="foot">' + title + '（' + platform + '）'
    + (expire ? '<br>链接有效期至 ' + expire : '')
    + '<br>进度条可以直接拖动；链接过期后视频与弹幕会被自动清理。'
    + '</div>\n'
    + '</div>\n'
    + '<script>' + script + '</script>\n'
    + '</body>\n</html>\n'
}

/**
 * 过期 / 无效令牌的提示页（HTTP 状态码是 404）。
 * 用户从群里点进来的链接多半已经躺在聊天记录里很久了，这里要说清楚「为什么打不开」。
 */
export function renderExpiredPage (): string {
  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n'
    + '<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<title>链接已过期</title>\n'
    + '<style>' + BASE_STYLE
    + '.box{max-width:520px;margin:18vh auto 0;padding:0 20px;text-align:center;}'
    + 'h1{font-size:20px;margin:0 0 12px;}p{color:#9aa0ae;font-size:14px;line-height:1.8;margin:0;}'
    + '</style>\n</head>\n<body>\n'
    + '<div class="box">\n<h1>链接已过期</h1>\n'
    + '<p>这个在线播放链接已经过期（或者视频已经被清理），视频与弹幕都不再保留。<br>'
    + '需要再看的话，重新发一次链接让机器人解析即可。</p>\n</div>\n'
    + '</body>\n</html>\n'
}

/**
 * 播放页的内联脚本。
 *
 * 弹幕是自己画的：按 video.currentTime 把到点的弹幕扔进活动列表，
 * 滚动弹幕每帧按速度左移、顶部/底部固定几秒，画完就丢。
 * 拖动进度条时按当前时间重新定位游标（不会把前面几千条弹幕一次性喷出来）。
 */
const PLAYER_SCRIPT = [
    "(function () {",
    "  'use strict'",
    "  var TOKEN = '__KKK_TOKEN__'",
    "  var API = '/kkk/player/' + TOKEN",
    "  var video = document.getElementById('video')",
    "  var canvas = document.getElementById('danmaku')",
    "  var ctx = canvas.getContext('2d')",
    "  var notice = document.getElementById('notice')",
    "  var countEl = document.getElementById('dmCount')",
    "  var toggle = document.getElementById('dmOn')",
    "  var sizeSelect = document.getElementById('dmSize')",
    "  var opacityRange = document.getElementById('dmOpacity')",
    "  var opacityValue = document.getElementById('dmOpacityValue')",
    "",
    "  // 字号档位：B站弹幕自带的 18/25/36 会再乘这个系数，用户在页面上选的优先级更高",
    "  var SIZE_SCALE = { small: 0.75, medium: 1, large: 1.35 }",
    "  var sizeScale = 1",
    "  var enabled = true",
    "  var items = []",
    "  var cursor = 0",
    "  var active = []",
    "  var scrollLanes = []",
    "  var topLanes = []",
    "  var bottomLanes = []",
    "  var laneHeight = 26",
    "  var viewWidth = 0",
    "  var viewHeight = 0",
    "  var scrollSpeed = 220",
    "  var FIXED_MS = 4000",
    "  var GAP = 16",
    "",
    "  function showNotice (text) {",
    "    notice.textContent = text",
    "    notice.hidden = false",
    "  }",
    "",
    "  function laneCount () {",
    "    return Math.max(1, Math.floor(viewHeight * 0.82 / laneHeight))",
    "  }",
    "",
    "  function clearLanes () {",
    "    active = []",
    "    scrollLanes = []",
    "    topLanes = []",
    "    bottomLanes = []",
    "  }",
    "",
    "  function fitCanvas () {",
    "    var rect = canvas.getBoundingClientRect()",
    "    var dpr = Math.min(window.devicePixelRatio || 1, 2)",
    "    viewWidth = Math.max(1, Math.round(rect.width))",
    "    viewHeight = Math.max(1, Math.round(rect.height))",
    "    canvas.width = Math.round(viewWidth * dpr)",
    "    canvas.height = Math.round(viewHeight * dpr)",
    "    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)",
    "    ctx.textBaseline = 'top'",
    "    laneHeight = Math.max(18, Math.round(viewHeight / 16))",
    "    scrollSpeed = Math.max(120, viewWidth / 8)",
    "    clearLanes()",
    "  }",
    "",
    "  function fontOf (size) {",
    "    return 'bold ' + Math.max(10, Math.round(size * sizeScale)) + 'px \"PingFang SC\", \"Microsoft YaHei\", sans-serif'",
    "  }",
    "",
    "  // 找一条空着的轨道：上一批弹幕的尾巴还没进画面，就说明这条轨道还占着",
    "  function pickLane (lanes, now, busyMs) {",
    "    for (var i = 0; i < lanes.length; i++) {",
    "      if (lanes[i] <= now) { lanes[i] = now + busyMs; return i }",
    "    }",
    "    lanes.push(now + busyMs)",
    "    return lanes.length - 1",
    "  }",
    "",
    "  function push (item, now) {",
    "    if (!item || !item.text) return",
    "    var size = Number(item.size) || 25",
    "    ctx.font = fontOf(size)",
    "    var width = ctx.measureText(String(item.text)).width",
    "    var mode = Number(item.mode) || 1",
    "    var fixed = mode === 4 || mode === 5",
    "    var lanes = fixed ? (mode === 4 ? bottomLanes : topLanes) : scrollLanes",
    "    var busy = fixed ? FIXED_MS : ((width + GAP) / scrollSpeed) * 1000",
    "    var lane = pickLane(lanes, now, busy)",
    "    if (lane >= laneCount()) return",
    "    var y = mode === 4",
    "      ? viewHeight - (lane + 1) * laneHeight",
    "      : lane * laneHeight",
    "    if (y < 0) y = 0",
    "    active.push({",
    "      text: String(item.text),",
    "      color: Number(item.color),",
    "      size: size,",
    "      mode: mode,",
    "      width: width,",
    "      x: viewWidth,",
    "      y: y,",
    "      bornAt: now",
    "    })",
    "  }",
    "",
    "  // 重新定位游标：拖动进度条之后不能把前面几千条一次性补画出来",
    "  function reset (timeMs) {",
    "    clearLanes()",
    "    cursor = 0",
    "    for (var i = 0; i < items.length; i++) {",
    "      if (Number(items[i].time) >= timeMs) { cursor = i; break }",
    "      cursor = i + 1",
    "    }",
    "  }",
    "",
    "  function colorOf (value) {",
    "    var n = Number(value)",
    "    if (!isFinite(n) || n < 0) n = 16777215",
    "    var hex = Math.floor(n).toString(16)",
    "    while (hex.length < 6) hex = '0' + hex",
    "    return '#' + hex.slice(-6)",
    "  }",
    "",
    "  function luminance (value) {",
    "    var n = Number(value)",
    "    if (!isFinite(n) || n < 0) n = 16777215",
    "    var r = (n >> 16) & 255",
    "    var g = (n >> 8) & 255",
    "    var b = n & 255",
    "    return 0.299 * r + 0.587 * g + 0.114 * b",
    "  }",
    "",
    "  function draw (dt, now) {",
    "    ctx.clearRect(0, 0, viewWidth, viewHeight)",
    "    if (!enabled) return",
    "    for (var i = active.length - 1; i >= 0; i--) {",
    "      var item = active[i]",
    "      if (item.mode === 4 || item.mode === 5) {",
    "        if (now - item.bornAt > FIXED_MS) { active.splice(i, 1); continue }",
    "      } else {",
    "        item.x -= scrollSpeed * dt",
    "        if (item.x + item.width < 0) { active.splice(i, 1); continue }",
    "      }",
    "      var size = Math.max(10, Math.round(item.size * sizeScale))",
    "      ctx.font = fontOf(item.size)",
    "      // 深色弹幕用白描边、浅色弹幕用黑描边，亮暗画面上都看得清",
    "      ctx.lineWidth = Math.max(1.5, size / 8)",
    "      ctx.strokeStyle = luminance(item.color) > 160 ? 'rgba(0,0,0,0.72)' : 'rgba(255,255,255,0.72)'",
    "      ctx.fillStyle = colorOf(item.color)",
    "      ctx.strokeText(item.text, item.x, item.y)",
    "      ctx.fillText(item.text, item.x, item.y)",
    "    }",
    "  }",
    "",
    "  var lastFrame = 0",
    "  function frame (now) {",
    "    window.requestAnimationFrame(frame)",
    "    if (!lastFrame) lastFrame = now",
    "    var dt = Math.min(0.05, (now - lastFrame) / 1000)",
    "    lastFrame = now",
    "    if (video.paused || video.ended || video.seeking) dt = 0",
    "    var timeMs = video.currentTime * 1000",
    "    var guard = 0",
    "    while (cursor < items.length && Number(items[cursor].time) <= timeMs && guard < 40) {",
    "      push(items[cursor], now)",
    "      cursor++",
    "      guard++",
    "    }",
    "    draw(dt, now)",
    "  }",
    "",
    "  video.addEventListener('loadedmetadata', fitCanvas)",
    "  video.addEventListener('seeked', function () { reset(video.currentTime * 1000) })",
    "  video.addEventListener('error', function () {",
    "    showNotice('链接已过期或视频已被清理，请重新发一次链接让机器人解析')",
    "  })",
    "  window.addEventListener('resize', fitCanvas)",
    "",
    "  toggle.addEventListener('change', function () {",
    "    enabled = toggle.checked",
    "    canvas.style.display = enabled ? '' : 'none'",
    "  })",
    "  sizeSelect.addEventListener('change', function () {",
    "    sizeScale = SIZE_SCALE[sizeSelect.value] || 1",
    "    clearLanes()",
    "  })",
    "  opacityRange.addEventListener('input', function () {",
    "    var value = Number(opacityRange.value) || 100",
    "    canvas.style.opacity = String(value / 100)",
    "    opacityValue.textContent = value + '%'",
    "  })",
    "",
    "  fitCanvas()",
    "  window.requestAnimationFrame(frame)",
    "",
    "  fetch(API + '/danmaku')",
    "    .then(function (res) {",
    "      if (!res.ok) throw new Error('HTTP ' + res.status)",
    "      return res.json()",
    "    })",
    "    .then(function (data) {",
    "      items = (data && data.items) || []",
    "      items.sort(function (a, b) { return Number(a.time) - Number(b.time) })",
    "      countEl.textContent = String(items.length)",
    "      reset(0)",
    "    })",
    "    .catch(function (error) {",
    "      showNotice('弹幕加载失败：' + (error && error.message ? error.message : error))",
    "    })",
    "})()",
  '',
].join('\n')
