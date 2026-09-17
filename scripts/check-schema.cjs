/**
 * 检查动态生成的配置 Schema：枚举字段解析成了哪些下拉选项、有没有漏掉默认值。
 *
 * 用法：node scripts/check-schema.cjs [--all]
 *   --all  连没有解析出枚举的字段一起打印
 */
const path = require('node:path')

const pluginRoot = path.resolve(__dirname, '..')
const { parseConfigMeta, buildUpstreamSchema } = require(path.join(pluginRoot, 'lib/schema.js'))
const defaults = require(path.join(pluginRoot, 'config/default_config/config.json'))

const meta = parseConfigMeta(pluginRoot)

/** 按配置结构走一遍，取出每个字段的默认值 */
const walk = (value, fieldPath, visit) => {
  if (Array.isArray(value)) {
    visit(fieldPath, value)
    const sample = value.find((item) => item !== null && item !== undefined)
    if (sample !== undefined) walk(sample, fieldPath + '[]', visit)
    return
  }
  if (value && typeof value === 'object') {
    visit(fieldPath, value)
    for (const [key, item] of Object.entries(value)) walk(item, fieldPath + '.' + key, visit)
    return
  }
  visit(fieldPath, value)
}

const rows = []
for (const [key, value] of Object.entries(defaults)) {
  walk(value, key, (fieldPath, sample) => rows.push({ fieldPath, sample }))
}

const showAll = process.argv.includes('--all')
let withEnum = 0
let leaf = 0
for (const row of rows) {
  const info = meta[row.fieldPath] ?? meta['#' + row.fieldPath.split('.').pop().replace(/\[\]$/, '')]
  const options = info && info.options
  if (!options) {
    if (showAll) console.log('  · ' + row.fieldPath + '  = ' + JSON.stringify(row.sample))
    continue
  }
  withEnum += 1
  console.log('▸ ' + row.fieldPath + '  （默认 ' + JSON.stringify(row.sample) + '）')
  for (const option of options) {
    console.log('    - ' + JSON.stringify(option.value) + (option.label ? '  ' + option.label : ''))
  }
}
for (const row of rows) if (!Array.isArray(row.sample) && (!row.sample || typeof row.sample !== 'object')) leaf += 1

console.log('\n字段总数 ' + rows.length + '（叶子 ' + leaf + '），解析出下拉的 ' + withEnum + ' 个')
console.log('Schema 顶层键：' + Object.keys(buildUpstreamSchema(pluginRoot).dict ?? {}).join(', '))
