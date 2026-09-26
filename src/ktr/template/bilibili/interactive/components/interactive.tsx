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

/**
 * 版面尺寸。
 *
 * **字要大**（用户要求）：这张卡片是 1440px 宽的画布，到了手机聊天框里会被等比缩到
 * 几百像素宽，图上文字的实际大小 = 字号 / 画布总宽 —— 所以「把字弄大」只能靠
 * **字号占宽度的比例变大**：
 *   - 列宽不再跟着字号涨（涨了等于没变），只把字号提上去；
 *   - 每列能显示几个字 = 列宽 / 字号，字号大了就得少显示几个字，
 *     标签改成**按像素宽度裁剪**（中文按 1 个字宽算），不让它压到下一列上去。
 */
const COL_WIDTH = 260
const ROW_HEIGHT = 88
const PAD_LEFT = 8
const PAD_TOP = 24

/** 节点文字的字号（选项 / 剧情节点） */
const CHOICE_FONT = 33
const NODE_FONT = 34
/** 一列文字最多能用到哪里：到下一列的圆圈之前就为止（别压到人家的圆上） */
const LABEL_WIDTH = COL_WIDTH - 45

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

/**
 * 一个字符大概占多少个字号宽：中文 / 全角算 1 个，空格 0.3，其余 0.5。
 * （不用真的去量字体，够用就行 —— 目的是别让文字压到下一列的圆圈上。）
 */
const charWidth = (char: string): number => {
  if (/[\u2e80-\ufffd\ufe30-\ufe4f]/.test(char)) return 1
  if (char === ' ') return 0.3
  return 0.5
}

/** 一段文字排出来大概多宽（像素） */
const lineWidth = (text: string, fontSize: number): number => {
  let total = 0
  for (const char of text) total += charWidth(char) * fontSize
  return total
}

/**
 * 把标签排成**最多两行**，两行都装不下才截断加省略号。
 *
 * 以前是按「14 个字」裁的：中文一个字差不多一个字号宽，14 个字在 34px 字号下要 470 多个像素，
 * 而列宽只有 260px —— 标签会直接压到下一列的圆圈上，字挤在一起更看不清。
 *
 * 为什么要折行而不是直接截断：字号调大以后一列只能放下六七个字，
 * 直接砍会把「当前 · 第二题」这种关键信息切掉；折成两行既保住了字大，也保住了内容
 * （行高已经在 ROW_HEIGHT 里留出来了）。
 *
 * @param label 原始文字
 * @param fontSize 字号（越大能放的字越少）
 * @param extra 额外可用宽度（最后一列右边没有东西，用它多占一点）
 * @param suffix 后缀（「（默认）」这种）——**整块跟着最后一行，绝不从中间断开**
 */
const wrapLabel = (label: string, fontSize: number, extra = 0, suffix = ''): string[] => {
  const budget = LABEL_WIDTH + extra
  const lines: string[] = []
  let current = ''
  let used = 0
  for (const char of label) {
    const cost = charWidth(char) * fontSize
    if (current && used + cost > budget) {
      lines.push(current)
      current = ''
      used = 0
      // 两行都满了：把第二行截断加省略号
      if (lines.length >= 2) {
        lines[1] = lines[1] + '…'
        break
      }
    }
    current += char
    used += cost
  }
  if (current) {
    if (lines.length >= 2) lines[1] = lines[1] + '…'
    else lines.push(current)
  }
  if (!lines.length) lines.push('')
  /** 后缀单独占一行也行（它很短），实在没地方了就跟在最后一行后面 */
  if (suffix) {
    const last = lines[lines.length - 1]
    if (lineWidth(last + suffix, fontSize) <= budget) lines[lines.length - 1] = last + suffix
    else if (lines.length < 2) lines.push(suffix)
    else lines[lines.length - 1] = last + suffix
  }
  return lines
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
          <div style={{ marginTop: 18, fontSize: 32, fontWeight: 600, opacity: 0.5, wordBreak: 'break-word' }}>已选：{path.join(' → ')}</div>
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
              const font = isChoice ? CHOICE_FONT : NODE_FONT
              const textX = x + (isChoice ? 22 : 26)
              /** 「（默认）」也算进这一列的可视宽度里，免得它把第二行挤出去 */
              const lines = wrapLabel(item.label, font, item.depth >= depth ? 56 : 0, item.isDefault ? '（默认）' : '')
              /** 一行时基线和以前一样；两行时整块往上挪一点，让两行都贴着圆圈居中 */
              const baseline = lines.length > 1 ? y - font * 0.15 : y + font * 0.35
              return (
                <g key={'node-' + item.id}>
                  <circle cx={x} cy={y} r={isChoice ? 9 : 13} fill={item.walked || item.kind === 'root' ? item.color : '#ffffff'} stroke={item.color} strokeWidth={4} />
                  <text
                    x={textX}
                    y={baseline}
                    fontSize={font}
                    fontWeight={item.walked || item.kind === 'root' ? 900 : 600}
                    fill={item.walked ? item.color : 'currentColor'}
                    opacity={item.walked || item.kind === 'root' ? 1 : 0.82}
                  >
                    {lines.map((line, index) => (
                      <tspan key={'line-' + index} x={textX} dy={index === 0 ? 0 : Math.round(font * 1.05)}>{line}</tspan>
                    ))}
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
          <div style={{ marginTop: 26, fontSize: 30, fontWeight: 600, opacity: 0.55 }}>剧情太长，图上只画了前半部分分支</div>
        )}
        <div style={{ marginTop: 22, display: 'flex', alignItems: 'center', gap: 14, fontSize: 30, fontWeight: 600, opacity: 0.52 }}>
          <span style={{ display: 'inline-block', width: 30, height: 6, borderRadius: 999, background: BILI_BLUE }} />
          高亮的是你已经走过的路
        </div>
        {data.notice && (
          <div style={{ marginTop: 18, borderRadius: 20, padding: '16px 28px', fontSize: 30, fontWeight: 600, opacity: 0.62, background: 'rgba(127,127,127,0.12)' }}>{data.notice}</div>
        )}
      </div>
    </DefaultLayout>
  )
})

BilibiliInteractive.displayName = 'BilibiliInteractive'
