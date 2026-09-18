/**
 * `node-karin` 的 Koishi 兼容实现（迁移核心）。
 *
 * 目标：让 packages/core/src 里的业务代码几乎原样运行 —— 只把框架 API 换成 Koishi 的实现。
 * 覆盖范围按原插件的真实调用面收敛：
 *   karin.command / task / getBot / getAllBot(ID|List) / contactGroup / sendMsg / sendMaster / on / ctx
 *   logger（见 ./logger）、segment（见 ./segment）、common.makeForward、config.master、db(KV)、render、sqlite3、root
 */
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

import { h } from 'koishi'
import type { Bot, Context, Session } from 'koishi'

import { logger } from './logger'
import { commandQueue, eventQueue, getRuntime, taskQueue, tryGetRuntime } from './runtime'
import { segment } from './segment'
import { syncUpstreamToKoishi } from './syncConfig'
import { normalizeMessageText } from './text'

/** 取当前 Koishi 上下文（移植代码访问 Koishi 服务用） */
export const getKoishiContext = (): Context => getRuntime().ctx

export const BOT_CONNECT = 'bot-connect'
export const BOT_DISCONNECT = 'bot-disconnect'
export const BOT_READY = 'bot-ready'

/** 命令处理器调用 next() 时返回的哨兵，表示继续走后续中间件 */
export const NEXT = Symbol('kkk.next')

/** Karin 的 Contact 形状 */
export interface Contact {
  /** 会话 id：群聊是群号，私聊是 private:用户号 */
  peer: string
  /** 群号 */
  guildId?: string
  /** 私聊用户号 */
  userId?: string
  isGroup?: boolean
}

export type SendMessage = any[]
export type Elements = any
export type ElementTypes = any
export type ImageElement = any
export type Package = Record<string, any>

/* ------------------------------------------------------------------ *
 * Bot 适配
 * ------------------------------------------------------------------ */

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.amr': 'audio/amr',
  '.silk': 'audio/silk',
  '.bin': 'application/octet-stream'
}

