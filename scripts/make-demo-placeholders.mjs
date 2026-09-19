/**
 * 生成 README 里演示图的占位图。
 *
 * 真图放进去之前先铺一张写着「这里该放什么」的占位，README 就不会是一片裂图。
 *
 * 用法：
 *   node scripts/make-demo-placeholders.mjs          # 只补缺失的（已有的图不会被覆盖）
 *   node scripts/make-demo-placeholders.mjs --force  # 全部重画成占位
 *
 * 换真图：把截图按文件名覆盖到 docs/images/ 即可（建议 1440×810，16:9）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const outDir = path.join(pluginRoot, 'docs', 'images')
const force = process.argv.includes('--force')

/** 文件名 → [这张图该拍什么, 怎么拍] */
export const SHOTS = [
  ['01-qq-panel', 'QQ 交互面板：解析完成的卡片 + 清晰度 / 视频 / 弹幕 / 大小 表格 + 一排按钮', '群里发链接后机器人回的第一条消息'],
  ['02-bilibili-info', 'B站视频信息卡（封面、UP 主、数据栏、热门弹幕）', '解析一个 B站视频后的卡片'],
  ['03-comment-card', '评论区长图：超过 20MB 或发送失败时自动切片，再用一条 markdown 拼回一整张', '评论区卡片的完整长图'],
  ['04-douyin-gallery', '抖音图集：多张图合成一条 markdown 发送，实况视频跟在后面', '解析抖音图集后的消息'],
  ['05-xiaohongshu-note', '小红书笔记卡片 + 评论区', '解析小红书笔记后的面板'],
  ['06-download-progress', '下载进度提示：正在获取下载链接 / 正在合并音轨 / 发送中…', '点完画质按钮后的进度消息'],
  ['07-webui-qq-tab', '配置面板 /kkk 的「QQ 适配器」分类（控制台里的「kkk 配置」页就是它）', '浏览器打开 /kkk 并切到 QQ 适配器标签'],
  ['08-console-entry', 'Koishi 控制台：侧边栏入口 + 插件配置里的「QQ 适配器」与折叠的「Koishi 原生设置」', '控制台插件配置页'],
  ['09-error-card', '错误诊断卡片：框架版本 / 插件版本 / 适配器，以及 QQ 群号与仓库地址', '触发一次报错的卡片'],
]

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]

const STYLE = [
  'html, body { margin: 0; width: 1440px; height: 810px; }',
  'body { display: flex; align-items: center; justify-content: center;',
  '       font-family: "Microsoft YaHei", "PingFang SC", sans-serif; background: #f5f6f8; }',
  '.card { width: 1220px; height: 610px; border-radius: 24px; background: #fff;',
  '        border: 3px dashed #c3c8d2; display: flex; flex-direction: column;',
  '        align-items: center; justify-content: center; gap: 26px; }',
  '.badge { font-size: 22px; letter-spacing: 2px; color: #8b93a3; }',
  '.title { font-size: 44px; font-weight: 700; color: #2b3240; }',
  '.note { font-size: 25px; line-height: 1.6; max-width: 980px; text-align: center; color: #5c6474; }',
  '.file { font-size: 23px; color: #1f6feb; background: #eef4ff; padding: 10px 20px; border-radius: 10px; }',
].join(String.fromCharCode(10))

const buildHtml = (index, name, title, note) => [
  '<!doctype html>',
  '<html lang="zh"><head><meta charset="utf-8"><style>',
  STYLE,
  '</style></head><body>',
  '  <div class="card">',
  '    <div class="badge">演示图占位 · ' + String(index + 1).padStart(2, '0') + '</div>',
  '    <div class="title">' + title + '</div>',
  '    <div class="note">' + note + '</div>',
  '    <div class="file">docs/images/' + name + '.png</div>',
  '  </div>',
  '</body></html>',
].join(String.fromCharCode(10))

async function loadPuppeteer () {
  for (const cand of [path.join(pluginRoot, 'node_modules', 'puppeteer-core'), 'D:/devkoishi/node_modules/puppeteer-core', 'puppeteer-core']) {
    try { return await import(pathToFileURL(require.resolve(cand)).href) } catch { /* 试下一个 */ }
  }
  return null
}

async function main () {
  fs.mkdirSync(outDir, { recursive: true })
  const mod = await loadPuppeteer()
  if (!mod) { console.error('没找到 puppeteer-core，无法生成占位图'); process.exit(1) }
  const puppeteer = mod.default ?? mod
  const executablePath = BROWSERS.find((p) => fs.existsSync(p))
  if (!executablePath) { console.error('没找到 Edge / Chrome，无法生成占位图'); process.exit(1) }

  const targets = SHOTS.filter(([name]) => force || !fs.existsSync(path.join(outDir, name + '.png')))
  if (!targets.length) console.log('[kkk] 占位图都在，无需生成（要重画加 --force）')
  else {
    const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox'] })
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 810 })
    for (const [name, title, note] of targets) {
      const index = SHOTS.findIndex(([n]) => n === name)
      await page.setContent(buildHtml(index, name, title, note), { waitUntil: 'load' })
      await page.screenshot({ path: path.join(outDir, name + '.png') })
      console.log('[kkk] 生成占位图 docs/images/' + name + '.png')
    }
    await browser.close()
  }

  const list = ['# 演示图清单', '',
    '这里放 README 用到的演示图，**把截图按文件名覆盖进来就行**（建议 1440×810，16:9，单张 < 1MB）。',
    '', '缺图时可以重新生成占位：`node scripts/make-demo-placeholders.mjs`（已存在的图不会被覆盖）。',
    '', '| 文件 | 该拍什么 | 怎么拍 |', '| --- | --- | --- |']
  for (const [name, title, note] of SHOTS) list.push('| `' + name + '.png` | ' + title + ' | ' + note + ' |')
  list.push('')
  fs.writeFileSync(path.join(outDir, 'README.md'), list.join(String.fromCharCode(10)))
  console.log('[kkk] 清单已更新 docs/images/README.md')
}

main().catch((error) => { console.error(error); process.exit(1) })
