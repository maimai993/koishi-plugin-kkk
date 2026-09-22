/**
 * 控制台（Koishi 插件配置页）可见性冒烟测试。
 *
 * 需求：**kkk 的配置界面里所有设置项都要隐藏**，只留一段「请到 WebUI 面板改」的说明。
 * 理由：同一份配置在控制台改一半、在面板改一半，两边都会把整份配置写回 koishi.yml，
 * 很容易互相覆盖（用户实际遇到过「面板里关了、控制台一保存又回来了」）。
 *
 * 隐藏用的是 Koishi 自带的 `Schema.*.hidden()`（控制台客户端认 `meta.hidden`：
 * 不渲染、但字段仍在 schema 里，所以控制台保存不会把值弄丢）。
 *
 * 用法：node scripts/smoke-console-hidden.cjs
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
  master: () => []
})

const { Config } = require(path.join(libRoot, 'index.js'))

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  —— ' + detail : ''))
}

/** 找出所有「可见」的叶子字段路径（hidden 的整棵子树都跳过） */
const visibleLeaves = (node, prefix = '') => {
  if (!node || node.meta?.hidden) return []
  const out = []
  if (node.type === 'object') {
    for (const [key, child] of Object.entries(node.dict ?? {})) out.push(...visibleLeaves(child, prefix ? prefix + '.' + key : key))
  } else if (node.type === 'intersect' || node.type === 'union' || node.type === 'tuple') {
    for (const child of node.list ?? []) out.push(...visibleLeaves(child, prefix))
  } else {
    out.push(prefix || '(root)')
  }
  return out
}

const visible = visibleLeaves(Config)

console.log('\n[1] 控制台里只剩一段指路文字')
check('可见字段只有 webuiGuide', visible.length === 1 && visible[0] === 'webuiGuide', visible.join(', ') || '（没有任何可见字段）')

console.log('\n[2] 那几组设置都还在 schema 里（隐藏 ≠ 删除，保存不会丢值）')
const hiddenGroups = ['qq', 'advanced', 'forward', 'upstream']
const branches = Config.type === 'intersect' ? Config.list : [Config]
const dict = Object.assign({}, ...branches.map((branch) => branch.dict ?? {}))
for (const key of hiddenGroups) {
  check('隐藏组仍然声明着：' + key, !!dict[key] && dict[key].meta?.hidden === true, dict[key] ? ('hidden=' + String(dict[key].meta?.hidden)) : '字段不存在')
}

console.log('\n[3] 指路文字写的是 WebUI 面板')
const guide = dict.webuiGuide
check('webuiGuide 可见', !!guide && guide.meta?.hidden !== true)
check('说明里提到 /kkk 面板', /\/kkk/.test(guide?.meta?.description ?? ''), String(guide?.meta?.description ?? '').slice(0, 40) + '…')
check('说明里写了「隐藏」这件事', /隐藏/.test(guide?.meta?.description ?? ''))

const failed = results.filter((item) => !item.ok)
console.log('\n=== ' + (results.length - failed.length) + '/' + results.length + ' 通过 ===')
process.exitCode = failed.length ? 1 : 0
