/**
 * 探针：「提取封面图 / 提取评论区图片」按钮**挂不挂**，以及「评论区图片直接发」这条路。
 *
 * 覆盖三条来自用户的需求，全是回归测试：
 *   ① 「其它平台也要写啊，别只写B站的」—— 四个平台（B站 / 抖音 / 快手 / 小红书）同一套口径；
 *   ② 「评论区没有图片就不要显示按钮了」—— 缓存里没有评论图片时**不挂**按钮
 *      （`QqPanel.hasCardImage`：点了没反应的东西宁可不挂）；
 *   ③ 「是否收集评论区的图片……这个开不开都没有用啊」—— 那个开关要真有用：
 *      打开时**直接把评论区的图发一条**（`sendCommentPicsDirectly`），
 *      并且**不再挂**「提取评论区图片」按钮（图已经在群里了）。
 *
 * 全程离线：图片由探针自己起的 `127.0.0.1` http 服务提供（尺寸真实的 PNG），
 * 不联网、不连 QQ、不碰用户配置、不写任何文件。
 *
 * 用法：node scripts/probe-extract-buttons.cjs
 */
const http = require('node:http')
const zlib = require('node:zlib')
const fs = require('node:fs')
const path = require('node:path')

const lib = path.join(__dirname, '..', 'lib')
const root = path.join(__dirname, '..')

/**
 * **先把图片落地这一步打桩，再 require 业务代码。**
 *
 * `sendCommentPicsDirectly` 里第一件事是 `processImageUrl(pic)` —— 真实实现会按
 * `imageSendMode` 去下载 / 转 base64（探针里会把 127.0.0.1 的图下成 base64，
 * 而 base64 拿不到公网地址 → md 生成不出来，测不到我们真正关心的那一段）。
 * 产物是 CJS，调用点是 `(0, ImageHelper_1.processImageUrl)(…)`（取属性发生在**调用时**），
 * 所以在这里把这个导出换掉，就能让整条链路按我们要的形状走。
 */
const ImageHelper = require(path.join(lib, 'karin/module/utils/ImageHelper.js'))
const realProcessImageUrl = ImageHelper.processImageUrl
/** 当前生效的打桩：默认原样返回地址（相当于 imageSendMode = url） */
let processImageUrlStub = (url) => url
ImageHelper.processImageUrl = (url, title, index) => processImageUrlStub(url, title, index)

const QqPanel = require(path.join(lib, 'karin/module/utils/QqPanel.js'))
const CardImageCache = require(path.join(lib, 'karin/module/utils/CardImageCache.js'))
const CommentPics = require(path.join(lib, 'karin/module/utils/CommentPics.js'))

let failed = 0
const check = (name, ok, detail) => {
  console.log((ok ? '  ✔ ' : '  ✘ ') + name + (detail ? '  → ' + detail : ''))
  if (!ok) failed++
}

/** 造一张尺寸正确的 PNG（读尺寸只看 IHDR，CRC 填 0 也够用） */
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
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(height * (1 + width * 3)))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * 造一个假事件。
 * @param kind 'crack'（有原生按钮）/ 'qq'（官方 QQ，只有 markdown）/ 'onebot'（连 markdown 都没有）
 */
const makeEvent = (kind, peer) => {
  const sent = []
  const adapterName = kind === 'crack' ? 'adapter-qq-crack' : kind === 'qq' ? 'adapter-qq' : 'adapter-onebot'
  const e = {
    contact: { peer },
    channelId: peer,
    sender: { userId: 'user-1', nick: '触发者' },
    bot: {
      adapter: { name: adapterName },
      bot: { platform: kind === 'onebot' ? 'onebot' : 'qq' },
      account: { selfId: 'self-1', name: 'Bot' }
    },
    reply: async (content) => { sent.push(content); return [{ id: 'msg-' + sent.length }] }
  }
  /** crack 专属能力：`supportsKeyboardButton` 认它就说明原生按钮这条路是通的 */
  if (kind === 'crack') e.bot.refreshBotGroupState = () => {}
  return { e, sent }
}

