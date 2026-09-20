/**
 * 兼容层运行时状态。
 *
 * 原 koishi-plugin-kkk 的代码在模块顶层就会调用 `karin.command(...)` / `karin.task(...)`，
 * 这些调用发生在 Koishi 插件 apply 之前，因此先进入队列，等 apply 时绑定 ctx 再统一落地。
 */
import path from 'node:path'

import type { Context } from 'koishi'

export interface KkkRuntimeConfig {
  /** 主人账号（对应 karin 的 config.master()） */
  masters: string[]
  /** 调试日志 */
  debug: boolean
  /** 数据目录，默认 <baseDir>/data */
  dataPath?: string
  /** 控制台 API 令牌；留空时只允许本机访问 */
  apiToken?: string
  /** QQ 平台解析前先发交互面板（Markdown + 按钮）让用户选解析内容和画质 */
  qqPanel?: boolean
  /** QQ 面板里隐藏超过该体积（MB）的画质按钮；QQ 富媒体视频硬限制为 200MB */
  qqFileLimitMB?: number
  /** 视频体积超过该值（MB）时改走群文件；0 表示关闭。QQ 默认 30 */
  qqGroupFileLimitMB?: number
  /** 解析面板里是否显示「烧录弹幕」列（默认关） */
  qqPanelDanmaku?: boolean
  /** 解析面板 / 番剧面板下方是否带「打开原站」链接（默认带） */
  qqPanelSourceLink?: boolean
  /** 强制不烧录弹幕（默认开）：优先级最高，指令 / 面板 / 平台配置都压不过它 */
  forceNoDanmaku?: boolean
}

export interface KkkRuntime {
  ctx: Context
  config: KkkRuntimeConfig
  /** 插件根目录（含 lib/、resources/） */
  pluginRoot: string
  /** 数据根目录 */
  dataRoot: string
}

let runtime: KkkRuntime | null = null

export function bindRuntime (value: KkkRuntime) {
  runtime = value
}

export function tryGetRuntime (): KkkRuntime | null {
  return runtime
}

export function getRuntime (): KkkRuntime {
  if (!runtime) throw new Error('[kkk] Karin 兼容层尚未初始化，请通过 koishi-plugin-kkk 插件加载')
  return runtime
}

/**
 * Koishi 当前配置的命令前缀。
 *
 * 用户在 koishi.yml 里可以配多个，例如 \`['/', '']\`：\`''\` 表示「不带前缀直接敲指令」。
 * 面板按钮要按这个来决定发出去的命令文本长什么样。
 * @returns 前缀列表（可能是空串）
 */
export function commandPrefixes (): string[] {
  const value = (tryGetRuntime()?.ctx as any)?.config?.prefix
  if (Array.isArray(value)) {
    const list = value.filter((item): item is string => typeof item === 'string')
    if (list.length) return list
  }
  if (typeof value === 'string') return [value]
  return ['']
}

/**
 * 拼一条「用户视角」的指令文本（用于 QQ 面板按钮）。
 * @param name 指令名，例如 \`解析\`
 * @returns 带前缀的指令（配置了空前缀时就是指令名本身）
 */
export function commandInvocation (name: string): string {
  const prefixes = commandPrefixes()
  if (prefixes.includes('')) return name
  return (prefixes.find((item) => item) ?? '') + name
}

/** 插件在数据目录下的子目录名（对应 karin 的 Root.pluginName） */
export const PLUGIN_DIR_NAME = 'koishi-plugin-kkk'

/** Karin 的数据根目录（等价 karinPathBase），移植代码按 \`\${karinPathBase}/\${pluginName}\` 组织文件 */
export function karinPathBase (): string {
  return getRuntime().dataRoot
}

/** 插件私有数据目录 */
export function pluginDataDir (): string {
  return path.resolve(karinPathBase(), PLUGIN_DIR_NAME)
}

/** 渲染产物目录 */
export function karinPathHtml (): string {
  return path.resolve(pluginDataDir(), 'html')
}

/** 临时文件目录 */
export function karinPathTemp (): string {
  return path.resolve(pluginDataDir(), 'temp')
}

export interface CommandRegistration {
  reg: RegExp | string
  handler: (...args: any[]) => any
  options?: Record<string, any>
  order: number
}

export interface TaskRegistration {
  name: string
  cron: string
  handler: (...args: any[]) => any
  options?: Record<string, any>
}

/** 模块顶层注册、等待 apply 落地的命令 */
export const commandQueue: CommandRegistration[] = []
/** 模块顶层注册、等待 apply 落地的定时任务 */
export const taskQueue: TaskRegistration[] = []
/** 模块顶层注册的事件监听 */
export const eventQueue: Array<{ event: string; handler: (...args: any[]) => any }> = []
