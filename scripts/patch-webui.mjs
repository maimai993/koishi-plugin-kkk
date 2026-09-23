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
 * 「不可编辑」的表达式。
 *
 * 语义：带 `editableWhen: 'danmaku'` 的字段（目前只有「弹幕重定向在线播放器」那一个开关），
 * **只有把通用里的「强制不烧录弹幕」关掉（= 打开弹幕功能）之后才能改**；
 * 开着「强制不烧录弹幕」时锁住（读不到这个键时按默认值 true 处理，同样锁住）。
 *
 * 注意极性：Q 取到的是当前值，`===!0` 表示「强制不烧录弹幕开着」= 要锁住。
 * （之前这里写成了 `===!1`，于是「关掉强制不烧录弹幕」反而把字段锁住了。）
 */
const DANMAKU_LOCKED = 'Q(e,' + arr(['qq', 'forceNoDanmaku']) + ',!0)===!0'

/** 锁住时在字段说明后面补一句，免得用户以为是界面坏了 */
const LOCK_HINT = '（这一项要先关掉上面的「强制不烧录弹幕」（也就是打开弹幕功能）才能改）'

/**
 * 「在线播放器设置」这一组的**总开关**。
 *
 * 用户要求：这一组要有自己的总开关，关掉时组内其它字段（公网地址 / 端口 / 有效期 /
 * 在线播放最大文件 / 超限转在线播放 / 面板显示「在线看」按钮）全部禁用变灰，
 * 打开即恢复可编辑 —— 用面板现成的「不可编辑」门控（和「强制不烧录弹幕」锁那一套同一视觉）。
 *
 * 极性：`Q(e,['qq','playerEnabled'],true)` 取到当前值（缺省即开），`===false` 表示「关着」= 锁住。
 */
const PLAYER_SECTION = '在线播放器设置'
const PLAYER_MASTER_KEY = 'playerEnabled'
const PLAYER_GROUP_OFF = 'Q(e,' + arr(['qq', PLAYER_MASTER_KEY]) + ',!0)===!1'
/** 被总开关关掉时补一句说明 */
const GROUP_LOCK_HINT = '（这一项要先把上面的「在线播放器总开关」打开才能改）'

/**
 * 「这一项跟着某个开关走」的联动表（键 = 字段，值 = 它依赖的那个开关字段）。
 *
 * 开关关掉时这一项禁用变灰，视觉与「在线播放器总开关」那把锁完全一致。
 * 目前：重复解析间隔（分钟）只有「短时间不重复解析」打开时才可改。
 */
const FIELD_DISABLED_BY = {
  parseDedupeMinutes: 'parseDedupe'
}

/** 取字段的 label（联动提示语里要用「短时间不重复解析」这种用户看到的说法） */
const labelOfField = (key) => (fields.find((item) => item.key === key)?.label) || key

