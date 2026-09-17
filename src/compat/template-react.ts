/**
 * `@karinjs/template-react` 的最小兼容实现（Koishi 迁移补充）。
 *
 * 上游模板通过 ktr 约定注册：`export default defineTemplate({ name, description, component, validate })`，
 * 由 ktr 的构建产物（SSR 外壳）负责按路由装配与渲染。
 * 这里不需要 ktr 的构建管线，只要把注册对象原样返回，渲染由 `module/utils/Render` 直接做 React SSR。
 */

/** 模板上下文（ktr 的 RenderContext 子集，模板只读这几个字段） */
export interface RenderContext {
  /** 渲染缩放，由外壳施加到 #container */
  scale?: number
  /** 主题，明暗只走 theme.mode */
  theme?: { mode?: 'light' | 'dark' }
  /** 版本信息，模板页脚展示 */
  version?: {
    plugin?: string
    pluginName?: string
    pluginVersion?: string
    releaseType?: string
    poweredBy?: string
    frameworkVersion?: string
    hasUpdate?: boolean
  }
  /** 封面氛围背景参数 */
  ambientCover?: Record<string, unknown>
  [key: string]: unknown
}

export interface TemplateDefinition<T = any> {
  name?: string
  description?: string
  component: (props: any) => any
  validate?: (data: unknown) => data is T
  [key: string]: unknown
}

/** 模板注册：原样返回即可 */
export function defineTemplate<T = any> (options: TemplateDefinition<T>): TemplateDefinition<T> {
  return options
}

/** ktr 里负责拼 HTML 外壳的类，这里仅保留类型占位（预览工具用到） */
export class HtmlWrapper {
  constructor (public options?: Record<string, unknown>) {}
  loadInlineCss (_path: string): string { return '' }
}

/** ktr 里解析模板样式的辅助函数 */
export function resolveTemplateStyle (options?: Record<string, unknown>): string {
  return String((options as any)?.cssPath ?? '')
}

export default { defineTemplate, HtmlWrapper, resolveTemplateStyle }