function guessMime (filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/** 仿 karin 的 AdapterType（机器人实例） */
export class KkkBot {
  constructor (public bot: Bot) {}

  get selfId (): string {
    return this.bot.selfId
  }

  get account () {
    return {
      selfId: this.bot.selfId,
      uid: this.bot.user?.id ?? this.bot.selfId,
      uin: this.bot.selfId,
      name: this.bot.user?.name ?? this.bot.selfId,
      avatar: this.bot.user?.avatar
    }
  }

  get adapter () {
    const platform = String(this.bot.platform ?? '')
    const raw: any = (this.bot as any).adapter || {}
    const cfg: any = raw.config ?? {}
    return {
      name: platform,
      protocol: platform,
      standard: platform,
      // 错误卡片模板还会读这三项，之前没给 → 卡片上显示 undefined 和一个空的「v」
      platform: String(raw.platform ?? cfg.platform ?? (platform || '未知')),
      communication: String(raw.communication ?? cfg.communication ?? cfg.protocol ?? '未知'),
      version: String(raw.version ?? cfg.version ?? ''),
      raw: this.bot.adapter
    }
  }

  get ctx () {
    return this.bot.ctx
  }

  /** 好友列表 */
  /**
   * 好友列表。
   *
   * Koishi 的 Bot 没有统一的 getFriendList，拿不到就返回空数组 ——
   * 上游用它来「找能给主人发消息的 bot」，空数组会自然走到后面的兜底逻辑（getAllBotID），
   * 所以这里**不能抛错**，否则整条推送链路会断在第一步。
   */
  async getFriendList (): Promise<any[]> {
    try {
      return await (this.bot as any).getFriendList()
    } catch (error) {
      logger.debug('getFriendList 失败: ' + String(error))
      return []
    }
  }

  /** 群信息，karin 侧字段为 groupName */
  async getGroupInfo (groupId: string): Promise<any> {
    try {
      const guild = await this.bot.getGuild(groupId)
      return { ...guild, groupId, groupName: (guild as any)?.name ?? '' }
    } catch (error) {
      logger.debug('getGroupInfo 失败: ' + String(error))
      return undefined
    }
  }

  async getGroupAvatarUrl (groupId: string): Promise<string> {
    try {
      return await (this.bot as any).getGroupAvatarUrl?.(groupId) ?? ''
    } catch {
      return ''
    }
  }

  async getAvatarUrl (userId: string): Promise<string> {
    try {
      return await (this.bot as any).getAvatarUrl?.(userId) ?? ''
    } catch {
      return ''
    }
  }

  /**
   * 合并转发。
   *
   * 上游是把内容装进「合并转发」发出去；但**部分适配器根本没有合并转发能力**
   * （例如 QQ 官方适配器 koishi-plugin-adapter-qq-crack，platform=\`qqguild\`，
   * 整个包里没有一处 forward），硬发 \`<message>\` 元素只会失败或变成一条空消息。
   * 所以这里先问适配器支不支持，不支持就**退化成直接发送这些元素**（视觉上是普通消息）。
   */
  async sendForwardMsg (contact: Contact | string, elements: any, _options?: any): Promise<{ messageId: string }> {
    const channelId = typeof contact === 'string' ? contact : contact.peer
    const payload = elements instanceof ForwardPayload ? elements : new ForwardPayload(normalizeContent(elements))

    if (supportsForward(this.bot)) {
      try {
        const ids = await this.bot.sendMessage(channelId, [h('message', ...payload.elements)] as any)
        return { messageId: ids[ids.length - 1] ?? '' }
      } catch (error) {
        logger.warn('合并转发发送失败，改为直接发送内容: ' + String((error as any)?.message ?? error))
      }
    } else {
      logger.debug('当前适配器（' + this.bot.platform + '）不支持合并转发，改为直接发送内容')
    }

    // 退化路径：整条发一次；失败再逐个元素发，尽量把内容送出去
    try {
      const ids = await this.bot.sendMessage(channelId, payload.elements as any)
      return { messageId: ids[ids.length - 1] ?? '' }
    } catch (error) {
      logger.warn('整条发送失败，改为逐个元素发送: ' + String((error as any)?.message ?? error))
      let lastId = ''
      for (const item of payload.elements) {
        const ids = await this.bot.sendMessage(channelId, [item] as any)
        lastId = ids[ids.length - 1] ?? lastId
      }
      return { messageId: lastId }
    }
  }

  /**
   * 上传群文件。
   *
   * 上游会把「文件」写成各种形式：本地路径、`file://`、`base64://xxx`（Base.ts 生成视频文件时就是这种）。
   * 之前这里只认路径，base64 串会直接抛「上传文件不存在」或者被当成 URL 交给适配器去 fetch
   * （日志表现：`QQ 消息发送失败 fetch base64://AAAAHGZ0eXBpc29t…`）。
   * 现在统一交给 `segment.file` 处理：它能吃路径 / file:// / base64:// / Buffer。
   */
  async uploadFile (contact: Contact | string, file: string | Buffer, name?: string): Promise<any> {
    const channelId = typeof contact === 'string' ? contact : contact.peer
    let element: any
    if (Buffer.isBuffer(file)) {
      element = segment.file(file, name)
    } else if (typeof file === 'string' && (file.startsWith('base64://') || file.startsWith('data:'))) {
      element = segment.file(file, name)
    } else {
      const filePath = String(file).startsWith('file://') ? String(file).slice('file://'.length) : String(file)
      if (!fs.existsSync(filePath)) throw new Error('上传文件不存在: ' + filePath)
      element = segment.file(fs.readFileSync(filePath), name ?? path.basename(filePath))
    }
    return this.bot.sendMessage(channelId, [element] as any)
  }

  /** 群成员信息，karin 侧字段：userId/nick/card/role */
  async getGroupMemberInfo (groupId: string, userId: string): Promise<any> {
    const bot: any = this.bot
    try {
      const member = await bot.getGuildMember?.(groupId, userId)
      if (!member) return undefined
      return { ...member, userId: member.user?.id ?? userId, nick: member.user?.name ?? member.nick ?? '', card: member.nick ?? '' }
    } catch (error) {
      logger.debug('getGroupMemberInfo 失败: ' + String(error))
      return undefined
    }
  }

  /** 群列表，karin 侧字段：group_id/group_name */
  async getGroupList (): Promise<any[]> {
    const bot: any = this.bot
    try {
      const list = await bot.getGuildList?.()
      return (list ?? []).map((item: any) => ({ ...item, group_id: item.id, group_name: item.name }))
    } catch (error) {
      logger.debug('getGroupList 失败: ' + String(error))
      return []
    }
  }

  /** 取消息（karin 的 bot.getMsg），结果按 karin 的 elements 形状返回 */
  async getMsg (contact: Contact | string, messageId: string): Promise<any> {
    const channelId = typeof contact === 'string' ? contact : contact.peer
    try {
      const message = await (this.bot as any).getMessage(channelId, messageId)
      if (!message) return { message_id: messageId, elements: [], raw_message: '' }
      const elements = (message.elements ?? []).map((el: any) => {
        switch (el.type) {
          case 'text': return { type: 'text', text: el.attrs?.content ?? '' }
          case 'image': return { type: 'image', file: el.attrs?.src ?? '' }
          case 'at': return { type: 'at', qq: el.attrs?.id ?? '' }
          case 'quote': return { type: 'reply', id: el.attrs?.id ?? '' }
          default: return { type: el.type, data: JSON.stringify(el.attrs ?? {}) }
        }
      })
      return { message_id: message.id ?? messageId, raw_message: message.content ?? '', elements }
    } catch (error) {
      logger.debug('getMsg 失败: ' + String(error))
      return { message_id: messageId, elements: [], raw_message: '' }
    }
  }

  /** 发送消息（karin 的 bot.sendMsg） */
  async sendMsg (contact: Contact | string, content: any, _options?: any): Promise<{ messageId: string }> {
    const channelId = typeof contact === 'string' ? contact : contact.peer
    const ids = await this.bot.sendMessage(channelId, normalizeContent(content) as any)
    return { messageId: ids[ids.length - 1] ?? '' }
  }

  /**
   * 消息表情回应（karin 的 bot.setMsgReaction）。
   * Satori 机器人没有统一接口，能调则调，不能调就静默返回 false —— 原插件只用它做「处理中/成功」提示。
   */
  async setMsgReaction (_contact: Contact | string, messageId: string, emojiId: string | number, isAdd = true): Promise<boolean> {
    const bot: any = this.bot
    const fn = bot.setMessageReaction ?? bot.setMsgReaction
    if (typeof fn !== 'function') return false
    try {
      await fn.call(bot, messageId, String(emojiId), isAdd)
      return true
    } catch {
      return false
    }
  }

  /**
   * 撤回消息。
   *
   * 必须带上频道号：QQ 适配器的 `deleteMessage(channelId, messageId)` 会在内部对
   * channelId 调 `.startsWith`，传 undefined 直接抛
   * `TypeError: Cannot read properties of undefined (reading 'startsWith')`（撤回全部失败）。
   * @param messageId 要撤回的消息 id
   * @param channelId 频道/群 id（karin 侧调用一般不带，这时用最近一次事件的频道）
   */
  async recallMsg (messageId: string, channelId?: string): Promise<any> {
    try {
      const channel = channelId || (this as any).lastChannelId || ''
      return await this.bot.deleteMessage(channel, messageId)
    } catch (error) {
      logger.debug('recallMsg 失败: ' + String(error))
      return undefined
    }
  }
}

export type AdapterType = KkkBot

/* ------------------------------------------------------------------ *
 * Message 适配
 * ------------------------------------------------------------------ */

/** 仿 karin 的 Message（事件对象） */
export class Message {
  /** 消息文本（原插件会直接改写这个字段） */
  msg: string
  selfId: string
  userId: string
  groupId: string
  isGroup: boolean
  sender: { userId: string; nick: string; role?: string }
  contact: Contact
  bot: KkkBot
  messageId: string
  /** 引用的消息 ID（karin 的 e.replyId） */
  replyId?: string
  session?: Session
  /** 原始 satori 事件载荷 */
  raw?: any

  constructor (init: Partial<Message> & { session?: Session; bot?: KkkBot | Bot }) {
    this.msg = init.msg ?? ''
    this.selfId = init.selfId ?? ''
    this.userId = init.userId ?? ''
    this.groupId = init.groupId ?? ''
    this.isGroup = init.isGroup ?? false
    this.sender = init.sender ?? { userId: this.userId, nick: '' }
    this.contact = init.contact ?? { peer: this.groupId || ('private:' + this.userId), isGroup: this.isGroup }
    this.bot = init.bot instanceof KkkBot ? init.bot : new KkkBot(init.bot as Bot)
    this.messageId = init.messageId ?? ''
    this.replyId = init.replyId ?? ''
    this.session = init.session
    this.raw = init.raw
  }

  /**
   * 由 Koishi 会话构造。
   * @param session Koishi 会话
   * @param msg 已经归一化过的消息文本（QQ 卡片链路会在匹配前先做异步还原，见 karin/module/utils/QqCardResolve.ts）；
   *            不传时退回同步归一化（还原 JSON 转义 + 提取已有链接）
   */
  static fromSession (session: Session, msg?: string): Message {
    const isGroup = !!session.guildId
    const userId = session.userId ?? ''
    return new Message({
      // QQ 分享卡片在适配器里是「带 JSON 转义的一整段文本」，这里还原转义并补上挖出来的链接，
      // 否则各平台的链接正则匹配不到（详见 compat/text.ts）
      msg: msg ?? normalizeMessageText(session.content ?? ''),
      selfId: session.selfId,
      userId,
      groupId: session.guildId ?? session.channelId ?? '',
      isGroup,
      sender: { userId, nick: session.author?.nick ?? session.username ?? '' },
      contact: {
        peer: session.channelId ?? (isGroup ? session.guildId! : 'private:' + userId),
        guildId: session.guildId ?? undefined,
        userId,
        isGroup
      },
      bot: session.bot,
      messageId: session.messageId ?? '',
      replyId: (session as any).quote?.id ?? (session as any).event?.message?.quote?.id ?? '',
      session,
      raw: session.event
    })
  }

  /**
   * 回复消息。
   *
   * **被动回复兜底**：QQ 官方 bot 的「被动回复」有硬限制（一条消息只能回几次、还有时间窗），
   * 而弹幕烧录这种操作动辄几分钟 —— 回来再 reply 就会撞
   * `[40034128] 回复消息失败，被动回复时间或者次数超过限制`，视频明明下好了却发不出去。
   * 这时自动改用**主动消息**（不带引用，直接往频道里发），失败才把原错误抛出去。
   */
  async reply (content: any, _options?: any): Promise<{ messageId: string; rawData?: any }> {
    const elements = normalizeContent(content)

    /**
     * 主动消息兜底（重点）。
     *
     * QQ 适配器在「被动回复超限」时**不一定抛异常**：它只是发不出去、返回空数组，
     * 于是 await send() 看起来是成功的 —— 视频就静默丢了。所以这里除了 catch，
     * 还要看**有没有拿到消息 ID**：没拿到就换主动消息（不带引用）重发一次。
     */
    const sendActive = async (): Promise<{ messageId: string; rawData?: any }> => {
      const activeIds = await this.bot.bot.sendMessage(this.contact.peer, elements as any)
      return { messageId: activeIds?.[activeIds.length - 1] ?? '' }
    }

    try {
      if (this.session) {
        const ids = await this.session.send(elements as any)
        const id = ids?.[ids.length - 1] ?? ''
        if (!id) {
          logger.mark('[compat] 回复没有返回消息 ID（多为被动回复超限），改用主动消息重发')
          return await sendActive()
        }
        return { messageId: id }
      }
      const ids = await this.bot.bot.sendMessage(this.contact.peer, elements as any)
      return { messageId: ids?.[ids.length - 1] ?? '' }
    } catch (error: any) {
      const text = String(error?.message ?? error)
      // 被动回复额度/时间窗超了：换成主动消息再试一次
      if (!/被动回复|40034128|timeout|次数超过/.test(text)) throw error
      // 用 mark 级别：这是「视频明明下好了却发不出去」的关键兜底，日志里要看得见
      logger.mark('[compat] 被动回复受限，改用主动消息发送: ' + text)
      return await sendActive()
    }
  }

  /** karin 的 e.bot 直接就是发送者 */
  async sendMsg (content: any) {
    return this.reply(content)
  }
}

function normalizeContent (content: any): any[] {
  if (content === undefined || content === null) return []
  return Array.isArray(content) ? content : [content]
}

/**
 * 合并转发的载荷。
 *
 * 上游 \`common.makeForward(elements, botId, botName)\` 的返回值只被 \`bot.sendForwardMsg()\` 消费，
 * 所以这里用一个带类型的对象承载「哪些元素要转发」，由 sendForwardMsg 决定真转发还是退化成直发。
 */
export class ForwardPayload {
  constructor (
    public elements: any[],
    public botId?: string,
    public botName?: string
  ) {}
}

/** karin 的 common.makeForward */
export function makeForward (elements: any, botId?: string, botName?: string): ForwardPayload {
  return new ForwardPayload(normalizeContent(elements), botId, botName)
}

/**
 * 适配器是否支持「合并转发」。
 *
 * OneBot 系（platform 为 onebot / red / chronocat…）支持 Satori 的 \`<message>\` 元素；
 * QQ 官方 API（qqguild / qq / qqbot）没有这个能力，必须退化。
 */
function supportsForward (bot: any): boolean {
  const platform = String(bot?.platform ?? '')
  if (!platform) return false
  return !/qqguild|qqbot|^qq$|official/i.test(platform)
}

/* ------------------------------------------------------------------ *
 * karin 门面
 * ------------------------------------------------------------------ */

let commandOrder = 0

export const contactGroup = (groupId: string): Contact => ({ peer: groupId, guildId: groupId, isGroup: true })
export const contactFriend = (userId: string): Contact => ({ peer: 'private:' + userId, userId, isGroup: false })

function resolveBot (selfId?: string): KkkBot | undefined {
  const runtime = tryGetRuntime()
  if (!runtime) return undefined
  const bots = runtime.ctx.bots as unknown as Bot[]
  if (!bots?.length) return undefined
  const matched = selfId ? bots.find((bot) => bot.selfId === selfId || bot.user?.id === selfId) : undefined
  return new KkkBot(matched ?? bots[0])
}

function command (reg: RegExp | string, handler: (...args: any[]) => any, options?: Record<string, any>) {
  const registration = { reg, handler, options, order: commandOrder++ }
  commandQueue.push(registration)
  return registration
}

function task (name: string, cron: string, handler: (...args: any[]) => any, options?: Record<string, any>) {
  const registration = { name, cron, handler, options }
  taskQueue.push(registration)
  return registration
}

function on (event: string, handler: (...args: any[]) => any) {
  eventQueue.push({ event, handler })
  return () => {
    const index = eventQueue.findIndex((item) => item.handler === handler)
    if (index >= 0) eventQueue.splice(index, 1)
  }
}

async function sendMsg (selfId: string, contact: Contact | string, content: any, _options?: any) {
  const bot = resolveBot(selfId)
  if (!bot) throw new Error('[kkk] 没有可用的机器人实例，无法发送消息')
  const channelId = typeof contact === 'string' ? contact : contact.peer
  const ids = await bot.bot.sendMessage(channelId, normalizeContent(content) as any)
  return { messageId: ids[ids.length - 1] ?? '', rawData: ids }
}

async function sendMaster (botId: string, master: string, content: any, _options?: any) {
  const bot = resolveBot(botId)
  if (!bot) throw new Error('[kkk] 没有可用的机器人实例，无法发送消息')
  const elements = normalizeContent(content)
  const target = bot.bot as any
  // Satori 的 Bot 有 sendPrivateMessage；个别适配器没有，退化成私聊频道 id
  const ids = typeof target.sendPrivateMessage === 'function'
    ? await target.sendPrivateMessage(master, elements)
    : await target.sendMessage('private:' + master, elements)
  return { messageId: ids?.[ids.length - 1] ?? '', rawData: ids }
}

/**
 * 等待同一会话中的下一条消息（karin 的 karin.ctx）。
 */
function waitContext (event: Message, options: { time?: number; reply?: boolean; throwOnTimeout?: boolean } = {}): Promise<Message | undefined> {
  const runtime = getRuntime()
  const timeout = options.time ?? 60 * 1000
  return new Promise((resolve, reject) => {
    let settled = false
    const dispose = runtime.ctx.on('message', (session: Session) => {
      if (settled) return
      if (session.channelId !== event.contact.peer) return
      if (event.userId && session.userId !== event.userId) return
      settled = true
      dispose()
      clearTimeout(timer)
      resolve(Message.fromSession(session))
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      dispose()
      if (options.throwOnTimeout) reject(new Error('等待用户输入超时'))
      else resolve(undefined)
    }, timeout)
  })
}

/* ------------------------------------------------------------------ *
 * KV 存储（karin 的 db.get/set/del）
 * ------------------------------------------------------------------ */

const kvCache = new Map<string, any>()
let kvLoaded = false

function kvFile () {
  return path.resolve(getRuntime().dataRoot, 'koishi-plugin-kkk', 'data', 'kv.json')
}

function loadKv () {
  if (kvLoaded) return
  kvLoaded = true
  try {
    const file = kvFile()
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      for (const [key, value] of Object.entries(data)) kvCache.set(key, value)
    }
  } catch (error) {
    logger.warn('读取 KV 存储失败: ' + String(error))
  }
}

