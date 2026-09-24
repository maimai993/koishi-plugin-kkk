/**
 * 冒烟测试：互动视频的**剧情流程图**在「合并转发」里的归属。
 *
 * 用户要求：「流程图」要能像文字 / 图片 / 视频 / 文件那样在「合并转发内容」里单独勾。
 * 于是它必须能被认出来 —— 剧情图本身是 `img` 段，跟普通图片长得一模一样，
 * 所以发送方用 `withForwardKind('chart', …)` 给它打了个类别标签（见 compat/forward-collect）。
 *
 * 这个测试守三件事：
 *   1. **没勾「流程图」**：它不进聊天记录，而是**单独发出去**（不许丢内容）；
 *   2. **勾了「流程图」**：它进聊天记录；
 *   3. 解析结束（袋子已经冲刷）之后才画出来的剧情图**照样发得出去** ——
 *      以前这里有个坑：收集袋 drain 之后还继续收，收进去就再也没人发了，内容凭空消失。
 *
 * 用法：node scripts/smoke-forward-chart.cjs
 */
const path = require('node:path')
const { Context } = require('koishi')

const pluginRoot = path.resolve(__dirname, '..')
const dataRoot = path.resolve(pluginRoot, 'data-smoke-forward-chart')

const plugin = require(path.join(pluginRoot, 'lib/index.js'))
const ctx = new Context()
ctx.plugin(plugin, { dataPath: dataRoot, debug: true })

let failures = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? '✅' : '❌') + ' ' + name + (extra ? ' | ' + extra : ''))
  if (!ok) failures++
}

const NORMAL = 'https://example.com/normal.png'
const CHART = 'https://example.com/chart.png'
const LATE = 'https://example.com/late-chart.png'

setTimeout(async () => {
  try {
    const { Message, segment, karin } = require(path.join(pluginRoot, 'lib/compat/node-karin.js'))
    const { withForwardKind } = require(path.join(pluginRoot, 'lib/compat/node-karin.js'))
    const { withParseForward } = require(path.join(pluginRoot, 'lib/karin/module/utils/ParseForward.js'))
    const { Config } = require(path.join(pluginRoot, 'lib/karin/module/utils/Config.js'))

    /** 造一个假会话（onebot = 支持合并转发），发出去的内容都收进 sent */
    const makeEvent = (sent) => Message.fromSession({
      content: 'https://www.bilibili.com/video/BV1xx411c7mD',
      selfId: '10000', userId: '12345', guildId: '456', channelId: '456', messageId: 'm1',
      bot: {
        selfId: '10000', platform: 'onebot', status: 1, user: { id: '10000', name: 'smoke-bot' }, ctx,
        sendMessage: async (channel, payload) => { sent.push({ channel: String(channel), payload }); return ['msg-1'] },
        getGuild: async () => ({ name: 'smoke-guild' })
      },
      author: { nick: 'smoke' }, username: 'smoke', event: {},
      send: async (payload) => { sent.push({ channel: '456', payload }); return ['msg-2'] }
    })

    /** 一次解析：普通图片 + 剧情图（带标签）+ 文字；解析结束后再补画一张剧情图 */
    const runParse = async (kinds) => {
      await Config.Modify('app', 'forwardContent', kinds)
      const sent = []
      const e = makeEvent(sent)
      await withParseForward(async (ev) => {
        await ev.reply(segment.image(NORMAL))
        await withForwardKind('chart', () => ev.reply(segment.image(CHART)))
        await ev.reply(segment.text('解析结果文字'))
      })(e, () => Symbol('next'))
      /** 剧情是**后台**跑的：解析早就结束了，图这时才画出来 */
      await withForwardKind('chart', () => e.reply(segment.image(LATE)))
      return sent
    }

    /** 取合并转发节点里的内容（没有转发就返回空串） */
    const forwardTextOf = (sent) => {
      const forward = sent.find((item) => {
        const list = Array.isArray(item.payload) ? item.payload : [item.payload]
        return list.some((el) => el && el.type === 'message')
      })
      if (!forward) return ''
      return JSON.stringify(forward.payload)
    }
    /** 单独直发出去的内容 */
    const directTextOf = (sent) => {
      const forward = sent.filter((item) => {
        const list = Array.isArray(item.payload) ? item.payload : [item.payload]
        return list.some((el) => el && el.type === 'message')
      })
      const rest = sent.filter((item) => !forward.includes(item))
      return JSON.stringify(rest)
    }

    const savedFake = Config.app.fakeForward
    const savedContent = Config.app.forwardContent
    await Config.Modify('app', 'fakeForward', true)
    const savedNames = { forward: [], direct: [] }

    console.log('\n[1] 没勾「流程图」：不进聊天记录，单独发出去')
    {
      const sent = await runParse(['text', 'image'])
      const forward = forwardTextOf(sent)
      const direct = directTextOf(sent)
      check('合并转发里有普通图片与文字', forward.includes(NORMAL) && forward.includes('解析结果文字'), forward.slice(0, 120))
      check('剧情图**不在**聊天记录里', !forward.includes(CHART))
      check('剧情图单独发出来了（没被丢掉）', direct.includes(CHART), direct.slice(0, 160))
      savedNames.forward = forward
      savedNames.direct = direct
    }

    console.log('\n[2] 勾了「流程图」：进聊天记录')
    {
      const sent = await runParse(['text', 'image', 'chart'])
      const forward = forwardTextOf(sent)
      const direct = directTextOf(sent)
      check('聊天记录里有剧情图', forward.includes(CHART), forward.slice(0, 160))
      check('聊天记录里也有普通图片', forward.includes(NORMAL))
      check('勾上之后不会再单独发一遍', !direct.includes(CHART), direct.slice(0, 160))
    }

    console.log('\n[3] 解析结束之后才画出来的剧情图照样发得出去')
    {
      const sent = await runParse(['text', 'image'])
      const forward = forwardTextOf(sent)
      check('晚到的那张没有混进已经发出去的聊天记录', !forward.includes(LATE))
      check('晚到的那张单独发出去了（收集袋已经关闭，不许再吞）', directTextOf(sent).includes(LATE), directTextOf(sent).slice(0, 200))
    }

    console.log('\n[4] 收尾：配置恢复原样')
    {
      await Config.Modify('app', 'fakeForward', savedFake)
      await Config.Modify('app', 'forwardContent', savedContent)
      check('已恢复', JSON.stringify(Config.app.forwardContent) === JSON.stringify(savedContent))
    }

    void karin
  } catch (error) {
    console.log('❌ 冒烟测试抛异常: ' + String(error && error.stack ? error.stack : error))
    failures++
  }
  console.log('\n=== ' + (failures ? failures + ' 项失败' : '全部通过') + ' ===')
  process.exit(failures ? 1 : 0)
}, 3000)
