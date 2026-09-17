/**
 * 冒烟测试：指令注册与分发（去掉 # 前缀，注册成真正的 Koishi 指令）。
 *
 * 覆盖：
 *   1. 33 个 karin 命令注册成了 Koishi 指令（在 \$commander 的指令表里、带说明和选项）；
 *   2. 指令的 action 走通：裸写 \`解析 <链接>\` 与带前缀 \`/解析 <链接>\` 都能触发解析面板；
 *   3. 旧的 \`#解析 <链接>\` 仍可用（兜底中间件）；
 *   4. 消息里的链接自动解析（链接识别那条路）依旧工作，且遇到指令消息要让路；
 *   5. 面板按钮发出去的就是「不带 # 的指令」，并随平台切换 解析 / 弹幕解析；
 *   6. autoParse=false 时裸链接不再解析。
 *
 * 用法：node scripts/smoke-koishi-commands.cjs
 * 说明：测试用 QQ 平台（platform=qqguild），解析会先出「交互面板」，
 *       既验证了指令链路，又不会真的去下载视频。
 */
const fs = require('node:fs')
const path = require('node:path')
const { Context } = require('koishi')

const pluginRoot = path.resolve(__dirname, '..')
const dataRoot = path.resolve(pluginRoot, 'data-smoke-kcmd')
fs.mkdirSync(path.join(dataRoot, 'koishi-plugin-kkk', 'config'), { recursive: true })
const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'config/default_config/config.json'), 'utf8'))
config.app.parseTip = false
fs.writeFileSync(path.join(dataRoot, 'koishi-plugin-kkk', 'config', 'config.json'), JSON.stringify(config, null, 2))

const plugin = require(path.join(pluginRoot, 'lib/index.js'))
const ctx = new Context()
let sent = []
const fakeBot = {
  selfId: '10000', platform: 'qqguild', status: 1, user: { id: '10000', name: 's' }, ctx,
  sendMessage: async (ch, c) => { sent.push(c); return ['m'] },
  getGuild: async () => ({ name: 'g' }), getFriendList: async () => []
}
Object.defineProperty(ctx, 'bots', { get: () => [fakeBot] })

// 抓住所有中间件（含 Koishi 指令分发自己的那条），手动串成链
const middlewares = []
const original = ctx.middleware.bind(ctx)
ctx.middleware = (fn, ...rest) => { middlewares.push(fn); return original(fn, ...rest) }

ctx.plugin(plugin, { dataPath: dataRoot, debug: true, masters: ['12345'], qqPanel: true })

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  —— ' + detail : ''))
}

const URL = 'https://www.bilibili.com/video/BV1xx411c7mD'

const makeSession = (content) => ({
  content, selfId: '10000', userId: '12345', guildId: '456', channelId: '456', messageId: 'm1',
  bot: fakeBot, author: { nick: 's' }, username: 's', event: {}, user: { id: '12345' },
  send: async (c) => { sent.push(c); return ['m2'] }
})

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
  return { sent: sent.length, markdown, buttons }
}

/** 走中间件链（验证「链接自动解析」和旧的 # 写法） */
const dispatchMiddleware = async (content) => {
  sent = []
  const session = makeSession(content)
  let index = 0
  const run = async () => {
    while (index < middlewares.length) {
      const middleware = middlewares[index++]
      let continued = false
      await middleware(session, () => { continued = true; return run() })
      if (!continued) return
    }
  }
  await run()
  return readSent()
}

/** 走 Koishi 指令的 action（就是指令匹配成功后 Koishi 会调用的那个函数） */
const runCommand = async (name, content) => {
  const command = ctx.$commander._commandList.find((item) => item.name === name)
  if (!command) throw new Error('没有注册指令: ' + name)
  sent = []
  const session = makeSession(content)
  await command._actions[command._actions.length - 1]({ session, options: {}, args: [] })
  return readSent()
}

