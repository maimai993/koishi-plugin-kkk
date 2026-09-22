/**
 * 面板（/kkk）分类冒烟测试。
 *
 * 覆盖两件事：
 *   1. 「Koishi 设置」这一组分类确实注入进了面板前端包（分类入口 / 分发 case / 4 个字段路径），
 *      并且**没有 masters**（主人账号属于 Koishi 权限体系，面板是免登录页面，不给它开口子）；
 *   2. 服务端（src/webui.ts）的白名单与面板字段一一对应 —— 前端能改的，服务端就认这几个；
 *      前端塞别的东西进来，服务端会丢掉。
 *
 * 用法：node scripts/smoke-panel-tabs.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const pluginRoot = path.resolve(__dirname, '..')
const webAssets = path.join(pluginRoot, 'assets', 'web', 'assets')
const BT = String.fromCharCode(96)

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  —— ' + detail : ''))
}

const bundle = fs.readdirSync(webAssets).filter((name) => /^index-.*[.]js$/.test(name))
  .map((name) => path.join(webAssets, name))
  .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0]
const text = fs.readFileSync(bundle, 'utf8')
const count = (needle) => text.split(needle).length - 1

console.log('\n[1] 面板里多了「Koishi 设置」分类（' + path.basename(bundle) + '）')
check('分类入口存在且只有一个', count('{key:' + BT + 'koishi' + BT) === 1, '× ' + count('{key:' + BT + 'koishi' + BT))
check('分发 case 存在且只有一个', count('case' + BT + 'koishi' + BT) === 1, '× ' + count('case' + BT + 'koishi' + BT))
check('组件定义存在', count('KKKNativeConfig=') === 1)

console.log('\n[2] 这一组里是 4 个字段，且没有 masters')
for (const key of ['dataPath', 'debug', 'autoParse', 'webUiAuth']) {
  const needle = BT + 'koishi' + BT + ',' + BT + key + BT
  check('字段路径 ' + key, count(needle) === 1, '× ' + count(needle))
}
check('没有 masters（面板不给主人账号开口子）', count(BT + 'koishi' + BT + ',' + BT + 'masters' + BT) === 0)

console.log('\n[3] 没有把 undefined 塞进 JSX children（拼串时容易多一个逗号）')
check('不存在 children:[, 这种空位', count('children:[,') === 0)

console.log('\n[4] 服务端白名单与面板字段一一对应')
const webui = fs.readFileSync(path.join(pluginRoot, 'src', 'webui.ts'), 'utf8')
const match = webui.match(/const NATIVE_PANEL_KEYS = \[([^\]]*)\]/)
const keys = match ? match[1].split(',').map((item) => item.trim().replace(/['"]/g, '')).filter(Boolean) : []
check('找到 NATIVE_PANEL_KEYS', keys.length > 0, keys.join(', '))
check('白名单正好是面板那 4 个字段', JSON.stringify(keys) === JSON.stringify(['dataPath', 'debug', 'autoParse', 'webUiAuth']), JSON.stringify(keys))
check('白名单里没有 masters', !keys.includes('masters'))
check('GET 会把这一组返回给面板', /koishi: readNativePanelOptions\(config\)/.test(webui))
check('POST 会把这一组写回插件配置顶层', /const \{ qq, koishi: nativeGroup, \.\.\.upstream \} = normalizeLists\(body\)/.test(webui))

const failed = results.filter((item) => !item.ok)
console.log('\n=== ' + (results.length - failed.length) + '/' + results.length + ' 通过 ===')
process.exitCode = failed.length ? 1 : 0
