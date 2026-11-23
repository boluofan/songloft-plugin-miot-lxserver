import assert from 'node:assert/strict';
import test from 'node:test';
import { loader } from './chat_loader.mjs';

// 入库模式：lxserver 结果改存「引用」（解析型），播放时由宿主回调 /music/url 现解析。
const load = loader({
  '../service/service': {}, '../config/manager': {},
  '../indexing/manager': {}, '../group/coordinator': {},
  // 只需要「直链为空时不构造 URL」这一条语义，其余给个可用替身即可
  '../player/url_builder': {
    URLBuilder: {
      buildSongURL: async (song) => {
        const url = song?.url || '';
        return url ? 'http://192.168.1.10:58091' + url + '?access_token=t' : '';
      },
    },
    playbackOptionsOf: () => ({}),
  },
  '../utils/http': {
    getHostAPIBaseUrl: async () => 'http://127.0.0.1:58091',
    getHostBaseUrl: async () => 'http://192.168.1.10:58091',
  },
  '../types': {},
});
const { OnlineSearcher } = load('../src/voicecmd/online_searcher.ts');
const { PLUGIN_ENTRY_PATH } = load('../src/lxserver/ref.ts');

const lxConfig = (overrides = {}) => ({
  enabled: true, host: 'http://lx.test:9527', token: '', quality: '320k',
  allowQualityFallback: true, sources: ['kw'], searchTimeout: 6, urlTimeout: 12,
  ...overrides,
});

const lxSong = (overrides = {}) => ({
  name: '晴天', singer: '周杰伦', source: 'kw', songmid: '228908',
  interval: '04:29', img: 'https://img.test/c.jpg', types: [{ type: '320k' }],
  ...overrides,
});

const jsonResp = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
});

function fixture(t, { lx = lxConfig(), noImport = false, imported = { id: 9 } } = {}) {
  const previous = globalThis.songloft;
  globalThis.songloft = {
    log: { info() {}, warn() {}, error() {} },
    plugin: { getToken: async () => 'plugin-token' },
  };
  t.after(() => { globalThis.songloft = previous; });

  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, init });
    if (url.includes('/songs/remote')) {
      const body = JSON.parse(init.body);
      return jsonResp({
        count: body.length,
        songs: body.map((item, i) => ({
          id: imported.id + i,
          type: 'remote',
          title: item.title,
          artist: item.artist,
          // 宿主 MarshalJSON 会把 url 统一改写成播放端点，解析型歌曲也一样
          url: `/api/v1/songs/${imported.id + i}/play`,
          plugin_entry_path: item.plugin_entry_path,
          source_data: item.source_data,
          dedup_key: item.dedup_key,
        })),
      });
    }
    if (url.includes('/api/music/search')) {
      // 歌手检索返回歌手；歌曲检索返回曲目
      if (url.includes('type=singer')) {
        return jsonResp([{ id: 'a1', name: 'G.E.M.邓紫棋', alias: [], albumSize: 10, source: 'kw' }]);
      }
      return jsonResp([lxSong()]);
    }
    if (url.includes('/api/music/artistSongs')) {
      return jsonResp(Array.from({ length: 5 }, (_, i) => lxSong({ name: `歌${i + 1}`, songmid: String(1000 + i) })));
    }
    if (url.includes('/api/music/url')) {
      return jsonResp({ url: 'https://audio.test/q.mp3', type: '320k' });
    }
    return jsonResp([]);
  });

  const searcher = new OnlineSearcher({
    getConfig: async () => ({
      external_search_enabled: false,
      external_search_timeout: 2,
      external_search_sources: [],
      external_search_no_import: noImport,
      lxserver: lx,
    }),
  });
  return { searcher, requests };
}

const fakeMina = () => {
  const pushed = [];
  return {
    pushed,
    playURL: async (_account, _device, url) => { pushed.push(url); return true; },
  };
};

const remoteBody = (requests) => {
  const call = requests.find(r => r.url.includes('/songs/remote'));
  assert.ok(call, '应调用 /api/v1/songs/remote 入库');
  return JSON.parse(call.init.body);
};

test('入库模式：lxserver 结果改存引用，入库体里 url 为空并带插件 entryPath', async t => {
  const { searcher, requests } = fixture(t, { noImport: false });
  const song = await searcher.search('晴天', { title: '晴天', artist: '周杰伦' });
  assert.ok(song);
  assert.match(song.url, /^https:\/\/audio\.test/, '搜索结果本身仍带直链（供直推模式用）');

  const mina = fakeMina();
  const ok = await searcher.playSearchResult(song, 'acc', 'dev', mina);
  assert.equal(ok, true);

  const body = remoteBody(requests);
  assert.equal(body.length, 1);
  assert.equal(body[0].url, '', '解析型不存直链');
  assert.equal(body[0].plugin_entry_path, PLUGIN_ENTRY_PATH);
  assert.equal(body[0].dedup_key, 'lxserver:kw:228908');
  const sourceData = JSON.parse(body[0].source_data);
  assert.equal(sourceData.platform, 'kw');
  assert.equal(sourceData.id, '228908');
  assert.equal(sourceData.raw.songmid, '228908', 'source_data 必须够播放时重新解析');

  assert.equal(mina.pushed.length, 1, '仍然推给音箱一次');
  assert.match(mina.pushed[0], /\/api\/v1\/songs\/9\/play/, '推的是宿主播放端点，直链由宿主现解析');
});

test('直链不入库模式：不写曲库，直接把原始直链推给音箱', async t => {
  const { searcher, requests } = fixture(t, { noImport: true });
  const song = await searcher.search('晴天', { title: '晴天', artist: '周杰伦' });
  assert.ok(song);

  const mina = fakeMina();
  const ok = await searcher.playSearchResult(song, 'acc', 'dev', mina);
  assert.equal(ok, true);

  assert.equal(requests.filter(r => r.url.includes('/songs/remote')).length, 0, '不入库');
  assert.deepEqual(mina.pushed, ['https://audio.test/q.mp3']);
});

test('歌手队列入库模式：整队带引用返回，完全不解析直链', async t => {
  const { searcher, requests } = fixture(t, { noImport: false, lx: lxConfig({ sources: ['wy'] }) });
  const queue = await searcher.searchArtistQueue('邓紫棋', { limit: 10, importMode: true });
  assert.ok(queue);
  assert.equal(queue.mode, 'import');
  assert.equal(queue.items.length, 5);
  assert.equal(requests.filter(r => r.url.includes('/api/music/url')).length, 0, '入库模式不需要任何直链');
  assert.equal(queue.items[0].url, undefined);

  // importSongs 一次批量写入，而不是 5 次单条导入
  const imported = await searcher.importSongs(queue.items);
  assert.equal(imported.length, 5);
  assert.equal(remoteBody(requests).length, 5);
  assert.deepEqual(imported.map(r => r.id), [9, 10, 11, 12, 13]);
});

test('歌手队列直推模式：仍是懒解析，mode=push 且首批只解析 2 首', async t => {
  const { searcher, requests } = fixture(t, { noImport: true, lx: lxConfig({ sources: ['wy'] }) });
  const queue = await searcher.searchArtistQueue('邓紫棋', { limit: 10, preResolve: 2 });
  assert.ok(queue);
  assert.equal(queue.mode, 'push');
  assert.equal(requests.filter(r => r.url.includes('/api/music/url')).length, 2);
  assert.match(queue.peekUrl(0), /audio\.test/);
});
