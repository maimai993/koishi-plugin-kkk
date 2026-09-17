/**
 * 冒烟测试：QQ 分享卡片解析与「无链接卡片」还原。
 *
 * 覆盖四种卡片形态 + 一条反例：
 *   1. meta.detail_1.qqdocurl（带 JSON 转义的 b23.tv 短链）→ 只要链接被还原出来即可（不触发搜索）
 *   2. meta.news 卡片，带封面 → 走封面哈希命中 B 站搜索
 *   3. meta.news 卡片，只有标题 → 走标题匹配
 *   4. 抖音卡片 → 识别成 douyin，不应触发 B 站搜索
 *   5. 不存在的标题 → 必须放弃还原（宁可解析失败也不能猜错）
 *
 * 用法：node scripts/smoke-qqcard.cjs
 */
const path = require('node:path')
const { Context } = require('koishi')

const pluginRoot = path.resolve(__dirname, '..')
const plugin = require(path.join(pluginRoot, 'lib', 'index.js'))

const dataPath = path.resolve(pluginRoot, 'data-smoke')
const ctx = new Context()
ctx.plugin(plugin, { dataPath, debug: true })

/** 一条卡片消息（JSON 转义过的斜杠，和 QQ 适配器塞进来的形态一致） */
const cardWithLink = '{"app":"com.tencent.structmsg","config":{"ctime":1700000000,"forward":1},"desc":"哔哩哔哩","meta":{"detail_1":{"appid":"1109937557","desc":"哔哩哔哩","qqdocurl":"https:\\/\\/b23.tv\\/aBcDeFg","title":"【测试】卡片视频"}},"prompt":"[分享] 卡片视频","view":"news"}'

const newsCard = (title, cover) => JSON.stringify({
  app: 'com.tencent.structmsg',
  view: 'news',
  desc: '哔哩哔哩',
  meta: { news: { appid: '1109937557', tag: '哔哩哔哩', title, ...(cover ? { preview: cover } : {}), jumpUrl: '' } },
  prompt: '[分享] ' + title
})

const douyinCard = JSON.stringify({
  app: 'com.tencent.structmsg',
  desc: '抖音',
  meta: { detail_1: { appid: '1109937556', title: '抖音短视频', desc: '抖音' } },
  prompt: '[分享] 抖音短视频'
})

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  —— ' + detail : ''))
}

setTimeout(async () => {
  try {
    const { resolveQqCardContent } = require(path.join(pluginRoot, 'lib/karin/module/utils/QqCardResolve.js'))
    const { parseQqCards } = require(path.join(pluginRoot, 'lib/compat/qqcard.js'))
    const { searchBilibiliVideos } = require(path.join(pluginRoot, 'lib/karin/platform/bilibili/search.js'))

    console.log('\n[1] 解析器：卡片字段抽取')
    const cards = parseQqCards(cardWithLink)
    check('detail_1 卡片被识别', cards.length === 1, 'cards=' + cards.length)
    check('平台判定为 bilibili', cards[0] && cards[0].platform === 'bilibili', cards[0] && cards[0].platform)
    check('标题抽取正确', cards[0] && cards[0].title === '【测试】卡片视频', cards[0] && cards[0].title)
    check('qqdocurl 被还原成正常链接', cards[0] && cards[0].urls.includes('https://b23.tv/aBcDeFg'), cards[0] && cards[0].urls.join(','))
    const dy = parseQqCards(douyinCard)
    check('抖音卡片判定为 douyin', dy[0] && dy[0].platform === 'douyin', dy[0] && dy[0].platform)

    console.log('\n[2] 带短链的卡片：不触发搜索，直接补链接')
    const withLink = await resolveQqCardContent(cardWithLink)
    check('文本里出现 b23.tv 链接', withLink.includes('b23.tv/aBcDeFg'), withLink.slice(-60))

    console.log('\n[3] 无链接卡片（带封面）：封面哈希命中')
    // 先用搜索接口拿一条真实结果的封面，再伪造一张「同封面、无链接」的卡片
    const probe = await searchBilibiliVideos({ keyword: '字幕君交流场所', title: '字幕君交流场所', limit: 5 })
    check('搜索接口可用', probe.length > 0, probe.length ? probe[0].bvid + ' ' + probe[0].title : '无结果')
    // 老视频的封面是 transparent.gif 占位图，取第一条真有稿件封面的结果来验封面哈希分支
    const target = probe.find((item) => /bfs\/archive/.test(item.pic))
    check('存在带稿件封面的结果', !!target, target ? target.bvid : '无')
    if (target) {
      // 搜索接口的 pic 偶发返回占位图（transparent.gif），这时封面没得比，
      // 最多重试 3 次，把「上游抽风」和「封面匹配坏了」区分开
      let hit = null
      for (let attempt = 0; attempt < 3 && !hit; attempt++) {
        const items = await searchBilibiliVideos({ keyword: target.title, title: target.title, cover: target.pic, limit: 5 })
        if (items[0] && items[0].coverMatch) hit = items[0]
      }
      check('同封面搜索时 coverMatch 命中', !!hit, hit ? hit.bvid + ' score=' + hit.score : '3 次都只拿到占位封面（上游抽风）')
      if (hit) {
        const resolved = await resolveQqCardContent(newsCard(target.title, target.pic))
        check('卡片按封面还原出 ' + target.bvid, resolved.includes('bilibili.com/video/' + target.bvid), resolved.slice(-70))
      }
    }

    console.log('\n[4] 无链接卡片（只有标题）：标题匹配')
    const titleOnly = await resolveQqCardContent(newsCard('字幕君交流场所', ''))
    check('还原出 BV1xx411c7mD', titleOnly.includes('BV1xx411c7mD'), titleOnly.slice(-70))

    console.log('\n[5] 反例：不存在的标题必须放弃还原')
    const junk = await resolveQqCardContent(newsCard('这个标题绝对不存在zzzq', ''))
    check('没有凭空造出链接', !/bilibili\.com\/video|b23\.tv/.test(junk), junk.slice(-70))

    console.log('\n[6] 抖音卡片不触发 B 站搜索')
    const dyResolved = await resolveQqCardContent(douyinCard)
    check('结果与普通文本一致', !/bilibili\.com/.test(dyResolved), dyResolved.slice(-50))

    const failed = results.filter((item) => !item.ok)
    console.log('\n=== ' + (results.length - failed.length) + '/' + results.length + ' 通过 ===')
    process.exitCode = failed.length ? 1 : 0
  } catch (error) {
    console.error('冒烟测试失败:', error && error.stack ? error.stack : error)
    process.exitCode = 1
  }
  process.exit(process.exitCode || 0)
}, 4000)
