import assert from 'node:assert/strict';
import test from 'node:test';
import { loader } from './chat_loader.mjs';

// 解析型音源：ref 编解码 + provider.resolveSongRef + 宿主回调端点 POST /music/url
const load = loader();
const {
  buildSongRef, buildToponeRef, decodeSongRef, decodeToponeRef, decodeAnyRef,
  encodeSongRef, isOwnSongRef, isResolvableSong, toponeDedupKey, PLUGIN_ENTRY_PATH,
} = load('../src/lxserver/ref.ts');
const { LxServerProvider } = load('../src/lxserver/provider.ts');

const lxConfig = (overrides = {}) => ({
  enabled: true,
  host: 'http://lx.test:9527',
  token: '',
  quality: '320k',
  allowQualityFallback: false, // 关掉阶梯，便于数 /api/music/url 的调用次数
  sources: ['kw'],
  searchTimeout: 6,
  urlTimeout: 12,
  ...overrides,
});

function withSongloft(t) {
  const previous = globalThis.songloft;
  globalThis.songloft = {
    log: { info() {}, warn() {}, error() {} },
    plugin: { getToken: async () => 'plugin-token' },
  };
  t.after(() => { globalThis.songloft = previous; });
}

function track(overrides = {}) {
  return {
    id: '228908',
    name: '晴天',
    singer: '周杰伦',
    album: '叶惠美',
    duration: 269,
    cover: 'https://img.test/c.jpg',
    source: 'kw',
    quality: '320k',
    raw: {
      name: '晴天', singer: '周杰伦', source: 'kw', songmid: '228908',
      lyric: '[00:00]一大段歌词'.repeat(50),
      tlyric: 'translation',
      desc: '一段很长的简介',
    },
    ...overrides,
  };
}

const jsonResp = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
});

// ---------- ref 编解码 ----------

test('buildSongRef：保留平台/id/songInfo，裁掉歌词与长文本', t => {
  withSongloft(t);
  const ref = buildSongRef(track(), '320k');
  assert.equal(ref.v, 1);
  assert.equal(ref.owner, PLUGIN_ENTRY_PATH, '带上生产者标记，入库改写只认自家引用');
  assert.equal(ref.platform, 'kw');
  assert.equal(ref.id, '228908');
  assert.equal(ref.name, '晴天');
  assert.equal(ref.quality, '320k');
  assert.equal(ref.raw.songmid, '228908', '解析直链所需的字段必须保留');
  assert.equal(ref.raw.lyric, undefined, '歌词不该进 source_data');
  assert.equal(ref.raw.tlyric, undefined);
  assert.equal(ref.raw.desc, undefined);
});

test('source_data 超限时丢弃 raw，但仍保留可重搜的 platform/id', t => {
  withSongloft(t);
  const huge = track({ raw: { name: '晴天', source: 'kw', songmid: '228908', blob: 'x'.repeat(20000) } });
  const ref = buildSongRef(huge);
  assert.equal(ref.raw, undefined, '超限降级：raw 不落库，播放时重搜兜底');
  assert.equal(ref.platform, 'kw');
  assert.equal(ref.id, '228908');
  assert.equal(ref.name, '晴天');
});

test('decodeSongRef：字符串/对象两种形态都能反解，脏数据返回 null', t => {
  withSongloft(t);
  const ref = buildSongRef(track());
  const encoded = encodeSongRef(ref);

  const fromString = decodeSongRef(encoded);
  assert.equal(fromString.id, '228908');
  assert.equal(fromString.raw.songmid, '228908');

  const fromObject = decodeSongRef(ref);
  assert.equal(fromObject.platform, 'kw');

  assert.equal(decodeSongRef(''), null);
  assert.equal(decodeSongRef('not-json'), null);
  assert.equal(decodeSongRef({ platform: 'kw' }), null, '缺 id 不可解析');
  assert.equal(decodeSongRef([1, 2]), null);
});

