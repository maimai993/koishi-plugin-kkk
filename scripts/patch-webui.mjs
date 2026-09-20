/**
 * 给原版 WebUI（assets/web 里的 SPA）加一个「QQ 适配器」分类。
 *
 * 原版面板只认 Karin 那份 config.json（接口库 / 通用 / 抖音 / 哔哩哔哩 / 快手 / 小红书 / 推送列表），
 * 而 QQ 专属的那几项（面板、切片、番剧选集表格、卡片 OCR）是 Koishi 侧才有的，
 * 于是这里往打包好的 SPA 里补一个 tab：
 *
 *   1. 分类列表里加 { key: 'qq', label: 'QQ 适配器' }；
 *   2. 配置面板的分发 switch 里加 case 'qq'，渲染下面生成的组件；
 *   3. 组件用 SPA 自带的字段渲染器，路径一律 ['qq', 字段名]，
 *      读写的还是那份整包配置 —— 保存时 POST /kkk/v1/config，
 *      服务端把 qq 拆出来写回 Koishi 的 koishi.yml（见 src/webui.ts）。
 *
 * 字段表来自 src/qqFields.json（和控制台表单同一份），所以两边永远一致。
 * 脚本可反复执行：先删掉上次插入的片段，再按当前字段表重新插入。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const webAssets = path.join(pluginRoot, 'assets', 'web', 'assets')

// 用字符码拼反引号，免得本文件自己被模板串语法绊倒
const BT = String.fromCharCode(96)
const START = '/*KKK-QQ-START*/'
const END = '/*KKK-QQ-END*/'
const COMPONENT = 'KKKQQConfig'

const fields = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'src', 'qqFields.json'), 'utf-8'))

const q = (value) => BT + String(value) + BT
const arr = (items) => '[' + items.map(q).join(',') + ']'

/** 一个字段 → 一行渲染器调用 */
function renderField (field) {
  const target = arr(['qq', field.key])
  const args = [target, q(field.label), q(field.description)]
  if (field.type === 'boolean') return 'i(' + args.join(',') + ')'
  const options = ['type:' + q(field.secret ? 'password' : field.type === 'number' ? 'number' : 'text')]
  if (field.type === 'number') {
    options.push('fallback:' + Number(field.default))
    if (field.min !== undefined) options.push('min:' + field.min)
    if (field.max !== undefined) options.push('max:' + field.max)
  } else if (field.secret) {
    options.push('placeholder:' + q('留空则使用公共测试密钥'))
  }
  return 'a(' + args.concat('{' + options.join(',') + '}').join(',') + ')'
}

const groups = []
for (const field of fields) {
  let group = groups.find((item) => item.name === field.group)
  if (!group) groups.push(group = { name: field.group, fields: [] })
  group.fields.push(field)
}

const sections = groups.map((group) => 'r(' + q(group.name) + ',(0,U.jsx)(U.Fragment,{children:[' + group.fields.map(renderField).join(',') + ']}))').join(',')

const componentCode = COMPONENT
  + '=({config:e,renderers:t})=>{let{renderPageHeader:n,renderSubSection:r,renderSwitch:i,renderTextField:a}=t;return(0,U.jsxs)(U.Fragment,{children:[n('
  + q('QQ 适配器') + ',' + q('这些设置只对 QQ 平台生效，其它平台不受影响。改完点右下角保存即可，不用重启。') + '),' + sections + ']})}'

const CATEGORY = '{key:' + q('qq') + ',label:' + q('QQ 适配器') + ',description:' + q('QQ 平台专属') + '}'
const SWITCH = ';case' + q('qq') + ':return(0,U.jsx)(' + COMPONENT + ',{...e})'
const CATEGORY_ANCHOR = ',{key:' + q('pushlist') + ',label:' + q('推送列表') + ',description:' + q('订阅 JSON') + '}'
const SWITCH_ANCHOR = 'case' + q('pushlist') + ':return(0,U.jsx)(MR,{...e})'
const COMPONENT_ANCHOR = ',PR=e=>{switch(e.activeFile){'

/** 去掉上次插入的组件（按标记切掉） */
function stripComponent (text) {
  let out = text
  for (;;) {
    const start = out.indexOf(START)
    if (start < 0) return out
    const end = out.indexOf(END, start)
    if (end < 0) return out
    // 插入时是 `,<块>,PR=...`，这里的块前面那个逗号也要一起去掉，
    // 否则会留下 `,,` —— 语法直接报 Expected identifier but found ","
    const from = out[start - 1] === ',' ? start - 1 : start
    out = out.slice(0, from) + out.slice(end + END.length)
  }
}

