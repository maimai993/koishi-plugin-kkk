/**
 * 探针：群文件发送的「文件名」。
 *
 * 起因（用户贴的日志）：
 *
 *     [视频发送] 平台=qq 体积=40.6MB QQ阈值=30MB 走群文件=true
 *     被动消息: 视频大小: 40.6MB 正在通过e.bot.uploadFile回复...
 *     视频文件上传错误,Error
 *     [ErrorHandler] 原始错误: 解析过程中有 1 个步骤失败（发送视频）：
 *     Error
 *         at _QQMessageEncoder.send (…/@satorijs/core/lib/index.cjs:756:13)
 *
 * 这条视频来自快手，标题（`work.photo.caption`）是一段**带换行、三百多字**的文案，
 * 而这条链路以前把标题**原样**拼上 `.mp4` 当 `file_name` 发给 QQ 的 `upload_prepare`。
 * 对照证据：
 *   - 历史上走群文件成功的三次是 B站 / 抖音 / onebot；B站 的标题在 `bilibili.ts` 里
 *     已经做过 `substring(0, 50).replace(/[\\/:*?"<>|\r\n\s]/g, ' ')` 清洗，快手没有；
 *   - 今天走群文件失败的三次**全是快手**，而且是同一个视频。
 *
 * 覆盖五件事：
 *   ① 「文件名生成」是纯函数，直接按真实标题断言（旧实现会失败、新实现通过）；
 *   ② 端到端：真调 `uploadFile`，断言交给适配器的文件名里**没有换行**；
 *   ③ 兜底：名字被 QQ 打回时，会换一个临时名重试一次；
 *   ④ 错误描述：satori 的 `AggregateError`（message 是空的）要能说出真正的原因；
 *   ⑤ 「发了但协议端没回消息 ID」（LLOneBot 发视频）：算成功，且**不许重发**。
 *
 * 全程离线：不联网、不连 QQ、不改用户配置；只往系统临时目录里写一个探针自己的数据目录。
 *
 * 用法：node scripts/probe-group-file-name.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const lib = path.join(__dirname, '..', 'lib')

/** 出问题那条视频的真实标题（从 `https://v.kuaishou.com/ngvMu0wy` 页面里的 `caption` 字段抄的） */
const REAL_CAPTION = '《打电话赢 1 万！视频连线妈妈拿双份奖金，订阅直接翻倍余额，全程爽到爆》\n\n'
  + '三大现金挑战，奖金拿到手软：\n \n极速通话挑战：路人比拼打电话，先接通者双方各得 1 万美元，女友神助攻赢麻了\n \n'
  + '视频连线挑战：拨通妈妈视频，接通就给母亲儿子各 1 万，妈妈秒接直接暴富\n \n'
  + '订阅翻倍余额：确认订阅后，银行余额直接翻倍，29.82 美元秒变 10,029.82 美元\n \n'
  + '全程高能宠粉，不订阅真的亏到哭！ #MrBeast      #野兽先生'

/**
 * 先绑定一个假运行时，再 require 业务模块。
 *
 * `Common` 是在模块顶层 `new` 出来的，构造函数里会调 `karinPathTemp()` → `getRuntime()`，
 * 没绑定就直接抛。假运行时只提供探针需要的最小字段，数据目录落在系统临时目录里。
 */
const runtime = require(path.join(lib, 'compat/runtime.js'))
const probeDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kkk-probe-groupfile-'))
runtime.bindRuntime({
  ctx: { config: { port: 5200 } },
  config: { masters: [], debug: false, qqGroupFileLimitMB: 30 },
  pluginRoot: path.join(__dirname, '..'),
  dataRoot: probeDataRoot
})

/**
 * `Config` 换成假的：探针结果不能随用户面板上的开关变化。
 * Base.js 是 `Config_1.Config.app.xxx` 这种**调用时取属性**的写法，所以直接替换导出即可。
 */
const ConfigModule = require(path.join(lib, 'karin/module/utils/Config.js'))
ConfigModule.Config = {
  app: {
    compress: false,
    compresstrigger: 100,
    compressvalue: 20,
    videoSendMode: 'file',
    removeCache: false,
    filelimit: 200,
    usegroupfile: false,
    groupfilevalue: 100
  },
  bilibili: {},
  douyin: {},
  kuaishou: {},
  xiaohongshu: {},
  // `amagiClient` 在模块顶层就 new 了一个实例，构造函数里会读 `Config.amagi`
  amagi: { cookies: {}, timeout: 5000, 'User-Agent': 'kkk-probe', proxy: { switch: false } }
}

