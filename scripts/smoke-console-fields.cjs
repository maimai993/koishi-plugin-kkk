/**
 * 控制台（Koishi 插件配置页）字段冒烟测试。
 *
 * 用户要求：
 *   1. **所有设置项都要在控制台里显示出来**（之前为了逼大家用面板，全部隐藏了，现在恢复）；
 *   2. 说明要**说人话**、是给用户看的；
 *   3. 说明**不要用 markdown 语法**（控制台是按纯文本渲染的，写 **粗体** 只会看到一堆星号）。
 *
 * 用法：node scripts/smoke-console-fields.cjs
 */
const path = require('node:path')

const pluginRoot = path.resolve(__dirname, '..')
const libRoot = path.join(pluginRoot, 'lib')
const runtime = require(path.join(libRoot, 'compat', 'runtime.js'))
const noop = () => {}
runtime.bindRuntime({
  ctx: { get: () => undefined, logger: () => ({ info: noop, warn: noop, error: noop, debug: noop, mark: noop }), bots: [], registry: new Map() },
  config: { app: {} },
  dataRoot: path.join(pluginRoot, 'data-smoke-console'),
  pluginRoot,
  master: () => []
})

const { Config } = require(path.join(libRoot, 'index.js'))

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  —— ' + detail : ''))
}

/** 收集所有字段：路径 / 是否 hidden / 说明 */
const walk = (node, prefix, out) => {
  if (!node) return out
  const hidden = node.meta?.hidden === true
  if (node.type === 'object') {
    for (const [key, child] of Object.entries(node.dict ?? {})) walk(child, prefix ? prefix + '.' + key : key, out)
  } else if (node.type === 'intersect' || node.type === 'union' || node.type === 'tuple') {
    for (const child of node.list ?? []) walk(child, prefix, out)
  } else {
    out.push({ path: prefix || '(root)', hidden, description: String(node.meta?.description ?? '') })
  }
  return out
}
const fields = walk(Config, '', [])

console.log('\n[1] 设置项要能看见')
const hiddenCount = fields.filter((item) => item.hidden).length
check('没有隐藏任何字段', hiddenCount === 0, '隐藏 ' + hiddenCount + ' 个')
check('字段数量看起来正常（>100 项，含上游各平台配置）', fields.length > 100, fields.length + ' 个字段')
for (const key of ['qq.qqPanel', 'qq.playerEnabled', 'qq.errorReportUpload', 'qq.errorNoCard', 'advanced.masters', 'forward.global']) {
  check('可见：' + key, fields.some((item) => item.path === key && !item.hidden))
}

console.log('\n[1.5] 分组不要折叠（用户要求：一进来就能看到全部）')
const collapsed = []
const walkCollapse = (node, prefix) => {
  if (!node) return
  if (node.meta?.collapse === true) collapsed.push(prefix || '(root)')
  if (node.type === 'object') for (const [key, child] of Object.entries(node.dict ?? {})) walkCollapse(child, prefix ? prefix + '.' + key : key)
  else if (node.type === 'intersect' || node.type === 'union' || node.type === 'tuple') for (const child of node.list ?? []) walkCollapse(child, prefix)
}
walkCollapse(Config, '')
check('没有任何折叠分组', collapsed.length === 0, collapsed.join(', '))

console.log('\n[2] 说明说人话、不带 markdown 语法')
const MD_PATTERNS = [
  ['**加粗**', /\*\*/],
  ['反引号代码', /\x60/],
  ['markdown 链接', /\]\([^)]+\)/],
  ['标题井号', /(^|\s)#{1,6}\s/],
  ['markdown 表格', /\n\s*\|.*\|/]
]
const offenders = []
for (const item of fields) {
  for (const [label, pattern] of MD_PATTERNS) {
    if (pattern.test(item.description)) offenders.push(item.path + '（' + label + '）')
  }
}
check('没有任何字段说明带 markdown 语法', offenders.length === 0, offenders.slice(0, 6).join(', '))

console.log('\n[3] 常用设置每条都要有说明（用户看不懂就等于没配）')
const { QQ_FIELDS } = require(path.join(libRoot, 'qqOptions.js'))
const missing = QQ_FIELDS.filter((field) => !field.description || field.description.length < 8).map((field) => field.key)
check('常用设置的说明都不为空', missing.length === 0, missing.join(', '))
const tooLong = QQ_FIELDS.filter((field) => field.description.length > 200).map((field) => field.key + '(' + field.description.length + ')')
check('没有超长的「论文式」说明（<=200 字）', tooLong.length === 0, tooLong.join(', '))

const failed = results.filter((item) => !item.ok)
console.log('\n=== ' + (results.length - failed.length) + '/' + results.length + ' 通过 ===')
process.exit(failed.length ? 1 : 0)
