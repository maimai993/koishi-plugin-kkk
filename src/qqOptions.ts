/**
 * QQ 适配器专属设置。
 *
 * 这些项只在 QQ 平台生效（面板、切片、番剧选集表格、卡片 OCR），
 * 定义集中在 \`qqFields.json\` —— 两边共用同一份：
 *   1. Koishi 控制台的插件配置表单（\`qq\` 折叠组，见 \`src/index.ts\`）；
 *   2. WebUI（\`/kkk\` 的「QQ 适配器」分类，见 \`scripts/patch-webui.mjs\`）。
 * 改一处两边同步，不会出现「WebUI 有、控制台没有」。
 */
import type { Schema } from 'koishi'

import fields from './qqFields.json'

export interface QqField {
  key: string
  group: string
  type: 'boolean' | 'number' | 'string'
  default: any
  label: string
  description: string
  min?: number
  max?: number
  secret?: boolean
}

export const QQ_FIELDS = fields as QqField[]

/** 表单里 QQ 分组的字段名 */
export const QQ_KEYS = QQ_FIELDS.map((field) => field.key)

/** 缺省值表 */
export const QQ_DEFAULTS: Record<string, any> = Object.fromEntries(QQ_FIELDS.map((field) => [field.key, field.default]))

/**
 * 读当前值：优先读新的 \`config.qq.*\`，其次兼容早期写在顶层的同名字段，最后回退默认值。
 */
export function readQqOptions (config: any): Record<string, any> {
  const group = config?.qq ?? {}
  const result: Record<string, any> = {}
  for (const field of QQ_FIELDS) {
    const value = group[field.key] ?? config?.[field.key]
    result[field.key] = value === undefined || value === null ? field.default : value
  }
  return result
}

/**
 * 生成控制台表单里的 QQ 分组。
 *
 * \`Schema.intersect\` 里的分组名会被 \`apply\` 摊平回顶层（见 \`src/index.ts\`），
 * 插件内部照旧读 \`config.qqPanel\` 这种扁平字段。
 */
export function buildQqSchema (Schema: Schema): Schema<any> {
  const shape: Record<string, any> = {}
  for (const field of QQ_FIELDS) {
    const base = field.type === 'boolean'
      ? Schema.boolean()
      : field.type === 'number'
        ? Schema.number()
        : Schema.string()
    shape[field.key] = base.default(field.default).description(field.description)
  }
  return Schema.object(shape)
}
