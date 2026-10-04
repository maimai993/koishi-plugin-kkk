# 上游 karin-plugin-kkk 变更对照审查

对照对象：`ikenxuan/karin-plugin-kkk` 的 8 个 commit（2026-09-16 ~ 2026-09-22）
对照基准：本地 `E:/devkoishi/plugins/koishi-plugin-kkk`（v3.12.1）
审查方式：GitHub API 逐个取 commit 的文件清单与 patch，再在本地源码里逐条核对

> 说明：上游是 `packages/core` monorepo，本地是 Koishi 单包移植版，
> 路径前缀 `packages/core/` 对应本地根目录，`packages/core/ktr/` 对应本地 `src/ktr/`，
> `packages/core/src/` 对应本地 `src/karin/`。

---

## 结论速览

| # | commit | 标题 | 本地状态 |
|---|--------|------|----------|
| 1 | `ff54ba5` | 优化作品缓存管理，新增续期去重记录功能并调整清理逻辑 | ❌ **未移植**（改动最大，含一个真实 bug 修复） |
| 2 | `677e213` | 评论/笔记二维码统一补作者头像并修复深色模式 | ❌ **未移植**（B站/快手/小红书三张评论卡） |
| 3 | `0659c2b` | fix: xhs comments | ❌ **未移植**（子评论 pictures 类型 + amagi 类型名） |
| 4 | `2fa299a` | ui: 优化部分字体粗细 | ❌ **未移植**（`font-black` → `font-bold`） |
| 5 | `f4b5312` | fix(dy): 修复推送图片获取用户信息的逻辑 | ⚠️ **部分**（拉取路径已是新写法，但缺一层兜底） |
| 6 | `ee22474` | ui: 重写 live phtot tip | ➖ **不适用**（本地这张卡是自研的，跟上游结构不同） |
| 7 | `049eb2f` | deps: update amagi | ➖ **不适用**（本地已用更新的 `7.0.0-beta.5`） |
| 8 | `85088c7` | fix: alias | ➖ **不适用**（上游 monorepo 的 vite alias / workspace 配置） |

**有实际价值的是 1~4 号，其中 1 号除了功能还修了一个会「重推历史作品」的 bug。**

---

## 1. `ff54ba5` 缓存续期去重 —— ❌ 未移植（最值得搬）

### 上游改了什么

把抖音喜欢/推荐列表的去重记录从「**固定 TTL**」改成「**滑动 TTL**」：

- 新增 `DouyinDBBase.touchAwemeCache(sec_uid, pushType, aweme_ids)`：
  每轮推送把「当前列表里全部作品的 `updatedAt`」刷新到当前时间；
- `cleanOldAwemeCache` 的判据从 `createdAt < cutoff` 改成 **`updatedAt < cutoff`**；
- `favorite.ts` / `recommend.ts` 里原来调的 `updateListSnapshot` 换成 `touchAwemeCache`；
- **`push.ts` 里清理的时机从「拉列表之前」挪到「拉列表之后」**。

### 为什么时机也要挪（上游注释写得很清楚）

> 若放在续期之前，升级后旧记录的 `updatedAt` 偏早，会在续期前被按 `updatedAt` 清理掉，
> 导致仍在列表中的历史作品被当作新作品重推一次。

也就是说：**单独改判据而不挪时机，升级的那一刻会把老记录全清掉 → 全量重推一次。**
这两件事必须一起改。

### 本地现状

- `src/karin/module/db/douyin.ts:694` `cleanOldAwemeCache` 仍按 **`createdAt`** 清理；
- 本地有 `updateListSnapshot`（写 `TABLE.douyinListSnapshot`，**另一张表**），
  上游已把它换成 `touchAwemeCache`；
- 本地 `src/karin/platform/douyin/push.ts:85` 清理**仍在** `getDynamicList` 之前；
- `favorite.ts:90` / `recommend.ts:89` 仍调 `updateListSnapshot`。

### 移植要点（本地）

