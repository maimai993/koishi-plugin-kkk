/**
 * 在线播放页（单文件 HTML）。
 *
 * ## 界面
 * 照着 **B站播放页**（夜间模式）做的：深灰底 + 白字、标题大字最多两行、下面一行小图标统计数据
 * （播放量 / 弹幕数 / 发布时间 / UP 主）、视频下方一条**弹幕控制条**（弹幕开关 + 「弹幕设置」按钮），
 * 展开的面板里放字号 / 透明度 / 显示区域，再下面是B站那种操作按钮排（点赞 / 投币 / 收藏 / 评论 / 分享）。
 * 参照截图：_sandbox-test/bili-ref-desktop.png（1440x900）与 bili-ref-mobile.png（390x844）。
 *
 * ## 硬性约束
 * - **零外网依赖**：页面里没有任何 http(s) 外链资源，图标全是内联 SVG，封面走同源
 *   `/kkk/player/<token>/cover`（登记会话时就把封面下到本地了），断网 / 内网也能正常看；
 * - 弹幕仍是 **canvas 自绘**（滚动 / 顶部 / 底部、颜色、字号、显示区域、透明度），不引第三方库；
 * - 进度条靠原生 video controls + 服务端的 HTTP Range；
 * - 用户可见文案不带 emoji（图标一律内联 SVG）。
 *
 * 注意：内联脚本是**单引号 TS 字符串数组**拼出来的，所以脚本里一律用双引号，
 * 别在数组项里写单引号（会把这个文件自己的语法搞坏）。
 */
import type { PlayerSession } from './store'

/** 页面上要显示的会话信息（作品信息都可能缺，缺了就不渲染那一块） */
export interface PlayerPageInfo extends Partial<PlayerSession> {
  token: string
}

/** HTML 文本转义（标题 / 作者都是用户内容，不能直接塞进标签里） */
function escapeHtml (value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 平台名换成中文 */
function platformLabel (platform?: string): string {
  const key = String(platform ?? '').toLowerCase()
  if (key === 'bilibili') return '哔哩哔哩'
  if (key === 'douyin') return '抖音'
  if (key === 'kuaishou') return '快手'
  if (key === 'xiaohongshu') return '小红书'
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

/** 发布时间：B站那排统计里显示的「2026-09-08 18:04:40」 */
function formatPublishDate (value?: number): string {
  const time = Number(value)
  if (!Number.isFinite(time) || time <= 0) return ''
  const date = new Date(time)
  const pad = (n: number) => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
}

/** 数字按B站的口径缩写：12345 → 1.2万，123456789 → 1.2亿 */
function formatCount (value?: number): string {
  const num = Number(value)
  if (!Number.isFinite(num) || num < 0) return ''
  if (num >= 100000000) return (num / 100000000).toFixed(1).replace(/\.0$/, '') + '亿'
  if (num >= 10000) return (num / 10000).toFixed(1).replace(/\.0$/, '') + '万'
  return String(Math.round(num))
}

/** 时长 1:02:14 / 10:24（封面角标） */
function formatDuration (seconds?: number): string {
  const total = Math.floor(Number(seconds))
  if (!Number.isFinite(total) || total <= 0) return ''
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s)
}

/** 内联 SVG 图标（用户硬性要求：不用 emoji 当图标） */
const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M7 4.8v14.4L19 12z"/></svg>',
  danmaku: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 10h6M7 14h10"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="8.4"/><path d="M12 7.6V12l3 2"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="8.4" r="3.6"/><path d="M5 20c1.6-3.7 4.1-5.4 7-5.4s5.4 1.7 7 5.4"/></svg>',
  tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M4 5.5h10l6 6.5-6 6.5H4z"/></svg>',
  like: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M7 21V10l4.2-7.4c1.5.2 2.4 1.3 2.4 2.9V9h4.6c1.3 0 2.2 1.1 2 2.4l-1.2 7A2 2 0 0 1 17 20H7z"/><path d="M3 21h4V10H3z"/></svg>',
  coin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="8.4"/><path d="M12 8.2v7.6"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="m12 4 2.5 5.2 5.5.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9 5.5-.8z"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19c0-5.4 4-8.6 9-8.6"/><path d="m13 5.6 6 4.8-6 4.8"/></svg>',
  comment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M20 14.5a2 2 0 0 1-2 2H9l-4.5 3.2V6a2 2 0 0 1 2-2H18a2 2 0 0 1 2 2z"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.4 5.4l1.9 1.9M16.7 16.7l1.9 1.9M18.6 5.4l-1.9 1.9M7.3 16.7l-1.9 1.9"/></svg>'
}

