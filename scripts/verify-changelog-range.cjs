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
const cases = [['3.11.1', '3.12.0'], ['3.11.0', '3.12.0'], ['3.10.2', '3.12.0'], ['3.12.0', '3.12.0']]
for (const [startVersion, endVersion] of cases) {
  const out = karin.range({ data: md, startVersion, endVersion, compare: 'semver' })
  const keys = Object.keys(karin.parseChangelog(out))
  const dumped = out.length >= md.length
  console.log(
    'range(' + startVersion + ' → ' + endVersion + ')：命中 [' + keys.join(', ') + ']  长度=' + out.length +
    (dumped ? '  ⚠ 返回了整份日志（没裁出来）' : '')
  )
}
