/**
 * 探针：人机验证页（`/kkk/geetest`）。
 *
 * ## 为什么要有它
 * 平台风控（B站 -352）时要让用户过一次人机验证。以前发的是**写死在代码里的第三方地址**
 * （`koishi-plugin-kkk-docs.vercel.app/geetest?...`），那个站在国内经常连不上 ——
 * 用户打不开验证页，风控就变成「无解」。现在页面由插件自己托管，公网地址走新增的配置项。
 *
 * 这类改动不报错、不崩，只是「用户那边什么都打不开」，所以要把出口钉住：
 *
 *   ① 配置项存在（控制台 + WebUI 同一张字段表），默认留空；
 *   ② 页面 HTML：真参数 → 含极验 SDK 和那两个参数；**假参数 → 拒绝渲染**（不能带出注入内容）；
 *   ③ **XSS 闸门**：`challenge` 里塞 `</script>` 之类必须被白名单挡下 ——
 *      这两个值是拼进 `<script>` 里的，不校验就是活生生的注入点；
 *   ④ 链接拼接：配了公网地址用它；没配退化成本机地址；**宿主没有 server 时退回第三方页**；
 *      地址末尾带斜杠不能拼出双斜杠；
 *   ⑤ 路由真的挂到了 `ctx.server` 上，且能吐出页面；
 *   ⑥ 静态闸门：`riskControl.ts` 里不许再出现写死的第三方验证地址。
 *
 * 用法：node scripts/probe-verify-page.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..')
const lib = path.join(root, 'lib')

const runtime = require(path.join(lib, 'compat/runtime.js'))

/** 假 ctx：带一个能记下路由的 server（@cordisjs/plugin-server 的形状） */
const makeServer = () => {
  const routes = {}
  return {
    routes,
    ctx: {
      config: { port: 5200, prefix: '' },
      server: {
        port: 5200,
        get: (routePath, handler) => { routes[routePath] = handler }
      }
    }
  }
}

const bind = (extra = {}) => {
  const made = makeServer()
  runtime.bindRuntime({
    ctx: made.ctx,
    config: { ...extra },
    dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'kkk-probe-verify-'))
  })
  return made
}

/** 假 logger：不设的话 compat/logger 会去找 runtime.ctx.logger，而假 ctx 没有 */
const logLines = []
require(path.join(lib, 'compat/logger.js')).setLogger({
  debug () {},
  info: (...args) => { logLines.push(String(args[0] ?? '')) },
  mark () {},
  warn (message) { logLines.push('[warn] ' + message); console.log('  [warn] ' + message) },
  error (message) { logLines.push('[error] ' + message); console.log('  [error] ' + message) }
})

const fields = require(path.join(root, 'src', 'qqFields.json'))
const verify = require(path.join(lib, 'verify/index.js'))

let failed = 0
const check = (name, ok, detail) => {
  console.log((ok ? '  \u2714 ' : '  \u2718 ') + name + (detail ? '  \u2192 ' + detail : ''))
  if (!ok) failed++
}

const GT = 'a1b2c3d4e5f6'
const CHALLENGE = '9f8e7d6c5b4a'

