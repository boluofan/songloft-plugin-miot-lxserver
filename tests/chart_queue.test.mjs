import assert from 'node:assert/strict';
import test from 'node:test';
import { loader } from './chat_loader.mjs';

// 加载真实 OnlineSearcher + 真实 LxServerProvider/Client，仅 mock 全局依赖与 fetch。
const load = loader({
  '../service/service': {}, '../player/url_builder': {}, '../config/manager': {},
  '../indexing/manager': {}, '../group/coordinator': {}, '../utils/http': {},
  '../types': {},
});
const { OnlineSearcher } = load('../src/voicecmd/online_searcher.ts');
const { getDefaultVoiceCommands } = load('../src/voicecmd/defaults.ts');

function lxConfig(overrides = {}) {
  return {
    enabled: true, host: 'http://lx.test:9527', token: '', quality: '320k',
    allowQualityFallback: true, sources: ['kw', 'tx', 'wy'], searchTimeout: 6, urlTimeout: 12,
    ...overrides,
  };
}

function fixture(t, { lx = lxConfig(), handler }) {
  const previous = globalThis.songloft;
  globalThis.songloft = { log: { info() {}, warn() {}, error() {} } };
  t.after(() => { globalThis.songloft = previous; });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, init });
    return handler(url, init);
  });
  const searcher = new OnlineSearcher({
    getConfig: async () => ({
      external_search_enabled: false,
      external_search_timeout: 2,
      external_search_sources: [],
      lxserver: lx,
    }),
  });
  return { searcher, requests };
}

const jsonResp = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
});

const board = (name, bangid) => ({ id: `wy__${bangid}`, name, bangid, source: 'wy' });
const chartSong = (name, id) => ({
  name, singer: '某歌手', source: 'wy', songmid: id,
  interval: '04:00', img: 'https://img.test/c.jpg', types: [{ type: '320k' }],
});

/** 默认 handler：kw 无榜单，tx 有热歌榜/飙升榜，wy 有热歌榜（精确命中优先） */
function chartHandler(overrides = {}) {
  const boardsBySource = {
    kw: [],
    tx: [board('热歌榜', '26'), board('飙升榜', '62')],
    wy: [board('热歌榜', '3778678'), board('欧美热歌榜', '2809513713')],
  };
  const listByBangid = {
    '26': [chartSong('tx榜曲1', 'tx1'), chartSong('tx榜曲2', 'tx2')],
    '62': [chartSong('tx飙升1', 'txup1')],
    '3778678': [chartSong('wy榜曲1', 'wy1'), chartSong('wy榜曲2', 'wy2')],
    '2809513713': [chartSong('欧美曲', 'us1')],
  };
  return (url) => {
    if (overrides.boards !== undefined && url.includes('/leaderboard/boards')) return jsonResp(overrides.boards);
    if (url.includes('/leaderboard/boards')) {
      const source = new URL(url).searchParams.get('source');
      return jsonResp({ list: boardsBySource[source] || [], source });
    }
    if (url.includes('/leaderboard/list')) {
      const bangid = new URL(url).searchParams.get('bangid');
      if (overrides.list?.[bangid] !== undefined) return jsonResp({ list: overrides.list[bangid], total: overrides.list[bangid].length });
      return jsonResp({ list: listByBangid[bangid] || [], total: (listByBangid[bangid] || []).length });
    }
    if (url.includes('/api/music/url')) return jsonResp({ url: 'https://audio.test/song.mp3', type: '320k' });
    return jsonResp([]);
  };
}

test('榜单命令在默认口令表里且已启用', () => {
  const cmds = getDefaultVoiceCommands().filter(c => c.type === 'play_chart');
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].enabled, true);
  assert.ok(cmds[0].keywords.some(k => k.includes('榜单')));
});

test('榜单目录请求：仅带 source 参数，精确命中优先', async t => {
  const { searcher, requests } = fixture(t, { handler: chartHandler() });
  const queue = await searcher.searchChartQueue('热歌榜', { limit: 5, preResolve: 2 });
  assert.ok(queue, '榜单命中');
  const boardReqs = requests.filter(r => r.url.includes('/leaderboard/boards'));
  assert.deepEqual(boardReqs.map(r => new URL(r.url).searchParams.get('source')), ['kw', 'tx', 'wy'], '跨源收集目录后再按匹配分排序');
  assert.ok(boardReqs.every(r => [...new URL(r.url).searchParams.keys()].join(',') === 'source'), '只发 source 一个参数');
  assert.equal(queue.artistName, '热歌榜', '精确名压过包含名（tx 热歌榜 / wy 热歌榜同分，按 sources 顺序取 tx）');
  assert.equal(queue.items.length, 2);
  const listReq = requests.filter(r => r.url.includes('/leaderboard/list'));
  assert.equal(listReq.length, 1, '最高分命中即取曲目，不逐个试');
});

