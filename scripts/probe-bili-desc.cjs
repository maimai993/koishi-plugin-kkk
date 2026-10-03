/**
 * 探针：B站视频卡片里**简介到底有没有渲染出来**。
 *
 * 用户反馈：「b站的视频解析封面卡片渲染的内容没有简介」。
 *
 * 这一版不用截图（截图要浏览器渲染器，只有宿主里才有），直接用 **SSR 产物 HTML**：
 * `renderTemplateHtml` 是「模板组件 → HTML 字符串」那一步，不需要浏览器。
 * 于是可以精确问三个问题：
 *   ① 数据里 `desc` 是空的时候，HTML 长什么样（基线）；
 *   ② `desc` 是正常富文本时，简介的原文**有没有出现在 HTML 里**；
 *   ③ 两次 HTML 的长度差有多大 —— 简介整段文字 + 换行都进去的话，差值是**几千字符级**，
 *      只差几十字符就说明「有内容但没渲染」。
 *
 * 用法：node scripts/probe-bili-desc.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..')
const lib = path.join(root, 'lib')

const runtime = require(path.join(lib, 'compat/runtime.js'))
runtime.bindRuntime({
  ctx: { config: { port: 5200 } },
  config: { app: {} },
  dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'kkk-probe-bili-desc-'))
})

require(path.join(lib, 'compat/logger.js')).setLogger({
  debug () {}, info () {}, mark () {},
  warn: (m) => console.log('  [warn] ' + m),
  error: (m) => console.log('  [error] ' + m)
})

const Config = require(path.join(lib, 'karin/module/utils/Config.js'))
Config.Config = {
  app: { EmojiReply: false, RenderWaitTime: 10, renderScale: 2, noiseOverlay: 'off' },
  amagi: { cookies: {} },
  bilibili: {},
  douyin: {}
}

const render = require(path.join(lib, 'karin/module/utils/Render/index.js'))
const rich = require(path.join(lib, 'richtext/parse/index.js'))
const dynamicText = require(path.join(lib, 'karin/platform/bilibili/dynamic-text.js'))

let failed = 0
const check = (name, ok, detail) => {
  console.log((ok ? '  ✔ ' : '  ✘ ') + name + (detail ? '  → ' + detail : ''))
  if (!ok) failed++
}

/** 一段「像真的」的 B 站简介：多行 + 时间轴 + 链接，跟真实投稿一个形状 */
const DESC_LINES = [
  '本期视频带大家看一下这个方案的完整实现，代码已经开源，链接放在下面。',
  '',
  '00:00 开场',
  '01:20 环境准备',
  '05:40 核心逻辑',
  '12:00 踩坑记录',
  '',
  '参考资料：https://www.bilibili.com/read/cv12345678',
  '',
  '感谢大家的支持，记得三连 ~'
]
const DESC_TEXT = DESC_LINES.join('\n')
/** 只取一段不含 URL、不含 @ 的普通文字当「海报标记」，避免被链接/表情的处理干扰 */
const MARKER = '本期视频带大家看一下这个方案的完整实现'

const descDoc = dynamicText.buildBilibiliVideoDescRichText([{ raw_text: DESC_TEXT, type: 1 }])

const baseData = (desc) => ({
  share_url: 'https://b23.tv/BV1JSan6GEFW',
  title: '【实拍】这个方案到底能不能跑起来？完整实现 + 踩坑记录',
  desc,
  stat: { view: 1234567, danmaku: 8901, reply: 2345, like: 98765, coin: 12345, share: 678, favorite: 23456 },
  bvid: 'BV1JSan6GEFW',
  ctime: 1735689600,
  pic: 'https://i0.hdslb.com/bfs/archive/0000000000000000000000000000000000000000.jpg',
  owner: { mid: 123456, name: '测试UP主', face: 'https://i0.hdslb.com/bfs/face/0000000000000000000000000000000000000000.jpg' }
})

/** html 里出现 desc 区域才算「渲染了简介」：找渲染后的可见文本片段 */
const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1

