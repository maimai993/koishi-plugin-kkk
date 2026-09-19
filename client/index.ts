/**
 * kkk 的控制台入口（浏览器端）。
 *
 * 用官方工具 `koishi-console build .` 打包（入口必须是 client/index.ts），
 * 产物在 dist/index.js，依赖已一起 bundle，浏览器可直接加载。
 *
 * 页面本体是个 iframe，指向插件自己的配置面板 `/kkk`（原版 SPA，免登录）。
 * 注意：控制台把自定义页面直接挂在 #app 下，**不在布局里**，所以左侧那条图标栏
 * （nav.layout-activity，fixed、64px、z-index 100）和底部状态栏会盖在页面上，
 * 而 iframe 默认高度只有 150px。这里在挂载后量一下这两条的实际尺寸，
 * 把 iframe 摆到它们右边的剩余区域，并随窗口变化跟着更新。
 */
import { defineComponent, h, onMounted, onUnmounted, ref } from 'vue'

export const name = 'kkk-console'

const FALLBACK_ASIDE = 64
const FALLBACK_STATUS = 28

export function apply (ctx: any) {
  ctx.page({
    name: 'kkk 配置',
    path: '/kkk-config',
    desc: '解析 / 面板 / 画质 / 图片切片等设置，改完直接生效',
    authority: 4,
    // 图标名要来自控制台内置图标集（activity:*），写错了侧边栏会是一片空白
    icon: 'activity:plugin',
    component: defineComponent({
      setup () {
        const style = ref<Record<string, string>>({})
        const sync = () => {
          const aside = document.querySelector('nav.layout-activity') as HTMLElement | null
          const status = document.querySelector('footer.layout-status') as HTMLElement | null
          const left = aside ? Math.round(aside.getBoundingClientRect().right) || FALLBACK_ASIDE : FALLBACK_ASIDE
          const bottom = (status ? Math.round(status.getBoundingClientRect().height) : FALLBACK_STATUS) + 8
          style.value = {
            position: 'fixed',
            left: left + 'px',
            top: '0px',
            width: 'calc(100vw - ' + left + 'px)',
            height: 'calc(100vh - ' + bottom + 'px)',
            border: '0',
            display: 'block',
            background: '#fff',
            zIndex: '1'
          }
        }
        let timer: any = null
        onMounted(() => {
          sync()
          // 侧边栏会随窗口宽度/悬浮展开，量一次不够，定时校准最省心
          timer = setInterval(sync, 1000)
          window.addEventListener('resize', sync)
        })
        onUnmounted(() => {
          if (timer) clearInterval(timer)
          window.removeEventListener('resize', sync)
        })
        return () => h('iframe', { src: '/kkk', style: style.value })
      }
    })
  })
}
