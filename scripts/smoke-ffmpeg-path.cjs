/**
 * 冒烟测试：ffmpeg 可执行文件的挑选与兜底（线上「spawn ./downloads/ffmpeg-linux-amd64-… EACCES」）。
 *
 * 覆盖：
 *   1. 候选校验：相对路径不存在 → 跳过；存在但没有执行权限 → 跳过；
 *      相对路径按 karinPathBase 归一化成绝对路径；目录 → 自动补 ffmpeg(.exe)；
 *      裸名字 → 去 PATH 里找，找不到就算不可用；
 *   2. 真实链路：把系统 ffmpeg 写成**相对路径**喂进去（karinPathBase 能归一化）→ 真的跑起来一次；
 *   3. 候选都不可用 → 回落到 PATH，日志里能看到「跳过 → 使用」；
 *   4. 两个候选都「能过校验但起不来」（假可执行文件）时不报「修复失败」就完事：
 *      自动换下一个候选，PATH 兜底能跑完；PATH 也不行时 stderr 里会列出都试过哪些；
 *   5. Koishi 的 ffmpeg 服务（ctx.ffmpeg）优先：好路径就用它；路径无效就跳过并提示去
 *      koishi-plugin-ffmpeg-path 配置里改，然后继续往下兜底；
 *   6. isFfmpegAvailable() 与真实可用性一致。
 *
 * 用法：node scripts/smoke-ffmpeg-path.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const pluginRoot = path.resolve(__dirname, '..')
const work = path.join(os.tmpdir(), 'kkk-smoke-ffmpeg-path')
fs.rmSync(work, { recursive: true, force: true })
fs.mkdirSync(work, { recursive: true })

const compat = require(path.join(pluginRoot, 'lib/compat/node-karin.js'))
const runtime = require(path.join(pluginRoot, 'lib/compat/runtime.js'))

let failures = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? ' | ' + extra : ''))
  if (!ok) failures++
}

/** 捕获兼容层日志（bindRuntime 之后 logger 会写进这里） */
const logs = []
const pushLog = (level) => (...args) => {
  logs.push('[' + level + '] ' + args.map((item) => (typeof item === 'string' ? item : String(item))).join(' '))
}
const fakeLogger = {
  debug: pushLog('debug'),
  info: pushLog('info'),
  warn: pushLog('warn'),
  error: pushLog('error'),
  mark: pushLog('mark'),
  success: pushLog('info')
}
const clearLogs = () => { logs.length = 0 }
const hasLog = (pattern) => logs.some((line) => pattern.test(line))
const findLog = (pattern) => logs.find((line) => pattern.test(line)) ?? ''

/** 系统 ffmpeg 在哪（PATH 里找一份真的） */
const systemFfmpeg = compat.findExecutableInPath('ffmpeg')
const systemFfprobe = compat.findExecutableInPath('ffprobe')

/**
 * 造一个「能通过校验、但 spawn 一定起不来」的假可执行文件。
 * Windows 看扩展名（.exe 就过），Linux/macOS 看 X_OK（chmod 755 就过），
 * 内容不是可执行格式 → 真跑的时候必然在 spawn 阶段失败。
 */
const fakeName = process.platform === 'win32' ? 'kkk-fake-ffmpeg.exe' : 'kkk-fake-ffmpeg'
const makeFakeBin = (name) => {
  const file = path.join(work, name)
  fs.writeFileSync(file, 'this is definitely not an executable')
  if (process.platform !== 'win32') fs.chmodSync(file, 0o755)
  return file
}

