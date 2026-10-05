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
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
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

/**
 * 记录本次 emit 写出的文件，用于构建后清理残留。
 *
 * 以前是 emit 前直接 rmSync 掉整个 lib（一次删几百个文件），现在改成事后比对清理：
 * 只删「上次产物里有、这次没被重写」的文件，正常情况下是 0 个。
 */
const emitted = new Set()
const recordAndWrite = (fileName, text, writeByteOrderMark) => {
  emitted.add(path.resolve(fileName))
  ts.sys.writeFile(fileName, text, writeByteOrderMark)
}

const program = ts.createProgram(parsed.fileNames, options)
const emitResult = program.emit(undefined, recordAndWrite)

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

/** 递归收集目录下的文件（只用于找残留产物） */
const walkFiles = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/** 清掉这次没被重写的旧产物（比如删除源文件后 lib 里留下的孤儿 .js） */
const cleanStaleArtifacts = () => {
  const stale = walkFiles(outDir).filter((file) => {
    if (!/\.(js|cjs|mjs|d\.ts|map)$/.test(file)) return false
    return !emitted.has(path.resolve(file))
  })
  for (const file of stale) {
    rmSync(file, { force: true })
    console.log('  清理残留 ' + path.relative(outDir, file).split(path.sep).join('/'))
  }
  return stale.length
}

/** 顺序敏感：子路径必须排在 node-karin 之前 */
const ALIASES = [
  { prefix: 'node-karin/root', target: 'compat/root', exact: true },
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
  // 这个包自己打包有问题（type:module + require 指向 .js），require 它就抛
  // 「exports is not defined in ES module scope」，会让所有卡片模板加载失败 → 接到 lucide 上
  { prefix: '@phosphor-icons/react', target: 'compat/phosphor-icons', exact: true },
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

/**
 * 兜底检查：产物里残留**裸** `node-karin` 引用。
 *
 * ## 为什么必须卡死在这一步
 * `node-karin` 是 karin 生态的包，**不在本插件的 dependencies 里**（产物自带兼容层），
 * 所以别名没改写干净 = 装到宿主上直接 `Cannot find module 'node-karin'`，
 * 而且是**加载期**就崩，宿主连插件列表都起不来。
 *
 * 线上真出过：3.11.0 那份产物里有 56 个文件裸 `require("node-karin")`，
 * 宿主一加载就报 `Error: Cannot find module 'node-karin'`（lib/player/index.js:83）。
 * 这种错误只在**装到干净的 node_modules 里**才暴露，本地开发目录因为有转发包永远发现不了。
 *
 * 只认代码里的引用（注释里提到这个包名不算）。
 */
const checkBareNodeKarin = (dir) => {
  const offenders = []
  const pattern = /(require\(|import\()\s*["']node-karin(\/[^"']*)?["']\s*\)/
  for (const entry of ts.sys.readDirectory(dir, ['.js'])) {
    const source = readFileSync(entry, 'utf8')
    if (!source.includes('node-karin')) continue
    const inCode = source.split(/\r?\n/).some((line) => {
      const trimmed = line.trim()
      if (!trimmed.includes('node-karin')) return false
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return false
      return pattern.test(trimmed)
    })
    if (inCode) offenders.push(path.relative(root, entry))
  }
  return offenders
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

/**
 * 取当前 commit hash（不派生子进程）。
 *
 * 以前这里用 `execFileSync('git', ['rev-parse', 'HEAD'])`。**同步起子进程在部分环境里会直接失败**
 * （这台开发机上 `spawnSync`/`execFileSync` 一律返回 EBUSY，被沙箱掐掉时 build 会连一行输出都没有
 * 就退出），而 commit hash 只是卡片上「显示用」的元数据 —— 直接读 `.git` 目录更省事也更稳。
 *
 * 覆盖三种情况：分离头指针（HEAD 本身就是 hash）、普通分支（HEAD 是 `ref: refs/heads/x`，
 * 且该 ref 可能还没写进 `.git/refs`，而是压在 `.git/packed-refs` 里）、以及 worktree / submodule
 * （`.git` 是个指向真实 git 目录的文件）。
 *
 * 都读不到时退回 CI 给的 `GITHUB_SHA`（或空串，插件会显示「无 commit」）。
 * @returns 40 位 commit hash，或空串
 */
const readCommitHash = () => {
  try {
    let gitDir = path.join(root, '.git')
    if (existsSync(gitDir) && !statSync(gitDir).isDirectory()) {
      const pointer = readFileSync(gitDir, 'utf8').trim()
      const match = /^gitdir:\s*(.+)$/.exec(pointer)
      if (match) gitDir = path.resolve(root, match[1].trim())
    }
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    if (/^[0-9a-f]{40}$/i.test(head)) return head
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim()
    if (!ref) return ''
    const loose = path.join(gitDir, ...ref.split('/'))
    if (existsSync(loose)) return readFileSync(loose, 'utf8').trim()
    const packed = path.join(gitDir, 'packed-refs')
    if (existsSync(packed)) {
      for (const line of readFileSync(packed, 'utf8').split('\n')) {
        const [hash, name] = line.trim().split(/\s+/)
        if (name === ref && /^[0-9a-f]{40}$/i.test(hash)) return hash
      }
    }
  } catch {
    // 不在仓库里 / 结构不认识：交给下面的兜底
  }
  return String(process.env.GITHUB_SHA ?? '').trim()
}

/**
 * 写入构建元数据。
 *
 * 卡片上的「Built Time / Commit Hash」以前一直是空的：插件读的是 lib/build-metadata.json，
 * 但没有任何地方生成它。构建时顺手写一份，随 lib 一起部署（也会被打进 npm 包里）。
 */
const writeBuildMetadata = () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const commitHash = readCommitHash()
  const metadata = {
    version: String(pkg.version ?? ''),
    buildTime: new Date().toISOString(),
    buildTimestamp: Date.now(),
    name: String(pkg.name ?? ''),
    description: String(pkg.description ?? ''),
    homepage: String(pkg.homepage ?? ''),
    commitHash,
    shortCommitHash: commitHash.slice(0, 7)
  }
  writeFileSync(path.join(outDir, 'build-metadata.json'), JSON.stringify(metadata, null, 2) + '\n')
  return metadata
}

mkdirSync(outDir, { recursive: true })
const buildMetadata = writeBuildMetadata()
const rewritten = rewriteAliases(outDir)
const bareKarin = checkBareNodeKarin(outDir)
if (bareKarin.length) {
  console.error('构建失败：以下产物还在引用外部的 node-karin 包（它不在依赖里，装到宿主上会 '
    + 'Cannot find module）—— 别名没改写干净：')
  for (const item of bareKarin) console.error('  - ' + item)
  process.exit(1)
}
const offenders = checkImportMeta(outDir)
if (offenders.length) {
  console.error('构建失败：以下产物残留 import.meta，CJS 下会被 Node 当成 ESM：')
  for (const item of offenders) console.error('  - ' + item)
  process.exit(1)
}
const stale = cleanStaleArtifacts()
console.log('构建完成：输出到 ' + path.relative(root, outDir) + '，重写别名文件 ' + rewritten + ' 个，清理残留 ' + stale + ' 个')
console.log('构建信息：v' + buildMetadata.version + ' · ' + (buildMetadata.shortCommitHash || '无 commit') + ' · ' + buildMetadata.buildTime)
