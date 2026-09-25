/**
 * 冒烟测试：下载与渲染的**顺序**（用户要求：一边下载视频一边渲染卡片）。
 *
 * 这条链路跑起来要真外网 + 真视频，所以这里退一步做**结构断言**，
 * 把「下载不能挡在卡片前面」这件事钉在编译产物上：
 *
 *   1. 不能存在 `await steps.run('下载视频'` —— 那会退回到「等视频下完才渲染」；
 *   2. 登记下载（`steps.run('下载视频'`）必须在渲染步骤之前（先启动下载）；
 *   3. 真正取下载结果（`await downloadTask`）必须在渲染步骤之后（卡片先发出去）。
 *
 * 走的是 lib 产物（真正跑的就是它），不是 src。
 *
 * 注意：编译产物**保留注释**，而注释里就写着旧写法和新写法，
 * 所以断言之前必须先把注释剥掉，否则匹配到的是说明文字而不是代码。
 *
 * 用法：node scripts/smoke-async-download.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const pluginRoot = path.resolve(__dirname, '..')

let failures = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? ' | ' + extra : ''))
  if (!ok) failures++
}

/** 剥掉块注释与行注释（`//` 前面是冒号的不算，避免砍掉 https:// 这种字符串） */
function stripComments (text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const lineOf = (text, index) => (index < 0 ? -1 : text.slice(0, index).split('\n').length)

/** 每个平台：文件、渲染步骤的锚点 */
/**
 * 每个平台：文件 + 渲染步骤的锚点。
 *
 * 锚点必须跟着实现走：3.5.0 起渲染/发送改成 SendTasks 登记（`sends.add('渲染作品信息卡', …)`），
 * 以前那个 `steps.run('渲染作品信息卡'" 的写法已经不存在了 —— 锚点不更新，这条测试就只会
 * 一直红着报「render@-1」，看着像回归、其实是测试自己过期。
 */
const CASES = [
  { name: 'B站', file: 'lib/karin/platform/bilibili/bilibili.js', render: "sends.add('渲染作品信息卡'" },
  { name: '抖音', file: 'lib/karin/platform/douyin/douyin.js', render: "sends.add('渲染作品信息卡'" },
  { name: '快手', file: 'lib/karin/platform/kuaishou/kuaishou.js', render: "sends.add('渲染评论区'" },
  { name: '小红书', file: 'lib/karin/platform/xiaohongshu/xiaohongshu.js', render: "'xiaohongshu/noteInfo'" },
]

for (const item of CASES) {
  const file = path.join(pluginRoot, item.file)
  if (!fs.existsSync(file)) {
    check(item.name + '：产物存在', false, item.file + ' 不存在（先跑 build）')
    continue
  }
  const text = stripComments(fs.readFileSync(file, 'utf8'))

  const blocking = text.indexOf("await steps.run('下载视频'")
  check(item.name + '：下载不是阻塞等待', blocking < 0, blocking < 0 ? '' : 'line ' + lineOf(text, blocking))

  const register = text.indexOf("steps.run('下载视频'")
  const render = text.indexOf(item.render)
  check(item.name + '：下载在渲染之前启动', register >= 0 && render >= 0 && register < render,
    'download@' + lineOf(text, register) + ' render@' + lineOf(text, render))

  const awaitAt = text.indexOf('await downloadTask')
  check(item.name + '：下载结果在渲染之后才等', awaitAt >= 0 && awaitAt > render,
    'await@' + lineOf(text, awaitAt) + ' render@' + lineOf(text, render))
}

console.log('')
console.log(failures ? '失败 ' + failures + ' 项' : '全部通过')
process.exit(failures ? 1 : 0)
