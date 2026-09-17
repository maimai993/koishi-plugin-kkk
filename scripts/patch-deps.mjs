/**
 * 依赖修补脚本（Koishi 迁移补充）。
 *
 * 有些依赖的打包对 CJS 消费方是坏的，而我们的插件是 CJS 产物（tsc 直出，无打包器）：
 *
 * 1. \`@phosphor-icons/react\`：package.json 声明 "type": "module"，却把 require 条件指向
 *    \`dist/index.cjs.js\`（.js 扩展名 → Node 按 ESM 解析 → 文件里却是 CJS 语法，
 *    直接报 "exports is not defined in ES module scope"）。
 *    修法：把该文件复制成 \`.cjs\`，并把 package.json 里 require 条件改指过去。
 *
 * 用法（安装依赖后执行一次）：node scripts/patch-deps.mjs
 * 幂等：已修补过会跳过。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const modules = path.join(root, 'node_modules')

let patched = 0

/** 把 CJS 实现复制成 .cjs 并改写 package.json 里的 require 条件 */
function patchPhosphorIcons () {
  const dir = path.join(modules, '@phosphor-icons', 'react')
  const pkgPath = path.join(dir, 'package.json')
  if (!existsSync(pkgPath)) return
  const raw = readFileSync(pkgPath, 'utf8')
  if (raw.includes('./dist/index.cjs"')) {
    console.log('已修补：@phosphor-icons/react')
    return
  }
  const source = path.join(dir, 'dist', 'index.cjs.js')
  if (!existsSync(source)) {
    console.warn('跳过：@phosphor-icons/react 缺少 dist/index.cjs.js')
    return
  }
  copyFileSync(source, path.join(dir, 'dist', 'index.cjs'))
  writeFileSync(pkgPath, raw.split('./dist/index.cjs.js').join('./dist/index.cjs'))
  console.log('已修补：@phosphor-icons/react（require → dist/index.cjs）')
  patched++
}

patchPhosphorIcons()

console.log(patched ? '依赖修补完成：' + patched + ' 个包' : '依赖修补完成：无需改动')