1. `douyin.ts` 加 `touchAwemeCache`；本地是 Koishi 原生 db，写法要用 `this.db.update(...)` 而非原生 SQL 的 `IN (...)`；
2. `cleanOldAwemeCache` 判据 `createdAt` → `updatedAt`；
3. `favorite.ts` / `recommend.ts` 的 `updateListSnapshot` → `touchAwemeCache`；
4. `push.ts` 把清理块挪到 `const data = await this.getDynamicList(...)` **之后**；
5. `updateListSnapshot` 是否保留需确认（本地 `douyinListSnapshot` 表还有没有别的读取方）。

⚠️ 迁移期风险：老记录 `createdAt` 早、`updatedAt` 也早，第一次跑如果先清理后续期，
会重推一轮。所以第 4 点必须和第 2 点同批上线。

---

## 2. `677e213` 评论二维码头像 + 深色模式 —— ❌ 未移植

### 上游改了什么

三张评论卡片（B站/快手/小红书）的二维码从 `generateQRCode()` 换成 `<QRCodeWithAvatar>`，
把作者头像放到二维码正中；`Comment.tsx` 的 types 各加一个 `AuthorAvatar?: string`；
三个平台对应的 `.ts` 在渲染评论卡时把头像传进去。
另外小红书 `noteInfo.tsx` 也补了 `avatarUrl={data.author.avatar}`。

### 本地现状

- ✅ `src/ktr/template/components/QRCodeWithAvatar.tsx` **已存在**（1737 字节），
  抖音评论卡 + 小红书 noteInfo 已经在用；
- ❌ `bilibili/comment`、`kuaishou/comment`、`xiaohongshu/comment` 三处**仍用**
  `import { generateQRCode }` + `<img src={generateQRCode(...)}>`；
- ❌ 这三个 `types.ts` 里**没有** `AuthorAvatar`；
- ❌ `xiaohongshu/noteInfo/components/noteInfo.tsx` 的 `QRCodeWithAvatar` **没传** `avatarUrl`。

### 移植要点（本地）

改 3 张卡的 `Comment.tsx`（换组件）+ 3 个 `types.ts`（加字段）+ 3 个平台 `.ts`（传值）
+ `noteInfo.tsx`（补 `avatarUrl`）。字段名上游统一叫 `AuthorAvatar`，本地照抄即可。
小红书那处的头像来源是 `NoteData.data.data.items[0].note_card.user.avatar`。

---

## 3. `0659c2b` xhs comments —— ❌ 未移植

### 上游改了什么

- `xiaohongshu/comments.ts` 和 `xiaohongshu.ts` 的类型从 `NoteComments`
  换成 **`XiaohongshuNoteCommentsResponse`**（amagi 换名）；
- `xiaohongshu/comment/components/types.ts` 里 **子评论** 的 `pictures` 从 `string[]`
  换成结构化对象数组（`height/width/url_pre/url_default/info_list`）。

### 本地现状

- ❌ 仍在用 `NoteComments`（`comments.ts:1`、`xiaohongshu.ts:7`）；
- ⚠️ `types.ts:54` 的**主评论** `pictures` **已经是**结构化数组了 —— 上游这次改的是
  **子评论**（`types.ts:102` 仍是 `string[]`），本地正好漏的就是这一处；
- ✅ 依赖没问题：本地 amagi `7.0.0-beta.5` **已经导出** `XiaohongshuNoteCommentsResponse`
  （在 `dist/default/index.d.ts` 和 `dist/exports/compat.d.ts` 里都能找到），**不用升依赖**。

### 移植要点（本地）

改 2 处 import/注解 + 1 处子评论 `pictures` 类型。风险低。

---

## 4. `2fa299a` 字体粗细 —— ❌ 未移植

上游把模板里一批 `font-black` 降成 `font-bold`（30 个文件，主要是各卡片的标题/数字）。

本地抽样核对：

| 文件 | 行 | 现况 |
|------|-----|------|
| `bilibili/videoInfo/components/videoInfo.tsx` | 90 | `font-black`（弹幕） |
| 同上 | 125 | `font-black`（标题 h1） |
| `components/DefaultLayout.tsx` | 85 | `font-black` |
| 同上 | 137 | `font-black` |

