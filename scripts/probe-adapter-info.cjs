/**
 * 探针：适配器信息 —— 错误卡片那个**图标**，和「#kkk版本」里那栏**适配器版本**。
 *
 * OneBot 系的协议端（NapCat / LLOneBot / Lagrange…）在 Koishi 眼里都叫 `onebot`，
 * 光看 `bot.platform` 根本分不出来。所以卡片要两步走：
 *
 *   ① 问协议端一句 `get_version_info`，拿到它自报的名字（`NapCat.Onebot` / `LLOneBot`）；
 *   ② 把名字翻成短代号（nc / ll / lg…），印成 `onebot(nc)`，图标按自报名字去配。
 *
 * 这个探针离线把这两步跑一遍：
 *
 *   ① 代号映射认得出各家，认不出的一律不带代号（不会印出 `onebot()`）；
 *   ② NapCat / LLOneBot 各自印成 `onebot(nc)` / `onebot(ll)`；
 *   ③ `get_version_info` 的四种暴露方式（define 的方法名 / _get / _request / 信封未拆）都认；
 *   ④ 只问一次（缓存），问不到也只问一次；
 *   ⑤ 对面不回时不卡住（1.5 秒超时），也不留 unhandledRejection；
 *   ⑥ 非 OneBot（QQ 官方）不受影响，短标签就是平台名；
 *   ⑦ 错误卡片那一栏真的带着 `implementationName`，模板也真的拿它去选图标；
 *   ⑧ 图标文件在包里真的存在（不然卡片上是裂图）；
 *   ⑨ Milky 的图标接上了，且它也算「QQ 那一族」（大图要走切片，不然上传报 921）。
 *
 * 用法：node scripts/probe-adapter-info.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const lib = path.join(root, 'lib')
const srcDir = path.join(root, 'src')

const api = require(path.join(lib, 'compat/adapter-info.js'))

let pass = 0
let fail = 0
let section = ''

const head = (text) => {
  section = text
  console.log('\n' + text)
}

const ok = (cond, label, extra) => {
  if (cond) {
    pass++
    console.log('  ✓ ' + label)
  } else {
    fail++
    console.log('  ✗ ' + label + (extra === undefined ? '' : '  →  ' + JSON.stringify(extra)))
  }
}

const eq = (actual, expected, label) => ok(actual === expected, label, { actual, expected })

/** 造一个像 Koishi Bot 的对象（platform / selfId / internal） */
const fakeBot = (platform, selfId, internal) => ({
  platform,
  selfId,
  adapterName: platform,
  status: 1,
  internal: internal || {},
  adapter: undefined
})

/** 造一个像兼容层 KkkBot 的包装（adapterCardInfo 两种都收） */
const wrap = (bot) => ({ bot })

/* ------------------------------------------------------------------ *
 * ① 代号映射
 * ------------------------------------------------------------------ */
head('① 实现端名字 → 短代号')

eq(api.implementationCode('NapCat.Onebot'), 'nc', 'NapCat.Onebot → nc')
eq(api.implementationCode('NapCat'), 'nc', 'NapCat → nc（大小写不敏感：' + api.implementationCode('napcat') + '）')
eq(api.implementationCode('LLOneBot'), 'll', 'LLOneBot → ll')
eq(api.implementationCode('Lagrange.OneBot'), 'lg', 'Lagrange.OneBot → lg')
eq(api.implementationCode('Chronocat'), 'cc', 'Chronocat → cc')
eq(api.implementationCode('go-cqhttp'), 'go', 'go-cqhttp → go')
eq(api.implementationCode('Shamrock'), 'sr', 'Shamrock → sr')
// 关键：不肯自报家门 / 适配器自己报的通用名字，不能硬凑一个代号出来
eq(api.implementationCode('OneBot'), '', 'OneBot（通用）不带代号')
eq(api.implementationCode(''), '', '空名字不带代号')
eq(api.implementationCode(undefined), '', 'undefined 不带代号')
ok(!api.implementationCode('unknown-impl').includes('('), '认不出的名字不会带括号')

/* ------------------------------------------------------------------ *
 * ② NapCat / LLOneBot 各印各的
 * ------------------------------------------------------------------ */
