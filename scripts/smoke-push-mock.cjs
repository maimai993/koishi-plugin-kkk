/**
 * 推送渲染链路测试：把 amagi 的动态列表接口替换成固定数据，
 * 验证「配置 → 取数 → 过滤 → 渲染 → 入库 → 发送」在 Koishi 侧是否跑得通。
 * 用于在没有可用 Cookie / 被 B站风控的环境下验证迁移后的推送链路。
 *
 * 用法：node scripts/smoke-push-mock.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { Context } = require('koishi')

const pluginRoot = path.resolve(__dirname, '..')
const dataRoot = path.resolve(pluginRoot, 'data-smoke-mock')
const cfgDir = path.join(dataRoot, 'koishi-plugin-kkk', 'config')
fs.mkdirSync(cfgDir, { recursive: true })

const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'config/default_config/config.json'), 'utf8'))
config.app.parseTip = false
config.pushlist = {
  douyin: [],
  bilibili: [{ switch: true, host_mid: 946974, group_id: ['456:10000'], remark: '测试UP', pushTypes: ['word'] }]
}
config.bilibili.push.switch = true
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(config, null, 2))

const plugin = require(path.join(pluginRoot, 'lib/index.js'))
const ctx = new Context()
const sent = []
const fakeBot = {
  selfId: '10000', platform: 'smoke', status: 1, user: { id: '10000', name: 'smoke' }, ctx,
  sendMessage: async (channel, content) => { sent.push({ channel, content }); return ['msg-1'] },
  sendPrivateMessage: async (user, content) => { sent.push({ channel: 'private:' + user, content }); return ['msg-1'] },
  getGuild: async () => ({ name: 'smoke-guild' }),
  getFriendList: async () => []
}
Object.defineProperty(ctx, 'bots', { get: () => [fakeBot] })
ctx.plugin(plugin, { dataPath: dataRoot, debug: true })

/** 构造一条「纯文动态」的固定响应 */
function makeDynamic () {
  const now = Math.floor(Date.now() / 1000)
  // 动态 ID 每次运行都不同，否则会被「已推送」缓存挡住（这本身是去重逻辑正确的表现）
  const id = String(Date.now())
  return {
    id_str: id,
    type: 'DYNAMIC_TYPE_WORD',
    basic: { comment_id_str: '1000000000000000001', comment_type: 1, like_icon: { icon_id: '', icon_url: '' } },
    modules: {
      module_author: {
        mid: 946974, name: '测试UP', face: 'https://i0.hdslb.com/bfs/face/member/noface.jpg',
        pub_ts: now - 600, pub_time: '10分钟前', following: false, is_top: false,
        official_verify: { type: -1, desc: '' }, vip: { type: 0, status: 0 }, pendant: {}, nameplate: {}
      },
      module_dynamic: {
        desc: {
          text: '这是一条用于验证 Koishi 推送链路的测试动态',
          rich_text_nodes: [{ type: 'RICH_TEXT_NODE_TYPE_TEXT', text: '这是一条用于验证 Koishi 推送链路的测试动态', orig_text: '' }]
        },
        major: null, topic: null, additional: null
      },
      module_stat: {
        comment: { count: 3, forbidden: false }, forward: { count: 1, forbidden: false }, like: { count: 5, forbidden: false }
      },
      module_tag: null,
      module_interaction: { items: [] }
    }
  }
}

setTimeout(async () => {
  try {
    // 替换 amagi 的客户端工厂：每个 Base 实例都会新建 client，只有包住工厂才能稳定注入固定数据
    const amagi = require('@ikenxuan/amagi')
    const realFactory = amagi.default
    amagi.default = function (options) {
      const client = realFactory(options)
      client.bilibili.fetcher.fetchUserDynamicList = async () => ({
        success: true,
        code: 200,
        message: 'OK',
        data: { code: 0, message: 'OK', data: { items: [makeDynamic()], offset: '', has_more: false } }
      })
      client.bilibili.fetcher.fetchUserCard = async () => ({
        success: true, code: 200, message: 'OK',
        data: { code: 0, message: 'OK', data: { card: { mid: '946974', name: '测试UP', face: '' } } }
      })
      return client
    }

    const { taskQueue } = require(path.join(pluginRoot, 'lib/compat/runtime.js'))
    const task = taskQueue.find((item) => item.name === 'B站推送')
    console.log('=== 执行定时任务：B站推送（固定数据） ===')
    await task.handler()

    const { bilibiliDB } = require(path.join(pluginRoot, 'lib/karin/module/db/index.js'))
    const pushed = await bilibiliDB.isDynamicPushed('1000000000000000001', 946974, '456').catch((e) => '查询失败: ' + e.message)
    console.log('动态是否已入库:', pushed)

    console.log('\n=== 共发出 ' + sent.length + ' 条消息 ===')
    for (const item of sent) {
      const list = Array.isArray(item.content) ? item.content : [item.content]
      console.log('→ ' + item.channel + ': ' + list.map((el) => {
        if (typeof el === 'string') return el.slice(0, 300)
        const type = el && el.type ? el.type : typeof el
        const attrs = el && el.attrs ? JSON.stringify(el.attrs).slice(0, 200) : ''
        return '[' + type + '] ' + attrs
      }).join(' | '))
    }
  } catch (error) {
    console.error('固定数据推送测试失败:', error && error.stack ? error.stack : error)
    process.exitCode = 1
  }
  process.exit(process.exitCode || 0)
}, 5000)
