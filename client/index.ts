/**
 * kkk 的控制台入口（浏览器端）。
 *
 * 面板本体是插件自带的 `/kkk`（独立页面），独立 URL 没有控制台那层保护，
 * 所以这里负责把「控制台已登录」这件事告诉面板。两条路依次尝试：
 *   1. RPC `kkk/panel-token`（服务端监听器带 authority: 4，未登录根本调不到）；
 *   2. 控制台 store 里的 user。
 * 拿到凭据后拼进 iframe 地址；两条路都不行才显示「请先登录」，并把最后一条错误原因带上，
 * 方便一眼看出是没登录还是别的什么问题。
 */
import { send, store } from '@koishijs/client'
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
        const target = ref('')
        const reason = ref('')
        const ready = ref(false)
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

        const openPanel = async () => {
          let required = true
          try {
            const res = await fetch('/kkk/api/status').then((r) => r.json())
            status.value = (res && res.data) || null
            required = !status.value || status.value.authRequired !== false
          } catch {
            status.value = null
          }
          if (!required) { target.value = '/kkk'; ready.value = true; return }

          // 1. RPC 换面板 token
          try {
            const token = await send('kkk/panel-token')
            if (typeof token === 'string' && token) { target.value = '/kkk?panel=' + token; ready.value = true; return }
            reason.value = 'RPC 没有返回 token'
          } catch (error: any) {
            reason.value = 'RPC 失败: ' + String(error?.message ?? error)
          }

          // 2. store 里的 user（老版本控制台可能只在这里放登录信息）
          try {
            const user: any = (store as any)?.user
            if (user?.token && user?.id) {
              target.value = '/kkk?uid=' + user.id + '&token=' + user.token
              ready.value = true
              return
            }
          } catch (error: any) {
            reason.value = reason.value || '读取 store.user 失败: ' + String(error?.message ?? error)
          }
          ready.value = true
        }

        onMounted(() => {
          sync()
          timer = setInterval(sync, 1000)
          window.addEventListener('resize', sync)
          void openPanel()
        })
        onUnmounted(() => {
          if (timer) clearInterval(timer)
          window.removeEventListener('resize', sync)
        })

        const src = computed(() => target.value)
        return () => {
          if (src.value) return h('iframe', { src: src.value, style: style.value })
          if (!ready.value) return h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#666', fontFamily: 'system-ui' } }, '正在打开配置面板……')
          return h('div', {
            style: { display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'center', justifyContent: 'center', height: '100%', fontFamily: 'system-ui', color: '#666' }
          }, [
            h('h2', { style: { margin: 0, fontSize: '20px' } }, '请先登录 Koishi 控制台'),
            h('p', { style: { margin: 0 } }, '登录后即可打开 kkk 配置面板。'),
            reason.value ? h('p', { style: { margin: 0, fontSize: '12px', color: '#999' } }, reason.value) : null,
            h('a', { href: '/login', style: { color: '#3b82f6' } }, '去登录')
          ])
        }
      }
    })
  })
}