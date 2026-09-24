/**
 * 互动剧情「发选项 → 等选择 → 播下一段」的冒烟测试。
 *
 * 全部用假对象：假消息事件（e.reply 记下发了什么）、假请求（返回剧本）、假等待（返回用户回的话）、
 * 假播放（记下要播哪个 cid）。这样能完整验证循环，不需要联网、不需要适配器。
 *
 * 用法：node scripts/smoke-interactive-story.cjs
 */
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
  ctx: { get: () => undefined, logger: () => ({ info: noop, warn: noop, error: noop, debug: noop, mark: noop }), bots: [], registry: new Map(), on: noop, middleware: noop },
  config: { app: {} },
  dataRoot: path.join(pluginRoot, 'data-smoke-interactive-story'),
  pluginRoot,
  master: () => []
})

const story = require(path.join(libRoot, 'karin', 'platform', 'bilibili', 'interactive-story.js'))
const { runInteractiveStory, buildChoiceMessage, CHOICE_WAIT_SECONDS } = story

/** 造一个假事件：记录发了什么、撤了哪条 */
const makeEvent = (platform, adapterName) => {
  const state = { replies: [], recalled: [] }
  const e = {
    contact: { peer: 'g100' },
    bot: {
      bot: { platform },
      adapter: { name: adapterName ?? platform },
      recallMsg: async (id) => { state.recalled.push(id) }
    },
    reply: async (content) => {
      state.replies.push(content)
      return { messageId: 'm' + state.replies.length }
    }
  }
  return { e, state }
}

/** 剧本：根节点两个选项；选了 edge=11 之后到结局；选了 edge=12 之后还有一题 */
const rootPayload = {
  code: 0,
  data: {
    title: '点进来帮史蒂夫做出选择！',
    is_leaf: 0,
    edges: { questions: [{ title: '第一题', choices: [
      { id: 11, cid: 101, option: 'A 向左走', is_default: 1 },
      { id: 12, cid: 102, option: 'B 向右挖' }
    ] }] }
  }
}
const leafPayload = { code: 0, data: { title: '结局', is_leaf: 1, edges: { questions: [] } }
}
const middlePayload = {
  code: 0,
  data: { title: '第二段', is_leaf: 0, edges: { questions: [{ title: '第二题', choices: [
    { id: 21, cid: 201, option: 'A 继续' }
  ] }] } }
}

const requestFor = (script) => async (url) => {
  const edgeId = /edge_id=(\d+)/.exec(url)
  if (!edgeId) return script.root
  return script[edgeId[1]] ?? { code: 99003, message: '剧情图被修改已失效' }
}

