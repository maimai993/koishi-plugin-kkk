/**
 * \`@kkk/richtext\` 的移植入口（覆盖上游 packages/richtext 的全部导出）。
 *
 * core 侧只用 parse + types（生成可序列化节点），模板侧用 react（把节点渲染成 React）。
 * 两边都在这里导出，与上游 \`src/index.ts\` 一致。
 */
export * from './parse'
export * from './types'
export * from './react'