function saveKv () {
  try {
    const file = kvFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(kvCache), null, 2))
  } catch (error) {
    logger.warn('写入 KV 存储失败: ' + String(error))
  }
}

export const db = {
  async get<T = any> (key: string): Promise<T | undefined> {
    loadKv()
    return kvCache.get(key) as T | undefined
  },
  async set (key: string, value: any) {
    loadKv()
    kvCache.set(key, value)
    saveKv()
  },
  async del (key: string) {
    loadKv()
    kvCache.delete(key)
    saveKv()
  },
  async all () {
    loadKv()
    return Object.fromEntries(kvCache)
  },
  async clear () {
    kvCache.clear()
    saveKv()
  }
}

/* ------------------------------------------------------------------ *
 * render / app / 其它零散 API
 * ------------------------------------------------------------------ */

export const render = {
  /**
   * karin 的 render.render：给 HTML 文件截图。
   * 这里走 koishi-plugin-puppeteer（可选依赖）。
   */
  async render (options: {
    name?: string
    file: string
    selector?: string
    fullPage?: boolean
    type?: string
    omitBackground?: boolean
    multiPage?: boolean | number
    pageGotoParams?: Record<string, any>
  }): Promise<string> {
    const runtime = getRuntime()
    const puppeteer: any = (runtime.ctx as any).puppeteer
    if (!puppeteer) throw new Error('[kkk] 渲染失败：未安装 koishi-plugin-puppeteer')

    const screenshotOptions: any = {
      file: options.file,
      selector: options.selector ?? '#container',
      fullPage: options.fullPage ?? false,
      omitBackground: options.omitBackground ?? true,
      type: options.type ?? 'png',
      pageGotoParams: options.pageGotoParams
    }

    /**
     * 自己开页面对 HTML 文件截图。
     *
     * 不能走 `puppeteer.render(html, options)` —— 那个 API 的第二个参数是**回调函数**，
     * 传截图配置进去会直接报 `callback is not a function`
     * （抖音弹幕条渲染就是这么挂的，日志里一堆「弹幕条渲染失败，将按纯文字处理」）。
     */
    const target = options.selector ?? '#container'
    const newPage = async (): Promise<any> => {
      if (typeof puppeteer.page === 'function') return await puppeteer.page()
      if (puppeteer.browser && typeof puppeteer.browser.newPage === 'function') return await puppeteer.browser.newPage()
      return null
    }
    const page = await newPage()
    if (!page) throw new Error('[kkk] 渲染失败：puppeteer 服务没有可用的页面')

    try {
      if (page.setViewport) await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 2 })
      await page.goto(pathToFileURL(options.file).href, {
        waitUntil: options.pageGotoParams?.waitUntil ?? 'load',
        timeout: options.pageGotoParams?.timeout ?? 15000
      })
      const handle = (await page.$(target)) ?? (await page.$('body'))
      const box = handle ? await handle.boundingBox() : null
      if (box && box.height > 900 && page.setViewport) {
        await page.setViewport({ width: Math.ceil(box.width) + 4, height: Math.ceil(box.height) + 4, deviceScaleFactor: 2 })
      }
      const buffer = await page.screenshot({
        clip: box ?? undefined,
        omitBackground: options.omitBackground ?? true,
        type: (options.type as any) ?? 'png'
      } as any)
      return buffer.toString('base64')
    } finally {
      try { await page.close() } catch { /* 忽略 */ }
    }

    if (Buffer.isBuffer(result)) return result.toString('base64')
    if (typeof result === 'string') return result.replace(/^data:image\/\w+;base64,/, '')
    if (result?.data) return String(result.data).replace(/^data:image\/\w+;base64,/, '')
    throw new Error('[kkk] 渲染失败：截图结果为空')
  }
}

