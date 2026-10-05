/**
 * 探针：`/kkk` 只能从 Koishi 控制台侧边栏进。
 *
 * 以前 `/kkk` 是一个**独立页面**：没装 auth 插件的部署上它一律放行，于是
 * 「打开 <host>/kkk 就能改插件配置」成了一个不需要任何凭据的公网入口。
 * 控制台侧边栏那个页面倒是要登录 —— 但它只是拿 iframe 嵌 `/kkk`，等于后门一直开着。
 *
 * 现在 `/kkk` 只认**控制台下发的面板令牌**（RPC `kkk/panel-token`）：
 * 直链一律 404，静态资源、SPA 前端路由、配置读写接口全跟着一起关。
 * 这个探针把整条链路离线跑一遍，逐条确认「除了侧边栏那条路，别的都进不来」。
 *
 * 用法：node scripts/probe-webui-access.cjs
 */
const path = require('node:path')

const root = path.join(__dirname, '..')
const lib = path.join(root, 'lib')

const { registerWebUi } = require(path.join(lib, 'webui.js'))

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  console.log((ok ? '  \u2714 ' : '  \u2718 ') + name + (detail ? '  \u2192 ' + detail : ''))
  if (ok) pass++
  else fail++
}

/**
 * 假 response：插件里的 handler 会写 status / type / body / set()。
 *
 * ⚠️ 要照 Koa 的样子做：`ctx.headers` **委托给 request**（也就是请求头），
 * 而插件里到处是 `response.headers?.cookie` 这种读法。只把 headers 当响应头
 * 的话，所有鉴权判断都会读到空 —— 探针会假报「没通过」，其实真机上是通的。
 * 响应头另存一份到 `sent`（`Set-Cookie` 之类从那里读）。
 */
const makeResponse = (request) => {
  const sent = {}
  return {
    status: 200,
    type: '',
    body: undefined,
    request,
    path: request.path ?? request.url,
    url: request.url,
    query: request.query ?? {},
    params: request.params ?? {},
    headers: request.headers,
    sent,
    set: (key, value) => { sent[key] = value }
  }
}

const makeRequest = (url, extra = {}) => ({
  url,
  path: url.split('?')[0],
  query: extra.query ?? {},
  headers: extra.headers ?? {},
  params: extra.params ?? {}
})

/**
 * 装一套假 Koishi（server + console），把 registerWebUi 跑起来，并抓下注册的路由/RPC。
 */
const setup = (opts = {}) => {
  const routes = { get: {}, post: {}, use: [] }
  const listeners = {}
  const warnings = []
  const ctx = {
    config: { port: 5140 },
    server: {
      get: (routePath, handler) => { routes.get[routePath] = handler },
      post: (routePath, handler) => { routes.post[routePath] = handler },
      use: (handler) => { routes.use.push(handler) }
    },
    console: {
      entries: {},
      addListener: (name, callback, options) => { listeners[name] = { callback, options } }
    },
    // 插件只问这两件事：装没装 auth 插件、有没有数据库（查 token 表用）
    get: (name) => (name === 'auth' && opts.withAuth ? { name: 'auth' } : undefined),
    bots: []
  }
  const logger = {
    debug () {}, info () {}, mark () {},
    warn: (m) => { warnings.push(String(m)) },
    error: (m) => { warnings.push(String(m)) }
  }
  registerWebUi({ ctx, config: {}, rawConfig: {}, logger, pluginRoot: root })
  return { routes, listeners, warnings, ctx }
}

/** 跑一遍 server.use 里的中间件（静态资源 / SPA 前端路由走这条） */
const runMiddleware = async (routes, request) => {
  const response = makeResponse(request)
  let nextCalled = false
  for (const middleware of routes.use) {
    await middleware(response, async () => { nextCalled = true })
  }
  return { response, nextCalled }
}

/** 调一个 GET 路由 */
const get = async (routes, routePath, request) => {
  const handler = routes.get[routePath]
  if (!handler) throw new Error('没注册这个路由: GET ' + routePath)
  const response = makeResponse(request)
  await handler(response)
  return response
}

/** 控制台页面换令牌：this 是发起调用的控制台客户端 */
const askToken = (listeners, client = {}) => listeners['kkk/panel-token'].callback.call(client)

const jsonBody = (response) => {
  try {
    return JSON.parse(String(response.body))
  } catch {
    return {}
  }
}