const appFieldCall = (field) => {
  const path = '[' + [q('qq'), q(field.key)].join(',') + ']'
  const locked = field.editableWhen === 'danmaku'
  /** 在线播放器设置这一组里，除总开关以外的字段都跟着总开关联动 */
  const lockedByGroup = field.section === PLAYER_SECTION && field.key !== PLAYER_MASTER_KEY
  /** 这一项依赖的开关（见 FIELD_DISABLED_BY） */
  const dependsOn = FIELD_DISABLED_BY[field.key]
  const dependsOff = dependsOn ? 'Q(e,' + arr(['qq', dependsOn]) + ',!0)===!1' : ''
  const disabled = [locked ? DANMAKU_LOCKED : '', lockedByGroup ? PLAYER_GROUP_OFF : '', dependsOff].filter(Boolean).join('||')
  const dependsHint = dependsOn ? '（这一项要先把上面的「' + labelOfField(dependsOn) + '」打开才能改）' : ''
  const description = q(String(field.description) + (locked ? LOCK_HINT : '') + (lockedByGroup ? GROUP_LOCK_HINT : '') + dependsHint)
  // renderSwitch 的第 4 个参数、renderTextField 的 options.disabled 都是「不可编辑」
  if (field.type === 'boolean') {
    return 's(' + path + ',' + q(field.label) + ',' + description + (disabled ? ',' + disabled : '') + ')'
  }
  /** 多选（checkboxGroup）：面板用 renderCheckboxGroup，选项来自字段的 options */
  if (field.type === 'checkboxGroup') {
    const options = '[' + (field.options ?? [])
      .map((option) => '{value:' + q(option.value) + ',label:' + q(option.label) + '}')
      .join(',') + ']'
    return 'n(' + path + ',' + q(field.label) + ',' + description + ',' + options
      + (disabled ? ',' + disabled : '') + ')'
  }
  const opts = ["type:" + q(field.type === 'number' ? 'number' : 'text')]
  if (field.type === 'number') {
    opts.push('fallback:' + Number(field.default))
    if (field.min !== undefined) opts.push('min:' + field.min)
    if (field.max !== undefined) opts.push('max:' + field.max)
  }
  if (disabled) opts.push('disabled:' + disabled)
  return 'c(' + path + ',' + q(field.label) + ',' + description + ',{' + opts.join(',') + '})'
}
const sectionFields = (section) => APP_FIELDS.filter((field) => field.section === section)
/** 直接跟在「交互设置」里的散字段（没有 section 的那些） */
const APP_FIELDS_CODE = APP_FIELDS.filter((field) => !field.section).map(appFieldCall).join(',')
/**
 * 带 section 的字段（在线播放器设置）：**必须是「交互设置」的兄弟节点**，不能塞进它里面。
 *
 * 踩过的坑：原来这段被注入到「交互设置」的 children 里，于是它被渲染成交互设置卡片里的
 * 一个 `card__content > grid grid-cols-2` 子卡片 —— 和「缓存设置 / 交互设置」那种顶层卡片
 * 完全不是一个样式（外框内缩、字段被挤成两列）。现在按标记插在「交互设置」这个分组调用之后，
 * 和其它分组一样直接挂在表单根下的 Fragment 里，走的是同一套卡片容器与间距。
 */
const APP_SECTION_CODE = [...new Set(APP_FIELDS.filter((field) => field.section).map((field) => field.section))].map((section) =>
  'o(' + q(section)
  + ',(0,U.jsx)(U.Fragment,{children:['
  + sectionFields(section).map(appFieldCall).join(',')
  + ']}))').join(',')
const SECT_START = '/*KKK-SECTION-START*/'
const SECT_END = '/*KKK-SECTION-END*/'


/* ------------------------------------------------------------------ *
 * 通用设置：优先渲染器（app.renderer）
 * ------------------------------------------------------------------ */

const RENDERER_START = '/*KKK-RENDERER-START*/'
const RENDERER_END = '/*KKK-RENDERER-END*/'

/**
 * 「优先渲染器」这一项挂在「通用」分类下，**作为「渲染设置」的兄弟分组**插在它后面。
 *
 * 存储位置是上游配置的 `app.renderer`（和 renderScale 同一个段），取值 'shotkit' | 'puppeteer'。
 * 面板里用下拉框（i = 该分类的选项渲染器），默认值放在上游 config.json / app.yaml 里，
 * 这里只负责把控件画出来。
 *
 * 文案里那句 https 的提醒是实测结论，不是猜测：预编译内核在 Windows 上拉不到 https 资源，
 * 而卡片里的封面、头像基本都是 https，选内核会缺图 —— 用户看到选项说明就知道该选哪个。
 */
