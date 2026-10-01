/**
 * 探针：「提取封面图 / 提取评论区图片」这两个**回调按钮最多只触发一次**。
 *
 * 用户原话：「提取图片的回调按钮最多只能触发一次，不然点一直点，不知道谁在刷屏」。
 *
 * QQ 的原生回调按钮（`action.type = 1`）是**发出去就收不回**的东西：QQ 那边不会记住
 * 「这个按钮点过了」，所以只能由插件自己拦 —— 这里就把拦的那段（真 `handleExtractCard`）
 * 跑起来，逐条验证：
 *   ① 第一次点：正常出图；
 *   ② 再点（同一个人 / 换个人）：**静默忽略**，群里不再多一条，日志里记下是谁在点；
 *   ③ 封面按钮和评论按钮是两件事，互不影响；
 *   ④ 换作品互不影响；
 *   ⑤ **重新解析会重新武装**（新卡片发出来，按钮又能点一次）—— 不然就永久锁死了；
 *   ⑥ **手敲指令不受限**（留一条明确的路，图发不出来时还能重试）；
 *   ⑦ 这次没发出去（图过期 / 发送失败）**不算「点过了」**，再点还能成；
 *   ⑧ 记录跟着缓存一起 15 分钟过期。
 *
 * 走的是**真产物**（`lib/karin/apps/tools.js` 里 `extractCardAPP` 的 handler），
 * 只把「量图片尺寸」「把图片地址落地」这两步打桩 —— 那是网络活，与本次要验的逻辑无关。
 * 不联网、不连 QQ、不碰用户配置、不写任何文件（dataRoot 用临时目录）。
 *
 * 用法：node scripts/probe-extract-once.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const lib = path.join(__dirname, '..', 'lib')

/**
 * **先把运行环境打桩，再 require 业务模块。**
 *
 * `Config` / `runtime` / `logger` 都是在业务模块 **import 期**就被读到的
 * （比如 `tools.ts` 里 `priority: Config.app.videoTool ? …` 就是模块级表达式），
 * 所以顺序不能反，否则整个 require 直接抛。
 */
const runtime = require(path.join(lib, 'compat/runtime.js'))
runtime.bindRuntime({
  ctx: { config: { port: 5200 } },
  /**
   * `errorNoCard: true` —— 出错只发文字、不渲染错误卡片。
   * 第 7b 段会故意让发送失败，那时异常会流进错误处理器；不关掉卡片渲染的话
   * 探针要凭空渲染一张几 MB 的大图（还要切片、发到几个账号），与本次要验的东西无关。
   */
  config: { app: {}, errorNoCard: true },
  dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'kkk-probe-extract-once-'))
})

/** 接住日志：要断言「谁在刷屏」真的被记下来了 */
const marks = []
const warns = []
require(path.join(lib, 'compat/logger.js')).setLogger({
  debug () {},
  info: (message) => marks.push(String(message)),
  warn: (message) => warns.push(String(message)),
  error () {}
})

const Config = require(path.join(lib, 'karin/module/utils/Config.js'))
Config.Config = {
  /** EmojiReply 关掉：不然每次调用都会去尝试给消息加表情（探针里没有真 bot） */
  app: { EmojiReply: false, videoTool: false, videoSendMode: 'url' },
  amagi: { cookies: {} },
  bilibili: {},
  douyin: {},
  kuaishou: {},
  xiaohongshu: {}
}

const ImageHelper = require(path.join(lib, 'karin/module/utils/ImageHelper.js'))
const QqPanel = require(path.join(lib, 'karin/module/utils/QqPanel.js'))
const CardImageCache = require(path.join(lib, 'karin/module/utils/CardImageCache.js'))
const tools = require(path.join(lib, 'karin/apps/tools.js'))

