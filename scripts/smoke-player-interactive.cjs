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
  // 画面 + 声音分开的两份（B站就是两条流；互动分段也一样，不在服务器合成）
  audioPath: writeFake('main.m4a', 1024, 9),
  title: '互动测试',
  platform: 'bilibili',
  danmaku: [],
  // 原视频链接（播放页上显示「原视频」那一行 —— 用户要求：本页链接没意义，原链接才有）
  work: { title: '互动测试', sourceUrl: 'https://www.bilibili.com/video/BV1xx411c7mD' },
  story: {
    node: firstNode,
    source: {
      node: async (params) => { nodeCalls.push(params); return nodeResult },
      segment: async (cid, report) => {
        segmentCalls.push(cid)
        // 模拟「下载 + 合成」：先报下载进度、再报合成，最后给一个临时文件让播放器搬进会话目录
        report?.({ stage: 'video', bytes: 2048, total: 4096 })
        await new Promise((resolve) => setTimeout(resolve, 120))
        report?.({ stage: 'audio', bytes: 512, total: 1024 })
        await new Promise((resolve) => setTimeout(resolve, 60))
        return {
          filepath: writeFake('seg-src-' + cid + '.mp4', 4096, cid % 251),
          audioPath: writeFake('seg-src-' + cid + '.m4a', 1024, 13)
        }
      }
    }
  }
})
const token = session.token
const base = '/kkk/player/' + token