const main = async () => {
  console.log('== 选项消息 ==')
  const { e: qqEvent } = makeEvent('qqguild')
  /** 用现成的假事件 + 假请求先跑一遍，只为拿到节点对象 */
  let captured = null
  await runInteractiveStory({
    e: qqEvent,
    bvid: 'BV1xDgL6SEzk',
    graphVersion: 1722536,
    rootCid: 41156151510,
    title: '史蒂夫的选择',
    notice: '登录后才能体验全部结局哦～',
    request: requestFor({ root: rootPayload }),
    wait: async () => { captured = null; return null },
    play: async () => {}
  })
  const rootNode = {
    bvid: 'BV1xDgL6SEzk',
    graphVersion: 1722536,
    cid: 41156151510,
    title: '点进来帮史蒂夫做出选择！',
    question: '第一题',
    choices: [
      { index: 0, label: 'A', text: '向左走', rawText: 'A 向左走', edgeId: 11, cid: 101, isDefault: true },
      { index: 1, label: 'B', text: '向右挖', rawText: 'B 向右挖', edgeId: 12, cid: 102, isDefault: false }
    ],
    isLeaf: false,
    notice: '登录后才能体验全部结局哦～'
  }
  const qqMarkdown = buildChoiceMessage(rootNode, { title: '史蒂夫的选择', path: ['开场'], waitSeconds: 180, buttons: true })
  check('QQ 用 markdown 按钮', qqMarkdown.includes('<qqbot-cmd-input'), qqMarkdown.slice(0, 120))
  // 两个选项按钮 + 一个「渲染流程图」按钮
  check('每个选项一个按钮，外加渲染流程图按钮', (qqMarkdown.match(/qqbot-cmd-input/g) || []).length === 3, String((qqMarkdown.match(/qqbot-cmd-input/g) || []).length))
  check('带「渲染流程图」按钮', qqMarkdown.includes(encodeURIComponent('渲染流程图')), qqMarkdown.slice(-160))
  check('按钮文案带字母与选项文字', qqMarkdown.includes('A%20%E5%90%91%E5%B7%A6%E8%B5%B0'), qqMarkdown.slice(0, 200))
  check('按钮里不带链接（QQ 会拒收带链接的消息）', !/https?:\/\//.test(qqMarkdown))
  check('带上剧情进度', qqMarkdown.includes('开场'))
  check('带上 B站 的提示语', qqMarkdown.includes('登录后才能体验全部结局'))
  const plain = buildChoiceMessage(rootNode, { title: '史蒂夫的选择', path: [], waitSeconds: 180, buttons: false })
  check('其它适配器用纯文字选项', plain.includes('A 向左走') && plain.includes('B 向右挖'), plain)
  check('纯文字版没有按钮标签', !plain.includes('qqbot-cmd-input'))
  check('纯文字版告知怎么回复', /回复上面的字母或数字/.test(plain), plain)

  console.log('== 走完一次剧情（QQ 按钮）==')
  const { e, state } = makeEvent('qqguild')
  const played = []
  const result = await runInteractiveStory({
    e,
    bvid: 'BV1xDgL6SEzk',
    graphVersion: 1722536,
    rootCid: 41156151510,
    title: '史蒂夫的选择',
    request: requestFor({ root: rootPayload, 11: leafPayload, 12: middlePayload }),
    wait: async () => 'A',
    play: async (cid) => { played.push(cid) }
  })
  check('走到结局', result.ended === 'leaf', result.ended)
  check('走了两个节点', result.nodes === 2, String(result.nodes))
  check('剧情路径记录了选项文字', result.path.join('/') === '向左走', result.path.join('/'))
  check('按选择播放了对应节点的视频', played.join(',') === '101', played.join(','))
  check('发出过选项消息', state.replies.some((item) => String(item).includes('qqbot-cmd-input') || (item && item.type === 'markdown')), JSON.stringify(state.replies).slice(0, 160))
  check('结局时撤回了上一条选项消息', state.recalled.length >= 1, JSON.stringify(state.recalled))
  check('结局有提示', state.replies.some((item) => String(item).includes('结局')), JSON.stringify(state.replies).slice(0, 200))

  console.log('== 结局那一段也要给上层画图的机会 ==')
  const endingHook = makeEvent('qqguild')
  const hookCalls = []
  const endingResult = await runInteractiveStory({
    e: endingHook.e,
    bvid: 'BV1xDgL6SEzk',
    graphVersion: 1722536,
    rootCid: 41156151510,
    request: requestFor({ root: rootPayload, 11: leafPayload }),
    wait: async () => 'A',
    play: async () => {},
    onNode: async (node, event, path, isFirst) => {
      hookCalls.push({ isLeaf: node.isLeaf, isFirst, path: path.join('/') })
      return true
    }
  })
  check('剧情结束后仍然收到了一次画图机会', endingResult.ended === 'leaf' && hookCalls.length === 2, JSON.stringify(hookCalls))
  check('最后一次是结局节点', hookCalls[hookCalls.length - 1]?.isLeaf === true, JSON.stringify(hookCalls))
  check('只有第一次带 isFirst', hookCalls[0]?.isFirst === true && hookCalls[1]?.isFirst === false, JSON.stringify(hookCalls))
  check('画图时能拿到完整路径', hookCalls[hookCalls.length - 1]?.path === '向左走', hookCalls[hookCalls.length - 1]?.path)

  console.log('== 多段剧情：每组选项都会撤回上一组 ==')
  const multi = makeEvent('onebot', 'onebot')
  const played2 = []
  const answers = ['B', 'A']
  const result2 = await runInteractiveStory({
    e: multi.e,
    bvid: 'BV1xDgL6SEzk',
    graphVersion: 1722536,
    rootCid: 41156151510,
    request: requestFor({ root: rootPayload, 12: middlePayload, 21: leafPayload }),
    wait: async () => answers.shift() ?? null,
    play: async (cid) => { played2.push(cid) }
  })
  check('两段剧情走完', result2.ended === 'leaf' && result2.nodes === 3, result2.ended + '/' + result2.nodes)
  check('路径记录两个选项', result2.path.join('/') === '向右挖/继续', result2.path.join('/'))
  check('每一段都播了对应的 cid', played2.join(',') === '102,201', played2.join(','))
  check('非 QQ 平台没发按钮', multi.state.replies.every((item) => !String(item).includes('qqbot-cmd-input')), JSON.stringify(multi.state.replies).slice(0, 160))
  check('第二组选项发出前撤回了第一组', multi.state.recalled.length >= 1, JSON.stringify(multi.state.recalled))

  console.log('== 认不出回复：静默继续等（群里不该被刷提示）==')
  const hinting = makeEvent('onebot', 'onebot')
  const answers3 = ['嗯嗯', '这是什么', 'A']
  const replyCountBefore = 0
  const result3 = await runInteractiveStory({
    e: hinting.e,
    bvid: 'BV1xDgL6SEzk',
    graphVersion: 1722536,
    rootCid: 41156151510,
    request: requestFor({ root: rootPayload, 11: leafPayload }),
    wait: async () => answers3.shift() ?? null,
    play: async () => {}
  })
  check('认不出之后仍然能继续（等下一次回复）', result3.ended === 'leaf', result3.ended)
  const textReplies = hinting.state.replies.map((item) => String(item && item.type === 'markdown' ? 'markdown' : item))
  check('认不出时不发任何提示', !textReplies.some((item) => /没认出|不认识|再选一次/.test(item)), textReplies.join(' | ').slice(0, 200))
  // 只数「带编号的选项行」：结局提示里的剧情路径也含「向左走」，别把它算进去
  const optionMessages = hinting.state.replies.filter((item) => /(^|\n)A 向左走/.test(String(item)))
  check('认不出时也不重发选项（选项消息只发过一次）', optionMessages.length === 1, String(optionMessages.length))
  check('这期间只多了一条结局提示', hinting.state.replies.length === 2, JSON.stringify(hinting.state.replies).slice(0, 200))
  void replyCountBefore

  console.log('== 一直说别的：不吵人，只等超时 ==')
  const hopeless = makeEvent('onebot', 'onebot')
  let hopelessWaits = 0
  const result4 = await runInteractiveStory({
    e: hopeless.e,
    bvid: 'BV1xDgL6SEzk',
    graphVersion: 1722536,
    rootCid: 41156151510,
    request: requestFor({ root: rootPayload }),
    wait: async () => {
      // 第五次才「超时」，前面都是听不懂的话
      hopelessWaits++
      return hopelessWaits >= 5 ? null : '???'
    },
    play: async () => {}
  })
  check('一直认不出时不会打扰用户，只是等到超时', result4.ended === 'timeout', result4.ended)
  check('中间那几次听不懂的话没有任何回复', hopeless.state.replies.filter((item) => /没认出|不认识/.test(String(item))).length === 0, JSON.stringify(hopeless.state.replies).slice(0, 200))

  console.log('== 超时 ==')
  const timingOut = makeEvent('onebot', 'onebot')
  const result5 = await runInteractiveStory({
    e: timingOut.e,
    bvid: 'BV1xDgL6SEzk',
    graphVersion: 1722536,
    rootCid: 41156151510,
    request: requestFor({ root: rootPayload }),
    wait: async () => null,
    play: async () => {}
  })
  check('超时结束', result5.ended === 'timeout', result5.ended)
  check('超时提示告诉用户怎么接着玩', timingOut.state.replies.some((item) => String(item).includes('再发一次链接')), JSON.stringify(timingOut.state.replies).slice(0, 200))

  console.log('== 剧情图取不到 ==')
  const broken = makeEvent('onebot', 'onebot')
  const result6 = await runInteractiveStory({
    e: broken.e,
    bvid: 'BV1xDgL6SEzk',
    graphVersion: 1,
    rootCid: 1,
    request: async () => ({ code: 99003, message: '剧情图被修改已失效' }),
    wait: async () => null,
    play: async () => {}
  })
  check('取不到节点时安静收尾', result6.ended === 'unavailable' && result6.nodes === 0, result6.ended + '/' + result6.nodes)
  check('这种情况不打扰用户（不发消息）', broken.state.replies.length === 0, JSON.stringify(broken.state.replies))

  console.log('== 结局节点 ==')
  const ending = makeEvent('qqguild')
  const result7 = await runInteractiveStory({
    e: ending.e,
    bvid: 'BV1xDgL6SEzk',
    graphVersion: 1722536,
    rootCid: 101,
    request: requestFor({ root: leafPayload }),
    wait: async () => null,
    play: async () => {}
  })
  check('根节点就是结局时直接结束', result7.ended === 'leaf', result7.ended)
  check('结局不再等用户回复', result7.nodes === 1, String(result7.nodes))

  console.log('')
  console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项')
  if (failures.length === 0) {
    console.log('=== 通过：互动剧情循环（按钮 / 等待 / 续播 / 收尾）都正常 ===')
    process.exit(0)
  }
  for (const item of failures) console.log('  ❌ ' + item)
  console.log('=== 失败 ===')
  process.exit(1)
}

main().catch((error) => {
  console.log('测试自身抛错: ' + (error && error.stack ? error.stack : error))
  process.exit(1)
})
