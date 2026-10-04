/**
 * 拼「给用户点的链接」时要用的两个小东西：本机 IP 和 Koishi 真正在听的端口。
 *
 * 在线播放（`/kkk/player/...`）和人机验证页（`/kkk/geetest`）都要拼这种链接，
 * 两边各写一份必然漂移（比如哪天修了端口取法，只修一边），所以抽到这里共用。
 */
import os from 'node:os'

import { tryGetRuntime } from './runtime'

/** 取一个本机可访问的 IPv4（没配公网地址时的兜底） */
export function localAddress (): string {
  try {
    const interfaces = os.networkInterfaces()
    for (const name of Object.keys(interfaces)) {
      for (const info of interfaces[name] ?? []) {
        if (info.family === 'IPv4' && !info.internal) return info.address
      }
    }
  } catch { /* 拿不到就用回环地址 */ }
  return '127.0.0.1'
}

/**
 * Koishi 自己监听的端口（没配独立端口、或者端口不安全退回时，链接得指向它）。
 *
 * **优先读 `ctx.server.port`** —— 那才是真正 listen 的端口
 * （@cordisjs/plugin-server 在 ready 时写入）。配置树里那份 `port` 常常取不到：
 * 这台部署的端口是写在 server 插件自己的作用域里的（`group:server → server.port: 5200`），
 * 只读 `ctx.config / ctx.root.config` 会拿到默认值 5140，链接就指错端口了（真踩过）。
 * 注意 ready 之前 `server.port` 还是 undefined，所以这里保留后面的兜底。
 */
export function koishiPort (): number {
  const ctx: any = tryGetRuntime()?.ctx
  const candidates = [
    ctx?.server?.port,
    ctx?.config?.port,
    ctx?.root?.config?.port,
    ctx?.app?.options?.port,
    process.env.PORT
  ]
  for (const value of candidates) {
    const num = Number(value)
    if (Number.isFinite(num) && num > 0) return num
  }
  return 5140
}