const RENDERER_FIELD = 'i(' + arr(['app', 'renderer']) + ',' + q('优先渲染器') + ',' + q(
  '卡片优先用哪个渲染器渲染。两个渲染服务都在时会按这里选的走，缺一个就自动用另一个；',
) + ',['
  + '{label:' + q('shotkit 内核（默认）') + ',value:' + q('shotkit') + ',description:' + q(
    '不依赖浏览器，单张几十毫秒、内存低。注意：当前预编译内核在 Windows 上加载不了 https 资源，卡片里的远程封面、头像会缺图。',
  ) + '}'
  + ',{label:' + q('浏览器（Chrome / Edge）') + ',value:' + q('puppeteer') + ',description:' + q(
    '完整渲染、远程资源正常，单张通常 1 秒以上，需要浏览器渲染服务（koishi-plugin-puppeteer 或同类）。',
  ) + '}'
  + '],e=>e)'

const RENDERER_CODE = 'o(' + q('通用设置') + ',(0,U.jsxs)(U.Fragment,{children:[' + RENDERER_FIELD + ']}))'

/** 插到「渲染设置」这个分组后面（兄弟节点）。可重复执行：先按标记删上次插的，再插一次。 */
function patchRendererSetting (text, name) {
  let out = stripMarkedWithComma(text, RENDERER_START, RENDERER_END)
  const at = out.indexOf('`渲染设置`')
  if (at < 0) return out
  let open = -1
  for (let i = at - 1; i >= 0 && i > at - 40; i--) {
    if (out[i] === '(') { open = i; break }
  }
  if (open < 0) return out
  const close = matchParen(out, open)
  if (close < 0) return out
  out = out.slice(0, close + 1) + ',' + RENDERER_START + RENDERER_CODE + RENDERER_END + out.slice(close + 1)
  console.log('[kkk] 「通用设置 → 优先渲染器」已注入到「渲染设置」之后: ' + name)
  return out
}

/**
 * 把带 section 的分组插到「交互设置」后面（兄弟节点）。
 *
 * 可重复执行：先按标记删掉上次插的（连同前面那个逗号），再插一次 —— 不会越套越多。
 */
function patchAppSections (text, name) {
  let out = stripMarkedWithComma(text, SECT_START, SECT_END)
  if (!APP_SECTION_CODE) return out
  const at = out.indexOf('`交互设置`')
  // 只在真正注入时打日志：这个函数会对每个前端包都跑一遍，没找到分组的是正常情况
  if (at < 0) return out
  // 往前找到这次分组调用的左括号（形如 o(`交互设置`,(…))）
  let open = -1
  for (let i = at - 1; i >= 0 && i > at - 40; i--) {
    if (out[i] === '(') { open = i; break }
  }
  if (open < 0) return out
  const close = matchParen(out, open)
  if (close < 0) return out
  out = out.slice(0, close + 1) + ',' + SECT_START + APP_SECTION_CODE + SECT_END + out.slice(close + 1)
  console.log('[kkk] 在线播放器设置已作为「交互设置」的兄弟分组注入: ' + name)
  return out
}

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

/* ------------------------------------------------------------------ *
 * 「Koishi 设置」分类：插件在 Koishi 里的运行参数
 * ------------------------------------------------------------------ */

const KOISHI_START = '/*KKK-KOISHI-START*/'
const KOISHI_END = '/*KKK-KOISHI-END*/'
const KOISHI_COMPONENT = 'KKKNativeConfig'
const KOISHI_CATEGORY = '{key:' + q('koishi') + ',label:' + q('Koishi 设置') + ',description:' + q('插件本体设置') + '}'
const KOISHI_SWITCH = ';case' + q('koishi') + ':return(0,U.jsx)(' + KOISHI_COMPONENT + ',{...e})'

/**
 * 这一分类里的字段渲染器调用。
 *
 * 存的位置是 koishi.yml 里本插件的**顶层键**（dataPath / debug / autoParse / webUiAuth），
 * 所以路径写 ['koishi', 字段名]，服务端（src/webui.ts 的 NATIVE_PANEL_KEYS）拆出来写回顶层。
 *
 * **masters 不在这里**：主人账号属于 Koishi 的权限体系，而面板是免登录页面，
 * 不该给它开口子 —— 仍然只在 koishi.yml 里改（控制台那边也全部隐藏了）。
 */
