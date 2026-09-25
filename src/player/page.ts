/**
 * 在线播放页（单文件 HTML）。
 *
 * ## 界面
 * 照着 **B站播放页**（夜间模式）做的：深灰底 + 白字、标题大字最多两行、下面一行小图标统计数据
 * （播放量 / 弹幕数 / 发布时间 / UP 主）、视频下方一条**弹幕控制条**（弹幕开关 + 「弹幕设置」按钮），
 * 播放器下面还有一个**下载按钮**（`/kkk/player/<token>/video?download=1`，服务端带 Content-Disposition），
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
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.4 5.4l1.9 1.9M16.7 16.7l1.9 1.9M18.6 5.4l-1.9 1.9M7.3 16.7l-1.9 1.9"/></svg>',
  expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  compress: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M9.4 5.4v13.2M14.6 5.4v13.2"/></svg>',
  volume: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.6 9.6h3L12 6v12l-4.4-3.6h-3z"/><path d="M15.4 9.6a3.4 3.4 0 0 1 0 4.8"/><path d="M18 7.2a7 7 0 0 1 0 9.6"/></svg>',
  muted: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.6 9.6h3L12 6v12l-4.4-3.6h-3z"/><path d="m15.8 10 4.4 4.4M20.2 10l-4.4 4.4"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6.6 6.6l10.8 10.8M17.4 6.6L6.6 17.4"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.8v10.6"/><path d="m7.7 10.2 4.3 4.3 4.3-4.3"/><path d="M4.8 19.6h14.4"/></svg>'
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
  /* 全屏：让整个 .video-wrap 进全屏，弹幕 canvas 和控制条才会一起显示（见 toggleFullscreen） */
  '.video-wrap:fullscreen,.video-wrap:-webkit-full-screen{background:#000;}',
  '.video-wrap:fullscreen video,.video-wrap:-webkit-full-screen video{width:100vw;height:100vh;max-height:none;object-fit:contain;}',
  'video{display:block;width:100%;max-height:74vh;background:#000;}',
  '#danmaku{position:absolute;left:0;top:0;width:100%;height:100%;z-index:1;pointer-events:none;}',
  '.notice{position:absolute;left:0;right:0;top:0;bottom:0;z-index:6;display:flex;align-items:center;justify-content:center;',
  'line-height:1.8;padding:20px;text-align:center;color:#ffd0d0;background:rgba(0,0,0,.76);font-size:14px;}',
  '.notice[hidden]{display:none}',
  /* 播放器内部的控制条（自己的 H5 播放器，全屏时跟着容器一起进去） */
  '.ctrl{position:absolute;left:0;right:0;bottom:0;z-index:3;display:flex;align-items:center;gap:6px;',
  'padding:22px 12px 8px;line-height:1.2;color:#fff;transition:opacity .22s;}',
  '.ctrl{background:linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.72) 46%,rgba(0,0,0,.86));}',
  // 全屏播放、鼠标不动的时候把控制条收起来（B站也是这个行为）
  '.ctrl.idle{opacity:0;pointer-events:none}',
  '.cbtn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;flex:0 0 auto;',
  'height:32px;min-width:32px;padding:0 7px;border:0;border-radius:8px;background:transparent;color:#fff;',
  'font-family:inherit;font-size:13px;cursor:pointer;}',
  '.cbtn svg{font-size:19px}',
  '.cbtn span{display:inline-flex;align-items:center}',
  '.cbtn:hover{background:rgba(255,255,255,.16)}',
  '.cbtn:focus-visible{outline:2px solid var(--pink);outline-offset:2px}',
  '.cbtn.on{background:rgba(251,114,153,.24);color:#ffd7e2}',
  '.cbtn .ico-pause,.cbtn .ico-mute,.cbtn .ico-compress{display:none}',
  '#playBtn.is-playing .ico-play{display:none}',
  '#playBtn.is-playing .ico-pause{display:inline-flex}',
  '#muteBtn.is-muted .ico-vol{display:none}',
  '#muteBtn.is-muted .ico-mute{display:inline-flex}',
  '#fullscreenBtn.in-full .ico-expand{display:none}',
  '#fullscreenBtn.in-full .ico-compress{display:inline-flex}',
  '.ctime{flex:0 0 auto;font-size:12px;color:#e8e8ea;font-variant-numeric:tabular-nums;white-space:nowrap;}',
  /* 进度条：可拖可点，带缓冲条 */
  '.prog{position:relative;flex:1 1 auto;display:flex;align-items:center;height:22px;cursor:pointer;touch-action:none;}',
  '.prog .track{position:relative;width:100%;height:3px;border-radius:2px;background:rgba(255,255,255,.26);transition:height .12s;}',
  '.prog:hover .track,.prog:focus-visible .track{height:5px}',
  '.prog .buf{position:absolute;left:0;top:0;bottom:0;border-radius:2px;background:rgba(255,255,255,.34);}',
  '.prog .fill{position:absolute;left:0;top:0;bottom:0;border-radius:2px;background:var(--pink);}',
  '.prog .dot{position:absolute;left:0;top:50%;width:11px;height:11px;margin:-5.5px 0 0 -5.5px;border-radius:50%;',
  'background:#fff;box-shadow:0 0 0 2px rgba(0,0,0,.35);}',
  '.prog:focus-visible{outline:2px solid var(--pink);outline-offset:2px;border-radius:6px}',
  /* 暂停时画面正中那个大播放按钮 */
  '.bigplay{position:absolute;left:50%;top:50%;z-index:2;width:62px;height:62px;margin:-31px 0 0 -31px;',
  'border:0;border-radius:50%;background:rgba(0,0,0,.52);color:#fff;display:flex;align-items:center;',
  'justify-content:center;cursor:pointer;transition:transform .15s,background .15s;}',
  '.bigplay svg{font-size:30px;margin-left:3px}',
  '.bigplay[hidden]{display:none}',
  '.bigplay:hover{background:rgba(251,114,153,.92);transform:scale(1.05)}',
  '.switch{display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none;font-size:13px;color:var(--fg);}',
  '.switch input{position:absolute;opacity:0;width:0;height:0;}',
  '.sw-track{position:relative;width:36px;height:20px;border-radius:999px;background:#3b3d44;transition:background .18s;flex:0 0 auto;}',
  '.sw-thumb{position:absolute;left:2px;top:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .18s;}',
  '.switch input:checked + .sw-track{background:var(--pink);}',
  '.switch input:checked + .sw-track .sw-thumb{transform:translateX(16px);}',
  '.switch input:focus-visible + .sw-track{outline:2px solid var(--blue);outline-offset:2px;}',
  /* 弹幕设置：直接浮在画面上（默认收起），全屏时也跟着一起进去 */
  '.dmpanel{position:absolute;right:12px;bottom:52px;z-index:4;width:384px;max-width:calc(100% - 24px);',
  'max-height:calc(100% - 68px);overflow:auto;display:flex;flex-direction:column;gap:12px;',
  'background:rgba(22,23,26,.95);border:1px solid #34363d;border-radius:12px;padding:10px 14px 14px;',
  'line-height:1.5;box-shadow:0 14px 36px rgba(0,0,0,.55);}',
  '.dmpanel[hidden]{display:none}',
  /* 隐藏按钮必须真的隐藏（.cbtn 的 display:inline-flex 会盖掉浏览器默认的 [hidden]） */
  '.cbtn[hidden]{display:none}',
  /*
   * 互动视频：选项 / 进度**贴在视频上**的一小块卡片（用户要求）。
   *
   * 位置贴着画面底部、控制条上方；容器本身 pointer-events:none ——
   * 只有卡片能点，其余画面照常可以点一下暂停/继续，不会出现「弹一层东西把播放器整个挡住」的割裂感。
   * 卡片在 .video-wrap 里，全屏时（整个 .video-wrap 进全屏）自动跟着一起进去。
   */
  '.story{position:absolute;left:0;right:0;bottom:56px;z-index:5;display:flex;justify-content:center;',
  'padding:0 12px;pointer-events:none;}',
  '.story[hidden]{display:none}',
  '.story-card{pointer-events:auto;width:100%;max-width:560px;max-height:min(54vh,420px);overflow:auto;',
  'display:flex;flex-direction:column;gap:10px;padding:12px 14px;border-radius:12px;line-height:1.5;color:#fff;',
  'background:rgba(18,19,22,.93);border:1px solid rgba(255,255,255,.16);box-shadow:0 12px 32px rgba(0,0,0,.5);}',
  '.story-q{font-size:14px;font-weight:600;}',
  '.story-tip{font-size:12px;color:#c9ccd3}',
  '.story-opts{display:flex;flex-direction:column;gap:8px;}',
  '.story-opt{appearance:none;display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;text-align:left;',
  'border:1px solid rgba(255,255,255,.2);border-radius:10px;background:rgba(255,255,255,.06);color:#fff;',
  'font-family:inherit;font-size:14px;cursor:pointer;}',
  '.story-opt:hover{background:rgba(251,114,153,.9);border-color:var(--pink)}',
  '.story-opt:focus-visible{outline:2px solid var(--pink);outline-offset:2px}',
  '.story-opt b{flex:0 0 auto;min-width:20px;text-align:center;color:var(--pink)}',
  '.story-opt:hover b{color:#fff}',
  /* 加载进度条（点完选项到下一段能播之间显示） */
  '.story-track{position:relative;height:4px;border-radius:2px;background:rgba(255,255,255,.24);overflow:hidden;}',
  '.story-fill{position:absolute;left:0;top:0;bottom:0;background:var(--pink);transition:width .3s;}',
  '.dmpanel-head{display:flex;align-items:center;gap:10px;font-size:13px;color:#e8e8ea;}',
  '.dmpanel-head b{flex:1 1 auto;font-weight:600}',
  '.dmpanel .dmbtn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;',
  'cursor:pointer;background:#2b2d33;border:1px solid #34363d;color:var(--fg);font-size:13px;font-family:inherit;}',
  '.dmpanel .dmbtn:hover{background:#34363d}',
  '.dmpanel .dmbtn.active{background:#3a2c33;border-color:var(--pink);color:#fff}',
  '.dmrow{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}',
  '.dmlabel{flex:0 0 60px;color:var(--muted);font-size:13px;}',
  '.dmsub{color:#6f7480;font-size:12px}',
  '.seg{display:inline-flex;background:#26282e;border:1px solid #34363d;border-radius:8px;overflow:hidden;}',
  '.segbtn{appearance:none;border:0;background:transparent;color:#c9ccd3;font-family:inherit;font-size:13px;',
  'padding:6px 14px;cursor:pointer;min-width:52px;}',
  '.segbtn + .segbtn{border-left:1px solid #34363d}',
  '.segbtn:hover{background:#2f3138}',
  '.segbtn.active{background:var(--pink);color:#fff}',
  /* 三类弹幕的开关（滚动 / 顶部 / 底部），做成可点的小胶囊 */
  '.chips{display:inline-flex;gap:8px;flex-wrap:wrap}',
  '.chip{appearance:none;border:1px solid #34363d;background:#26282e;color:#8f95a3;font-family:inherit;font-size:13px;',
  'padding:5px 14px;border-radius:999px;cursor:pointer;}',
  '.chip:hover{background:#2f3138}',
  '.chip.active{background:rgba(251,114,153,.16);border-color:var(--pink);color:#ffd7e2}',
  /* 数字输入（任意整数百分比） */
  '.numwrap{display:inline-flex;align-items:center;gap:4px;background:#26282e;border:1px solid #34363d;',
  'border-radius:8px;padding:3px 8px;}',
  '.numwrap input{width:56px;background:transparent;border:0;color:var(--fg);font-family:inherit;font-size:13px;',
  'text-align:right;outline:none;font-variant-numeric:tabular-nums;}',
  '.numwrap input::-webkit-outer-spin-button,.numwrap input::-webkit-inner-spin-button{opacity:.45}',
  '.numwrap .unit{color:var(--muted);font-size:12px}',
  'input[type=range]{flex:1 1 160px;max-width:280px;accent-color:var(--pink);height:20px;}',
  /* B站底部那排操作按钮（纯展示） */
  '.actions{display:flex;align-items:center;gap:44px;margin:18px 2px 6px;flex-wrap:wrap;}',
  '.act{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-size:14px;cursor:default;}',
  '.act svg{font-size:21px;color:#c9ccd3}',
  /* 下载按钮：B站那排操作按钮里「下载」的位置，做成实心主色按钮，一眼能看见 */
  '.downbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:14px 2px 2px;}',
  /* 链接行：本页链接 + 直接跳转 / 手动复制（用户要求） */
  '.linkrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:12px 2px 2px;'
  + 'padding:10px 14px;background:var(--card);border-radius:8px;}',
  '.linklabel{color:var(--muted);font-size:13px;flex:0 0 auto;}',
  '.linktext{color:#dfe2e8;font-size:13px;word-break:break-all;flex:1 1 220px;min-width:0;}',
  '.linkbtn{height:32px;padding:0 14px;border-radius:6px;border:1px solid #3a3d44;background:#25272d;'
  + 'color:#e6e8ec;font-size:13px;cursor:pointer;}',
  '.linkbtn:hover{border-color:var(--pink);color:#fff;}',
  '.linkhint{color:var(--pink);font-size:12px;flex:0 0 auto;}',
  '.dlbtn{display:inline-flex;align-items:center;gap:8px;height:38px;padding:0 18px;border-radius:8px;',
  'background:var(--pink);color:#fff;font-size:14px;font-weight:600;cursor:pointer;}',
  '.dlbtn svg{font-size:20px}',
  '.dlbtn:hover{background:#ff8aac}',
  /** 「合成后下载」是主按钮（另外两个只是分别下载原始流），稍微区分一下 */
  '.dlbtn.main{background:#fb7299;color:#fff}',
  '.dlbtn.main:hover{background:#ff8aac}',
  '.dlbtn:focus-visible{outline:2px solid #fff;outline-offset:2px}',
  '.dlhint{color:var(--muted);font-size:12px;}',
  /* 没配公网地址时的提示条：用户打不开得知道是「没配域名」，不是「插件坏了」 */
  '.warnlocal{margin-top:14px;padding:10px 13px;border:1px solid #5d3a22;background:#2a1d14;color:#ffcfa8;',
  'border-radius:10px;font-size:13px;line-height:1.75;}',
  '.warnlocal b{color:#ffb27a}',
  '.foot{margin-top:14px;color:var(--muted);font-size:12px;line-height:1.9;word-break:break-all;}',
  '.foot .dot{display:inline-block;margin:0 6px;color:#3b3d44}',
  '@media (max-width:560px){',
  '.wrap{padding:14px 12px 32px}',
  '.head{flex-direction:column;gap:12px}',
  '.cover{width:100%;flex:0 0 auto;aspect-ratio:16/9}',
  '.title{font-size:17px}',
  '.stats{font-size:12px;gap:4px 12px}',
  '.ctrl{gap:4px;padding:20px 8px 6px}',
  '.cbtn{height:30px;min-width:30px;padding:0 5px}',
  '.ctime{font-size:11px}',
  '.dmpanel{left:8px;right:8px;bottom:44px;width:auto;max-width:none;padding:8px 10px 10px;gap:8px;',
  '-webkit-overflow-scrolling:touch}',
  '.dmpanel .dmrow{gap:8px}',
  '.dmpanel .dmlabel{flex:0 0 50px}',
  '.dmpanel-head{gap:6px}',
  '.actions{gap:0;justify-content:space-between}',
  '.downbar{margin-top:12px}',
  '.dlbtn{height:36px;padding:0 14px;font-size:13px}',
  '.act{font-size:12px;gap:4px}',
  '.act svg{font-size:19px}',
  '.segbtn{padding:8px 12px;min-width:46px}',
  '.chip{padding:7px 14px}',
  '.dmlabel{flex:0 0 64px}',
  '.numwrap input{width:48px}',
  'input[type=range]{flex:1 1 120px}',
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
  /** 有没有**单独的音轨**（B站这类音视频分离的）：有就 <video muted> + <audio> 同时播 */
  const hasAudio = typeof info.audioPath === 'string' && info.audioPath.length > 0
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

  /**
   * 链接行（用户要求）：把「本页链接」显示出来，下面配两个按钮 ——
   *   - 直接跳转：新标签打开这条链接（QQ 内置浏览器里想换系统浏览器时很有用）；
   *   - 手动复制：复制到剪贴板（失败就退化成可全选的文本框，QQ 里长按也能复制）。
   * 真地址在浏览器里由脚本填（服务端不知道用户到底是从哪个域名/端口进来的，反代场景尤其如此）。
   * 点完任一按钮就把原始链接文本收起来（用户要求：点击后删除链接的显示），页面干净些。
   */
  const linkRow = '<div class="linkrow">'
    + '<span class="linklabel">本页链接</span>'
    + '<span class="linktext" id="pageLinkText">（正在获取…）</span>'
    + '<button type="button" class="linkbtn" id="pageLinkJump">直接跳转</button>'
    + '<button type="button" class="linkbtn" id="pageLinkCopy">手动复制</button>'
    + '<span class="linkhint" id="pageLinkHint"></span>'
    + '</div>'

  /**
   * 原视频链接（用户要求）。
   *
   * 播放页上写「本页链接」其实没什么意义 —— 用户已经站在这个页面上了；
   * 真正有用的是「原视频在哪」：想去发弹幕、看评论区、转发给朋友，都得回平台。
   * 所以这一行显示**平台上的原链接**（B站/抖音），点一下直接过去，也能一键复制。
   * 平台没给链接（拿不到）就整行不渲染，绝不编一个出来。
   */
  const sourceRow = info.sourceUrl
    ? '<div class="linkrow">'
      + '<span class="linklabel">原视频</span>'
      + '<a class="linktext" id="pageSourceLink" href="' + escapeHtml(info.sourceUrl)
      + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(info.sourceUrl) + '</a>'
      + '<button type="button" class="linkbtn" id="pageSourceOpen">'
      + (platform ? '在' + platform + '打开' : '打开原视频') + '</button>'
      + '<button type="button" class="linkbtn" id="pageSourceCopy">复制原链接</button>'
      + '<span class="linkhint" id="pageSourceHint"></span>'
      + '</div>'
    : ''

  const cover = info.cover
    ? '<div class="cover"><img src="/kkk/player/' + token + '/cover" alt="">'
      + (duration ? '<span class="dur">' + duration + '</span>' : '') + '</div>'
    : ''

  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n'
    + '<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    + '<meta name="referrer" content="no-referrer">\n'
    // 空 data URI 图标：不然浏览器会去请求 /favicon.ico 打个 404（用户日志里看到过）
    + '<link rel="icon" href="data:,">\n'
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
    + '    <div class="video-wrap" id="videoWrap">\n'
    /**
     * 音视频分离时：视频**静音**播画面，声音交给下面这个 <audio> 一起播
     * （用户要求：默认不在服务器合成，浏览器端同时播放即可）。
     */
    + '      <video id="video" src="/kkk/player/' + token + '/video" preload="metadata" playsinline webkit-playsinline' + (hasAudio ? ' muted' : '') + '></video>\n'
    + (hasAudio ? '      <audio id="audioTrack" src="/kkk/player/' + token + '/audio" preload="auto"></audio>\n' : '')
    + '      <canvas id="danmaku"></canvas>\n'
    /**
     * 互动视频的选项覆盖层（用户要求）：直接浮在画面上，全屏时也看得见、点得动。
     * 内容由脚本按接口返回的剧情动态渲染（有选项才出现，普通视频全程隐藏）。
     */
    + '      <div class="story" id="story" hidden></div>\n'
    + '      <div id="notice" class="notice" hidden></div>\n'
    + '      <button type="button" class="bigplay" id="bigPlay" aria-label="播放">' + ICON.play + '</button>\n'
    + '      <div class="ctrl" id="ctrl">\n'
    + '        <button type="button" class="cbtn" id="playBtn" aria-label="播放 / 暂停"><span class="ico-play">' + ICON.play + '</span><span class="ico-pause">' + ICON.pause + '</span></button>\n'
    + '        <span class="ctime" id="timeLabel">00:00 / 00:00</span>\n'
    + '        <div class="prog" id="prog" role="slider" tabindex="0" aria-label="播放进度"><div class="track"><div class="buf" id="progBuf"></div><div class="fill" id="progFill"></div></div><div class="dot" id="progDot"></div></div>\n'
    + '        <button type="button" class="cbtn" id="muteBtn" aria-label="静音"><span class="ico-vol">' + ICON.volume + '</span><span class="ico-mute">' + ICON.muted + '</span></button>\n'
    + '        <button type="button" class="cbtn" id="storyBtn" hidden aria-label="互动剧情选项">' + ICON.tag + '<span>选项</span></button>\n'
    + '        <button type="button" class="cbtn" id="dmSettingsBtn" aria-expanded="false" aria-label="弹幕设置">' + ICON.gear + '<span>弹幕设置</span></button>\n'
    + '        <button type="button" class="cbtn" id="fullscreenBtn" aria-pressed="false" aria-label="全屏"><span class="ico-expand">' + ICON.expand + '</span><span class="ico-compress">' + ICON.compress + '</span></button>\n'
    + '      </div>\n'
    + '      <div class="dmpanel" id="dmPanel" hidden>\n'
    + '        <div class="dmpanel-head"><b>弹幕设置</b><span class="dmsub">共 <b id="dmCount">' + danmakuCount + '</b> 条</span>'
    + '<button type="button" class="cbtn" id="dmPanelClose" aria-label="收起设置">' + ICON.close + '</button></div>\n'
    + '        <div class="dmrow"><span class="dmlabel">弹幕</span>'
    + '<label class="switch"><input type="checkbox" id="dmOn" checked><span class="sw-track"><span class="sw-thumb"></span></span><span>开启弹幕</span></label>'
    + '<span class="dmsub">关掉就清空画面</span></div>\n'
    + '        <div class="dmrow"><span class="dmlabel">字号</span><div class="seg" id="dmSize">'
    + '<button type="button" class="segbtn active" data-value="small">小</button>'
    + '<button type="button" class="segbtn" data-value="medium">中</button>'
    + '<button type="button" class="segbtn" data-value="large">大</button></div>'
    + '<span class="numwrap"><input type="number" id="dmSizeValue" min="50" max="200" step="1" value="75" inputmode="numeric" aria-label="弹幕字号百分比"><span class="unit">%</span></span></div>\n'
    + '        <div class="dmrow"><span class="dmlabel">透明度</span>'
    + '<input type="range" id="dmOpacity" min="0" max="100" step="1" value="50">'
    + '<span class="numwrap"><input type="number" id="dmOpacityValue" min="0" max="100" step="1" value="50" inputmode="numeric" aria-label="弹幕透明度百分比"><span class="unit">%</span></span></div>\n'
    + '        <div class="dmrow"><span class="dmlabel">显示区域</span><div class="seg" id="dmArea">'
    + '<button type="button" class="segbtn active" data-value="quarter">1/4</button>'
    + '<button type="button" class="segbtn" data-value="half">半屏</button>'
    + '<button type="button" class="segbtn" data-value="full">全屏</button></div></div>\n'
    + '        <div class="dmrow"><span class="dmlabel">弹幕类型</span><div class="chips" id="dmType">'
    + '<button type="button" class="chip active" data-type="scroll" aria-pressed="true">滚动</button>'
    + '<button type="button" class="chip active" data-type="top" aria-pressed="true">顶部</button>'
    + '<button type="button" class="chip active" data-type="bottom" aria-pressed="true">底部</button></div></div>\n'
    + '        <div class="dmrow"><span class="dmlabel">颜色</span>'
    + '<label class="switch"><input type="checkbox" id="dmColored" checked><span class="sw-track"><span class="sw-thumb"></span></span><span>彩色弹幕</span></label>'
    + '<span class="dmsub">关掉后统一白色</span></div>\n'
    + '      </div>\n'
    + '    </div>\n'
    + '  </div>\n'
    /**
     * 下载按钮（用户要求「网页界面可以下载」）：
     * 走 `/video?download=1`，服务端会带上 `Content-Disposition: attachment` 与处理过的文件名。
     * 放在播放器下面单独一条 —— 作品信息可能缺（那时不会渲染操作按钮排），下载入口不能跟着一起消失。
     */
    + '  <div class="downbar">'
    + (hasAudio
      /**
       * 音视频分离：给两个「分别下载」+ 一个「服务器合成后下载」。
       * 分别是秒下（就是两个原文件），合成那条第一次点要等一两秒（服务器跑一次 ffmpeg -c copy）。
       */
      ? '<a class="dlbtn" href="/kkk/player/' + token + '/video?download=1" download>'
        + ICON.download + '<span>下载画面</span></a>'
        + '<a class="dlbtn" href="/kkk/player/' + token + '/audio?download=1" download>'
        + ICON.download + '<span>下载声音</span></a>'
        + '<a class="dlbtn main" href="/kkk/player/' + token + '/merged?download=1" download>'
        + ICON.download + '<span>合成后下载</span></a>'
        + '<span class="dlhint">画面与声音是分开的两条流：前两个直接下载，最后一个由服务器合成成一个视频（第一次要等一两秒）；'
        + '想在播放器里看就直接播放，声音会自动跟上</span>'
      : '<a class="dlbtn" id="downloadBtn" href="/kkk/player/' + token + '/video?download=1" download>'
        + ICON.download + '<span>下载视频</span></a>'
        + '<span class="dlhint">保存到本机（原画质，不重新编码）</span>')
    + '</div>\n'
    + sourceRow + linkRow + '\n'
    + (actions ? '  <div class="actions">' + actions + '</div>\n' : '')
    + (info.localOnly
      ? '  <div class="warnlocal"><b>未配置公网地址，仅本机可访问</b>：这条链接用的是管理员机器的本机地址，'
        + '只有本机 / 内网能打开。公网访问请让管理员在「通用 → 在线播放器设置 → 播放器公网地址」里填上自己的域名'
        + '（就是用户能访问到的那个域名），再用 Nginx / Caddy 之类把域名代理到播放器端口。</div>\n'
      : '')
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
/**
 * 「直接跳转 / 手动复制」两个按钮的行为（播放页与过期页共用一份逻辑）。
 *
 * 真地址用 `location.href` 在浏览器里取：服务端不知道用户是从哪个域名/端口进来的
 * （配了公网地址 + 反向代理时更是如此），写死服务端看到的地址会给出错链接。
 * 剪贴板 API 在 http / QQ 内置浏览器里可能不可用，失败就退化成可全选的文本框。
 */
