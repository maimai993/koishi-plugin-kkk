/**
 * \`node-karin/lodash\` 的兼容实现。
 *
 * 上游只有一个模板用到它，且只用了 \`camelCase\` / \`upperFirst\` 两个纯函数，
 * 因此这里不引入 lodash 全量依赖，直接实现同语义的小函数（并保留 lodash 的默认导出形态）。
 */

/** lodash 的 camelCase：\`'QQ Bot' -> 'qqBot'\` */
export function camelCase (input: string): string {
  const words = String(input ?? '')
    .replace(/['\u2019]/g, '')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  return words
    .map((word, index) => {
      const lower = word.toLowerCase()
      return index === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join('')
}

/** lodash 的 upperFirst：只把首字母大写 */
export function upperFirst (input: string): string {
  const text = String(input ?? '')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const lodash = { camelCase, upperFirst }
export default lodash
