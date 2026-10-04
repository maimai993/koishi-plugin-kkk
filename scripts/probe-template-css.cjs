/**
 * 探针：模板样式补齐（extra-utilities.css）是否还在位。
 *
 * ## 为什么要守这个
 *
 * `resources/template/style.css` 是 tailwind v4 的按需构建产物，只含「构建那一刻」扫描到的类。
 * 模板源码跟着上游更新后，新引入的类不会自动出现在产物里 —— 页面不报错，
 * 只是**静默丢样式**：掉内边距、掉间距、图标塌成 0 宽。
 * v3.12.1 的实况照片提示卡就是这么整张崩掉的（上游 ee22474 重写后引入 49 个新类，一个都没有）。
 *
 * 所以这里守三件事：
 *   1. 补齐文件还在，并且被 Render 真的加载进了渲染产物；
 *   2. 模板源码用到的类，在 style.css + extra-utilities.css 里都能找到规则（离线检查）；
 *   3. 上游产物里的关键规则内容对得上（抽出来的不是空壳）。
 *
 * 用法：node scripts/probe-template-css.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const LIB = process.env.KKK_LIB ? path.resolve(process.env.KKK_LIB) : path.join(ROOT, 'lib')
const EXTRA = path.join(ROOT, 'resources', 'template', 'extra-utilities.css')

let failed = 0
const ok = (label, cond, extra) => {
  if (cond) {
    console.log('  ✓ ' + label)
  } else {
    failed++
    console.log('  ✗ ' + label + (extra === undefined ? '' : ' → ' + JSON.stringify(extra)))
  }
}

/** 异步 spawn：这台机器上同步起子进程会被宿主掐掉（EBUSY） */
const run = (args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ code, out }))
  })

const main = async () => {
  // ---------------- 1. 补齐文件本身 ----------------
  console.log('\n[1] extra-utilities.css 在位')
  ok('文件存在', fs.existsSync(EXTRA))
  const extraCss = fs.existsSync(EXTRA) ? fs.readFileSync(EXTRA, 'utf8') : ''
  ok('文件非空', extraCss.length > 1000, extraCss.length)
  ok('带「自动生成」表头，提醒不要手改', extraCss.includes('请勿手改'))
  ok('规则包在 @layer utilities 里（跟原产物同层）', extraCss.includes('@layer utilities'))

  // ---------------- 2. 离线覆盖检查：模板用到的类都有规则吗 ----------------
  console.log('\n[2] 覆盖检查（离线，与同步脚本同一套判定）')
  const check = await run([path.join('scripts', 'sync-template-css.mjs'), '--check'])
  const lastLine = check.out.trim().split('\n').filter(Boolean).pop() || ''
  ok('sync-template-css --check 通过', check.code === 0, { code: check.code, tail: lastLine })
  if (check.code !== 0) console.log(check.out)

  // ---------------- 3. Render 真的把这个文件加载进去了 ----------------
  console.log('\n[3] 渲染产物里能看到补齐的规则')
  const { bindRuntime } = require(path.join(LIB, 'compat/runtime.js'))
  const dataRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kkk-tcss-')), 'data')
  bindRuntime({
    ctx: { config: { port: 5200 } },
    config: { app: {}, errorNoCard: true },
    pluginRoot: ROOT,
    dataRoot
  })
  require(path.join(LIB, 'compat/logger.js')).setLogger({ debug () {}, info () {}, warn () {}, error () {} })

  const render = require(path.join(LIB, 'karin/module/utils/Render/index.js'))
  const html = await render.renderTemplateHtml('other/live-photo-tip', {}, false)
  ok('SSR 成功', typeof html === 'string' && html.length > 2000, html === null ? 'null' : (html || '').length)
  const h = html || ''

  // 这些类正是实况照片提示卡崩掉时的缺失项，挑内边距 / 间距 / 尺寸 / 任意值四类各一个
  const mustHave = ['.px-27', '.pt-29', '.gap-5\\.5', '.w-39', '.h-39', '.h-4\\.5', '.text-\\[132px\\]', '.rounded-\\[46px\\]']
  for (const cls of mustHave) {
    ok('CSS 里有 ' + cls, h.includes(cls))
  }
  ok('补齐的 @theme 变量也进来了（--font-bilifont）', h.includes('--font-bilifont:'))

  // ---------------- 4. 抽出来的规则不是空壳 ----------------
  console.log('\n[4] 规则内容对得上')
  ok('.px-27 是 padding-inline + spacing 计算', /\.px-27\s*\{[^}]*padding-inline:\s*calc\(var\(--spacing\)\s*\*\s*27\)/.test(h))
  ok('.w-39 是 width + spacing 计算', /\.w-39\s*\{[^}]*width:\s*calc\(var\(--spacing\)\s*\*\s*39\)/.test(h))
  ok('.text-\\[132px\\] 用的是字面值', /font-size:\s*132px/.test(h))

  console.log('\n' + (failed === 0 ? '全部通过' : '✘ 有 ' + failed + ' 项没通过'))
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('探针自身出错：', err)
  process.exitCode = 2
})