export const common = {
  makeForward,
  async sleep (ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  },
  get karinVersion () {
    return karin.version
  }
}

export const config = {
  /** 主人账号列表 */
  master (): string[] {
    return getRuntime().config.masters
  },
  /** 读取任意目录下的配置文件（兼容占位） */
  json (dir?: string) {
    const runtime = getRuntime()
    const file = dir ? path.resolve(runtime.dataRoot, dir) : path.resolve(runtime.dataRoot, 'config.json')
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return undefined
    }
  }
}

/**
 * karin 的 hooks 是内置插件（更新检测等）暴露的钩子集合。
 * Koishi 侧没有对应实现，这里做成深度空实现：任何属性都是可调用的 no-op，
 * 避免移植代码在 import 阶段直接崩掉。
 */
const noopProxy: any = new Proxy(function () {}, {
  get: (_target, prop) => (prop === 'then' ? undefined : noopProxy),
  apply: () => noopProxy
})

export const hooks: any = new Proxy({}, {
  get: (_target, prop) => (prop === 'on' || prop === 'once'
    ? (event: string, handler: (...args: any[]) => any) => on(event, handler)
    : noopProxy)
})

export const watch = (_paths: any, _options: any, _handler?: any) => () => {}
export const restart = async () => {
  logger.warn('[kkk] Koishi 环境下不支持插件重启，请手动重启进程')
}
/**
 * 检查 npm 上的最新版本（对应 karin 的 checkPkgUpdate）。
 * 返回 karin 约定的三种形状：yes(有更新) / no(无更新) / error。
 * 未发布到 npm 的包（例如本地开发时的 koishi-plugin-kkk）会走到 error 分支，调用方按「无更新」处理。
 */