const koishiFieldCode = [
  'n(' + q('Koishi 设置') + ',' + q('插件在 Koishi 里的运行参数。改完点右下角保存即可 —— 会写回 koishi.yml 并热重载，不用重启。') + ')',
  'r(' + q('基础') + ',(0,U.jsxs)(U.Fragment,{children:[' + [
    'i(' + arr(['koishi', 'autoParse']) + ',' + q('自动解析') + ',' + q('群里有人发链接（或回复一条带链接的消息）就自动解析，不用打指令。') + ')',
    'i(' + arr(['koishi', 'debug']) + ',' + q('调试日志') + ',' + q('在日志里输出调试信息，排查问题时才需要打开 —— 打开后日志会很吵。') + ')',
    'a(' + arr(['koishi', 'dataPath']) + ',' + q('数据目录') + ',' + q('配置、数据库、临时文件都放在这里（一般是绝对路径，例如 D:/devkoishi/data）。改完需要重启 Koishi 才生效。') + ',{type:' + q('text') + '})',
    'i(' + arr(['koishi', 'webUiAuth']) + ',' + q('面板需要登录控制台') + ',' + q('打开时 /kkk 面板要求先登录 Koishi 控制台（装了 auth 插件的部署）。没装 auth 插件时本来就没有登录这一说，这里不生效。') + ')'
  ].join(',') + ']}))'
].join(',')

const koishiComponentCode = KOISHI_COMPONENT
  + '=({config:e,renderers:t})=>{let{renderPageHeader:n,renderSubSection:r,renderSwitch:i,renderTextField:a}=t;return(0,U.jsxs)(U.Fragment,{children:[' + koishiFieldCode + ']})}'

/** 去掉上次插入的 Koishi 分类片段（可反复执行） */
function stripKoishiCategory (text) {
  let out = text
  for (;;) {
    const start = out.indexOf(KOISHI_START)
    if (start < 0) break
    const end = out.indexOf(KOISHI_END, start)
    if (end < 0) break
    const from = out[start - 1] === ',' ? start - 1 : start
    out = out.slice(0, from) + out.slice(end + KOISHI_END.length)
  }
  out = out.split(',' + KOISHI_CATEGORY).join('')
  out = out.split(KOISHI_SWITCH).join('')
  return out
}

function patchKoishiCategory (text, name) {
  if (!text.includes(KOISHI_COMPONENT) && !text.includes(',' + CATEGORY)) return text
  let out = stripKoishiCategory(text)
  // 分类入口：插在「QQ 适配器」之后
  const categoryAnchor = ',' + CATEGORY
  if (out.includes(categoryAnchor)) {
    out = out.replace(categoryAnchor, categoryAnchor + ',' + KOISHI_CATEGORY)
  } else {
    console.warn('[kkk] ' + name + '：没找到「QQ 适配器」分类入口，跳过 Koishi 分类')
    return text
  }
  // 分发 switch：插在 QQ 的 case 之后
  if (out.includes(SWITCH)) out = out.replace(SWITCH, SWITCH + KOISHI_SWITCH)
  // 组件定义：和 QQ 组件一样塞在 PR 前面
  if (out.includes(COMPONENT_ANCHOR)) out = out.replace(COMPONENT_ANCHOR, ',' + KOISHI_START + koishiComponentCode + KOISHI_END + COMPONENT_ANCHOR)
  console.log('[kkk] 「Koishi 设置」分类已注入: ' + name)
  return out
}

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
 * 现在都换成文本框：可以填 * （谁都可以）、关键字，也可以直接写用户 ID，多个用逗号分隔。
 * 服务端保存时会把「错误日志」这一项的字符串拆成数组。
 */
/**
 * 注意：Koishi 这边的账号是**用户 ID**（session.userId / 控制台里的用户 id），不是 QQ 号 ——
 * 群里那个 QQ 号和用户 ID 不一定相等，写 QQ 号会匹配不上（用户实测反馈过这个文案问题）。
 */
