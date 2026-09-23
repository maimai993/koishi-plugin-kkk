/**
 * 冒烟测试：QQ 平台的解析交互面板（Markdown + 原生按钮）。
 *
 * 覆盖：
 *   1. QQ 平台发链接 → 只回面板（不回解析结果，也不会真的去下载视频）；
 *   2. 面板里的画质按钮遵守体积上限（默认 200MB），超限档位不生成按钮；
 *   3. 「视频＋弹幕」按钮 = 带 --panel=1 的同一条命令，点了重新渲染面板并高亮；
 *   4. 参数覆盖真的生效：runWithParseOverride 里 Config.bilibili.videoQuality 变成按钮选的档位；
 *   5. 抖音走的是同一套面板逻辑（用固定数据验证：4K 300MB 那一档必须被隐藏）；
 *   6. 非 QQ 平台 / 关掉面板开关 → 行为不变。
 *
 * 用法：node scripts/smoke-qqpanel.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { Context } = require('koishi')

const pluginRoot = path.resolve(__dirname, '..')
const dataRoot = path.resolve(pluginRoot, 'data-smoke')
const target = 'https://www.bilibili.com/video/BV1xx411c7mD'

/* ------------------------------------------------------------------ *
 * 抖音侧固定数据（没有 Cookie 时抖音接口必被风控，这里只验证展示与选档逻辑）
 * ------------------------------------------------------------------ */
/** 依赖可能在本包 node_modules，也可能被提升到宿主 node_modules，两处都试 */
const resolveDep = (name) => {
  try {
    return require(path.join(pluginRoot, 'node_modules', name))
  } catch {
    return require(name)
  }
}
const axios = resolveDep('axios')
const realAxiosGet = axios.get
const LONG_URL = 'https://www.douyin.com/video/7123456789012345678'
axios.get = async (url, options) => {
  if (typeof url === 'string' && url.includes('douyin')) return { request: { res: { responseUrl: LONG_URL } }, data: '' }
  return realAxiosGet(url, options)
}

const makeBitRate = (definition, sizeMB) => ({
  gear_name: definition,
  quality_type: 28,
  bit_rate: 1000000,
  FPS: 30,
  format: 'mp4',
  video_extra: JSON.stringify({ definition }),
  play_addr: { uri: 'v', url_list: ['https://www.w3schools.com/html/mov_bbb.mp4'], data_size: Math.round(sizeMB * 1024 * 1024) }
})
const douyinDetail = {
  aweme_id: '7123456789012345678',
  aweme_type: 0,
  is_slides: false,
  desc: '【面板验证】抖音视频解析测试',
  preview_title: '【面板验证】抖音视频解析测试',
  create_time: Math.floor(Date.now() / 1000) - 3600,
  share_url: LONG_URL,
  author: { uid: '1', sec_uid: 'SEC', nickname: '测试作者', avatar_thumb: { url_list: ['https://www.w3schools.com/html/pic_trulli.jpg'] } },
  statistics: { digg_count: 1, comment_count: 1, share_count: 1, collect_count: 1, play_count: 1 },
  images: null,
  music: null,
  video: {
    play_addr: { uri: 'v', url_list: ['https://www.w3schools.com/html/mov_bbb.mp4'], data_size: 20971520 },
    cover: { url_list: ['https://www.w3schools.com/html/pic_trulli.jpg'] },
    origin_cover: { url_list: ['https://www.w3schools.com/html/pic_trulli.jpg'] },
    duration: 15000,
    // 4K 那档 300MB，超过 QQ 的 200MB 硬限制，必须被面板隐藏
    bit_rate: [makeBitRate('4k', 300), makeBitRate('1080p', 80), makeBitRate('720p', 20), makeBitRate('540p', 8)]
  }
}

