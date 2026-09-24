/**
 * 面板（/kkk）里「流程图」勾选项的冒烟测试。
 *
 * 背景：\`bilibili.sendContent\` 新加了 \`chart\`（互动视频的剧情流程图），
 * 控制台那边是从 YAML 注释现算的，自动就有；**面板那边是打包好的前端包，选项写死在控件里**，
 * 所以必须由 scripts/patch-webui.mjs 塞进去 —— 而且塞错了不会报错（上一版就是静默跳过的，
 * 用户看到的是「控制台有、面板没有」）。
 *
 * 这个测试把打包结果翻出来核对三件事：
 *   1. B站那一栏的「解析时发送的内容」候选项里有 chart（流程图）；
 *   2. 面板保存前的**值白名单**里有 chart（不在里面的话，勾了保存会被面板自己清掉）；
 *   3. 另外三个平台**没有** chart（流程图是 B站互动视频独有的，别给它们加假选项）。
 *
 * 用法：node scripts/smoke-panel-chart.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const pluginRoot = path.resolve(__dirname, '..')
const webAssets = path.join(pluginRoot, 'assets', 'web', 'assets')
const BT = String.fromCharCode(96)
const QUOTED_CHART = 'value:' + BT + 'chart' + BT

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  —— ' + detail : ''))
}

const bundle = fs.readdirSync(webAssets).filter((name) => /^index-.*[.]js$/.test(name))
  .map((name) => path.join(webAssets, name))
  .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0]
const text = fs.readFileSync(bundle, 'utf8')
console.log('\n前端包: ' + path.basename(bundle) + '（' + text.length + ' 字节）')

/** 取某个平台「解析时发送的内容」那一栏的整段渲染调用 */
const optionsOf = (platform) => {
  const anchor = '[' + BT + platform + BT + ',' + BT + 'sendContent' + BT + '],' + BT + '解析时发送的内容' + BT
  const at = text.indexOf(anchor)
  if (at < 0) return null
  const start = text.lastIndexOf('(', at)
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') { depth--; if (depth === 0) return text.slice(start, i + 1) }
  }
  return null
}

console.log('\n[1] B站那一栏有「流程图」')
const bilibili = optionsOf('bilibili')
check('找到 B站「解析时发送的内容」控件', !!bilibili)
check('候选项里有 chart', !!bilibili && bilibili.includes(QUOTED_CHART))
check('勾选框文案是「流程图」', !!bilibili && bilibili.includes('流程图'), bilibili ? bilibili.slice(-110) : '')

console.log('\n[2] 值白名单里有 chart（否则保存时会被面板清掉）')
const whitelist = '{path:[' + BT + 'bilibili' + BT + ',' + BT + 'sendContent' + BT + '],options:['
  + BT + 'info' + BT + ',' + BT + 'comment' + BT + ',' + BT + 'video' + BT + ',' + BT + 'image' + BT + ',' + BT + 'chart' + BT + ']}'
check('补全表里列了 chart', text.includes(whitelist))

console.log('\n[3] 另外三个平台没有 chart（流程图只有 B站有）')
for (const platform of ['douyin', 'xiaohongshu', 'kuaishou']) {
  const options = optionsOf(platform)
  check(platform + ' 没有 chart', !options || !options.includes(QUOTED_CHART))
}

console.log('\n[3.5] 「合并转发内容」里也有「流程图」（B站 + 通用那份全局）')
/** 取某一段文本里紧跟着它的选项数组（渲染调用里最后一个数组字面量） */
const forwardOptionsOf = (needle) => {
  const at = text.indexOf(needle)
  if (at < 0) return null
  const close = text.indexOf('])', at)
  const open = text.lastIndexOf('[', close)
  return open < 0 || close < 0 ? null : text.slice(open, close + 1)
}
const globalForward = forwardOptionsOf('合并转发内容（全局）')
const bilibiliForward = forwardOptionsOf('[' + BT + 'bilibili' + BT + ',' + BT + 'forwardContent' + BT + ']')
check('通用 →「合并转发内容（全局）」有流程图', !!globalForward && globalForward.includes(QUOTED_CHART))
check('B站 →「合并转发内容」有流程图', !!bilibiliForward && bilibiliForward.includes(QUOTED_CHART))
for (const platform of ['douyin', 'xiaohongshu', 'kuaishou']) {
  const options = forwardOptionsOf('[' + BT + platform + BT + ',' + BT + 'forwardContent' + BT + ']')
  check(platform + ' →「合并转发内容」里没有流程图（那是 B站独有的）', !!options && !options.includes(QUOTED_CHART))
}

console.log('\n[4] 解析链路真的认这个值')
const source = fs.readFileSync(path.join(pluginRoot, 'src', 'karin', 'platform', 'bilibili', 'bilibili.ts'), 'utf8')
check('按 sendContent 里的 chart 决定要不要渲染剧情图', source.includes('sendContent.some((item) => item === \'chart\')'))

const failed = results.filter((item) => !item.ok)
console.log('\n=== ' + (results.length - failed.length) + '/' + results.length + ' 通过 ===')
process.exitCode = failed.length ? 1 : 0
