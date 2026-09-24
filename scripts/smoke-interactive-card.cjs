/**
 * 互动视频「剧情图」卡片：直接跑 SSR，确认卡片拼得出来。
 *
 * 卡片是给用户看的图，不能在冒烟里截图（生产才有 puppeteer），所以这里退一步：
 * 用 react-dom/server 把模板渲成 HTML，检查标题、选项、页脚版本信息都在。
 *
 * 用法：node scripts/smoke-interactive-card.cjs
 */
const path = require('node:path')
const pluginRoot = path.resolve(__dirname, '..')
const libRoot = path.join(pluginRoot, 'lib')
const noop = () => {}
const runtime = require(path.join(libRoot, 'compat', 'runtime.js'))
runtime.bindRuntime({ ctx: { get: () => undefined, logger: () => ({ info: noop, warn: noop, error: noop, debug: noop, mark: noop }), bots: [], registry: new Map(), on: noop, middleware: noop }, config: { app: {} }, dataRoot: path.join(pluginRoot, 'data-smoke-interactive-card'), pluginRoot, master: () => [] })

const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const template = require(path.join(libRoot, 'ktr', 'template', 'bilibili', 'interactive', 'index.js'))
const { Root } = require(path.join(libRoot, 'karin', 'root.js'))

const failures = []
let passed = 0
const check = (name, condition, detail) => {
  if (condition) { passed++; console.log('  ✓ ' + name) } else { failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')) }
}

const data = {
  title: '点进来帮史蒂夫做出选择！不用下载点击就玩！【互动视频+3种真结局+10个成就】',
  step: 2,
  path: ['向左走'],
  rootLabel: '当前 · 第二题',
  question: '第一题',
  notice: '登录后才能体验全部结局哦～',
  graph: {
    question: '开场',
    isLeaf: false,
    choices: [
      { label: 'A', text: '向左走', isDefault: true, children: [ { question: '第二题', isLeaf: false, choices: [ { label: 'A', text: '向右挖', children: [ { question: '结局一', isLeaf: true, choices: [] } ] }, { label: 'B', text: '向下挖', children: [ { question: '结局二', isLeaf: true, choices: [] } ] } ] } ] },
      { label: 'B', text: '向右挖', children: [ { question: '另一条线', isLeaf: false, choices: [ { label: 'A', text: '继续', children: [ { question: '结局三', isLeaf: true, choices: [] } ] } ] } ] }
    ]
  }
}
const ctx = {
  theme: 'light',
  scale: 1,
  version: {
    plugin: 'koishi-plugin',
    pluginName: 'kkk',
    pluginVersion: Root.pluginVersion,
    releaseType: 'Stable',
    poweredBy: 'Koishi',
    frameworkVersion: Root.karinVersion
  }
}

const main = () => {
  const def = template.default ?? template
  check('模板能加载', !!def && !!def.component, Object.keys(template).join(','))
  check('validate 认这份数据', typeof def.validate === 'function' && def.validate(data) === true)
  check('validate 会挡住空数据', def.validate({}) === false)

  const html = renderToStaticMarkup(React.createElement(def.component, { data, ctx }))
  check('渲染出标题', html.includes('帮史蒂夫做出选择'), html.length)
  check('渲染出选项编号与文字', html.includes('向左走') && html.includes('向右挖') && html.includes('向下挖'))
  check('画的是思维导图（svg + 曲线）', html.includes('<svg') && html.includes('<path') && html.includes(' C '), html.slice(0, 120))
  check('全部剧情都画上了（含深层结局）', html.includes('结局一') && html.includes('结局二') && html.includes('结局三'), html.slice(0, 200))
  check('每一段剧情都有落点圆圈', (html.match(/<circle/g) || []).length >= 8, String((html.match(/<circle/g) || []).length))
  check('走过的路用高亮标出来', html.includes('高亮的是你已经走过的路'))
  check('渲染出每段的题目/落点', html.includes('第二题') && html.includes('结局一'))
  check('补画时根节点是「当前 · 这一段」', html.includes('当前 · 第二题'), html.slice(0, 200))
  check('渲染出已选剧情', html.includes('已选：') && html.includes('向左走'))
  check('标出 B站 默认分支', html.includes('（默认）'))
  check('带上 B站 的提示语', html.includes('登录后才能体验全部结局'))
  check('页脚有插件版本（和作品信息卡同一套）', html.includes('v' + Root.pluginVersion), html.slice(-400))
  check('页脚有框架版本', html.includes(String(Root.karinVersion)), html.slice(-400))
  check('没有噪音层（feTurbulence 很慢，这张卡不铺）', !html.includes('feTurbulence'))
  check('没有把未定义的选项渲染成 undefined', !html.includes('undefined'), (html.match(/.{0,40}undefined.{0,40}/) || [''])[0])

  console.log('')
  console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项')
  if (failures.length === 0) { console.log('=== 通过：剧情图卡片拼得出来，页脚版本信息齐全 ==='); process.exit(0) }
  for (const item of failures) console.log('  ❌ ' + item)
  console.log('=== 失败 ===')
  process.exit(1)
}

try { main() } catch (error) { console.log('测试自身抛错: ' + (error && error.stack ? error.stack : error)); process.exit(1) }
