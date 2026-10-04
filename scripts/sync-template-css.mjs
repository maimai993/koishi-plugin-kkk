#!/usr/bin/env node
/**
 * 把「上游新模板用到、而本地产物还没有」的 Tailwind 工具类，抽取成
 * `resources/template/extra-utilities.css`。
 *
 * ## 为什么需要这个脚本
 *
 * `resources/template/style.css` 是 tailwind v4 的**按需构建产物**：只有「构建那一刻」
 * 被 `@source` 扫到的类才会生成规则。我们的模板源码是跟着上游 `ikenxuan/karin-plugin-kkk`
 * 走的，每同步一次上游模板，就可能引入一批产物里没有的新类。
 * 类不存在时页面不会报错，只是**静默丢样式** —— 卡片掉间距、掉尺寸、图标塌成 0 宽
 * （实况照片提示卡就是这么崩的，见 docs/ 里的排查记录）。
 *
 * 上游没有把构建产物提交进仓库（`packages/core/ktr/template/style.css` 只是入口源文件），
 * 但**发布到 npm 的包里带了构建好的 `lib/style.css`**。所以这里直接拉 npm 产物，
 * 把它里面有的规则抽出来补进本地，不需要复现整个 tailwind 构建链。
 *
 * ## 用法
 *
 *   node scripts/sync-template-css.mjs              # 拉上游最新产物，补齐并写文件
 *   node scripts/sync-template-css.mjs --check      # 只检查是否已同步（缺类则退出码 1）
 *   node scripts/sync-template-css.mjs --from a.css # 用本地已有的上游产物
 *   node scripts/sync-template-css.mjs --version 2.43.2
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..')
const TEMPLATE_DIR = path.join(ROOT, 'src', 'ktr', 'template')
const LOCAL_CSS = path.join(ROOT, 'resources', 'template', 'style.css')
const EXTRA_CSS = path.join(ROOT, 'resources', 'template', 'extra-utilities.css')

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i < 0 ? null : argv[i + 1] ?? true
}
const CHECK = argv.includes('--check')
const FROM = flag('--from')
const VERSION = flag('--version') || 'latest'

/* ------------------------------------------------------------------ *
 * 1. 收集模板源码里用到的类名
 * ------------------------------------------------------------------ */

const walk = (dir, out = []) => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) walk(full, out)
    else if (/\.(tsx|jsx|ts|html)$/.test(name)) out.push(full)
  }
  return out
}

