import assert from 'node:assert/strict';
import test from 'node:test';
import { loader } from './chat_loader.mjs';

// 加载真实 OnlineSearcher + 真实 LxServerProvider/Client，仅 mock 全局依赖与 fetch
const load = loader({
  '../service/service': {}, '../player/url_builder': {}, '../config/manager': {},
  '../indexing/manager': {}, '../group/coordinator': {}, '../utils/http': {},
  '../types': {},
});
const { OnlineSearcher } = load('../src/voicecmd/online_searcher.ts');

function lxConfig(overrides = {}) {
  return {
    enabled: true, host: 'http://lx.test:9527', token: '', quality: '320k',
    allowQualityFallback: true, sources: ['kw'], searchTimeout: 6, urlTimeout: 12,
    ...overrides,
  };
}

function fixture(t, { lx = lxConfig(), toponeSources = [], handler }) {
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
      external_search_enabled: toponeSources.length > 0,
      external_search_timeout: 2,
      external_search_sources: toponeSources.map(name => ({
        id: name, name, enabled: true, url: `https://${name}.test/search`, token: 't',
      })),
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

const lxSong = (overrides = {}) => ({
  name: '晴天', singer: '周杰伦', source: 'kw', songmid: '228908',
  interval: '04:29', img: 'https://img.test/c.jpg', types: [{ type: '320k' }],
  ...overrides,
});
const toponeResp = (data) => ({ status: 200, text: async () => JSON.stringify({ code: 0, data }) });

test('内置 lxserver 命中：返回可播直链与 source_data，不发 topone 请求', async t => {
  const { searcher, requests } = fixture(t, {
    handler: (url) => {
      if (url.includes('/api/music/search')) return jsonResp([lxSong()]);
      if (url.includes('/api/music/url')) return jsonResp({ url: 'https://audio.test/q.mp3', type: '320k' });
      return jsonResp([]);
    },
  });
  const result = await searcher.search('晴天', { title: '晴天', artist: '周杰伦' });
  assert.ok(result);
  assert.equal(result.title, '晴天');
  assert.equal(result.url, 'https://audio.test/q.mp3');
  assert.equal(result.dedup_key, 'lxserver:kw:228908');
  assert.equal(result.source_data.platform, 'kw');
  assert.equal(result.hit_source, 'lxserver', '命中来源标记为内置 lxserver');
  assert.ok(requests.every(r => !r.url.includes('.test/search') || r.url.includes('lx.test')), '未调用 topone 源');
});

test('lxserver 未命中时回退 topone 外部源', async t => {
  const toponeSong = { title: '稻香', artist: '周杰伦', url: 'https://topone.test/song.mp3' };
  const { searcher, requests } = fixture(t, {
    toponeSources: ['primary'],
    handler: (url) => {
      if (url.includes('lx.test')) return jsonResp([]); // lxserver 无结果
      return toponeResp(toponeSong);
    },
  });
  const result = await searcher.search('稻香', { title: '稻香', artist: '周杰伦' });
  assert.deepEqual(result, { ...toponeSong, hit_source: 'topone' });
  assert.ok(requests.some(r => r.url.includes('lx.test')), '先试了 lxserver');
  assert.ok(requests.some(r => r.url.includes('primary.test')), '再试了 topone');
});

test('lxserver 直链全部失败时回退 topone', async t => {
  const toponeSong = { title: '晴天', artist: '周杰伦', url: 'https://topone.test/song.mp3' };
  const { searcher } = fixture(t, {
    toponeSources: ['primary'],
    handler: (url) => {
      if (url.includes('/api/music/search')) return jsonResp([lxSong()]);
      if (url.includes('/api/music/url')) return jsonResp({ error: '音源解析失败' }, 500);
      return toponeResp(toponeSong);
    },
  });
  assert.deepEqual(await searcher.search('晴天', { title: '晴天' }), { ...toponeSong, hit_source: 'topone' });
});

test('lxserver 禁用时完全不发请求，仅走 topone', async t => {
  const toponeSong = { title: '稻香', artist: '周杰伦', url: 'https://topone.test/song.mp3' };
  const { searcher, requests } = fixture(t, {
    lx: lxConfig({ enabled: false }),
    toponeSources: ['primary'],
    handler: () => toponeResp(toponeSong),
  });
  assert.deepEqual(await searcher.search('稻香', null), { ...toponeSong, hit_source: 'topone' });
  assert.ok(requests.every(r => !r.url.includes('lx.test')), 'lxserver 禁用时不请求');
});

test('hint 歌手不匹配时重罚，可落到另一个候选', async t => {
  const { searcher } = fixture(t, {
    handler: (url) => {
      if (url.includes('/api/music/search')) {
        return jsonResp([
          lxSong({ songmid: '1', name: '晴天', singer: '周杰伦' }),
          lxSong({ songmid: '2', name: '晴天', singer: '张学友' }),
        ]);
      }
      if (url.includes('/api/music/url')) return jsonResp({ url: 'https://audio.test/x.mp3', type: '320k' });
      return jsonResp([]);
    },
  });
  const result = await searcher.search('晴天', { title: '晴天', artist: '张学友' });
  assert.ok(result);
  assert.equal(result.title, '晴天');
  const songmidUsed = result.dedup_key;
  assert.match(songmidUsed, /:2$/, '应选歌手匹配的候选');
});

test('isExternalSearchConfigured：lxserver 启用即返回 true（无需 topone 源）', async t => {
  const { searcher } = fixture(t, { handler: () => jsonResp([]) });
  assert.equal(await searcher.isExternalSearchConfigured(), true);
});

test('isExternalSearchConfigured：都未配置返回 false', async t => {
  const { searcher } = fixture(t, {
    lx: lxConfig({ enabled: false }),
    handler: () => jsonResp([]),
  });
  assert.equal(await searcher.isExternalSearchConfigured(), false);
});

test('hint 仅给歌手名时也能命中歌手匹配的候选', async t => {
  const { searcher } = fixture(t, {
    handler: (url) => {
      if (url.includes('/api/music/search')) return jsonResp([lxSong({ songmid: '9', name: '唯一', singer: 'G.E.M.邓紫棋' })]);
      if (url.includes('/api/music/url')) return jsonResp({ url: 'https://audio.test/u.mp3', type: '320k' });
      return jsonResp([]);
    },
  });
  const result = await searcher.search('邓紫棋', { title: '邓紫棋' });
  assert.ok(result, '单独歌手名应能命中歌手字段');
  assert.equal(result.title, '唯一');
  assert.equal(result.artist, 'G.E.M.邓紫棋');
});

test('searchWithDiagnosis：区分 lxserver 无候选与候选被阈值过滤', async t => {
  const { searcher } = fixture(t, {
    handler: (url) => {
      if (url.includes('/api/music/search')) return jsonResp([]);
      return jsonResp([]);
    },
  });
  const missed = await searcher.searchWithDiagnosis('邓紫棋', { title: '邓紫棋' });
  assert.equal(missed.result, null);
  assert.match(missed.reason, /未返回候选/);
});

test('searchWithDiagnosis：候选存在但不匹配时说明匹配度不足', async t => {
  const { searcher } = fixture(t, {
    handler: (url) => {
      if (url.includes('/api/music/search')) return jsonResp([lxSong({ name: '晴天', singer: '周杰伦' })]);
      if (url.includes('/api/music/url')) return jsonResp({ url: 'https://audio.test/q.mp3', type: '320k' });
      return jsonResp([]);
    },
  });
  const missed = await searcher.searchWithDiagnosis('稻香', { title: '稻香' });
  assert.equal(missed.result, null);
  assert.match(missed.reason, /匹配度不足/);
});
