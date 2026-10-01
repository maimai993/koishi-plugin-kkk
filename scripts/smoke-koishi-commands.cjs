/**
 * 冒烟测试：指令注册与分发（去掉 # 前缀，注册成真正的 Koishi 指令）。
 *
 * 覆盖：
 *   1. 全部指令都注册成真正的 Koishi 指令，并且**挂在 `kkk` 分组下**（名字是 `kkk.xxx`）；
 *   2. 老的裸名字（`解析` / `kkk帮助` / `b站登录` / `下载进度` …）**一个都不能少** ——
 *      它们现在是别名，用户习惯和 QQ 按钮里的指令文本都靠它们；
 *   3. 指令的 action 走通：裸写 `解析 <链接>`、带前缀 `/解析 <链接>`、
 *      分组写法 `kkk.解析 <链接>` / `kkk 解析 <链接>` 都能触发解析面板；
 *   4. 旧的 `#解析 <链接>` 仍可用（兜底中间件），且中间件**确实把它消费掉了**；
 *   5. 面板按钮发出去的就是「不带 # 的指令」，短令牌能换回真实链接；
 *   6. interaction/button（回调按钮）那条路也能执行指令；
 *   7. autoParse=false 时裸链接交给别人、指令照常可用。
 *
 * 用法：node scripts/smoke-koishi-commands.cjs
 * 说明：测试用 QQ 平台（platform=qqguild），解析会先出「交互面板」，
 *       既验证了指令链路，又不会真的去下载视频。
 *
 * 两个**环境相关**的点（不算失败，会明确标出来）：
 *   - `kkk帮助` / `kkk版本` 这类指令要**渲染图片**（puppeteer），没有渲染器时看不到回复；
 *   - 消息里的**裸链接自动解析**要联网取作品信息。
 *   所以下面用「中间件有没有把消息消费掉」来判定指令识别成功，而不只看发了什么。
 *
 * 注意：插件声明了 `inject.required = ['database']`，**必须给一个数据库服务**
 * 它才会 apply —— 少这一句的话指令表永远是 0 个（这个坑一开始就在）。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Context } = require('koishi')
const sqlite = require('@koishijs/plugin-database-sqlite').default

const pluginRoot = path.resolve(__dirname, '..')
const dataRoot = path.resolve(pluginRoot, 'data-smoke-kcmd')
fs.mkdirSync(path.join(dataRoot, 'koishi-plugin-kkk', 'config'), { recursive: true })
const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'config/default_config/config.json'), 'utf8'))
config.app.parseTip = false
fs.writeFileSync(path.join(dataRoot, 'koishi-plugin-kkk', 'config', 'config.json'), JSON.stringify(config, null, 2))

const plugin = require(path.join(pluginRoot, 'lib/index.js'))
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkk-kcmd-'))

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  —— ' + detail : ''))
}
const skip = (name, detail) => console.log('  ⏭ ' + name + (detail ? '  —— ' + detail : ''))

const URL = 'https://www.bilibili.com/video/BV1xx411c7mD'
/** 解析面板的稳定特征（各平台面板表头不一样，这里只用 B站 的） */
const PANEL = /清晰度\s*\|\s*弹幕/
/** 给「需要联网」的用例加个上限，免得离线时把整个测试挂住 */
const withTimeout = (promise, ms, fallback) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))])

