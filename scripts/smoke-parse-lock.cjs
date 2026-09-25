/**
 * 冒烟测试：「短时间不重复解析」开关（通用 →「短时间不重复解析」，默认开）。
 *
 * 覆盖：
 *   1. 字段本身：在 qqFields 里、默认开、归到「通用」分类（WebUI 与控制台共用同一份字段表）；
 *   2. 开关开着（默认 / 老配置没这个键）：同一个键在窗口内只放行一次，不同键各放行一次；
 *   3. 开关关掉：同一个键连续调用也全部放行（方便反复调试同一条链接）；
 *   4. 四个平台都接了这把锁（抖音 / B站 / 快手 / 小红书），并且每条都是先判断再干活。
 *
 * 用法：node scripts/smoke-parse-lock.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const pluginRoot = path.resolve(__dirname, '..')
const runtimeMod = require(path.join(pluginRoot, 'lib/compat/runtime.js'))
const { acquireParseLock, isParseDedupeEnabled, parseDedupeWindowMs } = require(path.join(pluginRoot, 'lib/karin/module/utils/ParseLock.js'))

let failures = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? ' | ' + extra : ''))
  if (!ok) failures++
}

/** 绑定一个只带 config 的假运行时（ParseLock 只读 config.parseDedupe） */
const bindConfig = (config) => runtimeMod.bindRuntime({
  ctx: { logger: () => ({ debug () {}, info () {}, warn () {}, error () {} }), config: {} },
  config,
  pluginRoot,
  dataRoot: path.join(pluginRoot, 'data-smoke-lock')
})

console.log('\n[1] 字段本身')
{
  const { QQ_FIELDS, QQ_DEFAULTS } = require(path.join(pluginRoot, 'lib/qqOptions.js'))
  const field = QQ_FIELDS.find((item) => item.key === 'parseDedupe')
  check('字段 parseDedupe 存在', !!field, field ? field.label : '（没有）')
  check('默认开启（缺省即开，老配置行为不变）', QQ_DEFAULTS.parseDedupe === true, 'default=' + QQ_DEFAULTS.parseDedupe)
  check('渲染在「通用」分类里（renderIn=app）', field?.renderIn === 'app' && field?.group === '通用',
    JSON.stringify({ group: field?.group, renderIn: field?.renderIn, section: field?.section }))
  check('是开关类型且说明写清了「关掉后每条消息都会解析」',
    field?.type === 'boolean' && /关掉后每条消息都会解析/.test(field?.description ?? ''),
    (field?.description ?? '').slice(0, 60))

  /** 时间可自定义：单位分钟，默认 1，范围 1~60（用户要求「开启之后可以自定义时间单位分钟」） */
  const minutes = QQ_FIELDS.find((item) => item.key === 'parseDedupeMinutes')
  check('有「重复解析间隔（分钟）」这一项', !!minutes, minutes ? minutes.label : '（没有）')
  check('默认 1 分钟、范围 1~60、同样在「通用」分类里',
    minutes?.type === 'number' && minutes?.default === 1 && minutes?.min === 1 && minutes?.max === 60 &&
    minutes?.renderIn === 'app' && minutes?.group === '通用',
    JSON.stringify({ type: minutes?.type, default: minutes?.default, min: minutes?.min, max: minutes?.max }))
  check('说明里写明只在开关打开时生效', /打开时才生效/.test(minutes?.description ?? ''),
    (minutes?.description ?? '').slice(0, 50))
}

console.log('\n[1b] 去重窗口（分钟）')
{
  bindConfig({})
  check('默认窗口 = 1 分钟', parseDedupeWindowMs() === 60 * 1000, parseDedupeWindowMs() + 'ms')
  bindConfig({ parseDedupeMinutes: 5 })
  check('填 5 → 5 分钟', parseDedupeWindowMs() === 5 * 60 * 1000, parseDedupeWindowMs() + 'ms')
  bindConfig({ parseDedupeMinutes: 60 })
  check('填 60 → 60 分钟（上限）', parseDedupeWindowMs() === 60 * 60 * 1000, parseDedupeWindowMs() + 'ms')
  /** 超范围夹到最近的边界；填歪了（非数字 / 空）才回落到默认值 */
  bindConfig({ parseDedupeMinutes: 90 })
  check('填 90 → 夹到上限 60 分钟', parseDedupeWindowMs() === 60 * 60 * 1000, parseDedupeWindowMs() + 'ms')
  for (const bad of [0, -3]) {
    bindConfig({ parseDedupeMinutes: bad })
    check('填「' + String(bad) + '」→ 夹到下限 1 分钟', parseDedupeWindowMs() === 60 * 1000, parseDedupeWindowMs() + 'ms')
  }
  for (const bad of ['abc', null, undefined, '']) {
    bindConfig({ parseDedupeMinutes: bad })
    check('填「' + String(bad) + '」→ 回落到默认 1 分钟', parseDedupeWindowMs() === 60 * 1000, parseDedupeWindowMs() + 'ms')
  }
}