const main = async () => {
  console.log('\n=== 1. 直链 /kkk 必须进不去 ===')
  {
    const { routes, warnings } = setup()
    const page = await get(routes, '/kkk', makeRequest('/kkk'))
    check('GET /kkk（什么都没带）→ 404', page.status === 404, 'status=' + page.status)
    check('  并且留了日志', warnings.some((line) => line.includes('只能从 Koishi 控制台侧边栏进入')), warnings[0] ?? '')

    const asset = await runMiddleware(routes, makeRequest('/kkk/assets/index.js'))
    check('GET /kkk/assets/... → 404（静态资源也拿不到）', asset.response.status === 404, 'status=' + asset.response.status)

    const spa = await runMiddleware(routes, makeRequest('/kkk/assets/config'))
    check('SPA 前端路由 /kkk/assets/config → 404', spa.response.status === 404, 'status=' + spa.response.status)

    check('没有 /kkk/edit 这个入口', !routes.get['/kkk/edit'] && !routes.get['/kkk/edit/'])
  }

  console.log('\n=== 2. 控制台侧边栏那条路要通 ===')
  {
    const { routes, listeners } = setup()
    // 没装 auth 插件：控制台本身不设防，RPC 必须照样发令牌，否则面板在这类部署里打不开
    const token = askToken(listeners, { auth: undefined })
    check('没装 auth 插件时 RPC 也发令牌', typeof token === 'string' && /^[0-9a-f]{32}$/.test(String(token)), String(token).slice(0, 12))

    const page = await get(routes, '/kkk', makeRequest('/kkk?panel=' + token, { query: { panel: token } }))
    check('GET /kkk?panel=<token> → 200', page.status === 200, 'status=' + page.status)
    const cookie = String(page.sent['Set-Cookie'] ?? '')
    check('  并且给面板发了 cookie（后续资源/接口靠它）', cookie.includes('kkk_config_token_panel='), cookie.slice(0, 40))
    check('  cookie 是 HttpOnly', cookie.includes('HttpOnly'), cookie.slice(0, 60))

    // 换到 cookie 之后，静态资源与前端路由都要放行
    const headers = { cookie: 'kkk_config_token_panel=' + token }
    const asset = await runMiddleware(routes, makeRequest('/kkk/assets/index.js', { headers }))
    check('带 cookie 取静态资源 → 放行', asset.response.status === 200 && !!asset.response.body, 'status=' + asset.response.status)
    const spa = await runMiddleware(routes, makeRequest('/kkk/assets/config', { headers }))
    check('带 cookie 走 SPA 前端路由 → 回首页', spa.response.status === 200 && String(spa.response.body).includes('<'), 'status=' + spa.response.status)

    // 接口：先换面板自己的凭据，再用它读配置
    const login = jsonBody(await get(routes, '/kkk/api/v1/login', makeRequest('/kkk/api/v1/login', { headers })))
    check('带 cookie 能换到面板凭据', login.code === 200 && !!login.data?.accessToken, 'code=' + login.code)
    const bearer = { authorization: 'Bearer ' + String(login.data?.accessToken ?? '') }
    const config = jsonBody(await get(routes, '/kkk/v1/config', makeRequest('/kkk/v1/config', { headers: { ...headers, ...bearer } })))
    check('带凭据能读配置', config.code === 200, 'code=' + config.code)
  }

  console.log('\n=== 3. 数据接口同样不能裸奔 ===')
  {
    const { routes } = setup()
    for (const route of ['/kkk/v1/config', '/kkk/v1/bots', '/kkk/api/config', '/kkk/api/v1/login']) {
      const res = jsonBody(await get(routes, route, makeRequest(route)))
      check('GET ' + route + '（什么都没带）→ 401', res.code === 401, 'code=' + res.code)
    }
    const groups = jsonBody(await get(routes, '/kkk/v1/bots/:id/groups', makeRequest('/kkk/v1/bots/123/groups', { params: { id: '123' } })))
    check('GET /kkk/v1/bots/:id/groups → 401', groups.code === 401, 'code=' + groups.code)
  }

  console.log('\n=== 4. 令牌是凭据，不是摆设 ===')
  {
    const { routes } = setup()
    const fake = await get(routes, '/kkk', makeRequest('/kkk?panel=deadbeef', { query: { panel: 'deadbeef' } }))
    check('?panel= 是编的 → 404', fake.status === 404, 'status=' + fake.status)
    const empty = await get(routes, '/kkk', makeRequest('/kkk?panel=', { query: { panel: '' } }))
    check('?panel= 是空的 → 404', empty.status === 404, 'status=' + empty.status)
    const badCookie = await get(routes, '/kkk', makeRequest('/kkk', { headers: { cookie: 'kkk_config_token_panel=deadbeef' } }))
    check('cookie 是编的 → 404', badCookie.status === 404, 'status=' + badCookie.status)
  }

  console.log('\n=== 5. 装了 auth 插件：没登录控制台就换不到令牌 ===')
  {
    const { listeners } = setup({ withAuth: true })
    check('RPC 带 authority: 4（未登录调不到）', listeners['kkk/panel-token']?.options?.authority === 4,
      JSON.stringify(listeners['kkk/panel-token']?.options))
    let threw = ''
    try {
      askToken(listeners, { auth: undefined })
    } catch (error) {
      threw = String(error?.message ?? error)
    }
    check('客户端没登录 → RPC 抛错', threw.includes('请先登录'), threw)
    const okToken = askToken(listeners, { auth: { id: 1, authority: 5 } })
    check('客户端已登录 → 拿到令牌', /^[0-9a-f]{32}$/.test(String(okToken)), String(okToken).slice(0, 12))
  }

  console.log('\n=== 6. 控制台前端靠 status 决定要不要先换令牌 ===')
  {
    const { routes } = setup()
    const status = jsonBody(await get(routes, '/kkk/api/status', makeRequest('/kkk/api/status')))
    /**
     * 前端的逻辑是 `required = authRequired !== false` —— 报 false 的话它会直接把
     * iframe 指向裸的 /kkk，而那条路已经被 404 掉了，面板就打不开。所以必须恒为 true。
     */
    check('authRequired 恒为 true', status?.data?.authRequired === true, JSON.stringify(status?.data))
  }

  console.log('\n' + (fail === 0 ? '\u2714 全部通过' : '\u2718 有 ' + fail + ' 项没通过') + '：' + pass + ' 通过 / ' + fail + ' 失败')
  if (fail > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('\n探针崩了：', error?.stack ?? error)
  process.exitCode = 1
})
