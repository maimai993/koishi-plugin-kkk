/**
 * 探针：实况照片提示卡重写（上游 ee22474 的移植验证）
 *
 * 上游把 LivePhotoTip 整个重写了：从「品牌状态清单（verified / theoretical / unsupported 三档带角标）」
 * 改成「品牌 Logo 墙 + 整行正文说明」，并去掉了卡片自带的 KkkLogo / GlowImage 页脚。
 * 本探针只做离线 SSR 断言，不需要浏览器。
 *
 * 用法：node scripts/probe-live-photo-tip.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const LIB = process.env.KKK_LIB ? path.resolve(process.env.KKK_LIB) : path.join(ROOT, 'lib')

let failed = 0
const ok = (label, cond, extra) => {
  if (cond) {
    console.log('  ✓ ' + label)
  } else {
    failed++
    console.log('  ✗ ' + label + (extra === undefined ? '' : ' → ' + JSON.stringify(extra)))
  }
}

const REL = 'src/ktr/template/other/live-photo-tip/components/LivePhotoTip.tsx'
const ROUTE = 'other/live-photo-tip'

const main = async () => {
  const { bindRuntime } = require(path.join(LIB, 'compat/runtime.js'))
  const dataRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kkk-lpt-')), 'data')
  bindRuntime({
    ctx: { config: { port: 5200 } },
    config: { app: {}, errorNoCard: true },
    pluginRoot: ROOT,
    dataRoot
  })
  require(path.join(LIB, 'compat/logger.js')).setLogger({ debug () {}, info () {}, warn () {}, error () {} })

  const render = require(path.join(LIB, 'karin/module/utils/Render/index.js'))

  // ---------------- 1. 源码守卫：新结构到位、老结构清干净 ----------------
  console.log('\n[1] 源码守卫')
  const s = fs.readFileSync(path.join(ROOT, REL), 'utf8')
  ok('引入了 BrandTile（Logo 墙容器）', /function BrandTile\b/.test(s))
  ok('内置了 Google Photos / 小米 / 荣耀 三个自有 SVG 图标',
    /const GooglePhotosIcon\b/.test(s) && /const XiaomiIcon\b/.test(s) && /const HonorIcon\b/.test(s))
  ok('正文里有「支持实况照片」整行说明', /支持实况照片/.test(s))
  ok('正文里有「华为、荣耀为理论支持，尚未实测」', /华为、荣耀为理论支持，尚未实测/.test(s))
  ok('正文里有「暂不支持」分组', /暂不支持/.test(s))
  ok('去掉了旧的品牌状态角标配置 statusConfig', !/const statusConfig\b/.test(s))
  ok('去掉了卡片自带的 KkkLogo', !/const KkkLogo\b/.test(s))
  ok('去掉了卡片自带的 GlowImage 页脚', !/GlowImage/.test(s))
  ok('没有残留 karin 品牌串', !/karin-plugin-kkk|KARIN-PLUGIN/i.test(s))
  ok('不再从 lucide 引 ArrowDownToLine/Info 等旧图标', !/ArrowDownToLine/.test(s))

  // ---------------- 2. SSR：自定义文案 ----------------
  console.log('\n[2] SSR（传自定义文案）')
  const html = await render.renderTemplateHtml(ROUTE, { title: '我的实况图标题', description: '我的实况图说明' }, false)
  ok('SSR 成功返回 HTML', typeof html === 'string' && html.length > 2000, html === null ? 'null' : (html || '').length)
  const h = html || ''
  ok('标题进了 HTML', h.includes('我的实况图标题'))
  ok('说明进了 HTML', h.includes('我的实况图说明'))
  ok('品牌墙文案在', h.includes('支持实况照片'))
  ok('兼容性说明在', h.includes('华为、荣耀为理论支持，尚未实测'))

  // ---------------- 3. SSR：不传文案走默认值 ----------------
  console.log('\n[3] SSR（不传文案，走默认）')
  const def = await render.renderTemplateHtml(ROUTE, {}, false)
  const d = def || ''
  ok('默认标题「实况照片已生成」出现', d.includes('实况照片已生成'))
  ok('默认说明「保存原图到相册即可识别为实况图」出现', d.includes('保存原图到相册即可识别为实况图'))

  // ---------------- 4. 深色模式确实生效 ----------------
  console.log('\n[4] 深色模式')
  const dark = await render.renderTemplateHtml(ROUTE, {}, true)
  ok('深色与浅色产出的 HTML 不同', typeof dark === 'string' && dark !== def,
    { dark: (dark || '').length, light: (def || '').length })

  // ---------------- 5. 仍然复用本地页脚（署名是我们的） ----------------
  console.log('\n[5] 仍然复用本地 DefaultLayout 页脚')
  ok('页脚里有本地的 maimai 署名', d.includes('maimai'), '（页脚被换掉就会丢）')
  ok('页脚里有 Power By 段', d.includes('Power By'))
  ok('页脚里没有 ikenxuan 署名（上游那部分是给他自己加的）', !d.includes('ikenxuan'))

  console.log('\n' + (failed === 0 ? '全部通过' : '✘ 有 ' + failed + ' 项没通过'))
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('探针自身出错：', err)
  process.exitCode = 2
})
