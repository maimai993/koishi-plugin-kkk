/**
 * B站互动视频（剧情选项）冒烟测试。
 *
 * 全是纯逻辑 + 假请求：
 *   · 选项文字清洗（B站 自己带的 `A 向左走` 前缀、以及 `A.B.C` / `1 2 3` 这类噪音）；
 *   · edgeinfo_v2 响应解析（真实响应结构，从线上接口抄下来的）；
 *   · 用户回 `A` / `1` / 选项原文 → 选项序号；
 *   · 剧情会话的存取与过期；
 *   · 联网那段用注入的假请求，顺带验证 URL 里带没带 graph_version / edge_id。
 *
 * 用法：node scripts/smoke-interactive.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const pluginRoot = path.resolve(__dirname, '..')
const libRoot = path.join(pluginRoot, 'lib')

const failures = []
let passed = 0
const check = (name, condition, detail) => {
  if (condition) {
    passed++
    console.log('  ✓ ' + name)
  } else {
    failures.push(name + (detail ? ' → ' + detail : ''))
    console.log('  ✗ ' + name + (detail ? ' → ' + detail : ''))
  }
}

const noop = () => {}
const runtime = require(path.join(libRoot, 'compat', 'runtime.js'))
runtime.bindRuntime({
  ctx: {
    get: () => undefined,
    logger: () => ({ info: noop, warn: noop, error: noop, debug: noop, mark: noop }),
    bots: [],
    registry: new Map(),
    on: noop,
    middleware: noop
  },
  config: { app: {} },
  dataRoot: path.join(pluginRoot, 'data-smoke-interactive'),
  pluginRoot,
  master: () => []
})

const interactive = require(path.join(libRoot, 'karin', 'module', 'utils', 'InteractiveVideo.js'))
const {
  cleanChoiceText,
  isJunkChoice,
  choiceLabel,
  parseInteractiveNode,
  parseChoiceInput,
  fetchInteractiveInfo,
  fetchInteractiveNode,
  rememberInteractiveSession,
  getInteractiveSession,
  clearInteractiveSession,
  interactiveSessionCount,
  interactiveKey,
  formatInteractivePath,
  INTERACTIVE_TTL_MS
} = interactive

/** 线上真实根节点响应（BV1xDgL6SEzk，option 自带 A/B/C/D 前缀） */
const rootFixture = {
  code: 0,
  message: 'OK',
  data: {
    title: '点进来帮史蒂夫做出选择！不用下载点击就玩！【互动视频+3种真结局+10个成就】',
    edge_id: 0,
    is_leaf: 0,
    edges: {
      questions: [
        {
          id: 0,
          type: 2,
          title: '',
          choices: [
            { id: 47666682, cid: 41124561111, option: 'A 向左走', is_default: 1 },
            { id: 47666683, cid: 40853834820, option: 'B 向右挖' },
            { id: 47666684, cid: 40853834584, option: 'C 向下挖' },
            { id: 47666685, cid: 41166178276, option: 'D 向左走(二周目)' }
          ]
        }
      ]
    },
    story_list: [{ node_id: 1, edge_id: 1, title: '开场', cid: 41156151510, is_current: 1 }]
  }
}

/** 带噪音与脏数据的响应：编号噪音、纯标点、缺 cid 的坏选项 */
const messyFixture = {
  code: 0,
  data: {
    title: '测试剧情',
    is_leaf: 0,
    edges: {
      questions: [
        {
          title: '第一题',
          choices: [
            { id: 1, cid: 101, option: 'A.B.C' },
            { id: 2, cid: 102, option: '1 2 3' },
            { id: 3, cid: 103, option: '（2）真的选项' },
            { id: 4, cid: 0, option: 'D 坏选项（没有 cid）' },
            { id: 5, option: 'E 坏选项（没有 cid）' }
          ]
        }
      ]
    }
  }
}

/** 整道题都是噪音：不能把选项全丢光，否则用户没得点 */
const allJunkFixture = {
  code: 0,
  data: {
    title: '测试剧情',
    edges: { questions: [{ title: '', choices: [{ id: 7, cid: 107, option: 'A.B.C' }, { id: 8, cid: 108, option: '1 2 3' }] }] }
  }
}

const choice = (index, text, edgeId, cid, label) => ({ index, label, text, edgeId, cid })

