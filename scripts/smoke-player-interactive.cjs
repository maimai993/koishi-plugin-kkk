/**
 * 冒烟测试：在线播放器里的**互动视频**（B站互动稿）。
 *
 * 用户要求：互动视频的选项要「直接显示在视频上面，全屏也能点」。
 * 这条测试把新增的那条链路整条钉住（全部本机、不碰外网）：
 *
 *   1. 播放页上真的有选项覆盖层与「选项」按钮；
 *   2. 页面内联脚本语法正确（一万多字符拼起来，语法错了整页白屏）；
 *   3. GET /story       拿到当前这一段的题目与选项；带 cid/edge 才去问下一段；
 *   4. GET /segment/:cid 当前这一段直接发主视频；别的段按需下载 → 搬进会话目录 → 支持 Range；
 *   5. 同一个分段并发请求只下一次（用户连点不会把带宽和磁盘打满）；
 *   6. 没有剧情 / 分段非法 / 会话过期都是 404（播放页据此退化成普通播放页）。
 *
 * 走的是 lib 产物（真正跑的就是它）。
 * 用法：node scripts/smoke-player-interactive.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

const store = require('../lib/player/store.js')
const { handlePlayerRequest } = require('../lib/player/server.js')

let failures = 0
const check = (name, ok, detail) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  —— ' + detail : ''))
  if (!ok) failures++
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kkk-story-'))
store.setupPlayerStore(path.join(root, 'player'))

/** 造一个假的主视频 / 分段视频文件（内容不重要，只看大小与 Range） */
const writeFake = (name, bytes, fill) => {
  const file = path.join(root, name)
  fs.writeFileSync(file, Buffer.alloc(bytes, fill))
  return file
}

const request = (p, range, query) => handlePlayerRequest({ method: 'GET', path: p, range, query: query || '' })
const bodyOf = (res) => (res.body ? res.body.toString('utf-8') : '')
const sizeOf = (res) => (res.file ? res.file.end - res.file.start + 1 : 0)

/** 当前这一段的剧情 + 按需下载的能力（真实运行时由 B站 那边注入） */
const firstNode = {
  cid: 1001,
  question: '第一段怎么走？',
  isLeaf: false,
  choices: [
    { label: 'A', text: '向左走', cid: 2002, edgeId: 11 },
    { label: 'B', text: '向右挖', cid: 3003, edgeId: 12 }
  ]
}
const nodeCalls = []
const segmentCalls = []
let nodeResult = { cid: 2002, question: '第二段？', isLeaf: false, choices: [{ label: 'A', text: '继续', cid: 4004, edgeId: 21 }] }

const session = store.registerPlayerSession({
  videoPath: writeFake('main.mp4', 2048, 7),
  title: '互动测试',
  platform: 'bilibili',
  danmaku: [],
  story: {
    node: firstNode,
    source: {
      node: async (params) => { nodeCalls.push(params); return nodeResult },
      segment: async (cid) => {
        segmentCalls.push(cid)
        // 模拟「下载 + 合成」：给一个临时文件，交给播放器搬进会话目录
        await new Promise((resolve) => setTimeout(resolve, 120))
        return { filepath: writeFake('seg-src-' + cid + '.mp4', 4096, cid % 251) }
      }
    }
  }
})
const token = session.token
const base = '/kkk/player/' + token

