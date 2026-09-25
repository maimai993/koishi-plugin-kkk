/**
 * 冒烟测试：**真实**的互动剧情来源 `buildPlayerStorySource`（播放页按需取节点 / 取分段）。
 *
 * 为什么单独测它：这条链路是「编译不报错、线上才炸」的高风险区 ——
 * 构建用的是 `noCheck`，少 import 一个函数照样能出包。真实事故：
 * `buildPlayerStorySource` 里调 `fetchInteractiveNode` 却忘了 import，
 * 播放页表现就是「永远没有选项、/story 一律 404」，而所有冒烟都是绿的
 * （因为它们注入的是假 source）。这里注入**假请求**把真实现跑起来。
 *
 * 用法：node scripts/smoke-player-story-source.cjs
 */
const path = require('node:path')

const pluginRoot = path.resolve(__dirname, '..')
const { buildPlayerStorySource } = require(path.join(pluginRoot, 'lib/karin/platform/bilibili/bilibili.js'))

let failures = 0
const check = (name, ok, detail) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  —— ' + detail : ''))
  if (!ok) failures++
}

/** 假事件：剧情来源只把它转手给 Bilibili 实例，这里用不到真行为 */
const fakeEvent = { reply: async () => ({ messageId: 'm1' }), contact: { peer: 'group:1' } }

const urls = []
const request = async (url) => {
  urls.push(url)
  if (url.includes('/x/player/wbi/v2')) {
    return { code: 0, data: { interaction: { graph_version: 777, msg: '登录后才能体验全部结局哦～' } } }
  }
  if (url.includes('/x/stein/edgeinfo_v2')) {
    const edge = /edge_id=(\d+)/.exec(url)
    return {
      code: 0,
      data: edge
        ? {
            title: '第二段',
            is_leaf: 0,
            edges: { questions: [{ title: '第二段怎么走？', choices: [{ id: 21, cid: 4004, option: 'A 继续' }] }] }
          }
        : {
            title: '开场',
            is_leaf: 0,
            edges: {
              questions: [{
                title: '第一段怎么走？',
                choices: [
                  { id: 11, cid: 2002, option: 'A 向左走' },
                  { id: 12, cid: 3003, option: 'B 向右挖' }
                ]
              }]
            }
          }
    }
  }
  return null
}

const main = async () => {
  const source = buildPlayerStorySource({
    e: fakeEvent,
    bvid: 'BV1xx411c7mD',
    rootCid: 1001,
    headers: { Cookie: 'SESSDATA=fake' },
    islogin: true,
    request
  })

  console.log('[1] 接口形状')
  check('node / segment 都是函数（少 import 一个函数在这里就露馅）',
    typeof source.node === 'function' && typeof source.segment === 'function',
    'node=' + typeof source.node + ' segment=' + typeof source.segment)

  console.log('[2] 取根节点')
  const root = await source.node({ cid: 1001 })
  check('拿到节点（不是 null）', !!root, JSON.stringify(root))
  check('cid / 题目 / 是否结局',
    root && root.cid === 1001 && root.question === '第一段怎么走？' && root.isLeaf === false,
    JSON.stringify({ cid: root?.cid, question: root?.question, isLeaf: root?.isLeaf }))
  check('选项洗掉了自带编号，并带上 label / cid / edgeId',
    root && root.choices.length === 2 &&
    root.choices[0].label === 'A' && root.choices[0].text === '向左走' &&
    root.choices[0].cid === 2002 && root.choices[0].edgeId === 11 &&
    root.choices[1].text === '向右挖' && root.choices[1].cid === 3003 && root.choices[1].edgeId === 12,
    JSON.stringify(root && root.choices))
  check('先去问了剧情图版本号（播放器接口）',
    urls.some((u) => u.includes('/x/player/wbi/v2') && u.includes('bvid=BV1xx411c7mD') && u.includes('cid=1001')),
    urls[0])

  console.log('[3] 取下一段（带 edge_id）')
  const next = await source.node({ cid: 1001, edgeId: 11 })
  check('edgeinfo 请求带上了 graph_version 与 edge_id',
    urls.some((u) => u.includes('/x/stein/edgeinfo_v2') && u.includes('graph_version=777') && u.includes('edge_id=11')),
    urls[urls.length - 1])
  check('返回落地那一段的题干与选项',
    next && next.question === '第二段怎么走？' && next.choices.length === 1 && next.choices[0].cid === 4004,
    JSON.stringify(next))
  check('剧情图版本号只问了一次（缓存住了）',
    urls.filter((u) => u.includes('/x/player/wbi/v2')).length === 1,
    'wbi 请求 ' + urls.filter((u) => u.includes('/x/player/wbi/v2')).length + ' 次')

  console.log('[4] 接口抽风时不炸')
  const broken = buildPlayerStorySource({
    e: fakeEvent,
    bvid: 'BV1xx411c7mD',
    rootCid: 1001,
    headers: {},
    islogin: true,
    request: async () => ({ code: -404, message: '啥都没有' })
  })
  const none = await broken.node({ cid: 1001 })
  check('取不到版本号时返回 null（播放页退化成普通播放页，不抛异常）', none === null, JSON.stringify(none))

  console.log('')
  console.log(failures ? '失败 ' + failures + ' 项' : '全部通过')
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error('冒烟测试失败:', error && error.stack ? error.stack : error)
  process.exit(1)
})
