import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { setUnicodeEmojiSrcResolver } from '@kkk/richtext'

import { logger } from 'node-karin'

/**
 * Unicode emoji 图源：emoji-datasource-apple（Apple 64px PNG）。
 *
 * 图源不进插件发布产物——以可选依赖随 node_modules 安装，渲染时直读文件转 data: URL
 * 内联进富文本 JSON：data: 协议在 richtext 的图片来源白名单里天然放行，file:// 页面、
 * bridge http 页面、开发面板三条加载路径都能用，不依赖任何静态路由。
 *
 * 本模块被 Render/index.ts 引入即完成解析器注册；文件内容按文件名做进程级缓存。
 * 包缺失（用户没装 / --no-optional）时解析器返回 null，emoji 回退为文本渲染，不阻断启动。
 */
// 编译产物是 CJS：① 没有 import.meta（见 karin/root.ts 的同一处移植说明）；
// ② 更不能直接叫 `require` —— 顶层 `const require` 会把 CJS 的全局 require 压进 TDZ，
//    上面那几行 `require("node:fs")` 会炸「Cannot access 'require' before initialization」，
//    Node 还会因此把整个文件误判成 ESM（报错信息完全指不到这里）
const nodeRequire = createRequire(__filename)

let assetDir: string | null = null
// 与 assetDir 分开记「有没有找过」：包缺失时 assetDir 仍是 null，
// 只靠它判断会每个 emoji 重新解析一次包路径、并重复打一条 warn
let assetDirLooked = false

const getAssetDir = (): string | null => {
  if (!assetDirLooked) {
    assetDirLooked = true
    try {
      assetDir = path.join(path.dirname(nodeRequire.resolve('emoji-datasource-apple/package.json')), 'img', 'apple', '64')
    } catch (error) {
      // 包缺失时解析器保持返回 null，emoji 回退为文本渲染，不阻断启动
      logger.warn(
        `未找到 emoji-datasource-apple 包，Unicode emoji 将回退为文本渲染: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  return assetDir
}

const dataUrlCache = new Map<string, string | null>()

const resolveEmojiSrc = (filename: string): string | null => {
  if (dataUrlCache.has(filename)) {
    return dataUrlCache.get(filename) as string | null
  }

  let src: string | null = null
  const dir = getAssetDir()
  if (dir !== null) {
    try {
      const file = path.join(dir, `${filename}.png`)
      if (fs.existsSync(file)) {
        src = `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`
      }
    } catch {
      src = null
    }
  }

  dataUrlCache.set(filename, src)
  return src
}

setUnicodeEmojiSrcResolver(resolveEmojiSrc)