即本地仍是旧的 `font-black`。这属于纯视觉微调，**30 个文件**搬运量不小、收益很小
（本地还有自研改动，比如 `poweredBy` 那块跟上游已经不一样了），
建议**按需挑几个用户最常看到的卡片改**，不必全量跟。

---

## 5. `f4b5312` dy 推送图片用户信息 —— ⚠️ 部分已覆盖

上游改的是 `douyin/push/render.ts:527`：

```diff
- const user = Detail_Data.user_info?.data?.user ?? Detail_Data.author
+ const user = Detail_Data.user_info?.user ?? Detail_Data.author
```

即去掉中间那层 `.data`。本地 `render.ts:527` **已经是新写法**（`user_info?.user`），
说明这个修复本地已经通过别的方式跟上了。

但本地同文件 **54 行**还留着老写法：

```
src/karin/platform/douyin/push/render.ts:54
const subscriber: DouyinUserLike = Detail_Data.user_info?.data?.user ?? Detail_Data.author
```

以及 374 行的 `Detail_Data.user_info?.data?.user?.ip_location`。
这两处是「订阅者/推荐者」那条路径，**上游这次没动**，但如果 amagi 已经把
`user_info.data.user` 收成 `user_info.user`，这两处也会取不到值 —— **建议顺手核一下**。

---

## 6~8. 不适用说明

- **`ee22474` 重写 live photo tip**：上游把 `LivePhotoTip.tsx` 从 223 行重写成 280+，
  并重构了 `DefaultLayout` 的页脚（新增 `GlowIcon`/`GlowText` 的 Design By 署名区）。
  本地 `LivePhotoTip.tsx` 是 **295 行自研版**，且 `DefaultLayout` 页脚已经改成
  maimai 自己的署名（「构建工具信息整块去掉：ROLLDOWN / VITE 都不要了」）。
  **上游的页脚署名区对本地无意义**；LivePhotoTip 若要跟，得逐行比对，价值待定。
- **`049eb2f` update amagi**：上游从 `pkg.pr.new` 的临时构建换回 `7.0.0-beta.4`；
  本地已是 **`7.0.0-beta.5`**，更新，无需处理。
- **`85088c7` fix: alias**：删掉 `vite.config.ts` 里指向本地 `../amagi/packages/core/src`
  的 alias、把 `node-karin` override 升到 `1.16.3`。都是上游 monorepo 的内部构建配置，
  **本地单包结构没有对应物**。

---

## 建议的搬运顺序

如果决定搬，建议按这个顺序、分批发版：

1. **`ff54ba5`（缓存续期）** —— 唯一含真实 bug 修复，单独发一版（patch）。注意判据+时机必须同批。
2. **`677e213`（二维码头像）** —— 用户能直接看到，改动集中在模板层，风险低，可发 minor。
3. **`0659c2b`（xhs 子评论 pictures 类型）** —— 改动小，可并进 2 里一起发。
4. **`2fa299a`（字体粗细）** —— 纯视觉，建议只挑常用卡片改，或干脆不做。
5. **`f4b5312` 的 54/374 行** —— 顺手核实即可，确认有问题再改。

---

## 附：核对证据

- 上游 8 个 commit 的 SHA 均能在 `ikenxuan/karin-plugin-kkk` 上解析到，时间戳 2026-09-16 ~ 2026-09-22；
- patch 明细来自 GitHub API `GET /repos/ikenxuan/karin-plugin-kkk/commits/<sha>`（含 `files[].patch`）；
- 本地对照全部用现网源码逐行 grep 确认，涉及文件：
  `src/karin/module/db/douyin.ts`、`src/karin/platform/douyin/push.ts`、
  `src/karin/platform/douyin/push/{favorite,recommend,render}.ts`、
  `src/ktr/template/{bilibili,kuaishou,xiaohongshu}/comment/components/{Comment.tsx,types.ts}`、
  `src/ktr/template/xiaohongshu/noteInfo/components/noteInfo.tsx`、
  `src/ktr/template/components/DefaultLayout.tsx`、
  `src/ktr/template/bilibili/videoInfo/components/videoInfo.tsx`、
  `src/karin/platform/xiaohongshu/{comments.ts,xiaohongshu.ts}`。