console.log('== 选项文字清洗 ==')
check('去掉 A 前缀', cleanChoiceText('A 向左走') === '向左走', cleanChoiceText('A 向左走'))
check('去掉 B 前缀（无空格）', cleanChoiceText('B、向右挖') === '向右挖', cleanChoiceText('B、向右挖'))
check('去掉括号数字编号', cleanChoiceText('（1）向左走') === '向左走', cleanChoiceText('（1）向左走'))
check('去掉 1. 编号', cleanChoiceText('1.向下挖') === '向下挖', cleanChoiceText('1.向下挖'))
check('去掉结尾编号噪音 A.B.C', cleanChoiceText('向左走 A.B.C') === '向左走', cleanChoiceText('向左走 A.B.C'))
check('去掉结尾编号噪音 1 2 3', cleanChoiceText('向右挖 1 2 3') === '向右挖', cleanChoiceText('向右挖 1 2 3'))
check('正常文字不被误伤（首字母是单词的一部分）', cleanChoiceText('Block 摆放') === 'Block 摆放', cleanChoiceText('Block 摆放'))
check('压掉多余空格', cleanChoiceText('A   向左走') === '向左走', cleanChoiceText('A   向左走'))
check('零宽字符被清掉', cleanChoiceText('向左\u200b走') === '向左走', JSON.stringify(cleanChoiceText('向左\u200b走')))

console.log('== 噪音判定 ==')
check('A.B.C 是噪音', isJunkChoice('A.B.C'))
check('1 2 3 是噪音', isJunkChoice('1 2 3'))
check('纯标点是噪音', isJunkChoice('...'))
check('空字符串是噪音', isJunkChoice(''))
check('正常文字不是噪音', !isJunkChoice('向左走'))
check('360P 不是噪音（有字母有数字但是个正常选项）', !isJunkChoice('360P'))
check('标签：第 1 个是 A', choiceLabel(0) === 'A')
check('标签：第 26 个是 Z', choiceLabel(25) === 'Z')
check('标签：超过 26 个退回数字', choiceLabel(26) === '27', choiceLabel(26))

console.log('== 真实响应解析 ==')
const root = parseInteractiveNode(rootFixture, { bvid: 'BV1xDgL6SEzk', graphVersion: 1722536, cid: 41156151510 })
check('解析出 4 个选项', root && root.choices.length === 4, String(root && root.choices.length))
check('选项文字去掉了自带编号', root.choices[0].text === '向左走' && root.choices[1].text === '向右挖', root.choices.map((c) => c.text).join('|'))
check('标签按顺序重新给 A/B/C/D', root.choices.map((c) => c.label).join('') === 'ABCD', root.choices.map((c) => c.label).join(''))
check('保留 edgeId 与 cid', root.choices[0].edgeId === 47666682 && root.choices[0].cid === 41124561111, JSON.stringify(root.choices[0]))
check('默认分支标记保留', root.choices[0].isDefault === true && root.choices[1].isDefault === false, String(root.choices[1].isDefault))
check('题目为空串也不报错', root.question === '', JSON.stringify(root.question))
check('不是结局节点', root.isLeaf === false)
check('标题带过来了', root.title.startsWith('点进来帮史蒂夫'), root.title.slice(0, 12))

console.log('== 脏数据解析 ==')
const messy = parseInteractiveNode(messyFixture, { bvid: 'BVTEST', graphVersion: 1, cid: 100 })
check('丢掉纯编号选项，只留正经选项', messy.choices.length === 1, messy.choices.map((c) => c.text).join('|'))
check('留下的正经选项文字干净', messy.choices[0].text === '真的选项', messy.choices[0].text)
check('缺 cid 的坏选项被丢掉', !messy.choices.some((c) => c.rawText.includes('没有 cid')), messy.choices.map((c) => c.rawText).join('|'))
check('序号重新从 0 开始', messy.choices[0].index === 0 && messy.choices[0].label === 'A', messy.choices[0].label)
const allJunk = parseInteractiveNode(allJunkFixture, { bvid: 'BVTEST', graphVersion: 1, cid: 100 })
check('整道题都是噪音时保留选项（不能让用户没得点）', allJunk.choices.length === 2, String(allJunk.choices.length))
check('没有 choices 的节点算结局', parseInteractiveNode({ code: 0, data: { title: 'x', is_leaf: 1, edges: { questions: [] } } }, { bvid: 'b', graphVersion: 1, cid: 1 }).isLeaf === true)
check('空响应返回 null', parseInteractiveNode(null, { bvid: 'b', graphVersion: 1, cid: 1 }) === null)

