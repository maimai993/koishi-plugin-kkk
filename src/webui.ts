/**
 * kkk 的配置 WebUI —— 照搬原版 SPA，并且**免登录**。
 *
 * 界面就是 koishi-plugin-kkk 自带的那个 React 面板（assets/web/），服务端按它的接口契约实现。
 *
 * ## 登录策略
 * 不设独立口令。只认 Koishi 的 **auth 插件**：
 *   - auth 没启用（当前部署就是关的）→ 全部免登录，直接进；
 *   - auth 启用了 → 要求控制台已登录（用控制台的 cookie 查 token 表）。
 *
 * ## 原版 SPA 的契约
 *   POST /api/v1/login    → { code, data: { accessToken, userId, refreshToken }, message }
 *   POST /api/v1/refresh  → { code, data: { accessToken }, message }
 *   GET  /kkk/v1/bots     → { code, data: Bot[], message }
 *   GET  /kkk/v1/bots/:id/groups
 *   POST /kkk/v1/groups/batch
 *   静态资源在 /kkk/assets/ 下；SPA 自己的路由（/kkk/assets/config 等）也要回 index.html
 *
 * 另外留了一个简易编辑页 /kkk/edit（改插件配置用，保存写回 koishi.yml）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { Context } from 'koishi'

const COOKIE_NAME = 'kkk_config_token'
const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000

export interface WebUiDeps {
  ctx: Context
  config: any
  logger: any
  pluginRoot: string
}

export function registerWebUi ({ ctx, config, logger, pluginRoot }: WebUiDeps) {
  const server: any = (ctx as any).server
  if (!server || typeof server.get !== 'function') {
    logger.debug('[kkk] 没有 server 服务，跳过配置 WebUI')
    return
  }

  const webRoot = path.join(pluginRoot, 'assets', 'web')
  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json; charset=utf-8'
  }

  const readWebFile = (relative: string): Buffer | null => {
    try {
      const base = path.resolve(webRoot)
      const full = path.resolve(base, relative.replace(/^[/\\]+/, ''))
      if (!full.startsWith(base)) return null
      return fs.statSync(full).isFile() ? fs.readFileSync(full) : null
    } catch {
      return null
    }
  }
  /**
   * 返回 SPA 首页。
   *
   * 原版面板自带一个登录页（karin 那边要输 WebUI 口令）。Koishi 这边走 auth 插件：
   * **没启用 auth 时接口本来就放行**，所以这里注入一段自动登录脚本，
   * 直接把口令框填上并提交 —— 用户看到的就直接是配置界面，不用再想「key 是什么」。
   */
  const autoLoginScript = `<script>
(function () {
  var tries = 0;
  var timer = setInterval(function () {
    if (++tries > 80) { clearInterval(timer); return; }
    var input = document.querySelector('input[type=password], input[type=text]');
    var button = document.querySelector('button[type=submit], form button, button');
    if (!input || !button) return;
    clearInterval(timer);
    try {
      // React 受控组件：直接改 value 不会触发 onChange，必须走原生 setter + 派发 input 事件
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'koishi');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) { input.value = 'koishi'; }
    setTimeout(function () { try { button.click(); } catch (e) { } }, 400);
  }, 400);
})();
</script>`

  const indexHtml = (): Buffer => {
    const raw = readWebFile('index.html')
    if (!raw) return Buffer.from('<h1>KKK Config</h1><p>assets/web/index.html 缺失</p>')
    // 只有「不需要登录」时才自动登录；开了 auth 插件就得让用户自己登控制台
    if (authRequired()) return raw
    const text = raw.toString('utf-8')
    return Buffer.from(text.includes('</body>') ? text.replace('</body>', autoLoginScript + '</body>') : text + autoLoginScript)
  }

  /* ---------------- 登录策略 ---------------- */

  /** 只有启用 auth 插件才需要登录；当前部署是关的 → 免登录 */
  const authRequired = () => !!(ctx as any).get?.('auth')

  /** 控制台登录态：auth 插件的 cookie 形如 name=id:token，用它查 token 表 */
  const consoleAuthed = async (request: any): Promise<boolean> => {
    if (!authRequired()) return true
    const database: any = (ctx as any).get?.('database')
    if (!database?.get) return false
    const cookie = String(request?.headers?.cookie || '')
    for (const match of cookie.matchAll(/(?:^|;\s*)([\w-]+)=(\d+):([0-9a-f]+)/g)) {
      try {
        const rows = await database.get('token', { id: Number(match[2]), token: match[3] }, ['expiredAt'])
        if (rows?.[0] && Number(rows[0].expiredAt) > Date.now()) return true
      } catch { /* 试下一个 cookie */ }
    }
    return false
  }

  const tokens = new Map<string, number>()

  const issueToken = () => {
    const accessToken = crypto.randomBytes(16).toString('hex')
    const refreshToken = crypto.randomBytes(16).toString('hex')
    tokens.set(accessToken, Date.now())
    tokens.set(refreshToken, Date.now())
    return { accessToken, refreshToken, userId: 'kkk' }
  }

  const authed = (request: any): boolean => {
    if (!authRequired()) return true
    const header = String(request?.headers?.authorization || request?.headers?.['x-access-token'] || '')
    if (header && tokens.has(header.replace(/^Bearer\s+/i, ''))) return true
    const cookie = String(request?.headers?.cookie || '')
    const match = new RegExp(COOKIE_NAME + '=([0-9a-f]+)').exec(cookie)
    return !!(match && tokens.has(match[1]))
  }

  const ok = (response: any, data: any = null, message = '') => {
    response.type = 'application/json; charset=utf-8'
    response.body = JSON.stringify({ code: 200, data, message })
  }
  const fail = (response: any, code: number, message: string) => {
    response.status = 200
    response.type = 'application/json; charset=utf-8'
    response.body = JSON.stringify({ code, data: null, message })
  }

  /* ---------------- 鉴权接口 ---------------- */

  /**
   * 路径说明：原版 SPA 调的是 `/api/v1/login`，但 **`/api/*` 是 Koishi 控制台自己的路由**
   * （只允许 GET，我们注册的 POST 会被 405 掉）。所以把 SPA 包里的地址改成了 `/kkk/api/v1/*`
   * （assets/web 里已经替换过），服务端两个路径都注册一份，外部按原路径调也照样能用。
   */
  const loginHandler = async (response: any) => {
    // 免登录模式下任何输入都放行（原版会弹登录框，随便点一下即可进入）
    if (!(await consoleAuthed(response.request))) {
      logger.warn('[kkk] 配置面板需要先登录 Koishi 控制台')
      return fail(response, 401, '需要先登录 Koishi 控制台')
    }
    ok(response, issueToken(), '登录成功')
  }
  const refreshHandler = (response: any) => {
    const body: any = response.request?.body || {}
    const refresh = String(body.refreshToken || '')
    if (authRequired() && !tokens.has(refresh)) return fail(response, 401, 'refreshToken 无效')
    ok(response, issueToken(), '已刷新')
  }
  /**
   * 用 **GET** 注册：Koishi 控制台注册了一条 GET 通配路由 + allowedMethods，
   * 所有 POST 到任意路径都会被 405 掉（实测）。反正免登录模式下不看请求体，GET 完全够用，
   * SPA 包里对应调用也已经改成 GET（assets/web 说明）。
   */
  for (const prefix of ['/kkk/api/v1', '/api/v1']) {
    server.get(prefix + '/login', loginHandler)
    server.get(prefix + '/refresh', refreshHandler)
    // 兼容按 POST 调用的外部脚本（在没有控制台通配路由的环境下才生效）
    server.post(prefix + '/login', loginHandler)
    server.post(prefix + '/refresh', refreshHandler)
  }

  /* ---------------- 配置接口（原版 SPA 的主功能） ---------------- */

  /**
   * 原版面板的配置读写：
   *   GET  /kkk/v1/config  →  { code: 200, data: <配置> }
   *   POST /kkk/v1/config  →  保存（body 就是整份配置）
   * 判定成功的方式是 `(res.success || res.code === 200) && res.data !== undefined`，
   * 所以 data 一定要给（哪怕空对象），否则前端会直接抛「获取配置失败」。
   */
  server.get('/kkk/v1/config', (response: any) => {
    if (!authed(response)) return fail(response, 401, '鉴权失败: 缺少authorization')
    // 面板面向的是 karin 那份 config.json（画质 / 发送内容 / 推送 / 渲染…），
    // 在 Koishi 这边它就存在 `upstream` 里，启动时同步进 config.json
    ok(response, config?.upstream ?? {}, '')
  })

  server.post('/kkk/v1/config', async (response: any) => {
    if (!authed(response)) return fail(response, 401, '鉴权失败: 缺少authorization')
    try {
      const body: any = response.request?.body
      if (!body || typeof body !== 'object') throw new Error('请求体不是配置对象')
      // 原版面板发过来的是整份配置；这里把它整体写进 upstream，
      // 保存会走 scope.update → 落盘 koishi.yml → 热重载 → 启动时同步回 config.json
      await (ctx as any).scope.update({ ...config, upstream: body })
      logger.info('[kkk] 配置面板已保存 upstream 配置（写回 koishi.yml）')
      ok(response, null, '已保存')
    } catch (error: any) {
      logger.warn('[kkk] 配置面板保存失败: ' + String(error?.message ?? error))
      fail(response, 500, String(error?.message ?? error))
    }
  })

  /* ---------------- 数据接口 ---------------- */

  const botList = () => {
    const bots: any[] = (ctx as any).bots ?? []
    return bots.map((bot: any) => ({
      id: String(bot.selfId ?? bot.user?.id ?? ''),
      name: String(bot.user?.name ?? bot.selfId ?? ''),
      avatar: String(bot.user?.avatar ?? ''),
      platform: String(bot.platform ?? ''),
      status: 1
    }))
  }

  server.get('/kkk/v1/bots', (response: any) => {
    if (!authed(response)) return fail(response, 401, '鉴权失败: 缺少authorization')
    ok(response, botList(), '')
  })

  server.get('/kkk/v1/bots/:id/groups', (response: any) => {
    if (!authed(response)) return fail(response, 401, '鉴权失败: 缺少authorization')
    ok(response, [], '')
  })

  server.post('/kkk/v1/groups/batch', (response: any) => {
    if (!authed(response)) return fail(response, 401, '鉴权失败: 缺少authorization')
    ok(response, null, '')
  })

  /* ---------------- 静态资源 + SPA 路由 ---------------- */

  /**
   * 静态资源 + SPA 路由。
   *
   * 用**中间件**而不是 `server.get('/kkk/assets/*')`：新版 path-to-regexp 不再接受
   * 这种无名的 `*` 通配（会直接抛 `Unexpected MODIFIER` 把整个插件搞崩），
   * 手动判前缀最省事也最兼容。
   */
  server.use(async (response: any, next: any) => {
    const requestPath = String(response.path || '')
    if (!requestPath.startsWith('/kkk/assets/')) return next()
    const relative = decodeURIComponent(requestPath.slice('/kkk/assets/'.length))
    const file = relative ? readWebFile(relative) : null
    if (!file) {
      // SPA 自己的前端路由（/kkk/assets/config、/kkk/assets/about 等）→ 回 index.html
      response.type = 'text/html; charset=utf-8'
      response.body = indexHtml()
      return
    }
    response.type = MIME[path.extname(relative).toLowerCase()] ?? 'application/octet-stream'
    // 不缓存：面板的前端包会被我们改动（接口路径等），浏览器缓存旧包会直接导致「打不开/接口报错」
    response.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
    response.body = file
  })

  for (const route of ['/kkk', '/kkk/', '/kkk/login']) {
    server.get(route, (response: any) => {
      response.type = 'text/html; charset=utf-8'
      response.body = indexHtml()
    })
  }

  /* ---------------- 简易编辑页（改插件配置） ---------------- */

  server.get('/kkk/edit', (response: any) => {
    let body: string
    try {
      body = fs.readFileSync(path.join(pluginRoot, 'assets', 'webui.html'), 'utf-8')
    } catch {
      body = '<h1>kkk 配置</h1><p>assets/webui.html 缺失</p>'
    }
    const token = issueToken()
    response.set('Set-Cookie', COOKIE_NAME + '=' + token.accessToken + '; Path=/; HttpOnly; Max-Age=' + Math.floor(TOKEN_TTL / 1000))
    response.type = 'text/html; charset=utf-8'
    response.body = body
  })

  server.get('/kkk/api/config', (response: any) => {
    if (!authed(response)) return fail(response, 401, '未登录')
    const { upstream, ...options } = config || {}
    ok(response, { options, upstream: upstream || {} }, '')
  })

  server.post('/kkk/api/save', async (response: any) => {
    if (!authed(response)) return fail(response, 401, '未登录')
    try {
      const body: any = response.request?.body || {}
      const patch: any = { ...(body.options || {}) }
      const next: any = { ...config, ...patch }
      if (body.upstream && typeof body.upstream === 'object') next.upstream = body.upstream
      if (typeof (ctx as any).scope?.update !== 'function') throw new Error('当前上下文不支持 scope.update')
      await (ctx as any).scope.update(next)
      logger.info('[kkk] 配置已保存（写回 koishi.yml）并热重载')
      ok(response, null, '已保存')
    } catch (error: any) {
      logger.warn('[kkk] 配置保存失败: ' + String(error?.message ?? error))
      fail(response, 500, String(error?.message ?? error))
    }
  })

  logger.info('[kkk] 配置面板: /kkk（原版界面，免登录）；简易编辑页: /kkk/edit')
}
