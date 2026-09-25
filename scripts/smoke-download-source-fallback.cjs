/**
 * 冒烟测试：下载器遇到「连得上但不吐数据」的坏源时的行为。
 *
 * 背景（用户实测）：B站 playurl 把直链指向 `*.mcdn.bilivideo.cn` 这类 PCDN 边缘节点，
 * TCP 连得上、响应头也正常，就是 60 秒只吐 118 KB；而旧实现的定时器是
 * **从请求开始算的 60 秒总超时**，于是任何大文件都永远下不完，
 * 报错还被 Node 报成 `Error: aborted`（code ECONNRESET）→ 日志写成「连接被重置」。
 *
 * 这里用本地 HTTP 服务复现四种场景，全程只依赖本机、不碰外网：
 *   1. 坏源 + 备用镜像：应当自动换源并下完（新增行为）
 *   2. 只有坏源、没有备用：应当报「下载超时」，**不能**再报「连接被重置」
 *   3. 健康但慢的源（总耗时远超 timeout）：应当下完（旧的 60 秒总超时会掐死它）
 *   4. 涓流源（一直有数据但速度远低于阈值）+ 备用镜像：应当被看门狗换掉
 *
 * 走的是 lib 产物（真正跑的就是它），不是 src。
 * 用法：node scripts/smoke-download-source-fallback.cjs
 */
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const axios = require('axios')

const { Downloader } = require('../lib/karin/module/utils/Network/Downloader.js')

/** 目标文件大小：8 MB（远大于 x64 回退的 256 KB 安全裕量） */
const TOTAL = 8 * 1024 * 1024

let failures = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? ' | ' + extra : ''))
  if (!ok) failures++
}

/** 收集日志，用于断言「换源」「超时」这类提示文案 */
const logs = []
const rawLog = console.log.bind(console)
const rawWarn = console.warn.bind(console)
console.log = (...args) => { logs.push(args.join(' ')); rawLog(...args) }
console.warn = (...args) => { logs.push(args.join(' ')); rawWarn(...args) }

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1', () => resolve(server))
})
const urlOf = (server) => 'http://127.0.0.1:' + server.address().port + '/file'

const parseRangeStart = (header) => {
  if (!header) return 0
  const raw = String(header).replace('bytes=', '').split('-')[0]
  const start = Number(raw)
  return Number.isFinite(start) && start > 0 ? start : 0
}

/** 正常源：支持 Range，快速把整份数据写完 */
const goodHandler = (req, res) => {
  const start = parseRangeStart(req.headers.range)
  const length = TOTAL - start
  res.writeHead(start > 0 ? 206 : 200, {
    'content-type': 'application/octet-stream',
    'content-length': String(length),
    ...(start > 0 ? { 'content-range': 'bytes ' + start + '-' + (TOTAL - 1) + '/' + TOTAL } : {})
  })
  const chunk = Buffer.alloc(256 * 1024)
  let sent = start
  const pump = () => {
    while (sent < TOTAL) {
      const size = Math.min(chunk.length, TOTAL - sent)
      sent += size
      if (!res.write(chunk.subarray(0, size))) {
        res.once('drain', pump)
        return
      }
    }
    res.end()
  }
  pump()
}

/** 坏源：发完响应头和 64 KB 就再也不吐数据，且不关连接（mcdn/PCDN 的典型表现） */
const badHandler = (req, res) => {
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(TOTAL) })
  res.write(Buffer.alloc(64 * 1024))
}

/** 涓流源：一直有数据，但只有 ~5 KB/s，远低于坏源看门狗阈值 */
const trickleHandler = (req, res) => {
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(TOTAL) })
  const timer = setInterval(() => { res.write(Buffer.alloc(1024)) }, 200)
  res.on('close', () => clearInterval(timer))
}