test('isOwnSongRef：外部源的 source_data 不被误判为本插件引用', t => {
  withSongloft(t);
  assert.equal(isResolvableSong({ source_data: buildSongRef(track()) }), true);
  assert.equal(isOwnSongRef({ source_data: buildSongRef(track()) }), true);
  // 结构像但没有 owner：可能是别的源的 source_data，不得改写为解析型
  assert.equal(isOwnSongRef({ source_data: { platform: 'kw', id: '1' } }), false);
});

// ---------- provider.resolveSongRef ----------

test('resolveSongRef：raw 在就直接解析，不重搜', async t => {
  withSongloft(t);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/api/music/url')) {
      const body = JSON.parse(init.body);
      assert.equal(body.songInfo.songmid, '228908', '必须回传完整 songInfo');
      return jsonResp({ url: 'https://audio.test/q.mp3', type: '320k' });
    }
    return jsonResp([]);
  });

  const provider = new LxServerProvider(lxConfig());
  const playable = await provider.resolveSongRef(buildSongRef(track()));
  assert.equal(playable.url, 'https://audio.test/q.mp3');
  assert.equal(calls.filter(c => c.url.includes('/api/music/search')).length, 0, 'raw 够用就不该多搜一次');
  assert.equal(calls.filter(c => c.url.includes('/api/music/url')).length, 1);
});

test('resolveSongRef：raw 失效时按 platform+id 重搜兜底', async t => {
  withSongloft(t);
  const calls = [];
  let urlAttempts = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/api/music/url')) {
      urlAttempts += 1;
      // 第一次（用旧 raw）失败，重搜后再解析成功
      if (urlAttempts === 1) return jsonResp({ error: '音源失效' }, 500);
      return jsonResp({ url: 'https://audio.test/fresh.mp3', type: '320k' });
    }
    if (url.includes('/api/music/search')) {
      return jsonResp([
        { name: '晴天', singer: '周杰伦', source: 'kw', songmid: '999999', interval: '04:00' },
        { name: '晴天', singer: '周杰伦', source: 'kw', songmid: '228908', interval: '04:29' },
      ]);
    }
    return jsonResp([]);
  });

  const provider = new LxServerProvider(lxConfig());
  const playable = await provider.resolveSongRef(buildSongRef(track()));
  assert.equal(playable.url, 'https://audio.test/fresh.mp3');
  assert.equal(calls.filter(c => c.url.includes('/api/music/search')).length, 1, 'raw 不够时重搜一次');
  assert.equal(urlAttempts, 2);
});

test('resolveSongRef：全链路失败时抛错（宿主据此返 502 并切源）', async t => {
  withSongloft(t);
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('/api/music/url')) return jsonResp({ error: '无可用音源' }, 500);
    return jsonResp([]);
  });

  const provider = new LxServerProvider(lxConfig());
  await assert.rejects(() => provider.resolveSongRef(buildSongRef(track())), /无可用音源|无 url|解析失败/);
});

test('resolveSongRef：lxserver 未启用直接拒绝', async t => {
  withSongloft(t);
  const provider = new LxServerProvider(lxConfig({ enabled: false }));
  await assert.rejects(() => provider.resolveSongRef(buildSongRef(track())), /未配置|未启用/);
});

// ---------- 宿主回调端点 POST /music/url ----------

