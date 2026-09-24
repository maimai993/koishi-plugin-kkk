/**
 * 互动视频的「剧情图」思维导图卡片。
 *
 * 用户要的是**全部剧情流程**一张图看完（像 markmap 那种），不是只列眼前这几个选项。
 * 所以这里把爬下来的整张图铺成思维导图：根节点在最左，右侧逐层展开分支，用贝塞尔曲线连起来，
 * 顶层分支各自一种颜色；已经走过的选项加粗高亮。
 *
 * 样式全部写行内 / SVG 属性：卡片用的是预编译的 tailwind 产物，新模板的任意值类不存在。
 */
import React from 'react'

import { DefaultLayout } from '../../../components/DefaultLayout'
import type { PosterProps } from '../../../types/ctx'
import type { BilibiliInteractiveData, InteractiveMapNode } from './types'

const BILI_BLUE = '#00aeec'
/** 顶层分支配色，和思维导图常见做法一致：一条主枝一个颜色 */
const BRANCH_COLORS = ['#ff7a45', '#3fbf6f', '#22a6b3', '#a259ff', '#f0b429', '#5a8dee', '#e8608d', '#7f8c8d']

const COL_WIDTH = 260
const ROW_HEIGHT = 62
const PAD_LEFT = 8
const PAD_TOP = 20

interface Item {
  id: string
  label: string
  depth: number
  /** 这一项的纵坐标（叶子计数决定） */
  row: number
  color: string
  parent?: string
  /** 结局 / 选项 / 题目 */
  kind: 'root' | 'choice' | 'node'
  isDefault?: boolean
  /** 用户走过的选项 */
  walked?: boolean
}

/** 把剧情图摊平成「一行一项」的列表，并算好每个叶子占用的行号 */
const flatten = (root: InteractiveMapNode, path: string[], rootLabel?: string): { items: Item[]; rows: number } => {
  const items: Item[] = []
  let cursor = 0
  const seen = new Set<number>()

  const walk = (node: InteractiveMapNode, depth: number, parent: string | undefined, color: string, id: string) => {
    const label = node.question || (node.isLeaf ? '结局' : '继续剧情')
    const self: Item = { id, label, depth, row: 0, color, parent, kind: parent ? 'node' : 'root' }
    items.push(self)
    const choices = Array.isArray(node.choices) ? node.choices : []
    if (!choices.length) {
      self.row = cursor++
      return
    }
    let firstRow = -1
    choices.forEach((choice, index) => {
      const childId = id + '.' + index
      const choiceItem: Item = {
        id: childId,
        label: choice.label + ' ' + choice.text,
        depth: depth + 1,
        row: 0,
        color,
        parent: id,
        kind: 'choice',
        isDefault: choice.isDefault,
        walked: path.includes(choice.text)
      }
      items.push(choiceItem)
      const children = Array.isArray(choice.children) ? choice.children : []
      if (!children.length) {
        choiceItem.row = cursor++
      } else {
        children.forEach((child, childIndex) => walk(child, depth + 2, childId, color, childId + '.' + childIndex))
        choiceItem.row = choiceItem.row || cursor - 1
      }
      if (firstRow < 0) firstRow = choiceItem.row
    })
    /** 父节点对齐到自己第一个分支那一行，和思维导图的观感一致 */
    self.row = firstRow >= 0 ? firstRow : cursor++
  }

  const topChoices = Array.isArray(root.choices) ? root.choices : []
  const rootItem: Item = { id: 'root', label: rootLabel || root.question || '开场', depth: 0, row: 0, color: BILI_BLUE, kind: 'root' }
  items.push(rootItem)
  if (!topChoices.length) { rootItem.row = cursor++ } else {
    topChoices.forEach((choice, index) => {
      const color = BRANCH_COLORS[index % BRANCH_COLORS.length]
      const childId = 'root.' + index
      const choiceItem: Item = {
        id: childId,
        label: choice.label + ' ' + choice.text,
        depth: 1,
        row: 0,
        color,
        parent: 'root',
        kind: 'choice',
        isDefault: choice.isDefault,
        walked: path.includes(choice.text)
      }
      items.push(choiceItem)
      const children = Array.isArray(choice.children) ? choice.children : []
      if (!children.length) { choiceItem.row = cursor++ } else {
        children.forEach((child, childIndex) => walk(child, 3, childId, color, childId + '.' + childIndex))
        choiceItem.row = choiceItem.row || cursor - 1
      }
    })
    rootItem.row = items[1]?.row ?? 0
  }
  seen.clear()
  return { items, rows: Math.max(cursor, 1) }
}