const EXPIRED_LINK_SCRIPT = [
  "(function () {",
  "  'use strict'",
  "  var textEl = document.getElementById('pageLinkText')",
  "  var hintEl = document.getElementById('pageLinkHint')",
  "  var jumpBtn = document.getElementById('pageLinkJump')",
  "  var copyBtn = document.getElementById('pageLinkCopy')",
  "  var pageUrl = location.href",
  "  if (textEl) textEl.textContent = pageUrl",
  "  /** 点完按钮收起原始链接文本（用户要求：点击后删除链接的显示） */",
  "  function collapseLink (hint) {",
  "    if (textEl) { textEl.textContent = '（链接已收起，点上方按钮仍可使用）'; textEl.style.color = '#7d818a' }",
  "    if (hintEl) hintEl.textContent = hint || ''",
  "  }",
  "  if (jumpBtn) jumpBtn.addEventListener('click', function () {",
  "    window.open(pageUrl, '_blank', 'noopener')",
  "    collapseLink('已在新标签打开')",
  "  })",
  "  if (copyBtn) copyBtn.addEventListener('click', function () {",
  "    function fallbackCopy () {",
  "      var ta = document.createElement('textarea')",
  "      ta.value = pageUrl",
  "      ta.style.position = 'fixed'; ta.style.opacity = '0'",
  "      document.body.appendChild(ta)",
  "      ta.select(); ta.setSelectionRange(0, ta.value.length)",
  "      var ok = false",
  "      try { ok = document.execCommand('copy') } catch (err) { ok = false }",
  "      document.body.removeChild(ta)",
  "      collapseLink(ok ? '已复制' : '复制失败，请长按上面的链接文本手动复制')",
  "      return ok",
  "    }",
  "    if (navigator.clipboard && navigator.clipboard.writeText) {",
  "      navigator.clipboard.writeText(pageUrl).then(function () { collapseLink('已复制') }, fallbackCopy)",
  "    } else {",
  "      fallbackCopy()",
  "    }",
  "  })",
  "})()"
].join('\n')