const amagi = require('@ikenxuan/amagi')
const realFactory = amagi.default
amagi.default = function (options) {
  const client = realFactory(options)
  client.douyin.fetcher.parseWork = async () => ({ success: true, code: 200, message: 'OK', data: { aweme_detail: douyinDetail } })
  // 弹幕列表给空：这一节只验证「--dm=1 有没有被识别成烧录请求」，不想真去拉抖音接口、也不想真烧
  client.douyin.fetcher.fetchDanmakuList = async () => ({ success: true, code: 200, message: 'OK', data: { danmaku_list: [] } })
  // 评论 / 表情 / 用户资料也固定住：否则没 Cookie 的接口会先抛错，流程根本走不到「发送视频」那一步
  client.douyin.fetcher.fetchWorkComments = async () => ({ success: true, code: 200, message: 'OK', data: { comments: [], cursor: 0, has_more: 0, total: 0 } })
  client.douyin.fetcher.fetchEmojiList = async () => ({ success: true, code: 200, message: 'OK', data: { emoji_list: [] } })
  client.douyin.fetcher.fetchUserProfile = async () => ({ success: true, code: 200, message: 'OK', data: { user: { uid: '1', sec_uid: 'SEC', nickname: '测试作者', avatar_thumb: { url_list: ['https://www.w3schools.com/html/pic_trulli.jpg'] }, follower_count: 1 } } })
  return client
}

const plugin = require(path.join(pluginRoot, 'lib/index.js'))
const ctx = new Context()
// parseDedupe: false —— 这个冒烟测试会拿同一条链接反复跑不同配置，去重会把后半段全部挡掉（不是被测逻辑出问题）
ctx.plugin(plugin, { dataPath: dataRoot, debug: true, qqPanel: true, qqFileLimitMB: 200, parseDedupe: false })

/* ------------------------------------------------------------------ *
 * 断言工具
 * ------------------------------------------------------------------ */
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  —— ' + detail : ''))
}

/**
 * 直接跑某个已注册命令（不经过中间件，避免无关命令干扰）
 * @param hooks.sendHook 发送前调一次；抛错就等价于「适配器拒收这条消息」
 */
const runCommand = async (namePart, content, platform = 'qqguild', hooks = {}) => {
  const { commandQueue } = require(path.join(pluginRoot, 'lib/compat/runtime.js'))
  const { Message } = require(path.join(pluginRoot, 'lib/compat/node-karin.js'))
  const reg = commandQueue.find((item) => String(item.options?.name ?? '').includes(namePart))
  if (!reg) throw new Error('没有注册命令: ' + namePart)

  const sent = []
  const beforeSend = (payload) => { if (hooks.sendHook) hooks.sendHook(payload) }
  const bot = {
    selfId: '10000', platform, status: 1, user: { id: '10000', name: 'smoke' }, ctx,
    sendMessage: async (channel, payload) => { beforeSend(payload); sent.push(payload); return ['msg-1'] },
    getGuild: async () => ({ name: 'smoke-guild' })
  }
  const session = {
    content, selfId: '10000', userId: '12345', guildId: '456', channelId: '456',
    messageId: 'm1', bot, author: { nick: 'smoke' }, username: 'smoke', event: {},
    send: async (payload) => { beforeSend(payload); sent.push(payload); return ['msg-2'] }
  }
  await reg.handler(Message.fromSession(session), () => Symbol('next'))
  return sent
}

/** 把发出的元素压成 markdown 文本 + 按钮清单 */
const readPanel = (sent) => {
  const flat = []
  for (const item of sent) for (const el of (Array.isArray(item) ? item : [item])) flat.push(el)
  const markdown = flat.filter((el) => el && el.type === 'markdown')
    .map((el) => (el.children || []).map((child) => child.attrs && child.attrs.content).join('')).join('\n')
  // 按钮现在是 markdown 内联的 <qqbot-cmd-input text="…" show="…" />（群聊唯一可用的指令标签）
  const buttons = []
  const pattern = /<qqbot-cmd-input\s+text="([^"]*)"\s+show="([^"]*)"\s+reference="[^"]*"\s*\/>/g
  let matched
  while ((matched = pattern.exec(markdown)) !== null) {
    buttons.push({ data: decodeURIComponent(matched[1]), label: decodeURIComponent(matched[2]) })
  }
  return { flat, markdown, buttons }
}

