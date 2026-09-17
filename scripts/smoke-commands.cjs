/**
 * 信息类命令冒烟测试：`#kkk帮助` / `#kkk版本` / `#kkk更新日志`。
 * 覆盖 Render 兜底、CHANGELOG 解析（兼容层 logs/parseChangelog/range）、运行环境快照。
 *
 * 用法：node scripts/smoke-commands.cjs
 */
const fs = require('node:fs'); const path = require('node:path'); const { Context } = require('koishi');
const pluginRoot = path.resolve(__dirname, '..');
const dataRoot = path.resolve(pluginRoot, 'data-smoke-cmd');
fs.mkdirSync(path.join(dataRoot, 'koishi-plugin-kkk', 'config'), { recursive: true });
const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'config/default_config/config.json'), 'utf8'));
config.app.parseTip = false;
fs.writeFileSync(path.join(dataRoot, 'koishi-plugin-kkk', 'config', 'config.json'), JSON.stringify(config, null, 2));
const plugin = require(path.join(pluginRoot, 'lib/index.js'));
const ctx = new Context();
const sent = [];
const fakeBot = { selfId: '10000', platform: 'smoke', status: 1, user: { id: '10000', name: 's' }, ctx,
  sendMessage: async (ch, c) => { sent.push(c); return ['m'] }, getGuild: async () => ({ name: 'g' }), getFriendList: async () => [] };
Object.defineProperty(ctx, 'bots', { get: () => [fakeBot] });
const middlewares = [];
const orig = ctx.middleware.bind(ctx);
ctx.middleware = (fn, ...rest) => { middlewares.push(fn); return orig(fn, ...rest) };
ctx.plugin(plugin, { dataPath: dataRoot, debug: true, masters: ['12345'] });
const makeSession = (content) => ({ content, selfId: '10000', userId: '12345', guildId: '456', channelId: '456', messageId: 'm1', bot: fakeBot, author: { nick: 's' }, username: 's', event: {}, send: async (c) => { sent.push(c); return ['m2'] } });
async function dispatch (content) {
  const session = makeSession(content); let i = 0;
  const run = async () => { while (i < middlewares.length) { const mw = middlewares[i++]; let cont = false; await mw(session, () => { cont = true; return run() }); if (!cont) return } };
  await run();
}
setTimeout(async () => {
  const { commandQueue } = require(path.join(pluginRoot, 'lib/compat/runtime.js'));
  console.log('middlewares=' + middlewares.length + ' commands=' + commandQueue.length);
  for (const cmd of ['#kkk帮助', '#kkk版本', '#kkk更新日志']) {
    try { console.log('--- ' + cmd + ' ---'); await dispatch(cmd); } catch (e) { console.log('FAIL', e.message); }
  }
  console.log('\n共发出 ' + sent.length + ' 条消息');
  for (const c of sent) { const list = Array.isArray(c) ? c : [c]; console.log(list.map((el) => typeof el === 'string' ? el.slice(0, 160) : '[' + (el && el.type) + ']').join(' | ').slice(0, 300)); }
  process.exit(0);
}, 5000);