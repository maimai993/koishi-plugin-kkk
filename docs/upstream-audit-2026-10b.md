# 上游 karin-plugin-kkk 变更对照审查（第二批）

对照对象：`ikenxuan/karin-plugin-kkk` 的 8 个 commit（2026-09-27 ~ 2026-10-05）
对照基准：本地 `E:/devkoishi/plugins/koishi-plugin-kkk`（v3.14.0）
审查方式：GitHub API 逐个取 commit 的文件清单与 patch，再在本地源码里逐条核对

> 路径映射同第一批：`packages/core/` → 根目录，`packages/core/src/` → `src/karin/`，
> `packages/core/ktr/` → `src/ktr/`，`packages/richtext/` → `src/richtext/`。

---

## 结论速览

| # | commit | 标题 | 本地状态 |
|---|--------|------|----------|
| 1 | `0e8f479` | ktr：评论与动态正文 Unicode emoji 使用 Apple 图源渲染 | ✅ **已移植**（新增 102MB 可选依赖，见下） |
| 2 | `3E13D29` | 抖音：剧集视频类型 | ✅ **已移植**（`aweme_type` 补 `4`） |
| 3 | `01d3f72` | douyin：缓解接口 403 / uifid not found | ✅ **随第 8 条升上来了**（需联网实测确认） |
| 4 | `840CE1a` | 抖音：评论图二维码改用 www.douyin.com 规范短链 | ✅ **已移植** |
| 5 | `3da33b2` | ktr：登录二维码模板去掉 font-sans | ✅ **已移植** |
| 6 | `a232c68` | 优化部分错误提示 | ✅ **已移植**（新增「响应体原文」块） |
| 7 | `9a83c49` | 修复链接解析 SSRF 并将视频预览改为令牌寻址 | ✅ **已移植**（安全修复，最值得搬） |
| 8 | `A10A50D` | AMAGI 更新 | ✅ **已升到 beta.8**（4 条类型错误已修；**另需 zod 4**，见下） |

---

## 1. `0e8f479` Unicode emoji 用 Apple 图源 —— ✅ 已移植

### 上游改了什么

容器里没有系统 emoji 字体，评论/动态正文里的 🔥、❤ 之类纯字体渲染会显示成**方格**。
上游把文本节点按 emoji 序列切开，每个序列换成独立的 `emoji` 节点、内联 Apple 64px PNG。

- 新增 `packages/richtext/src/parse/unicodeEmoji.ts`：分词器 + 图源解析器注入口
  （`setUnicodeEmojiSrcResolver`）；richtext 保持零 Node 依赖，浏览器端不注册就退化成文本；
- 新增 `emojiAssets.generated.ts`：3793 个文件名的清单，由 `scripts/gen-emoji-assets.mjs`
  从 `emoji-datasource-apple` 的 `img/apple/64/` 生成；
- `createRichTextDocument` 对 text 节点做 `applyUnicodeEmoji`（`scale: 0.8`）；
- 新增 `src/module/utils/emojiAssets.ts`：读包内 PNG 转 `data:` URL，被 `Render/index.ts` 引入即注册。

### 本地怎么落的

全搬。清单文件体积太大没进 patch，改从 GitHub API 按 blob sha 取（`787a3e7…`，与 commit
记录一致），落盘后与本地安装的包做了**一一对应校验**（3793 ↔ 3793，无缺无多）。

**三处移植调整（upstream 代码直接跑不通）**：

1. `createRequire(import.meta.url)` → `createRequire(__filename)`：
   本地 `tsc` 的 `module: commonjs`，TS 里写 `import.meta` 直接编译报错
   （`karin/root.ts` 里已有同一处移植说明）。
2. 图源包放 **`optionalDependencies`** 而不是 `dependencies`：
   `emoji-datasource-apple@16.0.0` 解包 **102MB / 3816 文件**。上游自己写了「包缺失时
   解析器返回 null、emoji 回退文本、不阻断启动」的退路，所以做成可选是安全的；
   正常 `npm i` 照样会装上，行为与上游一致。