/** 量尺寸那一步（会去下载图片）：换成固定串，断言里只关心「发了几次」 */
QqPanel.buildMarkdownImageMessage = async (urls) =>
  urls?.length ? { type: 'markdown', attrs: { content: urls.map((url) => '![cover](' + url + ')').join('\n') } } : undefined
/** 把图片地址落地那一步（会去下载 / 转 base64）：原样返回 */
ImageHelper.processImageUrls = async (urls) => urls

/**
 * 错误处理器也打桩。
 *
 * 第 7b 段要验「发送失败时不该占用额度」，那就必须真的让 `e.reply` 抛一次 ——
 * 异常会流进 `wrapWithErrorHandler` 的错误分支。真实的错误处理会上报（联网）、
 * 给主人 / 管理员发通知，探针里既没网也没账号，全打掉即可。
 * （上面 `errorNoCard` 已经省掉了渲染那一步。）
 */
const errorReport = require(path.join(lib, 'karin/module/utils/ErrorReport.js'))
errorReport.uploadErrorReport = async () => null
const errorSender = require(path.join(lib, 'karin/module/utils/ErrorHandler/sender.js'))
for (const name of ['sendErrorToTrigger', 'sendErrorToMaster', 'sendErrorToAllMasters', 'sendErrorToAdmins', 'sendErrorToConfiguredIds']) {
  errorSender[name] = async () => {}
}

let failed = 0
const check = (name, ok, detail) => {
  console.log((ok ? '  ✔ ' : '  ✘ ') + name + (detail ? '  → ' + detail : ''))
  if (!ok) failed++
}
/** 章节标题 */
const section = (title) => console.log('\n=== ' + title + ' ===')

/**
 * 造一条假消息。
 * @param opts.msg 指令原文（按钮回调的 data 拼上 `#` 后就是它）
 * @param opts.button 是不是 QQ 回调按钮点出来的（决定 `session.type`）
 * @param opts.userId 谁点的
 * @param opts.peer 会话
 */
const makeMessage = (opts) => {
  const replies = []
  const e = {
    msg: opts.msg,
    userId: opts.userId ?? 'user-1',
    selfId: 'self-1',
    groupId: 'group-1',
    isGroup: true,
    isPrivate: false,
    channelId: opts.peer ?? 'group-1',
    contact: { peer: opts.peer ?? 'group-1', guildId: 'group-1', isGroup: true, userId: opts.userId ?? 'user-1' },
    sender: { userId: opts.userId ?? 'user-1', nick: '触发者' },
    messageId: 'msg-1',
    /** 关键判据：回调按钮 = `interaction/button`，手敲 / 蓝字链 = `message` */
    session: { type: opts.button ? 'interaction/button' : 'message' },
    bot: { adapter: { name: 'adapter-qq-crack' } },
    reply: async (content) => {
      replies.push(content)
      return [{ id: 'r' + replies.length }]
    }
  }
  return { e, replies }
}

/** 发出去的东西是不是「图」（markdown 段里带了图片） */
const hasImage = (content) => /!\[[^\]]*\]\([^)\s]+\)/.test(JSON.stringify(content ?? ''))

/** 跑一次 handler（真产物里那个被 wrapWithErrorHandler 包过的） */
const click = async (opts) => {
  const { e, replies } = makeMessage(opts)
  await tools.extractCardAPP.handler(e, () => undefined)
  return replies
}

const COVER_KEY = CardImageCache.cardImageKeyOf('bilibili', 'BV1JSan6GEFW')
const COMMENT_KEY = CardImageCache.cardImageKeyOf('douyin', '7123456789')
const OTHER_KEY = CardImageCache.cardImageKeyOf('kuaishou', 'photo-9')

const armCover = (key) => CardImageCache.rememberCardImages(key, { cover: 'https://cdn/' + key + '/cover.jpg' })
const armComment = (key) => CardImageCache.rememberCardImages(key, { commentPics: ['https://cdn/' + key + '/c1.jpg'] })