;(async () => {
  try {
    console.log('\n=== 1. desc 构建链路（纯函数，先确认数据没问题） ===')
    {
      const plain = rich.extractRichTextPlainText(descDoc)
      console.log('  富文本节点数 = ' + descDoc.nodes.length + ' | 纯文本长度 = ' + plain.length)
      check('简介文本完整进了富文本文档', plain.includes(MARKER), JSON.stringify(plain.slice(0, 30)))
      check('换行被转成 lineBreak 节点（多行简介要靠它）', descDoc.nodes.some((n) => n.type === 'lineBreak'),
        '节点类型：' + [...new Set(descDoc.nodes.map((n) => n.type))].join(','))
    }

    console.log('\n=== 2. SSR 对照：带简介 vs 不带简介 ===')
    const htmlWith = await render.renderTemplateHtml('bilibili/videoInfo', baseData(descDoc), false)
    const htmlWithout = await render.renderTemplateHtml(
      'bilibili/videoInfo',
      baseData(rich.createRichTextDocument([], { platform: 'bilibili' })),
      false
    )

    check('两侧 SSR 都成功（模板与校验通过）', !!htmlWith && !!htmlWithout,
      'with=' + (htmlWith ? htmlWith.length : 'null') + ' without=' + (htmlWithout ? htmlWithout.length : 'null'))

    if (htmlWith && htmlWithout) {
      const inWith = countOccurrences(htmlWith, MARKER)
      const inWithout = countOccurrences(htmlWithout, MARKER)
      console.log('  简介首句在 HTML 里出现次数：带简介 = ' + inWith + ' / 不带简介 = ' + inWithout)
      check('带简介 → 简介原文出现在卡片 HTML 里', inWith > 0, '出现 ' + inWith + ' 次')
      check('不带简介 → 简介原文不出现（对照成立）', inWithout === 0, '出现 ' + inWithout + ' 次')

      /** 时间轴、链接这些也验一下：它们走的是另外的分支（split 换行 / URL 识别） */
      check('时间轴行渲染进去了', htmlWith.includes('05:40 核心逻辑'))
      check('简介里的链接被渲染成可点的 a 标签', /<a[^>]*href="https:\/\/www\.bilibili\.com\/read\/cv12345678"/.test(htmlWith))

      const delta = htmlWith.length - htmlWithout.length
      console.log('  两次 HTML 长度：' + htmlWith.length + ' vs ' + htmlWithout.length + '（差 ' + delta + ' 字符）')
      check('长度差是「整段简介」的量级（不是几十字符）', delta > DESC_TEXT.length, '差 ' + delta + ' 字符，简介本体 ' + DESC_TEXT.length + ' 字符')

      /** 存一份给人工看（了解实际排版） */
      const out = path.join(root, 'bili-desc-probe.html')
      fs.writeFileSync(out, htmlWith, 'utf8')
      console.log('  已写出 SSR HTML：' + path.relative(root, out) + '（可直接用浏览器打开看排版）')
    }

    console.log('\n=== 3. ✅ 回归：desc_v2 为 null 时简介不能凭空消失 ===')
    {
      /**
       * **本次的真凶**：`data.desc_v2?.length` 只在 desc_v2 是**数组**时才对，
       * 而接口在某些情况下给的是 `desc_v2: null`（amagi 自己的类型里就有这一支：
       * `type Arc = { desc: string; desc_v2: null }`）。
       * 于是判断为假 → 走 desc 兜底那一支……实际并没有：三元的两个分支都指望
       * `desc_v2` 是数组，最后交给模板的是一个**空文档**，
       * 卡片模板里 `props.data.desc &&` 直接为假 ⇒ **整块简介都不渲染**，
       * 而 `desc`（纯文本）明明有内容 —— 用户看到的就是「封面卡片没有简介」。
       *
       * 这里**直接测产物里的 `buildVideoDescRichText`**（新的统一口径），
       * 而不是在探针里重写一遍逻辑 —— 重写的话实现改坏了它也测不出来。
       */
      const buildDesc = dynamicText.buildVideoDescRichText
      check('产物里有 buildVideoDescRichText（三处调用点都用它）', typeof buildDesc === 'function',
        typeof buildDesc)

      const plainDesc = '掉宝时间：北京时间 2026年9月29日15:00 -10月15日14:59'

      /** ① 正常：desc_v2 有内容 */
      const normal = rich.extractRichTextPlainText(buildDesc([{ raw_text: plainDesc, type: 1 }], plainDesc))
      check('desc_v2 正常 → 用 desc_v2', normal.includes('掉宝时间'), JSON.stringify(normal.slice(0, 24)))

      /** ② 真凶场景：desc_v2 是 null，desc 有内容 */
      const nullPlain = rich.extractRichTextPlainText(buildDesc(null, plainDesc))
      check('desc_v2 = null → 用 desc 兜底（不再丢简介）', nullPlain.includes('掉宝时间'),
        nullPlain ? JSON.stringify(nullPlain.slice(0, 24)) : '(空 —— 简介丢了)')

      /** ③ desc_v2 缺失（undefined）也一样 */
      check('desc_v2 缺失 → 同样用 desc 兜底',
        rich.extractRichTextPlainText(buildDesc(undefined, plainDesc)).includes('掉宝时间'))

      /** ④ desc_v2 空数组（接口偶尔给空数组） */
      check('desc_v2 空数组 → 还是用 desc 兜底',
        rich.extractRichTextPlainText(buildDesc([], plainDesc)).includes('掉宝时间'))

      /** ⑤ desc_v2 是「有元素但元素都是空文本」：没有可用内容，也该退回 desc */
      check('desc_v2 全是空串 → 退回 desc 兜底',
        rich.extractRichTextPlainText(buildDesc([{ raw_text: '', type: 1 }], plainDesc)).includes('掉宝时间'))

      /** ⑥ 两个都空：不能抛错，且必须是合法的空文档（模板要能吃） */
      let bothEmpty
      try {
        bothEmpty = buildDesc(null, '')
        check('两处都空 → 得到合法的空富文本文档', bothEmpty?.nodes?.length === 0,
          'nodes=' + (bothEmpty?.nodes?.length ?? 'undefined'))
      } catch (error) {
        check('两处都空 → 不抛错', false, error.message)
      }
      /** ⑦ 老函数直接吃 null 也不能崩（别处还有人在调它） */
      let oldCrash = false
      try {
        dynamicText.buildBilibiliVideoDescRichText(null)
      } catch (error) {
        oldCrash = true
      }
      check('buildBilibiliVideoDescRichText(null) 不再抛 descV2 is not iterable', !oldCrash)

      /** ⑧ **端到端**：拿真凶数据走一遍 SSR，简介必须出现在 HTML 里 */
      if (bothEmpty) {
        const nullV2Html = await render.renderTemplateHtml('bilibili/videoInfo', baseData(buildDesc(null, plainDesc)), false)
        check('desc_v2=null 的数据 → SSR 出来的卡片里真的有简介',
          !!nullV2Html && nullV2Html.includes('掉宝时间'),
          nullV2Html ? ('HTML ' + nullV2Html.length + ' 字符，含简介=' + nullV2Html.includes('掉宝时间')) : 'SSR 失败')
      }
    }

    console.log('\n=== 4. 真实的 desc_v2 形状（从接口拿到的就是它） ===')
    {
      /** 接口里 desc_v2 的常见形状：多段，每段 type=1 纯文本 / type=2 @某人 */
      const mixed = dynamicText.buildBilibiliVideoDescRichText([
        { raw_text: '第一段简介\n', type: 1 },
        { raw_text: '@某某UP', type: 2, biz_id: 999 },
        { raw_text: '\n尾段 https://b23.tv/abc', type: 1 }
      ])
      const plain = rich.extractRichTextPlainText(mixed)
      console.log('  混合 desc_v2 → ' + JSON.stringify(plain))
      check('多段拼接后 @ 与链接都在', plain.includes('@某某UP') && plain.includes('https://b23.tv/abc'))
    }

    console.log('\n' + (failed ? '✘ 有 ' + failed + ' 项没通过' : '✔ 全部通过'))
  } catch (error) {
    console.error('探针自身出错:', error)
    failed++
  } finally {
    process.exit(failed ? 1 : 0)
  }
})()
