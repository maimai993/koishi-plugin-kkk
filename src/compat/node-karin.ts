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

// 版本比较复用注入器那边的实现（它处理了 -beta.1 这类预发布号的先后）
import { isSemverGreater } from '../karin/module/utils/semver'

import { resolveAdapterInfo } from './adapter-info'
import { logger } from './logger'
import { COLLECTED_MESSAGE_ID, collectForward } from './forward-collect'
import { imagesToMarkdown } from './imageMarkdown'
import { UnconfirmedSendError, classifySendFailure, decorateSendError, describeSendFailure, isPassiveLimitFailure } from './sendError'
import { commandQueue, eventQueue, getRuntime, karinPathBase, taskQueue, tryGetRuntime } from './runtime'
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

  /**
   * 适配器信息（卡片上那一栏）。
   *
   * 以前这里直接读 `bot.adapter.version` —— 但 Koishi 的 Adapter 实例上根本没有版本号，
   * 于是错误卡片和「#kkk版本」海报上永远是一个空的「v」。现在交给 compat/adapter-info：
   * 按 Adapter 构造函数反查适配器插件、读它的 package.json，必要时再问一次实现端版本。
   */
  get adapter () {
    return resolveAdapterInfo(this.bot)
  }

  get ctx () {
    return this.bot.ctx
  }

  /**
   * 真实适配器名（`onebot` / `qq` …）。
   *
   * 能力探测（合并转发、平台分支）读的是这个字段，而兼容层里 `e.bot` 是 KkkBot 包装、
   * 真实 Bot 在 `.bot` 上 —— 不转发出去的话，`supportsForward(e.bot)` 永远拿到空平台名，
   * 判定成「不支持合并转发」，于是**收集好的内容最后被当成普通消息直发**。
   */
  get platform (): string {
    return String((this.bot as any)?.platform ?? '')
  }

  /** 适配器自带的 internal API（合并转发、上传等）就挂在真实 Bot 上 */
  get internal (): any {
    return (this.bot as any)?.internal
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
    /**
     * 先做能力判断再调用。
     *
     * 大部分适配器（比如 qq-crack）**没有实现 getFriendList**，直接调用会抛
     * `TypeError: this.bot.getFriendList is not a function`；上游拿它来「找能给主人发消息的 bot」，
     * 一轮推送会调好几次，日志里就刷成一片。这里没有这个方法就安静地返回空数组
     * （空数组本来就会走到后面的 getAllBotID 兜底）。
     */
    const fn = (this.bot as any)?.getFriendList
    if (typeof fn !== 'function') return []
    try {
      const list = await fn.call(this.bot)
      return Array.isArray(list) ? list : []
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
   * ## 走的是适配器自己的「合并转发 API」
   * OneBot（koishi-plugin-adapter-onebot）那条链路是这样的：
   *   `h('message', { forward: true }, …)`
   *     → 适配器解析到 **`forward` 属性**（lib/index.js:918-925）就进入 forward 状态，
   *       把 children 收成**一个 node**；`<author>` 子元素（:903-904）决定这个 node 的
   *       `uin` / `name`（:774-779）；
   *     → 最后调用 `this.bot.internal.sendGroupForwardMsg(channelId, nodes)`
   *       / `sendPrivateForwardMsg(userId, nodes)`（:734-738）—— 也就是 OneBot 的
   *       `send_group_forward_msg` / `send_private_forward_msg`。
   * **少了 `forward` 属性，OneBot 只会把这些元素当成普通消息内容**（静默变成一条怪消息），
   * 这正是「合并转发没生效」的原因，所以这里必须带上它。
   *
   * 其它适配器：支持能力按平台判断；**完全不支持合并转发的**（例如 QQ 官方适配器
   * koishi-plugin-adapter-qq-crack，包里没有任何 forward 相关代码）退化成直接发送这些元素。
   */
  async sendForwardMsg (contact: Contact | string, elements: any, _options?: any): Promise<{ messageId: string }> {
    const channelId = typeof contact === 'string' ? contact : contact.peer
    const payload = elements instanceof ForwardPayload ? elements : new ForwardPayload(normalizeContent(elements))

    /** 解析结果合并转发：已经在收集了就并进去，别再套一层转发 */
    if (collectForward(channelId, payload.elements)) return { messageId: COLLECTED_MESSAGE_ID }

    if (supportsForward(this.bot)) {
      try {
        /**
         * `forward: true` 是 OneBot 适配器识别「这条要发合并转发」的开关（见上面的说明）。
         * `<author>` 决定这条转发显示成谁发的：
         *   - 通用里「伪造合并转发消息」开着 → 调用方传进来的是**触发者**的 id / 昵称；
         *   - 关着 → 传的是机器人自己的 id / 昵称。
         * 没给 id / 昵称就不带这个元素，适配器会回落到机器人身份。
         */
        const author = (payload.botId || payload.botName)
          ? [h('author', { id: payload.botId, name: payload.botName })]
          : []
        /**
         * **每条内容一个节点（node），不能全塞进同一个节点里。**
         *
         * 用户实测反馈：「合并转发不要把评论区卡片、信息卡片、视频弄成一条信息啊，
         * 不然只有视频可以加载」—— 一个 node 里塞 卡片图 + 评论图 + 视频 时，
         * QQ 的聊天记录只把视频渲染出来了，图片全都不显示。
         *
         * 适配器（koishi-plugin-adapter-onebot lib/index.js:918-932）对**嵌套的普通 \`<message>\`**
         * 就是「一个聊天记录条目」：每遇到一个就 \`flush()\` 一次，把当前 children 收成一个 node
         * （flush 的 forward 分支把 node 推进上一层，见 :763-781）。所以这里给每个元素包一层
         * \`<message>\`，一条转发里就有 N 个条目，各自独立加载。
         */
        /**
         * **一次发送 = 一个聊天记录条目**：
         *   - 信息卡、评论区、视频 各自是独立的一次 \`reply()\` → 各自一个条目
         *     （不再挤在同一个节点里，那会导致 QQ 只加载视频）；
         *   - 卡片切片是**一次** \`reply([...])\` → 留在**同一个**条目里（用户要求：切片还是一条信息内）。
         *
         * 分组来自收集器（\`drainForwardGroups\`）；没有分组信息时退化成「一个元素一个条目」。
         */
        const groups = (payload.groups?.length ? payload.groups : payload.elements.map((element) => [element]))
          .filter((group) => Array.isArray(group) && group.length)
        const nodes = groups.map((group) => h('message', {}, ...group))
        const ids = await this.bot.sendMessage(channelId, [h('message', { forward: true }, ...author, ...nodes)] as any)
        logger.debug('[合并转发] 已提交 ' + nodes.length + ' 个聊天记录条目')
        return { messageId: ids[ids.length - 1] ?? '' }
      } catch (error) {
        logger.warn('合并转发发送失败，改为直接发送内容: ' + String((error as any)?.message ?? error))
      }
    } else {
      logger.debug('当前适配器（' + this.bot.platform + '）不支持合并转发，改为直接发送内容')
    }

    // 退化路径：整条发一次；失败再逐个元素发，尽量把内容送出去
    /** 退化发送 = 直接发消息，所以图片同样要改走 markdown（见 compat/imageMarkdown） */
    const fallback = await imagesToMarkdown(payload.elements, platformOfBot(this.bot))
    try {
      const ids = await this.bot.sendMessage(channelId, fallback as any)
      return { messageId: ids[ids.length - 1] ?? '' }
    } catch (error) {
      logger.warn('整条发送失败，改为逐个元素发送: ' + String((error as any)?.message ?? error))
      let lastId = ''
      for (const item of fallback) {
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
    /** 解析结果合并转发：文件（视频/群文件）也要进转发 */
    if (collectForward(channelId, [element])) return { messageId: COLLECTED_MESSAGE_ID, rawData: undefined }
    const ids = await this.bot.sendMessage(channelId, [element] as any)
    /**
     * 和 {@link reply} 同一个判据：**没拿到消息 ID 就是没发出去**。
     *
     * 文件/视频走的是「上传媒体 + 发一条带 media 的消息」，最后那条消息同样会返回 id；
     * 没有 id 说明它没发成功（qq-chat 也是这么判的）。以前这里把空 ID 当成功返回，
     * 结果「视频没发出去」被静默吞掉 —— Base.ts 那边看到没有异常就当发送成功了。
     */
    const id = ids?.[ids.length - 1] ?? ''
    if (!id) {
      logger.mark('[compat] 文件上传后没有拿到消息 ID：适配器没抛异常，但这个文件没有发出去')
      throw new UnconfirmedSendError()
    }
    return { messageId: id, rawData: ids }
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
    const elements = normalizeContent(content)
    /** 解析结果合并转发：正在收集就攒起来（见 compat/forward-collect） */
    if (collectForward(peerOf(contact), elements)) return { messageId: COLLECTED_MESSAGE_ID }
    const channelId = typeof contact === 'string' ? contact : contact.peer
    /** 图片统一改走 markdown（见 compat/imageMarkdown） */
    const outgoing = await imagesToMarkdown(elements, platformOfBot(this.bot))
    const ids = await this.bot.sendMessage(channelId, outgoing as any)
    // 同 reply/uploadFile：**没拿到消息 ID 就是没发出去**，别当成功返回
    const id = ids?.[ids.length - 1] ?? ''
    if (!id) {
      logger.mark('[compat] 主动发送后没有拿到消息 ID：适配器没抛异常，但这条消息没有发出去')
      throw new UnconfirmedSendError()
    }
    return { messageId: id }
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
    const raw = normalizeContent(content)

    /**
     * 解析结果合并转发：正在收集就攒起来，等解析结束发一条转发（见 compat/forward-collect）。
     * 回一个假的消息 ID：调用方普遍只看「有没有拿到 ID」（例如 uploadFile 判断发送成没成功）。
     */
    if (collectForward(this.contact?.peer ?? '', raw)) return { messageId: COLLECTED_MESSAGE_ID }

    /**
     * **图片统一改走 markdown**（上传拿公网地址 + 写死 `#宽px #高px`），见 compat/imageMarkdown。
     *
     * 放在这里是因为它是**所有回复的唯一出口** —— 业务代码一律 `e.reply(...)`，
     * 不用一处处改业务代码。转换不成功会退回原来的图片段（绝不把图弄丢）。
     * 上面的合并转发分支已经返回了，所以转发节点里仍然是普通图片段。
     */
    const elements = await imagesToMarkdown(raw, platformOfMessage(this))

    /**
     * 没拿到消息 ID 就是**没发出去**（对齐 qq-chat 的判法）。
     *
     * QQ 适配器只有在拿到 `resp.id` 时才会把消息塞进 satori 的 `results`；
     * 没拿到 ID 又没有异常，说明这条消息没有被确认发出 —— qq-chat 的注释写得很直白：
     * 「适配器没抛异常但也没给消息 id：QQ 那边其实没发出去」。
     * 以前这里把「没 ID」当成成功，等于把发失败的消息静默吞掉，调用方还以为已经送达。
     */
    const requireId = (ids: string[] | undefined): string => {
      const id = ids?.[ids.length - 1] ?? ''
      if (!id) {
        /**
         * 走到这里说明**适配器没有报错、但也没有返回消息 ID** —— 消息没有被确认发出。
         * （真正发失败会带错误码抛上来，见下面为什么要绕开 `session.send`。）
         */
        logger.mark('[compat] 发送后没有拿到消息 ID：这条消息没有发出去（适配器没报错，多半是被 before-send 拦下或进了审核）')
        throw new UnconfirmedSendError()
      }
      return id
    }

    /**
     * **不要用 `session.send()`** —— 它会吞掉异常，我们就拿不到错误码了。
     *
     * Koishi 自己的 `Session.send`（`@koishijs/core/lib/index.cjs:1841`）是这么写的：
     *
     *     return this.bot.sendMessage(...).catch((error) => {
     *       logger3.warn(error)      // 日志里那行「[W] session Error: QQ 消息发送失败 [40093011] …」
     *       return []                // 然后**吞掉异常**，返回空数组
     *     })
     *
     * 于是适配器抛出的错误码（例如 `[40093011] 上传文件大小超过限制`）到不了调用方，
     * 我们只能看到一个空数组 —— 这正是之前「只知道没发出去、不知道为什么」的原因。
     * qq-chat 也是直接调 `bot.sendMessage(...)`（见它的 `api-handlers.ts`），错误才看得见。
     *
     * 这里自己拼一次同样的调用：带上 `referrer` 和 `options.session`（适配器要靠 session
     * 取被动回复的 `msg_id` / `event_id`），但**不 catch** —— 让错误原样抛给判错逻辑。
     */
    const sendThroughSession = async (): Promise<string[] | undefined> => {
      const session: any = this.session
      if (!session) return undefined
      if (!elements.length) return []
      return await session.bot.sendMessage(
        session.channelId,
        elements as any,
        session.event?.referrer,
        { session }
      )
    }

    /**
     * 主动消息兜底（只在**拿到错误码**时触发）。
     *
     * `[40034128] 回复消息失败，被动回复时间或者次数超过限制` 时，换主动消息通道（不带引用）
     * 再发一次。判据是**错误码**，不是「有没有消息 ID」—— 「没 ID」只说明没发出去，
     * 说不出原因；被禁言、无主动消息权限这类换通道也一样发不出去（见 compat/sendError 的码表）。
     */
    const sendActive = async (): Promise<{ messageId: string; rawData?: any }> => {
      const activeIds = await this.bot.bot.sendMessage(this.contact.peer, elements as any)
      return { messageId: requireId(activeIds) }
    }

    try {
      if (this.session) {
        // 空内容不算失败：没有东西要发
        if (!elements.length) return { messageId: '' }
        return { messageId: requireId(await sendThroughSession()) }
      }
      return { messageId: requireId(await this.bot.bot.sendMessage(this.contact.peer, elements as any)) }
    } catch (error: any) {
      const failure = classifySendFailure(error)
      // 只有「被动回复额度/时间窗超了」才值得换通道重发；体积超限、被禁言、无权限这类
      // 换通道也一样失败，直接抛给调用方（它拿到错误码会去切片 / 降级 / 报错）
      // 空 message 的异常（qq-chat 编码器那种）在这里补一段可读说明，别让错误卡片上一片空白
      if (!isPassiveLimitFailure(failure)) throw decorateSendError(error, failure)
      // 用 mark 级别：这是「视频明明下好了却发不出去」的关键兜底，日志里要看得见
      logger.mark('[compat] 被动回复受限，改用主动消息发送: ' + describeSendFailure(failure))
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

/** 取出一个 contact 对应的频道 id（字符串直接当 id） */
function peerOf (contact: Contact | string): string {
  return typeof contact === 'string' ? contact : String((contact as Contact)?.peer ?? '')
}

/**
 * 适配器平台名。
 *
 * 发送出口要用它判断「这个平台认不认 markdown 图片」（见 compat/imageMarkdown）：
 * KkkBot 包装上直接转发真实 Bot 的 platform，传 KkkBot 或裸 Bot 都能取到。
 */
function platformOfBot (bot: any): string {
  return String(bot?.platform ?? bot?.bot?.platform ?? '')
}

/** 同上，从消息事件取（会话上就带 platform，拿不到再问 bot） */
function platformOfMessage (message: Message): string {
  return String(message.session?.platform ?? platformOfBot(message.bot))
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
    public botName?: string,
    /**
     * 可选：按「每次发送」分好组的元素（一次 \`reply()\` 一组）。
     * 给了就**一组一个聊天记录条目**（切片留在同一条里），没给就一个元素一个条目。
     */
    public groups?: any[][]
  ) {}
}

/** karin 的 common.makeForward（第 4 个参数是扩展：按发送分组，见 ForwardPayload.groups） */
export function makeForward (elements: any, botId?: string, botName?: string, groups?: any[][]): ForwardPayload {
  return new ForwardPayload(normalizeContent(elements), botId, botName, groups)
}

/**
 * 适配器是否支持「合并转发」。
 *
 * OneBot 系（platform 为 onebot / red / chronocat…）支持 Satori 的 \`<message>\` 元素；
 * QQ 官方 API（qqguild / qq / qqbot）没有这个能力，必须退化。
 */
/**
 * 这台适配器能不能发合并转发（导出给「解析结果合并转发」用：不支持就保持逐条发送的老样子）。
 * @param bot Koishi 的 Bot（或任何带 platform 的对象）
 */
export function isForwardSupported (bot: any): boolean {
  return supportsForward(bot)
}

function supportsForward (bot: any): boolean {
  /**
   * 兼容层里有两种 bot：**KkkBot 包装**（真实 Bot 在 `.bot` 上）和**裸 Bot**。
   * 这里统一解包，免得调用方传错一层就静默退化成「逐条直发」。
   */
  const target: any = bot?.bot ?? bot
  /**
   * ① 适配器自己就带合并转发 API 的：直接认（OneBot 系的 internal.*ForwardMsg）。
   *    这条优先，因为不依赖平台名怎么写。
   */
  const internal: any = target?.internal ?? bot?.internal
  if (internal && (typeof internal.sendGroupForwardMsg === 'function' || typeof internal.sendPrivateForwardMsg === 'function')) return true
  /**
   * ② 其余按平台判断：OneBot / red / chronocat 这些 Satori 适配器认识 `h('message')`；
   *    QQ 官方适配器（qqguild / qqbot / qq / official）没有任何 forward 能力，必须退化。
   */
  const platform = String(target?.platform ?? bot?.platform ?? '')
  if (!platform) return false
  return !/qqguild|qqbot|^qq$|official/i.test(platform)
}

/* ------------------------------------------------------------------ *
 * karin 门面
 * ------------------------------------------------------------------ */

let commandOrder = 0

export const contactGroup = (groupId: string): Contact => ({ peer: groupId, guildId: groupId, isGroup: true })
export const contactFriend = (userId: string): Contact => ({ peer: 'private:' + userId, userId, isGroup: false })

/**
 * 这个机器人现在能不能发消息。
 *
 * 线上真实报错（B站推送）：
 *
 *     TypeError: this._request is not a function
 *         at _Internal._get (adapter-onebot/lib/index.js:115)
 *         at ... sendGroupMsg ...
 *         at async Object.sendMsg (koishi-plugin-kkk/lib/compat/node-karin.js:684)
 *
 * 适配器**掉线后 bot 对象仍然留在 ctx.bots 里**，但底层连接（OneBot 的 _request）已经没了，
 * 于是 sendMessage 一路传到适配器内部才炸成一句莫名其妙的英文。
 * 这里提前认出来，给一句人话（用户要求：日志和错误卡片要能看懂）。
 *
 * Koishi 的 Bot.status：0 离线 / 1 在线 / 2 连接中 / 3 断开 / 4 重连。
 */
function isBotOnline (bot: any): boolean {
  const status = bot?.status
  // 没有 status 字段的（老适配器 / 测试桩）不拦，免得把好机器人也挡住
  if (typeof status !== 'number') return true
  return status === 1 || status === 2
}

function resolveBot (selfId?: string): KkkBot | undefined {
  const runtime = tryGetRuntime()
  if (!runtime) return undefined
  const bots = runtime.ctx.bots as unknown as Bot[]
  if (!bots?.length) return undefined
  const matched = selfId ? bots.find((bot) => bot.selfId === selfId || bot.user?.id === selfId) : undefined
  // 指定了 selfId：就算它掉线也返回它 —— 不能偷偷换一个机器人发，那样会串号（调用方会报「不在线」）
  if (matched) return new KkkBot(matched)
  // 没指定：优先挑在线的
  const online = bots.find((bot) => isBotOnline(bot))
  return online ? new KkkBot(online) : (bots[0] ? new KkkBot(bots[0]) : undefined)
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
  const rawBot: any = (bot as any).bot
  if (!isBotOnline(rawBot)) {
    throw new Error('[kkk] 机器人 ' + String(selfId || rawBot?.selfId || '') + ' 当前不在线（status=' + String(rawBot?.status)
      + '），这条消息发不出去。等它重新上线后下次推送会正常发出；如果是长期不在线，检查一下适配器连接')
  }
  const channelId = peerOf(contact)
  const elements = normalizeContent(content)
  /** 解析结果合并转发：这条也走漏斗（karin.sendMsg 是业务代码另一条常用出口） */
  if (collectForward(channelId, elements)) {
    return { messageId: COLLECTED_MESSAGE_ID, rawData: [] }
  }
  /** 图片统一改走 markdown（见 compat/imageMarkdown） */
  const outgoing = await imagesToMarkdown(elements, platformOfBot(bot.bot))
  const ids = await bot.bot.sendMessage(channelId, outgoing as any)
  return { messageId: ids[ids.length - 1] ?? '', rawData: ids }
}

async function sendMaster (botId: string, master: string, content: any, _options?: any) {
  const bot = resolveBot(botId)
  if (!bot) throw new Error('[kkk] 没有可用的机器人实例，无法发送消息')
  // 图片统一改走 markdown（见 compat/imageMarkdown）：私聊和群里一样，md 图片才不会被压糊
  const elements = await imagesToMarkdown(normalizeContent(content), platformOfBot(bot.bot))
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
   *
   * **只用浏览器渲染服务**（koishi-plugin-puppeteer / puppeteer-without-canvas 之类）。
   * 3.5.0 起不再支持 shotkit 内核：它在 Windows 上加载不了 https 资源，卡片里的远程封面、
   * 头像一律是空白框 —— 用户看到的是「卡片坏了」，快那一点不值得。
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
    /**
     * 渲染只走浏览器这一条路（3.5.0 起不再支持 shotkit 内核，见 Render/index.ts 的说明）。
     * 以前这里会按配置项 app.renderer 在「内核 / 浏览器」之间挑一个，现在没得挑了。
     */
    if (!puppeteer) throw new Error('[kkk] 渲染失败：没有可用的浏览器渲染服务（需要 koishi-plugin-puppeteer 或同类插件）')

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
    const tags: Record<string, string> = meta?.['dist-tags'] ?? {}
    /**
     * 预览版（3.3.0-beta.1 这种）**不能拿 latest 比**：本地跑 beta 时 latest 还在 3.2.2，
     * 按老逻辑会报「有新版本 3.2.2」—— 那其实是**降级**。
     * 所以带 - 的本地版本改看 beta 通道；beta 没有（说明预览已经并进正式版）才回退到 latest，
     * 并且只在远端确实比本地新时才说「有更新」。
     */
    const isPreview = local.includes('-')
    const remote = (isPreview ? (tags.beta || tags.latest) : tags.latest) || ''
    if (!remote) return { status: 'error' as const, error: new Error('响应缺少 dist-tags.latest') }
    if (remote === local) return { status: 'no' as const, local }
    if (isPreview && !isSemverGreater(remote, local)) return { status: 'no' as const, local }
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
 *
 * ## 可执行文件从哪来（每一份都要**校验通过**才会被用）
 *
 * 线上事故：koishi-plugin-ffmpeg-path 自动下载的 ffmpeg 给出来的是**相对路径**
 * （`./downloads/ffmpeg-linux-amd64-xxxx/ffmpeg`），兼容层原样拿去 spawn →
 * `spawn … EACCES`，B站 m4s 修复失败、整条解析跟着失败，用户还没法自救。
 * 所以现在按下述顺序挑，并且**每一份都先归一化成绝对路径 + 校验存在与可执行**：
 *   1. **Koishi 的 ffmpeg 服务**（`ctx.ffmpeg`，本部署由 koishi-plugin-ffmpeg-path 提供）
 *      —— 优先用它的 `executable`；给的是相对路径就按 karinPathBase / 进程工作目录归一化；
 *      校验不过就跳过并打日志，同时提示去该插件配置里指定绝对路径或关掉自动下载；
 *   2. karin 传进来的 `options.ffmpegPath`（上游有调用点会带）；
 *   3. 环境变量 `FFMPEG_PATH` / `FFMPEG_BIN`（ffprobe 是 `FFPROBE_PATH`）；
 *   4. PATH 里的 `ffmpeg` / `ffprobe`（最终兜底）。
 *
 * spawn 阶段报错（EACCES / ENOENT / EINVAL / UNKNOWN…也就是「文件在但起不来」）时
 * **自动换下一个候选重试**；所有候选都起不来时，stderr 里会附上「都试过哪些」，
 * 免得用户只看到一句「m4s 文件修复失败」却无从下手。
 *
 * 另外：本插件**不下载** ffmpeg（仓库里没有任何下载逻辑）；自动下载是 koishi-plugin-ffmpeg-path
 * 自己的事（它的 `autoDownload` 默认开着）。我们要做的只是**别盲目相信它给的路径**。
 * ------------------------------------------------------------------ */

function ffmpegRuntimeCtx (): any {
  try {
    return (tryGetRuntime() as any)?.ctx
  } catch {
    return null
  }
}

/** 相对路径归一化时依次尝试的根目录：karin 数据目录 → 进程工作目录 */
export function ffmpegResolveRoots (): string[] {
  const roots: string[] = []
  try {
    roots.push(karinPathBase())
  } catch { /* 运行时还没绑定：只用进程工作目录 */ }
  try {
    roots.push(process.cwd())
  } catch { /* 忽略 */ }
  return roots.filter((root, index) => !!root && roots.indexOf(root) === index)
}

/**
 * 这个文件现在能不能被执行。
 *
 * Windows 没有 X_OK 的概念（任何存在的文件都能「通过」），所以那边看**可执行扩展名**；
 * Linux / macOS 老老实实查 `X_OK`（下载下来的 ffmpeg 常见问题就是没有 +x）。
 */
export function canExecuteFile (file: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (!fs.existsSync(file)) return false
    if (platform === 'win32') return /\.(exe|cmd|bat|com)$/i.test(file)
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 在 PATH 里找一个可执行文件（找不到返回空串）；Windows 会把 .exe/.cmd/.bat/.com 都试一遍 */
export function findExecutableInPath (name: string, platform: NodeJS.Platform = process.platform): string {
  const dirs = String(process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean)
  const extensions = platform === 'win32' ? ['', '.exe', '.cmd', '.bat', '.com'] : ['']
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension)
      if (canExecuteFile(candidate, platform)) return candidate
    }
  }
  return ''
}

/** 校验候选时可注入的依赖（冒烟测试要能构造「不存在 / 不可执行」这些场景） */
export interface FfmpegCheckDeps {
  platform?: NodeJS.Platform
  exists?: (file: string) => boolean
  canExecute?: (file: string, platform: NodeJS.Platform) => boolean
  roots?: () => string[]
  isDirectory?: (file: string) => boolean
  findInPath?: (name: string, platform: NodeJS.Platform) => string
}

/** 一份候选的校验结果 */
export interface FfmpegCheckResult {
  ok: boolean
  /** 通过校验时：可以直接 spawn 的绝对路径（PATH 兜底那边同样是绝对路径） */
  bin: string
  /** 没通过的原因（日志与冒烟测试都读它） */
  reason?: string
}

/**
 * 校验一份候选可执行文件。
 *
 *   - 相对路径：按 karinPathBase → 进程工作目录**逐个归一化**成绝对路径，谁存在用谁；
 *   - 必须存在；Linux / macOS 还要有执行权限（Windows 看可执行扩展名）；
 *   - 传进来的是目录：当成「ffmpeg 所在目录」，自动补上平台对应的文件名；
 *   - 不带路径分隔符的裸名字（`ffmpeg`）：去 PATH 里找，找到就给绝对路径，找不到算这个候选不可用。
 * @param raw 原始值（可能是相对路径 / 绝对路径 / 目录 / PATH 里的名字）
 * @param from 来源说明，日志里用
 */
export function checkFfmpegCandidate (raw: string, from: string, deps: FfmpegCheckDeps = {}): FfmpegCheckResult {
  const platform = deps.platform ?? process.platform
  const exists = deps.exists ?? fs.existsSync
  const isDirectory = deps.isDirectory ?? ((file: string) => {
    try {
      return fs.statSync(file).isDirectory()
    } catch {
      return false
    }
  })
  const executable = deps.canExecute ?? canExecuteFile
  const inPath = deps.findInPath ?? findExecutableInPath
  const text = String(raw ?? '').trim()
  if (!text) return { ok: false, bin: '', reason: from + '：值为空' }

  /** 裸名字：交给 PATH 解析（spawn 也是这么找的），找不到就直接判不可用 */
  if (!/[/\\]/.test(text)) {
    const hit = inPath(text, platform)
    return hit
      ? { ok: true, bin: hit }
      : { ok: false, bin: '', reason: 'PATH 里找不到 ' + text }
  }

  const tried: string[] = []
  const reasons: string[] = []
  const roots = deps.roots ?? ffmpegResolveRoots
  const targets = path.isAbsolute(text) ? [text] : roots().map((root) => path.resolve(root, text))
  for (const target of targets) {
    tried.push(target)
    if (!exists(target)) continue
    /** 目录：补上平台对应的文件名（有人会把「ffmpeg 所在目录」填进来） */
    const file = isDirectory(target) ? path.join(target, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : target
    if (!exists(file)) {
      reasons.push('目录里没有 ' + path.basename(file) + '：' + file)
      continue
    }
    if (!executable(file, platform)) {
      /**
       * 这句要能直接照做：线上那份自动下载的 ffmpeg 最常见的毛病就是没有 +x
       * （报错是 `spawn ./downloads/…/ffmpeg EACCES`，看着像「文件不存在」，其实是权限）。
       */
      reasons.push(platform === 'win32'
        ? '不是可执行文件（Windows 需要 .exe/.cmd/.bat/.com）: ' + file
        : '没有执行权限，可在服务器上执行 “chmod +x ' + file + '”（我们每次都会重新校验，改完直接重新解析一次即可）: ' + file)
      continue
    }
    return { ok: true, bin: file }
  }
  return {
    ok: false,
    bin: '',
    reason: reasons.length ? reasons.join('；') : '文件不存在: ' + tried.join(' / '),
  }
}

interface FfmpegSource {
  /** 来源说明（日志里显示「跳过 <来源>」，也用来判断要不要提示 ffmpeg-path 配置） */
  from: string
  /** 原始值 */
  raw: string
}

/** 已经跳过过的候选：同一条只打一次日志，别把日志刷爆 */
const ffmpegSkipped = new Set<string>()
/** 当前选中的可执行文件（来源或文件变了才打日志，别刷屏） */
const ffmpegChosen = new Map<string, string>()

function logFfmpegSkip (kind: 'ffmpeg' | 'ffprobe', source: FfmpegSource, reason: string): void {
  const key = kind + '|' + source.from + '|' + source.raw + '|' + reason
  if (ffmpegSkipped.has(key)) return
  ffmpegSkipped.add(key)
  logger.warn('[ffmpeg] 跳过' + source.from + '（' + source.raw + '）：' + reason)
  /** 自动下载下来的那份最常见的毛病就是相对路径 / 没有执行权限，顺手给一句能照做的提示 */
  if (/[/\\]downloads[/\\]|ffmpeg-path|ffmpeg-linux|ffmpeg-win32|ffmpeg-darwin/i.test(source.raw)) {
    logger.warn('[ffmpeg] 这个路径像是 ffmpeg-path 自动下载/缓存下来的：'
      + '要么到「koishi-plugin-ffmpeg-path」配置里把 path 指到系统 ffmpeg 的绝对路径，'
      + '要么关掉它的 autoDownload、改用 PATH 里的 ffmpeg（本插件会自动接着往下找）')
  }
}

function logFfmpegChosen (kind: 'ffmpeg' | 'ffprobe', from: string, bin: string): void {
  const key = kind + '|' + from + '|' + bin
  if (ffmpegChosen.get(kind) === key) return
  ffmpegChosen.set(kind, key)
  logger.info('[ffmpeg] 使用' + from + '：' + bin)
}

/** 按优先级列出 ffmpeg 的候选（还没校验） */
function ffmpegSources (options: any = {}): FfmpegSource[] {
  const sources: FfmpegSource[] = []
  const ctx = ffmpegRuntimeCtx()
  /** 1. Koishi 的 ffmpeg 服务（koishi-plugin-ffmpeg-path 这类插件提供） */
  const service = ctx?.ffmpeg
  const servicePath = typeof service?.executable === 'string' && service.executable
    ? service.executable
    : (typeof service?.path === 'string' ? service.path : '')
  if (servicePath) sources.push({ from: 'Koishi 的 ffmpeg 服务（ctx.ffmpeg）', raw: servicePath })
  /** 2. karin 传进来的 options.ffmpegPath */
  if (typeof options?.ffmpegPath === 'string' && options.ffmpegPath) {
    sources.push({ from: 'ffmpegPath 参数', raw: options.ffmpegPath })
  }
  /** 3. 环境变量 */
  if (process.env.FFMPEG_PATH) sources.push({ from: '环境变量 FFMPEG_PATH', raw: process.env.FFMPEG_PATH })
  if (process.env.FFMPEG_BIN) sources.push({ from: '环境变量 FFMPEG_BIN', raw: process.env.FFMPEG_BIN })
  /** 4. PATH 兜底 */
  sources.push({ from: 'PATH', raw: 'ffmpeg' })
  return sources
}

/** 由 ffmpeg 路径推出同目录的 ffprobe（同名不同后缀，Windows 是 .exe） */
function siblingFfprobe (ffmpegPath: string): string {
  try {
    if (!ffmpegPath) return ''
    const name = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
    return path.join(path.dirname(ffmpegPath), name)
  } catch {
    return ''
  }
}

function ffprobeSources (options: any = {}): FfmpegSource[] {
  const sources: FfmpegSource[] = []
  /** 1. 与选中的 ffmpeg 同目录的 ffprobe（下载的 ffmpeg 一般自带一份） */
  const ffmpegPick = pickFfmpeg(options, true)
  const sibling = ffmpegPick ? siblingFfprobe(ffmpegPick.bin) : ''
  if (sibling) sources.push({ from: '与 ffmpeg 同目录', raw: sibling })
  /** 2. karin 传进来的 options.ffprobePath */
  if (typeof options?.ffprobePath === 'string' && options.ffprobePath) {
    sources.push({ from: 'ffprobePath 参数', raw: options.ffprobePath })
  }
  /** 3. 环境变量 */
  if (process.env.FFPROBE_PATH) sources.push({ from: '环境变量 FFPROBE_PATH', raw: process.env.FFPROBE_PATH })
  /** 4. PATH 兜底 */
  sources.push({ from: 'PATH', raw: 'ffprobe' })
  return sources
}

/**
 * 选出第一个通过校验的候选。
 * @param quiet 为 true 时不打「跳过」日志（给 ffprobe 的「同目录探测」用，避免重复刷）
 */
function pickFfmpeg (options: any = {}, quiet = false): FfmpegCheckResult | null {
  const deps: FfmpegCheckDeps = options?.__ffmpegDeps ?? {}
  for (const source of ffmpegSources(options)) {
    const checked = checkFfmpegCandidate(source.raw, source.from, deps)
    if (!checked.ok) {
      if (!quiet) logFfmpegSkip('ffmpeg', source, String(checked.reason ?? '校验不通过'))
      continue
    }
    if (!quiet) logFfmpegChosen('ffmpeg', source.from, checked.bin)
    return checked
  }
  return null
}

/** ffmpeg 用的候选（校验过、可直接 spawn 的） */
function resolveFfmpegCandidates (options: any = {}): Array<{ from: string, bin: string }> {
  const deps: FfmpegCheckDeps = options?.__ffmpegDeps ?? {}
  const list: Array<{ from: string, bin: string }> = []
  const seen = new Set<string>()
  for (const source of ffmpegSources(options)) {
    const checked = checkFfmpegCandidate(source.raw, source.from, deps)
    if (!checked.ok) {
      logFfmpegSkip('ffmpeg', source, String(checked.reason ?? '校验不通过'))
      continue
    }
    if (seen.has(checked.bin)) continue
    seen.add(checked.bin)
    list.push({ from: source.from, bin: checked.bin })
  }
  if (list.length) logFfmpegChosen('ffmpeg', list[0].from, list[0].bin)
  return list
}

/** ffprobe 用的候选（校验过、可直接 spawn 的） */
function resolveFfprobeCandidates (options: any = {}): Array<{ from: string, bin: string }> {
  const deps: FfmpegCheckDeps = options?.__ffmpegDeps ?? {}
  const list: Array<{ from: string, bin: string }> = []
  const seen = new Set<string>()
  for (const source of ffprobeSources(options)) {
    const checked = checkFfmpegCandidate(source.raw, source.from, deps)
    if (!checked.ok) {
      logFfmpegSkip('ffprobe', source, String(checked.reason ?? '校验不通过'))
      continue
    }
    if (seen.has(checked.bin)) continue
    seen.add(checked.bin)
    list.push({ from: source.from, bin: checked.bin })
  }
  if (list.length) logFfmpegChosen('ffprobe', list[0].from, list[0].bin)
  return list
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
  /** spawn 阶段就失败（文件在但起不来 / 找不到）时的错误码，用来决定要不要换下一个候选 */
  spawnError?: string
}

function runFfmpegBinary (bin: string, args: string[], options: any = {}): Promise<FfmpegResult> {
  return new Promise((resolve) => {
    let child: any
    try {
      child = spawn(bin, args, { windowsHide: true })
    } catch (error: any) {
      /** Windows 上 spawn 一个不是可执行格式的文件会**同步**抛（spawn UNKNOWN），这里也要认 */
      resolve({
        status: false,
        stdout: '',
        stderr: String(error?.message ?? error),
        code: null,
        spawnError: String(error?.code ?? 'UNKNOWN'),
      })
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
    let settled = false
    const done = (result: FfmpegResult) => {
      if (settled) return
      settled = true
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
      done({
        status: false,
        stdout,
        stderr: stderr + String(error?.message ?? error),
        code: null,
        spawnError: String(error?.code ?? 'UNKNOWN'),
      })
    })
    child.on('close', (code: number | null) => {
      done({ status: code === 0, stdout, stderr, code })
    })
  })
}

/**
 * 跑一次 ffmpeg / ffprobe：候选按优先级来，spawn 阶段失败就换下一个再试。
 *
 * 只有 spawn 阶段的失败（EACCES / ENOENT / EINVAL / UNKNOWN…「压根没跑起来」）才换候选；
 * 命令本身跑完但是**非 0 退出**（比如文件损坏）不会去试别的 ffmpeg —— 换一份也一样失败。
 */
async function runFfmpegCommand (
  kind: 'ffmpeg' | 'ffprobe',
  input: string,
  options: any = {}
): Promise<FfmpegResult> {
  const args = splitCommandArgs(input)
  const candidates = kind === 'ffmpeg' ? resolveFfmpegCandidates(options) : resolveFfprobeCandidates(options)
  if (!candidates.length) {
    return {
      status: false,
      stdout: '',
      stderr: '没有可用的 ' + kind + '：所有候选都没通过校验（先确认机器上装了 ffmpeg，或在配置里指定绝对路径）',
      code: null,
      spawnError: 'ENOENT',
    }
  }
  const tried: string[] = []
  let last: FfmpegResult | null = null
  for (const candidate of candidates) {
    const attempt = await runFfmpegBinary(candidate.bin, args, options)
    if (!attempt.spawnError) return attempt
    tried.push(candidate.bin + '（' + attempt.spawnError + '）')
    logger.warn('[ffmpeg] ' + candidate.bin + ' 起不来（' + attempt.spawnError + '），换下一个候选')
    last = attempt
  }
  /** 全部候选都在 spawn 阶段失败：把「都试过哪些」写进 stderr，用户照着装/改就行 */
  if (last) {
    last.stderr = last.stderr + '\n（已尝试的 ' + kind + '：' + tried.join('、')
      + '；都不行，请安装 ' + kind + ' 或在配置/环境变量里指定它的绝对路径）'
  }
  return last ?? { status: false, stdout: '', stderr: '没有可用的 ' + kind, code: null }
}

/**
 * 给别处（例如自己 spawn 的图片切片）用的「一个可以直接 spawn 的 ffmpeg」。
 *
 * 走的是同一套候选与校验（Koishi 服务 → ffmpegPath → 环境变量 → PATH），
 * 所以不会再出现「某个模块读 process.env.FFMPEG_PATH 拿到相对路径 / 坏路径就 EACCES」。
 * 一个都没通过校验时返回 `'ffmpeg'`（交给 PATH 最后一次机会，反正也没更好的了）。
 */
export function resolveFfmpegBin (options: any = {}): string {
  try {
    const picked = pickFfmpeg(options, true)
    if (picked?.bin) return picked.bin
  } catch { /* 取不到就走下面的兜底 */ }
  return 'ffmpeg'
}

/** 同上，ffprobe 版 */
export function resolveFfprobeBin (options: any = {}): string {
  try {
    const candidates = resolveFfprobeCandidates(options)
    if (candidates.length) return candidates[0].bin
  } catch { /* 取不到就走下面的兜底 */ }
  return 'ffprobe'
}

export const ffmpeg = (input: string, options: any = {}): Promise<FfmpegResult> =>
  runFfmpegCommand('ffmpeg', input, options)

export const ffprobe = (input: string, options: any = {}): Promise<FfmpegResult> =>
  runFfmpegCommand('ffprobe', input, options)

/**
 * 是否真的能用 ffmpeg（弹幕烧录 / 转码相关功能用它决定要不要提示「未接入」）。
 *
 * 判定口径和真正跑命令时**一致**：候选要能归一化成绝对路径、存在、并且可执行；
 * PATH 那一档会真的去 PATH 里找文件（不再像以前那样「看到名字是 ffmpeg 就返回 true」）。
 */
export const isFfmpegAvailable = (): boolean => {
  try {
    return !!pickFfmpeg({}, true)
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

/**
 * 解析结果合并转发用的收集器（见 compat/forward-collect）。
 *
 * 业务侧一般只用得到两个：
 *   - `withoutForwardCollect`：把「过程提示」那次发送包起来，让它不要被收进最终那条转发里；
 *   - `withForwardKind`：段类型看不出类别的内容（互动视频剧情流程图）标一个类别，
 *     交给 ParseForward 按「合并转发内容」分流。
 */
export { COLLECTED_MESSAGE_ID, collectForward, currentForwardBag, drainForward, drainForwardGroups, forwardKindOf, isForwardCollecting, runWithForwardBag, withForwardKind, withoutForwardCollect } from './forward-collect'

export { logger, segment, syncUpstreamToKoishi }
export default karin