const main = async () => {
  head('② 平台名 + 代号：onebot(nc) / onebot(ll)')

  const napcat = fakeBot('onebot', '10001', {
    get_version_info: async () => ({ app_name: 'NapCat.Onebot', app_version: '4.9.24', protocol_version: 'v11' })
  })
  // 问之前：只有平台名，代号还没拿到
  const before = api.resolveAdapterInfo(napcat)
  eq(before.shortLabel, 'onebot', '问之前短标签就是平台名（onebot）')
  eq(before.implementationCode, '', '问之前没有代号')

  await api.queryAdapterImplementation(napcat)
  const napInfo = api.resolveAdapterInfo(napcat)
  eq(napInfo.shortLabel, 'onebot(nc)', 'NapCat → onebot(nc)')
  eq(napInfo.version, '4.9.24', '版本取协议端自报的 4.9.24')
  eq(napInfo.implementationName, 'NapCat.Onebot', '实现端名字留给选图标用')
  eq(napInfo.name, 'onebot', 'name 仍然是平台标识（不能被展示名污染）')
  eq(napInfo.platform, 'onebot', 'platform 仍然是平台标识')

  const llo = fakeBot('onebot', '10002', {
    get_version_info: async () => ({ app_name: 'LLOneBot', app_version: '3.30.0', protocol_version: 'v11' })
  })
  await api.queryAdapterImplementation(llo)
  const lloInfo = api.resolveAdapterInfo(llo)
  eq(lloInfo.shortLabel, 'onebot(ll)', 'LLOneBot → onebot(ll)')
  eq(lloInfo.version, '3.30.0', 'LLOneBot 的版本是自己的')

  /* ---------------------------------------------------------------- *
   * ③ get_version_info 的四种暴露方式
   * ---------------------------------------------------------------- */
  head('③ 各家暴露 get_version_info 的方式不一样，四种都要认')

  const versionPayload = { app_name: 'NapCat.Onebot', app_version: '1.2.3', protocol_version: 'v11' }

  const viaDefine = fakeBot('onebot', '20001', {
    getVersionInfo: async () => versionPayload
  })
  await api.queryAdapterImplementation(viaDefine)
  eq(api.resolveAdapterInfo(viaDefine).shortLabel, 'onebot(nc)', '适配器 define 的 getVersionInfo')

  const viaGet = fakeBot('onebot', '20002', {
    _get: async (action) => (action === 'get_version_info' ? versionPayload : null)
  })
  await api.queryAdapterImplementation(viaGet)
  eq(api.resolveAdapterInfo(viaGet).shortLabel, 'onebot(nc)', '通用入口 _get')

  // _request 不拆信封，给回来的是 { retcode, data }
  const viaRequest = fakeBot('onebot', '20003', {
    _request: async (action) => (action === 'get_version_info' ? { retcode: 0, status: 'ok', data: versionPayload } : null)
  })
  await api.queryAdapterImplementation(viaRequest)
  eq(api.resolveAdapterInfo(viaRequest).shortLabel, 'onebot(nc)', '通用入口 _request（信封未拆）')

  // _get 拆了信封，data 里才是真内容
  const viaEnvelope = fakeBot('onebot', '20004', {
    _get: async () => ({ retcode: 0, data: { ...versionPayload, app_name: 'LLOneBot', app_version: '9.9.9' } })
  })
  await api.queryAdapterImplementation(viaEnvelope)
  const envInfo = api.resolveAdapterInfo(viaEnvelope)
  eq(envInfo.shortLabel, 'onebot(ll)', '_get 返回整封信也能剥出来')
  eq(envInfo.version, '9.9.9', '剥信封后版本号也对')

  // 协议端甩脸色（retcode 非 0）时不能拿 data
  const viaFailed = fakeBot('onebot', '20005', {
    _request: async () => ({ retcode: 1400, data: versionPayload })
  })
  await api.queryAdapterImplementation(viaFailed)
  eq(api.resolveAdapterInfo(viaFailed).implementationCode, '', 'retcode 非 0 时不当真')

  /* ---------------------------------------------------------------- *
   * ④ 只问一次
   * ---------------------------------------------------------------- */
  head('④ 只问一次（卡片渲染路径上不会重复发请求）')

  let asked = 0
  const countable = fakeBot('onebot', '30001', {
    get_version_info: async () => {
      asked++
      return versionPayload
    }
  })
  await api.queryAdapterImplementation(countable)
  await api.queryAdapterImplementation(countable)
  await api.queryAdapterImplementation(countable)
  eq(asked, 1, '问三次实际只发一次请求')

  let askedNothing = 0
  const silent = fakeBot('onebot', '30002', {
    get_version_info: async () => {
      askedNothing++
      return {}
    }
  })
  eq(await api.queryAdapterImplementation(silent), null, '协议端没给名字 → null')
  await api.queryAdapterImplementation(silent)
  eq(askedNothing, 1, '「问不到」也会被记住，不会一直重试')

  /* ---------------------------------------------------------------- *
   * ⑤ 不回包时不卡住
   * ---------------------------------------------------------------- */
  head('⑤ 对面不回：1.5 秒超时，且不炸 unhandledRejection')

  const rejections = []
  const onRejection = (reason) => rejections.push(String(reason))
  process.on('unhandledRejection', onRejection)

  const hanging = fakeBot('onebot', '40001', {
    get_version_info: () => new Promise(() => { /* 永不 settle */ })
  })
  // 超时定时器是 unref 的，裸脚本里事件循环可能空转退出，这里挂个心跳撑住
  const keepAlive = setInterval(() => {}, 50)
  const t0 = Date.now()
  const hangResult = await api.queryAdapterImplementation(hanging)
  const elapsed = Date.now() - t0
  clearInterval(keepAlive)
  eq(hangResult, null, '不回包 → null')
  ok(elapsed < 3000, '没被拖住（' + elapsed + 'ms < 3000ms）')
  eq(api.resolveAdapterInfo(hanging).shortLabel, 'onebot', '超时后仍退回平台名')

  const throwing = fakeBot('onebot', '40002', {
    get_version_info: async () => { throw new Error('boom') }
  })
  eq(await api.queryAdapterImplementation(throwing), null, '接口直接抛错 → null（不会连累卡片）')

  await new Promise((resolve) => setTimeout(resolve, 50))
  process.off('unhandledRejection', onRejection)
  eq(rejections.length, 0, '没有漏出去的 unhandledRejection')

  /* ---------------------------------------------------------------- *
   * ⑥ 非 OneBot 不受影响
   * ---------------------------------------------------------------- */
  head('⑥ QQ 官方这类平台：短标签就是平台名')

  const qq = fakeBot('qq', '50001', {})
  await api.queryAdapterImplementation(qq)
  const qqInfo = api.resolveAdapterInfo(qq)
  eq(qqInfo.shortLabel, 'qq', 'qq → qq（不带代号）')
  eq(qqInfo.implementationCode, '', 'qq 没有实现端代号')
  eq(qqInfo.name, 'qq', 'qq 的 name 仍是平台标识')

  const noInternal = fakeBot('onebot', '50002', null)
  eq(await api.queryAdapterImplementation(noInternal), null, '连 internal 都没有 → null')
  eq(api.resolveAdapterInfo(noInternal).shortLabel, 'onebot', 'internal 缺失时不崩')

  /* ---------------------------------------------------------------- *
   * ⑦ 错误卡片那一栏
   * ---------------------------------------------------------------- */
  head('⑦ 错误卡片的「Adapter / 适配器」一栏')

  const cardNap = await api.adapterCardInfo(napcat)
  eq(cardNap.name, 'onebot(nc)', '卡片上印 onebot(nc)')
  eq(cardNap.version, '4.9.24', '卡片上的版本号')
  eq(cardNap.implementationName, 'NapCat.Onebot', '卡片带着实现端名字（选图标用）')

  const cardLlo = await api.adapterCardInfo(wrap(llo))
  eq(cardLlo.name, 'onebot(ll)', '传 KkkBot 包装也一样（onebot(ll)）')

  const cardQq = await api.adapterCardInfo(qq)
  eq(cardQq.name, 'qq', 'QQ 官方卡片上就是 qq')
  ok(typeof cardQq.version === 'string', '版本号一定是字符串（模板会调 startsWith）')

  const cardNone = await api.adapterCardInfo(undefined)
  eq(cardNone.name, '未知适配器', '没有 bot 时兜底，不返回 undefined')
  eq(cardNone.version, '', '兜底的 version 是空串（不是 undefined）')

  /* ---------------------------------------------------------------- *
   * ⑧ 静态检查：模板真的拿实现端名字去选图标，图标文件真的在
   * ---------------------------------------------------------------- */
  head('⑧ 图标：模板按实现端名字选，且文件确实在包里')

  const renderSrc = fs.readFileSync(path.join(srcDir, 'karin/module/utils/ErrorHandler/render.ts'), 'utf8')
  const cardTsx = fs.readFileSync(path.join(srcDir, 'ktr/template/other/handlerError/components/handlerError.tsx'), 'utf8')
  const reportSrc = fs.readFileSync(path.join(srcDir, 'karin/module/utils/runtime-report.ts'), 'utf8')

  ok(renderSrc.includes('adapterCardInfo'), '错误渲染走 adapterCardInfo')
  ok(cardTsx.includes('implementationName'), '模板读 implementationName 选图标')
  ok(/getAdapterLogo\(data\.adapterInfo\)/.test(cardTsx), '模板把整个 adapterInfo 交给 getAdapterLogo')
  ok(reportSrc.includes('shortLabel'), '「#kkk版本」那栏用 shortLabel')

  const logoBlock = cardTsx.slice(cardTsx.indexOf('ADAPTER_LOGO_MAP'), cardTsx.indexOf('const getAdapterLogo'))
  for (const [key, file] of [['napcat', 'napcat.webp'], ['llonebot', 'llonebot.webp']]) {
    ok(logoBlock.includes(key), '图标表里有 ' + key)
    ok(fs.existsSync(path.join(root, 'resources/image/other/handlerError', file)), '包里有 ' + file)
  }

  const built = fs.readFileSync(path.join(lib, 'compat/adapter-info.js'), 'utf8')
  ok(built.includes('onebot(nc)') || built.includes('${name}(${code})'), '构建产物里带上了短标签逻辑')

  /* ---------------------------------------------------------------- *
   * ⑨ Milky：图标要接上，大图要走切片
   *
   * Milky 不是 OneBot 系（平台名就是 `milky`），但**底下就是 QQ** ——
   * 两个后果：图标表里漏了它就只剩一个万能拼图；
   * 切片那条链路漏了它，超过体积上限的海报就会原样发出去 → Milky 报
   * `HTTP Upload failed with code 921`，整条 `#kkk版本` 直接失败。
   * ---------------------------------------------------------------- */
  head('⑨ Milky：图标接上了，大图也走切片')

  ok(logoBlock.includes('milky'), '图标表里有 milky（不然错误卡片上是个拼图）')
  ok(logoBlock.includes('Milky.png'), '用的是 Milky.png（大小写要和文件一致）')
  ok(fs.existsSync(path.join(root, 'resources/image/other/handlerError/Milky.png')), '包里有 Milky.png')
  /**
   * **兜底项必须排在具体项后面**：`getAdapterLogo` 命中第一个就返回，
   * `onebot` / `satori` 会匹配到 `NapCat.Onebot` / `Lagrange.OneBot`，
   * 排到前面就把各家自己的图标顶掉了。
   */
  /**
   * ⚠️ 要按**整行**找：`llonebot: '…'` 里也含 `onebot: '…'` 这个子串，
   * 直接 indexOf 会命中 llonebot 那一行，把顺序判反（探针自己骗自己）。
   */
  const lineOf = (key) => logoBlock.indexOf('\n  ' + key + ': ')
  const onebotAt = lineOf('onebot')
  const napcatAt = lineOf('napcat')
  const gocqAt = lineOf('gocq')
  ok(napcatAt >= 0 && onebotAt > napcatAt, '兜底项 onebot 排在 napcat 之后（不会顶掉各家图标）')
  ok(gocqAt >= 0 && onebotAt > gocqAt, '兜底项 onebot 排在 gocq 之后')

  const slice = require(path.join(lib, 'karin/module/utils/ImageSlice.js'))
  for (const platform of ['qq', 'qqguild', 'onebot', 'napcat', 'lagrange', 'milky']) {
    ok(slice.isQqFamily(platform) === true, platform + ' → 算 QQ 那一族（大图要走切片）')
  }
  for (const platform of ['discord', 'telegram', 'kook', '']) {
    ok(slice.isQqFamily(platform) === false, (platform || '（空）') + ' → 不算（不该白切一刀）')
  }

  /** 帮助 / 版本 / 更新日志那三张卡片必须走切片，否则 Milky 上就是 921 */
  const helpSrc = fs.readFileSync(path.join(srcDir, 'karin/apps/help.ts'), 'utf8')
  ok(helpSrc.includes('sendSlicedImage'), '三张卡片（帮助 / 版本 / 更新日志）走 sendSlicedImage')
  ok((helpSrc.match(/replyCardImage\(e, img\)/g) ?? []).length === 3, '三处调用都换成了 replyCardImage',
    (helpSrc.match(/replyCardImage\(e, img\)/g) ?? []).length)

  /* ---------------------------------------------------------------- */
  console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '：' + pass + ' 通过 / ' + fail + ' 失败')
  if (fail > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('探针自己崩了（' + section + '）：', error)
  process.exitCode = 1
})
