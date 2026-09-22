/**
 * 冒烟测试：shotkit 注册成 puppeteer 服务时，那条**老写法**能不能跑通。
 *
 * 真实消费者是 karin 兼容层的 render.render（弹幕条这类走它），它的写法是：
 *   page.setViewport → page.goto → page.$('#container') → handle.boundingBox()
 *   → page.screenshot({ clip: box, omitBackground, type })
 *
 * 以前卡在 boundingBox()（内核不报元素坐标，直接抛 NotSupportedError）。
 * 现在内核改成「渲染该元素来量」：图片尺寸 ÷ 缩放 = 元素盒子的宽高，
 * 并且当随后的 clip 与量出来的盒子一致时按元素截取。
 *
 * 用法：node scripts/smoke-shotkit-compat.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const pluginRoot = path.resolve(__dirname, '..')
const { Context } = require('koishi')

let failures = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? ' | ' + extra : ''))
  if (!ok) failures++
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const pngSize = (buffer) => ({ width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) })

const DATA_ROOT = path.join(pluginRoot, 'data-smoke-render-path')
const HTML = path.join(DATA_ROOT, 'html', 'koishi-plugin-kkk', 'bilibili_info.html')

;(async () => {
  const kkk = require(path.join(pluginRoot, 'lib/index.js'))
  const shotkit = require('koishi-plugin-shotkit')

  const ctx = new Context()
  ctx.plugin(kkk, { dataPath: DATA_ROOT, debug: true })
  ctx.plugin(shotkit, { providePuppeteer: true })
  await ctx.start()
  await sleep(400)

  check('ctx.puppeteer 由 shotkit 提供', !!ctx.puppeteer && ctx.puppeteer.name === 'puppeteer', String(ctx.puppeteer && ctx.puppeteer.name))
  check('测试用的卡片 HTML 存在', fs.existsSync(HTML), HTML)
  if (!fs.existsSync(HTML)) process.exit(1)

  console.log('')
  console.log('[1] page.$ → boundingBox → screenshot({ clip })')
  {
    const page = await ctx.puppeteer.page()
    await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 2 })
    await page.goto('file:///' + HTML.replace(/\\/g, '/'))
    const handle = await page.$('#container')
    const box = await handle.boundingBox()
    check('boundingBox 不再抛错', !!box && box.width > 0 && box.height > 0, JSON.stringify(box))
    check('宽高是 CSS 像素（不是设备像素）', box.width > 300 && box.height > 200 && box.width < 2000, box.width + 'x' + box.height)
    const buffer = await page.screenshot({ clip: box, omitBackground: true, type: 'png' })
    const size = pngSize(buffer)
    check('screenshot({ clip }) 返回了真 PNG', buffer.length > 1000 && size.width > 0, buffer.length + ' bytes')
    check('截图尺寸 = 盒子 × 缩放', size.width === box.width * 2 && size.height === box.height * 2,
      '截图 ' + size.width + 'x' + size.height + ' vs 盒子 ' + box.width + 'x' + box.height + ' ×2')
    await page.close()
  }

  console.log('')
  console.log('[2] 对不上的 clip 仍然要拒绝')
  {
    const page = await ctx.puppeteer.page()
    await page.setContent('<div id="c" style="width:300px;padding:20px">hello</div>')
    let message = ''
    try {
      await page.screenshot({ clip: { x: 0, y: 0, width: 10, height: 10 }, selector: '#c' })
    } catch (error) {
      message = String(error && error.message)
    }
    check('抛错并说明原因', /cannot crop to an arbitrary rectangle/.test(message), message.slice(0, 90))
    await page.close()
  }

  console.log('')
  console.log('[3] karin 兼容层的 render.render 直接跑')
  {
    const before = ctx.shotkit.captures
    const { render } = require(path.join(pluginRoot, 'lib/compat/node-karin.js'))
    const base64 = await render.render({ file: HTML, selector: '#container' })
    const buffer = Buffer.from(base64, 'base64')
    const isPng = buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47
    check('render.render 返回了 base64 PNG', isPng, base64.length + ' chars')
    check('走的是 shotkit 内核', ctx.shotkit.captures - before > 0, (ctx.shotkit.captures - before) + ' 次渲染')
    if (isPng) {
      const size = pngSize(buffer)
      check('出的是真卡片尺寸', size.width > 300 && size.height > 200, size.width + 'x' + size.height)
      fs.writeFileSync(path.join(DATA_ROOT, 'compat-render.png'), buffer)
    }
  }

  await ctx.stop()
  console.log('')
  console.log(failures ? '失败 ' + failures + ' 项' : '全部通过')
  process.exit(failures ? 1 : 0)
})().catch((error) => {
  console.error('冒烟测试失败:', error && error.stack ? error.stack : error)
  process.exit(1)
})
