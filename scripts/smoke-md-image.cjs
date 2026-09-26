/**
 * 冒烟测试：**图片统一改走 markdown**（用户要求）。
 *
 * 背景（用户反馈）：
 *   - 「所有的图片发送都要走 md，不然太模糊了」—— QQ 的普通图片消息会被压糊，md 图片不会；
 *   - 「![#px大小#px大小]() 必须要 #px，不然手机不会显示」—— md 图片必须写死尺寸。
 * 所以 compat 的发送出口会把 image 段改写成 `![#宽px #高px](https://…)`（见 compat/imageMarkdown.ts）。
 *
 * 这里验四件事：
 *   1. 尺寸真的读出来了（PNG / JPEG 两种头），并且写进了 md；
 *   2. **只在认 markdown 的平台上改**（qq 改；onebot / qqguild / 未知平台一律不动）；
 *   3. 该跳过的都跳过（消息里有视频/语音/文件时不能改，否则 md 内容会被适配器丢掉）；
 *   4. 改不动就**原样发**（上传失败、没有 assets 服务），绝不把图弄丢；
 *   5. 走的是真出口：`Message.reply` / `KkkBot.sendMsg` 里就要已经改好了。
 *
 * 用法：node scripts/smoke-md-image.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const pluginRoot = path.resolve(__dirname, '..')

let failures = 0
const check = (name, ok, detail) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  —— ' + detail : ''))
  if (!ok) failures++
}

const runtime = require(path.join(pluginRoot, 'lib/compat/runtime.js'))
const segment = require(path.join(pluginRoot, 'lib/compat/segment.js')).segment
const mdImage = require(path.join(pluginRoot, 'lib/compat/imageMarkdown.js'))
const nodeKarin = require(path.join(pluginRoot, 'lib/compat/node-karin.js'))

/** 一个「够用」的 PNG：只补到 readImageSize 要读的字段（IHDR 的宽高） */
const fakePng = (width, height) => {
  const buffer = Buffer.alloc(32)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'latin1')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

/** 一个「够用」的 JPEG：SOF0 段里有高宽即可 */
const fakeJpeg = (width, height) => {
  const buffer = Buffer.alloc(20)
  buffer[0] = 0xff
  buffer[1] = 0xd8
  buffer[2] = 0xff
  buffer[3] = 0xc0
  buffer.writeUInt16BE(17, 4)
  buffer[6] = 0x08
  buffer.writeUInt16BE(height, 7)
  buffer.writeUInt16BE(width, 9)
  return buffer
}

const dataUri = (buffer) => 'data:image/png;base64,' + buffer.toString('base64')

let uploads = 0
let uploadShouldFail = false
const noop = () => {}
const ctx = {
  get: () => undefined,
  logger: () => ({ info: noop, warn: noop, error: noop, debug: noop, mark: noop }),
  assets: {
    upload: async (dataUriText, name) => {
      uploads++
      if (uploadShouldFail) throw new Error('assets 挂了')
      return 'https://assets.example.com/' + String(name)
    }
  }
}
runtime.bindRuntime({ ctx, config: {}, pluginRoot, dataRoot: os.tmpdir() })

const textOf = (element) => {
  if (!element) return ''
  if (element.type === 'text') return element.attrs?.content ?? ''
  return (element.children ?? []).map(textOf).join('')
}