setTimeout(async () => {
  try {
    console.log('\n[1] 注册成真正的 Koishi 指令')
    const list = ctx.$commander._commandList
    const names = list.map((item) => item.name)
    const i18n = ctx.i18n._data[''] || {}
    const desc = (name) => i18n['commands.' + name + '.description'] || ''
    check('指令表里有 解析 / 弹幕解析 / kkk帮助', ['解析', '弹幕解析', 'kkk帮助'].every((name) => names.includes(name)), '共 ' + names.length + ' 个')
    check('指令不再是 # 开头', names.every((name) => !name.startsWith('#')))
    check('指令带说明（控制台可见）', desc('解析').length > 0 && desc('弹幕解析').length > 0, '解析: ' + desc('解析') + ' / 弹幕解析: ' + desc('弹幕解析'))
    check('权限类指令也在表里', names.includes('b站登录') && names.includes('设置抖音推送'), names.filter((name) => /登录|推送/.test(name)).length + ' 个')
    const parseCmd = list.find((item) => item.name === '解析')
    check('解析 指令声明了面板用到的选项', ['qn', 'q', 'dm', 'panel'].every((key) => key in (parseCmd._options || {})), Object.keys(parseCmd._options || {}).join(','))

    console.log('\n[2] 指令 action 走通（裸写与带前缀）')
    const bare = await runCommand('解析', '解析 ' + URL)
    check('「解析 <链接>」触发解析面板', /解析设置/.test(bare.markdown), bare.markdown.split('\n')[0] || '（无输出）')
    const slash = await runCommand('解析', '/解析 ' + URL)
    check('「/解析 <链接>」同样触发', /解析设置/.test(slash.markdown))

    console.log('\n[3] 面板按钮发的是不带 # 的指令')
    console.log('     按钮：' + bare.buttons.map((button) => '[' + button.label + ']').join(' '))
    check('按钮里没有 # 前缀', bare.buttons.length > 0 && bare.buttons.every((button) => !String(button.data).startsWith('#')), bare.buttons[0] && bare.buttons[0].data)
    check('按钮文本是 解析/弹幕解析 指令预览', bare.buttons.every((button) => /^(解析|弹幕解析) /.test(String(button.data))), bare.buttons.map((button) => button.data).slice(0, 2).join(' | '))
    check('按钮里不带链接（只放短令牌）', bare.buttons.every((button) => !/https?:\/\//.test(String(button.data))), bare.buttons.map((button) => button.data).join(' | '))
    check('按钮长度可控（≤ 40 字符）', bare.buttons.every((button) => String(button.data).length <= 40), '最长 ' + Math.max(...bare.buttons.map((button) => String(button.data).length)) + ' 字符')
    const danmakuButton = bare.buttons.find((button) => String(button.data).startsWith('弹幕解析 '))
    check('存在「弹幕解析」按钮', !!danmakuButton, danmakuButton && danmakuButton.data)
    check('没有任何按钮带 --panel（点了不会再弹面板）', bare.buttons.every((button) => !String(button.data).includes('--panel')), bare.buttons.map((button) => button.data).join(' | '))
    const { resolvePanelToken } = require(path.join(pluginRoot, 'lib/karin/module/utils/QqPanel.js'))
    const token = (String(bare.buttons[0].data).match(/--p=([0-9a-z]+)/) || [])[1]
    check('短令牌能换回真实链接', resolvePanelToken(token) === URL, token + ' → ' + resolvePanelToken(token))

    console.log('\n[4] 旧的 # 写法与链接自动解析仍然可用')
    const legacy = await dispatchMiddleware('#解析 ' + URL)
    check('旧的 #解析 仍可用（兜底中间件）', /解析设置/.test(legacy.markdown))
    const link = await dispatchMiddleware(URL)
    check('裸链接触发解析面板', /解析设置/.test(link.markdown))
    check('只发一条（没有重复解析）', link.sent === 1, '共 ' + link.sent + ' 条')

    console.log('\n[5] 按钮文本能被解析成参数（点下去就是一次带参数的解析）')
    const { parseParseFlags } = require(path.join(pluginRoot, 'lib/karin/module/utils/ParseOverride.js'))
    if (danmakuButton) {
      const flags = parseParseFlags(String(danmakuButton.data))
      check('带上了画质与令牌', flags.override.bilibiliQuality === 16 && !!flags.panelToken, JSON.stringify(flags.override) + ' token=' + flags.panelToken)
      check('指令名决定要不要弹幕（不再用 --dm=1）', String(danmakuButton.data).startsWith('弹幕解析 ') && flags.override.burnDanmaku === undefined)
    }

    console.log('\n[6] 按钮点击的另一种落地方式：interaction/button 事件')
    {
      sent = []
      const interactionSession = {
        content: '', selfId: '10000', userId: '12345', guildId: '456', channelId: '456', messageId: 'm1',
        bot: fakeBot, author: { nick: 's' }, username: 's', user: { id: '12345' },
        event: { button: { id: 'b1', data: 'kkk版本' } },
        send: async (c) => { sent.push(c); return ['m3'] }
      }
      ctx.emit('interaction/button', interactionSession)
      await new Promise((resolve) => setTimeout(resolve, 1500))
      check('回调按钮事件里的指令被执行了', sent.length > 0, '发出 ' + sent.length + ' 条')
    }

    console.log('\n[7] 其它指令也走通了同一条 action 包装')
    const version = await runCommand('kkk版本', 'kkk版本')
    check('「kkk版本」有回复', version.sent > 0, '发出 ' + version.sent + ' 条')
    const help = await runCommand('kkk帮助', 'kkk帮助')
    check('「kkk帮助」有回复', help.sent > 0, '发出 ' + help.sent + ' 条')

    console.log('\n[8] Koishi 没认领时，文本兜底也能跑（宿主 prefix 没配空串的情况）')
    // 假会话没有 argv（等于 Koishi 没把这条当指令），此时必须靠插件自己的文本兜底
    const fallback = await dispatchMiddleware('kkk版本')
    check('无前缀指令文本仍能被执行', fallback.sent > 0, '发出 ' + fallback.sent + ' 条')
    const legacyLink = await dispatchMiddleware(URL)
    check('裸链接走链接识别那条路（照常出面板）', /解析设置/.test(legacyLink.markdown))

    console.log('\n[9] autoParse=false 时裸链接不再解析')
    const ctx2 = new Context()
    const middlewares2 = []
    const original2 = ctx2.middleware.bind(ctx2)
    ctx2.middleware = (fn, ...rest) => { middlewares2.push(fn); return original2(fn, ...rest) }
    ctx2.plugin(plugin, { dataPath: dataRoot, debug: true, masters: ['12345'], autoParse: false })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    let sent2 = []
    const session2 = {
      content: URL, selfId: '10000', userId: '12345', guildId: '456', channelId: '456', messageId: 'm1',
      bot: { ...fakeBot, sendMessage: async (ch, c) => { sent2.push(c); return ['m'] } },
      author: { nick: 's' }, username: 's', event: {}, user: { id: '12345' },
      send: async (c) => { sent2.push(c); return ['m2'] }
    }
    let index = 0
    const run = async () => {
      while (index < middlewares2.length) {
        const middleware = middlewares2[index++]
        let continued = false
        await middleware(session2, () => { continued = true; return run() })
        if (!continued) return
      }
    }
    await run()
    check('autoParse=false 时裸链接不解析', sent2.length === 0, '发出 ' + sent2.length + ' 条')

    const failed = results.filter((item) => !item.ok)
    console.log('\n=== ' + (results.length - failed.length) + '/' + results.length + ' 通过 ===')
    process.exitCode = failed.length ? 1 : 0
  } catch (error) {
    console.error('冒烟测试失败:', error && error.stack ? error.stack : error)
    process.exitCode = 1
  }
  process.exit(process.exitCode || 0)
}, 5000)
