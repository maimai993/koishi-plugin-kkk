import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Package } from 'node-karin'

const resolvePluginRoot = (startUrl: string) => {
  let dir = path.dirname(startUrl)
  for (let i = 0; i < 8; i++) {
    const pkgPath = path.join(dir, 'package.json')
    if (fs.existsSync(pkgPath)) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.resolve(startUrl, '../..')
}

// Koishi 移植：编译为 CJS 后没有 import.meta，改用 __filename
const pluginPath = resolvePluginRoot(__filename)
const pkg = JSON.parse(fs.readFileSync(path.join(pluginPath, 'package.json'), 'utf-8')) as Package

/**
 * 框架版本号。
 *
 * 上游 karin 用 `process.env.KARIN_VERSION`；Koishi 移植版里这个环境变量通常不存在，
 * 于是各处（错误卡片、运行环境诊断海报）都会显示成字面量 `koishi-compat`，
 * 卡片页脚看上去就是「vkoishi-compat」这种没意义的版本号。
 * 这里改成报**真实运行框架的版本**：优先环境变量，其次 Koishi 自己的版本号。
 */
const resolveFrameworkVersion = (): string => {
  if (process.env.KARIN_VERSION) return process.env.KARIN_VERSION
  const candidates = ['koishi/package.json', '@koishijs/core/package.json']
  for (const id of candidates) {
    try {
      // 编译产物是 CJS，这里的 require 能直接从插件的 node_modules 解析到宿主 koishi
      const loaded = require(id)
      const version = String(loaded?.version ?? '')
      if (version) return version
    } catch { /* 换下一个候选 */ }
  }
  // 兜底：从插件目录往上找宿主的 node_modules/koishi/package.json
  try {
    let dir = pluginPath
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, 'node_modules', 'koishi', 'package.json')
      if (fs.existsSync(candidate)) {
        const version = String(JSON.parse(fs.readFileSync(candidate, 'utf-8'))?.version ?? '')
        if (version) return version
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* 忽略 */ }
  return 'koishi-compat'
}

export const Root: {
  /** 插件名字 */
  pluginName: string
  /** 插件版本号 */
  pluginVersion: string
  /** 插件路径 */
  pluginPath: string
  /** Karin版本 */
  karinVersion: string
  /** 插件package.json */
  pkg: Package
} = {
  pluginName: pkg.name,
  pluginVersion: pkg.version,
  pluginPath,
  karinVersion: resolveFrameworkVersion(),
  pkg
}
