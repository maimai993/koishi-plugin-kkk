/**
 * \`@heroui/react\` 的最小兼容实现（Koishi 迁移补充）。
 *
 * 上游只有 4 个模板用到 HeroUI，且只用到 \`Chip\` 与 \`Button\` 两个展示型组件。
 * 而 @heroui/react v3 是 **ESM-only**（package.json 里 exports 只有 import 条件，没有 CJS 产物），
 * 我们的 CJS 产物（tsc 直出、无打包器）没法 require 它。
 *
 * 这里用同语义的普通元素实现：调用方本来就通过 \`className\` / \`style\` 传入了绝大多数样式，
 * 海报又是静态 HTML（没有交互），因此渲染结果与 HeroUI 基本一致。
 */
import React from 'react'

interface CompatProps {
  size?: 'sm' | 'md' | 'lg'
  color?: string
  variant?: string
  className?: string
  style?: React.CSSProperties
  children?: React.ReactNode
  [key: string]: unknown
}

const join = (...parts: Array<string | undefined | false>) => parts.filter(Boolean).join(' ')

/** 对应 HeroUI 的 Chip（标签/徽章） */
export const Chip = ({ size = 'md', color, variant, className, style, children, ...rest }: CompatProps) => (
  <span
    className={join('inline-flex items-center justify-center rounded-full leading-none', className)}
    style={style}
    data-color={color}
    data-variant={variant}
    data-size={size}
    {...(rest as any)}
  >
    {children}
  </span>
)

/** 对应 HeroUI 的 Button（静态海报里就是一块按钮样式的容器） */
export const Button = ({ size = 'md', color, variant, className, style, children, ...rest }: CompatProps) => (
  <span
    className={join('inline-flex items-center justify-center gap-2 rounded-xl font-medium', className)}
    style={style}
    data-color={color}
    data-variant={variant}
    data-size={size}
    {...(rest as any)}
  >
    {children}
  </span>
)

export default { Chip, Button }