/* ---------------- 布局里的「用户信息」块 ---------------- */

/**
 * 原版面板把用户信息写死在布局里（侧栏那张「炫炫 / Super Admin / 当前身份：管理员」卡片），
 * Koishi 这边面板是免登录的，这块没有意义，整块删掉。
 */
function matchParen (text, start) {
  let depth = 0
  let quote = ''
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '`' || ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '(') depth++
    else if (ch === ')') { depth--; if (depth === 0) return i }
  }
  return -1
}

function stripUserCard (text) {
  // 桌面版在侧栏（`shrink-0 px-4 pt-3 pb-2`），移动版在菜单抽屉里（`shrink-0 pb-5`）
  const nameAt = text.indexOf('炫炫')
  if (nameAt < 0) return text
  const divAt = text.lastIndexOf('(`div`,{className:`shrink-0', nameAt)
  if (divAt < 0) return text
  const start = text.lastIndexOf('(0,', divAt)
  if (start < 0) return text
  // 调用长这样：`(0,T.jsx)('div', {...})` —— 前半截 `(0,T.jsx)` 自己就闭合了，
  // 括号配对必须从**参数**那个括号开始，否则会立刻返回、切错位置
  const argOpen = text.indexOf(')(', start)
  if (argOpen < 0) return text
  let end = matchParen(text, argOpen + 1)
  if (end < 0) return text
  // 它通常是数组里的第一项，顺手把后面的逗号一起吃掉，免得留下一个空位
  if (text[end + 1] === ',') end += 1
  return text.slice(0, start) + text.slice(end + 1)
}

/* ---------------- 全局文案替换 ---------------- */

const TEXT_REPLACERS = [
  [/https:\/\/kkk\.karinjs\.com/g, 'https://kkk.tangbot.xyz'],
  [/Karin 插件配置管理面板/g, 'koishi-plugin-kkk 配置面板'],
  [/\bKarin\b/g, 'Koishi'],
]

function applyTextReplacements (text, name) {
  let out = text
  for (const [pattern, to] of TEXT_REPLACERS) out = out.replace(pattern, to)
  if (out !== text) console.log('[kkk] 文案替换: ' + name)
  return out
}

// 主包和布局在 assets/ 下，index.html 在上一级
const files = [
  ...fs.readdirSync(webAssets).filter((name) => /\.js$/.test(name)).map((name) => path.join(webAssets, name)),
  path.join(path.dirname(webAssets), 'index.html'),
].filter((file) => fs.existsSync(file))
if (!files.length) throw new Error('找不到 assets/web/assets/index-*.js（WebUI 前端包）')

for (const file of files) {
  const name = path.basename(file)
  let text = fs.readFileSync(file, 'utf-8')
  const before = text.length

  // 「QQ 适配器」分类只注入主包，其余文件（布局 / 主题 / index.html）只做删块与文案替换
  const isBundle = text.includes(SWITCH_ANCHOR) || /^index-.*[.]js$/.test(name)

  if (isBundle) {
    // 可重复执行：先清掉上次插入的片段
    text = stripComponent(text)
    text = text.split(',' + CATEGORY).join('')
    text = text.split(SWITCH).join('')

    // 1. 分类列表
    if (text.includes(CATEGORY_ANCHOR)) text = text.replace(CATEGORY_ANCHOR, ',' + CATEGORY + CATEGORY_ANCHOR)
    else console.warn('[kkk] ' + name + '：没找到分类列表，跳过（前端包可能换版本了）')

    // 2. 分发 switch
    if (text.includes(SWITCH_ANCHOR)) text = text.replace(SWITCH_ANCHOR, SWITCH_ANCHOR + SWITCH)

    // 3. 组件定义（塞在 PR 前面，同一个模块作用域，能用 U / Q 这些打包期变量）
    if (text.includes(COMPONENT_ANCHOR)) text = text.replace(COMPONENT_ANCHOR, ',' + START + componentCode + END + COMPONENT_ANCHOR)
  }

  if (/DesktopLayout|MobileLayout/.test(name)) {
    const stripped = stripUserCard(text)
    if (stripped !== text) { console.log('[kkk] 已删除用户信息块: ' + name); text = stripped }
  }
  text = applyTextReplacements(text, name)

  fs.writeFileSync(file, text)
  if (text.length !== before || before !== fs.statSync(file).size || !isBundle) console.log('[kkk] 已处理: ' + name + '（' + before + ' → ' + text.length + ' 字节）')
}

console.log('[kkk] 完成，共处理 ' + files.length + ' 个文件')