export function renderExpiredPage (): string {
  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n'
    + '<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<title>链接已过期</title>\n'
    + '<style>' + BASE_STYLE
    + '.box{max-width:520px;margin:18vh auto 0;padding:0 24px;text-align:center;}'
    + '.box h1{font-size:20px;margin:0 0 12px;color:#fff;font-weight:600;}'
    + '.box p{color:var(--muted);font-size:14px;line-height:1.9;margin:0;}'
    + '.linkrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:center;'
    + 'margin-top:18px;padding:10px 14px;background:var(--card);border-radius:8px;}'
    + '.linklabel{color:var(--muted);font-size:13px;}'
    + '.linktext{color:#dfe2e8;font-size:13px;word-break:break-all;flex:1 1 200px;min-width:0;text-align:left;}'
    + '.linkbtn{height:32px;padding:0 14px;border-radius:6px;border:1px solid #3a3d44;background:#25272d;'
    + 'color:#e6e8ec;font-size:13px;cursor:pointer;}'
    + '.linkbtn:hover{border-color:var(--pink);color:#fff;}'
    + '.linkhint{color:var(--pink);font-size:12px;}'
    + '</style>\n</head>\n<body>\n'
    /**
     * 过期页的内联脚本：跟播放页那两个按钮同一套行为（填链接 / 跳转 / 复制 / 点击后收起链接文本）。
     * 单独放一份是因为过期页不加载播放器脚本（那边有 canvas 弹幕那一大坨，没必要带进来）。
     */
    + '<script>' + EXPIRED_LINK_SCRIPT + '<\/script>'
    + '<div class="box">\n<h1>链接已过期</h1>\n'
    + '<p>这个在线播放链接已经过期（或者视频已经被清理），视频与弹幕都不再保留。<br>'
    + '需要再看的话，重新发一次链接让机器人解析即可。</p>\n'
    /**
     * 过期页也给「直接跳转 / 手动复制」两个按钮（用户要求）：
     * 用户往往是点聊天记录里的旧链接进来的，这时能直接复制这条链接去别处重试、或换浏览器打开。
     */
    + '<div class="linkrow">'
    + '<span class="linklabel">这条链接</span>'
    + '<span class="linktext" id="pageLinkText">（正在获取…）</span>'
    + '<button type="button" class="linkbtn" id="pageLinkJump">直接跳转</button>'
    + '<button type="button" class="linkbtn" id="pageLinkCopy">手动复制</button>'
    + '<span class="linkhint" id="pageLinkHint"></span>'
    + '</div>\n'
    + '</div>\n'
    + '<script>' + EXPIRED_LINK_SCRIPT + '</script>\n'
    + '</body>\n</html>\n'
}


