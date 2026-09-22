/**
 * 「每个编译产物都 require 得动」冒烟测试。
 *
 * 起因（线上真实故障）：给 player/server.ts 加了一行
 * `import { tryGetRuntime } from '../../compat/runtime'` —— 多写了一层 `..`，
 * 编译出来变成 `require("../../compat/runtime")`（指向插件根目录下的 compat，不存在）。
 * TypeScript 那条链路只做转译、不解析路径，构建时毫无提示；**插件在用户机器上直接加载失败**：
 *
 *     [W] config failed to load kkk
 *     Error: Cannot find module '../../compat/runtime'
 *
 * 这个测试就是把 lib 下每个 .js 都 require 一遍 —— 路径写错、模块顶层就抛异常，全都跑不掉。
 *
 * 用法：node scripts/smoke-require.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

const pluginRoot = path.resolve(__dirname, '..')
const libRoot = path.join(pluginRoot, 'lib')

/** 绑定最小运行时：很多模块在顶层就读配置/日志 */
const runtime = require(path.join(libRoot, 'compat', 'runtime.js'))
const noop = () => {}
runtime.bindRuntime({
  ctx: {
    get: () => undefined,
    logger: () => ({ info: noop, warn: noop, error: noop, debug: noop, mark: noop }),
    bots: [],
    registry: new Map(),
    on: noop,
    middleware: noop
  },
  config: { app: {} },
  dataRoot: path.join(pluginRoot, 'data-smoke-require'),
  pluginRoot,
  master: () => []
})

const walk = (dir) => {
  const out = []
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name)
    if (item.isDirectory()) out.push(...walk(full))
    else if (item.name.endsWith('.js')) out.push(full)
  }
  return out
}

const req = createRequire(path.join(libRoot, 'index.js'))
const files = walk(libRoot)
const failures = []
let ok = 0
let esm = 0
/** 缺第三方依赖（宿主没装）的模块：单独列出，不算失败 */
const optional = []
for (const file of files) {
  try {
    req(file)
    ok++
  } catch (error) {
    const message = String(error?.message ?? error)
    /** 模板类模块是 ESM（用 import 加载的），require 报这个是**预期**的，不算失败 */
    const isEsm = error?.code === 'ERR_REQUIRE_ESM' || error?.code === 'ERR_REQUIRE_ASYNC_MODULE'
      || /Cannot use import statement outside a module|require\(\) of ES Module/.test(message)
    if (isEsm) { esm++; continue }
    /**
     * 缺**第三方包**（cors / node:sqlite 之类）不算这次要抓的问题：有些模块是动态 import 的可选路径，
     * 依赖装没装取决于宿主环境。**相对路径**找不到才是真问题（就是这次线上的那种），照旧算失败。
     */
    const missing = /Cannot find module '([^']+)'/.exec(message)
    if (missing && !missing[1].startsWith('.')) {
      optional.push(path.relative(libRoot, file) + ' → 缺依赖 ' + missing[1])
      continue
    }
    failures.push({ file: path.relative(libRoot, file), message })
  }
}

console.log('检查了 ' + files.length + ' 个编译产物：require 成功 ' + ok + ' 个，ESM（预期跳过）' + esm + ' 个，缺第三方依赖（预期跳过）' + optional.length + ' 个')
for (const item of optional) console.log('  · ' + item)
if (failures.length === 0) {
  console.log('\n=== 通过：每个模块都加载得动（没有写错的 import 路径 / 顶层异常） ===')
  // 用 process.exit：require 这些模块时可能有别的东西把 exitCode 置成了非 0
  process.exit(0)
} else {
  for (const item of failures) console.log('  ❌ ' + item.file + ' → ' + item.message.split('\n')[0])
  console.log('\n=== 失败：' + failures.length + ' 个模块加载不了 ===')
  process.exit(1)
}