const run = async () => {
  console.log('— 尺寸读得出来 —')
  mdImage.clearMarkdownImageCache()
  uploads = 0
  const pngMd = await mdImage.markdownImageOf(dataUri(fakePng(600, 400)))
  check('PNG 宽高写进了 md', pngMd === '![#600px #400px](https://assets.example.com/kkk-md.png)', pngMd)
  check('PNG 按 image/png 上传（扩展名跟着走）', String(pngMd).endsWith('.png)'), pngMd)

  const jpegMd = await mdImage.markdownImageOf(dataUri(fakeJpeg(2880, 1440)))
  check('JPEG 宽高写进了 md', jpegMd === '![#2880px #1440px](https://assets.example.com/kkk-md.jpg)', jpegMd)

  const base64Md = await mdImage.markdownImageOf('base64://' + fakePng(12, 34).toString('base64'))
  check('base64:// 也认', base64Md === '![#12px #34px](https://assets.example.com/kkk-md.png)', base64Md)

  const file = path.join(os.tmpdir(), 'kkk-md-smoke-' + Date.now() + '.png')
  fs.writeFileSync(file, fakePng(8, 9))
  const fileMd = await mdImage.markdownImageOf(file)
  check('本地路径也认', fileMd === '![#8px #9px](https://assets.example.com/kkk-md.png)', fileMd)
  fs.rmSync(file, { force: true })

  console.log('— 同一张图不重复上传 —')
  mdImage.clearMarkdownImageCache()
  uploads = 0
  const again = dataUri(fakePng(100, 50))
  await mdImage.markdownImageOf(again)
  await mdImage.markdownImageOf(again)
  check('第二次走缓存（只上传一次）', uploads === 1, 'uploads=' + uploads)

  console.log('— 只改认 markdown 的平台 —')
  const image = () => segment.image(dataUri(fakePng(600, 400)))
  for (const platform of ['onebot', 'napcat', 'lagrange', 'go-cqhttp', 'chronocat', 'mirai', 'qqguild', 'sandbox', '']) {
    const list = [image()]
    const out = await mdImage.imagesToMarkdown(list, platform)
    check(platform + ' 平台保持图片段', out.length === 1 && out[0] === list[0] && out[0].type === 'img')
  }
  const qqOut = await mdImage.imagesToMarkdown([image()], 'qq')
  check('qq 平台改成 markdown', qqOut.length === 1 && qqOut[0].type === 'markdown', qqOut[0]?.type)
  check('qq 平台的 md 里带 #宽px #高px', /!\[#600px #400px\]\(https:\/\//.test(textOf(qqOut[0])), textOf(qqOut[0]))

  console.log('— 该跳过的都跳过 —')
  const withVideo = [image(), segment.video('data:video/mp4;base64,AAAA')]
  const videoOut = await mdImage.imagesToMarkdown(withVideo, 'qq')
  check('带视频的消息不动（md 会被适配器丢掉）', videoOut[0].type === 'img' && videoOut[1].type === 'video')
  const withAudio = [image(), segment.audio('data:audio/mpeg;base64,AAAA')]
  check('带语音的消息不动', (await mdImage.imagesToMarkdown(withAudio, 'qq'))[0].type === 'img')
  const noImage = [segment.text('只有文字')]
  const noImageOut = await mdImage.imagesToMarkdown(noImage, 'qq')
  check('没有图片就不进这套逻辑', noImageOut[0] === noImage[0])

  console.log('— 顺序与合并 —')
  const mixed = [segment.text('看图：'), image(), segment.text('就这些')]
  const mixedOut = await mdImage.imagesToMarkdown(mixed, 'qq')
  check('文字 / md 图片 / 文字 顺序不变',
    mixedOut.length === 3 && mixedOut[0].type === 'text' && mixedOut[1].type === 'markdown' && mixedOut[2].type === 'text',
    mixedOut.map((element) => element.type).join(','))
  const twice = await mdImage.imagesToMarkdown([image(), image(), segment.text('尾')], 'qq')
  check('连续图片合成一条 markdown（两行）',
    twice.length === 2 && twice[0].type === 'markdown' && String(textOf(twice[0])).split(String.fromCharCode(10)).length === 2,
    twice.map((element) => element.type).join(','))

  console.log('— 改不动就原样发，绝不丢图 —')
  uploadShouldFail = true
  mdImage.clearMarkdownImageCache()
  const failedList = [image()]
  const failedOut = await mdImage.imagesToMarkdown(failedList, 'qq')
  check('上传失败时退回图片段', failedOut.length === 1 && failedOut[0] === failedList[0] && failedOut[0].type === 'img')
  uploadShouldFail = false

  const savedCtx = ctx.assets
  delete ctx.assets
  mdImage.clearMarkdownImageCache()
  const noAssetsList = [image()]
  const noAssetsOut = await mdImage.imagesToMarkdown(noAssetsList, 'qq')
  check('没有 assets 服务时退回图片段', noAssetsOut[0] === noAssetsList[0] && noAssetsOut[0].type === 'img')
  ctx.assets = savedCtx

  console.log('— 读不出尺寸的图，宁可发普通图片 —')
  mdImage.clearMarkdownImageCache()
  const unknown = Buffer.alloc(64, 0x42)
  const unknownList = [segment.image('data:application/octet-stream;base64,' + unknown.toString('base64'))]
  const unknownOut = await mdImage.imagesToMarkdown(unknownList, 'qq')
  check('认不出格式的图保持图片段（不带尺寸的 md 手机上不显示）',
    unknownOut.length === 1 && unknownOut[0] === unknownList[0] && unknownOut[0].type === 'img')

  console.log('— 真出口上就已经改好了（Message.reply / KkkBot.sendMsg） —')
  const sent = []
  const makeBot = (platform) => new nodeKarin.KkkBot({
    platform,
    selfId: '1',
    sendMessage: async (channelId, elements) => {
      sent.push({ channelId, elements })
      return ['mid-1']
    }
  })

  const qqMessage = new nodeKarin.Message({ bot: makeBot('qq'), contact: { peer: 'group:1' } })
  await qqMessage.reply([segment.image(dataUri(fakePng(320, 240)))])
  check('Message.reply 发出去的是 markdown',
    sent.length === 1 && sent[0].elements.length === 1 && sent[0].elements[0].type === 'markdown',
    sent[0]?.elements?.map((element) => element.type).join(','))
  check('Message.reply 的 md 带尺寸', /!\[#320px #240px\]/.test(textOf(sent[0].elements[0])), textOf(sent[0].elements[0]))

  sent.length = 0
  const onebotBot = makeBot('onebot')
  await onebotBot.sendMsg('group:1', [segment.image(dataUri(fakePng(320, 240)))])
  check('OneBot 的 KkkBot.sendMsg 保持图片段',
    sent.length === 1 && sent[0].elements[0].type === 'img', sent[0]?.elements?.[0]?.type)

  sent.length = 0
  const qqBot = makeBot('qq')
  await qqBot.sendMsg('group:1', [segment.image(dataUri(fakePng(64, 64)))])
  check('qq 的 KkkBot.sendMsg 也改成了 markdown',
    sent[0]?.elements?.[0]?.type === 'markdown', sent[0]?.elements?.[0]?.type)

  console.log('')
  console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
  process.exit(failures === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