function handlerFixture(t, { lx = lxConfig(), sources = [], fetchHost } = {}) {
  withSongloft(t);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, init });
    return fetchHost(url, init);
  });

  const overrides = {
    '@songloft/plugin-sdk': {
      jsonResponse: (body, status = 200) => ({ statusCode: status, body: JSON.stringify(body) }),
    },
    './chat': {
      chatBody: (req) => JSON.parse(typeof req.body === 'string' ? req.body : '{}'),
    },
    // music_url 内部的 OnlineSearcher 需要这些依赖，全部给最小替身
    '../service/service': {},
    '../player/url_builder': { URLBuilder: { buildSongURL: async () => '' }, playbackOptionsOf: () => ({}) },
    '../config/manager': {},
    '../indexing/manager': {},
    '../group/coordinator': {},
    '../utils/http': {
      getHostAPIBaseUrl: async () => 'http://127.0.0.1:58091',
      getHostBaseUrl: async () => 'http://192.168.1.10:58091',
    },
    '../types': {},
  };
  const loadH = loader(overrides);
  const { registerMusicSourceHandlers } = loadH('../src/handlers/music_url.ts');

  const routes = new Map();
  const router = {
    post: (path, handler) => routes.set('POST ' + path, handler),
    get: (path, handler) => routes.set('GET ' + path, handler),
    async handle(req) {
      const handler = routes.get(req.method + ' ' + req.path);
      if (!handler) return { statusCode: 404, body: '{}' };
      return handler(req);
    },
  };
  registerMusicSourceHandlers(router, {
    getConfig: async () => ({
      lxserver: lx,
      external_search_enabled: sources.length > 0,
      external_search_timeout: 2,
      external_search_sources: sources,
    }),
  });

  return {
    requests,
    async call(body) {
      const response = await router.handle({ method: 'POST', path: '/music/url', body: JSON.stringify(body) });
      return { status: response.statusCode, body: JSON.parse(response.body) };
    },
  };
}

test('POST /music/url：正常解析返回 {url}', async t => {
  const h = handlerFixture(t, {
    fetchHost: async (url) => {
      if (url.includes('/api/music/url')) return jsonResp({ url: 'https://audio.test/ok.mp3', type: '320k' });
      return jsonResp([]);
    },
  });
  const result = await h.call({ source_data: encodeSongRef(buildSongRef(track())) });
  assert.equal(result.status, 200);
  assert.equal(result.body.url, 'https://audio.test/ok.mp3');
});

test('POST /music/url：source_data 非法返回 400，不打上游', async t => {
  const h = handlerFixture(t, { fetchHost: async () => jsonResp([]) });
  for (const source_data of ['', 'garbage', { platform: 'kw' }, null]) {
    const result = await h.call({ source_data });
    assert.equal(result.status, 400);
  }
  assert.equal(h.requests.length, 0);
});

test('POST /music/url：解析失败返回 502（不伪造 url）', async t => {
  const h = handlerFixture(t, {
    fetchHost: async (url) => (url.includes('/api/music/url') ? jsonResp({ error: '无可用音源' }, 500) : jsonResp([])),
  });
  const result = await h.call({ source_data: encodeSongRef(buildSongRef(track())) });
  assert.equal(result.status, 502);
  assert.ok(result.body.error);
  assert.equal(result.body.url, undefined);
});

test('POST /music/url：lxserver 未启用时返回 502 并说明原因', async t => {
  const h = handlerFixture(t, { lx: lxConfig({ enabled: false }), fetchHost: async () => jsonResp([]) });
  const result = await h.call({ source_data: encodeSongRef(buildSongRef(track())) });
  assert.equal(result.status, 502);
  assert.match(result.body.error, /未启用|未配置/);
});

// ---------- topone 外部源的引用 ----------

const toponeHits = (url) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ code: 0, msg: '', data: { title: '晴天', artist: '周杰伦', url } }),
});