console.log('== 用户回复解析 ==')
const choices = [choice(0, '向左走', 11, 101, 'A'), choice(1, '向右挖', 12, 102, 'B'), choice(2, '向下挖', 13, 103, 'C')]
check('回 A', parseChoiceInput('A', choices) === 0)
check('回小写 a', parseChoiceInput('a', choices) === 0)
check('回全角 Ａ', parseChoiceInput('Ａ', choices) === 0)
check('回数字 2', parseChoiceInput('2', choices) === 1)
check('回「选B」', parseChoiceInput('选B', choices) === 1)
check('回「选择 3」', parseChoiceInput('选择 3', choices) === 2)
check('回选项原文', parseChoiceInput('向右挖', choices) === 1)
check('回选项的一部分', parseChoiceInput('向下', choices) === 2)
check('带空格也认得', parseChoiceInput(' A ', choices) === 0)
check('越界字母返回 -1', parseChoiceInput('Z', choices) === -1)
check('不相干的话返回 -1', parseChoiceInput('这是什么', choices) === -1)
check('空消息返回 -1', parseChoiceInput('', choices) === -1)
check('没有选项时返回 -1', parseChoiceInput('A', []) === -1)

console.log('== 剧情会话 ==')
const key = interactiveKey('onebot', '12345')
rememberInteractiveSession(key, {
  bvid: 'BV1xDgL6SEzk',
  graphVersion: 1722536,
  cid: 41156151510,
  title: '测试',
  choices,
  path: ['开场'],
  notice: '登录后才能体验全部结局哦～'
})
const stored = getInteractiveSession(key)
check('会话能取回来', stored && stored.bvid === 'BV1xDgL6SEzk', stored && stored.bvid)
check('按频道隔离', getInteractiveSession(interactiveKey('onebot', '999')) === null)
check('会话数量正确', interactiveSessionCount() === 1, String(interactiveSessionCount()))
rememberInteractiveSession(key, { ...stored, path: ['开场', '向左走'] })
check('同频道重复写入是覆盖而不是新增', interactiveSessionCount() === 1, String(interactiveSessionCount()))
check('路径进度可以累加', formatInteractivePath(getInteractiveSession(key).path) === '开场 → 向左走', formatInteractivePath(getInteractiveSession(key).path))
/** remember 会强制把 updatedAt 设成现在，所以这里直接把进程时钟往前拨 */
const realNow = Date.now
Date.now = () => realNow() + INTERACTIVE_TTL_MS + 1000
check('过期会话取不到（隔天回 A 不该续上昨天的剧情）', getInteractiveSession(key) === null)
Date.now = realNow
check('时钟恢复正常后不影响新会话', getInteractiveSession(key) === null)
clearInteractiveSession(key)
check('清理后数量归零', interactiveSessionCount() === 0, String(interactiveSessionCount()))
check('空路径渲染成空串', formatInteractivePath([]) === '')