/**
 * 假日志器：接住插件写出来的日志，供断言用。
 * （兼容层默认走 `runtime.ctx.logger('kkk')`，探针的假 ctx 没有它。）
 */
const logs = []
const compatLogger = require(path.join(lib, 'compat/logger.js'))
compatLogger.setLogger({
  info: (message) => logs.push(['info', String(message)]),
  warn: (message) => logs.push(['warn', String(message)]),
  error: (message) => logs.push(['error', String(message)]),
  debug: (message) => logs.push(['debug', String(message)])
})

const Base = require(path.join(lib, 'karin/module/utils/Base.js'))
const ParseSteps = require(path.join(lib, 'karin/module/utils/ParseSteps.js'))

let failed = 0
const check = (name, ok, detail) => {
  console.log((ok ? '  ✔ ' : '  ✘ ') + name + (detail ? '  → ' + detail : ''))
  if (!ok) failed++
}
const section = (title) => console.log('\n' + title)

/** 造一个假事件：只有 `contact` 与 `bot.uploadFile`，名字被原样记下来 */
const makeEvent = (onUpload) => {
  const calls = []
  const event = {
    selfId: '3889000001',
    channelId: 'group_123',
    messageId: 'MSG-1',
    contact: { peer: 'group_123' },
    bot: {
      bot: { platform: 'qq' },
      platform: 'qq',
      account: { selfId: '3889000001', name: 'kkk' },
      uploadFile: async (contact, file, name) => {
        calls.push({ contact, file, name })
        if (onUpload) return await onUpload(calls.length, name)
        return { messageId: 'FILE-OK' }
      },
      recallMsg: async () => undefined
    },
    reply: async () => ({ messageId: 'TIP-1' })
  }
  return { event, calls }
}

/** 造一个视频文件信息：体积超过 QQ 阈值（30MB）才会走群文件 */
const makeFile = (originTitle, filepath) => ({
  filepath: filepath ?? path.join(probeDataRoot, 'video', 'tmp_1790849905058.mp4'),
  totalBytes: 40.62,
  originTitle
})

