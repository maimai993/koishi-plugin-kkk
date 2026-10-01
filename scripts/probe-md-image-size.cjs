/**
 * 探针：**md 图片的尺寸必须是真量出来的，量不到就别发 markdown**。
 *
 * 用户先后反馈过两件事，本探针就是这两条的回归测试：
 *   ① 「发送的所有 md 图片都要 `#px #px`，不然根本看不见」—— 不带尺寸的 md 图片手机端空白；
 *   ② 「自适应发送的图片长宽高有些被强制拉伸了」—— 之前「读不出尺寸就猜一个
 *      `420 × 546` 的框」会把图**拉变形**（QQ 按声明的框渲染）。
 *
 * 所以现在的口径是：**尺寸来自真实测量**（`compat/imageSize`，认 PNG/JPEG/GIF/WebP），
 * 量不到就 `null`，让调用方退回普通图片段；估算值只在「连图都读不到」时当最后兜底。
 *
 * 全程离线：探针自己起一个 `127.0.0.1` 的 http 服务提供**真实尺寸**的图，
 * 不依赖外网、不依赖 QQ、不依赖 assets 服务。
 *
 * 用法：node scripts/probe-md-image-size.cjs
 */
const http = require('node:http')
const zlib = require('node:zlib')
const path = require('node:path')

const lib = path.join(__dirname, '..', 'lib')
const QqPanel = require(path.join(lib, 'karin/module/utils/QqPanel.js'))
const imageMarkdown = require(path.join(lib, 'compat/imageMarkdown.js'))
const imageSize = require(path.join(lib, 'compat/imageSize.js'))

let failed = 0
const check = (name, ok, detail) => {
  console.log((ok ? '  ✔ ' : '  ✘ ') + name + (detail ? '  → ' + detail : ''))
  if (!ok) failed++
}

