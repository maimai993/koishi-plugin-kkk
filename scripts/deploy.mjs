/**
 * 把插件「以运行时最小集」部署到工作区的 node_modules 里。
 *
 * 只复制运行需要的文件（package.json / lib / config / resources / CHANGELOG.md / LICENSE），
 * 不带 src、scripts、测试数据。依赖不复制（那会多出 400+ MB），而是在副本里建一个
 * node_modules junction 指回开发目录的依赖，Node 的模块解析照常生效。
 *
 * 用法：
 *   node scripts/deploy.mjs                        # 部署到 <工作区>/node_modules/koishi-plugin-kkk
 *   node scripts/deploy.mjs --with-deps            # 连依赖一起复制（自包含，可整体拷走，约 450 MB）
 *   node scripts/deploy.mjs --target <dir>         # 指定目标目录
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const withDeps = argv.includes('--with-deps')
const targetIndex = argv.indexOf('--target')
const target = targetIndex >= 0
  ? path.resolve(argv[targetIndex + 1])
  : path.resolve(root, '..', '..', 'node_modules', 'koishi-plugin-kkk')

/** 运行时需要的文件/目录 */
// assets：配置页模板（assets/webui.html）；
// client：控制台入口（ctx.console.addEntry 会去这个目录找 index.js）
const ENTRIES = ['package.json', 'lib', 'config', 'resources', 'assets', 'client', 'CHANGELOG.md', 'LICENSE', 'dist']

if (!existsSync(path.join(root, 'lib', 'index.js'))) {
  console.error('还没有构建产物，请先执行：node scripts/build.mjs')
  process.exit(1)
}

// 清掉旧的部署（可能是 junction、目录或文件）
if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false })) {
  rmSync(target, { recursive: true, force: true })
}
mkdirSync(target, { recursive: true })

let copied = 0
let bytes = 0
for (const entry of ENTRIES) {
  const from = path.join(root, entry)
  if (!existsSync(from)) continue
  const to = path.join(target, entry)
  cpSync(from, to, { recursive: true })
  const size = statSync(from).isDirectory()
    ? readdirSync(from, { recursive: true }).reduce((sum, item) => {
      const file = path.join(from, item)
      return sum + (statSync(file).isFile() ? statSync(file).size : 0)
    }, 0)
    : statSync(from).size
  bytes += size
  copied++
  console.log('  复制 ' + entry + '（' + (size / 1024 / 1024).toFixed(2) + ' MB）')
}

if (withDeps) {
  const from = path.join(root, 'node_modules')
  if (existsSync(from)) {
    console.log('  复制 node_modules（依赖，比较慢）…')
    cpSync(from, path.join(target, 'node_modules'), { recursive: true })
  }
} else {
  // 依赖不复制，用 junction 指回开发目录；Node 解析依赖时会正常走到这里
  const deps = path.join(root, 'node_modules')
  if (existsSync(deps)) {
    symlinkSync(deps, path.join(target, 'node_modules'), 'junction')
    console.log('  依赖：junction → ' + deps)
  } else {
    console.warn('  警告：开发目录没有 node_modules，副本运行时会缺依赖')
  }
}

console.log('\n部署完成 → ' + target)
console.log('  文件 ' + copied + ' 项，约 ' + (bytes / 1024 / 1024).toFixed(2) + ' MB' + (withDeps ? '（另有依赖副本）' : '，依赖走 junction'))
console.log('  宿主重启（koishi start）后生效')