const run = async () => {
  section('① 文件名生成（纯函数，真实标题）')
  const oldWay = `${REAL_CAPTION}.mp4`
  check(
    '旧写法（标题原样拼 .mp4）确实是不合法的：含换行、超长',
    /[\r\n]/.test(oldWay) && oldWay.length > 200,
    `长度 ${oldWay.length}，含换行 ${/[\r\n]/.test(oldWay)}`
  )

  const name = Base.groupFileName(makeFile(`${REAL_CAPTION}.mp4`))
  check('真实标题：不含换行', !/[\r\n]/.test(name), JSON.stringify(name))
  check('真实标题：不含 QQ/Windows 不接受的字符', !/[\\/:*?"<>|\u0000-\u001f]/.test(name), JSON.stringify(name))
  check('真实标题：长度受控（≤ 60 字 + .mp4）', name.length <= 64, `长度 ${name.length}`)
  check('真实标题：以 .mp4 结尾', name.endsWith('.mp4'), name.slice(-8))
  check('真实标题：不会拼成 .mp4.mp4', !/\.mp4\.mp4$/i.test(name), name.slice(-12))

  check('短标题原样保留', Base.groupFileName(makeFile('测试视频.mp4')) === '测试视频.mp4')
  check('没有扩展名也会补上', Base.groupFileName(makeFile('测试视频')) === '测试视频.mp4')
  const noExtOnDisk = Base.groupFileName({ filepath: '/tmp/koishi/x/tmp_1.mp4' })
  check('标题整个为空时退回 filepath 的文件名（不是整条路径）', noExtOnDisk === 'tmp_1.mp4', noExtOnDisk)
  const winPath = Base.groupFileName({ filepath: 'E:\\devkoishi\\data\\temp\\kkk\\tmp_2.mp4' })
  check('反斜杠路径也能取到文件名', winPath === 'tmp_2.mp4', winPath)
  check('标题只有 .mp4（清完变空）→ 兜底名', /^kkk_\d+\.mp4$/.test(Base.groupFileName(makeFile('.mp4'))))
  check('标题只剩空白 → 退回 filepath 的文件名', Base.groupFileName(makeFile('\n\n   \n')) === 'tmp_1790849905058.mp4',
    Base.groupFileName(makeFile('\n\n   \n')))
  check('标题与 filepath 都空 → 兜底名', /^kkk_\d+\.mp4$/.test(Base.groupFileName({ originTitle: '', filepath: '' })))
  check('非法字符被换成空格', Base.groupFileName(makeFile('a/b\\c:d*e?f"g<h>i|j.mp4')) === 'a b c d e f g h i j.mp4',
    Base.groupFileName(makeFile('a/b\\c:d*e?f"g<h>i|j.mp4')))

  section('② 端到端：交给适配器的文件名')
  const videoPath = path.join(probeDataRoot, 'tmp_1790849905058.mp4')
  fs.mkdirSync(path.dirname(videoPath), { recursive: true })
  fs.writeFileSync(videoPath, Buffer.alloc(1024, 1))

  const a = makeEvent()
  await Base.uploadFile(a.event, makeFile(`${REAL_CAPTION}.mp4`, videoPath), 'https://example.com/v.mp4', { message_id: 'MSG-1' })
  check('真的走了群文件', a.calls.length === 1, `bot.uploadFile 调用 ${a.calls.length} 次`)
  if (a.calls.length) {
    check('传给适配器的文件名不含换行', !/[\r\n]/.test(String(a.calls[0].name)), JSON.stringify(a.calls[0].name))
    check('传给适配器的是本地路径（群文件分支）', a.calls[0].file === videoPath, String(a.calls[0].file))
  }

  section('③ 名字被 QQ 打回时换临时名重试一次')
  let round = 0
  const b = makeEvent(async (n, _name) => {
    if (n === 1) throw Object.assign(new Error('QQ 消息发送失败 [40034005] file_name invalid'), { response: { data: { code: 40034005 } } })
    return { messageId: 'FILE-RETRY-OK' }
  })
  const bReturn = await Base.uploadFile(b.event, makeFile(`${REAL_CAPTION}.mp4`, videoPath), '', { message_id: 'MSG-1' })
  check('重试了一次（共两次调用）', b.calls.length === 2, `调用 ${b.calls.length} 次`)
  check('第一次用的是清洗后的标题名', b.calls[0] && /[\r\n]/.test(String(b.calls[0].name)) === false, JSON.stringify(b.calls[0] && b.calls[0].name))
  check('第二次用的是临时名', b.calls[1] && /^kkk_\d+\.mp4$/.test(String(b.calls[1].name)), JSON.stringify(b.calls[1] && b.calls[1].name))
  check('重试成功后整体算成功', bReturn === true)
  const retryLog = logs.find(([, message]) => message.includes('改用临时文件名重试一次'))
  check('重试时打了日志，而且写清了原因', !!retryLog && retryLog[1].includes('[40034005]'),
    retryLog ? retryLog[1].trim() : '没打日志')

  let callsC = 0
  const c = makeEvent(async () => { callsC++; throw new Error('QQ 消息发送失败 [40034005] file_name invalid') })
  let threw = null
  try {
    await Base.uploadFile(c.event, makeFile(`${REAL_CAPTION}.mp4`, videoPath), '', { message_id: 'MSG-1' })
  } catch (error) {
    threw = error
  }
  check('两次都失败时仍然抛错（错误卡片照常出）', !!threw, threw ? threw.message : '没抛')
  check('两次都失败时没有无限重试', callsC === 2, `调用 ${callsC} 次`)

  section('④ 错误描述：把 AggregateError 里的真话挖出来')
  const inner = new Error('QQ 消息发送失败 [40034005] file_name invalid')
  const agg = new Error('')
  agg.errors = [inner]
  check('AggregateError 的 message 是空的（所以要挖）', agg.message === '')
  check('能挖出内层原因', ParseSteps.describeError(agg) === 'QQ 消息发送失败 [40034005] file_name invalid', ParseSteps.describeError(agg))
  check('没有内层时至少给个名字', ParseSteps.describeError(new Error('')) === 'Error', ParseSteps.describeError(new Error('')))
  const withCause = new Error('')
  withCause.cause = new Error('fetch base64://AAAA… failed')
  check('也认 cause', ParseSteps.describeError(withCause) === 'fetch base64://AAAA… failed', ParseSteps.describeError(withCause))
  const selfRef = new Error('')
  selfRef.cause = selfRef
  check('cause 自引用不会转不出来', typeof ParseSteps.describeError(selfRef) === 'string')
  check('parseSteps 合成的错误里带上了内层原因', (() => {
    const steps = new ParseSteps.ParseSteps()
    steps.fail('发送视频', agg)
    try {
      steps.throwIfFailed()
      return false
    } catch (error) {
      return error.message.includes('[40034005] file_name invalid')
    }
  })())

  /**
   * ⑤ 「发了，但协议端没回消息 ID」（LLOneBot 发视频就是这样）。
   *
   * 用户实测：一条指令下来群里躺着**两条一模一样的视频**，还多出一张「发送失败」的
   * 错误卡片。链路是这样的：
   *   uploadFile 判「没 ID = 没发出去」→ 抛错 → sendGroupFile **换个文件名再发一次**
   *   （视频于是进了两次群）→ 第二次同样没 ID → 错误卡片。
   * 适配器没抛异常就说明协议端收下了（OneBot 是 retcode 0），所以这里必须按成功算，
   * 而且**绝不能重试** —— 大文件重传的代价远大于漏报一次失败。
   */
  section('⑤ 「发了但没拿到消息 ID」：算成功，也不许重发')
  const sendError = require(path.join(lib, 'compat/sendError.js'))
  const d = makeEvent(async () => ({ messageId: '', rawData: [], unconfirmed: true }))
  const dReturn = await Base.uploadFile(d.event, makeFile('测试视频.mp4', videoPath), '', { message_id: 'MSG-1' })
  check('只发了一次（不再换文件名重发一遍）', d.calls.length === 1, `调用 ${d.calls.length} 次`)
  check('整体算成功（视频确实已经在群里）', dReturn === true)

  const e = makeEvent(async () => { throw new sendError.UnconfirmedSendError() })
  let eThrew = null
  try {
    await Base.uploadFile(e.event, makeFile('测试视频.mp4', videoPath), '', { message_id: 'MSG-1' })
  } catch (error) {
    eThrew = error
  }
  check('万一上面还是抛了未确认错误：也不重试', e.calls.length === 1, `调用 ${e.calls.length} 次`)
  check('未确认错误照样往上抛（由上层决定怎么报）', !!eThrew, eThrew ? eThrew.name : '没抛')
  check('isUnconfirmedSendError 认得它', sendError.isUnconfirmedSendError(new sendError.UnconfirmedSendError()))
  check('普通错误不认（该重试的还是会重试）', !sendError.isUnconfirmedSendError(new Error('file_name invalid')))

  section('⑥ 源码守卫（产物里真的接上了）')
  const baseSrc = fs.readFileSync(path.join(lib, 'karin/module/utils/Base.js'), 'utf8')
  check('产物里有 groupFileName', /groupFileName/.test(baseSrc))
  check('群文件分支不再直接拼 `${originTitle}.mp4`', !/\$\{[^}]*(?:file\.)?originTitle\}\.mp4/.test(baseSrc))
  check('产物里有失败重试', /fallbackGroupFileName/.test(baseSrc))
  /**
   * 「视频压根发不出去」的另一半原因：ffmpeg 解不动这个编码（日志里是
   * `[hevc …] Unknown profile bitstream`）时压缩必然失败，而以前**不看压缩结果**，
   * 一律把 filepath 换成那个压根不存在的产物 → 后面报「上传文件不存在」。
   */
  check('压缩失败时改用原文件（不会拿不存在的产物去发）', /压缩失败，改用原文件发送/.test(baseSrc))
  check('读不出时长时不进压缩（码率算出来是 NaN）', /放弃压缩，直接发原文件/.test(baseSrc))
  check('临时预览地址不再用 process.env.HTTP_PORT 裸取', !/localhost:\$\{process\.env\.HTTP_PORT/.test(baseSrc))
  /**
   * 源码守卫要先**剥掉注释**再匹配。
   *
   * 第一版守卫直接 `!/execFileSync/.test(src)`，结果匹配到了我在 build.mjs 里
   * 「以前这里用 execFileSync('git', …)」那句**解释性注释** —— 守卫把自己写的说明
   * 当成了违规代码（这个坑在 `probe-extract-buttons.cjs` 里也踩过一次）。
   */
  const stripComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/([^:'"\\])\/\/.*$/gm, '$1')
  const buildCode = stripComments(fs.readFileSync(path.join(__dirname, 'build.mjs'), 'utf8'))
  check('构建脚本不再导入 node:child_process', !/node:child_process/.test(buildCode))
  check('构建脚本不再同步起子进程', !/execFileSync|spawnSync/.test(buildCode))
  check('构建脚本改为直接读 .git/HEAD', /\.git\/HEAD|'HEAD'/.test(buildCode))

  console.log('\n' + (failed ? `✘ ${failed} 项失败` : '✔ 全部通过'))
  fs.rmSync(probeDataRoot, { recursive: true, force: true })
  // uploadFile 的 finally 里挂了一个 30 分钟后删文件的 setTimeout，别让它吊住进程
  process.exit(failed ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
