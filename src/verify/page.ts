/**
 * 人机验证页（极验 / geetest v3）。
 *
 * ## 为什么要自带一张页面
 * 以前 B站风控（-352）时发的是写死在代码里的一个第三方地址
 * （`koishi-plugin-kkk-docs.vercel.app/geetest?...`）。那个站在国内经常连不上 ——
 * 于是「风控了」就变成「无解」：用户根本打不开验证页，只能干等。
 *
 * 现在改由**插件自己**在 Koishi 的端口上挂一张 `/kkk/geetest`，
 * 唯一的外部依赖是极验自己的 CDN（`static.geetest.com`，国内可达）。
 * 用户点开 → 过验证 → 页面给出 `validate=…&seccode=…` → 复制回群里，
 * 机器人拿去调 amagi 校验，流程接上。
 *
 * ## 为什么不做「页面自动回传」
 * 验证是在浏览器里完成的，而**等待结果的那次对话在机器人进程里**；
 * 要自动回传就得再做一套「浏览器 ↔ 正在等待的那次验证」的配对机制（token 关联、
 * 用户中途离开群聊的状态清理……）。复制一行文本回群里是同一套流程最短的路，
 * 而且 QQ / OneBot / 私聊全通用。
 */

/** 极验 v3 的官方脚本；这是本页唯一的外部依赖 */
const GEETEST_SDK = 'https://static.geetest.com/static/tools/gt.js'

/* ------------------------------------------------------------------ *
 * 通用风控中转页（快手滑块这种「平台直接给了验证页地址」的情况）
 * ------------------------------------------------------------------ */

/**
 * 生成「平台给了验证页地址」时的中转页。
 *
 * ## 为什么还要中转一层
 * 平台给的地址（快手是 `captcha.zt.kuaishou.com/iframe/index.html?captchaSession=…`）
 * 本身在国内是通的，直接发出去用户也能点。中转页解决的是另外三件事：
 *   1. **链接走我们自己配的公网地址**（群里点开就是，不用复制一长串带票据的 URL）；
 *   2. **说清楚要做什么**（哪个平台、过完验证回来干什么），光甩一个链接用户不知道；
 *   3. 将来想换成「自建验证页」（用 `jsSdkUrl`）时，入口不用变。
 *
 * @param options.url 平台给的验证页地址（**必须过白名单**，见 `isAllowedCaptchaUrl`）
 * @param options.platform 平台名（显示用）
 * @param options.bizName 风控业务名（显示用，快手会给 `ANTICRAWL_DEFAULT` 这种）
 */
