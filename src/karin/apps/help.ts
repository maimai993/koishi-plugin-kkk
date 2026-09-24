import karin, { config, logger } from 'node-karin'

import { Render } from '@/module'
import { Config } from '@/module/utils/Config'
import { wrapWithErrorHandler } from '@/module/utils/ErrorHandler'
import { collectRuntimeReport, getLocalChangelog } from '@/module/utils/runtime-report'

import { classifySendFailure, describeSendFailure } from '../../compat/sendError'

type Role = 'master' | 'member'
type RoleItem = { title: string; description: string; icon?: string | { name: string; color?: string }; roles?: Role[] }
type RoleMenuGroup = {
  title: string
  items: RoleItem[]
  subGroups?: { title: string; items: RoleItem[] }[]
}

const HELP_MENU_CONFIG: RoleMenuGroup[] = [
  {
    title: '常用功能',
    items: [
      {
        title: '自动识别分享链接进行解析',
        description: (() => {
          const platforms = []
          if (Config.douyin?.switch) platforms.push('抖音')
          if (Config.bilibili?.switch) platforms.push('哔哩哔哩')
          if (Config.kuaishou?.switch) platforms.push('快手')
          if (Config.xiaohongshu?.switch) platforms.push('小红书')
          return platforms.length > 0 ? `支持「${platforms.join('」「')}」` : '暂无可用平台'
        })(),
        icon: 'ph:link-fill',
        roles: ['member', 'master']
      },
      {
        title: '「解析」',
        description: '直接发链接或引用消息后发送（指令前缀按 Koishi 配置，本插件不带 # 前缀）；发链接会自动识别平台并弹画质面板',
        icon: 'ph:magic-wand-fill',
        roles: ['member', 'master']
      },
      {
        title: 'kkk解析统计',
        description: '查看当前群组的解析统计数据，包括各平台解析次数、使用用户数等',
        icon: 'ph:chart-bar-fill',
        roles: ['member', 'master']
      },
      {
        title: 'kkk全局解析统计',
        description: '查看全局解析统计数据，包括所有群组的解析情况、趋势分析和群组排行',
        icon: 'ph:chart-line-up-fill',
        roles: ['master']
      }
    ]
  },
  {
    title: '推送相关',
    items: [
      {
        title: '抖音/B站推送列表',
        description: '查看当前群的订阅推送列表',
        icon: 'ph:list-checks-fill',
        roles: ['master']
      },
      {
        title: '抖音/B站强制推送',
        description: '全部强制推送：手动模拟一次定时任务；\n强制推送：只在触发群模拟一次定时任务；\n已推送过的不会再推送',
        icon: 'ph:paper-plane-right-fill',
        roles: ['master']
      },
      {
        title: 'kkk推送全局忽略 + 链接',
        description: '对抖音作品或B站动态进行全局忽略，所有群组的推送标记为已处理',
        icon: 'ph:arrows-clockwise-fill',
        roles: ['master']
      }
    ],
    subGroups: [
      {
        title: '在群聊中再发送一次即可取消订阅',
        items: [
          {
            title: '设置抖音推送 + 抖音号',
            description: '在群聊中发送以对该群订阅该抖音博主的作品更新',
            icon: 'ph:bell-fill',
            roles: Config.douyin.push.permission === 'all' ? ['member', 'master'] : ['master']
          },
          {
            title: '设置B站推送 + UP主UID',
            description: '在群聊中发送以对该群订阅该B站UP主的稿件/动态更新',
            icon: 'ph:bell-fill',
            roles: Config.bilibili.push.permission === 'all' ? ['member', 'master'] : ['master']
          }
        ]
      }
    ]
  },
  {
    title: '设置相关',
    items: [
      {
        title: 'kkk设置推送机器人 + Bot ID',
        description: '一键更换推送机器人',
        icon: 'ph:robot-fill',
        roles: ['master']
      },
      {
        title: '抖音登录',
        description: '使用抖音APP扫码登录获取 Cookies',
        icon: 'logos:tiktok-icon',
        roles: ['master']
      },
      {
        title: 'B站登录',
        description: '使用哔哩哔哩APP扫码登录获取 Cookies',
        icon: {
          name: 'streamline-ultimate:bilibili-logo-bold',
          color: '#7fe1fa'
        },
        roles: ['master']
      }
    ]
  },
  {
    title: '其他',
    items: [
      {
        title: 'kkk版本',
        description: '查看插件、Karin、Node.js、适配器与系统资源等运行环境诊断信息',
        icon: 'ph:monitor-fill',
        roles: ['member', 'master']
      },
      {
        title: '「kkk更新日志」「kkk更新」',
        description: '查看更新日志或执行插件更新',
        icon: 'ph:arrows-clockwise-fill',
        roles: ['master']
      }
    ]
  }
]