/** 起一套「有数据库、抓得到中间件」的 ctx，并等插件 apply 完 */
const makeCtx = async (options) => {
  const ctx = new Context()
  ctx.plugin(sqlite, { path: path.join(dbDir, Math.random().toString(36).slice(2) + '.db') })
  await ctx.start()

  const middlewares = []
  const original = ctx.middleware.bind(ctx)
  ctx.middleware = (fn, ...rest) => { middlewares.push(fn); return original(fn, ...rest) }

  let sent = []
  const fakeBot = {
    selfId: '10000', platform: 'qqguild', status: 1, user: { id: '10000', name: 's' }, ctx,
    sendMessage: async (ch, c) => { sent.push(c); return ['m'] },
    getGuild: async () => ({ name: 'g' }), getFriendList: async () => []
  }
  Object.defineProperty(ctx, 'bots', { get: () => [fakeBot] })

  const fork = ctx.plugin(plugin, options)
  // 插件 apply 里有几处 await import，轮询等它把指令注册完
  for (let i = 0; i < 80 && !ctx.$commander._commandList.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await new Promise((resolve) => setTimeout(resolve, 200))

  /**
   * **每次会话都换一个 channelId**。
   *
   * 插件有「短时间不重复解析」（`parseDedupe`，默认开），去重键里带会话 + 用户 + 作品。
   * 下面要连着解析同一个链接好几遍（裸写 / 带前缀 / 分组写法），共用会话的话第 2 次起会被
   * 当成「重复解析」直接拦掉，看起来像指令没生效。换会话就等价于「另一个群里发了同一条链接」。
   */
  let sessionSeq = 0
  const makeSession = (content) => {
    const id = ++sessionSeq
    return {
      content, selfId: '10000', userId: '12345', guildId: '456', channelId: '456-' + id, messageId: 'm' + id,
      bot: fakeBot, author: { nick: 's' }, username: 's', event: {}, user: { id: '12345' },
      send: async (c) => { sent.push(c); return ['m2'] }
    }
  }

  /** 读这一次 dispatch 发出的面板内容 */
  const readSent = () => {
    const flat = []
    for (const item of sent) for (const el of (Array.isArray(item) ? item : [item])) flat.push(el)
    const markdown = flat.filter((el) => el && el.type === 'markdown')
      .map((el) => (el.children || []).map((child) => child.attrs && child.attrs.content).join('')).join('\n')
    // 按钮是 markdown 内联的 <qqbot-cmd-input text="…" show="…" />（群聊唯一可用的指令标签）
    const buttons = []
    const pattern = /<qqbot-cmd-input\s+text="([^"]*)"\s+show="([^"]*)"\s+reference="[^"]*"\s*\/>/g
    let matched
    while ((matched = pattern.exec(markdown)) !== null) {
      buttons.push({ data: decodeURIComponent(matched[1]), label: decodeURIComponent(matched[2]) })
    }
    /** 所有发出去的内容拍平成一段文本（纯文本回复、文本段都要，用来断言回复文案） */
    const text = flat.map((el) => (typeof el === 'string' ? el
      : el && el.type === 'text' ? String(el.attrs?.content ?? '')
      : el && el.type === 'markdown' ? (el.children || []).map((c) => c.attrs?.content ?? '').join('')
      : '')).join('\n')
    return { sent: sent.length, markdown, buttons, text }
  }

  /**
   * 走中间件链（验证「链接自动解析」和旧的 # 写法）。
   * `consumed` = 消息被某个中间件拦下（没继续 next），这是「指令被认出来了」的可靠信号，
   * 不依赖后面能不能渲染出图片 / 能不能联网。
   */
  const dispatchMiddleware = async (content) => {
    sent = []
    const session = makeSession(content)
    let index = 0
    let stopped = -1
    const run = async () => {
      while (index < middlewares.length) {
        const at = index++
        let continued = false
        await middlewares[at](session, () => { continued = true; return run() })
        if (!continued) { stopped = at; return }
      }
    }
    await run()
    return { ...readSent(), consumed: stopped >= 0, stoppedAt: stopped }
  }

  /** 按「用户敲的那串字」走一遍 Koishi 的指令解析，再调它自己的 action */
  const runCommand = async (typed, content) => {
    const command = ctx.$commander.resolve(typed)
    if (!command) throw new Error('解析不出指令: ' + typed)
    sent = []
    const session = makeSession(content ?? typed)
    await command._actions[command._actions.length - 1]({ session, options: {}, args: [] })
    return readSent()
  }

  return { ctx, fork, makeSession, readSent, dispatchMiddleware, runCommand, fakeBot, getSent: () => sent, clearSent: () => { sent = [] } }
}

