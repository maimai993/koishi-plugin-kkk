/**
 * 模板路由表（构建期生成的等价物）。
 *
 * 上游由 ktr 的 \`ktr sync\` 扫描 \`template/<板块>/<模板>/index.tsx\` 生成 \`.ktr\` 注册表；
 * 这里改成**惰性动态 import**：
 *   - 不必为 35 个模板的依赖（echarts / heroui / 图标库…）在启动时全部付代价；
 *   - 某个模板缺依赖时只有它自己失败，不会拖垮整个插件（Render 会回退到内置卡片）。
 */
export type TemplateLoader = () => Promise<{ default?: any }>

export const templateRegistry: Record<string, TemplateLoader> = {
  'bilibili/bangumi': () => import('./template/bilibili/bangumi'),
  'bilibili/comment': () => import('./template/bilibili/comment'),
  'bilibili/dynamic/DYNAMIC_TYPE_ARTICLE': () => import('./template/bilibili/dynamic/DYNAMIC_TYPE_ARTICLE'),
  'bilibili/dynamic/DYNAMIC_TYPE_AV': () => import('./template/bilibili/dynamic/DYNAMIC_TYPE_AV'),
  'bilibili/dynamic/DYNAMIC_TYPE_DRAW': () => import('./template/bilibili/dynamic/DYNAMIC_TYPE_DRAW'),
  'bilibili/dynamic/DYNAMIC_TYPE_FORWARD': () => import('./template/bilibili/dynamic/DYNAMIC_TYPE_FORWARD'),
  'bilibili/dynamic/DYNAMIC_TYPE_LIVE_RCMD': () => import('./template/bilibili/dynamic/DYNAMIC_TYPE_LIVE_RCMD'),
  'bilibili/dynamic/DYNAMIC_TYPE_WORD': () => import('./template/bilibili/dynamic/DYNAMIC_TYPE_WORD'),
  'bilibili/interactive': () => import('./template/bilibili/interactive'),
  'bilibili/qrcodeImg': () => import('./template/bilibili/qrcodeImg'),
  'bilibili/userlist': () => import('./template/bilibili/userlist'),
  'bilibili/videoInfo': () => import('./template/bilibili/videoInfo'),
  'douyin/article-work': () => import('./template/douyin/article-work'),
  'douyin/comment': () => import('./template/douyin/comment'),
  'douyin/dynamic': () => import('./template/douyin/dynamic'),
  'douyin/favorite-list': () => import('./template/douyin/favorite-list'),
  'douyin/image-work': () => import('./template/douyin/image-work'),
  'douyin/live': () => import('./template/douyin/live'),
  'douyin/musicinfo': () => import('./template/douyin/musicinfo'),
  'douyin/qrcodeImg': () => import('./template/douyin/qrcodeImg'),
  'douyin/recommend-list': () => import('./template/douyin/recommend-list'),
  'douyin/userlist': () => import('./template/douyin/userlist'),
  'douyin/user_profile': () => import('./template/douyin/user_profile'),
  'douyin/video-work': () => import('./template/douyin/video-work'),
  'kuaishou/comment': () => import('./template/kuaishou/comment'),
  'other/changelog': () => import('./template/other/changelog'),
  'other/handlerError': () => import('./template/other/handlerError'),
  'other/help': () => import('./template/other/help'),
  'other/live-photo-tip': () => import('./template/other/live-photo-tip'),
  'other/qrlogin': () => import('./template/other/qrlogin'),
  'other/runtime': () => import('./template/other/runtime'),
  'other/version_warning': () => import('./template/other/version_warning'),
  'statistics/global': () => import('./template/statistics/global'),
  'statistics/group': () => import('./template/statistics/group'),
  'xiaohongshu/comment': () => import('./template/xiaohongshu/comment'),
  'xiaohongshu/noteInfo': () => import('./template/xiaohongshu/noteInfo')
}

/** 取某个路由的模板定义（不做缓存，模块本身有 require 缓存） */
export async function loadTemplate (route: string) {
  const loader = templateRegistry[route]
  if (!loader) return undefined
  const mod: any = await loader()
  return mod?.default ?? mod
}