/**
 * 播放页的内联脚本：canvas 自绘弹幕 + 弹幕设置面板。
 *
 * 面板里能调的（全部实时生效）：弹幕开关 / 字号（档位 + 任意百分比）/ 透明度（滑块 + 任意百分比）/
 * 显示区域 / 三类弹幕各自开关（滚动·顶部·底部）/ 彩色弹幕开关。
 * 里面标了 KKK-DANMAKU-PURE 的那段是**纯计算**（类型判定、颜色、轨道位置、尺寸比例），
 * 冒烟测试会把它抠出来在 Node 里直接断言，不用起浏览器。
 */
const PLAYER_SCRIPT = [
  "(function () {",
  "  'use strict'",
  "  var TOKEN = '__KKK_TOKEN__'",
  "  var API = '/kkk/player/' + TOKEN",
  "  /* KKK-DANMAKU-PURE-START */",
  "  /**",
  "   * 弹幕渲染里「纯计算」的那部分：类型判定 / 颜色 / 轨道位置 / 尺寸比例。",
  "   * 单独抽出来是为了能被冒烟测试直接断言（在 Node 里 eval 这段就行，不依赖浏览器）。",
  "   */",
  "  var KKK_DANMAKU_PURE = (function () {",
  "    /** 弹幕类型：B站 1/2/3 滚动、4 底部、5 顶部 */",
  "    function classify (mode) {",
  "      var value = Number(mode)",
  "      if (value === 4) return 'bottom'",
  "      if (value === 5) return 'top'",
  "      return 'scroll'",
  "    }",
  "    /** 弹幕自带颜色（十进制 RGB）→ #rrggbb；关掉彩色弹幕就统一白字 */",
  "    function colorOf (color, colored) {",
  "      if (colored === false) return '#ffffff'",
  "      var n = Number(color)",
  "      if (!isFinite(n) || n < 0) n = 16777215",
  "      return '#' + ('000000' + Math.floor(n).toString(16)).slice(-6)",
  "    }",
  "    /** 底色偏暗（白字看不清）就返回 true —— 用来决定描边用黑还是用白 */",
  "    function isDark (color) {",
  "      var n = Number(color)",
  "      if (!isFinite(n) || n < 0) n = 16777215",
  "      return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) < 160",
  "    }",
  "    /** 这一类弹幕现在显不显示（三类各自可以开关） */",
  "    function visible (mode, kinds) {",
  "      if (!kinds) return true",
  "      return kinds[classify(mode)] !== false",
  "    }",
  "    /**",
  "     * 轨道位置：顶部贴顶往下排、底部贴底往上排、滚动也是从顶部往下排。",
  "     * @param mode 弹幕类型",
  "     * @param lane 第几条轨道（从 0 开始）",
  "     * @param viewHeight 画面高度",
  "     * @param laneHeight 单条轨道高度",
  "     * @param laneCount 可用轨道数",
  "     */",
  "    function laneY (mode, lane, viewHeight, laneHeight, laneCount) {",
  "      var kind = classify(mode)",
  "      var index = Math.max(0, Math.min(Number(lane) || 0, Math.max(0, laneCount - 1)))",
  "      if (kind === 'bottom') return Math.max(0, viewHeight - (index + 1) * laneHeight)",
  "      return index * laneHeight",
  "    }",
  "    /** 字号百分比 → 缩放系数（夹在 0.5~2 之间，避免一个手滑把弹幕撑爆屏幕） */",
  "    function sizeScaleOf (percent) {",
  "      var n = Number(percent)",
  "      if (!isFinite(n) || n <= 0) n = 100",
  "      return Math.min(2, Math.max(0.5, n / 100))",
  "    }",
  "    /** 数值输入框的夹紧（允许任意整数百分比） */",
  "    function clampInt (value, min, max, fallback) {",
  "      var n = Math.round(Number(value))",
  "      if (!isFinite(n)) n = fallback",
  "      return Math.min(max, Math.max(min, n))",
  "    }",
  "    return {",
  "      classify: classify,",
  "      colorOf: colorOf,",
  "      isDark: isDark,",
  "      visible: visible,",
  "      laneY: laneY,",
  "      sizeScaleOf: sizeScaleOf,",
  "      clampInt: clampInt",
  "    }",
  "  })()",
  "  /* KKK-DANMAKU-PURE-END */",
  "",
  "  var PURE = KKK_DANMAKU_PURE",
  "  var notice = document.getElementById('notice')",
  "  var video = document.getElementById('video')",
  "  var canvas = document.getElementById('danmaku')",
  "  /**",
  "   * 单独的音轨（B站这类音视频分离的）。有它的时候：",
  "   *   - 视频元素是 muted 的（只出画面），声音由这个 <audio> 出；",
  "   *   - 播放 / 暂停 / 拖动进度都要**带着它一起**，否则声音会跟画面错开。",
  "   */",
  "  var audioTrack = document.getElementById('audioTrack')",
  "  /** 音量控制作用在谁身上：有独立音轨就是音轨，否则是视频自己 */",
  "  var soundEl = audioTrack || video",
  "  var toggle = document.getElementById('dmOn')",
  "  var countEl = document.getElementById('dmCount')",
  "  var settingsBtn = document.getElementById('dmSettingsBtn')",
  "  var settingsPanel = document.getElementById('dmPanel')",
  "  var fullscreenBtn = document.getElementById('fullscreenBtn')",
  "  var panelClose = document.getElementById('dmPanelClose')",
  "  var wrapEl = document.getElementById('videoWrap')",
  "  var ctrl = document.getElementById('ctrl')",
  "  var playBtn = document.getElementById('playBtn')",
  "  var bigPlay = document.getElementById('bigPlay')",
  "  var muteBtn = document.getElementById('muteBtn')",
  "  var prog = document.getElementById('prog')",
  "  var progBuf = document.getElementById('progBuf')",
  "  var progFill = document.getElementById('progFill')",
  "  var progDot = document.getElementById('progDot')",
  "  var timeLabel = document.getElementById('timeLabel')",
  "  var sizeGroup = document.getElementById('dmSize')",
  "  var sizeInput = document.getElementById('dmSizeValue')",
  "  var areaGroup = document.getElementById('dmArea')",
  "  var typeGroup = document.getElementById('dmType')",
  "  var opacityRange = document.getElementById('dmOpacity')",
  "  var opacityInput = document.getElementById('dmOpacityValue')",
  "  var coloredBox = document.getElementById('dmColored')",
  "",
  "  /** 显示区域：弹幕只在画面上方这块区域里跑 */",
  "  var AREA_RATE = { quarter: 0.25, half: 0.5, full: 1 }",
  "  /** 字号档位（点了会把百分比也一起改掉） */",
  "  var SIZE_PRESET = { small: 75, medium: 100, large: 135 }",
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
  "  var enabled = true",
  "  var FIXED_MS = 4000",
  "  var GAP = 16",
  "  /** 用户在「弹幕设置」里调的东西：全部实时生效 */",
  "  // 默认值：字号 小（75%）、透明度 50%、显示区域 1/4（用户要求）",
  "  var sizePercent = 75",
  "  var opacityPercent = 50",
  "  var areaRate = 0.25",
  "  var colored = true",
  "  var kinds = { scroll: true, top: true, bottom: true }",
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
  "    // 重排并且把最近 4 秒的弹幕补回画面上（只 clearLanes 会让刚进全屏的画面空掉）",
  "    resync()",
  "  }",
  "",
  "  function fontOf (size) {",
  "    var scale = PURE.sizeScaleOf(sizePercent)",
  "    return 'bold ' + Math.max(10, Math.round(size * scale)) + 'px \"PingFang SC\", \"Microsoft YaHei\", sans-serif'",
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
  "    if (!PURE.visible(item.mode, kinds)) return",
  "    var size = Number(item.size) || 25",
  "    ctx.font = fontOf(size)",
  "    var width = ctx.measureText(String(item.text)).width",
  "    var kind = PURE.classify(item.mode)",
  "    var lanes = kind === 'scroll' ? scrollLanes : (kind === 'top' ? topLanes : bottomLanes)",
  "    var busy = kind === 'scroll' ? ((width + GAP) / scrollSpeed) * 1000 : FIXED_MS",
  "    var lane = pickLane(lanes, now, busy)",
  "    if (lane >= laneCount()) return",
  "    active.push({",
  "      text: String(item.text),",
  "      color: Number(item.color),",
  "      size: size,",
  "      kind: kind,",
  "      width: width,",
  "      x: viewWidth,",
  "      y: PURE.laneY(item.mode, lane, viewHeight, laneHeight, laneCount()),",
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
  "  /**",
  "   * 画布尺寸变了（窗口缩放 / 进全屏 / 退全屏）之后重排。",
  "   *",
  "   * clearLanes 会把画面上的弹幕全清掉；如果只清不补，画面会一直空到「下一条弹幕的时间」为止",
  "   * —— 实测就是这个症状：一进全屏弹幕就再也没出现过（弹幕时间早就过去了，cursor 不会回头）。",
  "   * 所以这里把最近 4 秒的弹幕重新放回画面上（顶/底固定的原样回来，滚动的从右边重新进场）。",
  "   */",
  "  function resync () {",
  "    var now = window.performance && window.performance.now ? window.performance.now() : Date.now()",
  "    var timeMs = video.currentTime * 1000",
  "    reset(timeMs - FIXED_MS)",
  "    var guard = 0",
  "    while (cursor < items.length && Number(items[cursor].time) <= timeMs && guard < 60) {",
  "      push(items[cursor], now)",
  "      cursor++",
  "      guard++",
  "    }",
  "  }",
  "",
  "  function draw (dt, now) {",
  "    ctx.clearRect(0, 0, viewWidth, viewHeight)",
  "    if (!enabled) return",
  "    for (var i = active.length - 1; i >= 0; i--) {",
  "      var item = active[i]",
  "      if (item.kind === 'scroll') {",
  "        item.x -= scrollSpeed * dt",
  "        if (item.x + item.width < 0) { active.splice(i, 1); continue }",
  "      } else if (now - item.bornAt > FIXED_MS) {",
  "        active.splice(i, 1)",
  "        continue",
  "      }",
  "      var scale = PURE.sizeScaleOf(sizePercent)",
  "      var size = Math.max(10, Math.round(item.size * scale))",
  "      ctx.font = fontOf(item.size)",
  "      // 亮色弹幕用黑描边、深色弹幕用白描边：亮背景上也看得清",
  "      ctx.lineWidth = Math.max(1.5, size / 8)",
  "      ctx.strokeStyle = PURE.isDark(item.color) && colored ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.78)'",
  "      ctx.fillStyle = PURE.colorOf(item.color, colored)",
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
  "    // 音画同步：偏差超过 0.25 秒就拉回来（长时间播放 / 卡顿后必须对一次）",
  "    if (audioTrack && !video.paused && !video.ended && !video.seeking) alignAudio()",
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
  "  /** 把某个分组里 data-value 对应的按钮标成选中 */",
  "  function markSeg (group, value) {",
  "    if (!group) return",
  "    var buttons = group.querySelectorAll('.segbtn')",
  "    for (var i = 0; i < buttons.length; i++) {",
  "      buttons[i].classList.toggle('active', buttons[i].getAttribute('data-value') === value)",
  "    }",
  "  }",
  "",
  "  function applyOpacity (value) {",
  "    opacityPercent = value",
  "    canvas.style.opacity = String(value / 100)",
  "    if (opacityRange) opacityRange.value = String(value)",
  "    if (opacityInput && String(opacityInput.value) !== String(value)) opacityInput.value = String(value)",
  "  }",
  "",
  "  function applySize (value) {",
  "    sizePercent = value",
  "    if (sizeInput && String(sizeInput.value) !== String(value)) sizeInput.value = String(value)",
  "    var preset = null",
  "    for (var key in SIZE_PRESET) {",
  "      if (SIZE_PRESET[key] === value) preset = key",
  "    }",
  "    if (preset) markSeg(sizeGroup, preset)",
  "    else {",
  "      // 自定义百分比：档位按钮全部取消选中",
  "      if (sizeGroup) {",
  "        var buttons = sizeGroup.querySelectorAll('.segbtn')",
  "        for (var i = 0; i < buttons.length; i++) buttons[i].classList.remove('active')",
  "      }",
  "    }",
  "    clearLanes()",
  "  }",
  "",
  "  bindSeg(sizeGroup, function (value) {",
  "    applySize(SIZE_PRESET[value] || 100)",
  "  })",
  "  bindSeg(areaGroup, function (value) {",
  "    areaRate = AREA_RATE[value] || 0.5",
  "    clearLanes()",
  "  })",
  "",
  "  // 透明度：滑块和数字框双向同步，0~100 任意整数",
  "  if (opacityRange) {",
  "    opacityRange.addEventListener('input', function () {",
  "      applyOpacity(PURE.clampInt(opacityRange.value, 0, 100, 100))",
  "    })",
  "  }",
  "  if (opacityInput) {",
  "    opacityInput.addEventListener('input', function () {",
  "      var raw = Number(opacityInput.value)",
  "      if (isFinite(raw) && raw >= 0 && raw <= 100) applyOpacity(Math.round(raw))",
  "    })",
  "    opacityInput.addEventListener('change', function () {",
  "      applyOpacity(PURE.clampInt(opacityInput.value, 0, 100, 100))",
  "    })",
  "  }",
  "  // 字号：档位按钮 + 任意百分比（50~200）",
  "  if (sizeInput) {",
  "    sizeInput.addEventListener('input', function () {",
  "      var raw = Number(sizeInput.value)",
  "      if (isFinite(raw) && raw >= 50 && raw <= 200) applySize(Math.round(raw))",
  "    })",
  "    sizeInput.addEventListener('change', function () {",
  "      applySize(PURE.clampInt(sizeInput.value, 50, 200, 100))",
  "    })",
  "  }",
  "  /**",
  "   * 弹幕总开关（用户实测反馈：「在线播放的弹幕开关没有用」）。",
  "   *",
  "   * 以前这里**根本没有绑定事件**：`dmOn` 这个复选框只是个摆设 ——",
  "   * `enabled` 一直是 true、谁也改不了它，点开关当然没反应。",
  "   * 现在关掉会立刻清屏，重新打开会从头排一遍弹幕（不然要等下一波才看得到）。",
  "   */",
  "  if (toggle) {",
  "    toggle.addEventListener('change', function () {",
  "      enabled = !!toggle.checked",
  "      if (!enabled) {",
  "        active = []",
  "        ctx.clearRect(0, 0, viewWidth, viewHeight)",
  "      } else {",
  "        reset(video.currentTime * 1000)",
  "      }",
  "    })",
  "  }",
  "  /** 彩色弹幕开关：同样是漏了绑定（`colored` 一直锁在 true） */",
  "  if (coloredBox) {",
  "    coloredBox.addEventListener('change', function () {",
  "      colored = !!coloredBox.checked",
  "    })",
  "  }",
  "  // 弹幕类型：滚动 / 顶部 / 底部 三类各自开关",
  "  if (typeGroup) {",
  "    typeGroup.addEventListener('click', function (event) {",
  "      var target = event.target",
  "      if (!target || !target.classList || !target.classList.contains('chip')) return",
  "      var kind = target.getAttribute('data-type')",
  "      if (!kind) return",
  "      kinds[kind] = !kinds[kind]",
  "      target.classList.toggle('active', kinds[kind])",
  "      target.setAttribute('aria-pressed', kinds[kind] ? 'true' : 'false')",
  "      if (!kinds[kind]) {",
  "        // 关掉的那一类立刻从画面上收走",
  "        for (var i = active.length - 1; i >= 0; i--) {",
  "          if (active[i].kind === kind) active.splice(i, 1)",
  "        }",
  "      }",
  "    })",
  "  }",
  "  /** 弹幕设置面板：点控制条上的齿轮展开 / 收起（默认收起），面板里的关闭按钮一样 */",
  "  function settingsOpen () { return !!(settingsPanel && !settingsPanel.hidden) }",
  "  function setSettingsOpen (open) {",
  "    if (!settingsPanel) return",
  "    settingsPanel.hidden = !open",
  "    if (settingsBtn) {",
  "      settingsBtn.setAttribute('aria-expanded', open ? 'true' : 'false')",
  "      settingsBtn.classList.toggle('on', open)",
  "    }",
  "  }",
  "  if (settingsBtn && settingsPanel) {",
  "    settingsBtn.addEventListener('click', function () {",
  "      var open = settingsPanel.hidden",
  "      settingsPanel.hidden = !open",
  "      settingsBtn.setAttribute('aria-expanded', open ? 'true' : 'false')",
  "      settingsBtn.classList.toggle('active', open)",
  "    })",
  "  }",
  "  if (panelClose) panelClose.addEventListener('click', function () { setSettingsOpen(false) })",
  "",
  "  /* ---------- 自己的 H5 播放器：播放 / 进度 / 音量 / 全屏 ---------- */",
  "",
  "  /** 秒数 → 00:00 / 1:02:03 */",
  "  function fmtTime (seconds) {",
  "    var total = Number(seconds)",
  "    if (!isFinite(total) || total < 0) total = 0",
  "    total = Math.floor(total)",
  "    var h = Math.floor(total / 3600)",
  "    var m = Math.floor((total % 3600) / 60)",
  "    var s = total % 60",
  "    return (h > 0 ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s",
  "  }",
  "",
  "  /** 进度条 + 时间；跟着 timeupdate / progress 刷就够了，不用每帧画 */",
  "  function drawProgress () {",
  "    var duration = Number(video.duration)",
  "    var rate = isFinite(duration) && duration > 0 ? Math.min(1, Math.max(0, video.currentTime / duration)) : 0",
  "    if (progFill) progFill.style.width = (rate * 100) + '%'",
  "    if (progDot) progDot.style.left = (rate * 100) + '%'",
  "    if (timeLabel) timeLabel.textContent = fmtTime(video.currentTime) + ' / ' + fmtTime(duration)",
  "    if (progBuf && isFinite(duration) && duration > 0 && video.buffered && video.buffered.length) {",
  "      var loaded = video.buffered.end(video.buffered.length - 1)",
  "      progBuf.style.width = Math.min(100, Math.max(0, loaded / duration * 100)) + '%'",
  "    }",
  "  }",
  "",
  "  function seekToRate (rate) {",
  "    var duration = Number(video.duration)",
  "    if (!isFinite(duration) || duration <= 0) return",
  "    video.currentTime = Math.min(1, Math.max(0, rate)) * duration",
  "    drawProgress()",
  "  }",
  "",
  "  function rateOfEvent (event) {",
  "    var rect = prog.getBoundingClientRect()",
  "    if (!rect.width) return 0",
  "    return (event.clientX - rect.left) / rect.width",
  "  }",
  "",
  "  // 进度条：按住拖、点一下跳、方向键微调（touch-action:none 保证手机上也能拖）",
  "  var dragging = false",
  "  if (prog) {",
  "    prog.addEventListener('pointerdown', function (event) {",
  "      dragging = true",
  "      if (prog.setPointerCapture) { try { prog.setPointerCapture(event.pointerId) } catch (error) { /* 指针捕获失败也能拖 */ } }",
  "      seekToRate(rateOfEvent(event))",
  "      wakeControls()",
  "      event.preventDefault()",
  "    })",
  "    prog.addEventListener('pointermove', function (event) { if (dragging) seekToRate(rateOfEvent(event)) })",
  "    prog.addEventListener('pointerup', function () { dragging = false })",
  "    prog.addEventListener('pointercancel', function () { dragging = false })",
  "    prog.addEventListener('keydown', function (event) {",
  "      var step = event.shiftKey ? 10 : 5",
  "      if (event.key === 'ArrowRight') { video.currentTime = Math.min(video.duration || 0, video.currentTime + step); drawProgress(); event.preventDefault() }",
  "      else if (event.key === 'ArrowLeft') { video.currentTime = Math.max(0, video.currentTime - step); drawProgress(); event.preventDefault() }",
  "    })",
  "  }",
  "",
  "  /** 把音轨拉到和画面同一个位置（拖动 / 卡顿时对表） */",
  "  function alignAudio () {",
  "    if (!audioTrack) return",
  "    try {",
  "      if (Math.abs((audioTrack.currentTime || 0) - video.currentTime) > 0.25) audioTrack.currentTime = video.currentTime",
  "    } catch (error) { /* 还没加载好就等下一帧 */ }",
  "  }",
  "",
  "  function playAudio () {",
  "    if (!audioTrack) return",
  "    alignAudio()",
  "    var started = audioTrack.play()",
  "    if (started && started.catch) started.catch(function () { /* 画面已经在放，声音起不来就先算了 */ })",
  "  }",
  "",
  "  function pauseAudio () {",
  "    if (!audioTrack) return",
  "    try { audioTrack.pause() } catch (error) { /* 忽略 */ }",
  "  }",
  "",
  "  function togglePlay () {",
  "    if (video.paused || video.ended) {",
  "      var started = video.play()",
  "      if (started && started.catch) started.catch(function () { showNotice('浏览器拦住了自动播放，点一下画面中间的播放按钮就行') })",
  "      playAudio()",
  "    } else {",
  "      video.pause()",
  "      pauseAudio()",
  "    }",
  "  }",
  "",
  "  function syncPlayState () {",
  "    var playing = !video.paused && !video.ended",
  "    if (playBtn) playBtn.classList.toggle('is-playing', playing)",
  "    if (bigPlay) bigPlay.hidden = playing",
  "    drawProgress()",
  "  }",
  "",
  "  function syncMute () {",
  "    if (muteBtn) muteBtn.classList.toggle('is-muted', soundEl.muted || soundEl.volume === 0)",
  "  }",
  "",
  "  video.addEventListener('play', function () { syncPlayState(); playAudio() })",
  "  video.addEventListener('pause', function () { syncPlayState(); pauseAudio() })",
  "  video.addEventListener('ended', function () { syncPlayState(); pauseAudio() })",
  "  video.addEventListener('timeupdate', drawProgress)",
  "  video.addEventListener('progress', drawProgress)",
  "  video.addEventListener('durationchange', drawProgress)",
  "  video.addEventListener('loadedmetadata', drawProgress)",
  "  video.addEventListener('volumechange', syncMute)",
  "  // 拖动进度（含键盘 / 快进）：画面跳完马上把音轨对齐，不然会差出好几秒",
  "  video.addEventListener('seeked', alignAudio)",
  "  if (audioTrack) {",
  "    audioTrack.addEventListener('volumechange', syncMute)",
  "    // 音轨自己卡住 / 被系统暂停时，跟着画面走",
  "    audioTrack.addEventListener('pause', function () { if (!video.paused && !video.ended) playAudio() })",
  "    audioTrack.addEventListener('error', function () { showNotice('声音加载失败，画面继续播放（可以在下面单独下载声音）') })",
  "  }",
  "  if (playBtn) playBtn.addEventListener('click', togglePlay)",
  "  if (bigPlay) bigPlay.addEventListener('click', togglePlay)",
  "  // 点画面中间也能播放 / 暂停（弹幕 canvas 是 pointer-events:none，点它等于点在 video 上）",
  "  video.addEventListener('click', togglePlay)",
  "  if (muteBtn) {",
  "    // 有独立音轨时，静音 / 取消静音作用在音轨上（视频一直是 muted 的）",
  "    if (audioTrack) soundEl.muted = true",
  "    muteBtn.addEventListener('click', function () { soundEl.muted = !soundEl.muted; syncMute() })",
  "  }",
  "",
  "  function isFullscreen () { return !!(document.fullscreenElement || document.webkitFullscreenElement) }",
  "",
  "  /** 鼠标 / 手指动一下就把控制条叫回来；全屏播放且静止 2.6 秒就自动收起（B站也是这个行为） */",
  "  var idleTimer = 0",
  "  function wakeControls () {",
  "    if (ctrl) ctrl.classList.remove('idle')",
  "    if (idleTimer) window.clearTimeout(idleTimer)",
  "    idleTimer = window.setTimeout(function () {",
  "      if (ctrl && isFullscreen() && !video.paused && !settingsOpen()) ctrl.classList.add('idle')",
  "    }, 2600)",
  "  }",
  "  if (wrapEl) {",
  "    wrapEl.addEventListener('mousemove', wakeControls)",
  "    wrapEl.addEventListener('pointerdown', wakeControls)",
  "    wrapEl.addEventListener('touchstart', wakeControls)",
  "  }",
  "",
  "  /**",
  "   * 全屏。",
  "   *",
  "   * 浏览器自带的 controls 里的全屏按钮只能让 **video 元素自己**全屏，弹幕 canvas 是它的兄弟节点，",
  "   * 全屏时只渲染全屏元素及其子孙 —— 表现就是「一全屏弹幕就没了」（用户实测反馈）。",
  "   * 也不能在 fullscreenchange 里「先退出、再对容器请求全屏」：",
  "   * 用户手势只能授权一次全屏，第二次请求会被浏览器直接拒掉，全屏会闪一下就退出。",
  "   * 所以这里不用原生控件，控制条上自己放一个全屏按钮：让整个 .video-wrap 进全屏，",
  "   * 弹幕 canvas / 控制条 / 设置面板都在容器里，自然一起进去。",
  "   */",
  "  function toggleFullscreen () {",
  "    if (isFullscreen()) {",
  "      if (document.exitFullscreen) document.exitFullscreen().catch(function () {})",
  "      else if (document.webkitExitFullscreen) document.webkitExitFullscreen()",
  "      return",
  "    }",
  "    if (!wrapEl) return",
  "    if (wrapEl.requestFullscreen) wrapEl.requestFullscreen().catch(function () {})",
  "    else if (wrapEl.webkitRequestFullscreen) wrapEl.webkitRequestFullscreen()",
  "  }",
  "  if (fullscreenBtn) fullscreenBtn.addEventListener('click', toggleFullscreen)",
  "  /** 进出全屏画布尺寸都会变：重新量一次，顺便换一下按钮图标 */",
  "  function onFullscreenChange () {",
  "    var inFull = isFullscreen()",
  "    if (fullscreenBtn) {",
  "      fullscreenBtn.classList.toggle('in-full', inFull)",
  "      fullscreenBtn.setAttribute('aria-pressed', inFull ? 'true' : 'false')",
  "      fullscreenBtn.setAttribute('aria-label', inFull ? '退出全屏' : '全屏')",
  "      fullscreenBtn.setAttribute('title', inFull ? '退出全屏' : '全屏')",
  "    }",
  "    wakeControls()",
  "    window.setTimeout(fitCanvas, 60)",
  "  }",
  "  document.addEventListener('fullscreenchange', onFullscreenChange)",
  "  document.addEventListener('webkitfullscreenchange', onFullscreenChange)",
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
  "  applyOpacity(opacityPercent)",
  "  applySize(sizePercent)",
  "  syncPlayState()",
  "  syncMute()",
  "  drawProgress()",
  "  wakeControls()",
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
  "  /* ===== 原视频链接：打开 / 复制（用户要求：这一行才有意义，本页链接用户已经在上面了） ===== */",
  "  var sourceLinkEl = document.getElementById('pageSourceLink')",
  "  var sourceCopyBtn = document.getElementById('pageSourceCopy')",
  "  var sourceOpenBtn = document.getElementById('pageSourceOpen')",
  "  var sourceHintEl = document.getElementById('pageSourceHint')",
  "  var sourceUrl = sourceLinkEl ? sourceLinkEl.getAttribute('href') : ''",
  "  /** 复制原视频链接（和本页链接同一套退化方案：剪贴板不可用就给可全选的文本框） */",
  "  function copySourceLink () {",
  "    if (!sourceUrl) return",
  "    function done (ok) { if (sourceHintEl) sourceHintEl.textContent = ok ? '已复制' : '复制失败，请长按上面的链接手动复制' }",
  "    function fallback () {",
  "      var ta = document.createElement('textarea')",
  "      ta.value = sourceUrl",
  "      ta.style.position = 'fixed'; ta.style.opacity = '0'",
  "      document.body.appendChild(ta)",
  "      ta.select(); ta.setSelectionRange(0, ta.value.length)",
  "      var ok = false",
  "      try { ok = document.execCommand('copy') } catch (err) { ok = false }",
  "      document.body.removeChild(ta)",
  "      done(ok)",
  "    }",
  "    if (navigator.clipboard && navigator.clipboard.writeText) {",
  "      navigator.clipboard.writeText(sourceUrl).then(function () { done(true) }, fallback)",
  "    } else fallback()",
  "  }",
  "  if (sourceCopyBtn) sourceCopyBtn.addEventListener('click', copySourceLink)",
  "  if (sourceOpenBtn && sourceUrl) sourceOpenBtn.addEventListener('click', function () { window.open(sourceUrl, '_blank', 'noopener') })",
  "",
  "  /* ===== 本页链接：直接跳转 / 手动复制（用户要求） ===== */",
  "  var linkTextEl = document.getElementById('pageLinkText')",
  "  var linkHintEl = document.getElementById('pageLinkHint')",
  "  var linkJumpBtn = document.getElementById('pageLinkJump')",
  "  var linkCopyBtn = document.getElementById('pageLinkCopy')",
  "  var pageUrl = location.href",
  "  if (linkTextEl) linkTextEl.textContent = pageUrl",
  "  /** 点完按钮就把原始链接文本收起来（用户要求：点击后删除链接的显示），只留一句状态 */",
  "  function collapseLink (hint) {",
  "    if (linkTextEl) { linkTextEl.textContent = '（链接已收起，点上方按钮仍可使用）'; linkTextEl.style.color = '#7d818a' }",
  "    if (linkHintEl) linkHintEl.textContent = hint || ''",
  "  }",
  "  if (linkJumpBtn) linkJumpBtn.addEventListener('click', function () {",
  "    window.open(pageUrl, '_blank', 'noopener')",
  "    collapseLink('已在新标签打开')",
  "  })",
  "  if (linkCopyBtn) linkCopyBtn.addEventListener('click', function () {",
  "    /** 剪贴板 API 在 http / 老浏览器 / QQ 内置浏览器里可能不可用，失败就给一个可全选的文本框 */",
  "    function fallbackCopy () {",
  "      var ta = document.createElement('textarea')",
  "      ta.value = pageUrl",
  "      ta.style.position = 'fixed'; ta.style.opacity = '0'",
  "      document.body.appendChild(ta)",
  "      ta.select(); ta.setSelectionRange(0, ta.value.length)",
  "      var ok = false",
  "      try { ok = document.execCommand('copy') } catch (err) { ok = false }",
  "      document.body.removeChild(ta)",
  "      if (ok) collapseLink('已复制')",
  "      else collapseLink('复制失败，请长按上面的链接文本手动复制')",
  "      return ok",
  "    }",
  "    if (navigator.clipboard && navigator.clipboard.writeText) {",
  "      navigator.clipboard.writeText(pageUrl).then(function () { collapseLink('已复制') }, fallbackCopy)",
  "    } else {",
  "      fallbackCopy()",
  "    }",
  "  })",
  "  /* ===== 互动视频：选项贴在视频上，点完显示加载进度（用户要求） ===== */",
  "  var storyEl = document.getElementById('story')",
  "  var storyBtn = document.getElementById('storyBtn')",
  "  /** 当前这一段的剧情（题目 + 选项）；null = 不是互动视频 / 还没拿到 */",
  "  var storyNode = null",
  "  /** 正在准备的那一段 cid；非空时不再接第二次点击 */",
  "  var storyPending = null",
  "  /** 进度轮询的定时器 */",
  "  var storyPollTimer = 0",
  "  /** 选项面板是不是已经贴出来了（timeupdate 每帧都会调，用它挡住重复绘制） */",
  "  var storyShown = false",
  "  /** 服务端报回来的失败原因（页面直接显示给用户，别只说一句「没准备好」） */",
  "  var storyLastReason = ''",
  "  /** 上一条被点的选项（失败后「重试」要重放的就是它） */",
  "  var storyLastChoice = null",
  "",
  "  function hideStory () {",
  "    if (storyPollTimer) { window.clearTimeout(storyPollTimer); storyPollTimer = 0 }",
  "    if (!storyEl) return",
  "    storyEl.hidden = true",
  "    storyEl.innerHTML = ''",
  "    storyShown = false",
  "  }",
  "",
  "  /** 画一张贴在视频上的小卡片（选项和进度共用，样式统一） */",
  "  function storyCard () {",
  "    storyEl.innerHTML = ''",
  "    var card = document.createElement('div')",
  "    card.className = 'story-card'",
  "    storyEl.appendChild(card)",
  "    storyEl.hidden = false",
  "    storyShown = true",
  "    return card",
  "  }",
  "",
  "  /** 选项面板：题目 + 每个选项一个按钮（用户文字一律 textContent，不拼 HTML） */",
  "  function renderStory () {",
  "    if (!storyEl || !storyNode) return",
  "    var card = storyCard()",
  "    var head = document.createElement('div')",
  "    head.className = 'story-q'",
  "    head.textContent = storyNode.isLeaf ? '互动视频走到结局了' : (storyNode.question || '接下来的剧情')",
  "    card.appendChild(head)",
  "    var choices = storyNode.choices || []",
  "    if (!choices.length) {",
  "      var ending = document.createElement('div')",
  "      ending.className = 'story-tip'",
  "      ending.textContent = '这一段没有后续了，可以重看，或者关掉页面'",
  "      card.appendChild(ending)",
  "      return",
  "    }",
  "    var box = document.createElement('div')",
  "    box.className = 'story-opts'",
  "    for (var i = 0; i < choices.length; i++) {",
  "      (function (choice, index) {",
  "        var btn = document.createElement('button')",
  "        btn.type = 'button'",
  "        btn.className = 'story-opt'",
  "        var label = document.createElement('b')",
  "        label.textContent = choice.label || String(index + 1)",
  "        var text = document.createElement('span')",
  "        text.textContent = choice.text || ('选项 ' + (index + 1))",
  "        btn.appendChild(label)",
  "        btn.appendChild(text)",
  "        btn.addEventListener('click', function (event) {",
  "          // video 上的 click 是播放/暂停：这里必须拦掉，不然点选项会顺手把视频也切了",
  "          event.stopPropagation()",
  "          wakeControls()",
  "          pickStory(choice)",
  "        })",
  "        box.appendChild(btn)",
  "      })(choices[i], i)",
  "    }",
  "    card.appendChild(box)",
  "    var tip = document.createElement('div')",
  "    tip.className = 'story-tip'",
  "    tip.textContent = '点一条接着看（下一段要先下载好，进度就显示在这张卡片上）'",
  "    card.appendChild(tip)",
  "  }",
  "",
  "/**",
  " * 进度卡片：一条文字 + 一条进度条（失败时再挂一个「重试」按钮）。",
  " *",
  " * @param text 文案",
  " * @param percent 百分比",
  " * @param retry 失败重试要重放的那条选项（不给就不出按钮）",
  " */",
  "  function renderProgress (text, percent, retry) {",
  "    if (!storyEl) return",
  "    var card = storyCard()",
  "    var head = document.createElement('div')",
  "    head.className = 'story-q'",
  "    head.textContent = text",
  "    card.appendChild(head)",
  "    if (retry) {",
  "      var retryBtn = document.createElement('button')",
  "      retryBtn.type = 'button'",
  "      retryBtn.className = 'story-opt'",
  "      var mark = document.createElement('b')",
  "      mark.textContent = '↻'",
  "      var label = document.createElement('span')",
  "      label.textContent = '重试这一段'",
  "      retryBtn.appendChild(mark)",
  "      retryBtn.appendChild(label)",
  "      retryBtn.addEventListener('click', function (event) {",
  "        event.stopPropagation()",
  "        storyPending = null",
  "        hideStory()",
  "        pickStory(retry)",
  "      })",
  "      card.appendChild(retryBtn)",
  "    }",
  "    var track = document.createElement('div')",
  "    track.className = 'story-track'",
  "    var fill = document.createElement('div')",
  "    fill.className = 'story-fill'",
  "    fill.style.width = Math.max(0, Math.min(100, Number(percent) || 0)) + '%'",
  "    track.appendChild(fill)",
  "    card.appendChild(track)",
  "  }",
  "",
  "  /**",
  "   * 点了一条选项：**直接换源重新播放**（用户要求）。",
  "   *",
  "   * 浏览器自己去取 `/segment/<cid>`：服务端没下过就现下（下完留在会话目录里，第二次秒开）。",
  "   * 等它下的这段时间，画面上那张卡片就是进度条（轮询 /progress），下好开播后自动收起来。",
  "   * 画面和声音是两条流（B站就这样，服务器不合成），两个 src 一起换。",
  "   */",
  "  function pickStory (choice) {",
  "    if (storyPending || !choice || !choice.cid) return",
  "    storyPending = choice.cid",
  "    storyLastChoice = choice",
  "    var fromCid = storyNode ? storyNode.cid : 0",
  "    hideStory()",
  "    if (notice) notice.hidden = true",
  "    renderProgress('正在准备下一段…', 0)",
  "    video.setAttribute('src', API + '/segment/' + choice.cid)",
  "    if (audioTrack) {",
  "      audioTrack.setAttribute('src', API + '/segment/' + choice.cid + '?audio=1')",
  "      try { audioTrack.load() } catch (err) { /* 忽略 */ }",
  "    }",
  "    clearLanes()",
  "    reset(0)",
  "    try { video.load() } catch (err) { /* 老浏览器没有 load 也不能崩 */ }",
  "    var started = video.play()",
  "    if (started && started.catch) started.catch(function () {})",
  "    loadStory(fromCid, choice.edgeId, choice.cid)",
  "    pollProgress(choice.cid, 0)",
  "  }",
  "",
  "  /** 轮询分段准备进度：一边下一边报百分比；失败就把服务端给的原因直接写出来 */",
  "  function pollProgress (cid, waited) {",
  "    if (storyPending !== cid) return",
  "    if (waited > 600) {",
  "      storyPending = null",
  "      renderProgress('这一段准备超时了', 0, storyLastChoice)",
  "      return",
  "    }",
  "    fetch(API + '/progress?cid=' + cid)",
  "      .then(function (res) { return res.ok ? res.json() : null })",
  "      .then(function (info) {",
  "        if (storyPending !== cid) return",
  "        if (info && info.stage === 'failed') {",
  "          storyPending = null",
  "          storyLastReason = info.reason || ''",
  "          renderProgress('这一段没准备好：' + (storyLastReason || '下载失败或链接失效'), 0, storyLastChoice)",
  "          return",
  "        }",
  "        var stage = info ? info.stage : 'idle'",
  "        var percent = info && info.percent ? info.percent : 0",
  "        var text = stage === 'ready' ? '马上开始…'",
  "          : stage === 'audio' ? '正在下载声音 ' + percent + '%'",
  "            : stage === 'queued' ? '排队准备中…'",
  "              : '正在下载这一段 ' + percent + '%'",
  "        renderProgress(text, stage === 'ready' ? 100 : percent)",
  "        storyPollTimer = window.setTimeout(function () { pollProgress(cid, waited + 1) }, 500)",
  "      })",
  "      .catch(function () {",
  "        storyPollTimer = window.setTimeout(function () { pollProgress(cid, waited + 1) }, 1200)",
  "      })",
  "  }",
  "",
  "  /** 下一段开播了（或播放器自己报错）：结束这一轮等待，把进度卡片收起来 */",
  "  function settleStoryWait () {",
  "    if (storyPollTimer) { window.clearTimeout(storyPollTimer); storyPollTimer = 0 }",
  "    if (!storyPending) return",
  "    storyPending = null",
  "    hideStory()",
  "    if (notice) notice.hidden = true",
  "  }",
  "  video.addEventListener('loadeddata', settleStoryWait)",
  "  video.addEventListener('canplay', settleStoryWait)",
  "",
  "  /** 拉一次剧情：不带 fromCid = 问「当前这一段」的选项；带了 = 问走这条边之后的下一段 */",
  "  /**",
  "   * @param fromCid 从哪一段出发（不带 = 问当前这一段自己的选项）",
  "   * @param edgeId 走哪条边（不带 = 根节点）",
  "   * @param landingCid 这条边落地那一段的 cid —— edgeinfo 只回题干和选项、不回落点 cid，",
  "   *                   所以要拿选项自己带的 cid 钉住，之后「从哪一段出发」才不会用错。",
  "   */",
  "  function loadStory (fromCid, edgeId, landingCid) {",
  "    var url = API + '/story' + (fromCid ? '?cid=' + fromCid + '&edge=' + (edgeId || 0) : '')",
  "    fetch(url)",
  "      .then(function (res) { return res.ok ? res.json() : null })",
  "      .then(function (node) {",
  "        if (!node || !node.cid) return",
  "        storyNode = node",
  "        if (storyBtn) storyBtn.hidden = false",
  "        // 落点 cid 用选项自带的那个钉住（edgeinfo 只回题干和选项）",
  "        if (landingCid) node.cid = landingCid",
  "      })",
  "      .catch(function () { /* 取不到就当普通视频放，不影响这一段 */ })",
  "  }",
  "",
  "  /**",
  "   * **这一段放完了**才把选项贴出来（用户要求）。",
  "   *",
  "   * 播到一半不弹、加载完也不弹 —— 免得挡住画面；想提前看就点控制条上的「选项」。",
  "   * 放完时画面停在最后一帧，选项正好接在原视频的结束画面上。",
  "   */",
  "  function maybeShowStory () {",
  "    if (!storyNode || storyPending || storyShown) return",
  "    if (!video.ended) return",
  "    renderStory()",
  "    wakeControls()",
  "  }",
  "  video.addEventListener('ended', maybeShowStory)",
  "",
  "  /**",
  "   * 分段加载失败：**必须压过页面原来那句「链接已过期或视频已被清理」**。",
  "   *",
  "   * 那句是给「整条会话过期」准备的，用在互动分段上完全误导（用户真以为是链接过期了）。",
  "   * 这里在它之后注册，所以最后一句一定是这里的；再挂一个「重试」按钮，别让人只能刷新页面。",
  "   */",
  "  video.addEventListener('error', function () {",
  "    if (!storyNode && !storyPending) return",
  "    storyPending = null",
  "    if (storyPollTimer) { window.clearTimeout(storyPollTimer); storyPollTimer = 0 }",
  "    if (notice) notice.hidden = true",
  "    renderProgress('这一段没准备好：' + (storyLastReason || '下载失败或链接失效（详见机器人控制台日志）'), 0, storyLastChoice)",
  "  })",
  "  // 点卡片外面的画面 = 先把选项收起来（卡片内部的点击不会冒泡到这里）",
  "  if (storyEl) storyEl.addEventListener('click', function (event) { if (event.target === storyEl) hideStory() })",
  "  // 控制条上的「选项」：想提前看选项随时点（全屏时也在控制条上）",
  "  if (storyBtn) {",
  "    storyBtn.addEventListener('click', function () {",
  "      if (!storyNode || storyPending) return",
  "      renderStory()",
  "      wakeControls()",
  "    })",
  "  }",
  "  loadStory(0, 0)",
  "})()",
  ''
].join('\n')