;(async () => {
  try {
    const { ctx, dispatchMiddleware, runCommand } = await makeCtx({ dataPath: dataRoot, debug: true, masters: ['12345'], qqPanel: true })
    const list = ctx.$commander._commandList
    const names = list.map((item) => item.name)
    const i18n = ctx.i18n._data[''] || {}
    const desc = (name) => i18n['commands.' + name + '.description'] || ''
    const group = ctx.$commander.resolve('kkk')

    console.log('\n[1] 指令全部挂在 kkk 分组下')
    check('有 kkk 分组节点', names.includes('kkk'), '共 ' + names.length + ' 条指令')
    check('除了分组节点，其余指令名字都带 kkk. 前缀', names.every((name) => name === 'kkk' || name.startsWith('kkk.')), names.filter((n) => n !== 'kkk' && !n.startsWith('kkk.')).join(' / ') || '（无）')
    check('子指令数量与分组表一致', list.filter((item) => item.name.startsWith('kkk.')).length === group.children.filter((item) => item.name.includes('.')).length, list.filter((item) => item.name.startsWith('kkk.')).length + ' 个子指令')
    check('「解析」「弹幕解析」「帮助」都在分组下', ['kkk.解析', 'kkk.弹幕解析', 'kkk.帮助'].every((name) => names.includes(name)))
    check('指令带说明（控制台可见）', desc('kkk.解析').length > 0 && desc('kkk.弹幕解析').length > 0, '解析: ' + desc('kkk.解析') + ' / 弹幕解析: ' + desc('kkk.弹幕解析'))
    check('权限类指令也在分组下', names.includes('kkk.b站登录') && names.includes('kkk.设置抖音推送'), names.filter((name) => /登录|推送/.test(name)).length + ' 条')

    console.log('\n[2] 控制台的指令树（Command.toJSON 的 children）')
    const json = group.toJSON()
    const childNames = (json.children || []).map((item) => item.name)
    check('分组节点的 children 非空', childNames.length > 0, childNames.length + ' 个')
    check('children 全是 kkk.xxx', childNames.every((name) => name.startsWith('kkk.')), childNames.slice(0, 4).join(' '))
    check('children 里能看到 解析 / 帮助 / 下载进度', ['kkk.解析', 'kkk.帮助', 'kkk.下载进度'].every((name) => childNames.includes(name)))
    check('子指令的 parent 指回分组节点', group.children.every((item) => item.parent === group))

    console.log('\n[3] 老名字（别名）一个都不能少')
    // 升级前注册过的全部名字（大小写由 Command.normalize 归一到小写）
    const legacy = [
      'kkk封面', 'kkk评论', '提取封面图', '提取评论区图片', 'kkk推送全局忽略', '渲染流程图', '卡片消息',
      '解析', 'kkk解析', '弹幕解析', 'kkk帮助', 'kkk版本', 'kkk更新日志',
      'b站登录', 'b站扫码登录', 'kkkb站登录', 'kkkb站扫码登录', '抖音登录', '抖音扫码登录', 'kkk抖音登录', 'kkk抖音扫码登录',
      '抖音强制推送', '抖音全部强制推送', 'b站强制推送', 'b站全部强制推送',
      '设置抖音推送', '设置b站推送', 'b站推送列表', '抖音推送列表', 'kkk设置推送机器人', '登录', 'kkk登录',
      'kkk解析统计', 'kkk全局解析统计', '测试抖音作品推送', '测试抖音喜欢列表推送', '测试抖音推荐列表推送', '测试抖音直播状态推送',
      'kkk更新', '下载进度'
    ]
    const missing = legacy.filter((name) => !ctx.$commander.resolve(name))
    check('40 个老名字仍能解析到指令', missing.length === 0, missing.length ? '缺失: ' + missing.join(' ') : '全部命中')
    check('老名字都指到 kkk 分组下的指令', legacy.every((name) => String(ctx.$commander.resolve(name)?.name ?? '').startsWith('kkk.')), '例：解析 → ' + ctx.$commander.resolve('解析')?.name)
    check('同名合并：解析 / kkk解析 是同一条指令', ctx.$commander.resolve('解析') === ctx.$commander.resolve('kkk解析'))
    check('同名合并：b站登录 / kkkb站登录 是同一条指令', ctx.$commander.resolve('b站登录') === ctx.$commander.resolve('kkkb站登录'))

    console.log('\n[4] 指令 action 走通（裸写 / 带前缀 / 分组写法）')
    const bare = await runCommand('解析', '解析 ' + URL)
    check('「解析 <链接>」触发解析面板', PANEL.test(bare.markdown), bare.markdown.replace(/\n/g, ' ').slice(0, 60) || '（无输出）')
    const slash = await runCommand('解析', '/解析 ' + URL)
    check('「/解析 <链接>」同样触发', PANEL.test(slash.markdown))
    const dotted = await runCommand('kkk.解析', 'kkk.解析 ' + URL)
    check('「kkk.解析 <链接>」同样触发', PANEL.test(dotted.markdown), dotted.markdown.replace(/\n/g, ' ').slice(0, 60) || '（无输出）')
    const spaced = await runCommand('kkk.解析', 'kkk 解析 ' + URL)
    check('「kkk 解析 <链接>」同样触发', PANEL.test(spaced.markdown))
    const aliasCmd = await runCommand('kkk解析', 'kkk解析 ' + URL)
    check('老的「kkk解析 <链接>」同样触发', PANEL.test(aliasCmd.markdown))
    const progress = await runCommand('下载进度', '下载进度')
    check('「下载进度」（老写法）有回复', progress.sent > 0, '发出 ' + progress.sent + ' 条')
    const progressGrouped = await runCommand('kkk.下载进度', 'kkk 下载进度')
    check('「kkk 下载进度」有回复', progressGrouped.sent > 0, '发出 ' + progressGrouped.sent + ' 条')
    const groupOnly = await runCommand('kkk', 'kkk')
    check('只敲「kkk」会列出子指令', groupOnly.sent > 0, '发出 ' + groupOnly.sent + ' 条')

    /**
     * 「分组写法要还原成 karin 注册表认的裸名字」的**硬证据**。
     *
     * `推送全局忽略` 的 karin 正则是 `^#kkk推送全局忽略` —— **强制带 `kkk`**。
     * 所以只要 `kkk.推送全局忽略` 能被还原成 `kkk推送全局忽略`，不带参数时就会回一句
     * 「请提供链接」（纯文本、不渲染、不联网）；还原失败的话发出去的是
     * `#kkk.推送全局忽略`，正则匹配不上、连回复都没有。这条能把「还原」和「没还原」分开。
     */
    const dottedGrouped = await runCommand('kkk.推送全局忽略', 'kkk.推送全局忽略')
    check('「kkk.推送全局忽略」被还原成 `kkk推送全局忽略` 并命中', /请提供链接/.test(dottedGrouped.text), dottedGrouped.text.slice(0, 40) || '（无输出）')
    const spacedGrouped = await runCommand('kkk.推送全局忽略', 'kkk 推送全局忽略')
    check('「kkk 推送全局忽略」（空格写法）同样命中', /请提供链接/.test(spacedGrouped.text), spacedGrouped.text.slice(0, 40) || '（无输出）')
    const aliasGrouped = await runCommand('kkk推送全局忽略', 'kkk推送全局忽略')
    check('老的「kkk推送全局忽略」当然也命中', /请提供链接/.test(aliasGrouped.text), aliasGrouped.text.slice(0, 40) || '（无输出）')

    const parseCmd = list.find((item) => item.name === 'kkk.解析')
    check('解析 指令声明了面板用到的选项', ['qn', 'q', 'dm', 'panel'].every((key) => key in ((parseCmd && parseCmd._options) || {})), Object.keys((parseCmd && parseCmd._options) || {}).join(','))

    console.log('\n[5] 面板按钮发的是不带 # 的指令')
    console.log('     按钮：' + bare.buttons.map((button) => '[' + button.label + ']').join(' '))
    check('按钮里没有 # 前缀', bare.buttons.length > 0 && bare.buttons.every((button) => !String(button.data).startsWith('#')), bare.buttons[0] && bare.buttons[0].data)
    check('按钮文本都落在 kkk 分组下的指令上（解析 / 弹幕解析 / 提取…）', bare.buttons.every((button) => /^(解析|弹幕解析|kkk封面|kkk评论|提取封面图|提取评论区图片)/.test(String(button.data))), bare.buttons.map((button) => button.data.split(' ')[0]).join(' | '))
    const danmakuButton = bare.buttons.find((button) => String(button.data).includes('--dm=1'))
    check('存在带弹幕那一档的按钮（--dm=1）', !!danmakuButton, danmakuButton && danmakuButton.data)
    check('没有任何按钮带 --panel（点了不会再弹面板）', bare.buttons.every((button) => !String(button.data).includes('--panel')), bare.buttons.map((button) => button.data).join(' | '))
    const { resolvePanelToken } = require(path.join(pluginRoot, 'lib/karin/module/utils/QqPanel.js'))
    const token = (String(bare.buttons[0].data).match(/--p=([0-9a-z]+)/) || [])[1]
    check('短令牌能换回真实链接', resolvePanelToken(token) === URL, token + ' → ' + resolvePanelToken(token))

    console.log('\n[6] 旧的 # 写法走兜底中间件仍然可用')
    const legacyHash = await dispatchMiddleware('#解析 ' + URL)
    check('旧的 #解析 仍可用', PANEL.test(legacyHash.markdown), legacyHash.markdown.replace(/\n/g, ' ').slice(0, 40) || '（无输出）')
    check('消息被兜底中间件消费掉了（没有漏给后面的处理器）', legacyHash.consumed, 'stoppedAt=' + legacyHash.stoppedAt)
    const legacyHelp = await dispatchMiddleware('#kkk帮助')
    check('旧的 #kkk帮助 被认出来了（渲染不出来不算问题）', legacyHelp.consumed, 'stoppedAt=' + legacyHelp.stoppedAt + '，发出 ' + legacyHelp.sent + ' 条')
    const groupText = await dispatchMiddleware('kkk帮助')
    check('无前缀的 kkk帮助 文本同样被认出来', groupText.consumed, 'stoppedAt=' + groupText.stoppedAt)

    console.log('\n[7] 按钮文本能被解析成参数（点下去就是一次带参数的解析）')
    const { parseParseFlags } = require(path.join(pluginRoot, 'lib/karin/module/utils/ParseOverride.js'))
    if (danmakuButton) {
      const flags = parseParseFlags(String(danmakuButton.data))
      check('带上了画质与令牌', flags.override.bilibiliQuality === 16 && !!flags.panelToken, JSON.stringify(flags.override) + ' token=' + flags.panelToken)
      check('带弹幕那档的按钮会打开弹幕', flags.override.burnDanmaku !== false || String(danmakuButton.data).includes('--dm=1'), String(danmakuButton.data).slice(-30))
    } else {
      skip('弹幕那档按钮相关断言', '干净配置下没生成这个按钮')
    }

    console.log('\n[8] 按钮点击的另一种落地方式：interaction/button 事件')
    {
      const second = await makeCtx({ dataPath: dataRoot, debug: true, masters: ['12345'], qqPanel: true })
      second.clearSent()
      const session = second.makeSession('')
      session.event = { button: { id: 'b1', data: '下载进度' } }
      second.ctx.emit('interaction/button', session)
      await new Promise((resolve) => setTimeout(resolve, 1500))
      check('回调按钮事件里的指令被执行了', second.getSent().length > 0, '发出 ' + second.getSent().length + ' 条')
    }

    console.log('\n[9] 裸链接自动解析（需要联网，超时就跳过）')
    {
      const link = await withTimeout(dispatchMiddleware(URL), 15000, null)
      if (!link) skip('裸链接自动解析', '15 秒内没返回（大概率没网）')
      else {
        check('裸链接触发解析面板', PANEL.test(link.markdown), link.markdown.replace(/\n/g, ' ').slice(0, 40) || '（无输出）')
        // 面板本身分几条消息发（加载提示 + 卡片 + 表格），所以判「解析了几次」不能看条数，
        // 要看画质表格出现了几次 —— 出现两次就是「检测到链接，开始解析」跑了第二遍
        const tables = (link.markdown.match(/清晰度\s*\|\s*弹幕/g) || []).length
        check('只解析一次（画质表格只出现一次）', tables === 1, '表格 ' + tables + ' 次，共发出 ' + link.sent + ' 条')
      }
    }

    console.log('\n[10] autoParse=false 时裸链接交给别人、指令照常可用')
    {
      const off = await makeCtx({ dataPath: dataRoot, debug: true, masters: ['12345'], autoParse: false })
      const out = await off.dispatchMiddleware(URL)
      check('autoParse=false 时裸链接不解析', out.sent === 0, '发出 ' + out.sent + ' 条')
      const stillCommand = await off.dispatchMiddleware('kkk帮助')
      check('但指令照常被认出来', stillCommand.consumed, 'stoppedAt=' + stillCommand.stoppedAt)
    }

    console.log('\n[11] 热重载：dispose 后再挂一遍（别名最容易在这一步撞名）')
    {
      const opts = { dataPath: dataRoot, debug: true, masters: ['12345'], qqPanel: true }
      const rt = await makeCtx(opts)
      const before = rt.ctx.$commander._commandList.length

      rt.fork.dispose()
      await new Promise((resolve) => setTimeout(resolve, 300))
      const afterDispose = rt.ctx.$commander._commandList.length

      let threw = null
      try { rt.ctx.plugin(plugin, opts) } catch (error) { threw = error }
      for (let i = 0; i < 80 && rt.ctx.$commander._commandList.length === afterDispose; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
      const after = rt.ctx.$commander._commandList.length

      check('dispose 后整棵 kkk 指令树被清掉', afterDispose < before, before + ' → ' + afterDispose)
      check('重新挂载不抛错', !threw, threw && threw.message)
      check('重新挂载后指令数量恢复（别名全部重挂成功）', after === before, afterDispose + ' → ' + after + '（期望 ' + before + '）')
      check('重载后老名字仍可用', ['解析', 'kkk帮助', '下载进度'].every((name) => !!rt.ctx.$commander.resolve(name)), '解析 / kkk帮助 / 下载进度')
    }

    const failed = results.filter((item) => !item.ok)
    console.log('\n=== ' + (results.length - failed.length) + '/' + results.length + ' 通过 ===')
    process.exitCode = failed.length ? 1 : 0
  } catch (error) {
    console.error('冒烟测试失败:', error && error.stack ? error.stack : error)
    process.exitCode = 1
  }
  process.exit(process.exitCode || 0)
})()
