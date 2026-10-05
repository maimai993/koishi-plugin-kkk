/**
 * 探针：把「长得离谱的错误文本」折起来（compat/fold）。
 *
 * ## 为什么单独盯它
 * 它是**错误上报的止血钳**，自己崩了就等于把真错误吞掉。线上真崩过一次：
 * 群文件发送失败时 OneBot 把**整个请求参数**拼进错误信息（里面一段几 MB 的 base64），
 * 错误卡片去折叠它，V8 在超长单次匹配上递归爆栈 ——
 *
 *     RangeError: Maximum call stack size exceeded at foldLongRuns (lib/compat/fold.js:30:6)
 *
 * 结果用户只看到「发不出去」，真错误被整个盖掉（反馈：「nc 发群文件还是发不出去」）。
 *
 * 用法：node scripts/probe-fold-blob.cjs
 */
const path = require('node:path')

const fold = require(path.join(__dirname, '..', 'lib', 'compat', 'fold.js'))

let failed = 0
const check = (name, ok, detail) => {
  console.log((ok ? '  \u2714 ' : '  \u2718 ') + name + (detail ? '  \u2192 ' + detail : ''))
  if (!ok) failed++
}

/** 造一段 OneBot 那种「把整个请求参数拼进去」的错误信息 */
const onebotError = (payloadLength) =>
  'Error with request send_group_msg, args: {"group_id":1050229473,"message":[{"type":"image","data":{"file":"base64://'
  + 'A'.repeat(payloadLength) + '"}}]}, retcode: 1200'

;(async () => {
  console.log('\n=== 1. 折叠本身 ===')
  {
    const base64 = 'data:image/png;base64://' + 'QUJD'.repeat(100)
    const folded = fold.foldLongRuns(base64)
    check('base64 载荷被折掉了（只剩前缀）', folded.startsWith('data:image/png;base64://…'), JSON.stringify(folded))
    check('短文本原样保留', fold.foldLongRuns('发群文件失败') === '发群文件失败')
    check('undefined / null 不会炸', fold.foldLongRuns(undefined) === '' && fold.foldLongRuns(null) === '')

    /** 没有 base64 前缀的裸长串走兜底那条（JSON 里被转义过的载荷） */
    const bare = fold.foldLongRuns('x'.repeat(300) + '\nEND')
    check('裸长串也被折掉并注明长度', /省略 300 字符的长串/.test(bare) && bare.endsWith('\nEND'), JSON.stringify(bare))
    check('短串不动（256 是门槛）', fold.foldLongRuns('y'.repeat(255)) === 'y'.repeat(255))
    /** 一段里有多处载荷时每处都要折，中间的正常文字得留着 */
    const multi = fold.foldLongRuns('head ' + 'A'.repeat(300) + ' mid ' + 'B'.repeat(4000) + ' tail')
    check('多处载荷分别折掉，中间文字保留',
      multi === 'head …[省略 300 字符的长串]… mid …[省略 4000 字符的长串]… tail', JSON.stringify(multi))
    check('base64 短载荷不折（不到 64 字符）', fold.foldLongRuns('file: base64://QUJD') === 'file: base64://QUJD')
  }

  console.log('\n=== 2. 超长输入：不能爆栈（这条就是线上那个 RangeError） ===')
  {
    /**
     * 实测 V8 在 **单次匹配** 超过约 500 万字符时会递归爆栈，
     * 所以「整段 base64」这种输入最容易踩到。
     */
    for (const length of [1e6, 6e6, 9e6, 3e7]) {
      let result = ''
      let error = ''
      try {
        result = fold.foldLongRuns('A'.repeat(length))
      } catch (e) {
        error = String(e?.message ?? e)
      }
      check(length / 1e6 + 'M 字符的一整段：不抛异常', !error, error || ('结果 ' + result.length + ' 字符'))
    }

    const t0 = Date.now()
    fold.foldLongRuns('A'.repeat(3e7))
    const cost = Date.now() - t0
    /** 手写扫描是线性的：30M 字符几百毫秒，不会把错误上报拖死 */
    check('30M 字符也能在 1.5 秒内处理完（不会把错误上报拖死）', cost < 1500, cost + 'ms')
  }

  console.log('\n=== 3. 真·线上那条错误信息 ===')
  {
    const raw = onebotError(9e6)
    let combined = ''
    let error = ''
    try {
      combined = fold.foldAndTruncate(raw, 4000)
    } catch (e) {
      error = String(e?.message ?? e)
    }
    check('折叠 + 截断一步到位，不抛异常', !error, error)
    check('结果被截到 4000 出头（注明原文长度那句在后面）', combined.length < 4200, String(combined.length))
    check('base64 那段没留在卡片里（不然 HTML 又是几 MB）', !/A{1000,}/.test(combined), String(combined.length))
    /** 关键信息必须在：出错的是哪个动作、错误码是多少 */
    check('「send_group_msg」还在（看得出错在哪）', combined.includes('send_group_msg'), combined.slice(0, 80))
    /**
     * **关键**：错误码在 base64 **后面**。
     * 「只折前 N 个字符」那种省事做法会把后面这段一起丢掉 —— 而调用栈、错误码
     * 往往就在那儿，那正是「先折叠再截断」想保住的东西。
     */
    check('长串**后面**的错误码还在（不能只折开头）', combined.includes('retcode: 1200'), combined.slice(0, 160))
    check('base64 前缀留着（看得出这是段 base64）', combined.includes('base64://…'), combined.slice(0, 160))
  }

  console.log('\n=== 4. 截断 ===')
  {
    check('没超限就不动', fold.truncateWithNote('abc', 10) === 'abc')
    const cut = fold.truncateWithNote('z'.repeat(100), 10)
    check('超了就截断 + 注明', cut.startsWith('zzzzzzzzzz') && /原文共 100 字符/.test(cut), JSON.stringify(cut))
    check('常量没被改小（4000 / 400 / 200）',
      fold.MAX_CAPTURED_LOG_CHARS === 4000 && fold.MAX_CAPTURED_LOG_LINES === 400 && fold.MAX_CARD_LOG_LINES === 200,
      [fold.MAX_CAPTURED_LOG_CHARS, fold.MAX_CAPTURED_LOG_LINES, fold.MAX_CARD_LOG_LINES].join('/'))
  }

  console.log('\n' + (failed ? '\u2718 有 ' + failed + ' 项没通过' : '\u2714 全部通过'))
  process.exit(failed ? 1 : 0)
})().catch((error) => {
  console.error('\n探针崩了：', error?.stack ?? error)
  process.exit(1)
})
