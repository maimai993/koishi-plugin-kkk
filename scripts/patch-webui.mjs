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

/** 指定渲染到「通用」分类的字段（配置本身还在 qq.* 里，只是界面挪个位置） */
const APP_FIELDS = fields.filter((field) => field.renderIn === 'app')
const QQ_FIELDS_ONLY = fields.filter((field) => field.renderIn !== 'app')

/**
 * 「通用」分类里追加的字段（用该分类自己的渲染器：s = 开关，c = 文本框）。
 *
 * 带 section 的字段（在线播放器那几项）额外包一层小标题，
 * 不带 section 的直接跟在「交互设置」里 —— 和原来一样。
 */
/**
 * 「弹幕功能开着吗」的表达式。
 *
 * 通用里的「强制不烧录弹幕」关掉 = 弹幕烧录打开；带 `editableWhen: 'danmaku'` 的字段
 * （在线播放器那一组）只有在这时才能编辑（面板里灰掉，不给改）。
 */
const DANMAKU_OPEN = 'Q(e,' + arr(['qq', 'forceNoDanmaku']) + ',!0)===!1'

/** 字段被锁住时在标题上补一句说明，免得用户以为是界面坏了 */
const SECTION_LOCK_HINT = '（需先关闭「强制不烧录弹幕」）'

