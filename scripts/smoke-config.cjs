/**
 * 冒烟测试：控制台配置表单（Schema）与「表单 → config.json」的落地规则。
 *
 * 覆盖：
 *   1. 每个叶子字段都带默认值（控制台里不再是一片空白）；
 *   2. 枚举字段都渲染成下拉（union of const），选项里包含默认值，且没有假选项；
 *   3. 默认值能通过 Schema 校验，非法值会被拒绝；
 *   4. **与上游默认值相同的项不写回 config.json** —— 用户直接改文件的内容不会被表单默认值盖掉；
 *   5. 真的改过的项会写回；空数组/空对象仍然算「没填」。
 *
 * 用法：node scripts/smoke-config.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { Context } = require('koishi')

const pluginRoot = path.resolve(__dirname, '..')
const dataRoot = path.resolve(pluginRoot, 'data-smoke-config')
const cfgDir = path.join(dataRoot, 'koishi-plugin-kkk', 'config')
const cfgFile = path.join(cfgDir, 'config.json')

const defaults = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'config/default_config/config.json'), 'utf8'))

/** 模拟「用户之前直接在 config.json 里手改过两处」 */
fs.mkdirSync(cfgDir, { recursive: true })
const direct = JSON.parse(JSON.stringify(defaults))
direct.douyin.videoQuality = '1080p'
direct.app.renderScale = 150
fs.writeFileSync(cfgFile, JSON.stringify(direct, null, 2))

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  —— ' + detail : ''))
}

const plugin = require(path.join(pluginRoot, 'lib/index.js'))
const ctx = new Context()
// 控制台保存后 koishi.yml 里就是「默认值 + 用户改动」这个样子，这里直接把它整份塞进 upstream
ctx.plugin(plugin, { dataPath: dataRoot, debug: true, upstream: defaults })

setTimeout(async () => {
  try {
    const { buildUpstreamSchema } = require(path.join(pluginRoot, 'lib/schema.js'))
    const { applyUpstreamOverrides } = require(path.join(pluginRoot, 'lib/configBridge.js'))
    const schema = buildUpstreamSchema(pluginRoot)

    console.log('\n[1] 叶子字段都要有默认值')
    let leaf = 0
    let missing = []
    // Koishi 的 Schema 实例本身是**函数**（schema(value) 就是校验），typeof 判断别写成 !== 'object'
    const isSchema = (node) => !!node && (typeof node === 'object' || typeof node === 'function')
    const walkLeaf = (node, fieldPath) => {
      if (!isSchema(node)) return
      if (node.type === 'object') {
        for (const [key, child] of Object.entries(node.dict || {})) walkLeaf(child, fieldPath + '.' + key)
        return
      }
      leaf += 1
      if (!node.type || node.type === 'any') return
      if (!node.meta || node.meta.default === undefined) missing.push(fieldPath)
    }
    for (const [key, child] of Object.entries(schema.dict)) walkLeaf(child, key)
    check('所有叶子字段都有默认值', missing.length === 0, missing.length ? '缺失：' + missing.slice(0, 8).join(', ') : '共 ' + leaf + ' 个叶子字段')

    console.log('\n[2] 枚举字段渲染成下拉，且选项里含默认值')
    const unions = []
    const walkUnion = (node, fieldPath) => {
      if (!isSchema(node)) return
      if (node.type === 'union') { unions.push({ fieldPath, node }); return }
      if (node.type === 'object') {
        for (const [key, child] of Object.entries(node.dict || {})) walkUnion(child, fieldPath + '.' + key)
        return
      }
      if (node.type === 'array' && node.inner) walkUnion(node.inner, fieldPath + '[]')
    }
    for (const [key, child] of Object.entries(schema.dict)) walkUnion(child, key)
    const noDefaultInOptions = unions.filter((item) => {
      const values = item.node.list.map((option) => option.value)
      const fallback = item.node.meta.default
      if (Array.isArray(fallback)) return fallback.some((value) => !values.includes(value))
      return !values.includes(fallback)
    })
    check('枚举字段数量合理（≥ 25）', unions.length >= 25, unions.length + ' 个下拉字段')
    check('每个下拉都包含自己的默认值', noDefaultInOptions.length === 0, noDefaultInOptions.map((item) => item.fieldPath).join(', '))
    console.log('     权限类字段：' + JSON.stringify(schema.dict.douyin.dict.loginPerm.list.map((option) => option.value)))
    console.log('     B站画质：' + JSON.stringify(schema.dict.bilibili.dict.videoQuality.list.map((option) => option.value)))
    console.log('     抖音发送内容：' + JSON.stringify(schema.dict.douyin.dict.sendContent.inner.list.map((option) => option.value)))
    const perms = schema.dict.app.dict.errorLogSendTo.inner.list.map((option) => option.value)
    check('errorLogSendTo 没有混进 console 这种假选项', !perms.includes('console'), perms.join(','))

    console.log('\n[3] Schema 校验')
    let defaultsOk = true
    try { schema(defaults) } catch (error) { defaultsOk = false; console.log('     ' + error.message) }
    check('默认配置能通过校验', defaultsOk)
    let rejected = false
    try { schema({ douyin: { videoQuality: '999p' } }) } catch { rejected = true }
    check('非法枚举值被拒绝', rejected)

    console.log('\n[4] 与默认值相同的项不写回 config.json')
    const untouched = applyUpstreamOverrides(defaults)
    const afterUntouched = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
    check('写回字段数为 0', untouched.changed.length === 0, untouched.changed.slice(0, 5).join(', '))
    check('手改的 douyin.videoQuality 没被覆盖', afterUntouched.douyin.videoQuality === '1080p', afterUntouched.douyin.videoQuality)
    check('手改的 app.renderScale 没被覆盖', afterUntouched.app.renderScale === 150, String(afterUntouched.app.renderScale))

    console.log('\n[5] 真的改过的项要写回，空容器仍算没填')
    const changedResult = applyUpstreamOverrides({ douyin: { videoQuality: '720p' }, app: { renderScale: 120 }, pushlist: { douyin: [] } })
    const afterChanged = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
    check('改过的两项都写回了', changedResult.changed.includes('douyin.videoQuality') && changedResult.changed.includes('app.renderScale'), changedResult.changed.join(', '))
    check('config.json 里是新值', afterChanged.douyin.videoQuality === '720p' && afterChanged.app.renderScale === 120, afterChanged.douyin.videoQuality + ' / ' + afterChanged.app.renderScale)
    check('空数组不写回（不算改动）', !changedResult.changed.some((item) => item.startsWith('pushlist')), changedResult.changed.join(', '))

    const failed = results.filter((item) => !item.ok)
    console.log('\n=== ' + (results.length - failed.length) + '/' + results.length + ' 通过 ===')
    process.exitCode = failed.length ? 1 : 0
  } catch (error) {
    console.error('冒烟测试失败:', error && error.stack ? error.stack : error)
    process.exitCode = 1
  }
  process.exit(process.exitCode || 0)
}, 4000)
