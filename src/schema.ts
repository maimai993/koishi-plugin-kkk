/**
 * 把插件自己的配置（上游的 config.json）映射成 Koishi 的控制台表单。
 *
 * 上游 Karin 版把这些配置放在 \`config/config.json\`（amagi / app / douyin / bilibili / kuaishou /
 * xiaohongshu / pushlist 七个模块），由它的 WebUI 编辑。Koishi 侧如果只声明集成选项，
 * 控制台的「插件配置」里就看不到清晰度这类选项 —— 所以这里**按默认配置的形状动态生成 Schema**：
 *   - 结构、键名与上游完全一致，升级上游默认配置后表单会自动跟着变；
 *   - 描述取自上游 \`config/default_config/*.yaml\` 里每个字段上方的中文注释（Karin 版的字段说明）；
 *   - **默认值取自同一份默认配置**：所有字段在控制台里都显示真实取值，而不是一片空白；
 *   - **枚举型字段渲染成下拉框**：取值直接从注释里解析（「可选值：'info'(视频信息)…」、
 *     \`- 6: 240P 极速\` 这类列表、\`all为所有人\` 这类权限说明），选项文案用注释里的中文说明。
 *
 * ⚠️ 默认值带来的副作用（已在 configBridge 里处理）：Koishi 会把默认值填进配置对象，
 * 于是「没填」和「填了默认值」不再靠有没有值来区分，改为**与上游默认值相等即视为没填**，
 * 这样用户直接改 config.json 的内容不会在下次启动时被表单里的默认值覆盖。
 * 代价：在控制台里把某项改回默认值，不会写回 config.json（想强制改回请用 /kkk 面板或直接改文件）。
 */
import fs from 'node:fs'
import path from 'node:path'

import { Schema } from 'koishi'

/** 递归深度上限，避免异常配置把 Schema 撑爆 */
const MAX_DEPTH = 6

/** \`douyin.videoQuality\` -> 「视频画质偏好设置…」 */
export type DescriptionMap = Record<string, string>

/** 一个下拉选项 */
export interface EnumOption {
  value: string | number
  label: string
}

/** 一个字段的注释信息 */
export interface FieldMeta {
  /** 注释正文（拼成一段） */
  text: string
  /** 从注释里解析出来的候选值；没有就是普通输入框 */
  options?: EnumOption[]
}

export type MetaMap = Record<string, FieldMeta>

/**
 * 补充说明：上游 YAML 里没有（字段是后加的）或只作为模块容器出现的字段，
 * 按 \`src/karin/types/config/*.ts\` 的 JSDoc 与实际用途补上。YAML 里已有的说明优先。
 */
const SUPPLEMENT: DescriptionMap = {
  amagi: 'amagi 解析库配置：请求超时、UA、代理、各平台 Cookie、内置 API Server',
  'amagi.proxy.switch': '是否启用代理',
  'amagi.cookies': '各平台 Cookie，扫码登录成功后会自动写入这里',
  'amagi.cookies.bilibili': 'B站 Cookie（SESSDATA 等），配置后才能拿高画质与动态推送',
  'amagi.cookies.douyin': '抖音 Cookie，配置后才能解析作品与推送',
  'amagi.cookies.kuaishou': '快手 Cookie',
  'amagi.cookies.xiaohongshu': '小红书 Cookie',
  app: '全局通用设置：解析总开关、渲染、缓存、错误上报等',
  'app.forwardContent': '合并转发里包含哪些内容（fakeForward 打开时生效）：text 文字 / image 图片 / video 视频 / audio 语音 / file 文件 / markdown 卡片。没列出来的一律单独直发 —— OneBot 的转发节点装不下大体积视频，默认不含 video',
  'app.ambientCover': '封面氛围背景参数：控制封面图对模板背景氛围的贡献度，取值 0~1',
  'app.ambientCover.coverOpacity': '模糊封面层不透明度：封面色强度总闸，越大整体越浓',
  'app.ambientCover.overlayEdgeOpacity': '主题色压色罩两端（顶/底）不透明度',
  'app.ambientCover.overlayMiddleOpacity': '主题色压色罩中间带不透明度，越小封面色越透',
  douyin: '抖音解析与推送设置',
  bilibili: 'B站解析与推送设置',
  kuaishou: '快手解析设置',
  xiaohongshu: '小红书解析设置',
  pushlist: '推送订阅列表：每一项是「关注对象 + 群号:机器人账号」，可加过滤词/标签',
  'xiaohongshu.watermark': '小红书图片是否加水印（上游保留项）'
}

