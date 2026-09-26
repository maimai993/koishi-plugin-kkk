/**
 * 临时探针：把剧情图用一个**很长的题目**渲染一遍，确认标签会折成两行、内容不丢。
 */
const path = require('node:path')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const pluginRoot = path.resolve(__dirname, '..')
const runtime = require(path.join(pluginRoot, 'lib/compat/runtime.js'))
const noop = () => {}
runtime.bindRuntime({ ctx: { get: () => undefined, logger: () => ({ info: noop, warn: noop, error: noop, debug: noop, mark: noop }), config: {}, pluginRoot, dataRoot: require('node:os').tmpdir() } })
const template = require(path.join(pluginRoot, 'lib/ktr/template/bilibili/interactive/index.js'))
const Root = require(path.join(pluginRoot, 'lib/karin/root.js')).Root
const data = {
  title: '测试：很长的题目',
  step: 1,
  path: ['向左走'],
  graph: {
    question: '开场',
    choices: [
      { label: 'A', text: '向左走', isDefault: true, children: [{ question: '你要不要现在就跟着她一起上楼去看看那个房间', isLeaf: false, choices: [] }] },
      { label: 'B', text: '向右挖', children: [{ question: '结局二', isLeaf: true, choices: [] }] }
    ]
  }
}
const ctx = { theme: 'light', scale: 1, version: { plugin: 'koishi-plugin', pluginName: 'kkk', pluginVersion: Root.pluginVersion, releaseType: 'Stable', poweredBy: 'Koishi', frameworkVersion: Root.karinVersion } }
const def = template.default ?? template
const html = renderToStaticMarkup(React.createElement(def.component, { data, ctx }))
const tspans = html.match(/<tspan[^>]*>[^<]*<\/tspan>/g) || []
console.log('tspan 数量:', tspans.length)
console.log('折行的标签:')
for (const item of tspans.slice(0, 12)) console.log('   ', item.replace(/<[^>]+>/g, ' | '))
console.log('（默认）完整出现:', html.includes('（默认）'))
console.log('长题目开头出现:', html.includes('你要不要现在就'))
