/**
 * 冒烟测试：kkk 的渲染**只走浏览器服务**（3.5.0 起不再支持 shotkit 内核）。
 *
 *   用例 1：装了浏览器服务（这里用假的）+ 顺带装了 shotkit → 用浏览器渲染，内核一次都不碰
 *   用例 2：karin 兼容层的 render.render() 走的是同一条路
 *   用例 3：只有内核、没有浏览器服务 → 渲染失败，而且**不会偷偷用内核兜底**，
 *          日志里给出能照做的报错（"需要安装浏览器渲染服务"）
 *
 * 另外记录渲染区间，断言没有并发渲染（渲染是串行的硬性要求）。
 *
 * 用法：node scripts/smoke-render-path.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const pluginRoot = path.resolve(__dirname, '..')
const { Context } = require('koishi')

let failures = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? 'OK  ' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : ''))
  if (!ok) failures++
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const DATA_ROOT = path.join(pluginRoot, 'data-smoke-render-path')

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

function record (events, name, fn) {
  return async (...args) => {
    const entry = { name, start: Date.now(), end: 0 }
    events.push(entry)
    try { return await fn(...args) } finally { entry.end = Date.now() }
  }
}

function fakePuppeteer (events) {
  const handle = { boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }) }
  const page = {
    setViewport: async () => {},
    goto: async () => {},
    evaluate: async () => ({ width: 720, height: 480 }),
    $: async () => handle,
    metrics: async () => ({ JSHeapUsedSize: 1234567 }),
    screenshot: record(events, 'chrome:screenshot', async () => TINY_PNG),
    close: async () => {},
  }
  return { name: 'puppeteer', page: async () => page, browser: { newPage: async () => page, process: () => ({ pid: 0 }) } }
}

/** 建一个上下文：可选挂假浏览器服务；装了 shotkit 就给它打点（用它=失败） */
async function boot ({ withPuppeteer, events }) {
  const kkk = require(path.join(pluginRoot, 'lib/index.js'))
  const ctx = new Context()
  ctx.plugin(kkk, { dataPath: DATA_ROOT, debug: true })
  try {
    const shotkit = require('koishi-plugin-shotkit')
    ctx.plugin(shotkit, {})
  } catch { /* 没装就没装：这个测试的重点是「不会用它」，没装更省事 */ }
  if (withPuppeteer) ctx.set('puppeteer', fakePuppeteer(events))
  await ctx.start()
  await sleep(400)
  const service = typeof ctx.get === 'function' ? ctx.get('shotkit') : null
  if (service && typeof service.renderFile === 'function') {
    const original = service.renderFile.bind(service)
    service.renderFile = record(events, 'shotkit:renderFile', original)
  }
  return ctx
}

/** 渲染区间不能交叠（串行是硬性要求） */
function overlaps (events) {
  const spans = events.filter((e) => e.end).sort((a, b) => a.start - b.start)
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < spans[i - 1].end) return spans[i - 1].name + ' 与 ' + spans[i].name + ' 重叠'
  }
  return null
}

/** 抓住这段代码里的日志（兼容层日志最终落到 console.log） */
async function captureLogs (fn) {
  const lines = []
  const original = console.log
  console.log = (...args) => { lines.push(args.map((item) => String(item)).join(' ')) }
  try { await fn() } finally { console.log = original }
  return lines
}

const CARD = { title: '渲染冒烟', author: 'smoke', desc: '', cover: '' }

;(async () => {
  console.log('')
  console.log('[1] 有浏览器服务：用浏览器渲染，shotkit 一次都不碰')
  {
    const events = []
    const ctx = await boot({ withPuppeteer: true, events })
    const before = ctx.shotkit?.captures ?? 0
    const { Render } = require(path.join(pluginRoot, 'lib/karin/module/utils/Render/index.js'))
    const result = await Render({}, 'bilibili/info', CARD)
    const image = Array.isArray(result) ? result.find((el) => el && (el.type === 'img' || el.type === 'image')) : null
    check('渲染出了图片元素', !!image)
    check('浏览器被用上了', events.some((e) => e.name === 'chrome:screenshot'), events.map((e) => e.name).join(',') || '无')
    check('shotkit 内核一次都没碰', (ctx.shotkit?.captures ?? 0) - before === 0, ((ctx.shotkit?.captures ?? 0) - before) + ' 次')
    check('没有并发渲染', !overlaps(events))
    await ctx.stop()
  }

  console.log('')
  console.log('[2] karin 兼容层的 render.render() 也走浏览器')
  {
    const events = []
    const ctx = await boot({ withPuppeteer: true, events })
    const htmlPath = path.join(DATA_ROOT, 'html', 'koishi-plugin-kkk', 'bilibili_info.html')
    const before = ctx.shotkit?.captures ?? 0
    const mark = events.length
    const { render: karinRender } = require(path.join(pluginRoot, 'lib/compat/node-karin.js'))
    const base64 = await karinRender.render({ file: htmlPath, selector: '#container' })
    const compatEvents = events.slice(mark)
    check('render.render 走了浏览器', compatEvents.some((e) => e.name === 'chrome:screenshot') && base64.length > 50,
      compatEvents.map((e) => e.name).join(',') + ' → ' + base64.length + ' chars')
    check('render.render 也没碰内核', (ctx.shotkit?.captures ?? 0) - before === 0, ((ctx.shotkit?.captures ?? 0) - before) + ' 次')
    check('没有并发渲染', !overlaps(events))
    await ctx.stop()
  }

  console.log('')
  console.log('[3] 没有浏览器服务：渲染失败，不拿内核兜底，报错能照做')
  {
    const events = []
    const ctx = await boot({ withPuppeteer: false, events })
    const before = ctx.shotkit?.captures ?? 0
    const { Render } = require(path.join(pluginRoot, 'lib/karin/module/utils/Render/index.js'))
    let result = null
    const logs = await captureLogs(async () => { result = await Render({}, 'bilibili/info', CARD) })
    const image = Array.isArray(result) ? result.find((el) => el && (el.type === 'img' || el.type === 'image')) : null
    check('没有渲染出图片（返回空数组）', Array.isArray(result) && !image, JSON.stringify(result).slice(0, 80))
    check('内核没有被拿来兜底', (ctx.shotkit?.captures ?? 0) - before === 0, ((ctx.shotkit?.captures ?? 0) - before) + ' 次')
    check('日志说清楚了要装什么', logs.some((line) => /需要安装浏览器渲染服务/.test(line)),
      (logs.find((line) => /渲染失败/.test(line)) || '（没找到渲染失败日志）').slice(0, 160))
    await ctx.stop()
  }

  console.log('')
  console.log('=== ' + (failures ? '失败 ' + failures + ' 项' : '全部通过') + ' ===')
  process.exit(failures ? 1 : 0)
})().catch((error) => {
  console.error('冒烟测试失败:', error && error.stack ? error.stack : error)
  process.exit(1)
})