console.log('\n[2] 开关开着（默认）：窗口内只放行一次')
{
  bindConfig({})
  check('读不到这个键时按「开」处理（老配置）', isParseDedupeEnabled() === true)
  const first = acquireParseLock('bilibili:456:12345:BV1xx411c7mD:80')
  const second = acquireParseLock('bilibili:456:12345:BV1xx411c7mD:80')
  check('同一个键：第一次放行、第二次拦住', first === true && second === false,
    '第一次=' + first + ' 第二次=' + second)
  const otherQuality = acquireParseLock('bilibili:456:12345:BV1xx411c7mD:116')
  const otherWork = acquireParseLock('bilibili:456:12345:BV1yy411c7mE:80')
  const otherGroup = acquireParseLock('bilibili:789:12345:BV1xx411c7mD:80')
  check('换画质 / 换作品 / 换群都不会被误伤',
    otherQuality === true && otherWork === true && otherGroup === true,
    [otherQuality, otherWork, otherGroup].join(' / '))
  check('显式写着 true 时同样生效', (() => { bindConfig({ parseDedupe: true }); return acquireParseLock('k') === true && acquireParseLock('k') === false })())
}

console.log('\n[3] 开关关掉：每次都放行')
{
  bindConfig({ parseDedupe: false })
  check('isParseDedupeEnabled() 变成 false', isParseDedupeEnabled() === false)
  const results = [acquireParseLock('bilibili:456:12345:BV1xx411c7mD:80'), acquireParseLock('bilibili:456:12345:BV1xx411c7mD:80'), acquireParseLock('bilibili:456:12345:BV1xx411c7mD:80')]
  check('同一个键连续三次全部放行', results.every((item) => item === true), results.join(' / '))
}

console.log('\n[4] 四个平台都接了这把锁')
{
  bindConfig({})
  const source = fs.readFileSync(path.join(pluginRoot, 'src/karin/apps/tools.ts'), 'utf-8')
  // import 那一行长这样：import { acquireParseLock } from …（名字后面没有括号），所以只数调用
  const usages = source.split('acquireParseLock(').length - 1
  /**
   * 5 处 = 4 个平台（抖音 / B站 / 快手 / 小红书）+ 1 处**消息级**去重。
   *
   * 那处是后来补的（见 tools.ts 顶部 acquireMessageLock 的说明）：QQ 会把同一次发送投递多遍，
   * 平台级去重只挡得住解析本身、挡不住「检测到 X 链接」那句提示，所以最前面还要再拦一道。
   * 断言写死 4 会把它当成「多出来的调用」误报 —— 这里改成「平台 4 处 + 消息级 1 处」。
   */
  check('tools.ts 里每个平台都接了这把锁（4 处）+ 1 处消息级去重', usages === 5, '调用 ' + usages + ' 次')
  check('那处多出来的是消息级去重（acquireMessageLock）', /const acquireMessageLock[\s\S]{0,400}?acquireParseLock\(/.test(source))
  check('并且是从 ParseLock 里 import 进来的', /import \{ acquireParseLock \} from '@\/module\/utils\/ParseLock'/.test(source))
  for (const [name, pattern] of [['抖音', /douyinKey/], ['B站', /biliKey/], ['快手', /kuaishouKey/], ['小红书', /xiaohongshuKey/]]) {
    check(name + ' 有去重键', pattern.test(source))
  }
}

console.log('\n=== ' + (failures ? '失败 ' + failures + ' 项' : '全部通过') + ' ===')
process.exit(failures ? 1 : 0)
