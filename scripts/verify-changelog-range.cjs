/** 离线自验：CHANGELOG 的 `## x.y.z` 标题必须能被 range() 裁出来 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = 'E:/devkoishi/plugins/koishi-plugin-kkk'
const lib = path.join(root, 'lib')

const runtime = require(path.join(lib, 'compat/runtime.js'))
runtime.bindRuntime({ ctx: { config: { port: 5200 } }, config: { app: {} }, dataRoot: os.tmpdir() })
require(path.join(lib, 'compat/logger.js')).setLogger({ debug () {}, info () {}, warn () {}, error () {} })

const karin = require(path.join(lib, 'compat/node-karin.js'))
const md = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')

console.log('解析出的版本：' + Object.keys(karin.parseChangelog(md)).join(' , '))

/** 当前版本号（package.json）；CHANGELOG 顶部的 `## x.y.z` 必须是它，否则卡片会整份发出去 */
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const all = Object.keys(karin.parseChangelog(md))
if (!all.includes(version)) {
  console.log('❌ CHANGELOG 里没有 `## ' + version + '` 这一段（package.json 的版本号对不上）')
  process.exitCode = 1
} else {
  console.log('✅ package.json 版本 ' + version + ' 在 CHANGELOG 里有对应段落')
}

/** 取当前版本以及它下面 3 个历史版本，逐个验证「上一版 → 这一版」能裁出东西 */
const cases = []
for (let i = 0; i < all.length; i++) {
  cases.push([all[i + 1] ?? all[i], all[i]])
}
for (const [startVersion, endVersion] of cases) {
  // 最老那一版的下界只能等于它自己（没有更老的版本可当哨兵），range() 此时必然返回整份，
  // 属于工具本身的预期行为，不算失败。
  if (startVersion === endVersion && endVersion === all[all.length - 1]) continue
  const out = karin.range({ data: md, startVersion, endVersion, compare: 'semver' })
  const keys = Object.keys(karin.parseChangelog(out))
  const dumped = out.length >= md.length
  console.log(
    'range(' + startVersion + ' → ' + endVersion + ')：命中 [' + keys.join(', ') + ']  长度=' + out.length +
    (dumped ? '  ⚠ 返回了整份日志（没裁出来）' : '')
  )
  if (dumped) process.exitCode = 1
}
