/**
 * 探针：评论/笔记二维码补作者头像（上游 677e213 的移植验证）
 *
 * 要验证的事：
 *   1. 三张评论卡（B站/快手/小红书）的二维码用的是 QRCodeWithAvatar，不再是光秃秃的 generateQRCode；
 *   2. `AuthorAvatar` 从平台层一路传到模板，最终反映在渲染出的 HTML 上
 *      —— 带头像与不带头像得到的 `<img src>` 必须不同（否则就是「传了但没用上」）；
 *   3. 小红书 noteInfo 的二维码也吃到了 `data.author.avatar`；
 *   4. 深色模式参数还在（没在换组件时丢掉 useDarkTheme 的传递）。
 *
 * SSR 走导出的 `renderTemplateHtml`（纯服务端渲染，不需要浏览器）。
 * 用法：node scripts/probe-qrcode-avatar.cjs
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

const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const main = async () => {
  const { bindRuntime } = require(path.join(LIB, 'compat/runtime.js'))
  const dataRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kkk-qr-')), 'data')
  bindRuntime({
    ctx: { config: { port: 5200 } },
    config: { app: {}, errorNoCard: true },
    pluginRoot: ROOT,
    dataRoot
  })
  require(path.join(LIB, 'compat/logger.js')).setLogger({ debug () {}, info () {}, warn () {}, error () {} })

  const render = require(path.join(LIB, 'karin/module/utils/Render/index.js'))

  // ---------------- 1. 源码守卫：三张卡都换成了 QRCodeWithAvatar ----------------
  console.log('\n[1] 三张评论卡都改用 QRCodeWithAvatar')
  const cards = [
    ['bilibili/comment/components/Comment.tsx', 'B站评论卡'],
    ['kuaishou/comment/components/Comment.tsx', '快手评论卡'],
    ['xiaohongshu/comment/components/Comment.tsx', '小红书评论卡']
  ]
  for (const [p, label] of cards) {
    const s = src('src/ktr/template/' + p)
    ok(label + ' 引入了 QRCodeWithAvatar', /import\s*\{\s*QRCodeWithAvatar\s*\}/.test(s))
    ok(label + ' 不再直接用 generateQRCode', !/generateQRCode\(/.test(s))
    ok(label + ' 把 avatarUrl 传下去了', /avatarUrl=/.test(s))
    ok(label + ' 仍传 useDarkTheme', /useDarkTheme=\{/.test(s))
  }

  // ---------------- 2. 三个平台层都传了 AuthorAvatar ----------------
  console.log('\n[2] 平台层把作者头像传进模板')
  const bili = src('src/karin/platform/bilibili/bilibili.ts')
  ok('B站视频评论卡传了 owner.face', /AuthorAvatar:\s*infoData\.data\.data\.owner\?\.face/.test(bili))
  ok('B站动态评论卡传了 module_author.face', /AuthorAvatar:\s*dynamicInfo\.data\.data\.item\.modules\?\.module_author\?\.face/.test(bili))

  const ks = src('src/karin/platform/kuaishou/kuaishou.ts')
  ok('快手评论卡传了 photo.headUrl', /AuthorAvatar:\s*work\.photo\.headUrl/.test(ks))

  const xhs = src('src/karin/platform/xiaohongshu/xiaohongshu.ts')
  const xhsHits = (xhs.match(/AuthorAvatar:\s*noteCard\.user\?\.avatar/g) || []).length
  ok('小红书两处评论卡渲染都传了 user.avatar', xhsHits === 2, xhsHits)
  ok('小红书 noteInfo 传了 author.avatar',
    /QRCodeWithAvatar[\s\S]{0,160}avatarUrl=\{data\.author\.avatar\}/.test(src('src/ktr/template/xiaohongshu/noteInfo/components/noteInfo.tsx')))

  // ---------------- 3. SSR：头像真的反映到 HTML 上 ----------------
  console.log('\n[3] SSR 对照：传头像 vs 不传，二维码必须不一样')
  /**
   * 注意：`loadQRCodeAvatar` 只认 `http(s)://` 开头的地址（data: URI 会被直接拒掉），
   * 所以这里起一个临时 http 服务，真发一张 PNG 出去，才能走到「下载头像 → 塞进二维码」这条路。
   * 而且 PNG 必须是合法的 —— 手写个坏 CRC 的 base64 会让二维码解码阶段抛
   * `Logo image decode error`，整个 SSR 直接回退成 null（这个坑踩过了）。
   */
  const http = require('node:http')
  const PNG = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/avatar-probe.png'))
  let avatarHits = 0
  const server = http.createServer((req, res) => {
    avatarHits++
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length })
    res.end(PNG)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const AVATAR = `http://127.0.0.1:${server.address().port}/avatar.png`

  const baseComment = {
    Type: '视频',
    CommentsData: [],
    CommentLength: 1,
    share_url: 'https://b23.tv/BV1test',
    Resolution: null,
    ErrorText: ''
  }

  let withAvatar, withoutAvatar
  try {
    withAvatar = await render.renderTemplateHtml('bilibili/comment', { ...baseComment, AuthorAvatar: AVATAR }, false)
    withoutAvatar = await render.renderTemplateHtml('bilibili/comment', { ...baseComment }, false)
  } finally {
    server.close()
  }

  ok('临时的头像服务被请求到了（说明走的是下载头像那条路）', avatarHits > 0, avatarHits)
  ok('两次 SSR 都成功了', typeof withAvatar === 'string' && typeof withoutAvatar === 'string')
  ok('两次产出的 HTML 长度不同（头像进了二维码数据）',
    withAvatar.length !== withoutAvatar.length,
    { withAvatar: withAvatar.length, withoutAvatar: withoutAvatar.length })

  // 二维码是内联 data URI，把两个 <img src> 抠出来比
  const grabQr = (html) => {
    const m = html.match(/<img[^>]+alt="二维码"[^>]*>/)
    return m ? m[0] : ''
  }
  const qrWith = grabQr(withAvatar)
  const qrWithout = grabQr(withoutAvatar)
  ok('两侧都渲染出了 alt="二维码" 的 img', !!qrWith && !!qrWithout,
    { qrWith: qrWith.slice(0, 60), qrWithout: qrWithout.slice(0, 60) })
  ok('★ 带头像的二维码 img 与不带的不同（说明头像真的用上了）',
    qrWith !== qrWithout,
    { lenWith: qrWith.length, lenWithout: qrWithout.length })

  // ---------------- 4. 不传头像时不能炸 ----------------
  console.log('\n[4] 边界：不给头像也要能渲染')
  for (const route of ['bilibili/comment', 'kuaishou/comment', 'xiaohongshu/comment']) {
    const data = route === 'kuaishou/comment'
      ? { Type: '视频', CommentsData: [], CommentLength: 0, share_url: 'https://v.kuaishou.com/x', CommentLength2: 0 }
      : route === 'xiaohongshu/comment'
        ? { Type: '图文', CommentsData: [], CommentLength: 0, share_url: 'https://xhslink.com/x' }
        : baseComment
    try {
      const html = await render.renderTemplateHtml(route, data, false)
      ok(route + ' 无头像也能渲染', typeof html === 'string' && html.length > 0)
    } catch (e) {
      ok(route + ' 无头像也能渲染', false, String(e && e.message))
    }
  }

  console.log(failed === 0 ? '\n✔ 全部通过' : `\n✘ 有 ${failed} 项没通过`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