/** 元素树里的文本（markdown 段的正文在 children 里，见 compat/segment） */
const textOf = (node) => {
  if (!node) return ''
  const parts = []
  if (typeof node?.attrs?.content === 'string') parts.push(node.attrs.content)
  for (const child of node?.children ?? []) parts.push(textOf(child))
  return parts.join('')
}
/** 一个元素（按钮 / 文本 / markdown）的关键字段 */
const infoOf = (item) => {
  if (!item) return '(空)'
  const attrs = item?.attrs ?? item
  return {
    type: item?.type ?? attrs?.type,
    label: attrs?.label ?? attrs?.render_data?.label,
    actionType: attrs?.action?.type,
    data: attrs?.action?.data
  }
}
/** 取按钮元素（跳过卡片图本身） */
const buttonsOf = (list) => list.filter((item) => (item?.type ?? item?.attrs?.type) === 'button')

const imageCount = (text) => [...String(text ?? '').matchAll(/!\[[^\]\n]*\]\([^)\s]+\)/g)].length
const allImagesSized = (text) => {
  const images = [...String(text ?? '').matchAll(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g)]
  return images.length > 0 && images.every((m) => /#[^#\]]*?\d+(?:\.\d+)?\s*px/i.test(m[1]))
}

/** 四个平台（用户要求：别只写 B站） */
const PLATFORMS = [
  ['bilibili', 'BV1JSan6GEFW'],
  ['douyin', '7123456789'],
  ['kuaishou', 'photo-9'],
  ['xiaohongshu', 'note-123']
]

/**
 * 每个场景用**各自的作品键**。
 *
 * 缓存是模块级 Map（按 `平台:作品id` 存，15 分钟过期），同一个键在上一段里记过什么
 * 会一直留着 —— 复用键会让「只有评论长图」这一段实际上还是「有用户贴的图」，
 * 测出来永远是挂按钮（第一版探针就踩了这个坑，误报成功能坏了）。
 */
const keyFor = (platform, id, tag) => CardImageCache.cardImageKeyOf(platform, id + '-' + tag)

const server = http.createServer((req, res) => {
  const url = String(req.url ?? '')
  if (url.startsWith('/c1.png')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(makePng(800, 600)) }
  if (url.startsWith('/c2.png')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(makePng(500, 500)) }
  res.writeHead(404); res.end('nope')
})

server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port
  /**
   * §5/§6/§7 都要读源码（产物 + 源文件），在这里**统一读一次**：
   * 之前 §5 在自己的块作用域里 `const bilibili`，§6 用的时候就 `ReferenceError` 了。
   */
  const read = (rel) => fs.readFileSync(path.join(lib, 'karin/platform', rel), 'utf8')
  const bilibili = read('bilibili/bilibili.js')
  const douyin = read('douyin/douyin.js')
  const readSrc = (rel) => fs.readFileSync(path.join(root, 'src', rel), 'utf8')
  try {
    console.log('\n=== 1. 缓存里有没有图，决定按钮挂不挂（四个平台一致）===')
    {
      /** 只记了封面 */
      let ok = true
      const detail = []
      for (const [platform, id] of PLATFORMS) {
        const key = keyFor(platform, id, 'cover')
        CardImageCache.rememberCardImages(key, { cover: 'https://cdn/' + platform + '/cover.jpg' })
        const { e } = makeEvent('crack', 'g1-' + platform)
        const coverCard = buttonsOf(QqPanel.withCardActions(e, { type: 'img' }, key, { cover: true }))
        const commentCard = QqPanel.cardImageActions(e, { comment: true, key })
        const good = coverCard.length === 1 && coverCard[0]?.attrs?.label === '提取封面图' && commentCard.length === 0
        if (!good) ok = false
        detail.push(platform + ':封面' + coverCard.length + '/评论' + commentCard.length)
      }
      check('只有封面 → 封面按钮在、评论区按钮不挂', ok, detail.join(' '))
    }
    {
      /** 记了评论里用户贴的图 */
      let ok = true
      const detail = []
      for (const [platform, id] of PLATFORMS) {
        const key = keyFor(platform, id, 'pics')
        CardImageCache.rememberCardImages(key, {
          comment: ['/tmp/' + platform + '-comment.png'],
          commentPics: ['https://cdn/' + platform + '/c1.jpg', 'https://cdn/' + platform + '/c2.jpg']
        })
        const { e } = makeEvent('crack', 'g1b-' + platform)
        const buttons = buttonsOf(QqPanel.cardImageActions(e, { comment: true, key }))
        const good = buttons.length === 1 && buttons[0]?.attrs?.label === '提取评论区图片'
        if (!good) ok = false
        detail.push(platform + ':' + buttons.length)
      }
      check('评论区有用户贴的图 → 评论按钮挂上（只挂一个）', ok, detail.join(' '))
    }
    {
      /**
       * **上一轮要修的那一条**：只有「渲染出来的评论长图」，一条用户贴的图都没有。
       * 这种情况下按钮点了也是把长图重发一遍，等于白挂 —— 所以不挂。
       */
      let ok = true
      const detail = []
      for (const [platform, id] of PLATFORMS) {
        const key = keyFor(platform, id, 'longonly')
        CardImageCache.rememberCardImages(key, { comment: ['/tmp/' + platform + '-only.png'] })
        const { e } = makeEvent('crack', 'g1c-' + platform)
        const buttons = QqPanel.cardImageActions(e, { comment: true, key })
        const stillHasPic = QqPanel.hasCardImage(key, 'comment')
        const good = buttons.length === 0 && stillHasPic === false
        if (!good) ok = false
        detail.push(platform + ':' + buttons.length)
      }
      check('只有评论长图、没有用户贴的图 → 不挂按钮', ok, detail.join(' '))
    }
    {
      /** 拿不到作品 id 的作品（比如没解析出 id 的动态）挂了也点不出东西 */
      const { e } = makeEvent('crack', 'g1d')
      const hasKey = keyFor('bilibili', 'BVin', 'cover')
      CardImageCache.rememberCardImages(hasKey, { cover: 'https://cdn/b/in.jpg' })
      const withKey = QqPanel.withCardActions(e, { type: 'img' }, hasKey, { cover: true })
      const noKey = QqPanel.withCardActions(e, { type: 'img' }, '', { cover: true })
      check('有图但没作品 id → 也只剩图片本身', noKey.length === 1 && withKey.length === 2, 'noKey=' + noKey.length + ' withKey=' + withKey.length)
    }

    console.log('\n=== 2. 按钮长什么样（原生按钮 / 文字链 / 纯文本）===')
    {
      const { e } = makeEvent('crack', 'g2')
      const key = keyFor('kuaishou', 'photo-9', 'shape')
      CardImageCache.rememberCardImages(key, { cover: 'https://cdn/k/cover.jpg' })
      const list = QqPanel.withCardActions(e, { type: 'img', attrs: { src: 'card.png' } }, key, { cover: true })
      console.log('  封面卡 →', JSON.stringify(list.map(infoOf)))
      const btn = infoOf(list[1])
      check('是 button 元素且 action.type = 1（点击回调，不塞输入框）', btn.type === 'button' && btn.actionType === 1, JSON.stringify(btn))
      check('按钮名是纯中文（参数只在 data 里）', btn.label === '提取封面图', String(btn.label))
      check('data 带上作品键', btn.data === 'kkk封面 ' + key, String(btn.data))
    }
    {
      const { e } = makeEvent('qq', 'g2b')
      const key = CardImageCache.cardImageKeyOf('bilibili', 'BV1JSan6GEFW')
      CardImageCache.rememberCardImages(key, { commentPics: ['https://cdn/b/c1.jpg'] })
      const list = QqPanel.cardImageActions(e, { comment: true, key })
      const text = decodeURIComponent(textOf(list[0]))
      console.log('  →', text)
      check('官方 QQ 没有原生按钮 → 退回 markdown 文字链', list.length === 1 && text.includes('qqbot-cmd-input'), text.slice(0, 70))
      check('文字链带作品参数 + 中文按钮名', text.includes('bilibili:BV1JSan6GEFW') && text.includes('show="提取评论区图片"'), text.slice(0, 150))
    }
    {
      const { e } = makeEvent('onebot', 'g2c')
      const key = CardImageCache.cardImageKeyOf('douyin', '7123456789')
      CardImageCache.rememberCardImages(key, { cover: 'https://cdn/d/cover.jpg' })
      const list = QqPanel.cardImageActions(e, { cover: true, key })
      const type = list[0]?.type ?? list[0]?.attrs?.type
      check('OneBot 连 markdown 都没有 → 退回纯文字提示', type === 'text' && textOf(list[0]).includes('kkk封面 douyin:7123456789'), type + ' / ' + textOf(list[0]))
    }

    console.log('\n=== 3. 「是否收集评论区的图片」打开时：图直接发了，按钮就别挂了 ===')
    {
      const key = CardImageCache.cardImageKeyOf('bilibili', 'BVsent')
      const e = makeEvent('crack', 'g3')
      /** 先把「评论图片直接发」这条路走完 */
      processImageUrlStub = (url) => url
      const sent = await CommentPics.sendCommentPicsDirectly(e.e, [base + '/c1.png', base + '/c2.png'], { title: '标题', prompt: 'B站评论解析结果' })
      check('直接发送返回 true（真的发出去了）', sent === true, String(sent))
      CardImageCache.rememberCardImages(key, {
        comment: ['/tmp/bili-comment.png'],
        commentPics: [base + '/c1.png', base + '/c2.png']
      })
      check('缓存里确实有图（所以「不挂按钮」不是因为没图）', QqPanel.hasCardImage(key, 'comment') === true)
      const suppressed = QqPanel.cardImageActions(e.e, { comment: !sent, key })
      check('调用方传 comment = !picsSent → 按钮不挂', suppressed.length === 0, 'length=' + suppressed.length)
      const keptOn = QqPanel.cardImageActions(e.e, { comment: true, key })
      check('开关关着（picsSent = false）→ 按钮照挂', buttonsOf(keptOn).length === 1, 'length=' + buttonsOf(keptOn).length)
    }

    console.log('\n=== 4. sendCommentPicsDirectly：发不出去就别让按钮也没了 ===')
    {
      const { e, sent } = makeEvent('crack', 'g4a')
      const ok = await CommentPics.sendCommentPicsDirectly(e, [], { title: '标题' })
      check('评论区一条图都没有 → false 且什么都不发', ok === false && sent.length === 0, ok + ' / 发送 ' + sent.length + ' 次')
    }
    {
      const { e, sent } = makeEvent('crack', 'g4b')
      /** 图片全部落地失败（地址失效 / 下载失败） */
      processImageUrlStub = () => ''
      const ok = await CommentPics.sendCommentPicsDirectly(e, [base + '/c1.png', 'https://cdn/dead.jpg'], { title: '标题' })
      check('图一张都没落地 → false 且什么都不发（按钮该留着）', ok === false && sent.length === 0, ok + ' / 发送 ' + sent.length + ' 次')
    }
    {
      const { e, sent } = makeEvent('qq', 'g4c')
      processImageUrlStub = (url) => url
      const ok = await CommentPics.sendCommentPicsDirectly(e, [base + '/c1.png', base + '/c2.png'], { title: '标题', prompt: '测试' })
      const text = textOf(sent[0])
      console.log('  →', JSON.stringify(text))
      check('两张图 → 只发一条消息', ok === true && sent.length === 1, ok + ' / 发送 ' + sent.length + ' 次')
      check('是 markdown 段（不是一个 md 一条）', (sent[0]?.type ?? sent[0]?.attrs?.type) === 'markdown', String(sent[0]?.type))
      check('两张图都在同一条里，且都带真实比例尺寸', imageCount(text) === 2 && allImagesSized(text), '数量=' + imageCount(text))
      check('尺寸是真量的（800x600 → 420x315）', /#420px #315px/.test(text), text)
    }
    {
      const { e } = makeEvent('crack', 'g4d')
      processImageUrlStub = (url) => url
      /** 模拟 adapter 发消息时抛错（历史上真出现过） */
      e.reply = async () => { throw new Error('模拟发送失败') }
      const ok = await CommentPics.sendCommentPicsDirectly(e, [base + '/c1.png'], { title: '标题' })
      check('发送抛错 → false（不把解析拖挂，按钮留着）', ok === false, String(ok))
    }

    console.log('\n=== 5. 源码守卫：那个开关不许再被短路掉 ===')
    {
      check('B站产物里调用了 sendCommentPicsDirectly', bilibili.includes('sendCommentPicsDirectly'))
      check('抖音产物里调用了 sendCommentPicsDirectly', douyin.includes('sendCommentPicsDirectly'))
      /**
       * 正向：开关真的被读到了。
       * （只做反向检查不行 —— 注释里提到 `if (false && ...)` 也会被匹配到，探针自己写过一次这种误报。）
       */
      check('B站产物里读了 commentImageCollection 开关', /Config\.bilibili\.commentImageCollection/.test(bilibili))
      check('抖音产物里读了 commentImageCollection 开关', /Config\.douyin\.commentImageCollection/.test(douyin))
      /** 反向：不许再用字面量 false 把配置短路掉 */
      check('没有 `if (false && Config.…)` 这种短路', !/if\s*\(\s*false\s*&&\s*(?:Config|config)\./.test(bilibili) && !/if\s*\(\s*false\s*&&\s*(?:Config|config)\./.test(douyin))
      check('两个平台的按钮都跟着 picsSent 走', /comment:\s*!picsSent/.test(bilibili) && /comment:\s*!picsSent/.test(douyin))
    }

    /**
     * 「打开视频发送 → 出面板 → 选清晰度」这条路上，详情卡（封面按钮原本挂的那条）
     * 是**不发**的（`fromPanel` 跳过），于是用户根本看不到「提取封面图」
     * —— 用户反馈：「我打开了视频发送的话，它会根本不会出现这个按钮」。
     *
     * 修法分两步（后一步是用户再一次反馈后改的）：
     *   ① 详情卡不发时，把 `cover` 补到评论区那条长图上；
     *   ② **面板路径**下不再补在长图上 —— 封面入口并进了清晰度面板（最右边那个 ✅️），
     *      而长图挂表情还得另发一条消息，用户明确要求「不要再单独发一条消息」。
     */
    console.log('\n=== 6. 面板路径下「提取封面图」必须还有入口 ===')
    {
      /**
       * 产物里 `if (!infoCardSent)\n    return`（esbuild 会换行），所以只匹配到条件为止。
       * 关键是**详情卡和评论卡用的是同一个变量** —— 详情卡不发时，评论卡必须顶上。
       */
      check('B站：详情卡发不发抽成了变量（和 renderInfoCard 同一个条件）',
        /const infoCardSent = /.test(bilibili) && /if \(!infoCardSent\)/.test(bilibili))
      check('B站：评论卡按它补 cover（详情卡没发、且不是面板路径、且图没直接发过）',
        /cover:\s*!picsSent\s*&&\s*!infoCardSent\s*&&\s*!fromPanel/.test(bilibili), 'bilibili.ts')
      check('抖音：同样按 douyinInfoCardSent 补 cover',
        /const douyinInfoCardSent = /.test(douyin)
        && /cover:\s*!picsSent\s*&&\s*!douyinInfoCardSent\s*&&\s*!fromPanelDouyin/.test(douyin), 'douyin.ts')
      /** 反向：不许又退回「评论卡永远不带 cover」 */
      check('评论卡不是写死只带 comment',
        !/sendSlicedImageWithActions\([^)]*\{\s*comment:\s*!picsSent,\s*key:/.test(bilibili))
      /**
       * 面板路径（`fromPanel`）下**不许**在评论卡上重复挂封面：
       * 那条路上封面入口在清晰度面板上（最右边那个 ✅️，见 probe-onebot-reaction-panel 第 30 节），
       * 而长图挂表情还得**另发一条消息** —— 用户明确要求不要再多发一条。
       */
      check('面板路径下评论卡不带 cover（封面归清晰度面板，且不额外发消息）',
        /cover:\s*!picsSent\s*&&\s*!infoCardSent\s*&&\s*!fromPanel\b/.test(bilibili)
        && /cover:\s*!picsSent\s*&&\s*!douyinInfoCardSent\s*&&\s*!fromPanelDouyin\b/.test(douyin))
    }

    /**
     * 「解析结果合并转发」开着时，面板阶段是**不渲染卡片**的（只问清晰度，见
     * probe-onebot-reaction-panel 第 31 节），所以真正解析那一步必须把详情卡补上 ——
     * 用户要求：「这种情况下先不要渲染图片，先询问清晰度，后面再合成一条」。
     * 不补的话那条唯一的合并转发里就一张卡片都没有（用户反馈：「合并转发里面也没有那个卡片啊」）。
     *
     * 注意读 **TS 源码**：产物里 `isForwardCollecting()` 会被 esbuild 改写成
     * `(0, import_node_karin.isForwardCollecting)()`，正则对不上。
     */
    console.log('\n=== 6c. 合并转发开着时，面板路径也要补发详情卡 ===')
    {
      const biliSrc = readSrc('karin/platform/bilibili/bilibili.ts')
      const dySrc = readSrc('karin/platform/douyin/douyin.ts')
      check('B站：fromPanel 挡卡片时给「合并转发」留了例外',
        /const infoCardSent =[\s\S]{0,200}\(!fromPanel \|\| isForwardCollecting\(\)\)/.test(biliSrc),
        'bilibili.ts')
      check('抖音：同样给「合并转发」留了例外',
        /const douyinInfoCardSent =[\s\S]{0,200}\(!fromPanelDouyin \|\| isForwardCollecting\(\)\)/.test(dySrc),
        'douyin.ts')
      /** 反向：不是把 fromPanel 判断直接删了（那样不开合并转发时会发两张卡） */
      check('  不是无脑去掉 fromPanel 判断（不开转发时面板路径仍不发卡）',
        /!fromPanel/.test(biliSrc) && /!fromPanelDouyin/.test(dySrc))
    }

    /**
     * 评论区的图**已经直接发过**时，那条消息下面什么都不该挂 ——
     * 用户反馈：「打开了收集评论区图片，会主动发送评论区图片。就不要发提示了，也不要贴表情」。
     */
    console.log('\n=== 6b. 评论图直接发过 → 不发提示、不贴表情 ===')
    {
      const src = fs.readFileSync(path.join(root, 'src', 'karin', 'module', 'utils', 'QqPanel.ts'), 'utf8')
      check('长图那条路一律不写「贴个表情」（切片拿不到消息 id，挂不上）',
        /sendSlicedImageWithActions[\s\S]{0,600}emoji:\s*false/.test(src),
        'QqPanel.ts')
      check('拿不到消息 id 时不再自己发一条短消息',
        /不再另发一条短消息[\s\S]{0,200}return false/.test(
          fs.readFileSync(path.join(root, 'src', 'karin', 'module', 'utils', 'ReactionPanel.ts'), 'utf8')))
      /** 反向：不许留着「自己发一条短面板」那条路 */
      check('  attachCardImageEmojiPanel 里没有 sendEmojiActionPanel 了',
        !/const attachCardImageEmojiPanel = [\s\S]{0,1600}sendEmojiActionPanel/.test(
          fs.readFileSync(path.join(lib, 'karin', 'module', 'utils', 'ReactionPanel.js'), 'utf8')))
    }

    /**
     * 卡片正文那句文字退路要写明「也能贴表情」—— 用户反馈：
     * 「下方没有说可以点击表情提取」。但**只在真的会贴表情时才写**：
     * 写一句做不到的提示比不写更糟（用户照着贴了，然后「没有反应」）。
     */
    console.log('\n=== 7. 文字退路里要不要写「也可以贴个表情」 ===')
    {
      const { e } = makeEvent('onebot', 'g6a')
      const key = CardImageCache.cardImageKeyOf('bilibili', 'BVemoji')
      CardImageCache.rememberCardImages(key, { cover: 'https://cdn/b/cover-emoji.jpg' })

      const withEmoji = QqPanel.cardImageActions(e, { cover: true, key, emoji: true })
      const text = textOf(withEmoji[0])
      check('能贴表情 → 文字里写明「也可以直接给这条消息贴个表情」',
        text.includes('贴个表情') && text.includes('kkk封面 ' + key), text)
      check('  指令本身（引用退路）还在', text.includes('引用这条消息发送'), text.slice(0, 60))

      const noEmoji = QqPanel.cardImageActions(e, { cover: true, key })
      check('不能贴表情（开关关着 / 不是 QQ 系）→ 不写这句',
        !textOf(noEmoji[0]).includes('贴个表情'), textOf(noEmoji[0]))

      /** 官方 QQ 走 markdown 文字链，本来就有真按钮，不需要这句 */
      const { e: qq } = makeEvent('qq', 'g6b')
      const qqList = QqPanel.cardImageActions(qq, { cover: true, key })
      check('官方 QQ 是原生按钮 → 不加这句（它有真按钮可点）',
        !textOf(qqList[0]).includes('贴个表情'), textOf(qqList[0]).slice(0, 60))
      /** `canAttachEmoji` 和真正挂面板用的是同一个判定，说法不会两边不一致 */
      check('「能不能贴」复用了 canUseEmojiButtons（不是另写一份判断）',
        /canAttachEmoji[\s\S]{0,400}import\('\.\/ReactionPanel'\)/.test(
          readSrc('karin/module/utils/QqPanel.ts')))
    }

    /**
     * 「合并转发内容」里新增的「评论区图片」（`commentPic`）。
     *
     * 用户反馈：「这个选项里面啊，要再加一个评论区图片…如果开了这个（收集评论区图片）
     * 要是单独发，不要带任何里面的勾选这个东西，不然合并转发里面又发一遍就没有意义了」。
     *
     * 也就是：评论区里用户贴的那些图**不能按「图片」归类** —— 评论长图里已经把它们
     * 画过一遍了，再按 image 收进聊天记录就是同一批图在一条转发里出现两遍。
     */
    console.log('\n=== 8. 合并转发内容：评论区图片单独一类 ===')
    {
      const fc = require(path.join(lib, 'compat/forward-collect.js'))
      const PF = require(path.join(lib, 'karin/module/utils/ParseForward.js'))
      const { Config } = require(path.join(lib, 'karin/module/utils/Config.js'))
      const img = () => ({ type: 'img', attrs: { src: 'https://cdn.example.com/x.png' } })

      /**
       * 默认（`DEFAULT_FORWARD_CONTENT = ['text','image']`）：
       * 标了 `commentPic` 的那张 → 单独发；没标的普通图片 → 进聊天记录。
       */
      let groups = []
      await fc.runWithForwardBag('20001', async () => {
        await fc.withForwardKind('commentPic', () => { fc.collectForward('20001', [img()]) })
        fc.collectForward('20001', [img()])
        groups = fc.drainForwardGroups()
      })
      const split = PF.splitForwardableGroups(groups, 'bilibili')
      check('默认：评论区图片**不进**聊天记录（单独发出去）',
        split.direct.length === 1 && split.forwardGroups.length === 1,
        '直发 ' + split.direct.length + ' / 转发 ' + split.forwardGroups.length)
      check('  普通图片照旧进聊天记录（没被这条改动连累）', split.forwardGroups.length === 1)

      /**
       * 「勾上就进聊天记录」这条**没法在探针里跑通**：`Config` 是只读 Proxy（只有 get 陷阱，
       * 写进去的值读不出来），而真改盘上的 config.json 会把用户的配置弄脏。
       * 所以改成验「配置里写了 commentPic 就一定被采纳」这件事的两个前提：
       *   ① `FORWARD_KINDS` 里有它；② `normalizeKinds` 正是拿 `FORWARD_KINDS` 过滤的。
       * 两条都成立，用户勾上它就一定进得去。
       */
      check('  前提①：类别表里有 commentPic（下面那条源码守卫同款）',
        /FORWARD_KINDS = \[[^\]]*'commentPic'/.test(
          fs.readFileSync(path.join(lib, 'karin/module/utils/ParseForward.js'), 'utf8')))
      check('  前提②：配置值正是按 FORWARD_KINDS 过滤的（不是另写一份白名单）',
        /\.filter\(\(item\) => FORWARD_KINDS\.includes\(item\)\)/.test(
          fs.readFileSync(path.join(lib, 'karin/module/utils/ParseForward.js'), 'utf8')))

      /** 源码守卫：类别表 / 默认值 / 真的标上了 / 两个 UI 都加了这一项 */
      const pfSrc = fs.readFileSync(path.join(lib, 'karin/module/utils/ParseForward.js'), 'utf8')
      check('类别表里有 commentPic', /FORWARD_KINDS = \[[^\]]*'commentPic'/.test(pfSrc))
      check('默认**不含** commentPic（不然又会同一批图发两遍）',
        /DEFAULT_FORWARD_CONTENT = \['text',\s*'image'\]/.test(pfSrc), '默认值')
      check('发评论图那一路真的标了 commentPic',
        /withForwardKind\('commentPic'/.test(
          fs.readFileSync(path.join(lib, 'karin/module/utils/CommentPics.js'), 'utf8')))
      const webui = fs.readFileSync(path.join(root, 'scripts', 'patch-webui.mjs'), 'utf8')
      check('WebUI 里加了「评论区图片」这一项', /'commentPic',\s*'评论区图片'/.test(webui))
      check('控制台 Schema 里也加了', /'text', 'image', 'video', 'file', 'chart', 'commentPic'/.test(
        fs.readFileSync(path.join(root, 'src', 'index.ts'), 'utf8')))
      check('配置类型里也加了（不然写配置会报类型错）',
        /'text' \| 'image' \| 'video' \| 'file' \| 'commentPic'/.test(
          fs.readFileSync(path.join(root, 'src', 'karin', 'types', 'config', 'app.ts'), 'utf8')))
    }

    console.log('\n' + (failed ? '✘ 有 ' + failed + ' 项没通过' : '✔ 全部通过'))
  } catch (error) {
    console.error('探针自身出错:', error)
    failed++
  } finally {
    /** 把打桩还原，免得以后有别的探针复用这个进程时被带偏 */
    ImageHelper.processImageUrl = realProcessImageUrl
    server.close()
    process.exit(failed ? 1 : 0)
  }
})