/** 只收 className 位置的字面量，避免把变量名当成类名 */
const extractClasses = (file) => {
  const src = fs.readFileSync(file, 'utf8')
  const found = new Set()
  const addTokens = (raw) => {
    for (const t of raw.split(/\s+/)) {
      if (!t) continue
      if (!/^-?[a-z]/.test(t)) continue
      if (/[^\x00-\x7F]/.test(t)) continue
      found.add(t)
    }
  }
  const push = (raw) => {
    // `className={`a ${cond ? 'b' : 'c'}`}` —— 抓引号里的类名，丢掉 `${}` 里的表达式（那是变量名不是类名）
    for (const m of raw.matchAll(/\$\{([^}]*)\}/g)) {
      for (const lit of m[1].matchAll(/['"]([^'"]*)['"]/g)) addTokens(lit[1])
    }
    addTokens(raw.replace(/\$\{[^}]*\}/g, ' '))
  }
  for (const m of src.matchAll(/className\s*=\s*"([^"]*)"/g)) push(m[1])
  for (const m of src.matchAll(/className\s*=\s*\{`([^`]*)`\}/g)) push(m[1])
  return found
}

const templateFiles = walk(TEMPLATE_DIR)
const usedClasses = new Set()
for (const file of templateFiles) for (const c of extractClasses(file)) usedClasses.add(c)

/**
 * 本地产物和**上游产物**里都没有规则的类名。
 *
 * 补不了，所以列进白名单让 `--check` 能干净通过；每一条都记了原因，别往里塞新东西。
 * 这些是上游模板自己就带着的失效类（`shadow-large` 之类要 `@theme` 里先定义 `--shadow-large`
 * 才会生成，上游没定义），或纯语义标记类。
 */
const UNFIXABLE = new Set([
  'bg-divider',
  'border-divider',
  'divide-divider',
  'shadow-large',
  'shadow-medium',
  'text-view',
  'text-scrollbar',
  'rounded-6', // 匹配到的其实是 rounded-6xl
  'rounded-10',
  'leading-inherit',
  'changelog-content', // 本地 changelog 模板的标记类，等于是个空壳
  'runtime-release-notes', // 同上
  'prose', // 没装 @tailwindcss/typography
  'prose-lg',
  'prose-invert'
])

/**
 * `group` 只是给后代选择器用的标记类，Tailwind 不会为它生成任何规则 —— 永远查不到，直接排除。
 * 其余带 `'`、`(`、`)` 之类字符的，是脚本从模板字符串里误抓的变量名，不是类名。
 */
const IGNORED = new Set(['group'])
const isRealClass = (token) => {
  if (IGNORED.has(token) || UNFIXABLE.has(token)) return false
  if (/['"()\\]/.test(token)) return false // 从模板字符串里误抓的变量名 / 带引号片段
  return /^[A-Za-z0-9_%#:!.\-\[\]/]+$/.test(token)
}

/* ------------------------------------------------------------------ *
 * 2. CSS 解析：拆成一条条规则，保留 @media / @supports 包裹
 * ------------------------------------------------------------------ */

/** 按大括号配平把一段 CSS 拆成顶层条目 */
const splitBlocks = (css) => {
  const items = []
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open < 0) break
    let depth = 1
    let j = open + 1
    while (j < css.length && depth > 0) {
      const ch = css[j]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      j++
    }
    items.push({
      prelude: css.slice(i, open).trim(),
      body: css.slice(open + 1, j - 1)
    })
    i = j
  }
  return items
}

/** 递归收集叶子规则；at-rule 作为包裹（wrap）保留 */
const collectRules = (css, wrap = [], out = []) => {
  for (const { prelude, body } of splitBlocks(css)) {
    if (!prelude) continue
    if (prelude.startsWith('@')) collectRules(body, [...wrap, prelude], out)
    else out.push({ selectors: prelude, body, wrap })
  }
  return out
}

const stripEscapes = (s) => s.replace(/\\/g, '')

/** 选择器里是否有 `.token`（且后面不是类名字符） */
const selectorsHit = (selectors, token) => {
  const norm = stripEscapes(selectors)
  const needle = '.' + token
  let from = 0
  for (;;) {
    const idx = norm.indexOf(needle, from)
    if (idx < 0) return false
    const after = norm[idx + needle.length]
    if (after === undefined || !/[A-Za-z0-9_-]/.test(after)) return true
    from = idx + 1
  }
}

/** 任意 CSS 文本里是否存在 `.token` 规则 */
const cssHasClass = (css, token) => selectorsHit(stripEscapes(css), token)

const renderRule = (rule, indent = '  ') => {
  // `@layer utilities` 由外层统一提供，这里只保留真正需要嵌套的 @media / @supports
  const wraps = rule.wrap.filter((w) => !/^@layer\s/.test(w))
  const lines = []
  for (const w of wraps) lines.push(indent + w + ' {')
  const inner = indent + (wraps.length ? '  ' : '')
  lines.push(inner + rule.selectors + ' {')
  for (const line of rule.body.split('\n')) {
    if (line.trim()) lines.push(inner + '  ' + line.trim())
  }
  lines.push(inner + '}')
  for (let i = 0; i < wraps.length; i++) lines.push(indent + '}')
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * 3. 取上游产物
 * ------------------------------------------------------------------ */

const fetchUpstream = async () => {
  if (FROM) return { css: fs.readFileSync(FROM, 'utf8'), label: path.basename(FROM) }
  const url = `https://cdn.jsdelivr.net/npm/karin-plugin-kkk@${VERSION}/lib/style.css`
  const res = await fetch(url)
  if (!res.ok) throw new Error('拉取上游样式失败: HTTP ' + res.status + ' ' + url)
  return { css: await res.text(), label: `karin-plugin-kkk@${VERSION} (lib/style.css)` }
}

/* ------------------------------------------------------------------ *
 * 4. 主流程
 * ------------------------------------------------------------------ */

const main = async () => {
  /**
   * 基准分两种：
   *   - 生成：只看**本地产物本体** style.css。把 extra 也算进去的话，重跑会变成「无事可做」，
   *     顺手把已经补好的内容清空（这个坑踩过一次）。
   *   - --check：style.css + extra 一起看，代表「当前实际会生效的样式」，
   *     这样检查可以在离线状态下完成。
   */
  const cssOnly = fs.readFileSync(LOCAL_CSS, 'utf8')
  const extraCss = fs.existsSync(EXTRA_CSS) ? fs.readFileSync(EXTRA_CSS, 'utf8') : ''
  const known = CHECK ? cssOnly + '\n' + extraCss : cssOnly

  const missing = []
  for (const token of usedClasses) {
    if (!isRealClass(token)) continue
    if (!cssHasClass(known, token)) missing.push(token)
  }

  console.log('模板文件 ' + templateFiles.length + ' 个，类名引用 ' + usedClasses.size + ' 个')
  console.log('本地产物里找不到规则的：' + missing.length + ' 个')

  if (!missing.length) {
    console.log('\n样式已同步：模板用到的类在 style.css + extra-utilities.css 里都能找到规则。')
    return
  }

  // --check 完全离线：只回答「同没同步」，不负责算出怎么补
  if (CHECK) {
    console.log('\n--check 未通过，以下类名没有规则：')
    console.log('  ' + missing.join(' '))
    console.log('\n跑一次 node scripts/sync-template-css.mjs 补齐即可。')
    process.exitCode = 1
    return
  }

  const { css: upstreamCss, label } = await fetchUpstream()
  const rules = collectRules(upstreamCss)

  const picked = new Map() // token -> rule[]（同一个 token 可能命中多条规则）
  const stillMissing = []
  for (const token of missing) {
    const hit = rules.filter((r) => selectorsHit(r.selectors, token))
    if (hit.length) picked.set(token, hit)
    else stillMissing.push(token)
  }

  // 去重：同一条规则可能同时命中多个 token
  const uniqueRules = []
  const seen = new Set()
  for (const list of picked.values()) {
    for (const r of list) {
      const key = r.wrap.join('|') + '>>>' + r.selectors + '>>>' + r.body
      if (seen.has(key)) continue
      seen.add(key)
      uniqueRules.push(r)
    }
  }

  console.log('从上游产物里抽到规则：' + uniqueRules.length + ' 条，覆盖 ' + picked.size + ' 个类名')
  if (stillMissing.length) {
    console.log('上游产物里也没有的 ' + stillMissing.length + ' 个（多为脚本误抓的变量名，可忽略）：')
    console.log('  ' + stillMissing.join(' '))
  }

  /**
   * `@theme` 里的变量同样是按需输出的：新补进来的规则如果引用了本地产物里没有的变量
   * （`.font-bilifont` 这类），只补规则是白补 —— 得把变量一起补上。
   */
  const defaultVarRegex = (name) => new RegExp(name.replace(/-/g, '\\-') + '\\s*:\\s*([^;]+);')
  const varDecls = []
  const neededVars = new Set()
  for (const r of uniqueRules) {
    for (const m of r.body.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) neededVars.add(m[1])
  }
  for (const name of neededVars) {
    if (known.includes(name)) continue
    const hit = upstreamCss.match(defaultVarRegex(name))
    if (hit) varDecls.push([name, hit[1].trim()])
    else console.log('  注意：变量 ' + name + ' 本地和上游都没有定义')
  }

  const header = [
    '/* 本文件由 scripts/sync-template-css.mjs 自动生成，请勿手改。',
    ' *',
    ' * resources/template/style.css 是 tailwind v4 的按需构建产物，只含「构建那一刻」扫描到的类。',
    ' * 模板跟随上游更新后引入的新类不会自动出现，页面不报错、只是静默丢样式（掉间距 / 掉尺寸 / 图标塌成 0 宽）。',
    ' * 这里把上游 npm 产物（lib/style.css）里对应的规则抽出来补上。',
    ' *',
    ' * 来源：' + label,
    ' * 生成时间：' + new Date().toISOString(),
    ' * 补齐类名：' + picked.size + ' 个',
    ' */',
    varDecls.length ? ':root, :host {\n' + varDecls.map(([n, v]) => '  ' + n + ': ' + v + ';').join('\n') + '\n}\n' : null,
    '@layer utilities {',
    uniqueRules.map((r) => renderRule(r, '  ')).join('\n\n'),
    '}',
    ''
  ].filter((l) => l !== null).join('\n')

  fs.writeFileSync(EXTRA_CSS, header, 'utf8')
  console.log('\n已写入 ' + path.relative(ROOT, EXTRA_CSS).replace(/\\/g, '/') +
    '（' + (Buffer.byteLength(header) / 1024).toFixed(1) + ' KB）')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 2
})