/**
 * 注释里解析不出来的枚举，手工补。
 * 只补「取值域封闭、写错就跑不起来」的字段；普通数值/文本**不要**往这里加，
 * 否则控制台会把人限制在几个选项里。
 */
const SUPPLEMENT_ENUMS: Record<string, EnumOption[]> = {
  'app.Theme': [
    { value: 0, label: '自动（06:00-18:00 浅色，其余深色）' },
    { value: 1, label: '浅色' },
    { value: 2, label: '深色' },
    { value: 3, label: '智能场景（按封面判断深浅）' }
  ],
  'douyin.push.shareType': [
    { value: 'web', label: '跳转到抖音网页' },
    { value: 'download', label: '视频下载直链' }
  ]
}

/** 权限类字段：值就是 all / admin / master / group.owner / group.admin */
const PERMISSION_VALUES: EnumOption[] = [
  { value: 'all', label: '所有人' },
  { value: 'admin', label: '管理员' },
  { value: 'master', label: '主人' },
  { value: 'group.owner', label: '群主' },
  { value: 'group.admin', label: '群管理员' }
]

/** 字段名命中权限域 */
const isPermissionField = (name: string): boolean => /^(loginPerm|permission)$/i.test(name)

/** 剥掉列表项的 \`[]\` 后缀，用于回查字段名 */
const shortName = (fieldPath: string): string => fieldPath.split('.').pop()!.replace(/\[\]$/, '')

/**
 * 从注释行里抽枚举候选。
 *
 * 支持的三种写法（都是上游 YAML 里真实存在的）：
 * 1. \`可选值：'info'(视频信息)、'comment'(评论图片)\` —— 引号里的值 + 紧跟的中文说明；
 * 2. 列表项 \`- 6: 240P 极速\` / \`- 'off': 关闭\` / \`- 'google' - Google Motion Photo\`；
 * 3. \`all为所有人，admin为管理员…\` —— 权限字段常见写法。
 * @param lines 该字段的注释行
 * @param name 字段名（判断是不是权限域）
 */