;(async () => {
  console.log('\n=== 1. 配置项「验证页公网地址」 ===')
  {
    const field = fields.find((item) => item.key === 'verifyBaseUrl')
    check('字段存在', !!field)
    check('默认留空（留空 = 退化成本机地址）', field && field.default === '', String(field && field.default))
    check('在「通用」分组', field && field.group === '通用', field && field.group)
    check('单独一个「人机验证设置」小节', field && field.section === '人机验证设置', field && field.section)
    check('说明里写清了要指向 Koishi 端口（不是播放器域名）',
      field && /Koishi\s*端口/.test(field.description), '')
    check('说明里写了留空的后果', field && /点不开/.test(field.description), '')

    const webui = fs.readdirSync(path.join(root, 'assets/web/assets'))
      .filter((name) => name.startsWith('index-') && name.endsWith('.js'))
    const hit = webui.some((name) =>
      fs.readFileSync(path.join(root, 'assets/web/assets', name), 'utf8').includes('verifyBaseUrl'))
    check('WebUI 产物里也有这一项（同一张字段表）', hit, webui.join(','))
  }

  console.log('\n=== 2. 页面：真参数渲染出极验，假参数拒绝渲染 ===')
  {
    const html = verify.renderVerifyPage(GT, CHALLENGE)
    check('含极验官方 SDK', html.includes('static.geetest.com'), '')
    check('调的是 initGeetest（v3）', html.includes('initGeetest'), '')
    check('gt 传进去了', html.includes(GT), '')
    check('challenge 传进去了', html.includes(CHALLENGE), '')
    check('成功后给出 validate / seccode 让用户复制回群', /validate=/.test(html) && /seccode=/.test(html), '')
    check('有倒计时（机器人只等 120 秒）', /120/.test(html), '')

    /**
     * 内联脚本必须**能解析**：模板字符串里少个反引号、或者 `</script>` 提前闭合，
     * 页面就会直接白屏，而这种错在 Node 侧完全看不出来（HTML 就是个字符串）。
     * 这里只解析不执行（`new Function` 不跑函数体），DOM API 不存在也没关系。
     */
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])
    let syntaxOk = inline.length === 1
    let syntaxError = ''
    try { if (inline[0]) new Function(inline[0]) } catch (error) { syntaxOk = false; syntaxError = error.message }
    check('内联脚本语法正确（只解析不执行）', syntaxOk && inline.length === 1, syntaxError || (inline.length + ' 段'))

    check('缺 gt → 拒绝渲染', verify.renderVerifyPage('', CHALLENGE).includes('这个验证链接打不开'))
    check('缺 challenge → 拒绝渲染', verify.renderVerifyPage(GT, '').includes('这个验证链接打不开'))
  }

  console.log('\n=== 3. XSS 闸门（这两个值是拼进 <script> 里的） ===')
  {
    const attacks = [
      '</script><script>alert(1)</script>',
      "'; alert(1); //",
      '<img src=x onerror=alert(1)>',
      'a\nb\nc',
      '" onmouseover="alert(1)'
    ]
    for (const attack of attacks) {
      const html = verify.renderVerifyPage(attack, CHALLENGE)
      const leaked = html.includes('</script><script>') || html.includes('onerror=') || html.includes('onmouseover=')
      check('注入被白名单挡下：' + JSON.stringify(attack.slice(0, 28)),
        html.includes('这个验证链接打不开') && !leaked, '')
    }
    /** 正常值（字母数字 + 下划线短横线）不能被误杀 */
    check('正常的 gt（含下划线 / 短横线）不被挡',
      !verify.renderVerifyPage('abc_123-XYZ', CHALLENGE).includes('这个验证链接打不开'))
  }

  console.log('\n=== 4. 链接怎么拼 ===')
  {
    /** ④-1 宿主没有 server：只能退回第三方页 */
    verify.resetVerifyRoutes()
    bind()
    const noServerCtx = { config: { port: 5200 } } // 没有 server
    verify.registerVerifyRoutes(noServerCtx)
    check('没有 server 服务 → 路由挂不上', verify.isVerifyRouteReady() === false)
    const fallback = verify.buildVerifyLink({ gt: GT, challenge: CHALLENGE })
    check('  这种时候退回第三方验证页（有个地址也比没有强）',
      fallback.includes('koishi-plugin-kkk-docs.vercel.app'), fallback)
    check('  退回时也把 gt / challenge 带上了', fallback.includes(GT) && fallback.includes(CHALLENGE), '')
    check('  且是 `?v=3` 开头的合法 query（不是 `&v=3`）', /\?v=3&gt=/.test(fallback), fallback)

    /** ④-2 挂上路由 + 配了公网地址 */
    verify.resetVerifyRoutes()
    const made = bind({ verifyBaseUrl: 'https://kkk.example.com' })
    const dispose = verify.registerVerifyRoutes(made.ctx)
    check('路由挂上了', verify.isVerifyRouteReady() === true)
    const withBase = verify.buildVerifyLink({ gt: GT, challenge: CHALLENGE })
    check('配了公网地址 → 用它',
      withBase === 'https://kkk.example.com/kkk/geetest?gt=' + GT + '&challenge=' + CHALLENGE, withBase)

    /** ④-3 末尾带斜杠不能拼出双斜杠（用户复制粘贴很常见） */
    verify.resetVerifyRoutes()
    const slash = bind({ verifyBaseUrl: 'https://kkk.example.com/' })
    verify.registerVerifyRoutes(slash.ctx)
    const withSlash = verify.buildVerifyLink({ gt: GT, challenge: CHALLENGE })
    check('地址末尾带斜杠 → 不出现双斜杠', !withSlash.includes('com//'), withSlash)

    /** ④-4 没配公网地址 → 退化成本机 IP + Koishi 端口，并警告一次 */
    verify.resetVerifyRoutes()
    const plain = bind()
    verify.registerVerifyRoutes(plain.ctx)
    const local = verify.buildVerifyLink({ gt: GT, challenge: CHALLENGE })
    check('没配公网地址 → 退化成本机地址（含 /kkk/geetest）',
      /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/kkk\/geetest\?gt=/.test(local), local)
    check('  用的是 Koishi 自己监听的端口（不是配置树里的默认值）', local.includes(':5200'), local)
    dispose()
  }

  console.log('\n=== 5. 路由真的能吐出页面 ===')
  {
    verify.resetVerifyRoutes()
    const made = bind({ verifyBaseUrl: 'https://kkk.example.com' })
    const dispose = verify.registerVerifyRoutes(made.ctx)
    check('挂的路径就是 /kkk/geetest', Object.keys(made.routes).includes('/kkk/geetest'),
      Object.keys(made.routes).join(','))

    const koa = { search: '?gt=' + GT + '&challenge=' + CHALLENGE, set (key, value) { (this.headers ??= {})[key] = value }, headers: {} }
    await made.routes['/kkk/geetest'](koa)
    check('返回 200', koa.status === 200, String(koa.status))
    check('Content-Type 是 html', String(koa.headers['Content-Type'] ?? '').includes('text/html'),
      String(koa.headers['Content-Type']))
    check('body 就是那张验证页', String(koa.body ?? '').includes('initGeetest'), '')
    check('不缓存（每次风控的 challenge 都不一样）',
      String(koa.headers['Cache-Control'] ?? '').includes('no-store'), String(koa.headers['Cache-Control']))

    /** 直接调处理函数也要能出页面（探针不用起真服务） */
    const res = verify.handleVerifyRequest('?gt=' + GT + '&challenge=' + CHALLENGE)
    check('handleVerifyRequest 直接可用', res.status === 200 && res.body.includes(GT), '')

    dispose()
    check('dispose 之后路由状态归位', verify.isVerifyRouteReady() === false)
  }

  console.log('\n=== 6. 静态闸门：不许再有写死的第三方验证地址 ===')
  {
    const risk = fs.readFileSync(path.join(root, 'src/karin/platform/bilibili/riskControl.ts'), 'utf8')
    /** 注释里提到那个域名是为了解释「为什么换成自带页面」，不算调用 */
    const code = risk.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    check('riskControl 里不再写死 vercel 那个地址', !code.includes('vercel.app'), '')
    check('  它改用了 buildVerifyLink', code.includes('buildVerifyLink'), '')

    /**
     * 整个 src 里，除 `verify/index.ts`（兜底常量）外不该再有指向**第三方验证页**的代码。
     *
     * 只认 `/geetest` 那一条：同一个域名下的文档站（更新日志卡片的 diff 页）是另一回事，
     * 别把正常的用法也打成红的。
     */
    const USES_HOSTED_VERIFY = /vercel\.app\/geetest/
    const offenders = []
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue }
        if (!/\.tsx?$/.test(entry.name)) continue
        const text = fs.readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '')
        if (!USES_HOSTED_VERIFY.test(text)) continue
        if (full.replace(/\\/g, '/').endsWith('src/verify/index.ts')) continue
        offenders.push(path.relative(path.join(root, 'src'), full))
      }
    }
    walk(path.join(root, 'src'))
    check('src 里没有别处在用第三方验证页（新增文件就红）', offenders.length === 0, offenders.join(','))
  }

  console.log('\n=== 7. 通用风控入口：平台给了验证页地址时（目前是快手） ===')
  {
    const KUAISHOU = 'https://captcha.zt.kuaishou.com/iframe/index.html?captchaSession=abc123'
    /** ① 白名单：这个地址会被拼进 <iframe src> 和 <a href>，不放行就是开放重定向 */
    check('快手的滑块页 → 放行', verify.isAllowedCaptchaUrl(KUAISHOU))
    check('http 的不放行（必须 https）', !verify.isAllowedCaptchaUrl('http://captcha.zt.kuaishou.com/x'))
    check('别的域名不放行', !verify.isAllowedCaptchaUrl('https://evil.example.com/x'))
    check('长得像但多一段的不放行', !verify.isAllowedCaptchaUrl('https://captcha.zt.kuaishou.com.evil.com/x'))
    check('空值 / 垃圾不放行', !verify.isAllowedCaptchaUrl('') && !verify.isAllowedCaptchaUrl('not a url'))

    /** ② 链接拼接 */
    verify.resetVerifyRoutes()
    const made = bind({ verifyBaseUrl: 'https://kkk.example.com' })
    const dispose = verify.registerVerifyRoutes(made.ctx)
    const link = verify.buildRiskLink({ url: KUAISHOU, platform: '快手', bizName: 'ANTICRAWL_DEFAULT' })
    check('配了公网地址 → 中转页链接', link.startsWith('https://kkk.example.com/kkk/verify?url='), link)
    check('  地址被 URL 编码过（带 ?captchaSession= 也不会截断）',
      link.includes(encodeURIComponent(KUAISHOU)), link)
    check('  平台名和风控类型也带上了', link.includes('p=%E5%BF%AB%E6%89%8B') && link.includes('biz=ANTICRAWL'), link)
    check('地址不合法 → 不给链接（绝不能交出来路不明的地址）',
      verify.buildRiskLink({ url: 'https://evil.example.com/x' }) === '', '')

    /** ③ 页面：有按钮 + 有地址；且 bizName 要转义 */
    const page = verify.renderRiskPage({ url: KUAISHOU, platform: '快手', bizName: '<script>alert(1)</script>' })
    check('页面里有「打开验证页」的按钮', page.includes('打开验证页') && page.includes('href="' + KUAISHOU + '"'), '')
    check('bizName 被转义（不能把脚本注进来）',
      !page.includes('<script>alert(1)</script>') && page.includes('&lt;script&gt;'), '')

    /** ④ 请求处理：合法 200，非法 400 */
    const ok = verify.handleRiskRequest('?url=' + encodeURIComponent(KUAISHOU) + '&p=快手')
    check('合法地址 → 200 + html', ok.status === 200 && String(ok.headers['Content-Type']).includes('text/html'))
    const bad = verify.handleRiskRequest('?url=' + encodeURIComponent('https://evil.example.com/x'))
    check('非法地址 → 400，且不渲染页面', bad.status === 400 && !bad.body.includes('iframe'), String(bad.status))
    dispose()
  }

  console.log('\n=== 8. 抖音：没有地址时抓样本，绝不编链接 ===')
  {
    /** ① amagi 的抖音确实没装挑战提取器 —— 这是「做不了代理」的根因，钉住别忘 */
    const amagiSrc = fs.readFileSync(
      path.join(root, '../..', 'node_modules/@ikenxuan/amagi/dist/src-blqLvYiW.mjs'), 'utf8')
    const runtimeBlock = amagiSrc.slice(amagiSrc.indexOf('const PLATFORM_RUNTIME'), amagiSrc.indexOf('const PLATFORM_RUNTIME') + 900)
    check('amagi 只有快手装了 challenge 提取器', /kuaishou:\s*\{[^}]*challenge:/.test(runtimeBlock), '')
    check('  抖音那一支没有 challenge', !/douyin:\s*\{[^}]*challenge:/.test(runtimeBlock), '')

    /** ② 包装类要把 challenge 透出来（以前没有 → 快手有地址也拿不到） */
    const { AmagiError } = require(path.join(lib, 'karin/module/utils/amagiClient.js'))
    const err = new AmagiError({
      success: false,
      error: { kind: 'risk', code: 'CAPTCHA_REQUIRED', message: '需要验证码', challenge: { url: 'https://captcha.zt.kuaishou.com/x' } }
    })
    check('AmagiError 把 challenge 透出来了', err.challenge?.url === 'https://captcha.zt.kuaishou.com/x',
      JSON.stringify(err.challenge ?? null))
    check('  kind / amagiCode 也在（策略靠它们匹配）', err.kind === 'risk' && err.amagiCode === 'CAPTCHA_REQUIRED',
      err.kind + '/' + err.amagiCode)

    /** ③ 没地址时 logRiskSample 不炸，且把原始材料打出来了 */
    logLines.length = 0
    let threw = false
    try {
      verify.logRiskSample('抖音解析', { kind: 'risk', amagiCode: 'ANTIBOT_PAGE', code: 0, httpStatus: 200, reason: '反爬页', challenge: undefined, raw: '<html>…反爬…' })
    } catch { threw = true }
    check('logRiskSample 不抛异常（打日志不能把主流程带崩）', !threw)
    const dumped = logLines.join('\n')
    check('  把 kind / 码 / 原始响应都打出来了',
      dumped.includes('抖音解析') && dumped.includes('ANTIBOT_PAGE') && dumped.includes('反爬'), dumped.slice(0, 160))
  }

  console.log('\n=== 9. 静态闸门：抖音那两个场景都得挂上诊断 ===')
  {
    const read = (rel) => fs.readFileSync(path.join(root, 'src', rel), 'utf8')
    const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

    /** 用户报的第一个场景：抖音扫码 */
    check('扫码轮询的 risk 分支记了样本', /case\s*'risk'[\s\S]{0,400}logRiskSample/.test(code('karin/module/utils/loginSession.ts')))
    check('扫码轮询的 verify 分支记了样本', /case\s*'verify'[\s\S]{0,600}logRiskSample/.test(code('karin/module/utils/loginSession.ts')))
    check('扫码的图形验证码分支记了样本', /kind\s*!==\s*'sms'[\s\S]{0,600}logRiskSample/.test(code('karin/platform/douyin/login.ts')))

    /** 用户报的第二个场景：抖音解析 —— 走的是通用策略 */
    const strategy = code('verify/riskStrategy.ts')
    check('通用策略按 kind=risk / challenge.url 匹配', /kind\s*===\s*'risk'\s*\|\|[^)]*challenge\?\.url/.test(strategy))
    check('  没地址时不编链接，走 logRiskSample', strategy.includes('logRiskSample'))

    /**
     * ⚠️ 注册顺序：通用策略必须排在 B站 -352 之后，否则 B站的极验流程会被截走。
     * ErrorHandler 是「先匹配先赢」。
     */
    const setup = code('karin/setup.ts')
    const atBili = setup.indexOf("import '@/platform/bilibili/riskControl'")
    const atRisk = setup.indexOf("import '../verify/riskStrategy'")
    check('通用策略注册在 B站那一支之后（顺序反了 B站极验会断）', atBili >= 0 && atRisk > atBili, atBili + ' < ' + atRisk)
  }

  console.log('\n' + (failed ? '\u2718 有 ' + failed + ' 项没通过' : '\u2714 全部通过'))
  process.exit(failed ? 1 : 0)
})().catch((error) => {
  console.error('\n探针崩了：', error?.stack ?? error)
  process.exit(1)
})
