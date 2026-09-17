/**
 * 控制台表单 → 插件 config.json 的落地。
 *
 * 用户在 Koishi 控制台改的是 koishi.yml 里的 \`upstream\` 字段，插件真正读取的却是
 * \`<数据目录>/koishi-plugin-kkk/config/config.json\`（上游 Config 服务的路径）。
 * 因此 apply 阶段、**在加载上游 apps 之前**把表单里显式填过的值深合并进那个文件：
 *   - 空数组 / 空对象算没填（Koishi 会给 Schema.array()/object() 补空值）；
 *   - **与上游默认值相同的也算没填**：Schema 现在带 default()（控制台里能看到真实取值），
 *     Koishi 会把整份默认值一并填进配置对象，若照单全收，用户直接改 config.json 的内容
 *     会在下次启动时被表单里的默认值覆盖；
 *   - 数组整体覆盖（pushlist 这类结构化数据按整块替换更可预期）。
 *
 * 代价：在控制台里把某项**改回默认值**不会写回 config.json（与默认值相同 = 视为没动过）。
 * 真要强制改回去，用插件自带面板 /kkk 或直接编辑那个文件。
 */
import fs from 'node:fs'
import path from 'node:path'

import { PLUGIN_DIR_NAME, getRuntime } from './compat/runtime'

export interface MergeResult {
  /** 被改写的字段路径，形如 \`douyin.videoQuality\` */
  changed: string[]
  /** 实际写入的配置文件路径 */
  file: string
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * 把控制台里的上游配置合并进 config.json。
 * @param overrides 控制台里 \`upstream\` 字段的内容
 */
export function applyUpstreamOverrides (overrides: unknown): MergeResult {
  const runtime = getRuntime()
  const file = path.resolve(runtime.dataRoot, PLUGIN_DIR_NAME, 'config', 'config.json')
  const defaultFile = path.resolve(runtime.pluginRoot, 'config', 'default_config', 'config.json')

  /** 上游默认配置：用来把「控制台里的默认值」和「用户真的改过」区分开 */
  let defaults: Record<string, unknown> = {}
  try {
    if (fs.existsSync(defaultFile)) defaults = JSON.parse(fs.readFileSync(defaultFile, 'utf8'))
  } catch {
    defaults = {}
  }

  let current: Record<string, unknown> = {}
  try {
    if (fs.existsSync(file)) current = JSON.parse(fs.readFileSync(file, 'utf8'))
    else current = defaults
  } catch {
    current = {}
  }

  if (!isPlainObject(overrides)) return { changed: [], file }

  const changed: string[] = []
  /**
   * 「没填」的判定：undefined 之外，**空数组/空对象也算没填**。
   * 原因是 Koishi 解析配置时会给 Schema.array()/Schema.object() 补上空值，
   * 于是控制台里没碰过的 sendContent / pushlist 会以 `[]` 的形式传进来；
   * 若照单全收就会把用户在 config.json 里配好的内容清空。
   * 代价：想「清空某个列表」请用 /kkk 面板或直接改文件（已在 usage / README 说明）。
   */
  const isEmptyContainer = (value: unknown) =>
    Array.isArray(value) ? value.length === 0 : isPlainObject(value) && Object.keys(value).length === 0

  const merge = (target: Record<string, any>, source: Record<string, unknown>, baseline: Record<string, unknown>, prefix: string) => {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined || isEmptyContainer(value)) continue
      const base = isPlainObject(baseline) ? baseline[key] : undefined
      if (isPlainObject(value)) {
        if (!isPlainObject(target[key])) target[key] = {}
        merge(target[key], value, isPlainObject(base) ? base : {}, prefix + key + '.')
        continue
      }
      // 与上游默认值相同 → 控制台里没动过这一项，不写回（否则会盖掉用户手改的文件）
      if (base !== undefined && JSON.stringify(base) === JSON.stringify(value)) continue
      if (JSON.stringify(target[key]) === JSON.stringify(value)) continue
      target[key] = value
      changed.push(prefix + key)
    }
  }
  merge(current, overrides, defaults, '')

  if (changed.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(current, null, 2), 'utf8')
  }
  return { changed, file }
}

export default applyUpstreamOverrides
