/**
 * 冒烟测试：kkk 的 Render 会**优先使用 kkkshot 服务**（装了 koishi-plugin-kkkshot 时），
 * 并且服务出错时会自动退回原来的 puppeteer 路径。
 *
 * 用法：node scripts/smoke-kkkshot-render.cjs
 */
const path = require('node:path')

const pluginRoot = path.resolve(__dirname, '..')
const { Context } = require('koishi')

let failures = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? ' | ' + extra : ''))
  if (!ok) failures++
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

;(async () => {
  const plugin = require(path.join(pluginRoot, 'lib/index.js'))
  const ctx = new Context()
  ctx.plugin(plugin, { dataPath: path.join(pluginRoot, 'data-smoke-kkkshot'), debug: true })

  /** 假 kkkshot：记录调用，返回一张 1x1 PNG */
  const calls = []
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  let mode = 'ok'
  ctx.set('kkkshot', {
    name: 'kkkshot',
    async renderFile (file, options) {
      calls.push({ file: String(file).split(/[\\/]/).pop(), options })
      if (mode === 'fail') throw new Error('假装渲染炸了')
      return png
    },
    async render () { return png },
    stats () { return { renders: calls.length } },
    async warmup () { return true },
  })
  await ctx.start()
  await sleep(8000)

  const { Render } = require(path.join(pluginRoot, 'lib/karin/module/utils/Render/index.js'))

  console.log('\n[1] 有 kkkshot 时优先用它')
  {
    const result = await Render({}, 'bilibili/info', {
      title: 'kkkshot 冒烟', author: 'smoke', cover: '', desc: '测试卡片', view: 1, like: 2, coin: 3, favorite: 4
    })
    // 兼容层的 segment.image 出来的是 Satori 的 img 元素
    check('渲染出了图片元素', Array.isArray(result) && result.some((el) => el && (el.type === 'img' || el.type === 'image')),
      Array.isArray(result) ? JSON.stringify(result).slice(0, 120) : String(result))
    check('kkkshot 被调用（而不是 puppeteer）', calls.length === 1, calls.length + ' 次')
    check('调用参数带上了 selector / 缩放 / 格式',
      calls[0]?.options?.selector === '#container' && Number(calls[0]?.options?.deviceScaleFactor) >= 2 && calls[0]?.options?.format === 'jpeg',
      JSON.stringify(calls[0]?.options ?? {}))
    check('渲染的是本地 HTML 文件', /\.html$/.test(calls[0]?.file ?? ''), calls[0]?.file)
  }

  console.log('\n[2] kkkshot 出错时自动退回 puppeteer 路径')
  {
    mode = 'fail'
    calls.length = 0
    const result = await Render({}, 'douyin/info', { title: '回退冒烟', author: 'smoke', desc: '', cover: '' })
    check('kkkshot 被调用过（说明优先走它）', calls.length === 1, calls.length + ' 次')
    const text = JSON.stringify(result)
    // 没有 puppeteer 服务时这条路会失败并返回空数组，但**不能**是因为 kkkshot 挂掉而崩
    check('没有把异常抛给调用方（返回数组）', Array.isArray(result), text.slice(0, 80))
  }

  await ctx.stop()
  console.log('\n=== ' + (failures ? '失败 ' + failures + ' 项' : '全部通过') + ' ===')
  process.exit(failures ? 1 : 0)
})().catch((error) => {
  console.error('冒烟测试失败:', error && error.stack ? error.stack : error)
  process.exit(1)
})