export function renderRiskPage (options: { url: string, platform?: string, bizName?: string }): string {
  const url = String(options?.url ?? '')
  const platform = String(options?.platform ?? '').trim() || '平台'
  const bizName = String(options?.bizName ?? '').trim()
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>完成人机验证</title>
<style>${css()}</style>
</head>
<body>
<div class="card">
  <h1>${escapeHtml(platform)}这次要人机验证了</h1>
  <p class="lead">点下面的按钮过去，在打开的页面里完成验证，然后回到群里重新发一次链接就能解析。</p>
  ${bizName ? '<p class="hint">风控类型：' + escapeHtml(bizName) + '</p>' : ''}

  <a class="go" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">打开验证页</a>
  <textarea class="code" id="code" readonly rows="2">${escapeHtml(url)}</textarea>
  <button class="ghost" id="copy">复制地址</button>

  <div class="frame-wrap">
    <p class="hint">下面这片空白是正常的（很多验证页不允许被嵌进来）—— 用上面的按钮就行。</p>
    <iframe src="${escapeHtml(url)}" referrerpolicy="no-referrer"></iframe>
  </div>
</div>
<script>
(function () {
  var box = document.getElementById('code')
  var btn = document.getElementById('copy')
  box.addEventListener('focus', function () { box.select() })
  btn.addEventListener('click', function () {
    box.select()
    var ok = false
    try { ok = document.execCommand('copy') } catch (e) { ok = false }
    if (!ok && navigator.clipboard) {
      navigator.clipboard.writeText(box.value).then(function () { btn.textContent = '已复制 ✓' })
      return
    }
    btn.textContent = ok ? '已复制 ✓' : '请长按选中后手动复制'
  })
})()
</script>
</body>
</html>`
}

/**
 * `gt` / `challenge` 只可能是极验给的 id（字母数字和下划线、短横线）。
 *
 * 这两个值要**拼进 HTML 里的 `<script>`**，不做白名单校验的话
 * 一个精心构造的 `?challenge=` 就能把脚本注进来（XSS）。反正正常值一定匹配，
 * 不匹配就直接当参数坏了处理。
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

/** 参数不对时给一张说明页，别让用户对着一片空白发呆 */
const errorPage = (message: string): string => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>验证链接无效</title>
<style>${css()}</style>
</head>
<body>
<div class="card">
  <h1>这个验证链接打不开</h1>
  <p class="lead">${escapeHtml(message)}</p>
  <p class="hint">回到群里重新触发一次解析，让机器人发一条新的验证链接。</p>
</div>
</body>
</html>`

/**
 * 把值塞进一段 JS 字符串字面量：先过白名单，再转义引号和反斜杠。
 * 过不了白名单的已经被 `errorPage` 拦下了，这里是第二道。
 */
const jsString = (value: string): string =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')

const escapeHtml = (value: string): string =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** 页面样式（手机上看也要能点） */
const css = (): string => `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 24px 16px; min-height: 100vh;
  font: 15px/1.7 -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  background: #f5f6f8; color: #1f2328;
  display: flex; align-items: flex-start; justify-content: center;
}
@media (prefers-color-scheme: dark) {
  body { background: #16181c; color: #e6e8eb; }
  .card { background: #1f2227; box-shadow: 0 1px 3px rgba(0,0,0,.4); }
  .code { background: #12141a; border-color: #2c313a; color: #e6e8eb; }
  .hint { color: #9aa3ad; }
}
.card {
  width: 100%; max-width: 420px; background: #fff; border-radius: 14px;
  padding: 24px 20px; box-shadow: 0 1px 3px rgba(0,0,0,.08);
}
h1 { margin: 0 0 8px; font-size: 19px; }
.lead { margin: 0 0 18px; color: #4a5158; }
@media (prefers-color-scheme: dark) { .lead { color: #b3bac3; } }
#captcha { margin: 18px 0 4px; min-height: 44px; }
.result { display: none; margin-top: 18px; }
.result.show { display: block; }
.code {
  width: 100%; min-height: 74px; resize: vertical;
  font: 13px/1.6 ui-monospace, Menlo, Consolas, monospace;
  padding: 10px 12px; border: 1px solid #d7dbe0; border-radius: 8px;
  background: #fafbfc; color: #1f2328; word-break: break-all;
}
button {
  margin-top: 10px; width: 100%; padding: 10px 14px; font-size: 15px;
  border: 0; border-radius: 8px; background: #2f81f7; color: #fff; cursor: pointer;
}
button:active { opacity: .85; }
button.ghost { background: transparent; color: #2f81f7; border: 1px solid #2f81f7; }
a.go {
  display: block; margin-top: 16px; padding: 12px 14px; text-align: center;
  font-size: 16px; text-decoration: none; border-radius: 8px;
  background: #2f81f7; color: #fff;
}
a.go:active { opacity: .85; }
.frame-wrap { margin-top: 18px; }
.frame-wrap iframe {
  width: 100%; height: 420px; border: 1px solid #d7dbe0; border-radius: 8px; background: #fff;
}
@media (prefers-color-scheme: dark) { .frame-wrap iframe { border-color: #2c313a; background: #12141a; } }
.hint { margin: 12px 0 0; font-size: 13px; color: #6b737c; }
.error { display: none; margin-top: 16px; padding: 10px 12px; border-radius: 8px;
  background: #ffeef0; color: #a40e26; font-size: 14px; }
.error.show { display: block; }
.countdown { font-variant-numeric: tabular-nums; }`

/**
 * 生成验证页。
 * @param gt 极验的 gt（B站风控接口给的）
 * @param challenge 极验的 challenge
 */
export function renderVerifyPage (gt: string, challenge: string): string {
  if (!SAFE_ID.test(gt) || !SAFE_ID.test(challenge)) {
    return errorPage('链接里的验证参数不完整或格式不对。')
  }
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>完成人机验证</title>
<style>${css()}</style>
</head>
<body>
<div class="card">
  <h1>需要完成一次人机验证</h1>
  <p class="lead">平台这次把请求当成机器了。做完下面的验证，把结果复制回群里，机器人会接着解析。
    链接有效期 <span class="countdown" id="countdown">120</span> 秒。</p>

  <div id="captcha"></div>
  <div class="error" id="error"></div>

  <div class="result" id="result">
    <p class="lead" style="margin-bottom:8px">验证通过，把下面这一行**整段**发回群里：</p>
    <textarea class="code" id="code" readonly rows="3"></textarea>
    <button id="copy">复制这一行</button>
    <p class="hint">发回群里后机器人会自动继续；没赶上时间就重新发一次解析链接。</p>
  </div>
</div>

<script src="${GEETEST_SDK}"></script>
<script>
(function () {
  var errorBox = document.getElementById('error')
  var resultBox = document.getElementById('result')
  var codeBox = document.getElementById('code')
  var countdown = document.getElementById('countdown')

  function fail (text) {
    errorBox.textContent = text
    errorBox.classList.add('show')
  }

  var left = 120
  var timer = setInterval(function () {
    left -= 1
    if (left <= 0) { clearInterval(timer); countdown.textContent = '0'; return }
    countdown.textContent = String(left)
  }, 1000)

  if (typeof initGeetest !== 'function') {
    fail('验证脚本没加载出来 —— 多半是当前网络访问不了极验（static.geetest.com）。请换个网络再试。')
    return
  }

  try {
    initGeetest({
      gt: ${jsString(gt)},
      challenge: ${jsString(challenge)},
      offline: 0,
      new_captcha: true,
      product: 'popup',
      width: '100%'
    }, function (captcha) {
      captcha.appendTo('#captcha')
      captcha.onSuccess(function () {
        var r = captcha.getValidate()
        if (!r || !r.geetest_validate) { fail('验证结果为空，请再点一次。'); return }
        var text = 'validate=' + r.geetest_validate + '&seccode=' + r.geetest_seccode
        codeBox.value = text
        resultBox.classList.add('show')
      })
      captcha.onError(function () {
        fail('验证组件报错了，刷新页面重试；一直不行就换个网络。')
      })
    })
  } catch (err) {
    fail('验证组件初始化失败：' + (err && err.message ? err.message : err))
  }

  codeBox.addEventListener('focus', function () { codeBox.select() })
  document.getElementById('copy').addEventListener('click', function () {
    codeBox.select()
    var ok = false
    try { ok = document.execCommand('copy') } catch (e) { ok = false }
    if (!ok && navigator.clipboard) {
      navigator.clipboard.writeText(codeBox.value).then(function () {
        document.getElementById('copy').textContent = '已复制 ✓'
      })
      return
    }
    document.getElementById('copy').textContent = ok ? '已复制 ✓' : '请长按选中后手动复制'
  })
})()
</script>
</body>
</html>`
}
