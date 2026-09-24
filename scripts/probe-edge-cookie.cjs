const fs = require('node:fs')
const path = require('node:path')
const pluginRoot = path.resolve(__dirname, '..')
const libRoot = path.join(pluginRoot, 'lib')
const runtime = require(path.join(libRoot, 'compat', 'runtime.js'))
const noop = () => {}
runtime.bindRuntime({ ctx: { get: () => undefined, logger: () => ({ info: noop, warn: noop, error: noop, debug: noop, mark: noop }), bots: [], registry: new Map(), on: noop, middleware: noop }, config: { app: {} }, dataRoot: path.join(pluginRoot, 'data-probe-node'), pluginRoot, master: () => [] })
const { Networks } = require(path.join(libRoot, 'karin', 'module', 'utils', 'Network', 'index.js'))
const cfgPath = 'C:\\sj\\koishi\\data\\koishi-plugin-kkk\\config\\config.json'
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
const cookie = String(cfg.amagi?.cookies?.bilibili ?? '')
console.log('生产 Cookie: ' + (cookie ? '有（长度 ' + cookie.length + '，含 SESSDATA=' + /SESSDATA=/.test(cookie) + '）' : '无'))
const bvid = 'BV1xDgL6SEzk'
const rootCid = 41156151510
const edgeId = 47666682
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const baseHeaders = (withCookie) => ({ 'User-Agent': UA, Referer: 'https://www.bilibili.com/', ...(withCookie && cookie ? { Cookie: cookie } : {}) })
const urls = {
  player: 'https://api.bilibili.com/x/player/wbi/v2?bvid=' + bvid + '&cid=' + rootCid,
  edge: 'https://api.bilibili.com/x/stein/edgeinfo_v2?bvid=' + bvid + '&graph_version=1722536&cid=' + rootCid + '&edge_id=' + edgeId,
  edgeNoEdge: 'https://api.bilibili.com/x/stein/edgeinfo_v2?bvid=' + bvid + '&graph_version=1722536&cid=' + rootCid
}
const summarize = (payload) => {
  if (payload === false) return 'Networks 返回 false（请求本身失败）'
  if (payload === null) return 'Networks 返回 null'
  if (typeof payload !== 'object') return '类型 ' + typeof payload
  const data = payload.data ?? {}
  const questions = data.edges?.questions ?? []
  return 'code=' + payload.code + ' message=' + JSON.stringify(payload.message) + ' 有 data=' + !!payload.data + ' 题目数=' + questions.length
}
const main = async () => {
  for (const withCookie of [true, false]) {
    console.log('')
    console.log('=== ' + (withCookie ? '带生产 Cookie' : '匿名（不带 Cookie）') + ' ===')
    for (const [name, url] of Object.entries(urls)) {
      try {
        const payload = await new Networks({ url, headers: baseHeaders(withCookie), timeout: 15000 }).getData()
        console.log('Networks ' + name + ': ' + summarize(payload))
      } catch (error) { console.log('Networks ' + name + ' 抛错: ' + String(error?.message ?? error)) }
      try {
        const response = await fetch(url, { headers: baseHeaders(withCookie) })
        const text = await response.text()
        let parsed = null
        try { parsed = JSON.parse(text) } catch {}
        console.log('fetch    ' + name + ': HTTP ' + response.status + ' ' + (parsed ? 'code=' + parsed.code + ' message=' + JSON.stringify(parsed.message) : '非 JSON: ' + text.slice(0, 80)))
      } catch (error) { console.log('fetch    ' + name + ' 抛错: ' + String(error?.message ?? error)) }
    }
  }
}
main().catch((error) => { console.log('探针失败: ' + (error && error.stack ? error.stack : error)); process.exit(1) })