/** 公共样式：B站夜间模式那套配色（#18191c 底 + 白字） */
const BASE_STYLE = [
  '*{box-sizing:border-box}',
  ':root{--bg:#18191c;--card:#1f2024;--card2:#23252b;--line:#2b2d33;--fg:#e8eaf0;--muted:#9499a0;',
  '--pink:#fb7299;--blue:#00aeec;}',
  'html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);',
  'font-family:"PingFang SC","Microsoft YaHei","Segoe UI",system-ui,-apple-system,sans-serif;}',
  'body{min-height:100vh;-webkit-text-size-adjust:100%;}',
  'a{color:var(--blue);text-decoration:none}',
  'svg{width:1em;height:1em;display:block}'
].join('')

/** 播放页样式 */
const PLAYER_STYLE = [
  BASE_STYLE,
  '.wrap{max-width:1120px;margin:0 auto;padding:24px 16px 48px;}',
  /* 顶部：封面小卡 + 标题 + 统计行（B站标题区那一块） */
  '.head{display:flex;gap:18px;align-items:flex-start;margin-bottom:18px;}',
  '.cover{position:relative;flex:0 0 168px;width:168px;aspect-ratio:16/10;border-radius:8px;overflow:hidden;',
  'background:linear-gradient(135deg,#2b2d33,#202127);border:1px solid var(--line);}',
  '.cover img{width:100%;height:100%;object-fit:cover;display:block;}',
  '.cover .dur{position:absolute;right:6px;bottom:6px;padding:1px 5px;border-radius:4px;background:rgba(0,0,0,.72);',
  'color:#fff;font-size:12px;font-variant-numeric:tabular-nums;}',
  '.headmain{min-width:0;flex:1 1 auto;}',
  '.title{margin:0 0 10px;font-size:20px;line-height:1.45;font-weight:600;color:#fff;',
  'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;}',
  '.stats{display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px;color:var(--muted);font-size:13px;}',
  '.stat{display:inline-flex;align-items:center;gap:4px;white-space:nowrap;}',
  '.stat svg{font-size:15px;}',
  '.stat.up{color:#c9ccd3;}',
  /* 播放器卡片 */
  '.player{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;}',
  '.video-wrap{position:relative;width:100%;background:#000;line-height:0;}',
  'video{display:block;width:100%;max-height:74vh;background:#000;}',
  '#danmaku{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;}',
  '.notice{position:absolute;left:0;right:0;top:0;bottom:0;display:flex;align-items:center;justify-content:center;',
  'line-height:1.8;padding:20px;text-align:center;color:#ffd0d0;background:rgba(0,0,0,.76);font-size:14px;}',
  '.notice[hidden]{display:none}',
  /* 视频下方那条弹幕控制条（就是B站底部那条的意思） */
  '.dmbar{display:flex;align-items:center;gap:14px;padding:10px 14px;border-top:1px solid var(--line);',
  'background:var(--card2);flex-wrap:wrap;}',
  '.switch{display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none;font-size:13px;color:var(--fg);}',
  '.switch input{position:absolute;opacity:0;width:0;height:0;}',
  '.sw-track{position:relative;width:36px;height:20px;border-radius:999px;background:#3b3d44;transition:background .18s;}',
  '.sw-thumb{position:absolute;left:2px;top:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .18s;}',
  '.switch input:checked + .sw-track{background:var(--pink);}',
  '.switch input:checked + .sw-track .sw-thumb{transform:translateX(16px);}',
  '.switch input:focus-visible + .sw-track{outline:2px solid var(--blue);outline-offset:2px;}',
  '.dmbtn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;cursor:pointer;',
  'background:#2b2d33;border:1px solid #34363d;color:var(--fg);font-size:13px;font-family:inherit;}',
  '.dmbtn svg{font-size:15px}',
  '.dmbtn:hover{background:#34363d}',
  '.dmbtn.active{background:#3a2c33;border-color:var(--pink);color:#fff}',
  '.dmbar-count{margin-left:auto;color:var(--muted);font-size:13px;}',
  '.dmbar-count b{color:#c9ccd3;font-weight:600}',
  /* 弹幕设置面板（默认收起） */
  '.dmpanel{border-top:1px solid var(--line);background:#1b1c20;padding:12px 14px 14px;display:flex;flex-direction:column;gap:12px;}',
  '.dmpanel[hidden]{display:none}',
  '.dmrow{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}',
  '.dmlabel{flex:0 0 60px;color:var(--muted);font-size:13px;}',
  '.seg{display:inline-flex;background:#26282e;border:1px solid #34363d;border-radius:8px;overflow:hidden;}',
  '.segbtn{appearance:none;border:0;background:transparent;color:#c9ccd3;font-family:inherit;font-size:13px;',
  'padding:6px 14px;cursor:pointer;min-width:52px;}',
  '.segbtn + .segbtn{border-left:1px solid #34363d}',
  '.segbtn:hover{background:#2f3138}',
  '.segbtn.active{background:var(--pink);color:#fff}',
  '.dmvalue{color:#c9ccd3;font-size:13px;min-width:44px;font-variant-numeric:tabular-nums}',
  'input[type=range]{flex:1 1 160px;max-width:280px;accent-color:var(--pink);height:20px;}',
  /* B站底部那排操作按钮（纯展示，没有真实数据就不生成） */
  '.actions{display:flex;align-items:center;gap:44px;margin:18px 2px 6px;flex-wrap:wrap;}',
  '.act{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-size:14px;cursor:default;}',
  '.act svg{font-size:21px;color:#c9ccd3}',
  '.foot{margin-top:14px;color:var(--muted);font-size:12px;line-height:1.9;word-break:break-all;}',
  '.foot .dot{display:inline-block;margin:0 6px;color:#3b3d44}',
  '@media (max-width:560px){',
  '.wrap{padding:14px 12px 32px}',
  '.head{flex-direction:column;gap:12px}',
  '.cover{width:100%;flex:0 0 auto;aspect-ratio:16/9}',
  '.title{font-size:17px}',
  '.stats{font-size:12px;gap:4px 12px}',
  '.dmbar{gap:10px;padding:10px 12px}',
  '.dmbar-count{margin-left:0;width:100%}',
  '.actions{gap:0;justify-content:space-between}',
  '.act{font-size:12px;gap:4px}',
  '.act svg{font-size:19px}',
  '.segbtn{padding:8px 12px;min-width:46px}',
  // 手机上「显示区域」四个字要放得下，不然会折成两行把行高撑歪
  '.dmlabel{flex:0 0 64px}',
  'input[type=range]{flex:1 1 120px}',
  '.dmvalue{min-width:40px}',
  '}'
].join('')