const appFieldCall = (field) => {
  const path = '[' + [q('qq'), q(field.key)].join(',') + ']'
  const disabled = field.editableWhen === 'danmaku' ? DANMAKU_OPEN : ''
  // renderSwitch 的第 4 个参数、renderTextField 的 options.disabled 都是「不可编辑」
  if (field.type === 'boolean') {
    return 's(' + path + ',' + q(field.label) + ',' + q(field.description) + (disabled ? ',' + disabled : '') + ')'
  }
  const opts = ["type:" + q(field.type === 'number' ? 'number' : 'text')]
  if (field.type === 'number') {
    opts.push('fallback:' + Number(field.default))
    if (field.min !== undefined) opts.push('min:' + field.min)
    if (field.max !== undefined) opts.push('max:' + field.max)
  }
  if (disabled) opts.push('disabled:' + disabled)
  return 'c(' + path + ',' + q(field.label) + ',' + q(field.description) + ',{' + opts.join(',') + '})'
}
const sectionFields = (section) => APP_FIELDS.filter((field) => field.section === section)
const APP_FIELDS_CODE = [
  ...APP_FIELDS.filter((field) => !field.section).map(appFieldCall),
  ...[...new Set(APP_FIELDS.filter((field) => field.section).map((field) => field.section))].map((section) =>
    'o(' + q(section + (sectionFields(section).some((field) => field.editableWhen === 'danmaku') ? SECTION_LOCK_HINT : ''))
    + ',(0,U.jsx)(U.Fragment,{children:['
    + sectionFields(section).map(appFieldCall).join(',')
    + ']}))'),
].join(',')

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
for (const field of QQ_FIELDS_ONLY) {
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

/* ---------------- 推送目标弹窗：推送群改手填 ---------------- */

/**
 * 原版的「推送群」是从 /kkk/v1/bots/:id/groups 拉的下拉框，
 * 但那个接口拿不到群列表时是空的，用户根本选不了（只显示「请先选择机器人账号。」）。
 * 这里把这一项换成纯文本输入，直接填群号；提交时也允许没有 group 对象。
 */
const PUSH_GROUP_SELECT = '(0,U.jsx)(hR,{description:l?`当前 Bot 已加入的群。`:`请先选择机器人账号。`,disabled:!l||h,items:C,label:`推送群`,placeholder:`选择推送群`,selectedId:d,onSelect:f})'
const PUSH_GROUP_INPUT = [
  '(0,U.jsxs)(`div`,{className:`flex flex-col gap-1`,children:[',
  '(0,U.jsx)(dx,{className:`font-semibold`,children:`推送群`}),',
  '(0,U.jsx)(`input`,{className:`w-full rounded-large border border-default-200 bg-default-100 px-3 py-2 text-sm outline-none`,placeholder:`填写群号，例如 1050229473`,value:d||``,onChange:e=>f(e.target.value)}),',
  '(0,U.jsx)(px,{className:`text-xs`,children:`直接填群号（频道 id）即可；要指定平台时写成 平台:群号。`})',
  ']})',
].join('')

const PUSH_SUBMIT_FROM = 'let T=()=>{if(!w||!b||!x)return;let e={groupId:x.id,botId:b.id};x.name&&(e.groupName=x.name),x.avatar&&(e.groupAvatar=x.avatar),'
const PUSH_SUBMIT_TO = 'let T=()=>{if(!w||!b)return;let e={groupId:(x&&x.id)||String(d||``).trim(),botId:b.id};x&&x.name&&(e.groupName=x.name),x&&x.avatar&&(e.groupAvatar=x.avatar),'

function patchPushDialog (text, name) {
  let out = text
  if (out.includes(PUSH_GROUP_SELECT)) {
    out = out.replace(PUSH_GROUP_SELECT, PUSH_GROUP_INPUT)
    console.log('[kkk] 「推送群」改为手填群号: ' + name)
  }
  if (out.includes(PUSH_SUBMIT_FROM)) out = out.replace(PUSH_SUBMIT_FROM, PUSH_SUBMIT_TO)
  out = out.replace('先选择 Bot，再选择该 Bot 加入的群。', '先选择机器人账号，再填写要推送的群号。')
  return out
}

/* ---------------- 权限 / 错误日志：下拉、多选改成手填 ---------------- */

/**
 * 原版这两项是「下拉框」和「互斥勾选组」，用起来很别扭：
 *   - 谁可以触发扫码登录：只能从 5 个关键字里选一个；
 *   - 错误日志接收人：「第一个主人 / 所有主人」互斥，还不能填具体账号。
 * 现在都换成文本框：可以填 * （谁都可以）、关键字，也可以直接写 QQ 号，多个用逗号分隔。
 * 服务端保存时会把「错误日志」这一项的字符串拆成数组。
 */
const PERM_DESC = '选「指定账号」后填 QQ 号，多个用逗号分隔。'
const LOG_DESC = '谁来接收错误日志，选「指定账号」后填 QQ 号，多个用逗号分隔。'

const TEXT_SWAPS = [
  [
    'o([`bilibili`,`loginPerm`],`谁可以触发扫码登录`,`修改后需重启。`,IL)',
    'l([`bilibili`,`loginPerm`],`谁可以触发扫码登录`,' + '{DESC1}' + ')',
  ],
  [
    'o([`douyin`,`loginPerm`],`谁可以触发扫码登录`,`修改后需重启。`,IL)',
    'l([`douyin`,`loginPerm`],`谁可以触发扫码登录`,' + '{DESC1}' + ')',
  ],
  [
    'n([`app`,`errorLogSendTo`],`错误日志`,`遇到错误时谁会收到错误日志。注：推送任务只可发送给主人。「第一个主人」与「所有主人」互斥。`,[{label:`第一个主人`,value:`master`},{label:`所有主人`,value:`allMasters`},{label:`触发者的群聊`,value:`trigger`}],!1,[[`master`,`allMasters`]])',
    'c([`app`,`errorLogSendTo`],`错误日志`,' + '{DESC2}' + ')',
  ],
]

/**
 * 描述按「标签」改写：不管之前是下拉框还是文本框版本，都能把说明换成最新文案，
 * 避免只改了第一次打补丁时的那段原文、后面就再也替换不到。
 */
const DESC_BY_LABEL = [
  ['谁可以触发扫码登录', PERM_DESC],
  ['错误日志', LOG_DESC],
]

function patchDescriptions (text, name) {
  let out = text
  for (const [label, desc] of DESC_BY_LABEL) {
    const pattern = new RegExp('`' + label + '`,`[^`]*`', 'g')
    out = out.replace(pattern, '`' + label + '`,`' + desc + '`')
  }
  if (out !== text) console.log('[kkk] 描述已更新: ' + name)
  return out
}

function patchTextFields (text, name) {
  let out = text
  for (const [from, to] of TEXT_SWAPS) {
    const target = to.split('{DESC1}').join('`' + PERM_DESC + '`').split('{DESC2}').join('`' + LOG_DESC + '`')
    if (out.includes(from)) {
      out = out.split(from).join(target)
      console.log('[kkk] 改成手填: ' + name + ' :: ' + from.slice(0, 34) + '…')
    }
  }
  return out
}

/* ---------------- 权限 / 错误日志：下拉选模式，选「指定账号」才出输入框 ---------------- */

/**
 * 给渲染器工厂加一个 renderPermField：
 *   一个下拉（所有人 / 管理员（权限等级 4 及以上）/ 指定账号；错误日志那项是 触发者所在的群 / 管理员 / 指定账号），
 *   只有选中「指定账号」时才出现输入框，填 QQ 号、多个用逗号分隔。
 * 之所以要塞进工厂：只有工厂里拿得到 config（e）和写值函数（i）。
 */
const RENDER_PERM_FIELD = [
  'renderPermField:(t,r,s,c)=>{c=c||{};',
  'const p=t,list=!!c.list,modes=c.modes||[],raw=Q(e,p,list?[]:`all`),',
  'arr0=list?(Array.isArray(raw)?raw.map(String):(raw?[String(raw)]:[])):[],',
  'ids=list?arr0.filter(x=>/^\\d+$/.test(x)):[],',
  'numText=list?ids.join(`, `):([`all`,`admin`].includes(String(raw))?``:String(raw||``)),',
  'kw=list?(arr0.find(x=>!/^\\d+$/.test(x))||``):([`all`,`admin`].includes(String(raw))?String(raw):``),',
  'guess=(kw===`trigger`)?`trigger`:(kw||(String(numText).trim()?`id`:(list?`trigger`:`all`))),',
  'pair=(0,v.useState)(null),mode=pair[0]||guess,setMode=pair[1],',
  'apply=n=>{setMode(n);if(n===`id`){i(p,list?ids:String(numText))}else{i(p,list?[n]:n)}},',
  'setIds=n=>{i(p,list?String(n).split(/[,，\\s]+/).map(x=>x.trim()).filter(Boolean):n)},',
  'sel=(0,U.jsxs)(Ax,{fullWidth:!0,name:p.join(`.`),placeholder:r,value:mode,variant:`secondary`,onChange:e=>{e===null||Array.isArray(e)||apply(String(e))},children:[',
  '(0,U.jsx)(dx,{className:`font-semibold`,children:r}),',
  '(0,U.jsxs)(Ax.Trigger,{children:[(0,U.jsx)(Ax.Value,{}),(0,U.jsx)(Ax.Indicator,{})]}),',
  'a(s),',
  '(0,U.jsx)(Ax.Popover,{children:(0,U.jsx)(wx,{children:modes.map(m=>(0,U.jsx)(wx.Item,{id:m.value,textValue:m.label,children:m.label},m.value))})})]}),',
  'inp=mode===`id`?(0,U.jsxs)(lx,{fullWidth:!0,name:p.join(`.`),value:numText,onChange:e=>setIds(e),children:[',
  '(0,U.jsx)(dx,{className:`font-semibold`,children:list?`接收账号`:`允许的账号`}),',
  '(0,U.jsx)(cx,{variant:`secondary`,placeholder:`填写 QQ 号，多个用逗号分隔`})]}):null,',
  'box=(0,U.jsxs)(`div`,{className:n.field,children:[sel,inp]});return o(box,t,!1)},',
].join('')

const PERM_START = '/*KKK-PERM-START*/'
const PERM_END = '/*KKK-PERM-END*/'

const PERM_MODES = '[{value:`all`,label:`所有人`},{value:`admin`,label:`管理员（权限等级 4 及以上）`},{value:`id`,label:`指定账号`}]'
const LOG_MODES = '[{value:`trigger`,label:`触发者所在的群`},{value:`admin`,label:`管理员（权限等级 4 及以上）`},{value:`id`,label:`指定账号`}]'

/** 用「前缀定位 + 括号配对」替换调用（压缩代码里正则很容易写不中） */
function replaceCall (text, prefix, build) {
  let out = text
  let from = 0
  for (;;) {
    const at = out.indexOf(prefix, from)
    if (at < 0) return out
    const open = out.indexOf('(', at)
    const close = matchParen(out, open)
    if (open < 0 || close < 0) return out
    const replacement = build()
    out = out.slice(0, at) + replacement + out.slice(close + 1)
    // 游标往后挪：替换后的文本可能同样以该前缀开头，从头找会死循环
    from = at + replacement.length
  }
}

/** 从 start 处的 '{' 开始做花括号配对（跳过字符串字面量），返回对应的 '}' 下标 */
function matchBrace (text, start) {
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
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return i }
  }
  return -1
}

