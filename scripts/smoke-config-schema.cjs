/**
 * 控制台配置项冒烟：bilibili.sendContent 的候选项里必须有 chart（互动视频流程图）。
 *
 * 机制：schema 是插件加载时按 config/default_config/*.yaml 的注释（「可选值：…」）现算的，
 * 所以这个脚本直接调插件自己的 schema 构建函数，把这一项的候选项打出来 —— 
 * 以后遇到「面板里少一个勾选项」，跑它就能自证是代码问题还是没重启。
 */
const path = require('node:path')
const pluginRoot = path.resolve(__dirname, '..')
const libRoot = path.join(pluginRoot, 'lib')
const noop = () => {}
const runtime = require(path.join(libRoot, 'compat', 'runtime.js'))
runtime.bindRuntime({ ctx: { get: () => undefined, logger: () => ({ info: noop, warn: noop, error: noop, debug: noop, mark: noop }), bots: [], registry: new Map(), on: noop, middleware: noop }, config: { app: {} }, dataRoot: path.join(pluginRoot, 'data-smoke-config-schema'), pluginRoot, master: () => [] })

const mod = require(path.join(libRoot, 'schema.js'))
const names = Object.keys(mod).filter((k) => typeof mod[k] === 'function')
console.log('schema.js 导出的函数: ' + names.join(', '))

/**
 * 在返回的 schema / 元数据里找 sendContent 的候选项。
 *
 * ⚠️ cordis 的 Schema 实例是**可调用对象**：`typeof schema === 'function'`，
 * 而候选值藏在它的 `.dict` 里。只认 `typeof 'object'` 的话第一步就被挡回来，
 * 「明明有 chart」也会报成没有 —— 这个脚本自己踩过一次，别再退回去。
 */
const isSchemaNode = (item) => !!item && (typeof item === 'object' || typeof item === 'function')
const collect = (value, out = [], depth = 0) => {
  if (depth > 8 || !isSchemaNode(value)) return out
  try {
    for (const key of Object.keys(value)) {
      const item = value[key]
      if (key === 'sendContent') out.push(item)
      else if (isSchemaNode(item)) collect(item, out, depth + 1)
    }
  } catch { /* 忽略不可枚举的东西 */ }
  return out
}

let best = null
for (const name of names) {
  for (const args of [[pluginRoot], [pluginRoot, {}], []]) {
    try {
      const value = mod[name](...args)
      const hits = collect(value)
      if (hits.length) { best = { name, args: args.length, hits }; break }
    } catch { /* 换下一个签名 */ }
  }
  if (best) break
}

if (!best) {
  console.log('❌ 没能从 schema 里取到 sendContent（导出名: ' + names.join(',') + '）')
  process.exit(1)
}
const text = JSON.stringify(best.hits)
console.log('取到 ' + best.hits.length + ' 处 sendContent（来自 ' + best.name + '）')
const hasChart = text.includes('chart')
console.log('bilibili.sendContent 候选项: ' + (text.match(/bilibili[^]{0,400}/) ?? ['（未匹配）'])[0].slice(0, 220))
console.log('')
if (hasChart) { console.log('=== 通过：schema 里已经有 chart，重启 Koishi 后控制台就会出现这个勾选项 ==='); process.exit(0) }
console.log('=== 失败：schema 里没有 chart，说明没读到 YAML 里那句「可选值」注释 ===')
process.exit(1)
