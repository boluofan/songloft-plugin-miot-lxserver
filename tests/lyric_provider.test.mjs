import assert from 'node:assert/strict';
import test from 'node:test';
import { loader } from './chat_loader.mjs';

const { normalizeLyric, isLyricEmpty } = loader()('../src/lxserver/lyric.ts');

test('归一化：lxserver 无翻译时直接返回纯 LRC 字符串', () => {
  assert.equal(normalizeLyric('[00:01]晴天').lyric, '[00:01]晴天');
  assert.equal(normalizeLyric('  [00:01]晴天  ').lyric, '[00:01]晴天');
});

test('归一化：各源的别名映射到宿主 LyricPayload 字段', () => {
  assert.deepEqual(normalizeLyric({
    lrc: '[00:00]主', tlrc: '[00:00]译', rlrc: '[00:00]罗', klyric: '[00:00]逐',
  }), {
    lyric: '[00:00]主', tlyric: '[00:00]译', rlyric: '[00:00]罗', lxlyric: '[00:00]逐',
  });
  // 同名字段优先，别名兜底
  assert.equal(normalizeLyric({ lyric: 'A', lrc: 'B' }).lyric, 'A');
  assert.equal(normalizeLyric({ lxlyric: 'A', awlrc: 'B' }).lxlyric, 'A');
});

test('归一化：拆一层 {data} 信封，非歌词形态返回全空', () => {
  assert.equal(normalizeLyric({ code: 0, data: { lyric: '[00:02]嵌套' } }).lyric, '[00:02]嵌套');
  assert.equal(normalizeLyric({ code: 0, data: '  [00:03]字符串信封  ' }).lyric, '[00:03]字符串信封', 'data 为整段 LRC 字符串时也要取到主歌词');
  assert.deepEqual(normalizeLyric(null), { lyric: '', tlyric: '', rlyric: '', lxlyric: '' });
  assert.deepEqual(normalizeLyric(42), { lyric: '', tlyric: '', rlyric: '', lxlyric: '' });
  assert.equal(isLyricEmpty(normalizeLyric({ lyric: '', tlyric: '  ' })), true);
  assert.equal(isLyricEmpty(normalizeLyric({ tlyric: '[00:01]只有翻译' })), false);
});

const jsonResp = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
});

const songInfo = (id = '228908') => ({
  name: '晴天', singer: '周杰伦', source: 'kw', songmid: id,
  interval: '04:29', types: [{ type: '320k' }],
});

function setup(t, options = {}) {
  const { lyricResponse = { lyric: '[00:01]晴天' }, songs = [songInfo()] } = options;
  const previous = { fetch: globalThis.fetch, songloft: globalThis.songloft };
  const requests = [];
  let lyricCalls = 0;
  globalThis.songloft = {
    log: { info() {}, warn() {}, error() {} },
    plugin: { getToken: async () => 'tk', getHostUrl: async () => 'http://127.0.0.1:58091' },
  };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, init });
    if (url.includes('/api/music/search')) return jsonResp(songs);
    if (url.includes('/api/music/lyric')) {
      lyricCalls += 1;
      return jsonResp(typeof lyricResponse === 'function' ? lyricResponse(lyricCalls) : lyricResponse);
    }
    return jsonResp({});
  });
  t.after(() => Object.assign(globalThis, previous));

  const load = loader();
  const { createRouter } = load('../../../toolchain/packages/plugin-sdk/src/index.ts');
  const router = createRouter();
  const configManager = {
    getConfig: async () => ({
      lxserver: {
        enabled: true, host: 'http://lx.test:9527', token: '', quality: '320k',
        allowQualityFallback: true, sources: ['kw'], searchTimeout: 2, urlTimeout: 2,
      },
    }),
  };
  load('../src/handlers/lyric.ts').registerLyricHandlers(router, configManager);
  return {
    requests,
    get lyricCalls() { return lyricCalls; },
    async search(query) {
      const result = await router.handle({ method: 'GET', path: '/lyric-search', query });
      return { status: result.statusCode, body: JSON.parse(result.body) };
    },
  };
}

test('/lyric-search 命中：返回裸 LyricPayload，POST 带完整 songInfo', async t => {
  const h = setup(t, { lyricResponse: { lyric: '[00:01]晴天', tlyric: '[00:01]Sunny' } });
  const result = await h.search('title=晴天&artist=周杰伦&duration=269');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { lyric: '[00:01]晴天', tlyric: '[00:01]Sunny' });
  assert.equal(result.body.success, undefined, '宿主直接反序列化，不能包 envelope');

  const lyricReq = h.requests.find(r => r.url.includes('/api/music/lyric'));
  assert.ok(lyricReq, '发起了歌词请求');
  assert.equal(lyricReq.init.method, 'POST');
  const sent = JSON.parse(lyricReq.init.body);
  assert.equal(sent.songInfo.songmid, '228908', '必须回传原样 songInfo 而不是内部 id');
  assert.equal(sent.songInfo.source, 'kw');
});

test('/lyric-search 未找到：返回 404 让宿主跳到下一个提供者', async t => {
  const h = setup(t, { lyricResponse: { lyric: '', tlyric: '   ' } });
  const result = await h.search('title=晴天&artist=周杰伦');
  assert.equal(result.status, 404);
  assert.deepEqual(result.body, {});
});

test('/lyric-search 首候选无词时继续找下一首，命中即停', async t => {
  const h = setup(t, {
    songs: [1, 2, 3, 4, 5].map(String).map(songInfo),
    lyricResponse: call => (call === 2 ? { lyric: '[00:05]第二首' } : { lyric: '' }),
  });
  const result = await h.search('title=晴天&artist=周杰伦');
  assert.equal(result.body.lyric, '[00:05]第二首');
  assert.equal(h.lyricCalls, 2, '第二首命中即停');
});

test('/lyric-search 未配置内置源时不发任何请求', async t => {
  const h = setup(t);
  h.configManager = null; // 下面用单独 router 覆盖，避免改 fixture 语义
  const load = loader();
  const { createRouter } = load('../../../toolchain/packages/plugin-sdk/src/index.ts');
  const router = createRouter();
  load('../src/handlers/lyric.ts').registerLyricHandlers(router);
  const result = await router.handle({
    method: 'GET', path: '/lyric-search', query: 'title=晴天',
  });
  assert.equal(result.statusCode, 404);
  assert.deepEqual(JSON.parse(result.body), {});
  assert.equal(h.requests.length, 0);
});
