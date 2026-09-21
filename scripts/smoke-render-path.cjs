/**
 * 冒烟测试：kkk 的渲染优先级。
 *
 *   用例 1：有浏览器渲染服务（puppeteer）时 → 走浏览器，shotkit 一次都不该被调用
 *   用例 2：没有浏览器服务、只有 shotkit 时 → 退回内核，并且出的是真卡片
 *
 * 两个入口都覆盖：卡片主渲染 Render() 和 karin 兼容层的 render.render()。
 *
 * 用法：node scripts/smoke-render-path.cjs
 */
const path = require('node:path')

const pluginRoot = path.resolve(__dirname, '..')
const { Context } = require('koishi')

let failures = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? 'OK  ' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : ''))
  if (!ok) failures++
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 一张 1x1 PNG，用来冒充浏览器截图结果 */
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/** 假浏览器服务：只实现 kkk 那条路径会用到的方法 */
function fakePuppeteer (calls) {
  const handle = { boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }) }
  const page = {
    setViewport: async (v) => calls.push('setViewport'),
    goto: async (url, opts) => calls.push('goto:' + String(url).split(/[\\/]/).pop()),
    evaluate: async () => ({ width: 720, height: 480 }),
    $: async () => handle,
    screenshot: async () => { calls.push('screenshot'); return TINY_PNG },
    close: async () => calls.push('close')
  }
  return { name: 'puppeteer', page: async () => { calls.push('page'); return page }, browser: { newPage: async () => page } }
}

;(async () => {
  const kkk = require(path.join(pluginRoot, 'lib/index.js'))
  const shotkit = require('koishi-plugin-shotkit')

  console.log('')
  console.log('[1] 有 puppeteer 服务 → 走浏览器')
  {
    const calls = []
    const ctx = new Context()
    ctx.plugin(kkk, { dataPath: path.join(pluginRoot, 'data-smoke-render-path'), debug: true })
    ctx.plugin(shotkit, {})
    ctx.set('puppeteer', fakePuppeteer(calls))
    await ctx.start()
    await sleep(500)

    const before = ctx.shotkit.captures
    const { Render } = require(path.join(pluginRoot, 'lib/karin/module/utils/Render/index.js'))
    const result = await Render({}, 'bilibili/info', { title: '优先级冒烟', author: 'smoke', desc: '', cover: '' })
    const image = Array.isArray(result) ? result.find((el) => el && (el.type === 'img' || el.type === 'image')) : null

    check('渲染出了图片元素', !!image)
    check('浏览器被用上了', calls.includes('page') && calls.includes('screenshot'), calls.join(','))
    check('shotkit 一次都没被调用', ctx.shotkit.captures - before === 0, (ctx.shotkit.captures - before) + ' 次')

    // karin 兼容层同样应该优先浏览器（同一个假服务只能注册一次，用调用次数切片）
    const htmlPath = path.join(pluginRoot, 'data-smoke-render-path', 'html', 'koishi-plugin-kkk', 'bilibili_info.html')
    const before2 = ctx.shotkit.captures
    const mark = calls.length
    const { render: karinRender } = require(path.join(pluginRoot, 'lib/compat/node-karin.js'))
    const base64 = await karinRender.render({ file: htmlPath, selector: '#container' })
    const compatCalls = calls.slice(mark)
    check('render.render 也走了浏览器', compatCalls.includes('screenshot') && base64.length > 50, compatCalls.join(',') + ' → ' + base64.length + ' chars')
    check('render.render 没碰 shotkit', ctx.shotkit.captures - before2 === 0, (ctx.shotkit.captures - before2) + ' 次')

    await ctx.stop()
  }

  console.log('')
  console.log('[2] 只有 shotkit → 退回内核')
  {
    const ctx = new Context()
    ctx.plugin(kkk, { dataPath: path.join(pluginRoot, 'data-smoke-render-path'), debug: true })
    ctx.plugin(shotkit, {})
    await ctx.start()
    await sleep(500)

    const before = ctx.shotkit.captures
    const { Render } = require(path.join(pluginRoot, 'lib/karin/module/utils/Render/index.js'))
    const result = await Render({}, 'bilibili/info', { title: '只有内核时', author: 'smoke', desc: '', cover: '' })
    const image = Array.isArray(result) ? result.find((el) => el && (el.type === 'img' || el.type === 'image')) : null
    const src = (image && image.attrs && image.attrs.src) || ''
    const buffer = Buffer.from(src.includes(',') ? src.slice(src.indexOf(',') + 1) : '', 'base64')
    const isPng = buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47
    check('shotkit 被调用了一次', ctx.shotkit.captures - before === 1, (ctx.shotkit.captures - before) + ' 次')
    check('出的是真卡片而不是占位图', isPng && buffer.readUInt32BE(16) > 100, isPng ? buffer.readUInt32BE(16) + 'x' + buffer.readUInt32BE(20) : 'not png')
    await ctx.stop()
  }

  console.log('')
  console.log('=== ' + (failures ? '失败 ' + failures + ' 项' : '全部通过') + ' ===')
  process.exit(failures ? 1 : 0)
})().catch((error) => {
  console.error('冒烟测试失败:', error && error.stack ? error.stack : error)
  process.exit(1)
})