test('buildToponeRef：记下源/关键词/hint，并给出可去重的 dedup_key', t => {
  withSongloft(t);
  const ref = buildToponeRef(
    { title: '晴天', artist: '周杰伦', duration: 269 },
    { sourceId: 'src_a', keyword: '晴天 周杰伦', hint: { title: '晴天', artist: '周杰伦' } },
  );
  assert.equal(ref.kind, 'topone');
  assert.equal(ref.owner, PLUGIN_ENTRY_PATH);
  assert.equal(ref.source_id, 'src_a');
  assert.equal(ref.keyword, '晴天 周杰伦');
  assert.equal(ref.hint.artist, '周杰伦');

  const decoded = decodeToponeRef(ref);
  assert.equal(decoded.kind, 'topone');
  assert.equal(decoded.source_id, 'src_a');
  // 缺源或关键词的引用不可解析
  assert.equal(decodeToponeRef({ kind: 'topone', keyword: '晴天' }), null);
  // 同一引用反复反解结果必须一致（换个实例没关系，内容要相等）
  assert.deepEqual(decodeToponeRef(ref), decodeToponeRef(ref));

  assert.equal(toponeDedupKey('src_a', { title: ' 晴天 ', artist: '周杰伦' }), 'topone:src_a:晴天|周杰伦');
  // 同源同歌名同歌手 → 同一个 key（反复搜索不会重复入库）
  assert.equal(
    toponeDedupKey('src_a', { title: '晴天', artist: '周杰伦' }),
    toponeDedupKey('src_a', { title: '晴天', artist: '周杰伦 ' }),
  );
});

test('decodeAnyRef：lxserver 与 topone 两种引用都能分辨', t => {
  withSongloft(t);
  assert.equal(decodeAnyRef(buildSongRef(track())).kind, 'lxserver');
  assert.equal(
    decodeAnyRef(buildToponeRef({ title: '晴天' }, { sourceId: 's1', keyword: '晴天' })).kind,
    'topone',
  );
  // 老数据没有 kind：按 lxserver 解析
  const legacy = JSON.stringify({ owner: 'miot', platform: 'kw', id: '1', name: '晴天' });
  assert.equal(decodeAnyRef(legacy).kind, 'lxserver');
  assert.equal(decodeAnyRef({ platform: 'kw' }), null);
});

test('POST /music/url：topone 引用重跑原源搜索拿新鲜直链', async t => {
  const sources = [{ id: 'src_a', name: 'A', url: 'https://a.test/search', enabled: true, token: 't' }];
  const h = handlerFixture(t, {
    sources,
    fetchHost: async (url) => (url.includes('a.test/search') ? toponeHits('https://cdn.test/fresh.mp3') : jsonResp([])),
  });
  const ref = buildToponeRef({ title: '晴天', artist: '周杰伦' }, { sourceId: 'src_a', keyword: '晴天' });
  const result = await h.call({ source_data: ref });
  assert.equal(result.status, 200);
  assert.equal(result.body.url, 'https://cdn.test/fresh.mp3');

  const searchCall = h.requests.find(r => r.url === 'https://a.test/search');
  assert.ok(searchCall, '应回到原源重搜');
  const body = JSON.parse(searchCall.init.body);
  assert.equal(body.keyword, '晴天');
});

test('POST /music/url：原源已不在配置里时用其它启用源兜底', async t => {
  const sources = [{ id: 'src_b', name: 'B', url: 'https://b.test/search', enabled: true, token: 't' }];
  const h = handlerFixture(t, {
    sources,
    fetchHost: async (url) => (url.includes('b.test/search') ? toponeHits('https://cdn.test/b.mp3') : jsonResp([])),
  });
  const ref = buildToponeRef({ title: '晴天' }, { sourceId: 'src_gone', keyword: '晴天' });
  const result = await h.call({ source_data: ref });
  assert.equal(result.status, 200);
  assert.equal(result.body.url, 'https://cdn.test/b.mp3');
});

test('POST /music/url：外部源全部未命中时 502', async t => {
  const sources = [{ id: 'src_b', name: 'B', url: 'https://b.test/search', enabled: true, token: 't' }];
  const h = handlerFixture(t, {
    sources,
    fetchHost: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 404, msg: '未命中', data: null }) }),
  });
  const ref = buildToponeRef({ title: '晴天' }, { sourceId: 'src_b', keyword: '晴天' });
  const result = await h.call({ source_data: ref });
  assert.equal(result.status, 502);
  assert.match(result.body.error, /解析失败/);
});
