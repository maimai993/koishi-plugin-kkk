/**
 * 「用了没 import」检查（针对平台处理器里的在线播放器接口）。
 *
 * 背景：线上真实故障 —— `kuaishou.ts` / `xiaohongshu.ts` 里调了
 * `applyForceOnlinePlayer(this.e)`，但这两个文件**从来没 import 过它**，
 * 一发快手 / 小红书链接就是：
 *
 *     ReferenceError: applyForceOnlinePlayer is not defined
 *
 * 构建当时没拦住（用了未声明的名字，TypeScript 那条链路只做了转译）。
 *
 * 这里做的是**针对性**检查而不是通用 lint：把 `src/player` 导出的名字都收集起来，
 * 再看平台处理器里有没有「调用了却没 import」的。通用 lint 在这个仓库里噪声太大
 * （对象字面量、JSX 组件、同名局部函数都会误报），针对性检查零误报、直接锁住这个坑。
 *
 * 用法：node scripts/smoke-imports.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const pluginRoot = path.resolve(__dirname, '..')
const srcRoot = path.join(pluginRoot, 'src')

const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

const walk = (dir, filter) => {
  const out = []
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name)
    if (item.isDirectory()) out.push(...walk(full, filter))
    else if (filter(full)) out.push(full)
  }
  return out
}

/** src/player 导出的函数名 */
const playerFile = path.join(srcRoot, 'player', 'index.ts')
const playerText = fs.readFileSync(playerFile, 'utf8')
const playerExports = new Set()
for (const match of playerText.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) playerExports.add(match[1])
for (const match of playerText.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)/g)) playerExports.add(match[1])

/** 这个文件有没有从 player 模块 import 这个名字 */
const importsFromPlayer = (text, name) => {
  // 注意用 [^{}]* 而不是 [\s\S]*?：后者会把前面好几条 import 一起吞进来，名字表就废了
  // 也兼容 `import karin, { a, b } from '...'` 这种默认 + 具名混写
  for (const match of text.matchAll(/import\s*(?:[A-Za-z_$][\w$]*\s*,)?\s*(?:type\s*)?\{([^{}]*)\}\s*from\s*'([^']*player[^']*)'/g)) {
    const names = match[1].split(',').map((item) => item.trim().split(/\s+as\s+/).pop().trim())
    if (names.includes(name)) return true
  }
  return false
}

const targets = walk(path.join(srcRoot, 'karin'), (file) => file.endsWith('.ts'))
const problems = []
let checked = 0
for (const file of targets) {
  const text = stripComments(fs.readFileSync(file, 'utf8'))
  for (const name of playerExports) {
    const used = new RegExp('(?<![\\w$.])' + name + '\\s*\\(').test(text)
    if (!used) continue
    checked++
    if (importsFromPlayer(text, name)) continue
    // 本文件自己定义了同名函数（重新导出等）就不算漏
    if (new RegExp('function\\s+' + name + '\\s*\\(').test(text)) continue
    problems.push({ file: path.relative(srcRoot, file), name })
  }
}

console.log('检查了 ' + targets.length + ' 个源文件，player 导出 ' + playerExports.size + ' 个名字，命中调用 ' + checked + ' 处')

// 自检：这个检查本身得真的能抓到（拿线上那次的形状验一下）
const fakeBad = "export const x = async () => { applyForceOnlinePlayer(this.e) }"
const fakeGood = "import { applyForceOnlinePlayer } from '../../../player'\nexport const x = async () => { applyForceOnlinePlayer(this.e) }"
const selfCheck = [{
  name: '自检：漏 import 的写法必须判为问题',
  ok: !importsFromPlayer(fakeBad, 'applyForceOnlinePlayer')
}, {
  name: '自检：正常 import 的写法必须放行',
  ok: importsFromPlayer(fakeGood, 'applyForceOnlinePlayer')
}]
for (const item of selfCheck) console.log((item.ok ? '  ✅ ' : '  ❌ ') + item.name)

const failed = problems.length > 0 || selfCheck.some((item) => !item.ok)
if (problems.length === 0) {
  console.log('\n=== 通过：平台处理器里没有「调用了却没 import」的在线播放器接口 ===')
} else {
  for (const item of problems) console.log('  ❌ ' + item.file + ' 调用了 ' + item.name + ' 但没 import')
  console.log('\n=== 失败：' + problems.length + ' 处 ===')
}
process.exitCode = failed ? 1 : 0