function extractOptions (lines: string[], name: string): EnumOption[] | undefined {
  const found = new Map<string, string>()
  const add = (rawValue: string, label: string) => {
    const value = String(rawValue ?? '').trim().replace(/^['"]|['"]$/g, '')
    const text = String(label ?? '').replace(/^[\s:：\-—]+/, '').replace(/[，,。；;]+$/, '').trim()
    if (!value || found.has(value)) return
    found.set(value, text)
  }

  for (const line of lines) {
    const bullet = line.match(/^\s*[-*·]\s+(.+)$/)
    if (bullet) {
      const item = bullet[1].match(/^['"]?([^'"\s:：]+)['"]?\s*(?:[:：\-—]\s*)?(.*)$/)
      if (item) add(item[1], item[2])
      continue
    }

    if (/可选值|可选：/.test(line)) {
      const quoted = /['"]([^'"]+)['"]/g
      let matched: RegExpExecArray | null
      while ((matched = quoted.exec(line)) !== null) {
        const rest = line.slice(quoted.lastIndex)
        /**
         * 候选值后面必须紧跟「说明括号 / 顿号 / 逗号 / 句号 / 结束」。
         * 这条约束是为了滤掉解释性文字里的引号 —— 例如
         * 「'master'（除'console'外的第一个主人）」里的 'console' 后面是「外」，
         * 不加约束就会多出一个叫 console 的假选项。
         */
        if (!/^\s*([（(、，,。;；]|$)/.test(rest)) continue
        const label = rest.match(/^\s*[（(]([^）)]*)[）)]/)
        add(matched[1], label ? label[1] : '')
      }
      continue
    }

    if (isPermissionField(name)) {
      const words = /([a-zA-Z][\w.]*)为/g
      let matched: RegExpExecArray | null
      while ((matched = words.exec(line)) !== null) add(matched[1], '')
    }
  }

  // 「0为自动，1为浅色，2为深色」这类数字枚举：至少 3 个才算，避免把「0-100」这种区间误判成枚举
  const numeric = new Map<string, string>()
  for (const line of lines) {
    const numbers = /(\d+(?:\.\d+)?)\s*为/g
    let matched: RegExpExecArray | null
    while ((matched = numbers.exec(line)) !== null) {
      if (!numeric.has(matched[1])) numeric.set(matched[1], '')
    }
  }
  if (numeric.size >= 3) for (const [value, label] of numeric) add(value, label)

  return found.size >= 2 ? [...found].map(([value, label]) => ({ value, label })) : undefined
}

/**
 * 解析 \`config/default_config/*.yaml\` 里的字段注释。
 *
 * 形如：
 * \`\`\`yaml
 * # 视频体积上限，自适应画质模式下可接受的最大视频大小（单位：MB）
 * maxAutoVideoSize: 50
 * \`\`\`
 * 注释写在字段上方、连续若干行，用缩进判断层级。
 * @param pluginRoot 插件根目录
 */
export function parseConfigMeta (pluginRoot: string): MetaMap {
  const dir = path.join(pluginRoot, 'config', 'default_config')
  const result: MetaMap = {}
  let files: string[] = []
  try {
    files = fs.readdirSync(dir).filter((item) => item.endsWith('.yaml'))
  } catch {
    return result
  }

  for (const file of files) {
    const mod = file.replace(/\.yaml$/, '')
    let content = ''
    try {
      content = fs.readFileSync(path.join(dir, file), 'utf8')
    } catch {
      continue
    }
    const stack: Array<{ indent: number; key: string }> = []
    let comments: string[] = []

    for (const rawLine of content.split(/\r?\n/)) {
      const trimmed = rawLine.trim()
      if (!trimmed) {
        comments = []
        continue
      }
      if (trimmed.startsWith('#')) {
        comments.push(trimmed.replace(/^#\s?/, '').trimEnd())
        continue
      }
      const matched = rawLine.match(/^(\s*)([^\s:#][^:#]*?)\s*:/)
      if (!matched) {
        // 数组项、缩进文本等
        comments = []
        continue
      }
      const indent = matched[1].length
      const key = matched[2].trim().replace(/^['"]|['"]$/g, '')
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
      stack.push({ indent, key })

      const fullPath = [mod, ...stack.map((item) => item.key)].join('.')
      const text = comments.join(' ').replace(/\s+/g, ' ').trim()
      if (text && !result[fullPath]) {
        result[fullPath] = { text, options: extractOptions(comments, key) }
      }
      comments = []
    }
  }

  // 上游把若干旧 YAML 合并进了 config.json 的模块（例如 amagi 里混着 request/cookies 的字段），
  // 这些字段的完整路径对不上，补一张「唯一短名 → 描述」的表兜底。
  const flatCount: Record<string, number> = {}
  const flat: MetaMap = {}
  for (const [key, value] of Object.entries(result)) {
    const name = key.split('.').pop()!
    flatCount[name] = (flatCount[name] ?? 0) + 1
    flat[name] = value
  }
  for (const [name, count] of Object.entries(flatCount)) {
    if (count === 1) result['#' + name] = flat[name]
  }
  return result
}

/** 只取描述文本（对外保留的旧接口） */
export function parseConfigDescriptions (pluginRoot: string): DescriptionMap {
  const meta = parseConfigMeta(pluginRoot)
  const result: DescriptionMap = {}
  for (const [key, value] of Object.entries(meta)) result[key] = value.text
  return result
}

/**
 * 取某个字段路径的注释信息：完整路径 → 去掉 \`[]\` 的路径 → 唯一短名兜底。
 *
 * 中间那一跳是为数组元素准备的：枚举解析时用的是 \`xxx[]\`，
 * 而注释是按 \`xxx\` 登记的；同名短名（douyin/bilibili 都有 displayContent）又轮不到兜底表，
 * 少这一跳数组字段就永远拿不到下拉选项。
 */
function metaOf (meta: MetaMap, fieldPath: string): FieldMeta | undefined {
  return meta[fieldPath]
    ?? meta[fieldPath.replace(/\[\]$/, '')]
    ?? meta['#' + shortName(fieldPath)]
}

/** 取某个字段路径的描述：YAML 说明 → 唯一的短名兜底 → 手工补充 */
function describe (meta: MetaMap, fieldPath: string): string | undefined {
  return metaOf(meta, fieldPath)?.text ?? SUPPLEMENT[fieldPath]
}

/**
 * 把候选值对齐到字段的类型上。
 * @param options 候选值
 * @param sample 该字段的默认值（决定类型）
 * @returns 可用的下拉选项；类型对不上或不足 2 个时返回 undefined
 */
function coerceOptions (options: EnumOption[] | undefined, sample: unknown): EnumOption[] | undefined {
  if (!options || options.length < 2) return undefined
  const seen = new Set<string | number>()
  const result: EnumOption[] = []
  for (const option of options) {
    let value: string | number
    if (typeof sample === 'number') {
      value = Number(option.value)
      if (!Number.isFinite(value)) continue
    } else if (typeof sample === 'string') {
      value = String(option.value)
    } else {
      return undefined
    }
    if (seen.has(value)) continue
    seen.add(value)
    result.push({ value, label: option.label })
  }
  return result.length >= 2 ? result : undefined
}

/**
 * 「允许手填账号」的字段名（loginPerm / permission / errorLogSendTo）。
 *
 * 这些字段既能写关键字（all / admin / master / group.owner / group.admin），
 * 也能直接写**用户 ID**（`123456789`，多个用逗号分隔 / 数组）。
 */
const LOOSE_VALUE_FIELDS = new Set(['loginPerm', 'permission', 'errorLogSendTo'])

/** 手填账号时补在说明后面的一句提示 */
const LOOSE_HINT = '（也可以直接填用户 ID，不是 QQ 号；多个用逗号分隔）'

/**
 * 生成叶子字段（枚举 → 下拉；否则按类型给输入框），并带上默认值与说明。
 *
 * ⚠️ 可以手填账号的那几个字段**不能**做成「枚举下拉」：下拉会把值限死在几个 const 上，
 * 用户手填的 ID 一保存就会被 Schema 校验拒掉 —— 而且报出来的还是被
 * `@cordisjs/logger` 那句 `Cannot read properties of null (reading 'logger')` 盖掉的无头错误
 * （用户实测：面板里选「指定账号」填了 ID，一保存就报这句）。
 */
function leafSchema (sample: unknown, fieldPath: string, meta: MetaMap, ensure: unknown[] = []): Schema {
  const loose = LOOSE_VALUE_FIELDS.has(shortName(fieldPath))
  const withDesc = (schema: Schema): Schema => {
    const text = describe(meta, fieldPath)
    if (!text) return schema
    return schema.description(loose ? text + LOOSE_HINT : text)
  }

  // 手工枚举优先（选项文案更清楚），没有就用注释里解析出来的；手填账号的字段直接用文本框
  const options = loose ? undefined : coerceOptions(SUPPLEMENT_ENUMS[fieldPath] ?? metaOf(meta, fieldPath)?.options, sample)
  if (options) {
    const list = [...options]
    /**
     * 默认值必须出现在选项里。
     * 对数组字段这不是理论问题：上游注释里 \`douyin.displayContent\` 就漏写了 \`desc\`，
     * 而默认值里有它 —— 不补进去，控制台一保存就会写出一个 Schema 校验不过的值。
     */
    for (const value of [sample, ...ensure]) {
      if (typeof value !== 'string' && typeof value !== 'number') continue
      if (list.some((option) => option.value === value)) continue
      list.unshift({ value, label: String(value) + '（默认值，注释里未列出）' })
    }
    const union = Schema.union(
      list.map((option) => Schema.const(option.value as never).description(option.label || String(option.value)))
    )
    return withDesc(union.default(sample as never))
  }

  if (typeof sample === 'boolean') return withDesc(Schema.boolean().default(sample))
  if (typeof sample === 'number') return withDesc(Schema.number().default(sample))
  if (typeof sample === 'string') return withDesc(Schema.string().default(sample))
  return withDesc(Schema.any())
}

function toSchema (value: unknown, fieldPath: string, meta: MetaMap, depth = 0): Schema {
  if (depth > MAX_DEPTH) return Schema.any()

  if (Array.isArray(value)) {
    const sample = value.find((item) => item !== null && item !== undefined)
    const inner = sample === undefined ? Schema.any() : leafSchema(sample, fieldPath + '[]', meta, value)
    const text = describe(meta, fieldPath)
    const schema = Schema.array(inner).default(value as never)
    return text ? schema.description(text) : schema
  }

  if (value && typeof value === 'object') {
    const dict: Record<string, Schema> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      dict[key] = toSchema(item, fieldPath + '.' + key, meta, depth + 1)
    }
    const text = describe(meta, fieldPath)
    const schema = Schema.object(dict)
    return text ? schema.description(text) : schema
  }

  return leafSchema(value, fieldPath, meta)
}

/** 读取插件的默认配置，生成对应的 Koishi Schema（读不到时给个空对象，不影响启动） */
export function buildUpstreamSchema (pluginRoot: string): Schema {
  try {
    const file = path.join(pluginRoot, 'config', 'default_config', 'config.json')
    const defaults = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    const meta = parseConfigMeta(pluginRoot)
    const dict: Record<string, Schema> = {}
    for (const [key, value] of Object.entries(defaults)) {
      dict[key] = toSchema(value, key, meta)
    }
    return Schema.object(dict)
  } catch {
    return Schema.object({})
  }
}

export default buildUpstreamSchema
