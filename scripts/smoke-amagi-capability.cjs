/**
 * 冒烟测试：**解析库（@ikenxuan/amagi）得是带 secsdk 的那一版**。
 *
 * 线上事故：抖音从某天起要求 web 接口带 `uifid` + `x-secsdk-web-signature`（Argus 风控），
 * npm 上的 latest 6.6.0 没有这套实现 → 每个抖音接口都被拦成
 * `403 Blocked by ArgusSecurityPlugin Uifid Not Found` → 插件报「Cookie 失效」。
 * 换 cookie、换网络都没用，**只能升解析库**（上游 karin-plugin-kkk 也是把新 amagi 打进包里）。
 *
 * 这个冒烟不联网，只检查「装到的那份库**有**做签名和 uifid 的能力」：
 * 一旦有人把依赖降回 6.x，这里立刻红，不会等到用户来报「抖音解析不了」。
 *
 * 用法：node scripts/smoke-amagi-capability.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const pluginRoot = path.resolve(__dirname, '..')

let failures = 0
const check = (name, ok, detail) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  —— ' + detail : ''))
  if (!ok) failures++
}

/** 装上那份库的根目录：require.resolve 拿到入口文件，再往上找 package.json */
const resolveInstalled = () => {
  const entry = require.resolve('@ikenxuan/amagi', { paths: [pluginRoot] })
  let dir = path.dirname(entry)
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'package.json')
    if (fs.existsSync(candidate)) {
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'))
      if (pkg.name === '@ikenxuan/amagi') return { dir, pkg }
    }
    dir = path.dirname(dir)
  }
  return null
}

const versionOf = (text) => String(text ?? '').split('-')[0].split('.').map((n) => Number(n) || 0)

const main = () => {
  console.log('— 解析库能力 —')
  const installed = resolveInstalled()
  check('能找到已安装的 @ikenxuan/amagi', !!installed, installed ? installed.dir : '（找不到）')
  if (!installed) return done()

  const [major] = versionOf(installed.pkg.version)
  check('装的是 7.x（6.x 没有 secsdk，抖音会被 Argus 拦）', major >= 7, '实际 ' + installed.pkg.version)

  /** secsdk 签名只在 7.x 里导出，是最直接的能力探针 */
  let signing = null
  try {
    signing = require('@ikenxuan/amagi/signing')
  } catch (error) {
    signing = null
    check('导出 ./signing（secsdk 签名，7.x 才有）', false, String(error && error.message).slice(0, 120))
  }
  if (signing) {
    const names = Object.keys(signing)
    check('导出 ./signing（secsdk 签名，7.x 才有）', names.length > 0, names.slice(0, 6).join(', ') + '…')
    check('签名模块里能找到 secsdk / uifid 相关导出',
      names.some((name) => /secsdk|uifid|sign/i.test(name)),
      names.filter((name) => /secsdk|uifid|sign/i.test(name)).slice(0, 6).join(', '))
  }

  const amagi = require('@ikenxuan/amagi')
  const Client = amagi.Client || amagi.default
  check('Client 能拿到（v7 的默认导出）', typeof Client === 'function', typeof Client)
  if (typeof Client === 'function') {
    const client = Client({ cookies: {}, request: {}, debug: false })
    check('client.douyin.fetcher.parseWork 在（插件主链路）', typeof client?.douyin?.fetcher?.parseWork === 'function')
    check('client.douyin.login 在（扫码登录走它）', typeof client?.douyin?.login?.qrcode === 'function')
  }

  console.log('')
  console.log('— 仓库里的声明 —')
  const pkg = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'))
  const pinned = pkg.dependencies?.['@ikenxuan/amagi']
  const [pinnedMajor] = versionOf(pinned)
  check('package.json 钉的版本也是 7.x', pinnedMajor >= 7, '实际 ' + String(pinned))

  done()
}

const done = () => {
  console.log('')
  console.log(failures === 0 ? '全部通过' : failures + ' 项失败')
  process.exit(failures === 0 ? 0 : 1)
}

try {
  main()
} catch (error) {
  console.error(error)
  process.exit(1)
}