const main = async () => {
  console.log('== 剧情图爬取（整张图 / 断头重试）==')
  const graphModule = require(path.join(libRoot, 'karin', 'module', 'utils', 'InteractiveGraph.js'))
  const { crawlInteractiveGraph, clearInteractiveGraphCache } = graphModule
  const edgeUrl = (url) => /edge_id=(\d+)/.exec(url)
  /** 剧本：根 → A(cid 11) / B(cid 12)；A 之后是结局，B 之后还有一题 */
  const payloadFor = (edgeId) => {
    if (!edgeId) return { code: 0, data: { title: 't', is_leaf: 0, edges: { questions: [{ title: '开场', choices: [
      { id: 1, cid: 11, option: 'A 左' }, { id: 2, cid: 12, option: 'B 右' }] }] } } }
    if (edgeId === '1') return { code: 0, data: { title: 't', is_leaf: 1, edges: { questions: [] } } }
    return { code: 0, data: { title: 't', is_leaf: 0, edges: { questions: [{ title: '第二题', choices: [
      { id: 3, cid: 21, option: 'A 继续' }] }] } } }
  }
  let failuresLeft = 0
  const flakyRequest = async (url) => {
    const edgeId = edgeUrl(url)?.[1]
    // 只让「按分支取节点」失败一次，根节点照常返回（根失败就没图了，那是另一回事）
    if (edgeId && failuresLeft > 0) { failuresLeft--; return false }
    return payloadFor(edgeId)
  }
  clearInteractiveGraphCache()
  const graph = await crawlInteractiveGraph({ bvid: 'BVT', graphVersion: 9, rootCid: 100, request: flakyRequest })
  check('爬到的图带上了每个分支的后续（嵌套 children）', graph.root.choices[0].children?.[0]?.isLeaf === true, JSON.stringify(graph.root.choices.map((c) => !!c.children)))
  check('深层分支也在图里', graph.root.choices[1].children?.[0]?.choices?.[0]?.text === '继续', JSON.stringify(graph.root.choices[1]).slice(0, 200))
  // 根 + A 落点（结局）+ B 落点 + B 之后的结局 = 4
  check('节点数正确', graph.nodeCount === 4, String(graph.nodeCount))

  clearInteractiveGraphCache()
  failuresLeft = 1
  const retried = await crawlInteractiveGraph({ bvid: 'BVT2', graphVersion: 9, rootCid: 100, request: flakyRequest })
  check('单个节点抓失败会重试，不会留断头分支', retried.root.choices[0].children?.[0]?.isLeaf === true, JSON.stringify(retried.root.choices.map((c) => !!c.children)))

  clearInteractiveGraphCache()
  const broken = await crawlInteractiveGraph({ bvid: 'BVT3', graphVersion: 9, rootCid: 100, request: async (url) => (edgeUrl(url) ? false : payloadFor()) })
  check('下一段一直抓不到时不会挂住（照样返回图）', !!broken && broken.root.choices.every((c) => !c.children), JSON.stringify(broken.root.choices.map((c) => !!c.children)))

  console.log('== 联网部分（用假请求）==')
  const urls = []
  const fakeRequest = async (url) => {
    urls.push(url)
    if (url.includes('/x/player/wbi/v2')) return { code: 0, data: { interaction: { graph_version: 1722536, msg: '登录后才能体验全部结局哦～' } } }
    return rootFixture
  }
  const info = await fetchInteractiveInfo({ bvid: 'BV1xDgL6SEzk', cid: 41156151510, request: fakeRequest })
  check('拿到剧情图版本号', info && info.graphVersion === 1722536, JSON.stringify(info))
  check('带回 B站 的提示语', info.notice.includes('登录后'), info.notice)
  check('播放器接口 URL 正确', urls[0] === 'https://api.bilibili.com/x/player/wbi/v2?bvid=BV1xDgL6SEzk&cid=41156151510', urls[0])

  const node = await fetchInteractiveNode({ bvid: 'BV1xDgL6SEzk', graphVersion: 1722536, cid: 41156151510, request: fakeRequest })
  check('拿到根节点', node && node.choices.length === 4, String(node && node.choices.length))
  check('edgeinfo URL 带上了 graph_version', urls[1].includes('graph_version=1722536'), urls[1])

  await fetchInteractiveNode({ bvid: 'BV1xDgL6SEzk', graphVersion: 1722536, cid: 41156151510, edgeId: 47666682, request: fakeRequest })
  check('选完之后的请求带上了 edge_id', urls[2].includes('edge_id=47666682'), urls[2])

  const noInteraction = await fetchInteractiveInfo({
    bvid: 'BV1xx411c7mD',
    cid: 62131,
    request: async () => ({ code: 0, data: { interaction: {} } })
  })
  check('普通视频（没有 interaction）返回 null', noInteraction === null, JSON.stringify(noInteraction))

  const failed = await fetchInteractiveNode({
    bvid: 'BV1xDgL6SEzk',
    graphVersion: 1,
    cid: 1,
    request: async () => ({ code: 99003, message: '剧情图被修改已失效' })
  })
  check('剧情图失效（code != 0）返回 null 而不是抛错', failed === null, JSON.stringify(failed))
  const empty = await fetchInteractiveNode({ bvid: '', graphVersion: 0, cid: 0, request: fakeRequest })
  check('参数不全时不发请求', empty === null)

  console.log('')
  console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项')
  if (failures.length === 0) {
    console.log('=== 通过：互动视频的选项清洗 / 解析 / 会话都正常 ===')
    process.exit(0)
  }
  for (const item of failures) console.log('  ❌ ' + item)
  console.log('=== 失败 ===')
  process.exit(1)
}

main()