/** 一条统计（图标 + 文本），没有值就不生成 */
function statHtml (icon: string, text: string, className = ''): string {
  if (!text) return ''
  return '<span class="stat ' + className + '">' + icon + '<span>' + escapeHtml(text) + '</span></span>'
}

/** 一个操作按钮（纯展示；没有真实数据就不生成，绝不编数字） */
function actionHtml (icon: string, label: string, value?: number): string {
  const count = formatCount(value)
  if (!count) return ''
  return '<span class="act">' + icon + '<span>' + escapeHtml(label) + ' ' + count + '</span></span>'
}

/**
 * 播放页正文。
 *
 * token 只允许 [0-9a-z]，直接内联进脚本是安全的；接口地址按 token 拼成绝对路径 ——
 * 页面地址是 `/kkk/player/<token>`（没有结尾斜杠），用相对路径会被解析成
 * `/kkk/player/danmaku` 这种错地址。
 * @param info 会话信息（作品字段可能缺）
 */
export function renderPlayerPage (info: PlayerPageInfo): string {
  const token = String(info.token ?? '').replace(/[^0-9a-z]/g, '')
  const title = escapeHtml(info.title || '在线播放')
  const platform = escapeHtml(platformLabel(info.platform))
  const expire = formatExpire(info.expireAt)
  const danmakuCount = Number(info.danmakuCount) || 0
  const duration = formatDuration(info.durationSeconds)
  const script = PLAYER_SCRIPT.split('__KKK_TOKEN__').join(token)

  const stats = [
    statHtml(ICON.play, formatCount(info.views), 'views'),
    statHtml(ICON.danmaku, formatCount(info.platformDanmaku ?? danmakuCount), 'danmaku'),
    statHtml(ICON.clock, formatPublishDate(info.publishedAt), 'time'),
    statHtml(ICON.up, info.author || '', 'up'),
    statHtml(ICON.tag, platform, 'tag')
  ].join('')

  const actions = [
    actionHtml(ICON.like, '点赞', info.likes),
    actionHtml(ICON.coin, '投币', info.coins),
    actionHtml(ICON.star, '收藏', info.favorites),
    actionHtml(ICON.comment, '评论', info.comments),
    actionHtml(ICON.share, '分享', info.shares)
  ].join('')

  const cover = info.cover
    ? '<div class="cover"><img src="/kkk/player/' + token + '/cover" alt="">'
      + (duration ? '<span class="dur">' + duration + '</span>' : '') + '</div>'
    : ''

  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n'
    + '<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    + '<meta name="referrer" content="no-referrer">\n'
    + '<title>' + title + '</title>\n'
    + '<style>' + PLAYER_STYLE + '</style>\n'
    + '</head>\n<body>\n'
    + '<div class="wrap">\n'
    + '  <div class="head">\n'
    + '    ' + cover + '\n'
    + '    <div class="headmain">\n'
    + '      <h1 class="title">' + title + '</h1>\n'
    + '      <div class="stats">' + stats + '</div>\n'
    + '    </div>\n'
    + '  </div>\n'
    + '  <div class="player">\n'
    + '    <div class="video-wrap">\n'
    + '      <video id="video" src="/kkk/player/' + token + '/video" controls preload="metadata" playsinline webkit-playsinline></video>\n'
    + '      <canvas id="danmaku"></canvas>\n'
    + '      <div id="notice" class="notice" hidden></div>\n'
    + '    </div>\n'
    + '    <div class="dmbar">\n'
    + '      <label class="switch"><input type="checkbox" id="dmOn" checked><span class="sw-track"><span class="sw-thumb"></span></span><span>弹幕</span></label>\n'
    + '      <button type="button" class="dmbtn" id="dmSettingsBtn" aria-expanded="false">' + ICON.gear + '<span>弹幕设置</span></button>\n'
    + '      <span class="dmbar-count">共 <b id="dmCount">' + danmakuCount + '</b> 条弹幕</span>\n'
    + '    </div>\n'
    + '    <div class="dmpanel" id="dmPanel" hidden>\n'
    + '      <div class="dmrow"><span class="dmlabel">字号</span><div class="seg" id="dmSize">'
    + '<button type="button" class="segbtn" data-value="small">小</button>'
    + '<button type="button" class="segbtn active" data-value="medium">中</button>'
    + '<button type="button" class="segbtn" data-value="large">大</button></div></div>\n'
    + '      <div class="dmrow"><span class="dmlabel">透明度</span>'
    + '<input type="range" id="dmOpacity" min="10" max="100" step="5" value="100">'
    + '<span class="dmvalue" id="dmOpacityValue">100%</span></div>\n'
    + '      <div class="dmrow"><span class="dmlabel">显示区域</span><div class="seg" id="dmArea">'
    + '<button type="button" class="segbtn" data-value="quarter">1/4</button>'
    + '<button type="button" class="segbtn active" data-value="half">半屏</button>'
    + '<button type="button" class="segbtn" data-value="full">全屏</button></div></div>\n'
    + '    </div>\n'
    + '  </div>\n'
    + (actions ? '  <div class="actions">' + actions + '</div>\n' : '')
    + '  <div class="foot">'
    + (expire ? '链接有效期至 ' + expire + '<span class="dot">|</span>' : '')
    + '过期后视频与弹幕会被自动清理<span class="dot">|</span>进度条可直接拖动'
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
    + '.box{max-width:520px;margin:18vh auto 0;padding:0 24px;text-align:center;}'
    + '.box h1{font-size:20px;margin:0 0 12px;color:#fff;font-weight:600;}'
    + '.box p{color:var(--muted);font-size:14px;line-height:1.9;margin:0;}'
    + '</style>\n</head>\n<body>\n'
    + '<div class="box">\n<h1>链接已过期</h1>\n'
    + '<p>这个在线播放链接已经过期（或者视频已经被清理），视频与弹幕都不再保留。<br>'
    + '需要再看的话，重新发一次链接让机器人解析即可。</p>\n</div>\n'
    + '</body>\n</html>\n'
}