3. `getAssetDir` 补了一个 `assetDirLooked` 标志：上游只在解析成功时写 `assetDir`，
   包缺失时它一直是 `null`，于是**每个 emoji 都会重新 resolve 一次并重复打一条 warn**。

### 文件名兜底（这层的意义）

数据集里 ❤ 只落盘为 `2764-fe0f`、keycap 只落盘为 `0039-fe0f-20e3`，而评论原文大量是
**裸 ❤（无 VS16）**。所以 `filenameCandidates` 依次试「原样 → 补 VS16 → 去 VS16」；
反过来 ™ © ® 裸用时按文字渲染（带 VS16 才算表情）。这些都进了探针。

---

## 2. `3E13D29` 抖音剧集视频类型 —— ✅ 已移植

`src/karin/platform/douyin/douyin.ts`：

```ts
const isVideo = aweme_type === 0 || aweme_type === 4 || aweme_type === 55
```

补了 `4`（剧集合集）。原来只认 `0`（普通视频）与 `55`（部分图集形态），
剧集链接会掉到「非视频」分支。

---

## 3. `01d3f72` 抖音 403 / uifid not found —— ⚠️ 随第 8 条一起升（但要实测）

整个 commit 只有两处实质改动：

- `packages/amagi` 子模块指针 `07bca13` → `3f4e2dc`；
- `packages/core/package.json` 里 `@ikenxuan/amagi` 从 `7.0.0-beta.6` 改成 `workspace:*`。

**修在 amagi 里，core 侧没有可搬的代码。** 对本地而言唯一能做的是升 amagi 版本。
按 npm 发布时间：`beta.6` = 09-29、`beta.7` = 10-02、**`beta.8` = 10-05 11:51**
（这个 commit 是 10-05 06:51），所以 `beta.8` 大概率带上了这个修复。
升的代价见第 8 条（4 条类型错误，无运行时破坏），**但修没修好要联网实测**。

---

## 4. `840CE1a` 评论图二维码改用规范短链 —— ✅ 已移植

`douyin.ts` 的 `share_url`：

```ts
share_url: isVideo && selectedVideo
  ? buildDouyinPlayUrl(selectedVideo.play_addr)
  : `https://www.douyin.com/${isArticle ? 'article' : 'note'}/${aweme.aweme_id}`