/** 健康但慢的源：约 4 秒传完 8 MB（每 200 ms 一块），总耗时远超 timeout */
const slowHandler = (req, res) => {
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(TOTAL) })
  let sent = 0
  const timer = setInterval(() => {
    if (sent >= TOTAL) { clearInterval(timer); res.end(); return }
    const size = Math.min(512 * 1024, TOTAL - sent)
    sent += size
    res.write(Buffer.alloc(size))
  }, 250)
  res.on('close', () => clearInterval(timer))
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kkk-dl-'))

const runDownload = async (label, url, { timeout, retries = 3, backups = [] }) => {
  const filepath = path.join(tmp, label + '.bin')
  const instance = axios.create({ timeout, maxRedirects: 5, validateStatus: () => true })
  const downloader = new Downloader(instance, url, filepath, {}, timeout, retries, { enabled: false }, backups)
  const started = Date.now()
  try {
    const result = await downloader.download(() => {})
    return { ok: true, bytes: fs.statSync(result.filepath).size, elapsed: Date.now() - started }
  } catch (error) {
    return { ok: false, message: String(error && error.message), bytes: fs.existsSync(filepath) ? fs.statSync(filepath).size : 0, elapsed: Date.now() - started }
  }
}

const main = async () => {
  const bad = await listen(badHandler)
  const good = await listen(goodHandler)
  const trickle = await listen(trickleHandler)
  const slow = await listen(slowHandler)

  // 1. 坏源 + 备用镜像 → 自动换源下完
  logs.length = 0
  const switched = await runDownload('switch', urlOf(bad), { timeout: 2000, backups: [urlOf(good)] })
  check('坏源 + 备用镜像：下载成功', switched.ok, JSON.stringify(switched))
  check('坏源 + 备用镜像：文件完整', switched.bytes === TOTAL, switched.bytes + '/' + TOTAL)
  check('坏源 + 备用镜像：日志里有换源提示', logs.some((line) => line.includes('换备用下载源')), logs.filter((l) => l.includes('备用下载源')).join(' / '))

  // 2. 只有坏源、没有备用 → 报「下载超时」，不报「连接被重置」
  logs.length = 0
  const timedOut = await runDownload('timeout', urlOf(bad), { timeout: 1500, retries: 0 })
  check('无备用源：如预期失败', !timedOut.ok, JSON.stringify(timedOut))
  check('无备用源：报「下载超时」', timedOut.message.includes('下载超时'), timedOut.message.slice(0, 160))
  check('无备用源：不再误报「连接被重置」', !timedOut.message.includes('连接被重置'), timedOut.message.slice(0, 160))
  check('无备用源：超时按空闲判定（约等于 timeout）', timedOut.elapsed < 1500 + 1500, timedOut.elapsed + 'ms')

  // 3. 健康但慢的源：总耗时远超 timeout 也要下完（旧的 60 秒总超时会掐死它）
  const slowRun = await runDownload('slow', urlOf(slow), { timeout: 1500, retries: 0 })
  check('健康慢源：下载成功', slowRun.ok, JSON.stringify(slowRun))
  check('健康慢源：文件完整', slowRun.bytes === TOTAL, slowRun.bytes + '/' + TOTAL)
  check('健康慢源：确实是「比 timeout 慢」的场景', slowRun.elapsed > 1500 * 2, slowRun.elapsed + 'ms > 2x timeout')

  // 4. 涓流源 + 备用镜像 → 看门狗换源（热身期 20s，这条最慢）
  logs.length = 0
  const watchdog = await runDownload('watchdog', urlOf(trickle), { timeout: 60000, retries: 1, backups: [urlOf(good)] })
  check('涓流源：被看门狗换掉后下载成功', watchdog.ok, JSON.stringify(watchdog))
  check('涓流源：文件完整', watchdog.bytes === TOTAL, watchdog.bytes + '/' + TOTAL)
  check('涓流源：日志提示速度过低', logs.some((line) => line.includes('速度过低')), logs.filter((l) => l.includes('速度过低')).join(' / '))

  for (const server of [bad, good, trickle, slow]) server.close()
  fs.rmSync(tmp, { recursive: true, force: true })

  console.log('')
  console.log(failures ? '失败 ' + failures + ' 项' : '全部通过')
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