/** 删掉旧版注入（没有标记的那种：renderPermField:...） */
function stripBarePermField (text) {
  let out = text
  for (;;) {
    const at = out.indexOf('renderPermField:(')
    if (at < 0) return out
    const braceAt = out.indexOf('{', at)
    if (braceAt < 0) return out
    const end = matchBrace(out, braceAt)
    if (end < 0) return out
    let to = end + 1
    if (out[to] === ',') to += 1
    out = out.slice(0, at) + out.slice(to)
  }
}

/** 删掉上次注入的片段（按标记），这样改了实现也能覆盖进去 */
function stripMarked (text, from, to) {
  let out = text
  for (;;) {
    const a = out.indexOf(from)
    if (a < 0) return out
    const b = out.indexOf(to, a)
    if (b < 0) return out
    out = out.slice(0, a) + out.slice(b + to.length)
  }
}

/**
 * 同 {@link stripMarked}，但**把插入时多带的那个逗号一起吃回去**。
 *
 * 注入的写法是 `call,<START>…<END>`：只按标记切的话，逗号会留在原处，
 * 而重新注入又会再加一个 —— 每跑一次补丁包就多一个逗号（实测跑几次就变成 `,,,,,,,`）。
 */
function stripMarkedWithComma (text, from, to) {
  let out = text
  for (;;) {
    const a = out.indexOf(from)
    if (a < 0) return out
    const b = out.indexOf(to, a)
    if (b < 0) return out
    const start = out[a - 1] === ',' ? a - 1 : a
    out = out.slice(0, start) + out.slice(b + to.length)
  }
}

