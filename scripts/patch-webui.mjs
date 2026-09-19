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
    out = out.slice(0, start) + out.slice(end + END.length)
  }
}

const files = fs.readdirSync(webAssets).filter((name) => /^index-.*[.]js$/.test(name))
if (!files.length) throw new Error('找不到 assets/web/assets/index-*.js（WebUI 前端包）')

for (const name of files) {
  const file = path.join(webAssets, name)
  let text = fs.readFileSync(file, 'utf-8')
  const before = text.length

  // 可重复执行：先清掉上次插入的片段
  text = stripComponent(text)
  text = text.split(',' + CATEGORY).join('')
  text = text.split(SWITCH).join('')

  // 1. 分类列表
  if (!text.includes(CATEGORY_ANCHOR)) throw new Error(name + '：找不到分类列表（前端包可能换版本了，需要重新适配）')
  text = text.replace(CATEGORY_ANCHOR, ',' + CATEGORY + CATEGORY_ANCHOR)

  // 2. 分发 switch
  if (!text.includes(SWITCH_ANCHOR)) throw new Error(name + '：找不到配置面板的 switch')
  text = text.replace(SWITCH_ANCHOR, SWITCH_ANCHOR + SWITCH)

  // 3. 组件定义（塞在 PR 前面，同一个模块作用域，能用 U / Q 这些打包期变量）
  if (!text.includes(COMPONENT_ANCHOR)) throw new Error(name + '：找不到配置面板组件')
  text = text.replace(COMPONENT_ANCHOR, ',' + START + componentCode + END + COMPONENT_ANCHOR)

  fs.writeFileSync(file, text)
  console.log('[kkk] 已注入 QQ 适配器分类: ' + name + '（' + before + ' → ' + text.length + ' 字节）')
}

console.log('[kkk] 完成，共处理 ' + files.length + ' 个文件')
