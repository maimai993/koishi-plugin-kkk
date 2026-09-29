/**
 * 把插件「以运行时最小集」部署到工作区的 node_modules 里。
 *
 * 只复制运行需要的文件（package.json / lib / config / resources / CHANGELOG.md / LICENSE），
 * 不带 src、scripts、测试数据。依赖不复制（那会多出 400+ MB），而是在副本里建一个
 * node_modules junction 指回开发目录的依赖，Node 的模块解析照常生效。
 *
 * 同步策略是「镜像」而不是「先删再拷」：
 *   - 覆盖：源文件比目标新（或大小不同）才复制
 *   - 清理：目标里源已经没有的文件逐个删掉（比如删掉的旧模块），避免残留文件被 require 到
 *   - 依赖 junction：路径不对（比如项目从 D 盘迁到 E 盘后指向了不存在的旧路径）就重建
 *
 * 用法：
 *   node scripts/deploy.mjs                        # 部署到 <工作区>/node_modules/koishi-plugin-kkk
 *   node scripts/deploy.mjs --with-deps            # 连依赖一起复制（自包含，可整体拷走，约 450 MB）
 *   node scripts/deploy.mjs --target <dir>         # 指定目标目录
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
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

const stats = { copied: 0, removed: 0, bytes: 0 }

/** 收集目录里的相对文件路径（用 / 分隔） */
function walk (dir, base = dir, out = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, out)
    else if (entry.isFile()) out.set(path.relative(base, full).split(path.sep).join('/'), full)
  }
  return out
}

/** 目录镜像：该覆盖的覆盖，该删的删 */
function mirrorDir (from, to) {
  const src = walk(from)
  const dst = existsSync(to)
    ? walk(to)
    : (mkdirSync(to, { recursive: true }), new Map())

  for (const [rel, srcFile] of src) {
    const dstFile = path.join(to, rel.split('/').join(path.sep))
    const s = statSync(srcFile)
    const d = existsSync(dstFile) ? statSync(dstFile) : null
    if (d && d.size === s.size && d.mtimeMs >= s.mtimeMs) continue
    mkdirSync(path.dirname(dstFile), { recursive: true })
    cpSync(srcFile, dstFile)
    stats.copied++
    stats.bytes += s.size
  }

  for (const [rel, dstFile] of dst) {
    if (src.has(rel)) continue
    rmSync(dstFile, { force: true })
    stats.removed++
    console.log('  删除残留 ' + rel)
  }
}

mkdirSync(target, { recursive: true })

for (const entry of ENTRIES) {
  const from = path.join(root, entry)
  if (!existsSync(from)) continue
  const to = path.join(target, entry)
  if (statSync(from).isDirectory()) {
    mirrorDir(from, to)
  } else {
    const s = statSync(from)
    const d = existsSync(to) ? statSync(to) : null
    if (d && d.size === s.size && d.mtimeMs >= s.mtimeMs) continue
    cpSync(from, to)
    stats.copied++
    stats.bytes += s.size
  }
}

// 依赖：--with-deps 时整份复制，否则用 junction 指回开发目录
const depsLink = path.join(target, 'node_modules')
const deps = path.join(root, 'node_modules')
if (withDeps) {
  if (existsSync(deps)) {
    console.log('  复制 node_modules（依赖，比较慢）…')
    cpSync(deps, depsLink, { recursive: true })
  }
} else if (existsSync(deps)) {
  // junction 可能指向一个已经不存在的路径（项目换过盘符/目录），这时必须重建，
  // 否则运行时解析插件私有依赖会直接失败
  let current = null
  if (lstatSync(depsLink, { throwIfNoEntry: false })) {
    try { current = realpathSync(depsLink) } catch { current = null }
  }
  if (current && path.resolve(current) === path.resolve(deps)) {
    console.log('  依赖：junction 已正确 → ' + deps)
  } else {
    if (existsSync(depsLink) || lstatSync(depsLink, { throwIfNoEntry: false })) {
      try { rmSync(depsLink, { recursive: true, force: true }) } catch { unlinkSync(depsLink) }
    }
    symlinkSync(deps, depsLink, 'junction')
    console.log('  依赖：junction' + (current ? '（修复，原来指向 ' + current + '）' : '') + ' → ' + deps)
  }
} else {
  console.warn('  警告：开发目录没有 node_modules，副本运行时会缺依赖')
}

console.log('\n部署完成 → ' + target)
console.log('  更新 ' + stats.copied + ' 个文件，约 ' + (stats.bytes / 1024 / 1024).toFixed(2) + ' MB；清理残留 ' + stats.removed + ' 个'
  + (withDeps ? '；另有依赖副本' : '；依赖走 junction'))
console.log('  宿主重启（koishi start）后生效')
