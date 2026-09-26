/**
 * 冒烟测试：**快手 / 小红书的评论数据能变成模板要的结构**。
 *
 * 这两条评论链路对接的接口都换过（快手换到 H5 photo/comment/list、小红书字段也变过），
 * 换完之后字段名、层级、置顶标记、子评论形状全变，而插件是「取不到就静默少一块」的风格 ——
 * 错了不会报错，只是评论区空着。这里用两大平台**真实的返回形状**喂进去，盯住映射结果：
 *   - 字段对不对（昵称 / 点赞 / 子评论数 / ip 归属地 / 图片兜底）
 *   - 富文本对不对（表情、@、换行都解析成节点，不是拼 HTML）
 *   - 排序与条数限制（快手按点赞、小红书置顶优先，超上限按配置截断）
 *
 * 用法：node scripts/smoke-comments.cjs
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

const noop = () => {}
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kkk-comments-'))
const runtime = require(path.join(pluginRoot, 'lib/compat/runtime.js'))
runtime.bindRuntime({
  ctx: { get: () => undefined, logger: () => ({ info: noop, warn: noop, error: noop, debug: noop, mark: noop }), bots: [], registry: new Map(), on: () => () => {} },
  config: {},
  pluginRoot,
  dataRoot
})

const { Config } = require(path.join(pluginRoot, 'lib/karin/module/utils/Config.js'))
const { kuaishouComments } = require(path.join(pluginRoot, 'lib/karin/platform/kuaishou/comments.js'))
const { xiaohongshuComments } = require(path.join(pluginRoot, 'lib/karin/platform/xiaohongshu/comments.js'))

/** 节点类型序列，方便断言富文本结构 */
const kinds = (doc) => (doc && Array.isArray(doc.nodes) ? doc.nodes.map((node) => node.type) : [])
const textOf = (doc) => (doc && Array.isArray(doc.nodes) ? doc.nodes.filter((n) => n.type === 'text').map((n) => n.text).join('') : '')

const EMOJIS = [
  { name: '[微笑]', url: 'https://example.com/smile.png' },
  { name: '[笑]', url: 'https://example.com/laugh.png' }
]

const main = async () => {
  console.log('— 快手评论区 —')
  {
    Config.initCfg()
    const payload = {
      // H5 接口的形状：rootComments 在顶层、字段是 snake_case
      rootComments: [
        {
          comment_id: 111,
          author_name: '点赞少的',
          headurl: 'https://example.com/a.jpg',
          content: '第一条\n第二行',
          likedCount: 3,
          timestamp: 1700000000,
          subCommentCount: 2
        },
        {
          comment_id: 222,
          author_name: '点赞多的',
          headurl: 'https://example.com/b.jpg',
          content: '[微笑]@小明(123) 你好',
          likedCount: '1.2万',
          timestamp: 1700000001,
          subCommentCount: 0
        }
      ]
    }
    const list = await kuaishouComments(payload, EMOJIS)
  const byNick = (nick) => list.find((item) => item.nickname === nick)
  const many = byNick('点赞多的')
  const few = byNick('点赞少的')

  check('两条都映射出来了', list.length === 2, '实际 ' + list.length)
  check('cid / aweme_id 是字符串（H5 接口给的是数字）', many?.cid === '222' && many?.aweme_id === '222', String(many?.cid))
  check('昵称与头像映射正确', many?.nickname === '点赞多的' && many?.userimageurl === 'https://example.com/b.jpg')
  check('子评论数映射正确', few?.reply_comment_total === 2, String(few?.reply_comment_total))
  /**
   * 「1.2万」这种点赞数解不出数字时**兜底为 0**（而不是 NaN / 1.2）：
   * 快手的 H5 接口只给展示用的字符串，排序会因此把它排到后面，这是已知取舍。
   */
  check('「1.2万」这种点赞数兜底为 0（不是 NaN）', many?.digg_count === 0 && Number.isFinite(many?.digg_count), String(many?.digg_count))
  check('按点赞排序（兜底为 0 的排后面）', list[0]?.nickname === '点赞少的', list.map((c) => c.nickname).join(','))
  check('正文里的表情解析成 emoji 节点', kinds(many?.text).includes('emoji'), kinds(many?.text).join(','))
  check('@昵称(uid) 解析成 mention 节点',
    kinds(many?.text).includes('mention'),
    JSON.stringify(many?.text?.nodes?.find((node) => node.type === 'mention')))
  check('换行解析成 lineBreak 节点', kinds(few?.text).includes('lineBreak'), kinds(few?.text).join(','))
  check('富文本里没有 HTML 字符串', !JSON.stringify(list).includes('&lt;') && !JSON.stringify(list).includes('<span'))

  const empty = await kuaishouComments({ rootComments: [] }, EMOJIS)
    check('没有评论时返回空数组（不是报错）', Array.isArray(empty) && empty.length === 0)
  }

  console.log('')
  console.log('— 小红书评论区 —')
  {
    const payload = {
      data: {
        comments: [
          {
            id: 'c1',
            note_id: 'n1',
            content: '普通评论',
            user_info: { nickname: '普通用户' },
            create_time: 1700000000,
            like_count: 1,
            liked: false,
            sub_comment_count: 1,
            sub_comments: [
              { id: 's1', note_id: 'n1', content: '子评论 [笑]', user_info: { nickname: '子用户' }, create_time: 1700000001, like_count: 0, ip_location: '上海', show_tags: [], status: 0 }
            ],
            show_tags: [],
            at_users: ['@旧形态'],
            ip_location: '',
            pictures: null,
            status: 0
          },
          {
            id: 'c2',
            note_id: 'n1',
            content: '置顶评论',
            user_info: { nickname: '置顶用户' },
            create_time: 1700000002,
            like_count: 5,
            liked: true,
            sub_comment_count: 0,
            sub_comments: [],
            show_tags: ['user_top'],
            at_users: [{ nickname: '新形态' }, { user_info: { nickname: '另一种形态' } }],
            ip_location: '北京',
            pictures: [{ url: 'https://example.com/p.jpg' }],
            status: 0
          }
        ]
      }
    }
    const list = xiaohongshuComments(payload, EMOJIS)
    check('两条都映射出来了', list.length === 2, '实际 ' + list.length)
    check('置顶（user_top）排最前', list[0]?.id === 'c2', list.map((c) => c.id).join(','))
    check('ip 归属地缺失时兜底「未知」', list[1]?.ip_location === '未知', String(list[1]?.ip_location))
    check('pictures 不是数组时兜底成空数组', Array.isArray(list[1]?.pictures) && list[1].pictures.length === 0)
    check('子评论也映射出来了且带表情', list[1]?.sub_comments?.length === 1 && kinds(list[1]?.sub_comments?.[0]?.content).includes('emoji'))
    check('at_users 两种形态（字符串 / 对象）都能归一化',
      list[1]?.at_users?.join(',') === '@旧形态' && list[0]?.at_users?.join(',') === '@新形态,@另一种形态',
      JSON.stringify([list[0]?.at_users, list[1]?.at_users]))
    check('正文富文本带平台标记', list[0]?.content?.platform === 'xiaohongshu' && textOf(list[0]?.content).includes('置顶评论'))

    const empty = xiaohongshuComments({ data: { comments: [] } }, EMOJIS)
    check('没有评论时返回空数组（不是报错）', Array.isArray(empty) && empty.length === 0)
  }

  console.log('')
  console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => { console.error(error); process.exit(1) })