/**
 * 播放页的内联脚本：canvas 自绘弹幕 + 页面控件（弹幕开关 / 弹幕设置面板 / 字号 / 透明度 / 显示区域）。
 * 第三方库一个都不用，离线可用。
 */
const PLAYER_SCRIPT = [
  "(function () {",
  "  'use strict'",
  "  var TOKEN = '__KKK_TOKEN__'",
  "  var API = '/kkk/player/' + TOKEN",
  "  var notice = document.getElementById('notice')",
  "  var video = document.getElementById('video')",
  "  var canvas = document.getElementById('danmaku')",
  "  var toggle = document.getElementById('dmOn')",
  "  var countEl = document.getElementById('dmCount')",
  "  var settingsBtn = document.getElementById('dmSettingsBtn')",
  "  var settingsPanel = document.getElementById('dmPanel')",
  "  var sizeGroup = document.getElementById('dmSize')",
  "  var areaGroup = document.getElementById('dmArea')",
  "  var opacityRange = document.getElementById('dmOpacity')",
  "  var opacityValue = document.getElementById('dmOpacityValue')",
  "",
  "  /** 字号档位（B站弹幕设置里的三档） */",
  "  var SIZE_SCALE = { small: 0.75, medium: 1, large: 1.35 }",
  "  /** 显示区域：弹幕只在画面上方这块区域里跑（和B站的「显示区域」一个意思） */",
  "  var AREA_RATE = { quarter: 0.25, half: 0.5, full: 1 }",
  "",
  "  var ctx = canvas.getContext('2d')",
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
  "  var sizeScale = 1",
  "  var areaRate = 0.5",
  "  var enabled = true",
  "  var FIXED_MS = 4000",
  "  var GAP = 16",
  "",
  "  function showNotice (text) {",
  "    notice.textContent = text",
  "    notice.hidden = false",
  "  }",
  "",
  "  function laneCount () {",
  "    return Math.max(1, Math.floor(viewHeight * areaRate / laneHeight))",
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
  "    var y = mode === 4 ? viewHeight - (lane + 1) * laneHeight : lane * laneHeight",
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
  "  function reset (timeMs) {",
  "    clearLanes()",
  "    cursor = 0",
  "    for (var i = 0; i < items.length; i++) {",
  "      if (Number(items[i].time) >= timeMs) { cursor = i; break }",
  "      cursor = i + 1",
  "    }",
  "  }",
  "",
  "  function toColor (value) {",
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
  "    return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)",
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
  "      ctx.fillStyle = toColor(item.color)",
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
  "  /** 分段控件：点一个就把同组的选中态挪过去 */",
  "  function bindSeg (group, onPick) {",
  "    if (!group) return",
  "    group.addEventListener('click', function (event) {",
  "      var target = event.target",
  "      if (!target || !target.classList || !target.classList.contains('segbtn')) return",
  "      var buttons = group.querySelectorAll('.segbtn')",
  "      for (var i = 0; i < buttons.length; i++) buttons[i].classList.remove('active')",
  "      target.classList.add('active')",
  "      onPick(target.getAttribute('data-value'))",
  "    })",
  "  }",
  "",
  "  bindSeg(sizeGroup, function (value) {",
  "    sizeScale = SIZE_SCALE[value] || 1",
  "    clearLanes()",
  "  })",
  "  bindSeg(areaGroup, function (value) {",
  "    areaRate = AREA_RATE[value] || 0.5",
  "    clearLanes()",
  "  })",
  "",
  "  if (toggle) {",
  "    toggle.addEventListener('change', function () {",
  "      enabled = toggle.checked",
  "      canvas.style.display = enabled ? '' : 'none'",
  "    })",
  "  }",
  "  if (settingsBtn && settingsPanel) {",
  "    settingsBtn.addEventListener('click', function () {",
  "      var open = settingsPanel.hidden",
  "      settingsPanel.hidden = !open",
  "      settingsBtn.setAttribute('aria-expanded', open ? 'true' : 'false')",
  "      settingsBtn.classList.toggle('active', open)",
  "    })",
  "  }",
  "  if (opacityRange) {",
  "    opacityRange.addEventListener('input', function () {",
  "      var value = Number(opacityRange.value) || 100",
  "      canvas.style.opacity = String(value / 100)",
  "      if (opacityValue) opacityValue.textContent = value + '%'",
  "    })",
  "  }",
  "",
  "  video.addEventListener('loadedmetadata', fitCanvas)",
  "  video.addEventListener('seeked', function () { reset(video.currentTime * 1000) })",
  "  video.addEventListener('error', function () {",
  "    showNotice('链接已过期或视频已被清理，请重新发一次链接让机器人解析')",
  "  })",
  "  // 只有声音没有画面：多半是浏览器解不了这个视频的编码（HEVC / AV1 之类）",
  "  video.addEventListener('loadeddata', function () {",
  "    if (!video.videoWidth) {",
  "      showNotice('当前浏览器不支持这个视频的编码（只有声音没有画面），换 Chrome / Edge 新版本再试，或让管理员换一档画质重新解析')",
  "    }",
  "  })",
  "  window.addEventListener('resize', fitCanvas)",
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
  "      if (countEl) countEl.textContent = String(items.length)",
  "      reset(0)",
  "    })",
  "    .catch(function (error) {",
  "      showNotice('弹幕加载失败：' + (error && error.message ? error.message : error) + '（视频仍可播放）')",
  "    })",
  "})()",
  ''
].join('\n')