export const checkPkgUpdate = async (name: string, _options?: { compare?: string }) => {
  const local = readLocalVersion()
  try {
    const response = await fetch('https://registry.npmmirror.com/' + name, { signal: AbortSignal.timeout(10000) })
    if (!response.ok) return { status: 'error' as const, error: new Error('HTTP ' + response.status) }
    const meta: any = await response.json()
    const remote = meta?.['dist-tags']?.latest
    if (!remote) return { status: 'error' as const, error: new Error('响应缺少 dist-tags.latest') }
    if (remote === local) return { status: 'no' as const, local }
    return { status: 'yes' as const, local, remote }
  } catch (error) {
    return { status: 'error' as const, error: error as Error }
  }
}

/** 读取插件自身 package.json 的版本号 */
function readLocalVersion (): string {
  try {
    const file = path.resolve(getRuntime().pluginRoot, 'package.json')
    return JSON.parse(fs.readFileSync(file, 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}
export const updatePkg = async (_name: string) => {
  logger.warn('[kkk] Koishi 环境下请使用包管理器更新插件')
  return false
}
export const mkdirSync = fs.mkdirSync
export const isDocker = () => false
/**
 * 提取 CHANGELOG 中指定数量的版本记录（karin 的 \`logs\`）。
 * 上游用法：\`logs({ version, data, length })\` → 返回最近 \`length\` 个版本的 markdown 片段。
 */
export function logs (options: { version?: string; data: string; length?: number }): string {
  const { data, length, version } = options ?? ({} as any)
  if (typeof data !== 'string' || !data) return ''
  const versions = parseChangelog(data)
  const keys = Object.keys(versions)
  if (!keys.length) return ''
  let start = 0
  if (version) {
    const index = keys.findIndex((key) => compareVersion(key, version) === 0)
    if (index >= 0) start = index
  }
  const take = Math.max(1, Number(length) || 1)
  return keys.slice(start, start + take).map((key) => '## [' + key + ']\n' + versions[key]).join('\n\n')
}
/** 版本号比较（仅用于 changelog 过滤，够用即可） */
function compareVersion (a: string, b: string): number {
  const pa = String(a).replace(/^v/i, '').split('-')[0].split('.').map((item) => Number(item) || 0)
  const pb = String(b).replace(/^v/i, '').split('-')[0].split('.').map((item) => Number(item) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  }
  return 0
}

/**
 * 解析 CHANGELOG.md：\`{ '1.2.3': '该版本的正文' }\`（karin 的 parseChangelog）。
 * 标题形如 \`## [1.2.3](...) (2024-01-01)\` 或 \`## 1.2.3\`。
 */
export function parseChangelog (text: string): Record<string, string> {
  const result: Record<string, string> = {}
  if (typeof text !== 'string' || !text) return result
  const lines = text.split(/\r?\n/)
  let current: string | null = null
  let buffer: string[] = []
  const flush = () => {
    if (current) result[current] = buffer.join('\n').trim()
    buffer = []
  }
  for (const line of lines) {
    const matched = line.match(/^#{1,4}\s*\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?/)
    if (matched) {
      flush()
      current = matched[1]
      continue
    }
    if (current) buffer.push(line)
  }
  flush()
  return result
}

/**
 * 按版本区间裁剪 changelog（karin 的 range）。
 * 上游用法：\`range({ data, startVersion, endVersion, compare: 'semver' })\`，返回裁剪后的 markdown 文本。
 * 区间语义：\`startVersion < v <= endVersion\`；解析不出任何版本时原样返回。
 */
export function range (options: { data: string; startVersion?: string; endVersion?: string; compare?: string }): string {
  const { data, startVersion, endVersion } = options ?? ({} as any)
  if (typeof data !== 'string') return data
  const parsed = parseChangelog(data)
  const versions = Object.keys(parsed)
  if (!versions.length) return data

  const selected = versions.filter((version) => {
    if (startVersion && compareVersion(version, startVersion) <= 0) return false
    if (endVersion && compareVersion(version, endVersion) > 0) return false
    return true
  })
  if (!selected.length) return data
  return selected.map((version) => '## [' + version + ']\n' + parsed[version]).join('\n\n')
}
export const checkPort = async (port: number) => port
export const defineConfig = (config: any) => config
/**
 * 控制台 API 的鉴权（替代 karin 的 WebUI 会话鉴权）。
 *
 * - 插件配置里设了 \`apiToken\`：要求 \`Authorization: Bearer <token>\`（或 \`?token=\`）；
 * - 没设 token：只放行本机请求，避免把配置接口裸奔到公网。
 */
export const authMiddleware = (req: any, res: any, next: any) => {
  const expected = String(getRuntime().config.apiToken ?? '')
  const provided = String(req?.headers?.authorization ?? '').replace(/^Bearer\s+/i, '')
    || String(req?.query?.token ?? '')

  if (expected) {
    if (provided === expected) return next()
    return respond(401, res, { code: 401, message: '未授权：apiToken 不正确' })
  }

  const address = String(req?.socket?.remoteAddress ?? req?.ip ?? '')
  if (/^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(address)) return next()
  return respond(401, res, { code: 401, message: '未授权：请在插件配置中设置 apiToken' })
}

/**
 * karin 的响应助手：**第一个参数是 express 的 res**，会直接把响应写出去。
 * 例如 `createSuccessResponse(res, data, 'ok')` / `createBadRequestResponse(res, '参数错误')`。
 * 移植过来的 controllers 就是这么用的，签名必须对齐（否则请求会一直挂着不返回）。
 */
const respond = (status: number, res: any, payload: Record<string, any>) => {
  try {
    if (res && typeof res.status === 'function' && typeof res.json === 'function') {
      res.status(status).json(payload)
    } else if (res && typeof res.send === 'function') {
      res.status?.(status).send?.(payload)
    }
  } catch (error) {
    logger.debug('[kkk] 写响应失败: ' + String(error))
  }
  return payload
}

export const createSuccessResponse = (res: any, data?: any, message = 'success') =>
  respond(200, res, { code: 200, message, data })

export const createBadRequestResponse = (res: any, message = '请求参数错误') =>
  respond(400, res, { code: 400, message })

export const createNotFoundResponse = (res: any, message = '资源不存在') =>
  respond(404, res, { code: 404, message })

export const createServerErrorResponse = (res: any, message = '服务器内部错误') =>
  respond(500, res, { code: 500, message })

/* ------------------------------------------------------------------ *
 * FFmpeg / ffprobe
 *
 * 上游 karin 直接调它的 ffmpeg 封装；Koishi 兼容层原先是个**抛错的占位实现**，
 * 结果所有要拼流/改封装的解析（登录态 B站 视频要先把 m4s 修成 mp4 再和音频合成）
 * 都在第一步就炸/哑掉 —— 用户看到的就是「提示开始解析，然后没下文」。
 *
 * 这里给它一个真实现：子进程直接跑 ffmpeg / ffprobe，返回值形状保持 karin 的
 * `{ status, stdout, stderr }`（`status` 为真表示成功，kkk 里到处这么判断）。
 * 可执行文件来源优先级：karin 传入的 options.ffmpegPath → koishi-plugin-ffmpeg-path 服务
 * → 环境变量 FFMPEG_PATH/FFPROBE_PATH → PATH 里的 ffmpeg/ffprobe。
 * ------------------------------------------------------------------ */

function ffmpegRuntimeCtx (): any {
  try {
    return (tryGetRuntime() as any)?.ctx
  } catch {
    return null
  }
}

/** 由 ffmpeg 路径推出同目录的 ffprobe（找不到就交给 PATH） */
function siblingFfprobe (ffmpegPath: string): string {
  try {
    if (!ffmpegPath || ffmpegPath === 'ffmpeg') return 'ffprobe'
    const dir = path.dirname(ffmpegPath)
    const name = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
    const candidate = path.join(dir, name)
    return fs.existsSync(candidate) ? candidate : 'ffprobe'
  } catch {
    return 'ffprobe'
  }
}

function resolveFfmpegBin (options: any = {}): string {
  if (typeof options?.ffmpegPath === 'string' && options.ffmpegPath) return options.ffmpegPath
  const ctx = ffmpegRuntimeCtx()
  const servicePath = ctx?.ffmpeg?.executable ?? ctx?.ffmpeg?.path
  if (typeof servicePath === 'string' && servicePath) return servicePath
  return process.env.FFMPEG_PATH || process.env.FFMPEG_BIN || 'ffmpeg'
}

/** 把 karin 那种「一整条参数串」拆成 argv（引号内的空格要保留） */
function splitCommandArgs (input: string): string[] {
  const args: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(String(input ?? '')))) {
    args.push(match[1] ?? match[2] ?? match[3])
  }
  return args
}

interface FfmpegResult {
  status: boolean
  stdout: string
  stderr: string
  code: number | null
}

function runFfmpegBinary (bin: string, args: string[], options: any = {}): Promise<FfmpegResult> {
  return new Promise((resolve) => {
    let child: any
    try {
      child = spawn(bin, args, { windowsHide: true })
    } catch (error: any) {
      resolve({ status: false, stdout: '', stderr: String(error?.message ?? error), code: null })
      return
    }
    let stdout = ''
    let stderr = ''
    // 默认 10 分钟兜底，避免遇到损坏文件 / 网络流时永远挂着（kkk 里都是 await 调用）
    const timeout = Number(options?.timeout ?? 600000)
    const timer = timeout > 0 ? setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch { /* 忽略 */ }
    }, timeout) : null
    const done = (result: FfmpegResult) => {
      if (timer) clearTimeout(timer)
      resolve(result)
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = String(chunk)
      stdout += text
      options?.onStdout?.(text)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = String(chunk)
      stderr += text
      options?.onStderr?.(text)
    })
    child.on('error', (error: any) => {
      done({ status: false, stdout, stderr: stderr + String(error?.message ?? error), code: null })
    })
    child.on('close', (code: number | null) => {
      done({ status: code === 0, stdout, stderr, code })
    })
  })
}

