/** 互动视频「剧情图」卡片的数据（路由 index.tsx 与 components/ 共用）。 */

/** 思维导图上的一个分支 */
export interface InteractiveMapChoice {
  label: string
  text: string
  isDefault?: boolean
  /** 这一段下面的子树；没有就是结局 */
  children?: InteractiveMapNode[]
}

/** 思维导图上的一个节点（= 一段剧情） */
export interface InteractiveMapNode {
  /** 这一段的题目，B站 可能给空串 */
  question: string
  isLeaf: boolean
  /** 分支没展开完（预算用尽） */
  truncated?: boolean
  choices: InteractiveMapChoice[]
}

/** `#kkk` 互动视频剧情图卡片 */
export interface BilibiliInteractiveData {
  title: string
  step: number
  path: string[]
  question?: string
  notice?: string
  /** 根节点的文字：第一张图是「开场」，补画时是「当前 · 这一段」 */
  rootLabel?: string
  /** 整张剧情图（爬到了就画思维导图） */
  graph?: InteractiveMapNode
  /** 图没爬完，卡片上要标注 */
  truncated?: boolean
  /** 爬不到图时的兜底：当前这一段的分支 */
  choices?: Array<{ label: string; text: string; isDefault?: boolean }>
}
