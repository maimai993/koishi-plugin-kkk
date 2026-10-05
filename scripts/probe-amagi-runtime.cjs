/**
 * 探针：**解析库 amagi 在运行时真的能加载**。
 *
 * ## 为什么单开一个探针
 * `tsc --noEmit` 只能证明**类型对得上**，证明不了**包能 require 进来**。
 * amagi 从 `7.0.0-beta.5` 升到 `beta.8` 那次就是活例子：tsc 只多出 4 条无关痛痒的
 * 类型错误，看着很安全，实际上 `require('@ikenxuan/amagi')` 直接抛
 * `schema.meta is not a function` —— beta.8 用了 zod 4 的 `.meta()`，而环境里
 * 实际生效的是 zod 3。**插件一启动就崩**，且崩在类型检查完全看不到的地方。
 *
 * 这类问题有三个特点，所以必须单独钉住：
 *   ① 只在 **require 那一刻** 才暴露，构建期（tsc）不报；
 *   ② 报错信息指向 amagi 内部（`schema.meta`），**看不出是 zod 版本不对**；
 *   ③ 探针脚本大多只测本地逻辑，不 require amagi，所以**全绿也发现不了**。
 *
 * ## 检查什么
 *   ① `require` 成功（挡住上面那类「版本升级后加载不了」）；
 *   ② 默认导出是可调用的构造函数（`amagiClient.ts` 就是 `new Client(...)` 这么用的）；
 *   ③ 装上的版本与 `package.json` 声明的范围相符 —— 声明 beta.8、实际跑着 beta.5
 *      这种漂移会让「以为修好了」变成假象；
 *   ④ 包级的 `douyinFetcher` 在（抖音 passport 扫码登录只在它上面有）。
 *
 * 用法：node scripts/probe-amagi-runtime.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')

let failed = 0
const check = (name, ok, detail) => {
  console.log((ok ? '  \u2714 ' : '  \u2718 ') + name + (detail ? '  \u2192 ' + detail : ''))
  if (!ok) failed++
}

console.log('\n[1] 解析库能加载')

let amagi = null
let loadError = ''
try {
  amagi = require('@ikenxuan/amagi')
} catch (error) {
  loadError = error instanceof Error ? error.message : String(error)
}
check('require(\'@ikenxuan/amagi\') 不抛错', amagi !== null, loadError || 'ok')
if (!amagi) {
  // 加载都过不了，后面几项没有意义，直接退出（并给出最可能的成因）
  console.log('\n  最常见成因：zod 版本不对（amagi 7.0.0-beta.6+ 用 zod 4 的 .meta()，')
  console.log('  zod 3 下会抛 schema.meta is not a function）。检查一下实际生效的 zod 版本。\n')
  process.exit(1)
}

console.log('\n[2] 导出面符合用法')

const Client = amagi.default ?? amagi.Client
check('默认导出是构造函数（amagiClient 里 new Client(...)）', typeof Client === 'function', typeof Client)
check('包级 douyinFetcher 在（抖音 passport 扫码只在它上面）', typeof amagi.douyinFetcher === 'object' || typeof amagi.douyinFetcher === 'function', typeof amagi.douyinFetcher)
check('createBilibiliRoutes 在（HTTP 路由注册用）', typeof amagi.createBilibiliRoutes === 'function')
check('wbi_sign 在（B站签名用）', typeof amagi.wbi_sign === 'function')

console.log('\n[3] 装上的版本与声明一致')

const declared = require(path.join(root, 'package.json')).dependencies['@ikenxuan/amagi']
let installed = ''
try {
  installed = require('@ikenxuan/amagi/package.json').version
} catch {
  // 包的 exports 可能不暴露 ./package.json，退回从 dist 里读
  installed = ''
}
if (!installed) {
  // exports 挡住了 `./package.json`（直接 require 会抛 ERR_PACKAGE_PATH_NOT_EXPORTED）：
  // 从入口文件逐级向上找，直到找到带 package.json 的那一层（就是包根）
  const { createRequire } = require('node:module')
  const req = createRequire(path.join(root, 'package.json'))
  let dir = path.dirname(req.resolve('@ikenxuan/amagi'))
  while (true) {
    const candidate = path.join(dir, 'package.json')
    if (fs.existsSync(candidate)) {
      installed = require(candidate).version
      break
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
}
check('声明版本', Boolean(declared), declared)
check('实际安装版本', Boolean(installed), installed)
check('两者一致（漂移会让「以为修好了」变成假象）', declared && installed && declared.replace(/^[\^~]/, '') === installed,
  `声明 ${declared} / 实际 ${installed}`)

console.log(failed === 0
  ? '\n\u2714 全部通过：amagi 能加载，导出面与版本都对\n'
  : `\n\u2718 ${failed} 项失败\n`)
process.exit(failed === 0 ? 0 : 1)