/** 造一张**尺寸正确**的 PNG（CRC 填 0 也够用——读尺寸只看 IHDR 的宽高） */
const makePng = (width, height) => {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    if (typeof zlib.crc32 === 'function') crc.writeUInt32BE(zlib.crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  const raw = Buffer.alloc(height * (1 + width * 3))
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** 一句话判定：这段 md 文本里的每张图片都带 `#Npx` */
const allImagesSized = (text) => {
  const images = [...String(text ?? '').matchAll(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g)]
  if (!images.length) return false
  return images.every((m) => /#[^#\]]*?\d+(?:\.\d+)?\s*px/i.test(m[1]))
}
const imageCount = (text) => [...String(text ?? '').matchAll(/!\[[^\]\n]*\]\([^)\s]+\)/g)].length
/** 取出元素树里所有文本（markdown 段的正文在 children 里，见 compat/segment 的 h() 形状） */
const textOf = (node) => {
  if (!node) return ''
  const parts = []
  if (typeof node?.attrs?.content === 'string') parts.push(node.attrs.content)
  for (const child of node?.children ?? []) parts.push(textOf(child))
  return parts.join('')
}
/** 从 md 文本里抠出第一张图的 `#宽px #高px` */
const sizeOf = (md) => {
  const m = /!\[#(\d+)px #(\d+)px\]/.exec(String(md ?? ''))
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null
}

const PORT = 0 // 让系统分配
const png = {
  wide: makePng(800, 600), // 4:3 —— 猜出来的 1:1.3 框会明显拉宽
  tall: makePng(600, 1200), // 1:2 竖图
  square: makePng(500, 500)
}

const server = http.createServer((req, res) => {
  const url = String(req.url ?? '')
  if (url.startsWith('/wide.png')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(png.wide) }
  if (url.startsWith('/tall.png')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(png.tall) }
  if (url.startsWith('/square.png')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(png.square) }
  if (url.startsWith('/broken.png')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.from([1, 2, 3, 4, 5])) }
  res.writeHead(404); res.end('nope')
})

server.listen(PORT, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port
  try {
    console.log('\n=== 0. compat/imageSize：四种格式都要认 ===')
    check('PNG 800x600', JSON.stringify(imageSize.readImageSize(png.wide)) === '{"width":800,"height":600}', JSON.stringify(imageSize.readImageSize(png.wide)))
    check('JPEG SOF0 320x240', (() => {
      const jpeg = Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0\u0001\u0001\0\0\u0001\0\u0001\0\0'),
        Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xf0, 0x01, 0x40, 0x03]), Buffer.alloc(9),
        Buffer.from([0xff, 0xd9])
      ])
      const s = imageSize.readImageSize(jpeg)
      return s.width === 320 && s.height === 240
    })(), '期望 320x240')
    check('GIF 64x48', (() => {
      const gif = Buffer.alloc(20); gif.write('GIF89a', 0, 'latin1'); gif.writeUInt16LE(64, 6); gif.writeUInt16LE(48, 8)
      const s = imageSize.readImageSize(gif)
      return s.width === 64 && s.height === 48
    })(), '期望 64x48')
    check('WebP VP8X 1024x512', (() => {
      const w = Buffer.alloc(40)
      w.write('RIFF', 0, 'latin1'); w.write('WEBP', 8, 'latin1'); w.write('VP8X', 12, 'latin1')
      w.writeUIntLE(1023, 24, 3); w.writeUIntLE(511, 27, 3)
      const s = imageSize.readImageSize(w)
      return s.width === 1024 && s.height === 512
    })(), '期望 1024x512')
    check('截断/垃圾数据 → 0x0（不抛异常）', JSON.stringify(imageSize.readImageSize(Buffer.from([1, 2, 3]))) === '{"width":0,"height":0}')
    check('isUsableSize 认 0 为不可用', imageSize.isUsableSize({ width: 0, height: 600 }) === false && imageSize.isUsableSize({ width: 8, height: 6 }) === true)
    check('scaleToWidth 保持比例（800x600 → 420x315）', JSON.stringify(imageSize.scaleToWidth({ width: 800, height: 600 }, 420)) === '{"width":420,"height":315}', JSON.stringify(imageSize.scaleToWidth({ width: 800, height: 600 }, 420)))
    check('scaleToWidth 不放大（小图原样）', JSON.stringify(imageSize.scaleToWidth({ width: 100, height: 50 }, 420)) === '{"width":100,"height":50}')

    console.log('\n=== 1. toMarkdownImage：尺寸用真实值，比例不拉伸 ===')
    {
      const md = await QqPanel.toMarkdownImage(base + '/wide.png', 420)
      console.log('  →', md)
      check('返回了 md 图片', typeof md === 'string' && md.startsWith('!['), String(md))
      check('带 #宽px #高px', allImagesSized(md), String(md))
      const size = sizeOf(md)
      check('比例正确：800x600 → 420x315（不是 420x546 的拉伸框）', size && size.width === 420 && size.height === 315, JSON.stringify(size))
      check('宿主没有 assets → 用原始 http 链接', String(md).endsWith('(' + base + '/wide.png)'), String(md))
    }
    {
      const md = await QqPanel.toMarkdownImage(base + '/tall.png', 420)
      const size = sizeOf(md)
      check('竖图 600x1200 → 420x840（同样保持比例）', size && size.width === 420 && size.height === 840, JSON.stringify(size))
    }

    console.log('\n=== 2. 读不出尺寸 / 拿不到公网地址 → 返回 null（绝不猜框） ===')
    check('小图/半截图（读不出尺寸）→ null', (await QqPanel.toMarkdownImage(base + '/broken.png')) === null, String(await QqPanel.toMarkdownImage(base + '/broken.png')))
    check('HTTP 404 → null', (await QqPanel.toMarkdownImage(base + '/missing.png')) === null)
    check('base64:// 拿不到公网地址 → null', (await QqPanel.toMarkdownImage('base64://AAAA')) === null)
    check('data: 拿不到公网地址 → null', (await QqPanel.toMarkdownImage('data:image/png;base64,iVBORw0KGgo=')) === null)

    console.log('\n=== 3. sizeMarkdownImages：优先真量，量不到才估算 ===')
    {
      const out = await imageMarkdown.sizeMarkdownImages('没有图片的一段话', 420)
      check('没有图片语法 → 原样返回', out === '没有图片的一段话', out)
    }
    {
      const out = await imageMarkdown.sizeMarkdownImages('![封面](' + base + '/wide.png)', 420)
      const size = sizeOf(out)
      check('漏尺寸的 md 图片被补上真实比例（420x315）', size && size.width === 420 && size.height === 315, out)
      check('补完仍带尺寸', allImagesSized(out), out)
    }
    {
      const out = await imageMarkdown.sizeMarkdownImages('![](https://127.0.0.1:1/dead.png)', 420)
      const size = sizeOf(out)
      check('量不到 → 退回估算值兜底（保证看得见）', allImagesSized(out), out)
      check('估算值是 420x546（仅此一路兜底）', size && size.width === 420 && size.height === 546, JSON.stringify(size))
    }
    {
      const before = '![#420px #315px](' + base + '/wide.png)'
      const out = await imageMarkdown.sizeMarkdownImages(before, 420)
      check('已经带尺寸的不动（不重复测量 / 不改写）', out === before, out)
    }

    console.log('\n=== 4. ensureMarkdownImageSize：估算版兜底（老 API，保持可用） ===')
    {
      const cases = [
        ['![#420px #546px](https://x/a.jpg)', false, '已经带尺寸 → 不动'],
        ['![](https://x/a.jpg)', true, '空 alt → 补尺寸'],
        ['![封面](https://x/a.jpg)', true, '有 alt 无尺寸 → 补尺寸'],
        ['![](https://x/a.jpg)\n![](https://x/b.jpg)', true, '多张 → 都补'],
        ['纯文字，没有图片', false, '没有图片 → 原样'],
        ['[](https://x/a.jpg)', false, '不是图片语法（缺 !）→ 不动']
      ]
      for (const [input, shouldChange, label] of cases) {
        const out = imageMarkdown.ensureMarkdownImageSize(input, 420)
        const changed = out !== input
        const ok = changed === shouldChange && (!changed || allImagesSized(out))
        check(label, ok, JSON.stringify(input) + ' → ' + JSON.stringify(out))
      }
    }

    console.log('\n=== 5. 发送出口：整条只有 markdown 的消息也会被补（切长图 / 面板卡片那种） ===')
    {
      const elements = [{ type: 'markdown', attrs: {}, children: [{ type: 'text', attrs: { content: '![](' + base + '/wide.png)\n![](' + base + '/square.png)' }, children: [] }] }]
      const out = await imageMarkdown.imagesToMarkdown(elements, 'qq')
      const text = out.map(textOf).join('\n')
      console.log('  →', text)
      check('图片数量没变', imageCount(text) === 2, String(imageCount(text)))
      check('两张都带尺寸，且都是真实比例（420x315 / 420x420）', /#420px #315px/.test(text) && /#420px #420px/.test(text), text)
      check('非 markdown 段的位置/内容不受影响', out.length === 1, 'length=' + out.length)
    }
    {
      const elements = [{ type: 'markdown', attrs: { content: '![](' + base + '/tall.png)' } }]
      const out = await imageMarkdown.imagesToMarkdown(elements, 'qq')
      const text = out.map(textOf).join('\n')
      check('扁平 attrs.content 也能补真实尺寸', /#420px #840px/.test(text), text)
    }
    {
      const elements = [{ type: 'markdown', attrs: {}, children: [{ type: 'text', attrs: { content: '![#1440px #2000px](' + base + '/wide.png)' }, children: [] }] }]
      const out = await imageMarkdown.imagesToMarkdown(elements, 'qq')
      const text = out.map(textOf).join('\n')
      check('已带尺寸的原样保留（不被重新测量覆盖）', text === '![#1440px #2000px](' + base + '/wide.png)', text)
    }
    {
      const elements = [
        { type: 'video', attrs: { src: 'file:///tmp/v.mp4' } },
        { type: 'markdown', attrs: {}, children: [{ type: 'text', attrs: { content: '![](' + base + '/wide.png)' }, children: [] }] }
      ]
      const out = await imageMarkdown.imagesToMarkdown(elements, 'qq')
      const text = out.map(textOf).join('\n')
      check('有视频时不改图片段，但 md 尺寸照补', out.some((el) => el.type === 'video') && /#420px #315px/.test(text), text)
    }
    {
      const elements = [{ type: 'markdown', attrs: {}, children: [{ type: 'text', attrs: { content: '![](' + base + '/wide.png)' }, children: [] }] }]
      const out = await imageMarkdown.imagesToMarkdown(elements, 'onebot')
      const text = out.map(textOf).join('\n')
      check('OneBot 不动 markdown', text === '![](' + base + '/wide.png)', text)
    }

    console.log('\n=== 6. buildMarkdownImageMessage：一组图 → 一条消息 ===')
    {
      const msg = await QqPanel.buildMarkdownImageMessage([base + '/wide.png', base + '/square.png'], 420, 'qq')
      const text = textOf(msg)
      check('合成一条 markdown，两张都带真实尺寸', imageCount(text) === 2 && allImagesSized(text), text)
    }
    {
      const msgs = await QqPanel.buildMarkdownImageMessage([base + '/wide.png'], 420, 'onebot')
      // Koishi 的 h() 把 image 归一化成 `img` 段
      check('OneBot → 图片段而不是 markdown', Array.isArray(msgs) && msgs.length === 1 && msgs[0].type === 'img', JSON.stringify(msgs?.[0]?.type))
    }

    console.log('\n' + (failed ? '✘ 有 ' + failed + ' 项没通过' : '✔ 全部通过'))
  } catch (error) {
    console.error('探针自身出错:', error)
    failed++
  } finally {
    server.close()
    process.exit(failed ? 1 : 0)
  }
})
