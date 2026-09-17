/**
 * 构建脚本。
 *
 * 做两件事：
 * 1. 程序化调用 tsc（不派生 esbuild 等子进程），把 src 编译成 CJS 到 lib/；
 * 2. 把编译产物里保留的路径别名改写成相对路径 —— tsc 不会重写 import 说明符：
 *    - @/xxx            → karin 源码目录
 *    - @kkk/richtext    → 内置 richtext
 *    - node-karin[/sub] → 兼容层实现（这样产物自带兼容层，不依赖 node_modules 里的转发包）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const configPath = path.join(root, 'tsconfig.build.json')
const outDir = path.join(root, 'lib')

const configFile = ts.readConfigFile(configPath, (file) => readFileSync(file, 'utf8'))
if (configFile.error) {
  console.error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'))
  process.exit(1)
}
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root)
const options = { ...parsed.options, noCheck: true, incremental: false }

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })

const program = ts.createProgram(parsed.fileNames, options)
const emitResult = program.emit()

const diagnostics = ts.getPreEmitDiagnostics(program).filter((item) => item.category === ts.DiagnosticCategory.Error)
if (diagnostics.length) {
  for (const diagnostic of diagnostics.slice(0, 20)) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    const file = diagnostic.file ? path.relative(root, diagnostic.file.fileName) : ''
    const pos = diagnostic.file && diagnostic.start !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      : null
    console.error(file + (pos ? ':' + (pos.line + 1) + ':' + (pos.character + 1) : '') + ' ' + message)
  }
}

if (emitResult.emitSkipped) {
  console.error('构建失败：emit skipped')
  process.exit(1)
}

/** 顺序敏感：子路径必须排在 node-karin 之前 */
const ALIASES = [
  { prefix: 'node-karin/root', target: 'compat/root', exact: true },
  { prefix: 'node-karin/sqlite3', target: 'compat/sqlite3', exact: true },
  { prefix: 'node-karin/axios', target: 'compat/axios', exact: true },
  { prefix: 'node-karin/yaml', target: 'compat/yaml', exact: true },
  { prefix: 'node-karin/express', target: 'compat/express', exact: true },
  { prefix: 'node-karin/lodash', target: 'compat/lodash', exact: true },
  { prefix: 'node-karin/start', target: 'compat/start', exact: true },
  { prefix: 'node-karin', target: 'compat/node-karin', exact: true },
  { prefix: '@kkk/richtext', target: 'richtext', exact: false },
  // 上游模板里的 @template/* 别名指向 ktr 模板目录（@template/template/xxx = ktr/template/xxx）
  { prefix: '@template/', target: 'ktr', exact: false },
  { prefix: '@karinjs/template-react', target: 'compat/template-react', exact: true },
  { prefix: '@heroui/react', target: 'compat/heroui', exact: true },
  { prefix: '@/', target: 'karin', exact: false }
]

const rewriteAliases = (dir) => {
  let count = 0
  for (const entry of ts.sys.readDirectory(dir, ['.js'])) {
    const source = readFileSync(entry, 'utf8')
    if (!ALIASES.some((alias) => source.includes(alias.prefix))) continue
    let replaced = source
    for (const alias of ALIASES) {
      const targetPath = path.join(outDir, alias.target)
      const relative = path.relative(path.dirname(entry), alias.exact ? targetPath + '.js' : targetPath).replace(/\\/g, '/')
      const prefix = relative.startsWith('.') ? relative : './' + relative
      const staticPattern = /(require\()(?:"([^"]*)"|'([^']*)')(\))/g
      const dynamicPattern = /(import\()(?:"([^"]*)"|'([^']*)')(\))/g
      const replace = (match, lead, dq, sq, tail) => {
        const value = dq !== undefined ? dq : sq
        if (!value) return match
        const matches = alias.exact ? value === alias.prefix : value.startsWith(alias.prefix)
        if (!matches) return match
        const rest = alias.exact ? '' : value.slice(alias.prefix.length)
        const built = prefix + (rest ? (rest.startsWith('/') ? rest : '/' + rest) : '')
        const quote = dq !== undefined ? '"' : "'"
        return lead + quote + built + quote + tail
      }
      replaced = replaced.replace(staticPattern, replace).replace(dynamicPattern, replace)
    }
    if (replaced !== source) {
      writeFileSync(entry, replaced)
      count++
    }
  }
  return count
}

/** 兜底检查：CJS 产物里残留 import.meta 会让 Node 把该文件当 ESM（exports is not defined） */
const checkImportMeta = (dir) => {
  const offenders = []
  for (const entry of ts.sys.readDirectory(dir, ['.js'])) {
    const source = readFileSync(entry, 'utf8')
    if (!source.includes('import.meta')) continue
    // 只认代码里的 import.meta（注释里提到不算）
    const inCode = source.split(/\r?\n/).some((line) => {
      const trimmed = line.trim()
      if (!trimmed.includes('import.meta')) return false
      return !(trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*'))
    })
    if (inCode) offenders.push(path.relative(root, entry))
  }
  return offenders
}

mkdirSync(outDir, { recursive: true })
const rewritten = rewriteAliases(outDir)
const offenders = checkImportMeta(outDir)
if (offenders.length) {
  console.error('构建失败：以下产物残留 import.meta，CJS 下会被 Node 当成 ESM：')
  for (const item of offenders) console.error('  - ' + item)
  process.exit(1)
}
console.log('构建完成：输出到 ' + path.relative(root, outDir) + '，重写别名文件 ' + rewritten + ' 个')
