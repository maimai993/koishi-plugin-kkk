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

import { applyUpstreamOverrides } from './configBridge'
import { QQ_KEYS, readQqOptions } from './qqOptions'

const COOKIE_NAME = 'kkk_config_token'
const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000

export interface WebUiDeps {
  ctx: Context
  config: any
  /** 控制台表单里那份「分组」配置（qq / advanced / upstream），保存时照它写回去，保持 koishi.yml 整齐 */
  rawConfig?: any
  logger: any
  pluginRoot: string
}

export function registerWebUi ({ ctx, config, rawConfig, logger, pluginRoot }: WebUiDeps) {
  const server: any = (ctx as any).server
  if (!server || typeof server.get !== 'function') {
    logger.debug('[kkk] 没有 server 服务，跳过配置 WebUI')
    return
  }

  const webRoot = path.join(pluginRoot, 'assets', 'web')

  /** 面板前端是静态包，版本号由这里注入（前端里写的是 __KKK_VERSION__ 占位符） */
  const pluginVersion = (() => {
    try {
      return String(JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf-8')).version || '')
    } catch {
      return ''
    }
  })()
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
  // 面板把登录态存在 localStorage 的 accessToken / userId / refreshToken 三个键里，
  // 登录页只是个表单壳子 —— 与其去点 DOM（React 受控组件很脆），不如直接调登录接口把凭据写进去再刷新。
  try {
    // 每次都重新换一次：面板自己的 token 存在服务端内存里，Koishi 重启就失效，
    // 之前这里看到 localStorage 有值就直接 return，结果一直拿着废 token 请求，全部 401。
    // 防呆：万一接口一直不给凭据，也别在这里无限刷新
    if (sessionStorage.getItem('kkk-autologin') === '1') return;
    sessionStorage.setItem('kkk-autologin', '1');
    fetch('/kkk/api/v1/login', { credentials: 'include' })
      .then(function (res) { return res.json() })
      .then(function (res) {
        var data = res && res.data;
        if (!data || !data.accessToken) return;
        localStorage.setItem('userId', String(data.userId || 'kkk'));
        localStorage.setItem('accessToken', data.accessToken);
        localStorage.setItem('refreshToken', data.refreshToken || '');
        location.reload();
      })
      .catch(function () {});
  } catch (e) { /* 无痕模式可能禁用 localStorage，那就让用户自己登 */ }
})();
</script>`

  const indexHtml = (): Buffer => {
    const raw = readWebFile('index.html')
    if (!raw) return Buffer.from('<h1>KKK Config</h1><p>assets/web/index.html 缺失</p>')
    // 面板自己的登录态（Karın 版那套 accessToken）由这里自动补上：
    // 能走到这一步说明请求已经通过鉴权（免登录，或者带着控制台换来的面板 token），
    // 所以直接帮用户登进去，不用再面对一个「请输入 HTTP 鉴权密钥」的表单。
    const text = raw.toString('utf-8')
    return Buffer.from(text.includes('</body>') ? text.replace('</body>', autoLoginScript + '</body>') : text + autoLoginScript)
  }

  /* ---------------- 登录策略 ---------------- */

  /**
   * 面板（/kkk）是否需要登录。
   *
   * 默认**要求登录**：装了 auth 插件的部署，只有登录 Koishi 控制台后
   * （由控制台页面通过 RPC 换取面板 token）才能打开面板；
   * 没装 auth 插件的部署本来就没有登录这回事，这里不生效。
   * 想改成完全公开，把配置里的 `webUiAuth` 关掉即可。
   */
  const authRequired = () => (config as any)?.webUiAuth !== false && !!(ctx as any).get?.('auth')

  /** 打开面板时控制台会把登录 token 一起带过来，用它换一个面板自己的 cookie */
  const tokenAuthed = async (id: unknown, token: unknown): Promise<boolean> => {
    const aid = Number(id)
    const value = String(token || '')
    if (!Number.isFinite(aid) || !value) return false
    const database: any = (ctx as any).get?.('database')
    if (!database?.get) return false
    try {
      const rows = await database.get('token', { id: aid, token: value }, ['expiredAt'])
      return !!(rows?.[0] && Number(rows[0].expiredAt) > Date.now())
    } catch {
      return false
    }
  }

  /**
   * 控制台登录态。
   *
   * 两条路：
   *   1. 控制台页面（左侧边栏「kkk 配置」）会带上 `?uid=&token=`，校验通过后落到面板自己的 cookie；
   *   2. 之后页面里的静态资源和接口都靠这个 cookie 放行。
   * 没装 auth 插件时 `authRequired()` 为假，一律放行。
   */
  const consoleAuthed = async (request: any): Promise<boolean> => {
    if (!authRequired()) return true
    const cookie = String(request?.headers?.cookie || '')
    const fromCookie = new RegExp(COOKIE_NAME + '=(\\d+):([0-9a-f]+)').exec(cookie)
    if (fromCookie && await tokenAuthed(fromCookie[1], fromCookie[2])) return true
    const query = request?.query ?? {}
    // 控制台页面换来的面板 token（cookie 或 query 都认）
    const fromPanelCookie = new RegExp(COOKIE_NAME + '_panel=([0-9a-f]+)').exec(cookie)
    if (fromPanelCookie && panelTokenValid(fromPanelCookie[1])) return true
    if (panelTokenValid(query.panel)) return true
    if (await tokenAuthed(query.uid, query.token)) return true
    // 兼容一些老版本控制台把 auth 放在 cookie 里的写法（name=id:token）
    const database: any = (ctx as any).get?.('database')
    if (!database?.get) return false
    for (const match of cookie.matchAll(/(?:^|;\s*)([\w-]+)=(\d+):([0-9a-f]+)/g)) {
      if (await tokenAuthed(match[2], match[3])) return true
    }
    return false
  }

  /** 面板自己的 cookie：`id:token` */
  const rememberPanelToken = (response: any) => {
    const query = response?.request?.query ?? {}
    const maxAge = Math.floor(TOKEN_TTL / 1000)
    if (query.panel && panelTokenValid(query.panel)) {
      response.set('Set-Cookie', COOKIE_NAME + '_panel=' + String(query.panel) + '; Path=/kkk; HttpOnly; Max-Age=' + maxAge)
      return
    }
    if (query.uid && query.token) {
      response.set('Set-Cookie', COOKIE_NAME + '=' + query.uid + ':' + query.token + '; Path=/kkk; HttpOnly; Max-Age=' + maxAge)
    }
  }

  /**
   * 整理写回 koishi.yml 的那份配置：QQ 适配器的字段统一收进 `qq` 分组。
   *
   * 早期版本这些开关直接写在顶层，摊平时 `qq` 优先，清掉顶层那份免得两边数值打架
   * （用户会看到表单和实际生效值不一致）。
   */
  /** 面板把「错误日志接收人」这类多值字段做成了文本框，保存时把字符串拆成数组 */
  const LIST_UPSTREAM_PATHS: Array<[string, string]> = [['app', 'errorLogSendTo']]

  const normalizeLists = (upstream: any) => {
    if (!upstream || typeof upstream !== 'object') return upstream
    for (const [group, key] of LIST_UPSTREAM_PATHS) {
      const value = upstream?.[group]?.[key]
      if (typeof value === 'string') {
        upstream[group][key] = value.split(/[,，\s]+/).map((item: string) => item.trim()).filter(Boolean)
      }
    }
    return upstream
  }

  const normalize = (source: any) => {
    const next: any = { ...source }
    const group = { ...readQqOptions(source), ...(next.qq ?? {}) }
    let used = !!next.qq
    for (const key of QQ_KEYS) {
      if (next[key] !== undefined) {
        used = true
        delete next[key]
      }
    }
    if (used) next.qq = group
    return next
  }

  /* ---------------- 控制台 RPC：换一个面板专用 token ---------------- */

  /**
   * 面板 token：控制台页面（左侧边栏「kkk 配置」）通过 RPC 向服务端要一个，
   * 再拼到 iframe 地址上（`/kkk?panel=<token>`）。服务端校验通过后给面板发 cookie，
   * 后续静态资源与接口都靠它放行。
   *
   * 关键点：RPC 监听器带 `authority: 4`，**未登录或权限不足的客户端根本调不到**，
   * 所以「不登录就打不开面板」这件事是服务端强制的，不依赖前端自觉。
   */
  const panelTokens = new Map<string, number>()
  const PANEL_TOKEN_TTL = 10 * 60 * 1000

  const issuePanelToken = (): string => {
    const value = crypto.randomBytes(16).toString('hex')
    panelTokens.set(value, Date.now() + PANEL_TOKEN_TTL)
    return value
  }

  const panelTokenValid = (value: unknown): boolean => {
    const key = String(value || '')
    const expire = panelTokens.get(key)
    if (!expire) return false
    if (expire < Date.now()) {
      panelTokens.delete(key)
      return false
    }
    return true
  }

  try {
    const consoleService: any = (ctx as any).console
    if (typeof consoleService?.addListener !== 'function') {
      logger.warn('[kkk] 控制台没有 addListener，面板 token RPC 未注册（面板将无法从控制台获取登录态）')
    } else {
      consoleService.addListener('kkk/panel-token', function (this: any) {
        // this 是发起调用的控制台客户端，auth 由 auth 插件写入
        if (!this?.auth) throw new Error('请先登录 Koishi 控制台')
        return issuePanelToken()
      }, { authority: 4 })
    }
  } catch (error: any) {
    logger.warn('[kkk] 注册面板 token RPC 失败: ' + String(error?.message ?? error))
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
    // 面板 cookie（控制台换来的）本身就是授权凭据，接口请求直接用账号密码也不用再走一遍
    const panelCookie = new RegExp(COOKIE_NAME + '_panel=([0-9a-f]+)').exec(String(request?.headers?.cookie || ''))
    if (panelCookie && panelTokenValid(panelCookie[1])) return true
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
    // 在 Koishi 这边它就存在 `upstream` 里，启动时同步进 config.json。
    // 另外附一份 `qq`（「QQ 适配器」分类）：面板/切片/番剧选集/卡片识别这些是 Koishi 侧才有的开关，
    // 面板里作为独立分类显示，保存时由下面的 POST 拆出来写回 koishi.yml。
    ok(response, { ...(config?.upstream ?? {}), qq: readQqOptions(config) }, '')
  })

  server.post('/kkk/v1/config', async (response: any) => {
    if (!authed(response)) return fail(response, 401, '鉴权失败: 缺少authorization')
    try {
      const body: any = response.request?.body
      if (!body || typeof body !== 'object') throw new Error('请求体不是配置对象')
      // 原版面板发过来的是整份配置：
      //   - `qq`（面板里的「QQ 适配器」分类）→ 写回插件自己的配置（koishi.yml）
      //   - 其余整份 → upstream（Karin 版的 config.json 形状）
      // 保存都走 scope.update → 落盘 koishi.yml → 热重载 → 启动时同步回 config.json
      const { qq, ...upstream } = normalizeLists(body)
      await (ctx as any).scope.update(normalize({
        ...(rawConfig ?? config),
        ...(qq && typeof qq === 'object' ? { qq: { ...readQqOptions(config), ...qq } } : {}),
        upstream
      }))
      /**
       * 面板是**权威**的：表单里那份配置就是用户想要的，所以这里再用 authoritative 模式
       * 直接同步一次 config.json —— 值等于上游默认值也要真的落盘。
       *
       * 否则会踩「打开了没用」：合并转发开关 `app.fakeForward` 的默认值就是 true，
       * 用户在面板里把它打开、保存，走 apply 阶段那条保守规则时会被当成「没动过」跳过，
       * config.json 里还是 false（用户实测反馈的就是这个）。
       */
      try {
        const merged = applyUpstreamOverrides(upstream, { authoritative: true })
        if (merged.changed.length) logger.info('[kkk] 面板设置已写入 config.json: ' + merged.changed.join(', '))
      } catch (error: any) {
        logger.warn('[kkk] 面板设置写入 config.json 失败（改动会在下次启动时按保守规则同步）: ' + String(error?.message ?? error))
      }
      logger.info('[kkk] 配置面板已保存（QQ 适配器 → 插件配置，其余 → upstream，写回 koishi.yml）')
      ok(response, null, '已保存')
    } catch (error: any) {
      /**
       * 保存失败要把**调用栈**也带上：只打 message（例如那句
       * \`Cannot read properties of null (reading 'logger')\`）根本看不出是哪一层抛的，
       * 实际排查时只能靠这几行。
       */
      const rawMessage = String(error?.message ?? error)
      const stack = String(error?.stack ?? '').split('\n').slice(1, 16).map((line) => line.trim()).join(' | ')
      logger.warn('[kkk] 配置面板保存失败: ' + rawMessage + (stack ? '（' + stack + '）' : ''))
      /**
       * 保存失败里最常见、也最看不懂的一种：值没通过 Schema 校验。
       * 宿主（cordis）在 `resolveConfig` 抛错后会 emit 一个 `internal/error`，
       * 而 `@cordisjs/logger` 的监听器会**再抛一个** `Cannot read properties of null (reading 'logger')`，
       * 原始错误被它盖掉 —— 用户看到的就只有这一句。这里换成能照做的提示。
       */
      const message = /reading 'logger'/.test(rawMessage)
        ? '配置没通过校验：某个字段填的值不在允许范围内（常见于把用户 ID 填进了只能选关键字的字段）。请检查刚改过的那一项，详细信息见 Koishi 日志。'
        : rawMessage
      fail(response, 500, message)
    }
  })

  /**
   * 面板鉴权状态。控制台页面（iframe 的父页面）用它决定是直接打开面板还是提示先登录：
   * 未登录时不要把 token 传进来，也就不会给面板发 cookie。
   */
  server.get('/kkk/api/status', async (response: any) => {
    ok(response, {
      authRequired: authRequired(),
      authed: await consoleAuthed(response),
    }, '')
  })

  /* ---------------- 数据接口 ---------------- */

  /**
   * 面板能选的机器人账号。
   *
   * 同一个账号可能同时挂了多个适配器（这台部署就是 `qq` + `qqguild`，selfId 一样），
   * 而推送目标里存的 `botId` 就是 selfId —— 重复的条目只会让下拉里出现两个一模一样的选项，
   * 所以按 selfId 去重（保留第一个）。
   */
  const botList = () => {
    const bots: any[] = (ctx as any).bots ?? []
    const seen = new Set<string>()
    const list: any[] = []
    for (const bot of bots) {
      const id = String(bot?.selfId ?? bot?.user?.id ?? '')
      if (!id || seen.has(id)) continue
      seen.add(id)
      list.push({
        id,
        name: String(bot?.user?.name ?? bot?.selfId ?? ''),
        avatar: String(bot?.user?.avatar ?? ''),
        platform: String(bot?.platform ?? ''),
        status: 1
      })
    }
    return list
  }

  /** 按 selfId 找适配器实例（找不到返回 undefined） */
  const findBot = (botId: string): any =>
    ((ctx as any).bots ?? []).find((bot: any) => String(bot?.selfId ?? bot?.user?.id ?? '') === String(botId))

  /** 从各种适配器/数据库形态里把「群 / 频道」列表掰成 { id, name, avatar }（拿不到就空数组） */
  const normalizeChannelList = (raw: any): Array<{ id: string, name: string, avatar: string }> => {
    const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : []
    const list: Array<{ id: string, name: string, avatar: string }> = []
    for (const row of rows) {
      const id = String(row?.id ?? row?.channelId ?? row?.guildId ?? row?.groupId ?? '')
      if (!id) continue
      list.push({
        id,
        name: String(row?.name ?? row?.nick ?? row?.guildName ?? id),
        avatar: String(row?.avatar ?? '')
      })
    }
    return list
  }

  /**
   * 某个机器人账号能看到的群 / 频道（拿不到就是空数组）。
   *
   * 面板里的群号是**手填**的，这个列表只用来：① 给手填的值配一个名字 / 头像；② 别让手填的值被前端清掉。
   * 三条路依次试：适配器自己的列表接口 → 数据库里的 channel 表 → 放弃。全都要兜住，
   * 任何一个抛错都不能影响面板（这个接口以前直接返回 `[]`，用户填完群号会被前端当成「无效」清空）。
   */
  const botChannels = async (botId: string): Promise<Array<{ id: string, name: string, avatar: string }>> => {
    const bot: any = findBot(botId)
    for (const method of ['getGuildList', 'getGroupList', 'getChannelList']) {
      if (!bot || typeof bot[method] !== 'function') continue
      try {
        const list = normalizeChannelList(await bot[method]())
        if (list.length) return list
      } catch (error: any) {
        logger.debug('[kkk] 拉取机器人列表失败（' + method + '）: ' + String(error?.message ?? error))
      }
    }
    try {
      const db: any = (ctx as any).database
      if (db && typeof db.get === 'function' && bot?.platform) {
        const rows = await db.get('channel', { platform: String(bot.platform) }, ['id', 'name'])
        const list = normalizeChannelList(rows)
        if (list.length) return list
      }
    } catch (error: any) {
      logger.debug('[kkk] 从数据库读频道列表失败: ' + String(error?.message ?? error))
    }
    return []
  }

  server.get('/kkk/v1/bots', (response: any) => {
    if (!authed(response)) return fail(response, 401, '鉴权失败: 缺少authorization')
    ok(response, botList(), '')
  })

  server.get('/kkk/v1/bots/:id/groups', async (response: any) => {
    if (!authed(response)) return fail(response, 401, '鉴权失败: 缺少authorization')
    ok(response, await botChannels(String(response.params?.id ?? '')), '')
  })

  /**
   * 推送目标的展示信息（面板在「推送目标」弹窗里批量拉一次）。
   *
   * ## 契约（**必须返回数组，绝不能 null**）
   * 前端拿到的是 `oR(...)` 的 `data`，随后直接 `data.find(...)`：
   * 这个接口原来返回 `data: null`，于是用户「填完群号点完成」时渲染期抛
   * `TypeError: Cannot read properties of null (reading 'find')` —— React 会卸载整棵树，面板直接黑屏（线上事故）。
   * 所以这里：
   *   - 永远返回数组（解析不出来就给空数组）；
   *   - 每一项带上 groupName / botName / isOnline，拿不到就只给 id，前端会退回显示 id。
   */
  server.post('/kkk/v1/groups/batch', async (response: any) => {
    if (!authed(response)) return fail(response, 401, '鉴权失败: 缺少authorization')
    try {
      const body: any = response.request?.body ?? {}
      const raw = Array.isArray(body?.groups) ? body.groups : []
      /** 请求里的每一项可能是 { groupId, botId }，也可能直接是 'groupId:botId' 字符串 */
      const wanted = raw.map((item: any) => {
        if (typeof item === 'string') {
          const [groupId, botId] = item.split(':')
          return { groupId: String(groupId ?? ''), botId: String(botId ?? '') }
        }
        return { groupId: String(item?.groupId ?? ''), botId: String(item?.botId ?? '') }
      }).filter((item) => item.groupId && item.botId)

      const cache = new Map<string, Array<{ id: string, name: string, avatar: string }>>()
      const list: any[] = []
      for (const item of wanted) {
        if (!cache.has(item.botId)) cache.set(item.botId, await botChannels(item.botId))
        const bot: any = findBot(item.botId)
        const channel = cache.get(item.botId)?.find((row) => row.id === item.groupId)
        const target: any = { groupId: item.groupId, botId: item.botId }
        if (channel) {
          if (channel.name) target.groupName = channel.name
          if (channel.avatar) target.groupAvatar = channel.avatar
        }
        if (bot) {
          target.botName = String(bot.user?.name ?? bot.selfId ?? '')
          target.botAvatar = String(bot.user?.avatar ?? '')
          target.isOnline = Number(bot.status ?? 0) === 1
        }
        list.push(target)
      }
      ok(response, list, '')
    } catch (error: any) {
      // 兜底也要给数组：这里返回 null 会让面板在渲染期崩掉
      logger.warn('[kkk] 解析推送目标失败（返回空列表，避免面板黑屏）: ' + String(error?.message ?? error))
      ok(response, [], '')
    }
  })

  /* ---------------- 静态资源 + SPA 路由 ---------------- */

  /**
   * 静态资源 + SPA 路由。
   *
   * 用**中间件**而不是 `server.get('/kkk/assets/*')`：新版 path-to-regexp 不再接受
   * 这种无名的 `*` 通配（会直接抛 `Unexpected MODIFIER` 把整个插件搞崩），
   * 手动判前缀最省事也最兼容。
   */
  /**
   * 面板页面与静态资源的鉴权。
   *
   * `webUiAuth` 关（默认）时一律放行 —— 打开 `/kkk` 就能改配置；
   * 打开后要求**已登录 Koishi 控制台**（认控制台的 cookie），没登录直接给提示页，
   * 这样未登录状态下连 SPA 的静态资源和 /kkk/assets/config 这种前端路由也拿不到。
   */
  const pageDenied = async (response: any): Promise<boolean> => {
    if (!authRequired()) return false
    if (await consoleAuthed(response)) return false
    // 直接当成「没有这个页面」：面板只从控制台侧边栏进，独立 URL 不给任何提示
    response.status = 404
    response.type = 'text/plain; charset=utf-8'
    response.body = 'Not Found'
    return true
  }

  /**
   * 控制台下发的插件前端包（`/@plugin-<id>/index.js`）默认没有缓存头，
   * 浏览器会拿旧的 bundle 一直用（改了客户端逻辑却看不到效果）。
   * 这里给本插件自己的入口加 no-store —— qq-chat 也是这么处理的。
   */
  const isOwnEntry = (requestPath: string): boolean => {
    if (!requestPath.includes('/@plugin-')) return false
    const entries: any = (ctx as any).console?.entries ?? {}
    for (const key of Object.keys(entries)) {
      if (!requestPath.startsWith('/@plugin-' + key)) continue
      const files: any = entries[key]?.files
      const list = Array.isArray(files) ? files : [files?.dev, files?.prod]
      if (list.some((file: any) => typeof file === 'string' && file.includes('koishi-plugin-kkk'))) return true
    }
    return false
  }

  server.use(async (response: any, next: any) => {
    const requestPath = String(response.path || '')
    if (isOwnEntry(requestPath)) {
      await next()
      response.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
      return
    }
    if (!requestPath.startsWith('/kkk/assets/')) return next()
    if (await pageDenied(response)) return
    const relative = decodeURIComponent(requestPath.slice('/kkk/assets/'.length))
    const raw = relative ? readWebFile(relative) : null
    if (!raw) {
      // SPA 自己的前端路由（/kkk/assets/config、/kkk/assets/about 等）→ 回 index.html
      response.type = 'text/html; charset=utf-8'
      response.body = indexHtml()
      return
    }
    response.type = MIME[path.extname(relative).toLowerCase()] ?? 'application/octet-stream'
    // 前端包里带 __KKK_VERSION__ 占位符的文件，按真实版本号替换后再发
    const file = pluginVersion && relative.endsWith('.js') && raw.includes('__KKK_VERSION__')
      ? Buffer.from(raw.toString('utf-8').replace(/__KKK_VERSION__/g, pluginVersion))
      : raw
    // 不缓存：面板的前端包会被我们改动（接口路径等），浏览器缓存旧包会直接导致「打不开/接口报错」
    response.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
    response.body = file
  })

  for (const route of ['/kkk', '/kkk/', '/kkk/login']) {
    server.get(route, async (response: any) => {
      if (await pageDenied(response)) return
      rememberPanelToken(response)
      response.type = 'text/html; charset=utf-8'
      response.body = indexHtml()
    })
  }

  /* ---------------- 简易编辑页（改插件配置） ---------------- */

  server.get('/kkk/edit', async (response: any) => {
    if (await pageDenied(response)) return
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
      const next: any = normalize({ ...config, ...patch })
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
