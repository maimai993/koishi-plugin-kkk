/**
 * 冒烟测试：kkkshot 服务
 *   1. 服务能注册、能被别的插件 inject 到；
 *   2. 渲染一张卡片：格式 / 尺寸正确（按元素盒子裁切，不是整屏）；
 *   3. 渲染错误 HTML 会抛错但服务还能继续用（页面被丢掉重建）；
 *   4. 连续渲染的耗时：kkkshot vs「常规 puppeteer 用法」（新页面 + networkidle0）
 *      —— 后者就是 kkk 原来的路径，用来看提速。
 *
 * 用法：node scripts/smoke-kkkshot.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const pluginRoot = path.resolve(__dirname, '..')
const { Context } = require('koishi')

let failures = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? ' | ' + extra : ''))
  if (!ok) failures++
}

/** 造一张和 kkk 卡片同构的测试页：1440 宽、带底色、有图片和字体 */
const makeCardHtml = (title, height = 1400, imageUrl = '') => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #fff; font-family: system-ui, sans-serif; }
  #container { width: 1440px; }
  .card { width: 1440px; min-height: ${height}px; background: #f6f7f9; padding: 40px; border-radius: 16px; }
  h1 { font-size: 48px; margin-bottom: 24px; }
  .row { height: 60px; margin-bottom: 12px; background: #fff; border-radius: 8px; display: flex; align-items: center; padding: 0 20px; }
  img { width: 320px; height: 180px; object-fit: cover; border-radius: 8px; }
</style></head><body>
<div id="container"><div class="card">
  <h1>${title}</h1>
  ${Array.from({ length: 18 }).map((_, i) => `<div class="row">第 ${i + 1} 行内容 —— 用来把卡片撑高，模拟真实卡片</div>`).join('')}
  ${imageUrl ? `<img src="${imageUrl}">` : ''}
</div></div></body></html>`

const readImageSize = (buffer) => {
  if (buffer.length > 24 && buffer[0] === 0x89 && buffer[1] === 0x50) {
    return { type: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue }
      const marker = buffer[offset + 1]
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'jpeg', height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
      }
      const length = buffer.readUInt16BE(offset + 2)
      if (!length) break
      offset += 2 + length
    }
  }
  return { type: 'unknown' }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

;(async () => {
  const plugin = require(path.join(pluginRoot, 'lib/index.js'))
  const ctx = new Context()
  let injected = null
  ctx.plugin(plugin, { pages: 2, recycleAfter: 1000, warmup: false, timeout: 20000 })
  ctx.inject(['kkkshot'], (scope) => { injected = scope.kkkshot })
  await ctx.start()
  await sleep(6000)

  console.log('\n[1] 服务注册')
  check('ctx.kkkshot 存在', !!ctx.kkkshot)
  check('可以被别的插件 inject 到', !!injected)
  check('有 render / renderFile / stats / warmup', ['render', 'renderFile', 'stats', 'warmup'].every((key) => typeof ctx.kkkshot[key] === 'function'))

  console.log('\n[2] 渲染本地 HTML 文件（kkk 走的就是这条）')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkkshot-'))
  const file = path.join(dir, 'card.html')
  fs.writeFileSync(file, makeCardHtml('测试卡片'), 'utf8')
  const first = await ctx.kkkshot.renderFile(file, { selector: '#container', format: 'jpeg', quality: 92, deviceScaleFactor: 2 })
  const meta = readImageSize(first)
  console.log('     第一张：' + meta.type + ' ' + meta.width + 'x' + meta.height + ' ' + Math.round(first.length / 1024) + 'KB')
  check('返回的是 JPEG', meta.type === 'jpeg')
  // 1440 宽 + 2x → 2880；高度是卡片盒子（>1400）而不是初始视口的 900
  check('尺寸按元素盒子裁切（1440x2 宽、高度没被 900 视口截断）',
    meta.width === 2880 && meta.height > 1400 * 2 * 0.9, meta.width + 'x' + meta.height)

  console.log('\n[3] 连续渲染的耗时（这是「特别慢」的那部分）')
  const ROUNDS = 5
  const kkkshotTimes = []
  for (let i = 0; i < ROUNDS; i++) {
    const started = Date.now()
    await ctx.kkkshot.renderFile(file, { selector: '#container', format: 'jpeg', quality: 92 })
    kkkshotTimes.push(Date.now() - started)
  }
  const avg = (list) => Math.round(list.reduce((a, b) => a + b, 0) / list.length)
  console.log('     kkkshot：' + kkkshotTimes.join('ms / ') + 'ms → 平均 ' + avg(kkkshotTimes) + 'ms')

  /** 对照组：kkk 原来的路径（新开页面 + networkidle0 + 整屏截图） */
  const puppeteer = require('puppeteer-core')
  const puppeteerPlugin = require('koishi-plugin-puppeteer')
  const finder = require('puppeteer-finder')
  const executablePath = finder()
  const browser = await puppeteer.launch({ executablePath, headless: true, args: [] })
  const legacyTimes = []
  try {
    for (let i = 0; i < ROUNDS; i++) {
      const started = Date.now()
      const page = await browser.newPage()
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })
      await page.goto(require('node:url').pathToFileURL(file).href, { waitUntil: 'networkidle0', timeout: 20000 })
      const metrics = await page.evaluate(() => {
        const node = document.querySelector('#container')
        const rect = node.getBoundingClientRect()
        return { width: Math.ceil(rect.width), height: Math.ceil(rect.height) }
      })
      await page.setViewport({ width: metrics.width, height: Math.min(Math.max(Math.round(metrics.height), 200), 20000), deviceScaleFactor: 2 })
      await page.screenshot({ type: 'jpeg', quality: 92 })
      await page.close()
      legacyTimes.push(Date.now() - started)
    }
  } finally {
    await browser.close()
  }
  console.log('     常规用法：' + legacyTimes.join('ms / ') + 'ms → 平均 ' + avg(legacyTimes) + 'ms')
  const speedup = (avg(legacyTimes) / Math.max(1, avg(kkkshotTimes))).toFixed(2)
  console.log('     → 快 ' + speedup + ' 倍')
  check('kkkshot 明显更快（至少快 1.5 倍）', Number(speedup) >= 1.5, speedup + ' 倍')

  console.log('\n[3b] 远程图片慢的时候不能把渲染拖死（线上有一张卡片渲染了 35 秒）')
  {
    const slow = makeCardHtml('慢图卡片', 900, 'https://10.255.255.1/hang.png')
    const startedAt = Date.now()
    const buffer = await ctx.kkkshot.render(slow, { selector: '#container', format: 'jpeg', timeout: 60000 })
    const cost = Date.now() - startedAt
    console.log('     带一个连不上的远程图片：用时 ' + cost + 'ms')
    check('等候预算把它限制住了（< 15 秒）', cost < 15000, cost + 'ms')
    check('照样出图', readImageSize(buffer).type === 'jpeg')
  }

  console.log('\n[4] 尺寸稳定性 + 出错后仍可用')
  const buffer = await ctx.kkkshot.render(makeCardHtml('临时卡片', 800), { selector: '#container', format: 'png' })
  const meta2 = readImageSize(buffer)
  check('渲染 HTML 字符串（png）', meta2.type === 'png' && meta2.width === 2880, meta2.type + ' ' + meta2.width + 'x' + meta2.height)
  let threw = false
  try {
    await ctx.kkkshot.renderFile(path.join(dir, 'not-exist.html'), { selector: '#container', timeout: 3000 })
  } catch { threw = true }
  check('渲染不存在的文件会抛错（调用方可以回退）', threw)
  const afterError = await ctx.kkkshot.renderFile(file, { selector: '#container' })
  check('出错之后服务还能继续渲染', readImageSize(afterError).type === 'jpeg')
  const stats = ctx.kkkshot.stats()
  console.log('     统计：' + JSON.stringify(stats))
  check('统计里有渲染次数 / 平均耗时', stats.renders >= ROUNDS + 2 && stats.avgMs > 0, JSON.stringify({ renders: stats.renders, avgMs: stats.avgMs }))

  await ctx.stop()
  console.log('\n=== ' + (failures ? '失败 ' + failures + ' 项' : '全部通过') + ' ===')
  process.exit(failures ? 1 : 0)
})().catch((error) => {
  console.error('冒烟测试失败:', error && error.stack ? error.stack : error)
  process.exit(1)
})
