/**
 * 卡片解析（OCR 找 UP 主）冒烟测试。
 *
 * 覆盖线上踩过的那个坑：B站卡片的 OCR 文本里「UP主」**上一行不是昵称**，
 * 真名在第一行 —— 老规则只看「UP主前一行」，于是拿封面上的「半身像」去搜，
 * 标题又对不上，六个候选一个都不敢选（用户看到的「没能唯一定位…候选 6 条」）。
 *
 * 这里只测纯函数（不联网）：候选名的顺序、噪声过滤、去重。
 * 用法：node scripts/smoke-cardparse.cjs
 */
const path = require('node:path')

const pluginRoot = path.resolve(__dirname, '..')
const libRoot = path.join(pluginRoot, 'lib')

/** 兼容层要先绑定运行时，CardParser 读配置/日志都走它 */
const runtime = require(path.join(libRoot, 'compat', 'runtime.js'))
const noop = () => {}
runtime.bindRuntime({
  ctx: { get: () => undefined, logger: () => ({ info: noop, warn: noop, error: noop, debug: noop, mark: noop }), bots: [], registry: new Map() },
  config: { app: {} },
  dataRoot: path.join(pluginRoot, 'data-smoke-cardparse'),
  master: () => []
})

const { extractUpNames, extractUpName } = require(path.join(libRoot, 'karin/module/utils/CardParser.js'))

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  —— ' + detail : ''))
}

console.log('\n[1] 线上那条真实 OCR（真名在第一行、「UP主」前一行是封面文字）')
const live = '雾小霜暗区突围\n1,052\n半身像\nUP主\n4993粉丝\n1,087\n*未知"\n5.3万播放1806点赞\n11弹幕'
const liveNames = extractUpNames(live)
check('首选就是真昵称「雾小霜暗区突围」', liveNames[0] === '雾小霜暗区突围', liveNames.join(' / '))
check('封面文字「半身像」不会混进来', !liveNames.includes('半身像'), liveNames.join(' / '))
check('统计行（4993粉丝 / 5.3万播放…）不当昵称', !liveNames.some((item) => /粉丝|播放|点赞|弹幕|^[\d,.]+$/.test(item)), liveNames.join(' / '))
check('旧入口 extractUpName 与首选一致', extractUpName(live) === '雾小霜暗区突围', extractUpName(live))

console.log('\n[2] OCR 把整段压成一行（空格分隔）也要认出来')
const flat = '雾小霜暗区突围 1,052 半身像 UP主 4993粉丝 1,087 *未知" 5.3万播放1806点赞 11弹幕'
check('单行也能拿到真昵称', extractUpNames(flat)[0] === '雾小霜暗区突围', JSON.stringify(extractUpNames(flat)))

console.log('\n[3] 标准 B站排版（昵称在「UP主」上一行）保持原样')
const classic = '影视飓风\nUP主\n123.4万粉丝\n1.2亿播放'
check('昵称「影视飓风」', extractUpNames(classic)[0] === '影视飓风', JSON.stringify(extractUpNames(classic)))

console.log('\n[4] 边界：空文本 / 只有统计 / 重复行')
check('空文本返回空数组', extractUpNames('').length === 0)
check('只有统计行时没有候选', extractUpNames('1.2万粉丝\n3,456\n7.8万播放').length === 0, JSON.stringify(extractUpNames('1.2万粉丝\n3,456\n7.8万播放')))
check('大小写不同的 UP主 都能识别', extractUpNames('某某某\nup主\n100粉丝')[0] === '某某某', JSON.stringify(extractUpNames('某某某\nup主\n100粉丝')))
check('候选不重复', (() => { const list = extractUpNames('小明明\nUP主\n小明明\n99粉丝'); return list.length === new Set(list).size })(), JSON.stringify(extractUpNames('小明明\nUP主\n小明明\n99粉丝')))

const failed = results.filter((item) => !item.ok)
console.log('\n=== ' + (results.length - failed.length) + '/' + results.length + ' 通过 ===')
process.exitCode = failed.length ? 1 : 0
