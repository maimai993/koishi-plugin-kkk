/**
 * kkk 的控制台入口。
 *
 * 和 qq-chat 一样用 `ctx.page` 注册一个控制台页面，区别是这里不打包前端：
 * 页面里直接嵌一个 iframe 指向插件自己提供的配置页（/kkk），改完保存即写回 koishi.yml。
 */
import { defineComponent, h } from 'vue'

export default (ctx) => {
  ctx.page({
    name: 'kkk 配置',
    path: '/kkk-config',
    desc: '解析面板 / 画质 / 番剧表格等设置（保存写回 koishi.yml）',
    authority: 4,
    icon: 'settings',
    component: defineComponent({
      setup() {
        return () => h('iframe', {
          src: '/kkk',
          style: 'width:100%;height:calc(100vh - 120px);border:0;border-radius:8px;background:#fff'
        })
      }
    })
  })
}
