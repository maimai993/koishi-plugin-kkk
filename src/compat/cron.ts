/**
 * 最小 cron 调度器（5 段：分 时 日 月 周）。
 *
 * 原插件通过 karin.task 注册定时任务，Koishi 侧没有等价 API，
 * 这里自己实现匹配，用 ctx.setInterval 每 30 秒检查一次。
 */
import type { Context } from 'koishi'

function parseField (field: string, min: number, max: number): (value: number) => boolean {
  if (field === '*' || field === '?') return () => true
  const matchers: Array<(value: number) => boolean> = []
  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/)
    if (stepMatch) {
      const step = Number(stepMatch[2])
      const [start, end] = stepMatch[1] === '*' ? [min, max] : stepMatch[1].split('-').map(Number)
      matchers.push((value) => value >= start && value <= (end ?? start) && (value - start) % step === 0)
      continue
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)$/)
    if (rangeMatch) {
      const start = Number(rangeMatch[1])
      const end = Number(rangeMatch[2])
      matchers.push((value) => value >= start && value <= end)
      continue
    }
    const num = Number(part)
    if (!Number.isNaN(num)) matchers.push((value) => value === num)
  }
  if (!matchers.length) return () => true
  return (value: number) => matchers.some((matcher) => matcher(value))
}

export function cronMatcher (expression: string) {
  const fields = expression.trim().split(/\s+/)
  if (fields.length < 5) return () => false
  const [minute, hour, day, month, week] = fields
  const matchMinute = parseField(minute, 0, 59)
  const matchHour = parseField(hour, 0, 23)
  const matchDay = parseField(day, 1, 31)
  const matchMonth = parseField(month, 1, 12)
  const matchWeek = parseField(week, 0, 6)
  return (date: Date) => matchMinute(date.getMinutes())
    && matchHour(date.getHours())
    && matchDay(date.getDate())
    && matchMonth(date.getMonth() + 1)
    && matchWeek(date.getDay())
}

export interface ScheduledTask {
  name: string
  cron: string
  handler: (...args: any[]) => any
  options?: Record<string, any>
}

export function startScheduler (ctx: Context, logger: any, tasks: ScheduledTask[]) {
  if (!tasks.length) return
  const entries = tasks.map((task) => ({ task, match: cronMatcher(task.cron), running: false, lastKey: '' }))

  for (const entry of entries) {
    logger.info('注册定时任务 %s（%s）', entry.task.name, entry.task.cron)
  }

  const tick = async () => {
    const now = new Date()
    const key = now.toISOString().slice(0, 16)
    for (const entry of entries) {
      if (entry.lastKey === key) continue
      if (!entry.match(now)) continue
      entry.lastKey = key
      if (entry.running) {
        logger.warn('任务 %s 上一轮尚未结束，跳过本次触发', entry.task.name)
        continue
      }
      entry.running = true
      Promise.resolve()
        .then(() => entry.task.handler())
        .catch((error) => logger.error('任务 %s 执行失败: %s', entry.task.name, error?.stack ?? error))
        .finally(() => { entry.running = false })
    }
  }

  ctx.setInterval(tick, 30 * 1000)
  void tick()
}