export const BilibiliInteractive: React.FC<PosterProps<BilibiliInteractiveData>> = React.memo((props) => {
  const { data } = props
  const path = Array.isArray(data.path) ? data.path.filter(Boolean) : []
  const graph = data.graph
  const flat = graph ? flatten(graph, path, data.rootLabel) : null
  const depth = flat ? flat.items.reduce((max, item) => Math.max(max, item.depth), 0) : 0
  const width = PAD_LEFT * 2 + (depth + 1) * COL_WIDTH
  const height = PAD_TOP * 2 + (flat ? flat.rows : 1) * ROW_HEIGHT
  const byId = new Map<string, Item>()
  if (flat) for (const item of flat.items) byId.set(item.id, item)
  const rowY = (row: number) => PAD_TOP + row * ROW_HEIGHT + ROW_HEIGHT / 2
  const colX = (item: Item) => PAD_LEFT + item.depth * COL_WIDTH

  return (
    <DefaultLayout {...props}>
      <div style={{ position: 'relative', zIndex: 10, padding: '64px 56px 48px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <span style={{ borderRadius: 999, padding: '12px 28px', fontSize: 26, fontWeight: 900, letterSpacing: '0.18em', background: 'rgba(0,174,236,0.14)', color: BILI_BLUE }}>互动视频</span>
          <span style={{ fontSize: 26, fontWeight: 700, opacity: 0.42 }}>第 {data.step} 段 · 全部剧情流程</span>
        </div>
        <h1 style={{ margin: '28px 0 0', fontSize: 48, fontWeight: 900, lineHeight: 1.3, wordBreak: 'break-word' }}>{data.title}</h1>
        {path.length > 0 && (
          <div style={{ marginTop: 18, fontSize: 27, fontWeight: 600, opacity: 0.5, wordBreak: 'break-word' }}>已选：{path.join(' → ')}</div>
        )}

        {flat && (
          <svg
            viewBox={'0 0 ' + width + ' ' + height}
            width='100%'
            style={{ marginTop: 26, display: 'block', overflow: 'visible' }}
            role='img'
          >
            {flat.items.map((item) => {
              if (!item.parent) return null
              const parent = byId.get(item.parent)
              if (!parent) return null
              const x1 = colX(parent) + 8
              const x2 = colX(item) - 6
              const mid = (x1 + x2) / 2
              const d = 'M ' + x1 + ' ' + rowY(parent.row) + ' C ' + mid + ' ' + rowY(parent.row) + ', ' + mid + ' ' + rowY(item.row) + ', ' + x2 + ' ' + rowY(item.row)
              return <path key={'edge-' + item.id} d={d} fill='none' stroke={item.color} strokeWidth={item.walked ? 5 : 3} strokeLinecap='round' opacity={item.walked ? 1 : 0.75} />
            })}
            {flat.items.map((item) => {
              const x = colX(item)
              const y = rowY(item.row)
              const isChoice = item.kind === 'choice'
              return (
                <g key={'node-' + item.id}>
                  <circle cx={x} cy={y} r={isChoice ? 9 : 13} fill={item.walked || item.kind === 'root' ? item.color : '#ffffff'} stroke={item.color} strokeWidth={4} />
                  <text
                    x={x + (isChoice ? 22 : 26)}
                    y={y + 9}
                    fontSize={isChoice ? 27 : 29}
                    fontWeight={item.walked || item.kind === 'root' ? 900 : 600}
                    fill={item.walked ? item.color : 'currentColor'}
                    opacity={item.walked || item.kind === 'root' ? 1 : 0.82}
                  >
                    {item.label.length > 14 ? item.label.slice(0, 14) + '…' : item.label}
                    {item.isDefault ? '（默认）' : ''}
                  </text>
                </g>
              )
            })}
          </svg>
        )}

        {!flat && (data.choices ?? []).map((choice, index) => (
          <div key={choice.label + index} style={{ marginTop: index === 0 ? 30 : 18, fontSize: 36, fontWeight: 800 }}>
            {choice.label} {choice.text}
            {choice.isDefault ? '（默认）' : ''}
          </div>
        ))}

        {(data.truncated || graph?.truncated) && (
          <div style={{ marginTop: 26, fontSize: 25, fontWeight: 600, opacity: 0.55 }}>剧情太长，图上只画了前半部分分支</div>
        )}
        <div style={{ marginTop: 22, display: 'flex', alignItems: 'center', gap: 14, fontSize: 25, fontWeight: 600, opacity: 0.52 }}>
          <span style={{ display: 'inline-block', width: 26, height: 5, borderRadius: 999, background: BILI_BLUE }} />
          高亮的是你已经走过的路
        </div>
        {data.notice && (
          <div style={{ marginTop: 18, borderRadius: 20, padding: '16px 28px', fontSize: 25, fontWeight: 600, opacity: 0.62, background: 'rgba(127,127,127,0.12)' }}>{data.notice}</div>
        )}
      </div>
    </DefaultLayout>
  )
})

BilibiliInteractive.displayName = 'BilibiliInteractive'