test('榜单名模糊匹配：短名不被长名抢走，精确名优先', async t => {
  const { searcher, requests } = fixture(t, { handler: chartHandler() });
  const queue = await searcher.searchChartQueue('欧美热歌榜', { limit: 5, preResolve: 1 });
  assert.ok(queue);
  const listReq = requests.find(r => r.url.includes('/leaderboard/list'));
  assert.equal(new URL(listReq.url).searchParams.get('bangid'), '2809513713', '长榜名精确命中，不是热歌榜');
});

test('榜单曲目取 bangid（不是 id），并且曲目带完整引用与去重键', async t => {
  const { searcher, requests } = fixture(t, { handler: chartHandler() });
  const queue = await searcher.searchChartQueue('飙升榜', { limit: 5, preResolve: 1 });
  assert.ok(queue);
  const listReq = requests.find(r => r.url.includes('/leaderboard/list'));
  assert.equal(new URL(listReq.url).searchParams.get('bangid'), '62');
  assert.ok(new URL(listReq.url).searchParams.get('bangid') !== 'tx__62', '用 bangid 而非 id');
  assert.equal(queue.items[0].dedup_key, 'lxserver:wy:txup1');
  assert.ok(queue.items[0].source_data, '带引用供入库形态使用');
});

test('榜单 importMode：不解析任何直链，resolveUrl 返回空', async t => {
  const { searcher, requests } = fixture(t, { handler: chartHandler() });
  const queue = await searcher.searchChartQueue('热歌榜', { limit: 5, importMode: true });
  assert.ok(queue);
  assert.equal(queue.mode, 'import');
  assert.equal(requests.filter(r => r.url.includes('/api/music/url')).length, 0, '入库形态不解析直链');
  assert.equal(await queue.resolveUrl(0), '');
});

test('榜单无匹配榜单名时返回 null，不请求曲目列表', async t => {
  const { searcher, requests } = fixture(t, {
    lx: lxConfig({ sources: ['kw'] }), // kw 无榜单
    handler: chartHandler(),
  });
  assert.equal(await searcher.searchChartQueue('不存在的榜', { preResolve: 1 }), null);
  assert.equal(requests.filter(r => r.url.includes('/leaderboard/list')).length, 0);
});

test('榜单首批直链全部失败时返回 null（交给上层提示）', async t => {
  const { searcher } = fixture(t, {
    handler: (url) => {
      if (url.includes('/leaderboard/boards')) return jsonResp({ list: [board('热歌榜', '3778678')], source: 'wy' });
      if (url.includes('/leaderboard/list')) return jsonResp({ list: [chartSong('榜曲', 'wy1')], total: 1 });
      if (url.includes('/api/music/url')) return jsonResp({ error: '无可用音源' }, 500);
      return jsonResp([]);
    },
  });
  assert.equal(await searcher.searchChartQueue('热歌榜', { preResolve: 2 }), null);
});

test('榜单队列懒解析：取第 N 首时顺带预解析后 2 首', async t => {
  let urlCalls = 0;
  const { searcher, requests } = fixture(t, {
    handler: (url) => {
      if (url.includes('/leaderboard/boards')) return jsonResp({ list: [board('热歌榜', '3778678')], source: 'wy' });
      if (url.includes('/leaderboard/list')) {
        return jsonResp({ list: [1, 2, 3, 4, 5].map(i => chartSong(`榜曲${i}`, `wy${i}`)), total: 5 });
      }
      if (url.includes('/api/music/url')) {
        urlCalls += 1;
        return jsonResp({ url: `https://audio.test/s${urlCalls}.mp3`, type: '320k' });
      }
      return jsonResp([]);
    },
  });
  const queue = await searcher.searchChartQueue('热歌榜', { limit: 5, preResolve: 1 });
  assert.equal(urlCalls, 1, '首批只解析 1 首');
  await queue.resolveUrl(2);
  await new Promise(resolve => setImmediate(resolve));
  // 解析第 2 首时 lookahead 预解析 3、4；加上首批 1 首 = 4 次
  assert.equal(requests.filter(r => r.url.includes('/api/music/url')).length, 4);
  assert.ok(queue.peekUrl(3), '第 3 首已 lookahead 预解析');
  assert.ok(queue.peekUrl(4), '第 4 首已 lookahead 预解析');
  assert.equal(queue.peekUrl(5), '', '第 5 首尚未解析');
});
