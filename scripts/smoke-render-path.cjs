/**
 * 冒烟测试：kkk 的渲染优先级开关（面板「通用设置 → 优先渲染器」，配置项 app.renderer）。
 *
 *   用例 1：renderer = shotkit（默认）+ 两个服务都在 → 用内核，浏览器一次都不碰
 *   用例 2：renderer = puppeteer + 两个服务都在 → 用浏览器，内核一次都不碰
 *   用例 3：renderer = puppeteer + 只有内核 → 自动落到内核
 *
 * 两个入口都覆盖：卡片主渲染 Render() 和 karin 兼容层的 render.render()。
 * 另外全程记录两边渲染的起止时间，断言**两个引擎没有同时渲染**。
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
const CONFIG_DIR = path.join(DATA_ROOT, 'koishi-plugin-kkk', 'config')

/** 把「优先渲染器」写进本插件的 config.json（Config 每次访问都重新读盘，改完立刻生效） */
function setRenderer (value) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  const file = path.join(CONFIG_DIR, 'config.json')
  let config = {}
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* 第一次跑，还没有文件 */ }
  config.app = { ...(config.app || {}), renderer: value }
  fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8')
}

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

/** 建一个上下文：可选挂假浏览器服务，并给内核的 renderFile 打点 */
async function boot ({ withPuppeteer, events }) {
  const kkk = require(path.join(pluginRoot, 'lib/index.js'))
  const shotkit = require('koishi-plugin-shotkit')
  const ctx = new Context()
  ctx.plugin(kkk, { dataPath: DATA_ROOT, debug: true })
  ctx.plugin(shotkit, {})
  if (withPuppeteer) ctx.set('puppeteer', fakePuppeteer(events))
  await ctx.start()
  await sleep(400)
  const service = ctx.get('shotkit')
  const original = service.renderFile.bind(service)
  service.renderFile = record(events, 'shotkit:renderFile', original)
  return ctx
}

/** 两个引擎的渲染区间不能交叠（串行是硬性要求） */
function overlaps (events) {
  const spans = events.filter((e) => e.end && /^(chrome:screenshot|shotkit:renderFile)$/.test(e.name))
    .sort((a, b) => a.start - b.start)
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < spans[i - 1].end) return spans[i - 1].name + ' 与 ' + spans[i].name + ' 重叠'
  }
  return null
}

const CARD = { title: '优先级冒烟', author: 'smoke', desc: '', cover: '' }

;(async () => {
  console.log('')
  console.log('[1] renderer = shotkit（默认）：用内核')
  {
    setRenderer('shotkit')
    const events = []
    const ctx = await boot({ withPuppeteer: true, events })
    const before = ctx.shotkit.captures
    const { Render } = require(path.join(pluginRoot, 'lib/karin/module/utils/Render/index.js'))
    const result = await Render({}, 'bilibili/info', CARD)
    const image = Array.isArray(result) ? result.find((el) => el && (el.type === 'img' || el.type === 'image')) : null
    check('渲染出了图片元素', !!image)
    check('走了内核', ctx.shotkit.captures - before === 1, (ctx.shotkit.captures - before) + ' 次')
    check('浏览器一次都没碰', !events.some((e) => e.name === 'chrome:screenshot'), events.map((e) => e.name).join(',') || '无')
    check('没有并发渲染', !overlaps(events))
    await ctx.stop()
  }

  console.log('')
  console.log('[2] renderer = puppeteer：用浏览器')
  {
    setRenderer('puppeteer')
    const events = []
    const ctx = await boot({ withPuppeteer: true, events })
    const before = ctx.shotkit.captures
    const { Render } = require(path.join(pluginRoot, 'lib/karin/module/utils/Render/index.js'))
    const result = await Render({}, 'bilibili/info', CARD)
    const image = Array.isArray(result) ? result.find((el) => el && (el.type === 'img' || el.type === 'image')) : null
    check('渲染出了图片元素', !!image)
    check('浏览器被用上了', events.some((e) => e.name === 'chrome:screenshot'), events.map((e) => e.name).join(','))
    check('内核一次都没碰', ctx.shotkit.captures - before === 0, (ctx.shotkit.captures - before) + ' 次')

    // karin 兼容层要跟着同一个开关走
    const htmlPath = path.join(DATA_ROOT, 'html', 'koishi-plugin-kkk', 'bilibili_info.html')
    const mark = events.length
    const { render: karinRender } = require(path.join(pluginRoot, 'lib/compat/node-karin.js'))
    const base64 = await karinRender.render({ file: htmlPath, selector: '#container' })
    const compatEvents = events.slice(mark)
    check('render.render 也走了浏览器', compatEvents.some((e) => e.name === 'chrome:screenshot') && base64.length > 50,
      compatEvents.map((e) => e.name).join(',') + ' → ' + base64.length + ' chars')
    check('没有并发渲染', !overlaps(events))
    await ctx.stop()
  }

  console.log('')
  console.log('[3] renderer = puppeteer，但没有浏览器服务：自动落到内核')
  {
    setRenderer('puppeteer')
    const events = []
    const ctx = await boot({ withPuppeteer: false, events })
    const before = ctx.shotkit.captures
    const { Render } = require(path.join(pluginRoot, 'lib/karin/module/utils/Render/index.js'))
    const result = await Render({}, 'bilibili/info', CARD)
    const image = Array.isArray(result) ? result.find((el) => el && (el.type === 'img' || el.type === 'image')) : null
    const src = (image && image.attrs && image.attrs.src) || ''
    const buffer = Buffer.from(src.includes(',') ? src.slice(src.indexOf(',') + 1) : '', 'base64')
    const isPng = buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47
    check('内核被调用了一次', ctx.shotkit.captures - before === 1, (ctx.shotkit.captures - before) + ' 次')
    check('出的是真卡片而不是占位图', isPng && buffer.readUInt32BE(16) > 100, isPng ? buffer.readUInt32BE(16) + 'x' + buffer.readUInt32BE(20) : 'not png')
    await ctx.stop()
  }

  setRenderer('shotkit')

  console.log('')
  console.log('=== ' + (failures ? '失败 ' + failures + ' 项' : '全部通过') + ' ===')
  process.exit(failures ? 1 : 0)
})().catch((error) => {
  console.error('冒烟测试失败:', error && error.stack ? error.stack : error)
  process.exit(1)
})