export const ffmpeg = (input: string, options: any = {}): Promise<FfmpegResult> =>
  runFfmpegBinary(resolveFfmpegBin(options), splitCommandArgs(input), options)

export const ffprobe = (input: string, options: any = {}): Promise<FfmpegResult> => {
  const bin = typeof options?.ffprobePath === 'string' && options.ffprobePath
    ? options.ffprobePath
    : (process.env.FFPROBE_PATH || siblingFfprobe(resolveFfmpegBin(options)))
  return runFfmpegBinary(bin, splitCommandArgs(input), options)
}

/** 是否真的能用 ffmpeg（弹幕烧录 / 转码相关功能用它决定要不要提示「未接入」） */
export const isFfmpegAvailable = (): boolean => {
  try {
    const bin = resolveFfmpegBin()
    if (bin === 'ffmpeg') {
      // PATH 里的 ffmpeg：查一下常见位置即可，不为了探测去启动进程
      return true
    }
    return fs.existsSync(bin)
  } catch {
    return false
  }
}

/** express 应用实例（模块级懒加载，供 module/server 使用） */
let expressApp: any
export const app = new Proxy({}, {
  get (_target, prop) {
    if (!expressApp) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const express = require('express')
      expressApp = express()
    }
    return expressApp[prop]
  }
})

