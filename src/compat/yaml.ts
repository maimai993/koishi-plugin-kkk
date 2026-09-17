/** `node-karin/yaml` 的兼容实现：复用工作区已有的 js-yaml */
import yaml from 'js-yaml'

export const parse = (text: string) => yaml.load(text)
export const stringify = (value: any) => yaml.dump(value)
export default { parse, stringify }