function patchPermFields (text, name) {
  const perm = (platform) => 't.renderPermField([' + BT + platform + BT + ',' + BT + 'loginPerm' + BT + '],' + BT + '谁可以触发扫码登录' + BT + ',' + BT + PERM_DESC + BT + ',{modes:' + PERM_MODES + '})'
  const APP_START = '/*KKK-APP-START*/'
  const APP_END = '/*KKK-APP-END*/'
  const logCall = 't.renderPermField([' + BT + 'app' + BT + ',' + BT + 'errorLogSendTo' + BT + '],' + BT + '错误日志' + BT + ',' + BT + LOG_DESC + BT + ',{list:true,modes:' + LOG_MODES + '})'
  const log = logCall + (APP_FIELDS_CODE ? ',' + APP_START + APP_FIELDS_CODE + APP_END : '')
  let out = stripBarePermField(stripMarkedWithComma(stripMarked(text, PERM_START, PERM_END), '/*KKK-APP-START*/', '/*KKK-APP-END*/'))
  const before = out
  for (const [prefix, build] of [
    ['l([' + BT + 'bilibili' + BT + ',' + BT + 'loginPerm' + BT + '],', () => perm('bilibili')],
    ['o([' + BT + 'bilibili' + BT + ',' + BT + 'loginPerm' + BT + '],', () => perm('bilibili')],
    ['l([' + BT + 'douyin' + BT + ',' + BT + 'loginPerm' + BT + '],', () => perm('douyin')],
    ['o([' + BT + 'douyin' + BT + ',' + BT + 'loginPerm' + BT + '],', () => perm('douyin')],
    ['c([' + BT + 'app' + BT + ',' + BT + 'errorLogSendTo' + BT + '],', () => log],
    ['n([' + BT + 'app' + BT + ',' + BT + 'errorLogSendTo' + BT + '],', () => log],
    ['t.renderPermField([' + BT + 'app' + BT + ',' + BT + 'errorLogSendTo' + BT + '],', () => log],
  ]) out = replaceCall(out, prefix, build)
  if (out !== before) console.log('[kkk] 权限字段改为「选 id 才出输入框」: ' + name)
  if (!out.includes(PERM_START)) {
    out = out.replace(',renderPageHeader:(e,n)=>', ',' + PERM_START + RENDER_PERM_FIELD + PERM_END + 'renderPageHeader:(e,n)=>')
  }
  return out
}

/* ---------------- 全局文案替换 ---------------- */

const TEXT_REPLACERS = [
  [/https:\/\/kkk\.karinjs\.com/g, 'https://kkk.tangbot.xyz'],
  // 「关于插件」页：上游的仓库/头像/作者信息换成本项目
  [/https:\/\/github\.com\/ikenxuan\/karin-plugin-kkk/g, 'https://github.com/maimai993/koishi-plugin-kkk'],
  [/https:\/\/github\.com\/ikenxuan\.png/g, 'https://github.com/maimai993.png'],
  // 注意：替换文本自身也含 "ikenxuan, sj817"，不加否定断言的话每跑一次就会再套一层
  // （实测 ThemeSwitch 那个包里已经被套了两层，脚本就不是「可反复执行」了）
  [/ikenxuan, sj817(?![）)])/g, 'maimai993（Koishi 移植版；上游 karin-plugin-kkk by ikenxuan, sj817）'],
  // 「关于插件」页的大标题（JSX 里是反引号字符串）
  [/`karin-plugin-kkk`/g, '`koishi-plugin-kkk`'],
  [/版本 2\.33\.0/g, '版本 __KKK_VERSION__'],
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
  text = patchPushDialog(text, name)
  text = patchTextFields(text, name)
  text = patchPermFields(text, name)
  text = patchDescriptions(text, name)
  text = applyTextReplacements(text, name)

  fs.writeFileSync(file, text)
  if (text.length !== before || before !== fs.statSync(file).size || !isBundle) console.log('[kkk] 已处理: ' + name + '（' + before + ' → ' + text.length + ' 字节）')
}

console.log('[kkk] 完成，共处理 ' + files.length + ' 个文件')