```

非视频（图文/文章）分支原来是别的形态；改成 `www.douyin.com` 规范短链后，
评论图里那张二维码扫出来的地址才稳定。

---

## 5. `3da33b2` 登录二维码模板去掉 font-sans —— ✅ 已移植

`src/ktr/template/{bilibili,douyin}/qrcodeImg/components/qrcodeImg.tsx`：
`className="relative overflow-hidden font-sans"` → `"relative overflow-hidden"`。

容器内没有 `font-sans` 对应的字体族时，二维码会渲染成**一片方格**。

---

## 6. `a232c68` 优化部分错误提示 —— ✅ 已移植

错误卡片多一块「响应体原文」，并把上面那句的标签改成动态的：

- `ErrorHandler/render.ts` 新增 `rawTextOf(error)` + `RAW_TEXT_LIMIT = 500`，
  **只收字符串 body**（那正是 judge 判 `ANTIBOT_PAGE` 的反爬页 / Argus 拦截形态）；
- `types.ts` 的 `AmagiErrorDetail` 加 `raw?: string`；
- `handlerError.tsx`：标签 `data.amagi.raw ? '错误说明' : '平台原文'`，
  有 `raw` 时补一块 `<pre>`（带 `FileWarning` 图标）。

**为什么值得搬**：字符串 body 下 amagi 的 `extractPlatformMessage` 一律返回 `undefined`，
`reason` 必然是它自己的兜底句「平台返回了反爬页面」。继续印「平台原文」会让看图的人
以为那是抖音/B站说的 —— 平台究竟回了什么只在这一块里。

---

## 7. `9a83c49` SSRF + 预览令牌寻址 —— ✅ 已移植（安全修复，最值得搬）

### 7a. 抖音 CDN 直链：整条消息 test → 逐个 URL 校验

`apps/tools.ts` 删掉 `reg.douyinCDN`，换成 `parseDouyinPlayUrl(msg)`：
逐个 `matchAll(/https?:\/\/[^\s]+/gi)` 解析，严格比对
`hostname === 'aweme.snssdk.com'` 且 `pathname` 以 `/aweme/v1/play` 开头。

旧写法是**非锚定正则 test 整条消息、再把整条消息当 URL 交给下载器** ——
消息里只要混入那个子串（哪怕放在别的地方）就能让 bot 去拉任意 URL。

### 7b. 短链展开前校验域名

`platform/douyin/getID.ts` 加 `isDouyinUrl`（`douyin.com` / `iesdouyin.com`）、
`platform/xiaohongshu/getID.ts` 加 `isXiaohongshuUrl`（`xiaohongshu.com` / `xhslink.com` /
`xhslink.cn`）。不是自家域名就不发请求，直接走既有「无法提取 ID」兜底。

### 7c. 二维码识别前校验公网地址

`Common.tryScanImageQrCode` 开头加 `isSafePublicHttpUrl`：只放行 http(s)，
拒绝 `localhost` / `*.local` / `*.internal` 与 IPv4/IPv6 的内网字面量
（0/8、10/8、127/8、169.254/16、172.16-31、192.168/16、100.64-127，`::1`、`fe80::/10`、`fc00::/7`）。
引用消息里的图片地址是**外部可控**的，这一步挡的是内网探测。

### 7d. 视频预览改令牌寻址

- `Common.registerVideoPreview` 签发 `crypto.randomBytes(8).toString('hex')`，
  `videoPreviewState` 的 key 从 filename 换成 token；同名重复注册复用原令牌；
- `getVideoPreview(token)`；新增私有 `findPreviewByFilename`；
  `markVideoPreviewRemoved` 兼容「绝对路径 / 令牌」两种入参；
- **删掉 `validateVideoRequest`**（原来那套路径穿越校验不需要了）；
- 路由 `/stream/:filename`、`/video/:filename`、`/video/:filename/events`
  → `:token`；控制器统一走 `resolvePreviewByParam`；
- SSE payload **不再下发 `filePath`**（服务器本地路径不对外暴露）；
- `Base.uploadFile` 的日志预览地址改用 `previewInfo.token`。

---

## 8. `A10A50D` AMAGI 更新 —— ⚠️ 可以升，代价是 4 条类型错误

`7.0.0-beta.4` → `7.0.0-beta.6`（连带 `protobufjs` 8.7.1→8.8.0、`zod` 4.4.3→4.6.5，
去掉 `chalk` 依赖）。本地 `beta.5`，已比 `beta.4` 新。

### ⚠️ 更正：一度误判为「升不上去」

初版报告写的是「beta.6 起 `RiskChallenge` 被换名、升不上去」，**这个结论是错的**，
成因是查证方式有问题：当时只 grep 了 `dist/index-*.d.ts` 这**一个 rollup chunk**，
而 `RiskChallenge` 定义在 `endpoint-*.d.ts` 那个 chunk 里 —— beta.5 恰好把它内联进了
index chunk、beta.8 做了 chunk 拆分，于是「beta.5 搜得到、beta.8 搜不到」，
看着像被删了，其实只是搬家。

**正确的查法是比对外契约**（`package.json` 的 `types` 指向的 `dist/default/index.d.ts`）：

```
beta.5 对外导出 421 | beta.8 对外导出 421
beta.8 移除 (0) / 新增 (0)
RiskChallenge  β5✓ β8✓（接口定义逐字段一致：url / jsSdkUrl / session / bizName / result）
错误契约的 challenge?: RiskChallenge  β5✓ β8✓
```

`CaptchaChallenge` / `LoginChallenge` / `SmsChallenge` / `KuaishouCaptchaChallenge`
这些**beta.5 里本来就有**，不是 beta.6 新增的。

### 实测：升到 beta.8 的实际代价（tsc 121 → 125，仅 4 条）

用「装 beta.8 → tsc → 换回 beta.5 → tsc → diff」实测出来的新增错误：

| 位置 | 报错 | 运行时影响 |
|------|------|-----------|
| `platform/douyin/douyin.ts:1296` | `room_id` 不在 `PublicParamsOf<…>` 里 | 无（见下） |
| `platform/douyin/push/live.ts:51` | 同上 | 无 |
| `apps/testPush.ts:195` | 同上 | 无 |
| `platform/bilibili/bilibili.ts:1492` | `number` 不能赋给 `33 \| 1 \| 5 \| …` | 无（类型收紧） |

**`room_id` 那条为什么不影响运行时**：beta.8 把它标成了 `InternalParam`
（意思是「你不该传，它能从 `web_rid` 推出来」）。但 `internalParamKeysOf`
这个运行时函数**只有一个调用点** —— `parametersOf`，而那是**生成 OpenAPI 文档**
用的过滤器。请求构建路径完全不读它，所以传 `room_id` 照样带上、行为不变。

三处都是 `fetchLiveRoomInfo({ room_id, web_rid })`，修起来就是加个类型断言
（保留传值，零行为变化），或者确认 amagi 能自己推导后把 `room_id` 删掉
（**后者需要联网实测一次抖音直播**才能定）。

### ⚠️ 更要紧的一条：beta.8 需要 **zod 4** 才能真正加载

上面那 4 条只是类型。**真正的破坏点在这里**，而且 tsc 完全看不出来：

```
beta.5  require ✓
beta.8  require ✗  schema.meta is not a function
```

两版 `package.json` 声明的 zod **都是 `4.6.5`**，但本机 root 实际生效的是 **zod 3.25.76**。
beta.5 侥幸没碰 zod 4 独有的 API 所以能跑；beta.8 用了 `.meta()`（zod 4 才有），
于是**插件一启动就崩**，报错还指向 amagi 内部（`schema.meta`），看不出是 zod 的问题。

所以升级是两件事：
1. amagi → `beta.8`；
2. **确保 zod 4 对 amagi 可见**（npm 正常会嵌套装一份；本机是手工补到
   `node_modules/@ikenxuan/amagi/node_modules/zod` 的，因为 npm 当时撞了 502）。

发布后用户 `npm install` 时 npm 会按 amagi 的依赖解析；**只有当某个包依赖 zod 3
且 npm 决定把 zod 4 提升到 root 时，才可能影响那个包** —— 这是这次升级唯一需要
留意的外溢风险。

### 另外：探针里写死了 amagi 的 chunk 文件名

`probe-verify-page.cjs` 曾把路径写成 `dist/src-blqLvYiW.mjs`（beta.5 的 rollup hash），
升级后直接 ENOENT 把整个探针带崩。已改成按 `src-*.mjs` 动态查找。
**教训：rollup 产物的 hash 文件名不能写死。**

### 已升级

- `package.json`：`7.0.0-beta.5` → `7.0.0-beta.8`；
- 4 条类型错误已修（`room_id` × 3 走 `@/platform/douyin/liveParams`，
  bilibili 评论 `type` 把返回类型写成字面量联合）；
- tsc 回到 **121**（与升级前一致）；
- 新增 `scripts/probe-amagi-runtime.cjs`：require 得过 + 导出面 + 版本不漂移。
  （tsc 只能证明类型对，证明不了包能加载 —— 这次就是靠它才没漏掉 zod。）
