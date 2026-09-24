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

  /**
   * 只记录一次失败、不打断当前流程。
   *
   * 给**已经有 try/catch** 的位置用（那些地方自己会兜底，只是原来选择把异常吞掉或重新抛出）：
   * 调用它就能让这次失败在最后统一报出来，又不用改括号结构。
   * @param name 步骤名
   * @param error 捕获到的错误
   */
  fail (name: string, error: unknown): void {
    this.failures.push({ name, error })
    logger.warn('[解析] 步骤「' + name + '」失败，已跳过并继续后面的步骤: ' + messageOf(error))
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

/**
 * 「谁先就绪谁先发」的发送任务组。
 *
 * ## 为什么需要它（用户要求）
 *
 * 「所有东西的发送不需要等待全部完成 —— 视频都下载好了，非要等图片渲染完才能发」。
 *
 * 解析一条作品包含几件**互不依赖**的东西：信息卡、评论区、图集、视频。
 * 以前它们是一条接一条 `await` 的，于是**最慢的那一步决定全部内容的到达时间**：
 * 视频已经躺在硬盘上了，还要等卡片渲染完才肯发出去；反过来说卡片渲完了也发不出去，
 * 因为前面在等视频下载。
 *
 * 现在把「内容」（信息卡 / 评论 / 图集）和「视频」拆成两条线**并发**跑：
 * 视频下载一完成就开始上传，不等卡片；卡片渲完就发，不等视频。
 * 两条线都结束（`settle()`）之后才轮到 {@link ParseSteps.throwIfFailed} 统一报错，
 * 所以「错误卡片永远在最后」这个约定不变。
 *
 * ## 用法
 *
 * 把原来的 `await steps.run('名字', async () => { … })` 换成 `sends.add('名字', …)`，
 * 全部登记完后 `await sends.settle()`。失败照旧记进 ParseSteps，settle 不会抛。
 *
 * ## 注意
 *
 * - **有依赖顺序的步骤别拆开**：比如「先渲染再发送」必须在同一个任务里；
 * - 浏览器渲染是**串行**的（一个浏览器同时渲好几张只会互相拖慢），
 *   拆线只对「网络/磁盘/ffmpeg」这类真正并行的阶段有意义。
 */
export class SendTasks {
  private readonly tasks: Array<Promise<unknown>> = []

  constructor (private readonly steps: ParseSteps) {}

  /** 登记一个发送任务（立刻开始跑，不阻塞调用方） */
  add (name: string, fn: () => unknown | Promise<unknown>): void {
    this.tasks.push(this.steps.run(name, fn))
  }

  /** 等所有发送任务结束。失败已经记在 steps 里，这里不会抛。 */
  async settle (): Promise<void> {
    if (!this.tasks.length) return
    await Promise.allSettled(this.tasks)
  }

  /** 登记了几个任务（日志/自检用） */
  get size (): number {
    return this.tasks.length
  }
}

export default ParseSteps