export const karin = {
  version: '1.16.3-koishi-compat',
  command,
  task,
  on,
  getBot: (selfId: string) => resolveBot(selfId),
  /**
   * 取所有在线 bot 的 id。
   *
   * 不能只读 `bot.selfId` —— 实测 `ctx.bots` 里混着 console / sandbox 这类
   * selfId 为 null 的实例，过滤前会得到 `[null, null]`，推送任务就永远"找不到可用 bot"。
   * 这里把几种可能的来源都兜上，并且丢掉空值。
   */
  getAllBotID: (): string[] => {
    const bots: any[] = tryGetRuntime()?.ctx.bots ?? []
    const ids = bots.map((bot) => bot?.selfId ?? bot?.user?.id ?? bot?.internal?.selfId ?? '')
    return [...new Set(ids.map((id) => String(id ?? '')).filter((id) => id && id !== 'undefined'))]
  },
  getAllBotList: () => (tryGetRuntime()?.ctx.bots ?? []).map((bot) => ({ bot: new KkkBot(bot), status: 1 })),
  contactGroup,
  contactFriend,
  sendMsg,
  sendMaster,
  ctx: waitContext,
  /** karin.template 在 Koishi 侧无对应实现 */
  template: (_name: string) => undefined,
  logger,
  segment,
  root: {}
}

export { logger, segment, syncUpstreamToKoishi }
export default karin
