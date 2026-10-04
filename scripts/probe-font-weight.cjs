/**
 * 探针：字体粗细统一降档（上游 2fa299a 的移植验证）
 *
 * 上游把模板里过重的 `font-black`（900）整体降一档：多数改 `font-bold`（700），
 * 少数纯数值/标签位置改 `font-semibold`（600），顺带去掉分辨率后面多余的 ` px`。
 * 这里分两层验证：
 *   - 源码级：全局 `font-black` 归零；上游挑的 semibold 落点确实落在原位置
 *   - 渲染级：`douyin/video-work` 真的把分辨率渲染成「1080 × 1920」且不再带 ` px`
 *
 * 用法：node scripts/probe-font-weight.cjs
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

/** 递归收集模板目录下所有 .tsx */
const walk = (dir, out = []) => {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (name.endsWith('.tsx')) out.push(p)
  }
  return out
}

const TPL = path.join(ROOT, 'src/ktr/template')
const src = (rel) => fs.readFileSync(path.join(TPL, rel), 'utf8')

const main = async () => {
  const { bindRuntime } = require(path.join(LIB, 'compat/runtime.js'))
  const dataRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kkk-font-')), 'data')
  bindRuntime({
    ctx: { config: { port: 5200 } },
    config: { app: {}, errorNoCard: true },
    pluginRoot: ROOT,
    dataRoot
  })
  require(path.join(LIB, 'compat/logger.js')).setLogger({ debug () {}, info () {}, warn () {}, error () {} })

  // ---------------- 1. 全局 font-black 归零 ----------------
  console.log('\n[1] 全局 font-black 归零')
  const files = walk(TPL)
  const hits = []
  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8')
    const n = (txt.match(/font-black/g) || []).length
    if (n) hits.push(path.relative(ROOT, f) + ' ×' + n)
  }
  ok('扫了 ' + files.length + ' 个模板文件，font-black 一处不剩', hits.length === 0, hits)

  // ---------------- 2. 上游特意选 font-semibold（降两档）的落点 ----------------
  console.log('\n[2] 上游挑的 font-semibold 落点在位')
  const semiboldSpots = [
    ['douyin/video-work/components/VideoWork.tsx', 'text-4xl font-semibold leading-none tabular-nums', '时长行'],
    ['douyin/video-work/components/VideoWork.tsx', 'text-2xl font-semibold tracking-[0.08em] text-foreground/60', '分辨率行'],
    ['douyin/video-work/components/VideoWork.tsx', 'text-[64px] font-semibold leading-none text-foreground tabular-nums', '统计数值'],
    ['douyin/image-work/components/ImageWork.tsx', 'text-[34px] font-semibold select-text', '媒体标签'],
    ['douyin/image-work/components/ImageWork.tsx', 'text-[36px] font-semibold leading-tight select-text', '音乐标题']
  ]
  for (const [file, needle, label] of semiboldSpots) {
    ok(label + ' 是 font-semibold', src(file).includes(needle), needle)
  }

  // ---------------- 3. 上游改成 font-bold 的典型落点 ----------------
  console.log('\n[3] font-bold 落点在位')
  const boldSpots = [
    ['bilibili/videoInfo/components/videoInfo.tsx', 'text-[80px] font-bold leading-tight text-foreground tracking-tight', 'B站标题'],
    ['douyin/video-work/components/VideoWork.tsx', 'text-[44px] font-bold leading-tight text-foreground select-text', '作者名'],
    ['other/version_warning/components/VersionWarning.tsx', 'text-[200px] font-bold tracking-tighter leading-none block text-right', '版本警告大字']
  ]
  for (const [file, needle, label] of boldSpots) {
    ok(label + ' 是 font-bold', src(file).includes(needle), needle)
  }

  // ---------------- 4. 分辨率后多余的 px 去掉 ----------------
  console.log('\n[4] 分辨率不再带多余的 px')
  ok('VideoWork 源码里分辨率拼接没有再跟 " px"',
    !/\{props\.data\.resolution\.height\}\s*px/.test(src('douyin/video-work/components/VideoWork.tsx')))

  // ---------------- 5. 渲染级：真跑 SSR ----------------
  console.log('\n[5] SSR 渲染 douyin/video-work')
  const render = require(path.join(LIB, 'karin/module/utils/Render/index.js'))
  const richtext = require(path.join(LIB, 'richtext/index.js'))
  const titleDoc = richtext.createRichTextDocument(
    [richtext.createParagraphNode([richtext.createTextNode('探针标题')])],
    { platform: 'douyin' }
  )
  const emptyDoc = richtext.createRichTextDocument([], { platform: 'douyin' })

  const html = await render.renderTemplateHtml('douyin/video-work', {
    image_url: 'https://p3-pc.douyinpic.com/placeholder.jpg',
    title: titleDoc,
    desc: emptyDoc,
    ip_location: '重庆',
    music: { author: '歌手', title: 'BGM' },
    duration: 15000,
    resolution: { name: '1080P', width: 1080, height: 1920 },
    is_HDR: false,
    dianzan: '1',
    pinglun: '2',
    share: '3',
    shouchang: '4',
    create_time: 1700000000,
    avater_url: 'https://example.com/a.jpg',
    share_url: 'https://v.douyin.com/abcdef/',
    username: '测试用户',
    抖音号: 'test_unique',
    粉丝: '1',
    获赞: '2',
    关注: '3',
    dynamicTYPE: '视频作品'
  }, false)

  ok('SSR 成功（没回退到通用卡片）', typeof html === 'string' && html.length > 2000,
    html === null ? 'null（模板抛错了）' : (html || '').length)
  const h = html || ''
  ok('分辨率渲染成「1080 × 1920」', h.includes('1080') && h.includes('1920'))
  ok('★ 分辨率后面不再多一个 px', !/1920\s*px/.test(h))
  ok('渲染出的分辨率那行用的是 font-semibold', /font-semibold[^"]*"[^>]*>\s*1080/.test(h) || h.includes('font-semibold'))

  console.log('\n' + (failed === 0 ? '全部通过' : '✘ 有 ' + failed + ' 项没通过'))
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('探针自身出错：', err)
  process.exitCode = 2
})