const PERM_DESC = '选「指定账号」后填用户 ID，多个用逗号分隔。'
const LOG_DESC = '谁来接收错误日志，选「指定账号」后填用户 ID，多个用逗号分隔。'

/** 面板里的新标签（原来叫「伪造合并转发消息」，名字看不出「关掉就逐条发」） */
const FAKE_FORWARD_LABEL = '解析结果合并转发'

/**
 * 标签改名（整段替换 → 幂等）：`伪造合并转发消息` → `解析结果合并转发`。
 *
 * 必须定义在 TEXT_SWAPS **之前**（TEXT_SWAPS 里直接展开它，写在后面会 TDZ 报错）。
 */
const LABEL_SWAPS = [
  [
    // 注意：arr() 自带方括号，这里不能再包一层（写成 's([' + arr(...) + ']' 就成了 s([[…]])，永远匹配不上）
    's(' + arr(['app', 'fakeForward']) + ',' + q('伪造合并转发消息') + ',',
    's(' + arr(['app', 'fakeForward']) + ',' + q(FAKE_FORWARD_LABEL) + ',',
  ],
]

const TEXT_SWAPS = [
  ...LABEL_SWAPS,
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
/**
 * 「解析结果合并转发」的说明。
 *
 * 用户实测反馈「关闭合并转发 还是合并的」—— 之前这个开关只管「用谁的身份展示」，
 * 关掉照样合并；现在它同时管「要不要合并」：打开才合并（触发者身份），关掉就逐条发。
 */
const FAKE_FORWARD_DESC = '全局合并转发，优先级最高：打开时所有平台的解析结果都合成一条聊天记录发出，用触发者的身份展示；'
  + '「开始解析 / 下载中」这类过程提示不会进去。关掉就不合并，内容一条一条发。'
  + '只对支持聊天记录的适配器有效果（QQ 官方适配器没有这个能力，会自动改成逐条发送）。'

const DESC_BY_LABEL = [
  ['谁可以触发扫码登录', PERM_DESC],
  ['错误日志', LOG_DESC],
  [FAKE_FORWARD_LABEL, FAKE_FORWARD_DESC],
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
 *   只有选中「指定账号」时才出现输入框，填用户 ID、多个用逗号分隔。
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
  '(0,U.jsx)(cx,{variant:`secondary`,placeholder:`填写用户 ID，多个用逗号分隔`})]}):null,',
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

/* ---------------- 面板 API 返回值兜底（防黑屏） ---------------- */

/**
 * 「推送列表 / 推送目标」那几个接口的返回值兜底。
 *
 * 线上事故：服务端 `/kkk/v1/groups/batch` 原来返回 `data: null`，而前端拿到后直接 `data.find(...)`
 * （bundle 里的 `bR` 组件）—— 用户「填完频道 id 点完成」之后渲染期抛
 * `TypeError: Cannot read properties of null (reading 'find')`，React 卸载整棵树 → **整个面板黑屏**。
 *
 * 后端已经改成永远返回数组（见 src/webui.ts），这里再加一层前端兜底：
 * 无论后端返回什么，这三个函数都只给出数组，绝不把 null 交给渲染逻辑。
 *
 * 替换是**整段函数替换**（不是外面再包一层），替换后的文本里不再包含原文，
 * 所以脚本可以反复执行，不会越套越多。
 */
const API_GUARDS = [
  // 机器人列表
  [
    'sR=async()=>oR((await eI.get(' + BT + '/kkk/v1/bots' + BT + ')).data,' + BT + '获取 Bot 列表失败' + BT + ')',
    'sR=async()=>{let r=(await eI.get(' + BT + '/kkk/v1/bots' + BT + ')).data?.data;return Array.isArray(r)?r:[]}'
  ],
  // 某个机器人能看到的群列表
  [
    'cR=async e=>oR((await eI.get(' + BT + '/kkk/v1/bots/${encodeURIComponent(e)}/groups' + BT + ')).data,' + BT + '获取群列表失败' + BT + ')',
    'cR=async e=>{let r=(await eI.get(' + BT + '/kkk/v1/bots/${encodeURIComponent(e)}/groups' + BT + ')).data?.data;return Array.isArray(r)?r:[]}'
  ],
  // 推送目标的展示信息（黑屏就发生在这里：返回值被拿去做 .find）
  [
    'lR=async e=>e.length===0?[]:oR((await eI.post(' + BT + '/kkk/v1/groups/batch' + BT + ',{groups:e})).data,' + BT + '获取推送目标信息失败' + BT + ')',
    'lR=async e=>{if(!e.length)return [];let r=(await eI.post(' + BT + '/kkk/v1/groups/batch' + BT + ',{groups:e})).data?.data;return Array.isArray(r)?r:[]}'
  ],
]

function patchApiGuards (text, name) {
  let out = text
  let patched = 0
  for (const [from, to] of API_GUARDS) {
    if (out.includes(from)) { out = out.split(from).join(to); patched++ }
  }
  if (patched) console.log('[kkk] 接口返回值兜底: ' + name + '（' + patched + ' 处）')
  return out
}

/* ---------------- 面板错误边界（别整页黑屏） ---------------- */

/**
 * 往 index.html 里塞一小段脚本：面板里**没被接住**的异常（渲染期 TypeError、未处理的 Promise 拒绝）
 * 会在页面上顶出一块可读的中文报错卡片，而不是让用户对着黑屏发呆。
 *
 * 为什么放在页面级而不是 React 错误边界：面板是上游打包好的压缩 SPA，
 * 往里注入 React class 组件的风险太大；React 崩溃时会把错误重新抛到 window，
 * 这里接住就够了 —— 完整错误也照旧写进浏览器控制台，方便继续排查。
 */
const ERRB_START = '<!--KKK-ERRBOUNDARY-START-->'
const ERRB_END = '<!--KKK-ERRBOUNDARY-END-->'
const ERRB_SCRIPT = [
  ERRB_START,
  '<script>',
  '(function () {',
  "  if (window.__KKK_ERR_BOUNDARY__) return",
  "  window.__KKK_ERR_BOUNDARY__ = true",
  "  var shown = false",
  "  function draw (title, detail) {",
  "    if (shown) return",
  "    shown = true",
  "    try {",
  "      var box = document.createElement('div')",
  "      box.id = 'kkk-error-boundary'",
  "      box.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;padding:14px 18px;'"
    + " + 'background:#3a1d1d;color:#ffd7d7;font:13px/1.7 system-ui,-apple-system,sans-serif;'"
    + " + 'border-bottom:1px solid #7a3a3a;white-space:pre-wrap;word-break:break-word'",
  "      var head = document.createElement('div')",
  "      head.style.cssText = 'font-weight:600;margin-bottom:4px'",
  "      head.textContent = title",
  "      var body = document.createElement('div')",
  "      body.style.cssText = 'opacity:.9'",
  "      body.textContent = detail",
  "      var tip = document.createElement('div')",
  "      tip.style.cssText = 'margin-top:6px;opacity:.75'",
  "      tip.textContent = '面板还能继续用，刷新一下即可恢复。如果反复出现，把上面这行错误发给插件作者。'",
  "      var again = document.createElement('button')",
  "      again.textContent = '重新加载面板'",
  "      again.style.cssText = 'margin-top:10px;padding:6px 14px;border:0;border-radius:6px;"
    + "background:#c05555;color:#fff;cursor:pointer'",
  "      again.onclick = function () { location.reload() }",
  "      box.appendChild(head); box.appendChild(body); box.appendChild(tip); box.appendChild(again)",
  "      document.body.appendChild(box)",
  "    } catch (error) { /* 连兜底都失败就算了 */ }",
  "  }",
  "  window.addEventListener('error', function (event) {",
  "    var msg = (event && (event.message || (event.error && (event.error.message || event.error.stack)))) || '未知错误'",
  "    // 跨域脚本的 message 会被浏览器抹成 'Script error.'，这时位置信息就是唯一线索",
  "    var at = event && event.filename ? ' （' + event.filename + ':' + event.lineno + ':' + event.colno + '）' : ''",
  "    draw('面板出错了（已捕获，不会黑屏）', String(msg) + at)",
  "  })",
  "  window.addEventListener('unhandledrejection', function (event) {",
  "    var reason = event && event.reason",
  "    draw('面板出错了（已捕获，不会黑屏）', String((reason && reason.message) || reason || '未知错误'))",
  "  })",
  "})()",
  '</script>',
  ERRB_END
].join('\n')

/** index.html 里插入 / 更新错误边界：先按标记删掉旧的再插一次（幂等） */
function patchErrorBoundary (text, name) {
  if (!/^index\.html$/.test(name)) return text
  // 删掉上一次注入的块，顺手把留下的空行也收掉 —— 不然每跑一次就多 3 个字节（不是幂等）
  const out = stripMarked(text, ERRB_START, ERRB_END).replace(/\n[ \t]*\n([ \t]*<\/body>)/, '\n$1')
  if (!out.includes('</body>')) return out
  return out.replace('</body>', ERRB_SCRIPT + '\n  </body>')
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

/* ---------------- 合并转发：全局内容 + 各平台开关与内容 ---------------- */

/**
 * 「合并转发」相关字段。
 *
 * 语义（见 src/karin/module/utils/ParseForward.ts）：
 *   - **全局优先**：通用页的「解析结果合并转发」（app.fakeForward）打开 → 所有平台都合并；
 *   - 全局关着时，才看各平台页里的「合并转发（本平台）」开关（`<平台>.forward`）；
 *   - 合并内容也是两级：全局 app.forwardContent，平台 `<平台>.forwardContent`（留空 = 用全局那份）；
 *   - 没列出来的内容单独直发（例如 OneBot 的转发节点装不下大视频）。
 *
 * 注入点：通用页的 app.fakeForward 那一项**后面**（内容多选），
 * 以及每个平台页「解析开关」那一项**后面**（本平台开关 + 内容多选）。
 * 直接用渲染器工厂上的 t.renderSwitch / t.renderCheckboxGroup，不依赖各页自己的局部别名。
 */
const FORWARD_START = '/*KKK-FORWARD-START*/'
const FORWARD_END = '/*KKK-FORWARD-END*/'

const FORWARD_OPTIONS = '[' + [['text', '文字'], ['image', '图片'], ['video', '视频'], ['file', '文件']]
  .map(([value, label]) => '{value:' + q(value) + ',label:' + q(label) + '}').join(',') + ']'

const FORWARD_SWITCH_DESC = '本平台单独打开合并转发。注意全局优先：通用里的「解析结果合并转发」打开时所有平台都会合并，这个开关开不开都一样；只有全局关着时它才起作用。默认关闭。'
const FORWARD_CONTENT_DESC = '合并转发里放哪些内容：没勾的会单独发出去、不进聊天记录。留空表示用通用里那份全局设置。视频体积大时有些适配器（比如 NapCat）会拒绝整条聊天记录，这时会自动改成单独发送，不会丢内容。'
const FORWARD_GLOBAL_CONTENT_DESC = '全局合并转发里放哪些内容（通用页那个开关打开时生效，所有平台共用）：没勾的单独发。视频建议先不勾，聊天记录太大时适配器会整条拒绝。语音和 markdown 不在候选里：QQ 的聊天记录不支持语音气泡，markdown 只有官方 bot 认、而官方适配器没有合并转发能力。'

/** 平台页的锚点：紧跟在「解析开关」那一项之后插入 */
const FORWARD_TABS = [
  ['douyin', '抖音', 'c(' + arr(['douyin', 'switch']) + ',' + q('解析开关')],
  ['bilibili', '哔哩哔哩', 'c(' + arr(['bilibili', 'switch']) + ',' + q('解析开关')],
  ['kuaishou', '快手', 'a(' + arr(['kuaishou', 'switch']) + ',' + q('解析开关')],
  ['xiaohongshu', '小红书', 's(' + arr(['xiaohongshu', 'switch']) + ',' + q('解析开关')]
]

/** 在「某个字段渲染调用」后面插一段代码：按调用里的路径字面量定位，再做括号配对 */
function insertAfterCall (text, needle, code) {
  const at = text.indexOf(needle)
  if (at < 0) return text
  const open = text.lastIndexOf('(', at)
  if (open < 0) return text
  const close = matchParen(text, open)
  if (close < 0) return text
  return text.slice(0, close + 1) + ',' + code + text.slice(close + 1)
}

/** 平台页里那一段：小标题 + 本平台开关 + 本平台内容多选 */
function forwardSectionCode (platform, label) {
  return 't.renderSubSection(' + q('合并转发') + ',(0,U.jsxs)(U.Fragment,{children:['
    // 分类名已经写着平台名了（哔哩哔哩页里再写一遍「合并转发（哔哩哔哩）」是重复）
    + 't.renderSwitch(' + arr([platform, 'forward']) + ',' + q('合并转发') + ',' + q(FORWARD_SWITCH_DESC) + ')'
    + ',t.renderCheckboxGroup(' + arr([platform, 'forwardContent']) + ',' + q('合并转发内容') + ',' + q(FORWARD_CONTENT_DESC) + ',' + FORWARD_OPTIONS + ')'
    + ']}))'
}

function patchForwardFields (text, name) {
  // 先清掉上次注入的（脚本可反复执行）
  let out = stripMarked(text, FORWARD_START, FORWARD_END)
  const before = out

  // ① 通用页：全局合并内容（开关本身是原版就有的 app.fakeForward）
  out = insertAfterCall(out, arr(['app', 'fakeForward']) + ',' + q('解析结果合并转发'),
    FORWARD_START + 't.renderCheckboxGroup(' + arr(['app', 'forwardContent']) + ',' + q('合并转发内容（全局）')
    + ',' + q(FORWARD_GLOBAL_CONTENT_DESC) + ',' + FORWARD_OPTIONS + ')' + FORWARD_END)

  // ② 平台页：本平台开关 + 本平台内容
  for (const [platform, label, anchor] of FORWARD_TABS) {
    out = insertAfterCall(out, anchor, FORWARD_START + forwardSectionCode(platform, label) + FORWARD_END)
  }

  const hits = (out.match(/KKK-FORWARD-START/g) || []).length
  if (hits) console.log('[kkk] 合并转发字段共 ' + hits + ' 处: ' + name)
  void before
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

    // 4. 「Koishi 设置」分类（必须在 QQ 分类注入之后：它锚定的是 QQ 那一块）
    text = patchKoishiCategory(text, name)
  }

  if (/DesktopLayout|MobileLayout/.test(name)) {
    const stripped = stripUserCard(text)
    if (stripped !== text) { console.log('[kkk] 已删除用户信息块: ' + name); text = stripped }
  }
  text = patchPushDialog(text, name)
  text = patchApiGuards(text, name)
  text = patchErrorBoundary(text, name)
  text = patchTextFields(text, name)
  text = patchPermFields(text, name)
  // 必须在 patchPermFields 之后：那个函数会先剥掉旧的 APP 标记块再重写「交互设置」里的字段，
  // 我们的分组要插在「交互设置」**之后**，顺序反了会插到它里面去（就是这次要修的样式问题）
  text = patchAppSections(text, name)
  // 同样必须晚于 patchPermFields / patchAppSections：它锚定的是「渲染设置」的收尾括号
  text = patchRendererSetting(text, name)
  text = patchForwardFields(text, name)
  text = patchDescriptions(text, name)
  text = applyTextReplacements(text, name)

  fs.writeFileSync(file, text)
  if (text.length !== before || before !== fs.statSync(file).size || !isBundle) console.log('[kkk] 已处理: ' + name + '（' + before + ' → ' + text.length + ' 字节）')
}

console.log('[kkk] 完成，共处理 ' + files.length + ' 个文件')