const main = async () => {
  console.log('[1] 播放页：贴在视频上的选项卡片 + 「选项」按钮')
  {
    const page = await request(base)
    const html = bodyOf(page)
    check('播放页 200', page.status === 200, 'status=' + page.status)
    check('页面有选项覆盖层 <div class="story" id="story" hidden>', /id="story"/.test(html) && /class="story"/.test(html))
    check('控制条上有「选项」按钮（默认隐藏，有剧情才露出来）',
      /id="storyBtn" hidden/.test(html) && html.includes('互动剧情选项'))
    check('卡片贴在画面底部（全屏时跟着容器一起进去）',
      /\.story\{[^}]*position:absolute/.test(html) && /\.story\{[^}]*bottom:56px/.test(html) &&
      /\.story\{[^}]*z-index:5/.test(html),
      'z-index 5（高于弹幕 1 / 大播放 2 / 控制条 3 / 弹幕设置 4，低于提示层 6）')
    check('容器不吃点击（只有卡片能点，画面照常能点暂停）',
      /\.story\{[^}]*pointer-events:none/.test(html) && /\.story-card\{[^}]*pointer-events:auto/.test(html))
    check('有加载进度条样式（点完选项显示下载/合成进度）',
      /\.story-track\{/.test(html) && /\.story-fill\{/.test(html))
    check('显示的是**平台原视频链接**（不是用户已经在看的本页链接）',
      html.includes('id="pageSourceLink"') && html.includes('https://www.bilibili.com/video/BV1xx411c7mD') &&
      html.includes('原视频') && html.includes('复制原链接'),
      '原视频那一行')
    check('原链接带 target/rel（新标签打开，且不留 referrer）',
      /id="pageSourceLink"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/.test(html))
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
    check('点完**直接换源并重新播放**（用户要求）',
      /function pickStory[\s\S]{0,700}?video\.setAttribute\('src', API \+ '\/segment\/' \+ choice\.cid\)/.test(scriptText) &&
      /function pickStory[\s\S]{0,900}?video\.play\(\)/.test(scriptText))
    check('换段时音轨一起换（画面 muted、声音走 <audio>，不在服务器合成）',
      scriptText.includes("audioTrack.setAttribute('src', API + '/segment/' + choice.cid + '?audio=1')") &&
      html.includes('id="audioTrack"'))
    check('等待期间轮询 /progress 画进度，失败时把服务端给的原因写出来',
      scriptText.includes("fetch(API + '/progress?cid=' + cid)") &&
      scriptText.includes('function pollProgress') &&
      scriptText.includes("info.reason"))
    check('下好开播后自动收起进度卡片（loadeddata / canplay）',
      scriptText.includes('function settleStoryWait') &&
      scriptText.includes("addEventListener('loadeddata', settleStoryWait)"))
    check('**播放完成**才显示选项（加载完不弹、播到一半也不弹）',
      scriptText.includes('function maybeShowStory') &&
      scriptText.includes('if (!video.ended) return') &&
      scriptText.includes("addEventListener('ended', maybeShowStory)") &&
      !scriptText.includes('left <= 6'))
    check('分段失败时压过页面原来那句「链接已过期」，并给一个「重试这一段」按钮',
      scriptText.includes("if (!storyNode && !storyPending) return") &&
      scriptText.includes("label.textContent = '重试这一段'") &&
      scriptText.includes('storyLastReason'))
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

    const audio = await request(base + '/segment/2002', undefined, '?audio=1')
    check('分段的音轨也能单独取（?audio=1 → audio/mp4）',
      audio.status === 200 && audio.headers['Content-Type'] === 'audio/mp4' && sizeOf(audio) === 1024,
      audio.headers['Content-Type'] + ' ' + sizeOf(audio))
    check('音轨也搬进了会话目录（seg-2002.m4a）', fs.existsSync(path.join(session.dir, 'seg-2002.m4a')))
    const audioRange = await request(base + '/segment/2002', 'bytes=0-511', '?audio=1')
    check('音轨同样支持 Range', audioRange.status === 206 && sizeOf(audioRange) === 512, String(audioRange.status))

    const firstAudio = await request(base + '/segment/1001', undefined, '?audio=1')
    check('当前这一段的音轨就是会话里那份（不用再下载）',
      firstAudio.status === 200 && sizeOf(firstAudio) === 1024, 'size=' + sizeOf(firstAudio))
  }
  {
    // 并发：用户连点同一个选项
    const [a, b] = await Promise.all([request(base + '/segment/3003'), request(base + '/segment/3003')])
    check('并发请求同一个分段只下一次', a.status === 200 && b.status === 200 && segmentCalls.length === 2,
      'segment 调用=' + JSON.stringify(segmentCalls))
  }

  console.log('[5] GET /progress：点完选项的加载进度')
  {
    const before = await request(base + '/progress', undefined, '?cid=5005')
    const beforeJson = JSON.parse(bodyOf(before) || '{}')
    check('还没开始时是 idle（页面不用为「没开始」特判 404）',
      before.status === 200 && beforeJson.stage === 'idle', JSON.stringify(beforeJson))

    const current = await request(base + '/progress', undefined, '?cid=1001')
    const currentJson = JSON.parse(bodyOf(current) || '{}')
    check('当前这一段（会话主视频）直接就是 ready',
      current.status === 200 && currentJson.stage === 'ready' && currentJson.percent === 100,
      JSON.stringify(currentJson))

    // HEAD 触发下载（不 await）：中途轮询应当看得到「在下载 / 在合成」
    const running = request(base + '/segment/5005', 'bytes=0-0')
    await new Promise((resolve) => setTimeout(resolve, 80))
    const during = JSON.parse(bodyOf(await request(base + '/progress', undefined, '?cid=5005')) || '{}')
    check('下载过程中能看到阶段与百分比',
      ['queued', 'video', 'audio', 'merging'].includes(during.stage) && during.percent >= 0 && during.percent <= 100,
      JSON.stringify(during))
    await running
    const after = JSON.parse(bodyOf(await request(base + '/progress', undefined, '?cid=5005')) || '{}')
    check('下完之后变成 ready（页面据此换源）',
      after.stage === 'ready' && after.percent === 100, JSON.stringify(after))

    const again = JSON.parse(bodyOf(await request(base + '/progress', undefined, '?cid=5005')) || '{}')
    check('已经下好的分段直接回 ready（不用等一次往返）', again.stage === 'ready', JSON.stringify(again))
    const badCid = await request(base + '/progress', undefined, '?cid=abc')
    check('非法 cid 的进度查询 → 404', badCid.status === 404, 'status=' + badCid.status)
  }

  console.log('[5b] 分段准备失败：进度接口把原因带给页面')
  {
    const broken = store.registerPlayerSession({
      videoPath: writeFake('broken.mp4', 1024, 5),
      title: '坏源',
      platform: 'bilibili',
      danmaku: [],
      story: {
        node: { cid: 7007, question: '这一段没得选', isLeaf: false, choices: [{ label: 'A', text: '继续', cid: 7008, edgeId: 31 }] },
        source: {
          node: async () => null,
          segment: async () => { throw new Error('测试注入：直链拿不到') }
        }
      }
    })
    const brokenBase = '/kkk/player/' + broken.token
    const failed = await request(brokenBase + '/segment/7008')
    check('分段准备抛异常时 → 404', failed.status === 404, 'status=' + failed.status)
    const info = JSON.parse(bodyOf(await request(brokenBase + '/progress', undefined, '?cid=7008')) || '{}')
    check('进度接口回 failed 且带上原因（页面据此显示给人看）',
      info.stage === 'failed' && String(info.reason || '').includes('直链拿不到'), JSON.stringify(info))
  }

  console.log('[6] 边界：非法 cid / 没有剧情 / 过期')
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
    check('平台没给原链接时不编数据（整行不渲染）', !bodyOf(page).includes('id="pageSourceLink"'))
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
