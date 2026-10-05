/**
 * 探针：**OneBot 系平台上不许出现腾讯那套 markdown 私货**。
 *
 * ## 为什么单开一个探针
 * `markdown` 段和 `<qqbot-cmd-input>` / `<qqbot-cmd-enter>` 这些标签是
 * **腾讯官方适配器（qq / qqguild）的私货**。OneBot 系（NapCat / Lagrange / go-cqhttp /
 * Chronocat）根本不渲染：`segment.markdown('…')` 过去就是一整段**裸文本**，
 * 用户看到的是 `<qqbot-cmd-input text="下载进度 BV17tHb6AEKt" show="查询下载进度" />`
 * 这一行标签本身（用户实测截图）。
 *
 * 这类漏洞的特点是**不报错、不崩**，只是「发出去的东西很难看」，
 * 而且往往是某条只有 QQ 才会走的分支被 OneBot 复用（比如 `--p=<令牌>` 会让
 * `fromPanel` 判真，于是 OneBot 也走了「面板点进来的」那条分支）——
 * 静默、难发现。所以用探针把出口钉住。
 *
 * ## 检查什么
 *   ① `supportsMarkdown` 白名单：只有 qq / qqguild 是 true，其它（含空）都 false；
 *   ② `buildDownloadTip` 三态：OneBot → 纯文本指令；QQ → markdown 按钮；**不传事件 → 老行为**；
 *   ③ OneBot 分支的文本里不能出现任何 markdown 私货（`<qqbot-*`、`![#`、`| --- |` 表格）；
 *   ④ 图片链路在 OneBot 上不走 markdown（回归保护，`buildMarkdownImageMessage`）；
 *   ⑤ 静态闸门：`cmdInput(` 的调用点只允许出现在下面那份**带闸门的白名单**里，
 *      **新增一个文件就会红** —— 逼作者先想清楚「这个平台认 markdown 吗」。
 *
 * 用法：node scripts/probe-onebot-no-markdown.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const lib = path.join(root, 'lib')

const runtime = require(path.join(lib, 'compat/runtime.js'))
runtime.bindRuntime({
  ctx: { config: { port: 5200, prefix: '' } },
  config: { playerEnabled: true },
  dataRoot: fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kkk-probe-nomd-'))
})

const qqPanel = require(path.join(lib, 'karin/module/utils/QqPanel.js'))

/**
 * 假 logger：`compat/logger` 在没被 setLogger 时会去 `runtime.ctx.logger('kkk')`，
 * 而这里的假 ctx 没有那个方法 —— 一路 `logger.debug` 就会炸（不是被测代码的问题）。
 */
const logLines = []
require(path.join(lib, 'compat/logger.js')).setLogger({
  debug () {},
  info: (...args) => { logLines.push(String(args[0] ?? '')) },
  mark () {},
  warn (message) { console.log('  [warn] ' + message) },
  error (message) { console.log('  [error] ' + message) }
})

let failed = 0
const check = (name, ok, detail) => {
  console.log((ok ? '  \u2714 ' : '  \u2718 ') + name + (detail ? '  \u2192 ' + detail : ''))
  if (!ok) failed++
}

/**
 * 把消息段摊平成文字。
 *
 * ⚠️ `segment.markdown('x')` 等价于 `h('markdown', 'x')` —— 第二个参数是**子节点**不是 attrs，
 * 所以内容在 `children` 里、`attrs.content` 是空的。只读 attrs 会看到一坨 `[markdown]`。
 */
const render = (content) => {
  const list = Array.isArray(content) ? content : [content]
  return list.map((item) => {
    if (!item || typeof item !== 'object') return String(item ?? '')
    const attrs = item.attrs ?? {}
    const inner = (item.children ?? []).map((child) => {
      if (!child || typeof child !== 'object') return String(child ?? '')
      return String(child.attrs?.content ?? child.attrs?.text ?? '')
    }).join('')
    if (item.type === 'text') return String(attrs.content ?? '') + inner
    if (item.type === 'markdown') return '[markdown]' + String(attrs.content ?? '') + inner
    if (item.type === 'img' || item.type === 'image') return '[img]'
    return '[' + item.type + ']'
  }).join('')
}

