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

function fixture(t, { lx = lxConfig(), noImport = false, imported = { id: 9 }, emptyImport = false } = {}) {
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
      // 模拟唯一键冲突：宿主判定这首歌已存在，不回新行
      if (emptyImport) return jsonResp({ count: 0, songs: [] });
      const body = JSON.parse(init.body);
      // 照宿主 internal/handlers/music.go 的校验来：只认「url」或「plugin_entry_path + source_data」，
      // 缺一个就整批 400。fixture 太宽松会让「漏传 plugin_entry_path」这类 bug 一路溜到线上。
      const invalid = body.findIndex(item => item.url === '' && !(item.plugin_entry_path && item.source_data));
      if (invalid >= 0) {
        return jsonResp(
          { error: `第 ${invalid + 1} 条:必须提供 url 或 (plugin_entry_path + source_data)` },
          400,
        );
      }
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
    if (url.includes('/api/v1/songs?keyword=')) {
      // 入库失败后的查重复用：宿主 keyword 过滤同时 LIKE title/artist/album/标签/参与歌手
      return jsonResp({
        songs: [{ id: 42, title: '晴天', artist: '周杰伦', type: 'remote', url: '/api/v1/songs/42/play' }],
        total: 1,
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
  // 宿主只认「url 或 (plugin_entry_path + source_data)」；只给 source_data 会让整批 400，
  // 歌手队列因此整体失败并退化成单曲搜索（用户侧表现就是「只播了一首歌」）。
  assert.equal(queue.items[0].plugin_entry_path, PLUGIN_ENTRY_PATH, '队列项必须带 entryPath');
  assert.ok(queue.items[0].source_data, '队列项必须带引用');

  // importSongs 一次批量写入，而不是 5 次单条导入
  const imported = await searcher.importSongs(queue.items);
  assert.ok(imported, '整批入库不应被宿主拒绝');
  assert.equal(imported.length, 5);
  const body = remoteBody(requests);
  assert.equal(body.length, 5);
  assert.deepEqual(body.map(item => item.plugin_entry_path), Array(5).fill(PLUGIN_ENTRY_PATH));
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

test('入库返回空（唯一键冲突）时，查重复用 keyword 过滤而不是拉全曲库', async t => {
  const { searcher, requests } = fixture(t, { noImport: false, emptyImport: true });
  const song = await searcher.search('晴天', { title: '晴天', artist: '周杰伦' });
  assert.ok(song);

  const mina = fakeMina();
  const ok = await searcher.playSearchResult(song, 'acc', 'dev', mina);
  assert.equal(ok, true);

  const probe = requests.find(r => r.url.includes('/api/v1/songs?keyword='));
  assert.ok(probe, '查重应改用宿主 keyword 过滤');
  assert.equal(decodeURIComponent(/keyword=([^&]*)/.exec(probe.url)[1]), '晴天');
  assert.match(probe.url, /limit=50/, '先筛到几十条再精确比对，不拉全库');
  assert.match(probe.url, /exclude_playlist_labels=none/, '与索引口径一致，隐藏歌单里的也算');
  assert.equal(
    requests.filter(r => r.url.includes('/api/v1/songs/names')).length,
    0,
    '查重是歌曲维度，不该去打歌手名录',
  );

  assert.equal(mina.pushed.length, 1, '复用已存在的 remote 歌，不重复入库');
  assert.match(mina.pushed[0], /\/api\/v1\/songs\/42\/play/, '推的是已存在歌曲的播放端点');
});
