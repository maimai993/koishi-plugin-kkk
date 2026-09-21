/**
 * 冒烟测试：B站 av 号链接的识别。
 *
 * 背景（用户实测）：`https://www.bilibili.com/video/av117223783925866` 解析失败。
 * 根因是 av→BV 转换的返回结构多包了一层（amagi 的信封里还有一层 API 信封），
 * 旧代码只取 `data.bvid` 拿到 undefined，于是 av 链接被当成「没有 bvid 的视频」，
 * 解析静默失败。这个用例把它钉住：**av / BV / 裸 av 号都必须解析出 bvid**。
 *
 * 用法：node scripts/smoke-bili-avid.cjs（需要外网）
 */
const path = require('node:path')
const pluginRoot = path.resolve(__dirname, '..')

let failures = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? ' | ' + extra : ''))
  if (!ok) failures++
}

;(async () => {
  const { getBilibiliID } = require(path.join(pluginRoot, 'lib/karin/platform/bilibili/index.js'))
  const cases = [
    ['https://www.bilibili.com/video/av117223783925866', 'BV1Wrbs6pESB'],
    ['https://www.bilibili.com/video/av170001', 'BV17x411w7KC'],
    ['https://www.bilibili.com/video/BV1tjb56fEJs', 'BV1tjb56fEJs']
  ]
  for (const [url, expected] of cases) {
    let id = null
    try {
      id = await getBilibiliID(url)
    } catch (error) {
      check(url, false, '抛错: ' + (error && error.message))
      continue
    }
    check('解析出 bvid', id && id.type === 'one_video' && id.bvid === expected,
      JSON.stringify(id) + '（期望 ' + expected + '）')
  }
  console.log('')
  console.log(failures ? '失败 ' + failures + ' 项' : '全部通过')
  process.exit(failures ? 1 : 0)
})()
