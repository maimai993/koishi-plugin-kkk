/**
 * `node-karin/root` 的兼容实现。
 *
 * 注意：karin 里 `karinPathBase` / `karinPathHtml` 是**字符串常量**（不是函数），
 * 移植代码直接写 \`\${karinPathBase}/\${Root.pluginName}/config\`，所以这里按值导出。
 * 值在模块首次 require 时确定，因此兼容层运行时必须在加载移植代码之前完成绑定。
 */
import path from 'node:path'

import { PLUGIN_DIR_NAME, tryGetRuntime } from './runtime'

/** Karin 的数据根目录 */
export const karinPathBase: string = (() => {
  const runtime = tryGetRuntime()
  if (runtime) return runtime.dataRoot
  // 兜底：允许在未绑定运行时时读取（例如工具脚本里）
  return path.resolve(process.cwd(), 'data')
})()

/** 插件私有数据目录 */
export const karinPathData: string = path.resolve(karinPathBase, PLUGIN_DIR_NAME, 'data')

/**
 * 渲染产物目录。
 * 与 Karin 一致：这里只给根目录，具体子目录由调用方拼 \`\${karinPathHtml}/\${pluginName}\`。
 */
export const karinPathHtml: string = path.resolve(karinPathBase, 'html')

/** 临时文件目录（同样只给根目录，Common.tempDri 会再拼一层插件名） */
export const karinPathTemp: string = path.resolve(karinPathBase, 'temp')

/** Karin 根目录（Koishi 下即插件根目录） */
export const karinPathRoot: string = tryGetRuntime()?.pluginRoot ?? process.cwd()

export const isDocker = () => false

export default {
  karinPathBase,
  karinPathData,
  karinPathHtml,
  karinPathTemp,
  karinPathRoot,
  isDocker
}
