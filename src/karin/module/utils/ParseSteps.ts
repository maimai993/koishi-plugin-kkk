/**
 * 解析流程的「步骤」容器：单步失败不中断整体，最后统一报错。
 *
 * 背景（用户实际体验）：解析一条视频要经过「下载视频 → 渲染信息卡 → 渲染评论区 → 发图集 → 发视频」
 * 好几步，其中渲染卡片（puppeteer）最容易出问题。以前任何一步抛错都会**直接中断**，
 * 结果是「视频明明能下，却因为一张卡片渲染失败而什么都收不到」，只剩一张错误卡片。
 *
 * 现在的约定：
 *   1. 每一步用 {@link ParseSteps.run} 包起来，失败只记日志、跳过这一步；
 *   2. 后面能做的步骤（发视频、发图集…）照常跑完；
 *   3. 全部跑完后调用 {@link ParseSteps.throwIfFailed}，把失败合成一个错误抛出去 ——
 *      此时才由 ErrorHandler 渲染**一张**错误卡片发出来。
 *
 * 也就是说：错误卡片永远出现在最后，前面能发的东西都已经发出去了。
 */
import { logger } from 'node-karin'

/** 单个失败步骤 */
export interface ParseStepFailure {
  /** 步骤名（会出现在错误卡片上，所以写用户能看懂的说法） */
  name: string
  error: unknown
}

const messageOf = (error: unknown): string => {
  if (error instanceof Error) return error.message
  return String(error)
}

export class ParseSteps {
  /** 已失败的步骤（按发生顺序） */
  readonly failures: ParseStepFailure[] = []

  /**
   * 跑一步。失败时记录并继续（返回 undefined），不向外抛。
   * @param name 步骤名
   * @param fn 这一步要做的事
   */
  async run<T> (name: string, fn: () => T | Promise<T>): Promise<T | undefined> {
    try {
      return await fn()
    } catch (error) {
      this.failures.push({ name, error })
      logger.warn('[解析] 步骤「' + name + '」失败，已跳过并继续后面的步骤: ' + messageOf(error))
      return undefined
    }
  }

  /** 有没有步骤失败过 */
  get hasFailures (): boolean {
    return this.failures.length > 0
  }

  /**
   * 全部步骤跑完后调用：有失败就合成一个错误抛出去。
   *
   * 抛出去是为了复用既有的 ErrorHandler —— 它会渲染错误卡片、按配置发给触发者/主人/管理员/指定账号，
   * 这里不重复实现一遍。堆栈保留第一个失败的，方便对照日志。
   */
  throwIfFailed (): void {
    if (!this.failures.length) return
    const first = this.failures[0]
    const names = this.failures.map((item) => item.name).join('、')
    const error = new Error('解析过程中有 ' + this.failures.length + ' 个步骤失败（' + names + '）：' + messageOf(first.error))
    const firstStack = (first.error as any)?.stack
    if (typeof firstStack === 'string') error.stack = error.message + '\n' + firstStack
    throw error
  }
}

export default ParseSteps