;(async () => {
  console.log('系统 ffmpeg: ' + (systemFfmpeg || '（PATH 里没找到）'))
  if (!systemFfmpeg) {
    check('本机 PATH 里有 ffmpeg（这个冒烟要有真 ffmpeg 才能跑兜底链路）', false)
    process.exit(1)
  }

  // 绑定一个假运行时：dataRoot = 系统 ffmpeg 所在盘的根目录（这样相对路径能真的归一化回去）
  const driveRoot = path.parse(systemFfmpeg).root
  runtime.bindRuntime({
    ctx: { ffmpeg: undefined, logger: () => fakeLogger, config: {} },
    config: {},
    pluginRoot,
    dataRoot: driveRoot
  })

  console.log('\n[1] 候选校验（checkFfmpegCandidate）')
  {
    const missing = compat.checkFfmpegCandidate('./downloads/ffmpeg-linux-amd64-abc123/ffmpeg', '测试')
    check('相对路径不存在 → 跳过，并说明是「文件不存在」',
      missing.ok === false && /文件不存在/.test(missing.reason ?? ''),
      missing.reason)

    const relativeOfSystem = path.relative(driveRoot, systemFfmpeg)
    const normalized = compat.checkFfmpegCandidate(relativeOfSystem, '测试')
    check('相对路径按 karinPathBase 归一化成绝对路径后可用',
      normalized.ok === true && path.isAbsolute(normalized.bin) && normalized.bin === systemFfmpeg,
      relativeOfSystem + ' → ' + normalized.bin)

    const noPermFile = path.join(work, 'not-executable.bin')
    fs.writeFileSync(noPermFile, 'x')
    const denied = compat.checkFfmpegCandidate(noPermFile, '测试', {
      platform: 'linux',
      canExecute: () => false
    })
    check('存在但没有执行权限（Linux/macOS）→ 跳过，并提示 chmod +x',
      denied.ok === false && /没有执行权限/.test(denied.reason ?? ''),
      denied.reason)

    const asDirectory = compat.checkFfmpegCandidate(path.dirname(systemFfmpeg), '测试')
    check('传的是目录 → 自动补平台对应的文件名',
      asDirectory.ok === true && asDirectory.bin === systemFfmpeg,
      asDirectory.bin)

    const bareMissing = compat.checkFfmpegCandidate('ffmpeg', '测试', { findInPath: () => '' })
    check('裸名字在 PATH 里找不到 → 跳过（不会等到 spawn 才 ENOENT）',
      bareMissing.ok === false && /PATH 里找不到/.test(bareMissing.reason ?? ''),
      bareMissing.reason)

    const bareFound = compat.checkFfmpegCandidate('ffmpeg', '测试')
    check('裸名字在 PATH 里找到 → 给出绝对路径',
      bareFound.ok === true && path.isAbsolute(bareFound.bin) && bareFound.bin === systemFfmpeg,
      bareFound.bin)

    const empty = compat.checkFfmpegCandidate('', '测试')
    check('空值 → 跳过', empty.ok === false && /值为空/.test(empty.reason ?? ''), empty.reason)
  }

  console.log('\n[2] 相对路径也能真的跑起来（用户那份 ./downloads/… 的同类问题）')
  {
    clearLogs()
    const relativeOfSystem = path.relative(driveRoot, systemFfmpeg)
    const result = await compat.ffmpeg('-hide_banner -version', { ffmpegPath: relativeOfSystem })
    check('相对路径的 ffmpeg 被归一化后成功执行',
      result.status === true && /ffmpeg version/i.test(result.stdout),
      (result.stdout.split('\n')[0] || result.stderr.slice(0, 80)).slice(0, 80))
    check('日志里写明用的是哪一份', hasLog(/\[ffmpeg\] 使用ffmpegPath 参数/), findLog(/\[ffmpeg\] 使用/))
  }

  console.log('\n[3] 候选不可用 → 回落到 PATH')
  {
    clearLogs()
    const result = await compat.ffmpeg('-hide_banner -version', {
      ffmpegPath: './downloads/ffmpeg-linux-amd64-notexist/ffmpeg'
    })
    check('候选不存在时仍然跑完了一次 ffmpeg 调用', result.status === true)
    check('日志里能看到「跳过」（带原因）与「使用」',
      hasLog(/\[ffmpeg\] 跳过ffmpegPath 参数.*文件不存在/) && hasLog(/\[ffmpeg\] 使用PATH/),
      findLog(/\[ffmpeg\] 跳过/))
  }

  console.log('\n[4] 两个候选都起不来：自动换下一个候选，PATH 兜底仍然成功')
  {
    clearLogs()
    const fakeA = makeFakeBin('fake-a' + (process.platform === 'win32' ? '.exe' : ''))
    const fakeB = makeFakeBin('fake-b' + (process.platform === 'win32' ? '.exe' : ''))
    const savedEnv = process.env.FFMPEG_PATH
    process.env.FFMPEG_PATH = fakeB
    try {
      const result = await compat.ffmpeg('-hide_banner -version', { ffmpegPath: fakeA })
      check('两个坏候选之后仍然跑完了一次 ffmpeg 调用（PATH 兜底）', result.status === true,
        (result.stdout.split('\n')[0] || '').slice(0, 60))
      check('日志里能看到「起不来 → 换下一个候选」',
        hasLog(/起不来.*换下一个候选/), findLog(/起不来/))
    } finally {
      if (savedEnv === undefined) delete process.env.FFMPEG_PATH
      else process.env.FFMPEG_PATH = savedEnv
    }
  }

  console.log('\n[4b] 连 PATH 也不行时：stderr 里列出「都试过哪些」')
  {
    clearLogs()
    const fakeA = makeFakeBin('fake-c' + (process.platform === 'win32' ? '.exe' : ''))
    const result = await compat.ffmpeg('-version', { ffmpegPath: fakeA, __ffmpegDeps: { findInPath: () => '' } })
    check('全部候选都失败时返回失败（而不是抛异常）', result.status === false)
    check('stderr 里列出了试过的可执行文件，用户照着就能自救',
      /已尝试的 ffmpeg/.test(result.stderr) && result.stderr.includes(fakeA),
      result.stderr.split('\n').slice(-1)[0].slice(0, 140))
  }

  console.log('\n[5] Koishi 的 ffmpeg 服务（ctx.ffmpeg）优先')
  {
    clearLogs()
    const relativeOfSystem = path.relative(driveRoot, systemFfmpeg)
    runtime.getRuntime().ctx.ffmpeg = { executable: relativeOfSystem }
    const result = await compat.ffmpeg('-hide_banner -version', {
      ffmpegPath: './downloads/ffmpeg-linux-amd64-notexist/ffmpeg'
    })
    check('服务给的（相对）路径优先被采用并跑通',
      result.status === true && hasLog(/\[ffmpeg\] 使用Koishi 的 ffmpeg 服务/),
      findLog(/\[ffmpeg\] 使用/))
    check('服务可用时不再去碰坏掉的 ffmpegPath 参数（没有那条跳过日志）',
      !hasLog(/跳过ffmpegPath 参数/))

    clearLogs()
    runtime.getRuntime().ctx.ffmpeg = { executable: './downloads/ffmpeg-linux-amd64-yv630148nzng13713f2k2csrv34hfzhd/ffmpeg' }
    const fallback = await compat.ffmpeg('-hide_banner -version')
    check('服务给的路径无效（那份下载下来的相对路径）→ 跳过并继续兜底',
      fallback.status === true && hasLog(/\[ffmpeg\] 跳过Koishi 的 ffmpeg 服务/)
      && hasLog(/\[ffmpeg\] 使用PATH/),
      findLog(/跳过Koishi/))
    check('顺手提示怎么改 ffmpeg-path 的配置（用户能照做）',
      hasLog(/ffmpeg-path 自动下载/) && hasLog(/autoDownload/),
      findLog(/ffmpeg-path/).slice(0, 120))
    runtime.getRuntime().ctx.ffmpeg = undefined
  }

  console.log('\n[6] isFfmpegAvailable 与真实可用性一致')
  {
    check('本机可用时返回 true', compat.isFfmpegAvailable() === true,
      'system=' + systemFfmpeg)
    runtime.getRuntime().ctx.ffmpeg = { executable: './downloads/ffmpeg-linux-amd64-nope/ffmpeg' }
    const savedPath = process.env.PATH
    process.env.PATH = path.join(work, 'empty-path')
    process.env.FFMPEG_PATH = './downloads/ffmpeg-linux-amd64-nope/ffmpeg'
    try {
      check('服务路径无效 + PATH 里没有 + 环境变量无效 → 返回 false（不再盲目说「能用」）',
        compat.isFfmpegAvailable() === false)
    } finally {
      process.env.PATH = savedPath
      delete process.env.FFMPEG_PATH
      runtime.getRuntime().ctx.ffmpeg = undefined
    }
  }

  console.log('\n[7] ffprobe 与 ffmpeg 同目录')
  {
    const resolved = compat.checkFfmpegCandidate(
      path.join(path.dirname(systemFfmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'),
      '与 ffmpeg 同目录')
    check('同目录的 ffprobe 通过校验', resolved.ok === true, resolved.ok ? resolved.bin : resolved.reason)
    if (systemFfprobe) {
      clearLogs()
      const result = await compat.ffprobe('-v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ' + JSON.stringify(path.join(work, 'nope.mp4')))
      check('ffprobe 能跑（文件不存在也算跑起来了，stderr 有 ffprobe 的报错）',
        /ffprobe|No such file|Invalid|Error/i.test(result.stderr) || result.status === true,
        (result.stderr.split('\n')[0] || '').slice(0, 90))
    } else {
      console.log('（本机没有 ffprobe，跳过这一条）')
    }
  }

  console.log('\n[8] 其它模块（图片切片）用的解析入口 resolveFfmpegBin')
  {
    check('给出的是校验过的绝对路径', path.isAbsolute(compat.resolveFfmpegBin()) && compat.resolveFfmpegBin() === systemFfmpeg,
      compat.resolveFfmpegBin())
    runtime.getRuntime().ctx.ffmpeg = { executable: './downloads/ffmpeg-linux-amd64-nope/ffmpeg' }
    const savedPath = process.env.PATH
    const savedEnvPath = process.env.FFMPEG_PATH
    process.env.FFMPEG_PATH = './downloads/ffmpeg-linux-amd64-nope/ffmpeg'
    process.env.PATH = path.join(work, 'empty-path')
    try {
      check('一份都不可用时回落到 ffmpeg 这个名字（交给 PATH 最后一次机会）',
        compat.resolveFfmpegBin() === 'ffmpeg', compat.resolveFfmpegBin())
    } finally {
      process.env.PATH = savedPath
      if (savedEnvPath === undefined) delete process.env.FFMPEG_PATH
      else process.env.FFMPEG_PATH = savedEnvPath
      runtime.getRuntime().ctx.ffmpeg = undefined
    }
  }

  console.log('\n=== ' + (failures ? '失败 ' + failures + ' 项' : '全部通过') + ' ===')
  process.exit(failures ? 1 : 0)
})().catch((error) => {
  console.error('冒烟测试失败:', error && error.stack ? error.stack : error)
  process.exit(1)
})
