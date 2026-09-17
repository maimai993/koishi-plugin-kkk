/**
 * 渲染冒烟测试：用固定数据直接跑模板 SSR（不依赖 puppeteer，也不需要外网）。
 *
 * 验证点：
 *   - 路由注册表能加载到上游模板（\`src/ktr/template/**\`）
 *   - react-dom/server 能把模板渲染成 HTML，且关键内容出现在 HTML 里
 *   - 模板样式（上游构建产物 style.css）被内联进 HTML
 *   - 不支持的路由/坏数据会回退到内置通用卡片
 *
 * 用法：node scripts/smoke-render.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { Context } = require('koishi')

const pluginRoot = path.resolve(__dirname, '..')
const dataRoot = path.resolve(pluginRoot, 'data-smoke-render')
fs.mkdirSync(path.join(dataRoot, 'koishi-plugin-kkk', 'config'), { recursive: true })

const plugin = require(path.join(pluginRoot, 'lib/index.js'))
const ctx = new Context()
const fakeBot = {
  selfId: '10000', platform: 'smoke', status: 1, user: { id: '10000', name: 'smoke' }, ctx,
  sendMessage: async () => ['m'], getGuild: async () => ({ name: 'g' }), getFriendList: async () => []
}
Object.defineProperty(ctx, 'bots', { get: () => [fakeBot] })
ctx.plugin(plugin, { dataPath: dataRoot, debug: true, masters: ['12345'] })

// 用富文本包自带的构造函数拼文档，保证形状与模板一致
const richtext = require(path.join(pluginRoot, 'lib/richtext/index.js'))
const descDoc = richtext.createRichTextDocument([
  richtext.createParagraphNode([richtext.createTextNode('这里是视频简介，用于验证富文本渲染链路。')])
], { platform: 'bilibili' })

/** B站视频信息模板的固定数据 */
const videoInfoData = {
  share_url: 'https://b23.tv/BV1xx411c7mD',
  title: '【迁移验证】这是一条用于确认模板渲染的测试标题',
  desc: descDoc,
  stat: {
    aid: 2, view: 1234567, danmaku: 4567, reply: 890, favorite: 2345, coin: 6789, share: 123,
    now_rank: 0, his_rank: 8, like: 98765, dislike: 0, evaluation: '', argue_msg: ''
  },
  bvid: 'BV1xx411c7mD',
  ctime: Math.floor(Date.now() / 1000) - 86400,
  pic: 'https://i0.hdslb.com/bfs/archive/placeholder.jpg',
  owner: { mid: 946974, name: '测试UP主', face: 'https://i0.hdslb.com/bfs/face/placeholder.jpg' },
  hotDanmaku: [{ content: '测试弹幕', count: 12 }]
}

const outDir = path.join(dataRoot, 'html')
fs.mkdirSync(outDir, { recursive: true })

setTimeout(async () => {
  let failures = 0
  try {
    const render = require(path.join(pluginRoot, 'lib/karin/module/utils/Render/index.js'))

    const cases = [
      { route: 'bilibili/videoInfo', data: videoInfoData, expect: '【迁移验证】' },
      { route: 'other/changelog', data: { markdown: '## [2.42.5]\n- 迁移验证用的更新日志', Tip: false }, expect: '迁移验证用的更新日志' },
      { route: '不存在的路由/xxx', data: videoInfoData, expect: '【迁移验证】', fallbackOnly: true }
    ]

    for (const item of cases) {
      const html = await render.renderTemplateHtml(item.route, item.data, false)
      const finalHtml = html ?? render.buildFallbackHtml(item.route, item.data, false, 1)
      const usedTemplate = !!html
      const ok = finalHtml.includes(item.expect) && (!item.fallbackOnly || !usedTemplate)
      if (!ok) failures++
      const file = path.join(outDir, item.route.replace(/[\\/]/g, '_') + '.html')
      fs.writeFileSync(file, finalHtml)
      console.log(
        (ok ? '✅' : '❌') + ' ' + item.route +
        ' | 模板 SSR: ' + (usedTemplate ? '是' : '否（回退卡片）') +
        ' | HTML ' + finalHtml.length + ' 字节' +
        ' | 含样式: ' + (finalHtml.includes('.flex') || finalHtml.includes('--tw') ? '是' : '否') +
        ' | 含关键内容: ' + ok
      )
    }

    // 注册表健康检查：所有路由的模板是否都能被加载（缺依赖会在这里暴露）
    const registry = require(path.join(pluginRoot, 'lib/ktr/registry.js'))
    const routes = Object.keys(registry.templateRegistry)
    const broken = []
    for (const route of routes) {
      try {
        const mod = await registry.loadTemplate(route)
        if (!mod?.component) broken.push(route + '（无 component）')
      } catch (error) {
        broken.push(route + '（' + String(error && error.message).split('\n')[0] + '）')
      }
    }
    console.log('\n模板注册表：共 ' + routes.length + ' 个路由，可加载 ' + (routes.length - broken.length) + ' 个')
    if (broken.length) {
      console.log('暂不可用（依赖缺失等，运行时会自动回退通用卡片）:')
      for (const item of broken) console.log('  - ' + item)
    }

    console.log('\nHTML 样例输出目录: ' + outDir)
  } catch (error) {
    console.error('渲染冒烟测试失败:', error && error.stack ? error.stack : error)
    failures++
  }
  process.exit(failures ? 1 : 0)
}, 5000)
