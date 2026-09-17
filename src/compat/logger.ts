/** karin `logger` 的 Koishi 兼容实现：保留 mark/彩色包装等调用习惯 */
import { format } from 'node:util'

import type { Logger } from 'koishi'

import { tryGetRuntime } from './runtime'

let koishiLogger: Logger | null = null

export function setLogger (logger: Logger) {
  koishiLogger = logger
}

function getLogger (): Logger | null {
  if (koishiLogger) return koishiLogger
  const runtime = tryGetRuntime()
  if (!runtime) return null
  koishiLogger = runtime.ctx.logger('kkk')
  return koishiLogger
}

const safeFormat = (args: any[]): string => {
  try {
    return format(...args)
  } catch {
    return args.map((item) => (typeof item === 'string' ? item : String(item))).join(' ')
  }
}

const wrap = (code: number) => (input: unknown) => `\u001b[${code}m${input}\u001b[0m`

const chalkFn: any = new Proxy(function () {}, {
  get (_target, prop: string) {
    if (prop === 'rgb') return (r: number, g: number, b: number) => (input: unknown) => `\u001b[38;2;${r};${g};${b}m${input}\u001b[0m`
    if (prop === 'hex') return (_hex: string) => (input: unknown) => String(input)
    if (prop === 'bold') return wrap(1)
    return wrap(36)
  },
  apply (_target, _this, args: any[]) {
    return String(args[0] ?? '')
  }
})

/** karin 的 logger.runContext 会捕获一段代码里产生的日志，错误处理海报要读这段日志 */
const captureStack: string[][] = []

/** Karin 的日志级别是 4 字母缩写，错误诊断海报按这个格式解析 */
const KARIN_LEVEL: Record<string, string> = {
  debug: 'DEBU',
  trace: 'TRAC',
  info: 'INFO',
  mark: 'MARK',
  warn: 'WARN',
  error: 'ERRO',
  fatal: 'FATA'
}

const stamp = () => {
  const now = new Date()
  const pad = (value: number, size = 2) => String(value).padStart(size, '0')
  return pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds()) + '.' + pad(now.getMilliseconds(), 3)
}

const emit = (level: 'debug' | 'info' | 'warn' | 'error', args: any[]) => {
  const logger = getLogger()
  const message = safeFormat(args)
  const capture = captureStack[captureStack.length - 1]
  if (capture) capture.push('[' + stamp() + '][' + (KARIN_LEVEL[level] ?? 'INFO') + '] ' + message)
  if (!logger) {
    // 兼容层未初始化时退化到 stdout，避免丢日志
    // eslint-disable-next-line no-console
    console[level === 'debug' ? 'log' : level]('[kkk] ' + message)
    return
  }
  // 插件配置里打开 debug 时，把 karin 的 debug 日志提升为 info，避免被 Koishi 默认日志级别吞掉
  const effective = level === 'debug' && tryGetRuntime()?.config?.debug ? 'info' : level
  if (effective === 'debug') {
    logger.debug(message)
    return
  }
  logger[effective](message)
}

export const logger = {
  debug: (...args: any[]) => emit('debug', args),
  trace: (...args: any[]) => emit('debug', args),
  info: (...args: any[]) => emit('info', args),
  mark: (...args: any[]) => emit('info', args),
  warn: (...args: any[]) => emit('warn', args),
  error: (...args: any[]) => emit('error', args),
  fatal: (...args: any[]) => emit('error', args),
  /**
   * 移植代码用法：`const ctx = logger.runContext(fn); await ctx.run(); ctx.logs()`
   */
  runContext: (fn: () => any) => {
    const buffer: string[] = []
    return {
      run: async () => {
        captureStack.push(buffer)
        try {
          return await fn()
        } finally {
          captureStack.pop()
        }
      },
      // Karin 的 logs() 返回字符串数组：['[12:00:00.000][INFO] xxx', ...]
      logs: (): string[] => [...buffer]
    }
  },
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  red: wrap(31),
  cyan: wrap(36),
  violet: wrap(35),
  chalk: chalkFn,
  /** karin 的 logger 支持自定义前缀创建 */
  createLogger: () => logger
}

export default logger
