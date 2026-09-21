# koishi-plugin-kkkshot

给 [koishi-plugin-kkk](../koishi-plugin-kkk) 用的**高速截图服务**：注册一个 `kkkshot` 服务，
kkk 检测到这个服务时会**默认用它渲染卡片**（不用改 kkk 的任何配置）。

## 为什么需要它

kkk 原来走 `koishi-plugin-puppeteer` 的常规用法：**每次渲染都新开一个页面**，
用 `waitUntil: 'networkidle0'` 等「网络空闲」（本地卡片文件也要白等 500ms 的静默期），
再整屏截图。卡片一多（解析面板、信息卡、评论区、番剧选集…）就很慢。

kkkshot 的做法：

| | 常规 puppeteer 用法 | kkkshot |
|---|---|---|
| 浏览器 | 复用（puppeteer 服务） | 复用（**优先复用 puppeteer 服务的浏览器**，没有才自己起） |
| 页面 | **每次新建 + 关闭** | **常驻页面池**（默认 2 个页面反复用） |
| 等待 | `networkidle0`（500ms 静默期 + 所有请求结束） | `domcontentloaded` + **只等字体和图片**（`document.fonts.ready` + 图片 `complete/decode`） |
| 截图范围 | 整屏（容易带白边） | 按卡片元素自己的盒子 `clip`，并把页面底色设成卡片底色 |
| 内存 | 页面频繁创建/销毁 | 页面用满 N 次后回收重建，防止长跑泄漏 |

> 本机实测（1440 宽、JPEG、2x、同一张卡片连续渲染）：
> **常规用法约 1.6s / 张 → kkkshot 约 0.55s / 张（快 2.7~2.9 倍）**。
> 卡片里带**连不上的远程封面**时差距更大：常规用法会一直等到网络空闲超时
> （线上实测有一张卡片渲染了 **35 秒**），kkkshot 由 `imageWaitMs`（默认 5 秒）兜住，实测 **5.6 秒**出图。

## 安装

```bash
npm i koishi-plugin-kkkshot
```

装完在 Koishi 里启用即可（`koishi-plugin-kkk` 会自动优先用它）。
不想用了就把它停掉，kkk 会自动退回 `koishi-plugin-puppeteer`，行为与以前一致。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `reusePuppeteer` | `true` | 复用 `ctx.puppeteer`（koishi-plugin-puppeteer / puppeteer-without-canvas）的浏览器；关掉则自己启动一个 |
| `executablePath` | 空 | 自己启动时的浏览器路径，留空会自动找 |
| `headless` | `true` | 无头模式 |
| `args` | `[]` | 额外的浏览器启动参数 |
| `pages` | `2` | 常驻页面数（同时渲染的上限） |
| `recycleAfter` | `100` | 一个页面用多少次后回收重建 |
| `deviceScaleFactor` | `2` | 默认缩放（kkk 自己会按配置的 `renderScale` 传） |
| `timeout` | `15000` | 单次渲染超时（毫秒） |
| `waitImages` | `true` | 等页面里的图片加载完（封面图这类必须等） |
| `imageWaitMs` | `5000` | 等图片的**上限**：远程封面慢或连不上时不会把整次渲染拖住 |
| `waitFonts` | `true` | 等字体加载完 |
| `fontWaitMs` | `3000` | 等字体的上限 |
| `warmup` | `true` | 启动时预热一个页面，第一张卡片也不慢 |

## 给别的插件用

```js
// ctx.kkkshot 的接口
await ctx.kkkshot.render(htmlString, { selector: '#container', format: 'jpeg', quality: 92 })   // → Buffer
await ctx.kkkshot.renderFile('/path/to/card.html', { selector: '#container', deviceScaleFactor: 2 }) // → Buffer
ctx.kkkshot.stats()   // { renders, errors, avgMs, lastMs, pages, browserFrom }
await ctx.kkkshot.warmup()
```

想强制依赖它，就在自己的插件里写 `inject: ['kkkshot']`（可选依赖写 `inject: { optional: ['kkkshot'] }`）。

## 许可

MIT
