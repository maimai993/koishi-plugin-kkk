/**
 * 冒烟测试：QQ「群文件发送阈值」（配置项 qqGroupFileLimitMB）。
 *
 * 背景：这个阈值必须从 Koishi 侧的插件配置读，不能读上游的 Config ——
 * 上游 Config 是个 Proxy，取不到的键会走 getDefOrConfig() 返回 {}，Number({}) === NaN，
 * 阈值判定永远为假（表现就是「在面板里改了没用」）。这个用例把这条链路钉死。
 *
 * 用例（全部离线，不发任何网络请求）：
 *   1. 平台=qq、阈值 30MB、视频 35MB  → 走群文件（bot.uploadFile）
 *   2. 平台=qq、阈值 30MB、视频 10MB  → 走普通视频消息（bot.reply + video 元素）
 *   3. 平台=qq、阈值 0                → 关闭群文件，走普通视频消息
 *   4. 平台=onebot、阈值 30MB、视频 35MB → 非 QQ 不受该阈值影响
 *
 * 用法：node scripts/smoke-groupfile.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { Context } = require('koishi')

const pluginRoot = path.resolve(__dirname, '..')
const dataRoot = path.resolve(pluginRoot, 'data-smoke-groupfile')
const cfgDir = path.join(dataRoot, 'koishi-plugin-kkk', 'config')

const writeConfig = () => {
  const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'config/default_config/config.json'), 'utf8'))
  // 关掉压缩和上游的群文件开关，确保结果只可能来自 QQ 阈值这一条判定
  config.app.compress = false
  config.app.usegroupfile = false
  config.app.groupfilevalue = 100
  config.app.parseTip = false
  config.pushlist = { douyin: [], bilibili: [] }
  fs.mkdirSync(cfgDir, { recursive: true })
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(config, null, 2))
}
writeConfig()

const plugin = require(path.join(pluginRoot, 'lib/index.js'))
const { uploadFile } = require(path.join(pluginRoot, 'lib/karin/module/utils/Base.js'))

const tmpFile = path.join(os.tmpdir(), 'kkk-smoke-groupfile.mp4')
fs.writeFileSync(tmpFile, Buffer.alloc(1024))

let failures = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? ' | ' + extra : ''))
  if (!ok) failures++
}

/** 一次上传调用的结果：走了群文件还是普通视频 */
const runCase = async (ctx, { platform, sizeMB }) => {
  const calls = { uploadFile: 0, reply: [] }
  const koishiBot = {
    platform,
    uploadFile: async () => { calls.uploadFile++; return true },
    recallMsg: async () => true
  }
  const event = {
    selfId: '10000',
    userId: '12345',
    guildId: '456',
    channelId: '456',
    messageId: 'm1',
    // 平台名的真实位置就是 event.bot.bot.platform（见 Base.ts 注释）
    bot: Object.assign(koishiBot, { bot: koishiBot }),
    contact: { peer: 'group:456' },
    reply: async (content) => { calls.reply.push(content); return { messageId: 'tip-1' } }
  }
  const ok = await uploadFile(event, { filepath: tmpFile, totalBytes: sizeMB, originTitle: 'smoke' }, '')
  const repliedVideo = calls.reply.some((c) => {
    const text = JSON.stringify(c)
    return text.includes('"video"') || text.includes('video/mp4')
  })
  return { calls, ok, repliedVideo }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 每个用例起一个干净的 Context：运行时配置在 apply 时绑定，必须重新加载插件才生效 */
const boot = async (config) => {
  const ctx = new Context()
  Object.defineProperty(ctx, 'bots', { get: () => [] })
  ctx.plugin(plugin, Object.assign({ dataPath: dataRoot, debug: true, masters: ['12345'], webui: false, qqPanel: false }, config))
  await sleep(4000)
  return ctx
}

const shutdown = async (ctx) => {
  try {
    if (typeof ctx.stop === 'function') await ctx.stop()
  } catch { /* 关不掉无所谓，反正马上退出 */ }
}

;(async () => {
  try {
    console.log('=== 1) QQ + 阈值 30MB + 视频 35MB ===')
    let ctx = await boot({ qqGroupFileLimitMB: 30 })
    let r = await runCase(ctx, { platform: 'qq', sizeMB: 35.2 })
    check('走群文件（bot.uploadFile）', r.calls.uploadFile === 1 && !r.repliedVideo,
      'uploadFile=' + r.calls.uploadFile + ' 视频元素=' + r.repliedVideo)
    await shutdown(ctx)

    console.log('')
    console.log('=== 2) QQ + 阈值 30MB + 视频 10MB ===')
    ctx = await boot({ qqGroupFileLimitMB: 30 })
    r = await runCase(ctx, { platform: 'qq', sizeMB: 10 })
    check('走普通视频消息', r.calls.uploadFile === 0 && r.repliedVideo,
      'uploadFile=' + r.calls.uploadFile + ' 视频元素=' + r.repliedVideo)
    await shutdown(ctx)

    console.log('')
    console.log('=== 3) QQ + 阈值 0（关闭） + 视频 35MB ===')
    ctx = await boot({ qqGroupFileLimitMB: 0 })
    r = await runCase(ctx, { platform: 'qq', sizeMB: 35.2 })
    check('阈值 0 时不走群文件', r.calls.uploadFile === 0 && r.repliedVideo,
      'uploadFile=' + r.calls.uploadFile + ' 视频元素=' + r.repliedVideo)
    await shutdown(ctx)

    console.log('')
    console.log('=== 4) 非 QQ 平台 + 阈值 30MB + 视频 35MB ===')
    ctx = await boot({ qqGroupFileLimitMB: 30 })
    r = await runCase(ctx, { platform: 'onebot', sizeMB: 35.2 })
    check('非 QQ 不受该阈值影响', r.calls.uploadFile === 0 && r.repliedVideo,
      'uploadFile=' + r.calls.uploadFile + ' 视频元素=' + r.repliedVideo)
    await shutdown(ctx)
  } catch (error) {
    console.error('群文件阈值冒烟测试失败:', error && error.stack ? error.stack : error)
    failures++
  }
  console.log('')
  console.log(failures ? '失败 ' + failures + ' 项' : '全部通过')
  process.exit(failures ? 1 : 0)
})()