const buildMenuForRole = (role: Role) => {
  const filterItems = (items: RoleItem[] = []) =>
    items.filter((i) => !i.roles || i.roles.includes(role)).map(({ title, description, icon }) => ({ title, description, icon }))

  return HELP_MENU_CONFIG.map((group) => {
    const items = filterItems(group.items)
    const subGroups = group.subGroups?.map((sg) => ({ title: sg.title, items: filterItems(sg.items) })).filter((s) => s.items.length > 0)

    return { title: group.title, items, subGroups }
  }).filter((g) => g.items.length > 0 || (g.subGroups && g.subGroups.length > 0))
}

// 包装帮助命令
const handleHelp = wrapWithErrorHandler(
  async (e) => {
    const masters = config.master().filter((id) => id !== 'console')
    const isMaster = !!e.sender && masters.includes(e.sender.userId)
    const role: Role = isMaster ? 'master' : 'member'
    const menu = buildMenuForRole(role)

    // 将 menu 转换为 list 供前端渲染
    const list = menu.flatMap((group) => {
      const groupItems = group.items.map((item) => ({
        title: item.title,
        description: item.description
      }))
      const subItems =
        group.subGroups?.flatMap((sg) =>
          sg.items.map((item) => ({
            title: item.title,
            description: item.description
          }))
        ) || []
      return [...groupItems, ...subItems]
    })

    const img = await Render(e, 'other/help', {
      title: 'KKK插件帮助页面',
      menu,
      list,
      role
    })
    await e.reply(img)
    return true
  },
  {
    businessName: 'KKK帮助'
  }
)

// 包装版本命令
const handleVersion = wrapWithErrorHandler(
  async (e) => {
    const img = await Render(e, 'other/runtime', await collectRuntimeReport(e))
    await e.reply(img)
    return true
  },
  {
    businessName: 'KKK版本'
  }
)

/**
 * 把 Markdown 更新日志压成纯文字。
 *
 * 图片发不出去时的降级用：去掉标题号与加粗符号就够了，内容本身不改写。
 */
const toPlainChangelog = (markdown: string): string =>
  markdown
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*/g, '')
    .slice(0, 1800)
    .trim()

// 包装更新日志命令
const handleChangelog = wrapWithErrorHandler(
  async (e) => {
    const forwardLogs = getLocalChangelog(10)
    if (!forwardLogs) {
      throw new Error('当前构建未携带可用的 CHANGELOG.md')
    }

    const img = await Render(e, 'other/changelog', {
      markdown: forwardLogs,
      Tip: false,
      localVersion: '',
      remoteVersion: ''
    })
    try {
      await e.reply(img)
    } catch (error) {
      /**
       * 图片发不出去（体积超限、主动消息被拒、适配器抽风…）时退回纯文字。
       * 更新日志本身是文字，降级之后用户照样看得到更新了什么，比只弹一张错误卡片好。
       */
      logger.warn('[kkk] 更新日志图片发送失败，改用文字发送：' + describeSendFailure(classifySendFailure(error)))
      await e.reply(toPlainChangelog(forwardLogs))
    }
    return true
  },
  {
    businessName: 'KKK更新日志'
  }
)

export const help = karin.command(/^#?kkk帮助$/, handleHelp, { name: 'kkk-帮助' })

export const version = karin.command(/^#?kkk版本$/, handleVersion, { name: 'kkk-版本' })

export const changelog = karin.command(/^#?kkk更新日志$/, handleChangelog, { name: 'kkk-更新日志' })