setTimeout(async () => {
  try {
    const { getRuntime } = require(path.join(pluginRoot, 'lib/compat/runtime.js'))

    /**
     * 本文件测的是**原来的 ffmpeg 烧录链路**（面板列头、`--dm=1` 的判定、降级提示）。
     *
     * 通用里的「在线播放器」现在**默认开启**，开着时 `--dm=1` 会走在线播放（不烧录、
     * 也不发视频文件），本文件里那些关于烧录的断言就不成立了。
     * 所以这里显式关掉播放器，让本文件的行为和加这个功能之前完全一致；
     * 播放器模式本身（默认开启、列头写「弹幕」）由 scripts/smoke-player.cjs 覆盖。
     */
    getRuntime().config.playerEnabled = false
    /**
     * 「在线看」按钮那个开关（playerWatchButton，默认开）也要关掉：
     * 它开着时面板会多一列「在线看」（即使上面的弹幕重定向关着），本文件断言的是最朴素的
     * 「清晰度 | 大小 / 烧录弹幕」布局。在线看列本身由 scripts/smoke-player.cjs 覆盖。
     */
    getRuntime().config.playerWatchButton = false

    console.log('\n[1] QQ 平台发 B站链接 → 只回面板（不解析、不下载）')
    const sent = await runCommand('B站', target)
    const panel = readPanel(sent)
    // 面板是「先发一条加载中…，拿到数据后原地替换」——所以发出 2 条属于预期
    check('发出了面板（加载提示 + 替换后的面板）', sent.length >= 1 && /\| 清晰度 \| 大小 \|/.test(panel.markdown),
      '共 ' + sent.length + ' 条 / 表头 ' + (panel.markdown.split('\n').find((l) => l.startsWith('| 清晰度')) || '（无）'))
    check('用的是 markdown 指令标签 <qqbot-cmd-input>', panel.buttons.length > 0, panel.buttons.length + ' 个按钮')
    check('不再发原生 keyboard 按钮', !panel.flat.some((el) => el && el.type === 'button-group'))
    check('按钮文字是画质（不是整条指令）', panel.buttons.every((b) => b.label && !b.label.startsWith('#') && !/https?:/.test(b.label)), panel.buttons.map((b) => b.label).join(' / '))
    // 按钮里带的是**规范链接**（不超过 120 字符，见 QqPanel 的 urlPart 说明）或短令牌，
    // 不是用户发的那种带一堆参数的长分享链接 —— 短链接放进按钮是为了宿主重启后仍能解析
    check('按钮里不带超长原始链接', panel.buttons.every((b) => String(b.data).length < 200),
      '最长 ' + Math.max(...panel.buttons.map((b) => String(b.data).length)))
    console.log('  —— markdown ——\n' + panel.markdown.split('\n').map((l) => '     ' + l).join('\n'))
    console.log('  —— 按钮 ——')
    for (const b of panel.buttons) console.log('     [' + b.label + '] → ' + b.data)

    console.log('\n[2] 体积上限：上限压到 1MB 时只保留最小的一档')
    const runtime = getRuntime()
    const originalLimit = runtime.config.qqFileLimitMB
    runtime.config.qqFileLimitMB = 1
    const tiny = readPanel(await runCommand('B站', target))
    runtime.config.qqFileLimitMB = originalLimit
    const qualityButtons = tiny.buttons.filter((b) => /M/.test(b.label))
    const distinct = [...new Set(qualityButtons.map((b) => b.label))]
    check('最多保留 1 档画质（两行各一个按钮）', distinct.length <= 1, distinct.join(' / ') || '（无）')
    check('markdown 给出「发送可能失败」的提示', /可能失败/.test(tiny.markdown), tiny.markdown.match(/⚠️.*/)?.[0] ?? '（无提示）')
    /**
     * 播放器关掉时**保持老行为**：超限档位仍然不显示（点了也发不出去），也没有「在线看」列。
     * 「在线播放模式下所有档位都要出现 + 在线看按钮」由 scripts/smoke-player.cjs 第 [9d] 节覆盖。
     */
    check('播放器关掉时没有「在线看」列 / 按钮（这一列只跟播放器走）',
      !tiny.buttons.some((b) => String(b.data).includes('--play=1')) &&
      !/在线看/.test(tiny.markdown),
      (tiny.markdown.split('\n').find((l) => l.startsWith('| 清晰度')) || '（没有表格）'))

    console.log('\n[3] 烧录弹幕列：由配置面板决定（默认不显示），通用里的强制开关优先级最高')
    const { isBurnDanmakuSupported, isBurnDanmakuForbidden } = require(path.join(pluginRoot, 'lib/karin/module/utils/DanmakuPolicy.js'))
    const liveRuntime = getRuntime()
    const savedForce = liveRuntime.config.forceNoDanmaku
    const savedPanelDanmaku = liveRuntime.config.qqPanelDanmaku

    liveRuntime.config.forceNoDanmaku = false
    const supportedWhenAllowed = isBurnDanmakuSupported()
    liveRuntime.config.forceNoDanmaku = savedForce
    check('关掉强制开关后判定为可烧录（本机有 ffmpeg）', supportedWhenAllowed === true, 'isBurnDanmakuSupported=' + supportedWhenAllowed)
    check('默认强制不烧录弹幕（通用里的开关默认开）', savedForce !== false && isBurnDanmakuForbidden() === true,
      'forceNoDanmaku=' + savedForce)
    check('默认面板不显示「烧录弹幕」列', savedPanelDanmaku !== true, 'qqPanelDanmaku=' + savedPanelDanmaku)

    const tableOf = (p) => p.markdown.split('\n').find((line) => line.startsWith('| 清晰度'))
    const hasBurnButton = (p) => p.buttons.some((b) => String(b.data).includes('--dm=1'))
    const hasToggleButton = (p) => p.buttons.some((b) => String(b.data).includes('--panel='))

    check('默认两列「清晰度 | 大小」', tableOf(panel) === '| 清晰度 | 大小 |', tableOf(panel))
    check('默认没有烧录弹幕按钮', !hasBurnButton(panel))
    check('面板里没有「是否显示」的开关按钮（由配置决定，不是面板按钮）', !hasToggleButton(panel),
      panel.buttons.map((b) => b.data).join(' | '))

    // 两个开关都满足才显示：通用里的「强制不烧录弹幕」关掉 + QQ 适配器里打开面板弹幕列
    liveRuntime.config.forceNoDanmaku = false
    liveRuntime.config.qqPanelDanmaku = true
    // 链接形式必须是普通 markdown：mqqapi:// 会被适配器/QQ 直接拒收（见第 [8] 节）
    check('面板下方带「打开原站」链接（默认开）', /\[打开原站\]\(https:\/\//.test(panel.markdown),
      (panel.markdown.split('\n').find((l) => l.includes('打开原站')) || '（没有链接行）').slice(0, 120))
    liveRuntime.config.qqPanelSourceLink = false
    const noLink = readPanel(await runCommand('B站', target))
    liveRuntime.config.qqPanelSourceLink = true
    check('关掉开关后不再出现「打开原站」', !/打开原站/.test(noLink.markdown))

    const onPanel = readPanel(await runCommand('B站', target))
    liveRuntime.config.qqPanelDanmaku = savedPanelDanmaku
    liveRuntime.config.forceNoDanmaku = savedForce
    check('两个开关都打开后是三列「清晰度 | 烧录弹幕 | 大小」', tableOf(onPanel) === '| 清晰度 | 烧录弹幕 | 大小 |', tableOf(onPanel))
    const burnButtons = onPanel.buttons.filter((b) => String(b.data).includes('--dm=1'))
    check('每档画质都有「烧录弹幕」按钮', burnButtons.length > 0 && burnButtons.every((b) => b.label === '烧录弹幕'),
      burnButtons.map((b) => b.data).join(' | '))
    check('烧录按钮带着画质参数', burnButtons.every((b) => /--qn=\d+/.test(String(b.data))), burnButtons[0] && burnButtons[0].data)

    liveRuntime.config.qqPanelDanmaku = true
    liveRuntime.config.forceNoDanmaku = true
    const forcedPanel = readPanel(await runCommand('B站', target))
    liveRuntime.config.qqPanelDanmaku = savedPanelDanmaku
    liveRuntime.config.forceNoDanmaku = savedForce
    check('强制不烧录时，即使配置打开也只有两列', tableOf(forcedPanel) === '| 清晰度 | 大小 |', tableOf(forcedPanel))
    check('强制不烧录时没有任何烧录按钮', !hasBurnButton(forcedPanel))

    console.log('\n[4] 参数覆盖：按钮选的画质要真的作用到解析链路')
    const { runWithParseOverride } = require(path.join(pluginRoot, 'lib/karin/module/utils/ParseOverride.js'))
    const { Config } = require(path.join(pluginRoot, 'lib/karin/module/utils/Config.js'))
    const configured = Config.bilibili.videoQuality
    let inside = null
    await runWithParseOverride({ bilibiliQuality: 116 }, async () => { inside = Config.bilibili.videoQuality })
    check('作用域内取到覆盖值 116', inside === 116, 'inside=' + inside + ' / 配置=' + configured)
    check('作用域外仍是配置值', Config.bilibili.videoQuality === configured, 'now=' + Config.bilibili.videoQuality)
    let douyinInside = null
    await runWithParseOverride({ douyinQuality: '720p' }, async () => { douyinInside = Config.douyin.videoQuality })
    check('抖音画质同样可覆盖', douyinInside === '720p', 'inside=' + douyinInside)

    console.log('\n[5] 抖音：同一套面板 + 200MB 硬限制过滤（固定数据）')
    const dySent = await runCommand('抖音', 'https://v.douyin.com/iFakeTest/')
    const dy = readPanel(dySent)
    check('发出了面板（加载提示 + 替换后的面板）', dySent.length >= 1 && /\| 清晰度 \| 大小 \|/.test(dy.markdown),
      '共 ' + dySent.length + ' 条 / 表头 ' + (dy.markdown.split('\n').find((l) => l.startsWith('| 清晰度')) || '（无）'))
    const dyQuality = dy.buttons.filter((b) => /^(4K|1080P|720P|540P|480P)$/.test(b.label))
    console.log('     画质按钮：' + dyQuality.map((b) => b.label).join(' / '))
    check('300MB 的 4K 档被隐藏', !dyQuality.some((b) => b.label.includes('4K')), dyQuality.map((b) => b.label).join(' / '))
    check('80MB 的 1080P 档保留', dyQuality.some((b) => b.label.includes('1080P')), dyQuality.map((b) => b.label).join(' / '))
    check('画质参数用抖音的 --q=', dyQuality.some((b) => String(b.data).includes('--q=1080p')), dyQuality[0] && dyQuality[0].data)

    console.log('\n[6] 烧录请求的优先级：强制不烧录 > ffmpeg > 用户请求')
    {
      const runWithCapture = async (command) => {
        const logs = []
        const originalLog = console.log
        console.log = (...args) => { logs.push(args.map((item) => String(item)).join(' ')) }
        let sent = []
        try {
          sent = await runCommand('抖音', command)
        } catch (error) {
          logs.push('ERR ' + (error && error.message))
        }
        console.log = originalLog
        return { logs: logs.join('\n'), sent }
      }

      // 1) 默认状态：通用里「强制不烧录弹幕」是开的 → 带了 --dm=1 也不烧，并回一句说明
      const forced = await runWithCapture('https://v.douyin.com/iFakeTest/ --dm=1')
      check('强制不烧录时 --dm=1 不生效', /forceBurnDanmaku=false/.test(forced.logs),
        (forced.logs.match(/\[抖音\] 跳过烧录[^\n]*/) || ['（没有跳过烧录日志）'])[0].slice(0, 160))
      check('强制不烧录时会说明一句', JSON.stringify(forced.sent).includes('已关闭弹幕烧录'),
        (JSON.stringify(forced.sent).match(/已关闭弹幕烧录[^"]*/) || ['（没有说明）'])[0].slice(0, 120))

      // 2) 关掉强制开关后 → 这次才真的请求烧录
      liveRuntime.config.forceNoDanmaku = false
      const allowed = await runWithCapture('https://v.douyin.com/iFakeTest/ --dm=1')
      liveRuntime.config.forceNoDanmaku = savedForce
      check('关掉强制开关后 --dm=1 生效', /forceBurnDanmaku=true/.test(allowed.logs),
        (allowed.logs.match(/\[抖音\] 跳过烧录[^\n]*/) || ['（没有跳过烧录日志）'])[0].slice(0, 160))
      check('没有出现「未接入 ffmpeg」的降级提示', !/未接入 ffmpeg/.test(allowed.logs))
    }

    console.log('\n[7] 非 QQ 平台 / 关掉开关 → 不发面板')
    const { sendQqParsePanel } = require(path.join(pluginRoot, 'lib/karin/module/utils/QqPanel.js'))
    const { Message } = require(path.join(pluginRoot, 'lib/compat/node-karin.js'))
    const makeMessage = (platform) => Message.fromSession({
      content: target, selfId: '10000', userId: '1', guildId: '456', channelId: '456', messageId: 'm',
      bot: { selfId: '10000', platform, status: 1, ctx, sendMessage: async () => ['x'] },
      author: { nick: 's' }, username: 's', event: {}, send: async () => ['y']
    })
    const onebot = await sendQqParsePanel(makeMessage('onebot'), { platform: 'bilibili', url: target, id: 'BV1xx411c7mD' })
    check('onebot 平台不发面板', onebot === false)
    runtime.config.qqPanel = false
    const disabled = await sendQqParsePanel(makeMessage('qqguild'), { platform: 'bilibili', url: target, id: 'BV1xx411c7mD' })
    runtime.config.qqPanel = true
    check('qqPanel=false 时不发面板', disabled === false)

    console.log('\n[8] 「打开原站」链接：必须是能发出去的普通 markdown 链接 + 发送兜底')
    /**
     * 线上事故：链接原来写的是 `mqqapi://forward/url?...`，QQ 官方接口直接拒收
     * （40034028 请求参数不允许包含url mqqapi://forward/url），**整条面板**都发不出去。
     */
    check('面板 markdown 不含 mqqapi:// 链接', !/mqqapi/i.test(panel.markdown),
      (panel.markdown.match(/mqqapi[^\s)]*/) || ['（没有）'])[0])
    check('「打开原站」是普通 markdown 链接', /\[打开原站\]\(https:\/\/www\.bilibili\.com\/video\/BV1xx411c7mD\)/.test(panel.markdown),
      (panel.markdown.split('\n').find((line) => line.includes('打开原站')) || '（没有链接行）').slice(0, 80))

    // 模拟适配器「带链接就拒收」：应当自动摘掉链接行重发，面板照常出来
    const linkAttempts = []
    const resilient = readPanel(await runCommand('B站', target, 'qqguild', {
      sendHook: (payload) => {
        const text = JSON.stringify(payload)
        if (text.includes('打开原站')) {
          linkAttempts.push(text.slice(0, 40))
          throw new Error('QQ 消息发送失败 [40034028] 请求参数不允许包含url')
        }
      }
    }))
    check('带链接的那次被拒收（模拟生效）', linkAttempts.length >= 1, '拒收 ' + linkAttempts.length + ' 次')
    check('去掉链接后整条面板仍然发出去了',
      /\| 清晰度 \| 大小 \|/.test(resilient.markdown) && resilient.buttons.length > 0,
      '表头 ' + (resilient.markdown.split('\n').find((line) => line.startsWith('| 清晰度')) || '（无）'))
    check('重发的内容里没有链接行', !/打开原站/.test(resilient.markdown))
    check('重发的面板仍然带画质按钮', resilient.buttons.length > 0 &&
      resilient.buttons.every((b) => !b.label.startsWith('#')),
      resilient.buttons.map((b) => b.label).join(' / '))
    console.log('\n[9] 超长图切片（错误卡片那条链路）')
    /**
     * 线上事故：`sliceImageToMarkdown` 里混进了别的函数才有的变量（`e`/`valid`），
     * 一调用就 `ReferenceError: e is not defined` —— 错误卡片永远切不了片，
     * 8.9MB 的长图直接原样发出去。
     */
    // 旧的 sliceImageToMarkdown 早就换成 sliceImageToElements（返回元素数组，平台决定 markdown / 图片段）
    const { sliceImageToElements } = require(path.join(pluginRoot, 'lib/karin/module/utils/ImageSlice.js'))
    // 切片要上传，宿主的 assets 服务这里没有，直接塞一个假的
    ctx.assets = { upload: async (data, name) => ({ url: 'https://example.com/' + name }) }
    const { execFileSync } = require('node:child_process')
    const os = require('node:os')
    const tallJpg = path.join(os.tmpdir(), 'kkk-panel-smoke-tall.jpg')
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=400x5000', '-frames:v', '1', tallJpg])
    const tallDataUri = 'data:image/jpeg;base64,' + fs.readFileSync(tallJpg).toString('base64')
    let sliced = null
    let sliceError = null
    try {
      // 平台传 'qq'：切片只在 QQ 那条链路上生效（其它平台按原图发）
      sliced = await sliceImageToElements(tallDataUri, 'qq')
    } catch (error) {
      sliceError = error
    }
    check('切片函数不抛错（ReferenceError 已修）', !sliceError, sliceError ? String(sliceError.message) : 'ok')
    const slicedText = JSON.stringify(sliced ?? '')
    check('长图被切成多片 markdown', Array.isArray(sliced) && sliced.length >= 1 && (slicedText.match(/!\[#/g) || []).length >= 2,
      JSON.stringify(slicedText.slice(0, 90)))
    let badThrown = null
    let badResult = 'unset'
    try {
      badResult = await sliceImageToElements('data:image/jpeg;base64,AAAA', 'qq')
    } catch (error) {
      badThrown = error
    }
    check('坏输入不抛错（交给调用方按原图发）', !badThrown && (badResult === null || (Array.isArray(badResult) && badResult.length === 0)),
      badThrown ? String(badThrown.message) : String(badResult))
    const handlerSource = fs.readFileSync(path.join(pluginRoot, 'lib/karin/module/utils/ErrorHandler/handler.js'), 'utf-8')
    check('ErrorHandler 里仍有「切片失败按原图发送」的兜底',
      handlerSource.includes('错误卡片切片失败，按原图发送') && /try\s*\{[\s\S]*sliceImageToElements[\s\S]*?catch/.test(handlerSource))

    console.log('\n[10] 「弹幕」与「在线看」按钮的合并规则（用户要求）')
    {
      const cfg = getRuntime().config
      // 场景 1：只开「在线看」按钮（弹幕重定向关着）→ 面板上单独一列「在线看」
      cfg.playerWatchButton = true
      const wp = readPanel(await runCommand('B站', target))
      const wpHead = wp.markdown.split('\n').find((l) => l.startsWith('| 清晰度')) || ''
      check('只开「在线看」按钮时出现「在线看」列', /\| 在线看 \|/.test(wpHead), wpHead)
      check('这一列有可点的「在线看」按钮', wp.buttons.some((b) => b.label === '在线看'),
        wp.buttons.map((b) => b.label).join(' / '))
      // 场景 2：打开「弹幕重定向在线播放器」→ 两个动作等价，合并成一个按钮
      cfg.playerEnabled = true
      const mp = readPanel(await runCommand('B站', target))
      const mpHead = mp.markdown.split('\n').find((l) => l.startsWith('| 清晰度')) || ''
      check('播放器打开后合并成一列「弹幕」', /\| 弹幕 \|/.test(mpHead) && !/在线看/.test(mpHead), mpHead)
      check('合并后不再有单独的「在线看」按钮', !mp.buttons.some((b) => b.label === '在线看'),
        mp.buttons.map((b) => b.label).join(' / '))
      // 表格与后面的说明之间必须空一行，否则 markdown 会把提示吞进表格里（用户实测）
      const allLines = mp.markdown.split('\n')
      const hintAt = allLines.findIndex((l) => /超上限/.test(l) && !l.startsWith('|'))
      check('表格后面的提示与表格之间有空行', hintAt === -1 || allLines[hintAt - 1].trim() === '',
        hintAt === -1 ? '（本次没有提示行）' : '提示行的上一行=' + JSON.stringify(allLines[hintAt - 1]))
      cfg.playerEnabled = false
      cfg.playerWatchButton = false
    }

    const failed = results.filter((item) => !item.ok)
    console.log('\n=== ' + (results.length - failed.length) + '/' + results.length + ' 通过 ===')
    process.exitCode = failed.length ? 1 : 0
  } catch (error) {
    console.error('冒烟测试失败:', error && error.stack ? error.stack : error)
    process.exitCode = 1
  }
  process.exit(process.exitCode || 0)
}, 5000)