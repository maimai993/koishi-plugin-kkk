/**
 * 探针：**评论 / 动态正文里的 Unicode emoji 走 Apple 图源渲染**。
 *
 * ## 为什么单开一个探针
 * 容器里没有系统 emoji 字体，纯字体渲染会把 🔥 之类显示成**方格**（用户看到的就是
 * 一个框）。上游的做法是把 emoji 序列切成独立的 `emoji` 节点、内联 Apple 64px PNG
 * 的 data: URL。这条链路三段都容易静默失效：
 *
 *   ① **清单过期** —— `emojiAssets.generated.ts` 是从 emoji-datasource-apple 包内
 *      `img/apple/64/` 生成的；升级数据版本后忘了跑 `gen:emoji`，清单里就会有一批
 *      文件名在包里根本不存在 → 那些 emoji 全部回退成文本（不报错，只是没图）；
 *   ② **解析器没注册** —— `emojiAssets.ts` 靠「被 Render 引入」这个副作用注册；
 *      一旦 Render 那条 import 被摇掉，整条链路退化（同样不报错）；
 *   ③ **退路失效** —— 包没装（可选依赖）时必须回退成文本，不能出死图。
 *
 * 所以这里把「清单 ↔ 包内文件」「分词 ↔ 图源」「SSR ↔ <img>」三处都钉住。
 *
 * ## 检查什么
 *   ① 清单与 `emoji-datasource-apple/img/apple/64/` 一一对应（包缺失时跳过）；
 *   ② `splitUnicodeEmoji`：👍 / 👍🏿 / 🇨🇳 / 9️⃣ / ❤️ / ⚠️ / 👨‍👩‍👧 → 正确文件名；
 *      裸 ❤ / ⚠（无 VS16）也要命中；™ © ® 保持文本；中英混排拼接无损；
 *   ③ 未注册解析器时全部回退为文本（浏览器端 ktr 面板就是这个形态）；
 *   ④ `createRichTextDocument`：emoji 节点带 data: URL 且 scale=0.8，平台表情节点不受影响；
 *   ⑤ 端到端 SSR：emoji 渲染成内联 `<img>`，普通文本不受影响。
 *
 * 用法：node scripts/probe-richtext-emoji.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const lib = path.join(root, 'lib')

const runtime = require(path.join(lib, 'compat/runtime.js'))
runtime.bindRuntime({
  ctx: { config: { port: 5200, prefix: '' } },
  config: { playerEnabled: true },
  dataRoot: fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kkk-probe-emoji-'))
})

require(path.join(lib, 'compat/logger.js')).setLogger({
  debug () {},
  info () {},
  mark () {},
  warn (message) { console.log('  [warn] ' + message) },
  error (message) { console.log('  [error] ' + message) }
})

let failed = 0
const check = (name, ok, detail) => {
  console.log((ok ? '  \u2714 ' : '  \u2718 ') + name + (detail ? '  \u2192 ' + detail : ''))
  if (!ok) failed++
}

console.log('\n[1] 图源清单 ↔ emoji-datasource-apple 包内文件')

const richtext = require(path.join(lib, 'richtext/index.js'))
const { APPLE_EMOJI_64_FILES } = richtext

let pkgDir = null
try {
  const { createRequire } = require('node:module')
  const req = createRequire(path.join(root, 'package.json'))
  pkgDir = path.join(path.dirname(req.resolve('emoji-datasource-apple/package.json')), 'img', 'apple', '64')
} catch {
  pkgDir = null
}

check('清单非空', APPLE_EMOJI_64_FILES instanceof Set && APPLE_EMOJI_64_FILES.size > 3000,
  APPLE_EMOJI_64_FILES ? `${APPLE_EMOJI_64_FILES.size} 个` : 'undefined')

if (pkgDir) {
  const actual = new Set(fs.readdirSync(pkgDir).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)))
  const missing = [...APPLE_EMOJI_64_FILES].filter((x) => !actual.has(x))
  const extra = [...actual].filter((x) => !APPLE_EMOJI_64_FILES.has(x))
  check('清单里的文件名在包内都存在（过期就说明要跑 gen:emoji）', missing.length === 0,
    missing.length === 0 ? `${APPLE_EMOJI_64_FILES.size} 个全部命中` : `缺 ${missing.length} 个：${missing.slice(0, 3)}`)
  check('包内文件都在清单里（升级数据版本后要重跑）', extra.length === 0,
    extra.length === 0 ? `包内 ${actual.size} 个` : `多 ${extra.length} 个：${extra.slice(0, 3)}`)
} else {
  console.log('  \u25cb 未安装 emoji-datasource-apple，跳过一一对应检查（可选依赖，运行时会回退文本）')
}

console.log('\n[2] 注册解析器前：应当全部回退为文本（浏览器端 ktr 面板的形态）')

const { splitUnicodeEmoji, setUnicodeEmojiSrcResolver, createTextNode, createEmojiNode, createRichTextDocument } = richtext

const before = splitUnicodeEmoji('好耶🔥')
check('未注册时整段就是一个文本段', before.length === 1 && before[0].kind === 'text', JSON.stringify(before))

console.log('\n[3] 注册真实解析器（node_modules → data: URL）')

require(path.join(lib, 'karin/module/utils/emojiAssets.js'))

const filenameOf = (text) => {
  const parts = splitUnicodeEmoji(text)
  return parts.length === 1 && parts[0].kind === 'emoji' ? parts[0].filename : null
}

const cases = [
  ['\u{1F44D}', '1f44d'],
  ['\u{1F44D}\u{1F3FF}', '1f44d-1f3ff'],
  ['\u{1F1E8}\u{1F1F3}', '1f1e8-1f1f3'],
  ['9\uFE0F\u20E3', '0039-fe0f-20e3'],
  ['\u2764\uFE0F', '2764-fe0f'],
  ['\u26A0\uFE0F', '26a0-fe0f'],
  ['\u2122\uFE0F', '2122-fe0f'],
  ['\u{1F468}‍\u{1F469}‍\u{1F467}', '1f468-200d-1f469-200d-1f467']
]
for (const [sequence, expected] of cases) {
  check(`${JSON.stringify(sequence)} → ${expected}`, filenameOf(sequence) === expected, String(filenameOf(sequence)))
}

console.log('\n[4] 裸序列（评论里大量无 VS16 的 ❤/⚠）也要命中图源')

for (const [sequence, expected] of [['\u2764', '2764-fe0f'], ['\u26A0', '26a0-fe0f']]) {
  check(`裸 ${JSON.stringify(sequence)} → ${expected}`, filenameOf(sequence) === expected, String(filenameOf(sequence)))
}

console.log('\n[5] 该保持文本的不能变成图')

for (const text of ['\u2122', '\u00A9', '\u00AE', '1f600', '\u2192']) {
  check(`${JSON.stringify(text)} 保持文本`, filenameOf(text) === null, String(filenameOf(text)))
}
const merged = splitUnicodeEmoji('xx\u2122yy')
check('回退文本与相邻文本合并，不产生碎片段', merged.length === 1 && merged[0].text === 'xx\u2122yy', JSON.stringify(merged))

console.log('\n[6] 中英混排切分无损')

const parts = splitUnicodeEmoji('中文\u{1F525}测试\u{1F44D}\u{1F3FF}end')
check('分段类型', parts.map((p) => p.kind).join(',') === 'text,emoji,text,emoji,text', parts.map((p) => p.kind).join(','))
check('拼接后与原文一致',
  parts.map((p) => (p.kind === 'text' ? p.text : p.sequence)).join('') === '中文\u{1F525}测试\u{1F44D}\u{1F3FF}end')

console.log('\n[7] createRichTextDocument：emoji 图片化，平台表情不受影响')

const doc = createRichTextDocument([createTextNode('好耶\u{1F525}')])
const emojiNode = doc.nodes.find((node) => node.type === 'emoji')
check('出现 emoji 节点', Boolean(emojiNode), emojiNode ? emojiNode.name : '无')
if (emojiNode) {
  check('src 是 data: URL（白名单内，三条加载路径都能用）', /^data:image\/png;base64,[a-z0-9+/=]+$/i.test(emojiNode.src || ''),
    (emojiNode.src || '').slice(0, 40) + '…')
  check('scale = 0.8（行内小图，不顶行高）', emojiNode.scale === 0.8, String(emojiNode.scale))
}

const platformDoc = createRichTextDocument([createEmojiNode('小黄脸', 'https://i0.hdslb.com/bfs/emote/emote.png')])
check('平台表情节点原样保留（不走 Apple 图源）',
  platformDoc.nodes.length === 1 && platformDoc.nodes[0].src === 'https://i0.hdslb.com/bfs/emote/emote.png')

console.log('\n[8] 端到端 SSR')

let html = ''
try {
  const { renderRichTextToReact } = require(path.join(lib, 'richtext/react/index.js'))
  const { renderToStaticMarkup } = require('react-dom/server')
  html = renderToStaticMarkup(renderRichTextToReact(createRichTextDocument([createTextNode('好耶\u{1F525}中文')]), {}))
} catch (error) {
  html = ''
  console.log('  \u25cb SSR 不可用，跳过：' + error.message)
}
if (html) {
  check('emoji 渲染为内联图', html.includes('src="data:image/png;base64,'))
  check('alt 是原 emoji', html.includes('alt="\u{1F525}"'))
  check('普通文本不受影响', html.includes('>中文</span>') && html.includes('>好耶</span>'))
}

console.log('\n[9] 静态闸门')

const renderSrc = fs.readFileSync(path.join(lib, 'karin/module/utils/Render/index.js'), 'utf8')
check('Render 引入了 emojiAssets（解析器靠这个副作用注册）', /emojiAssets/.test(renderSrc))

// 编译产物是 CJS：顶层 `const require = createRequire(...)` 会把 CJS 的全局 require
// 压进 TDZ，上面几行 require("node:fs") 直接炸，Node 还会把整个文件误判成 ESM
const shadowing = []
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full)
    } else if (entry.name.endsWith('.ts') && /^\s*(?:const|let|var)\s+require\s*=/m.test(fs.readFileSync(full, 'utf8'))) {
      shadowing.push(path.relative(root, full))
    }
  }
}
walk(path.join(root, 'src'))
check('源码里没有顶层 `require =` 遮蔽 CJS 全局 require', shadowing.length === 0, shadowing.join(', '))
const toolsSrc = fs.readFileSync(path.join(root, 'src/karin/apps/tools.ts'), 'utf8')
check('抖音 CDN 直链改为逐个解析 URL 后校验（不再 test 整条消息）',
  /parseDouyinPlayUrl/.test(toolsSrc) && !/douyinCDN/.test(toolsSrc))
const commonSrc = fs.readFileSync(path.join(root, 'src/karin/module/utils/Common.ts'), 'utf8')
check('视频预览按令牌寻址（不再暴露磁盘文件名）', /token/.test(commonSrc) && !/validateVideoRequest/.test(commonSrc))
check('二维码识别前校验公网 http(s)（挡内网探测）', /isSafePublicHttpUrl/.test(commonSrc))
const dySrc = fs.readFileSync(path.join(root, 'src/karin/platform/douyin/getID.ts'), 'utf8')
const xhsSrc = fs.readFileSync(path.join(root, 'src/karin/platform/xiaohongshu/getID.ts'), 'utf8')
check('抖音短链展开前校验域名', /isDouyinUrl/.test(dySrc))
check('小红书短链展开前校验域名', /isXiaohongshuUrl/.test(xhsSrc))

console.log('\n[10] 视频预览令牌')

const { Common } = require(path.join(lib, 'karin/module/utils/Common.js'))
const filePath = path.join(require('node:os').tmpdir(), 'kkk-probe-emoji-video.mp4')
fs.writeFileSync(filePath, 'x')
const info = Common.registerVideoPreview(filePath, false, 30 * 60 * 1000)
check('registerVideoPreview 返回令牌', typeof info.token === 'string' && /^[0-9a-f]{16}$/.test(info.token), info.token)
check('令牌不等于文件名（不暴露磁盘文件名）', info.token !== info.filename, `${info.token} vs ${info.filename}`)
check('按令牌能查到', Common.getVideoPreview(info.token)?.filePath === filePath)
check('按文件名查不到（旧寻址方式已废）', Common.getVideoPreview(info.filename) === null)
const again = Common.registerVideoPreview(filePath, false, 30 * 60 * 1000)
check('同名重复注册复用同一令牌', again.token === info.token, `${info.token} / ${again.token}`)
check('按路径标记已移除仍然可用', Common.markVideoPreviewRemoved(filePath) !== null)
try { fs.unlinkSync(filePath) } catch {}

console.log(failed === 0
  ? '\n\u2714 全部通过：Unicode emoji 走 Apple 图源，预览按令牌寻址，短链展开有域名闸门\n'
  : `\n\u2718 ${failed} 项失败\n`)
process.exit(failed === 0 ? 0 : 1)
