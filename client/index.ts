/**
 * kkk 的控制台入口（浏览器端）。
 *
 * 用官方工具 `koishi-console build .` 打包：它期望入口是 client/index.ts，
 * 打完会把依赖（vue 等）一起 bundle，浏览器直接加载 —— 之前手写的 .js 里有裸 import，
 * 浏览器解析不了，所以侧边栏一直看不到这个入口。
 */
import { defineComponent, h } from 'vue'

export const name = 'kkk-console'

export function apply (ctx: any) {
  ctx.page({
    name: 'kkk 配置',
    path: '/kkk-config',
    desc: '解析面板 / 画质 / 番剧表格 / 图片切片等设置（保存写回 koishi.yml）',
    authority: 4,
    icon: 'settings',
    component: defineComponent({
      setup () {
        return () => h('iframe', {
          src: '/kkk',
          style: 'width:100%;height:calc(100vh - 120px);border:0;border-radius:8px;background:#fff'
        })
      }
    })
  })
}