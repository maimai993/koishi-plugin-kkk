import fs from 'node:fs'
import { resolve } from 'node:path'

import { logger } from 'node-karin'

import { Root } from '../../root'

export interface BuildMetadata {
  version: string
  buildTime: string
  buildTimestamp: number
  name: string
  description: string
  homepage: string
  commitHash: string
  shortCommitHash: string
}

let cachedMetadata: BuildMetadata | null = null

/**
 * 构建元数据的候选位置。
 *
 * 正常情况是 scripts/build.mjs 生成的 lib/build-metadata.json（随 lib 一起部署、也打进 npm 包）；
 * 早期版本把文件放在插件根目录，所以两个位置都看一眼。
 */
const candidatePaths = (): string[] => [
  resolve(Root.pluginPath, 'lib/build-metadata.json'),
  resolve(Root.pluginPath, 'build-metadata.json')
]

/** 读磁盘上的构建元数据；文件不存在返回 null，文件坏了只记一条日志 */
const readFromDisk = (): BuildMetadata | null => {
  for (const file of candidatePaths()) {
    try {
      if (!fs.existsSync(file)) continue
      const parsed: any = JSON.parse(fs.readFileSync(file, 'utf-8'))
      if (!parsed || typeof parsed !== 'object') continue
      return {
        version: String(parsed.version ?? ''),
        buildTime: String(parsed.buildTime ?? ''),
        buildTimestamp: Number(parsed.buildTimestamp ?? 0) || 0,
        name: String(parsed.name ?? ''),
        description: String(parsed.description ?? ''),
        homepage: String(parsed.homepage ?? ''),
        commitHash: String(parsed.commitHash ?? ''),
        shortCommitHash: String(parsed.shortCommitHash ?? '')
      }
    } catch (error) {
      logger.error('构建元数据解析失败（' + file + '）:', error)
    }
  }
  return null
}

/**
 * 兜底元数据：老安装包里没有 build-metadata.json，就用 package.json 拼一份。
 *
 * 版本号一定是准的，构建时间和 commit 留空 —— 卡片上显示「未知」也比整块信息消失要好，
 * 而且旧版本提示里的版本比较还需要 version 字段。
 */
const fromPackage = (): BuildMetadata => {
  const pkg: any = Root.pkg ?? {}
  return {
    version: String(Root.pluginVersion ?? pkg.version ?? ''),
    buildTime: '',
    buildTimestamp: 0,
    name: String(Root.pluginName ?? pkg.name ?? ''),
    description: String(pkg.description ?? ''),
    homepage: String(pkg.homepage ?? ''),
    commitHash: '',
    shortCommitHash: ''
  }
}

/**
 * 获取构建元数据。
 *
 * 一定返回对象（读不到构建产物时退回 package.json），调用方不需要再判空。
 */
export const getBuildMetadata = (): BuildMetadata => {
  if (cachedMetadata) return cachedMetadata
  cachedMetadata = readFromDisk() ?? fromPackage()
  return cachedMetadata
}

/**
 * 格式化构建时间为可读格式
 * @param isoString ISO 格式的时间字符串
 * @returns 格式化后的时间字符串，格式：2025年11月02日 17:30；无法解析时返回空串
 */
export const formatBuildTime = (isoString: string): string => {
  const date = new Date(isoString)
  if (!isoString || Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')

  return year + '年' + month + '月' + day + '日 ' + hour + ':' + minute
}