const main = async () => {
  console.log('[1] 播放页：选项覆盖层 + 「选项」按钮')
  {
    const page = await request(base)
    const html = bodyOf(page)
    check('播放页 200', page.status === 200, 'status=' + page.status)
    check('页面有选项覆盖层 <div class="story" id="story" hidden>', /id="story"/.test(html) && /class="story"/.test(html))
    check('控制条上有「选项」按钮（默认隐藏，有剧情才露出来）',
      /id="storyBtn" hidden/.test(html) && html.includes('互动剧情选项'))
    check('覆盖层样式就位（浮在画面上，全屏时跟着容器一起进去）',
      /\.story\{[^}]*position:absolute/.test(html) && /\.story\{[^}]*z-index:5/.test(html),
      'z-index 5（高于弹幕 1 / 大播放 2 / 控制条 3 / 弹幕设置 4，低于提示层 6）')
    check('页面里没有 emoji（播放页一律用内联 SVG）',
      !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html))
    const matched = /<script>([\s\S]*?)<\/script>/.exec(html)
    let scriptOk = false
    let scriptError = ''
    try {
      new vm.Script(matched ? matched[1] : '')
      scriptOk = !!matched
    } catch (error) {
      scriptError = String(error && error.message)
    }
    check('内联脚本语法正确（语法错整页白屏）', scriptOk, scriptError)
    const scriptText = matched ? matched[1] : ''
    check('脚本里有分段续播逻辑（换 /segment/<cid> 的 src）',
      scriptText.includes("'/segment/' + choice.cid") && scriptText.includes('function pickStory'),
      'picker')
  }

  console.log('[2] GET /story：当前这一段的题目与选项')
  {
    const res = await request(base + '/story')
    const node = JSON.parse(bodyOf(res) || '{}')
    check('200 + JSON', res.status === 200 && node.cid === 1001, 'cid=' + node.cid)
    check('题目与选项原样带出来',
      node.question === '第一段怎么走？' && node.choices.length === 2 &&
      node.choices[0].text === '向左走' && node.choices[0].cid === 2002 && node.choices[0].edgeId === 11)
    check('问当前这一段不必再去问接口（不会多打一次 B站）', nodeCalls.length === 0)
  }

  console.log('[3] GET /story?cid=&edge=：问下一段')
  {
    const res = await request(base + '/story', undefined, '?cid=1001&edge=11')
    const node = JSON.parse(bodyOf(res) || '{}')
    check('200 + 返回落地节点', res.status === 200 && node.cid === 2002, 'cid=' + node.cid)
    check('确实问了平台侧（cid + edge 都带过去了）',
      nodeCalls.length === 1 && nodeCalls[0].cid === 1001 && nodeCalls[0].edgeId === 11,
      JSON.stringify(nodeCalls))
  }
  {
    nodeResult = null
    const res = await request(base + '/story', undefined, '?cid=1001&edge=12')
    check('取不到节点 → 404（播放页据此保持原样，不会给出点不动的按钮）', res.status === 404)
    nodeResult = { cid: 2002, question: '', isLeaf: false, choices: [] }
  }

  console.log('[4] GET /segment/:cid：当前段直接发，别的段按需下载')
  {
    const res = await request(base + '/segment/1001')
    check('当前这一段 = 会话里的主视频', res.status === 200 && sizeOf(res) === 2048, 'size=' + sizeOf(res))
    const ranged = await request(base + '/segment/1001', 'bytes=0-1023')
    check('支持 Range（拖进度条靠它）',
      ranged.status === 206 && ranged.headers['Content-Range'] === 'bytes 0-1023/2048',
      ranged.headers['Content-Range'])
  }
  {
    const res = await request(base + '/segment/2002')
    check('没下过的分段：按需下载后 200', res.status === 200 && sizeOf(res) === 4096, 'size=' + sizeOf(res))
    check('平台侧只被调用了一次', segmentCalls.length === 1 && segmentCalls[0] === 2002, JSON.stringify(segmentCalls))
    const adopted = path.join(session.dir, 'seg-2002.mp4')
    check('分段搬进了会话目录（到期跟着会话一起清）', fs.existsSync(adopted))
    check('临时文件已经不在原地了（是搬不是拷）', !fs.existsSync(path.join(root, 'seg-src-2002.mp4')))
    const again = await request(base + '/segment/2002')
    check('第二次请求命中缓存（不再下载）', again.status === 200 && segmentCalls.length === 1)
  }
  {
    // 并发：用户连点同一个选项
    const [a, b] = await Promise.all([request(base + '/segment/3003'), request(base + '/segment/3003')])
    check('并发请求同一个分段只下一次', a.status === 200 && b.status === 200 && segmentCalls.length === 2,
      'segment 调用=' + JSON.stringify(segmentCalls))
  }

  console.log('[5] 边界：非法 cid / 没有剧情 / 过期')
  {
    const bad = await request(base + '/segment/abc')
    const zero = await request(base + '/segment/0')
    check('非法 cid → 404', bad.status === 404 && zero.status === 404, bad.status + ' / ' + zero.status)
  }
  {
    const plain = store.registerPlayerSession({
      videoPath: writeFake('plain.mp4', 1024, 3),
      title: '普通视频',
      platform: 'bilibili',
      danmaku: []
    })
    const story = await request('/kkk/player/' + plain.token + '/story')
    const segment = await request('/kkk/player/' + plain.token + '/segment/1001')
    check('没有剧情的会话：/story 与 /segment 都是 404（普通播放页照常）',
      story.status === 404 && segment.status === 404, story.status + ' / ' + segment.status)
    const page = await request('/kkk/player/' + plain.token)
    check('普通播放页照常有播放器（只是不显示选项）', page.status === 200 && /id="video"/.test(bodyOf(page)))
  }
  {
    await store.deletePlayerSession(token)
    const gone = await request(base + '/story')
    check('会话删掉之后 /story 也不认了', gone.status === 404, 'status=' + gone.status)
  }

  fs.rmSync(root, { recursive: true, force: true })
  console.log('')
  console.log(failures ? '失败 ' + failures + ' 项' : '全部通过')
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
