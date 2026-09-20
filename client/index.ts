/**
 * kkk 的控制台入口（浏览器端）。
 *
 * 用官方工具 `koishi-console build .` 打包（入口必须是 client/index.ts），产物在 dist/index.js。
 *
 * 面板本体是插件自带的 `/kkk`（独立页面）。qq-chat 那种做法是把界面注册成控制台页面、
 * 天然跟着控制台登录态；独立 URL 没有这层保护，所以这里向服务端要一个「面板 token」：
 *   1. `send('kkk/panel-token')` —— 服务端那个监听器带 authority: 4，
 *      未登录 / 权限不足的控制台客户端根本调不到；
 *   2. 拿到 token 后拼进 iframe 地址（/kkk?panel=<token>），服务端校验通过会给面板发 cookie，
 *      后续静态资源与接口都靠它放行；
 *   3. 拿不到 token（没登录）就只显示提示，不加载面板。
 */
import { send } from '@koishijs/client'
import { computed, defineComponent, h, onMounted, onUnmounted, ref } from 'vue'

export const name = 'kkk-console'

const FALLBACK_ASIDE = 64
const FALLBACK_STATUS = 28

export function apply (ctx: any) {
  ctx.page({
    name: 'kkk 配置',
    path: '/kkk-config',
    desc: '解析 / 面板 / 画质 / 图片切片等设置，改完直接生效',
    authority: 4,
    icon: 'activity:plugin',
    component: defineComponent({
      setup () {
        const style = ref<Record<string, string>>({})
        const status = ref<{ authRequired: boolean } | null>(null)
        const panelToken = ref('')
        const denied = ref(false)
        const sync = () => {
          const aside = document.querySelector('nav.layout-activity') as HTMLElement | null
          const footer = document.querySelector('footer.layout-status') as HTMLElement | null
          const left = aside ? Math.round(aside.getBoundingClientRect().right) || FALLBACK_ASIDE : FALLBACK_ASIDE
          const bottom = (footer ? Math.round(footer.getBoundingClientRect().height) : FALLBACK_STATUS) + 8
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
        onMounted(async () => {
          sync()
          timer = setInterval(sync, 1000)
          window.addEventListener('resize', sync)
          try {
            const res = await fetch('/kkk/api/status').then((r) => r.json())
            status.value = (res && res.data) || null
          } catch {
            status.value = null
          }
          if (!status.value || status.value.authRequired) {
            try {
              const token = await send('kkk/panel-token')
              panelToken.value = typeof token === 'string' ? token : ''
            } catch {
              panelToken.value = ''
            }
            denied.value = !panelToken.value
          }
        })
        onUnmounted(() => {
          if (timer) clearInterval(timer)
          window.removeEventListener('resize', sync)
        })
        const src = computed(() => {
          const s = status.value
          if (s && s.authRequired === false) return '/kkk'
          return panelToken.value ? '/kkk?panel=' + encodeURIComponent(panelToken.value) : ''
        })
        return () => {
          if (src.value) return h('iframe', { src: src.value, style: style.value })
          return h('div', {
            style: { display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'center', justifyContent: 'center', height: '100%', fontFamily: 'system-ui', color: '#666' }
          }, [
            h('h2', { style: { margin: 0, fontSize: '20px' } }, denied.value ? '请先登录 Koishi 控制台' : '正在打开配置面板……'),
            denied.value ? h('p', { style: { margin: 0 } }, '登录后即可打开 kkk 配置面板。') : null,
            denied.value ? h('a', { href: '/login', style: { color: '#3b82f6' } }, '去登录') : null
          ])
        }
      }
    })
  })
}