/** markdown 私货的痕迹：标签、markdown 图片、markdown 表格 */
const PRIVATE_MARKDOWN = /<qqbot-|!\[#|\|\s*:?-{2,}/

const oneBot = () => ({ bot: { platform: 'napcat' }, contact: { peer: '20001', isGroup: true }, isGroup: true })
const officialQq = () => ({ bot: { platform: 'qq' }, contact: { peer: 'c2c:1', isGroup: false }, isGroup: false })

;(async () => {
  console.log('\n=== 1. supportsMarkdown 白名单 ===')
  {
    for (const platform of ['qq', 'QQ', 'qqguild']) {
      check(platform + ' → 认 markdown', qqPanel.supportsMarkdown(platform) === true, String(qqPanel.supportsMarkdown(platform)))
    }
    for (const platform of ['onebot', 'napcat', 'lagrange', 'go-cqhttp', 'chronocat', 'discord', 'telegram', 'kook', '']) {
      check((platform || '（空）') + ' → 不认', qqPanel.supportsMarkdown(platform) === false, String(qqPanel.supportsMarkdown(platform)))
    }
  }

  console.log('\n=== 2. 「开始下载」那条提示（用户实测漏出来的就是这个） ===')
  {
    const taskId = 'BV17tHb6AEKt'

    /** OneBot：必须是**纯文本指令**，不能有任何 markdown 私货 */
    const one = qqPanel.buildDownloadTip(taskId, '收到请求，开始下载', oneBot())
    const oneText = render(one)
    check('OneBot 上不再发 markdown 段', !render(one).includes('[markdown]'), oneText.slice(0, 60))
    check('  没有 <qqbot-cmd-input> 标签', !oneText.includes('<qqbot-cmd-input'), oneText.slice(0, 60))
    check('  整体不含任何 markdown 私货', !PRIVATE_MARKDOWN.test(oneText), oneText.slice(0, 60))
    check('  说了人话：怎么查进度', /发送「[^」]*下载进度 BV17tHb6AEKt」查询下载进度/.test(oneText), oneText)
    check('  原来那句「收到请求，开始下载」还在', oneText.includes('收到请求，开始下载'), oneText.slice(0, 40))

    /** QQ：保持原样（markdown + 按钮） */
    const qq = qqPanel.buildDownloadTip(taskId, '收到请求，开始下载', officialQq())
    const qqText = render(qq)
    check('QQ 上照样是 markdown 按钮', qqText.includes('[markdown]') && qqText.includes('<qqbot-cmd-input'), qqText.slice(0, 80))
    check('  按钮里的指令带上了本次任务的 bvid', qqText.includes(encodeURIComponent('下载进度 BV17tHb6AEKt')) || qqText.includes('BV17tHb6AEKt'), qqText.slice(0, 100))

    /**
     * 不传事件时**保持老行为**（发 markdown）—— 这条是防「顺手把默认值改掉」：
     * 老调用点 / 探针拿不到事件，改了默认值会让 QQ 上的按钮凭空消失。
     */
    const none = qqPanel.buildDownloadTip(taskId, '收到请求，开始下载')
    check('不传事件 → 保持老行为（markdown，QQ 按钮不消失）', render(none).includes('<qqbot-cmd-input'), render(none).slice(0, 60))
  }

  console.log('\n=== 3. 图片链路在 OneBot 上也不走 markdown（回归保护） ===')
  {
    /**
     * 用 1x1 的 data URI，**不联网**：拿不到图时函数会返回 null（由调用方发普通图片段），
     * 那也是合格结果 —— 要拦的是「OneBot 上返回了 markdown 段」。
     */
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/AAf/AAAAAElFTkSuQmCC'
    let one = null
    try {
      one = await qqPanel.buildMarkdownImageMessage([png], 420, 'onebot')
    } catch (error) {
      check('OneBot：调用本体不抛（拿不到图要返回 null，不能把异常丢给调用方）', false, String(error?.message ?? error))
    }
    check('OneBot：要么返回图片段、要么返回 null —— 绝不能是 markdown',
      one === null || !render(one).includes('[markdown]'), one === null ? 'null' : render(one))

    /**
     * **Milky 同样不认 markdown**（用户反馈：「为什么 milky 适配器会发这个
     * `![#420px #315px](https://…)`」）。
     *
     * 根因：这份「不渲染 markdown」的名单在四个文件里各写了一遍，**都不含 milky** ——
     * 于是 Milky 被当成「会渲染 markdown」，评论区图片 / 封面全发成裸文本。
     */
    let milky = null
    try {
      milky = await qqPanel.buildMarkdownImageMessage([png], 420, 'milky')
    } catch (error) {
      check('Milky：调用本体不抛', false, String(error?.message ?? error))
    }
    check('Milky：也返回图片段 —— 绝不能是 markdown',
      milky === null || !render(milky).includes('[markdown]'), milky === null ? 'null' : render(milky))
  }

  console.log('\n=== 3.5 图片切片 / 错误卡片：只有官方 QQ 才用 markdown ===')
  {
    /**
     * 判据必须**正向点名**（「是官方 QQ 才用」），不能写成「不是 OneBot 就用」。
     *
     * 以前 `ImageSlice` 里就是 `markdownMode = !isOneBotLike(platform)` —— 于是凡是
     * **认不出来**的平台（`platformOf()` 拿到空串、或者 telegram / discord / satori 这类
     * 根本不是 QQ 的适配器）全被当成官方 QQ，发下去一串 `![#1440px #2000px](url)` 裸文本，
     * 图一张都出不来（用户反馈：「适配器不等于 qq（platform）为什么会使用 md 格式发送」）。
     */
    const md = require(path.join(lib, 'compat/imageMarkdown.js'))
    const slice = require(path.join(lib, 'karin/module/utils/ImageSlice.js'))
    check('判据只有一处（canUseMarkdownImage 已导出，别处都来问它）', typeof md.canUseMarkdownImage === 'function')
    /**
     * **白名单**：只有 QQ 和 QQ 频道。
     *
     * ⚠️ 判据必须**正向点名**（「是官方 QQ 才用」），不能写成「不是 OneBot 就用」——
     * 以前 `ImageSlice` 里就是 `markdownMode = !isOneBotLike(platform)`，于是凡是
     * **认不出来**的平台（`platformOf()` 拿到空串、或者 telegram / discord / satori /
     * **milky** 这类）全被当成官方 QQ，发下去一串 `![#1440px #2000px](url)` 裸文本，
     * 图一张都出不来（用户反馈过好几次）。
     *
     * 黑名单的失效方式是「**新协议端默认被放行**」—— 而这里放行的代价就是一堆乱码。
     */
    for (const platform of ['qq', 'QQ', 'qqbot', 'qq-foo']) {
      check(platform + ' → 用 markdown', md.canUseMarkdownImage(platform) === true, String(md.canUseMarkdownImage(platform)))
    }
    /**
     * ⚠️ `qqguild`（QQ 频道）在**这一份**名单里是 false —— 图片 md 只有 `qq` 认。
     * 它走的是另一套编码器，带尺寸的图片写法到那边是纯文本，图就变成一串代码
     * （3.7.2 引入图片 md 时就是这个结论，`smoke-md-image` 里那条用例盯着它）。
     * **文字** md（代码块 / 面板按钮）频道是认的 —— 那看 `supportsMarkdown`，别混。
     */
    for (const platform of ['qqguild', 'onebot', 'napcat', 'lagrange', 'go-cqhttp', 'chronocat', 'milky',
      'discord', 'telegram', 'kook', 'satori', 'wechat', 'feishu', 'dingtalk', 'bilibili', '']) {
      check((platform || '（空）') + ' → 不用 markdown 图片', md.canUseMarkdownImage(platform) === false, String(md.canUseMarkdownImage(platform)))
    }
    {
      /** 上面那条的反证：文字 md 的名单**仍然**包含 QQ 频道，两份名单不许合并 */
      check('  文字 md 仍然认 QQ 频道（图片 md 不认，两份名单有意分开）',
        qqPanel.supportsMarkdown('qqguild') === true && qqPanel.supportsMarkdown('qq') === true
        && qqPanel.supportsMarkdown('onebot') === false && md.canUseMarkdownImage('qqguild') === false)
    }
    {
      /**
       * 全仓库只允许 `compat/imageMarkdown.ts` 一处写这份正则 ——
       * Milky 就是靠「四份名单各写各的、都漏了它」溜过去的。
       */
      const files = ['compat/imageMarkdown.ts', 'karin/module/utils/ImageSlice.ts',
        'karin/module/utils/QqPanel.ts', 'karin/module/utils/ParseForward.ts']
      /**
       * 匹配 `/onebot|napcat|lagrange`（正则字面量开头那个斜杠要带上）——
       * `ImageSlice` 里还有个 `QQ_FAMILY`（`/^(qq|qqguild|onebot|…`）也会命中裸的那三个词，
       * 但那是「QQ 那一族」的另一份名单，不是这一份。
       */
      const owners = files.filter((file) =>
        /\/onebot\|napcat\|lagrange/.test(fs.readFileSync(path.join(root, 'src', file), 'utf8')))
      check('这份名单全仓库只有一处定义（在 compat/imageMarkdown.ts）',
        owners.length === 1 && owners[0] === 'compat/imageMarkdown.ts', owners.join(', '))
      /**
       * 两个判据**不能混**：`isOneBotLike` 问的是「走不走 OneBot 私有协议」（合并转发），
       * Milky 不是 OneBot；`canUseMarkdownImage` 是白名单，Milky 不在里面。
       */
      check('  两个判据没混成一个（milky 两个都不算）',
        md.isOneBotLike('milky') === false && md.canUseMarkdownImage('milky') === false
        && md.isOneBotLike('onebot') === true && md.canUseMarkdownImage('onebot') === false)
    }

    /**
     * 真的跑一遍 `sliceImageToElements`（错误卡片走的就是它）：
     * 空的 / 认不出来的平台也必须拿回**图片段**，绝不能是 markdown。
     * 用 1x1 的 data URI，不联网、也不用切片。
     */
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/AAf/AAAAAElFTkSuQmCC'
    /**
     * `qqguild` 也在这组里（图片 md 只有 `qq` 认，见上面 3.5 开头那组）。
     */
    for (const platform of ['onebot', 'qqguild', 'milky', 'discord', '']) {
      const out = await slice.sliceImageToElements([png], platform)
      const text = out === null ? '' : render(out)
      check((platform || '（空）') + ' → 返回图片段（不是 markdown）', !!text && !text.includes('[markdown]'), text.slice(0, 40))
    }
  }

  console.log('\n=== 4. 静态闸门：还有谁在造 <qqbot-cmd-input> ===')
  {
    /**
     * 允许出现 `cmdInput(` 的文件，以及它们的**闸门**。新文件进来就会红 ——
     * 那时请先确认「这个平台认 markdown 吗」，再决定是加闸门还是加进这张表。
     */
    const allowed = {
      'src/karin/module/utils/QqPanel.ts': '本文件自己：每处调用都在 supportsMarkdown(platformOf(e)) 分支里（cmdInput 也在这里定义）',
      'src/karin/apps/tools.ts': '候选表格那段是**死代码**（looksCard = false 直接 return next()），走不到',
      'src/karin/platform/bilibili/interactive-story.ts': 'buttons 由 supportsMarkdown 决定；OneBot 上走的是「回复「xxx」」纯文本',
      'src/index.ts': '包在 if (officialQq) 里（官方 QQ 专用分支）'
    }
    const walk = (dir, out = []) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full, out)
        else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
      }
      return out
    }
    const hitters = []
    for (const file of walk(path.join(root, 'src'))) {
      const source = fs.readFileSync(file, 'utf8')
      if (/[^A-Za-z]cmdInput\(/.test(source)) hitters.push(path.relative(root, file).replace(/\\/g, '/'))
    }
    check('调用点都在白名单里（新文件出现就要先想清平台闸门）',
      hitters.every((item) => !!allowed[item]), hitters.filter((item) => !allowed[item]).join(',') || hitters.join(', '))
    check('白名单里的文件都还在（删了要同步这张表）',
      Object.keys(allowed).every((item) => hitters.includes(item)),
      Object.keys(allowed).filter((item) => !hitters.includes(item)).join(',') || hitters.join(', '))

    /** `cmdInput` 定义处本身要带上「这是 markdown 私货」的说明，别哪天被当成通用工具用 */
    const panelSource = fs.readFileSync(path.join(root, 'src/karin/module/utils/QqPanel.ts'), 'utf8')
    const index = panelSource.indexOf('export function cmdInput')
    check('cmdInput 定义处写明了它认平台（别被当通用工具用）',
      index >= 0 && /markdown|qqbot|腾讯/i.test(panelSource.slice(index, index + 500)))
  }

  console.log('\n' + (failed ? '\u2718 有 ' + failed + ' 项没通过' : '\u2714 全部通过'))
  process.exit(failed ? 1 : 0)
})().catch((error) => {
  console.error('\n探针崩了：', error?.stack ?? error)
  process.exit(1)
})