;(async () => {
  try {
    section('1. 第一次点：正常出图')
    {
      armCover(COVER_KEY)
      const replies = await click({ msg: '#kkk封面 ' + COVER_KEY, button: true, userId: 'user-A' })
      check('点一次 → 出图一条', replies.length === 1 && hasImage(replies[0]), '发送 ' + replies.length + ' 次')
    }

    section('2. 再点：静默忽略，不再刷屏')
    {
      /** 同一个人连点 */
      const again = await click({ msg: '#kkk封面 ' + COVER_KEY, button: true, userId: 'user-A' })
      check('同一个人再点 → 一条都不发', again.length === 0, '发送 ' + again.length + ' 次')
      /** 换个人点，同样拦掉（拦的是「这张卡片这个按钮」，不是「这个人」） */
      const other = await click({ msg: '#kkk封面 ' + COVER_KEY, button: true, userId: 'user-B' })
      check('换个人点 → 也拦掉（群里就是同一张图，谁点都不再发）', other.length === 0, '发送 ' + other.length + ' 次')
      const spam = marks.filter((line) => line.includes('重复点击'))
      /** 前两次点击各产生一条：第一条说「user-A 又点了一次」，第二条说「user-B 也在点，但 user-A 已经点过了」 */
      check(
        '日志里记下了「谁在点」（这次点的 + 第一次点的都要有）',
        spam.length === 2 && spam[1].includes('user-B') && spam[1].includes('user-A'),
        spam[1] ?? '(没有这条日志)'
      )
    }

    section('3. 封面 / 评论是两个按钮，互不影响')
    {
      armComment(COMMENT_KEY)
      const comment = await click({ msg: '#kkk评论 ' + COMMENT_KEY, button: true, userId: 'user-B' })
      check('评论区按钮照常能用（没被封面那次点击带累）', comment.length === 1 && hasImage(comment[0]), '发送 ' + comment.length + ' 次')
      const commentAgain = await click({ msg: '#kkk评论 ' + COMMENT_KEY, button: true, userId: 'user-C' })
      check('评论按钮自己也只能点一次', commentAgain.length === 0, '发送 ' + commentAgain.length + ' 次')
    }

    section('4. 换作品互不影响')
    {
      armCover(OTHER_KEY)
      const card2 = await click({ msg: '#kkk封面 ' + OTHER_KEY, button: true, userId: 'user-A' })
      check('另一个作品的封面按钮可以点', card2.length === 1 && hasImage(card2[0]), '发送 ' + card2.length + ' 次')
      const u1 = await click({ msg: '#kkk评论 ' + COMMENT_KEY, button: true, userId: 'user-A' }) // 评论那条还是 user-B 点过
      check('缓存里两件作品各记各的，不会串', u1.length === 0, '发送 ' + u1.length + ' 次')
    }

    section('5. 重新发一次链接（新卡片）→ 按钮重新可用')
    {
      /** 同一个作品又解析了一遍：`rememberCardImages` 会顺手清掉「点过了」记录 */
      armCover(COVER_KEY)
      const reArmed = await click({ msg: '#kkk封面 ' + COVER_KEY, button: true, userId: 'user-C' })
      check('新卡片下面的按钮又能点一次（不会被永久锁死）', reArmed.length === 1 && hasImage(reArmed[0]), '发送 ' + reArmed.length + ' 次')
      const third = await click({ msg: '#kkk封面 ' + COVER_KEY, button: true, userId: 'user-C' })
      check('新卡片上也只放行一次', third.length === 0, '发送 ' + third.length + ' 次')
    }

    section('6. 手敲指令不受限（留一条明确的路）')
    {
      /** 上一步刚被 user-C 点过，这里手敲两次都该出图 */
      /** 先记下水线：只检查「手敲这一段」有没有新写日志（上面按钮那几段的日志不能算进来） */
      const before = marks.length
      const typed1 = await click({ msg: 'kkk封面 ' + COVER_KEY, button: false, userId: 'user-D' })
      const typed2 = await click({ msg: 'kkk封面 ' + COVER_KEY, button: false, userId: 'user-D' })
      check('手敲（不是按钮）→ 两次都出图', typed1.length === 1 && typed2.length === 1 && hasImage(typed2[0]), typed1.length + ' / ' + typed2.length)
      check('手敲不会往「谁在刷屏」日志里写东西', !marks.slice(before).some((line) => line.includes('重复点击')), marks.slice(before).join(' | ') || '(没有新日志)')
      /** 旧 `#` 写法同样是「手敲」口径 */
      const hashTyped = await click({ msg: '#kkk封面 ' + COVER_KEY, button: false, userId: 'user-D' })
      check('旧 `#kkk封面` 写法也照常', hashTyped.length === 1, '发送 ' + hashTyped.length + ' 次')
    }

    section('7. 这次没发出去，不算「点过了」')
    {
      const emptyKey = CardImageCache.cardImageKeyOf('xiaohongshu', 'note-empty')
      /** 缓存里什么都没有：按钮点了只会得到一句提示 */
      const miss = await click({ msg: '#kkk封面 ' + emptyKey, button: true, userId: 'user-E' })
      check('没图 → 回一句提示（不是图）', miss.length === 1 && !hasImage(miss[0]), '发送 ' + miss.length + ' 次')
      /** 关键：这次不该占用掉额度 —— 等图有了再点必须能成 */
      CardImageCache.rememberCardImages(emptyKey, { cover: 'https://cdn/k/cover.jpg' })
      const retry = await click({ msg: '#kkk封面 ' + emptyKey, button: true, userId: 'user-E' })
      check('图补上后再点 → 能出图（失败没占额度）', retry.length === 1 && hasImage(retry[0]), '发送 ' + retry.length + ' 次')
    }
    {
      /** 过期的那条路：作品键在缓存里根本不存在（= 按钮没带参数、也没解析记录） */
      const { e } = makeMessage({ msg: '#kkk封面', button: true, userId: 'user-F' })
      e.contact.peer = 'group-elsewhere'
      e.channelId = 'group-elsewhere'
      const replies = []
      e.reply = async (content) => { replies.push(content); return [{ id: 'x' }] }
      await tools.extractCardAPP.handler(e, () => undefined)
      check('作品键都拿不到 → 也是提示，不抛错', replies.length === 1 && !hasImage(replies[0]), '发送 ' + replies.length + ' 次')
    }

    {
      /**
       * **发送那一步报错时也不该占用额度。**
       *
       * 这条是真跑的：把 `e.reply` 换成抛错，异常会一路走到 `wrapWithErrorHandler`
       * 的错误分支（错误上报 / 发通知已在上面的打桩里换成空实现）。
       * 如果实现里漏了 `release`，下面那次重试就会被自己的「已点过」记录挡住 ——
       * 群里表现成「这张卡片再也发不出图了」。
       */
      const failKey = CardImageCache.cardImageKeyOf('bilibili', 'BVfail')
      armCover(failKey)
      const { e } = makeMessage({ msg: '#kkk封面 ' + failKey, button: true, userId: 'user-Z' })
      e.reply = async () => { throw new Error('模拟发送失败') }
      let threw = false
      try {
        await tools.extractCardAPP.handler(e, () => undefined)
      } catch {
        threw = true
      }
      console.log('  · 发送抛错后 handler ' + (threw ? '把错误抛了出来（错误处理器没接住）' : '由错误处理器接住并返回'))
      const retry = await click({ msg: '#kkk封面 ' + failKey, button: true, userId: 'user-Z' })
      check('发送失败 → 不算「点过了」，再点一次还能出图', retry.length === 1 && hasImage(retry[0]), '发送 ' + retry.length + ' 次')
      const afterRetry = await click({ msg: '#kkk封面 ' + failKey, button: true, userId: 'user-Z' })
      check('重试成功之后才真正占用（第三次点被拦）', afterRetry.length === 0, '发送 ' + afterRetry.length + ' 次')
    }

    section('8. 记录跟着缓存一起过期（15 分钟）')
    {
      const ttlKey = CardImageCache.cardImageKeyOf('bilibili', 'BVttl')
      armCover(ttlKey)
      check('先占一次 → true', CardImageCache.claimCardImageExtract(ttlKey, 'cover', 'user-G') === true)
      check('紧接着再占 → false（拦住了）', CardImageCache.claimCardImageExtract(ttlKey, 'cover', 'user-G') === false)
      /** 把时间拨过 TTL：记录和缓存一起被 sweep 清掉 */
      const realNow = Date.now
      Date.now = () => realNow() + 16 * 60 * 1000
      try {
        check('过了 15 分钟 → 记录跟着过期，又能占了', CardImageCache.claimCardImageExtract(ttlKey, 'cover', 'user-H') === true)
        check('同一时刻缓存也过期了', CardImageCache.recallCardImages(ttlKey) === undefined)
      } finally {
        Date.now = realNow
      }
    }

    section('9. release / 隔离的最小口径')
    {
      const k = CardImageCache.cardImageKeyOf('bilibili', 'BVdirect')
      CardImageCache.claimCardImageExtract(k, 'cover', 'u')
      CardImageCache.releaseCardImageExtract(k, 'cover')
      check('release 之后又能占（发送失败重试靠它）', CardImageCache.claimCardImageExtract(k, 'cover', 'u') === true)
      check('release 只撤销自己那一种，不碰另一种', CardImageCache.claimCardImageExtract(k, 'comment', 'u') === true)
      CardImageCache.releaseCardImageExtract(k, 'cover')
      check('撤销封面后，评论那条记录还在', CardImageCache.recallCardImageExtract(k, 'comment')?.by === 'u')
      check('空作品键不参与拦截（拿不到键时不该把所有点击都堵死）', CardImageCache.claimCardImageExtract('', 'cover', 'u') === true)
    }

    section('10. 源码守卫：只在「按钮」那条路上判一次')
    {
      /** 先剥注释再匹配 —— 注释里写到的函数名会把断言带偏（这个坑踩过两次） */
      const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      const src = stripComments(fs.readFileSync(path.join(lib, 'karin/apps/tools.js'), 'utf8'))
      check('判据是会话类型 `interaction/button`', /e\?\.session\?\.type[\s\S]{0,40}===\s*'interaction\/button'/.test(src))
      check('只在 fromButton 为真时才占用', /if\s*\(\s*fromButton\s*&&\s*!\s*\(0,\s*CardImageCache_1\.claimCardImageExtract\)/.test(src))
      check('claim 全文只出现一次（别处不许再判一遍）', (src.match(/claimCardImageExtract\)\(/g) ?? []).length === 1, String((src.match(/claimCardImageExtract\)\(/g) ?? []).length))
      check('两条失败路都 release 了（没图 / 发送报错）', (src.match(/releaseCardImageExtract\)\(/g) ?? []).length === 2, String((src.match(/releaseCardImageExtract\)\(/g) ?? []).length))
      const cacheSrc = stripComments(fs.readFileSync(path.join(lib, 'karin/module/utils/CardImageCache.js'), 'utf8'))
      check('重新记图时会清掉旧记录（重新武装）', /extracted\.delete\(/.test(cacheSrc))
    }

    console.log('\n' + (failed ? '✘ 有 ' + failed + ' 项没通过' : '✔ 全部通过' + (warns.length ? '（warn ' + warns.length + ' 条）' : '')))
  } catch (error) {
    console.error('探针自身出错:', error)
    failed++
  } finally {
    process.exit(failed ? 1 : 0)
  }
})()
