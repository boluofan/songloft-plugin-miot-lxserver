import assert from 'node:assert/strict';
import test from 'node:test';
import { loader, flush } from './chat_loader.mjs';

// 加载真实 OnlineSearcher + 真实 LxServerProvider/Client，仅 mock 全局依赖与 fetch
const load = loader({
  '../service/service': {}, '../player/url_builder': {}, '../config/manager': {},
  '../indexing/manager': {}, '../group/coordinator': {}, '../utils/http': {},
  '../types': {},
});
const { OnlineSearcher, DIRECT_URL_TTL_MS } = load('../src/voicecmd/online_searcher.ts');

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

/** 外部源命中：直链照给，同时挂上「怎么搜到的」引用（入库模式靠它代替直链） */
function assertToponeRef(result, sourceId, keyword) {
  assert.equal(result.source_data?.kind, 'topone', '挂上 topone 引用');
  assert.equal(result.source_data.source_id, sourceId);
  assert.equal(result.source_data.keyword, keyword);
  assert.equal(result.source_data.owner, 'miot');
  assert.equal(result.dedup_key, `topone:${sourceId}:${result.title}|${result.artist}`, '给出可去重的 dedup_key');
}

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
  assert.equal(result.url, toponeSong.url, '直链模式仍返回可直接播的链接');
  assert.equal(result.artist, '周杰伦');
  assert.equal(result.hit_source, 'topone');
  assertToponeRef(result, 'primary', '稻香');
  assert.deepEqual(result.source_data.hint, { title: '稻香', artist: '周杰伦' }, '记下 hint 供重搜时优先命中同一首');
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
  const result = await searcher.search('晴天', { title: '晴天' });
  assert.equal(result.url, toponeSong.url);
  assert.equal(result.hit_source, 'topone');
  assertToponeRef(result, 'primary', '晴天');
});

test('lxserver 禁用时完全不发请求，仅走 topone', async t => {
  const toponeSong = { title: '稻香', artist: '周杰伦', url: 'https://topone.test/song.mp3' };
  const { searcher, requests } = fixture(t, {
    lx: lxConfig({ enabled: false }),
    toponeSources: ['primary'],
    handler: () => toponeResp(toponeSong),
  });
  const result = await searcher.search('稻香', null);
  assert.equal(result.url, toponeSong.url);
  assert.equal(result.hit_source, 'topone');
  assert.equal(result.source_data.kind, 'topone');
  assert.equal(result.source_data.keyword, '稻香', 'hint 为空时仍记下关键词');
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

// ===== 歌手在线歌曲（懒解析） =====

const lxArtist = (overrides = {}) => ({
  id: '7763', name: 'G.E.M.邓紫棋', picUrl: 'http://y.gtimg.cn/a.jpg',
  alias: [], albumSize: 30, source: 'wy', ...overrides,
});
const lxArtistSong = (i) => ({
  name: `歌${i}`, singer: 'G.E.M.邓紫棋', source: 'wy', songmid: `m${i}`,
  interval: '03:30', img: 'https://img.test/a.jpg', types: [{ type: '320k' }],
});

/** 歌手队列 fixture：sources 默认含 wy/tx，artistSongs 返回 count 首 */
function artistFixture(t, { lx = lxConfig({ sources: ['wy', 'tx'] }), artists = [lxArtist()], count = 6, urlHandler } = {}) {
  let urlCalls = 0;
  const built = fixture(t, {
    lx,
    handler: (url, init) => {
      if (url.includes('/api/music/search')) return jsonResp(artists);
      if (url.includes('/api/music/artistSongs')) {
        return jsonResp(Array.from({ length: count }, (_, i) => lxArtistSong(i + 1)));
      }
      if (url.includes('/api/music/url')) {
        urlCalls += 1;
        if (urlHandler) return urlHandler(url, init);
        const body = JSON.parse(init?.body || '{}');
        return jsonResp({ url: `https://audio.test/${body.songInfo?.name || 'x'}.mp3`, type: '320k' });
      }
      return jsonResp([]);
    },
  });
  return { ...built, urlCalls: () => urlCalls, requests: built.requests };
}

test('searchArtistQueue：命中歌手返回队列，只预解析前 2 首直链', async t => {
  const { searcher, requests } = artistFixture(t, { count: 6 });
  const queue = await searcher.searchArtistQueue('邓紫棋');
  assert.ok(queue, '应返回队列');
  assert.equal(queue.artistName, 'G.E.M.邓紫棋');
  assert.equal(queue.total, 6);
  assert.equal(queue.items.length, 6);
  assert.equal(queue.items[0].title, '歌1');
  assert.equal(queue.items[0].hit_source, 'lxserver');
  assert.equal(queue.items[0].url, undefined, '队列项不带直链，走懒解析');

  const urlCalls = requests.filter(r => r.url.includes('/api/music/url')).length;
  assert.equal(urlCalls, 2, '首播只解析前 2 首，不解析整队');

  assert.match(queue.peekUrl(0), /\.mp3$/, '首批已解析可直接起播');
  assert.equal(queue.peekUrl(2), '', '第 3 首尚未解析');
});

test('searchArtistQueue：解析到第 N 首时才解析该首，并顺带预解析后 2 首', async t => {
  const { searcher, requests } = artistFixture(t, { count: 6 });
  const queue = await searcher.searchArtistQueue('邓紫棋');
  assert.equal(requests.filter(r => r.url.includes('/api/music/url')).length, 2);

  const third = await queue.resolveUrl(2);
  assert.match(third, /歌3\.mp3$/);
  await flush();
  const afterThird = requests.filter(r => r.url.includes('/api/music/url')).length;
  assert.equal(afterThird, 5, '第 3 首 + lookahead 第 4/5 首 = 5 次解析');
  assert.match(queue.peekUrl(3), /歌4\.mp3$/, 'lookahead 已把第 4 首预热好');
  assert.equal(queue.peekUrl(5), '', '不越界预解析第 6 首');

  // 已解析的不重复请求
  await queue.resolveUrl(2);
  await flush();
  assert.equal(requests.filter(r => r.url.includes('/api/music/url')).length, 5);
});

test('searchArtistQueue：歌手名精确匹配优先于包含匹配/高热度号', async t => {
  const { searcher, requests } = artistFixture(t, {
    artists: [
      lxArtist({ id: 'fan', name: 'G.E.M.邓紫棋粉丝团', albumSize: 999 }),
      lxArtist({ id: '7763', name: 'G.E.M.邓紫棋', albumSize: 10 }),
    ],
    count: 3,
  });
  await searcher.searchArtistQueue('邓紫棋');
  const artistCall = requests.find(r => r.url.includes('/api/music/artistSongs'));
  assert.ok(artistCall, '应调用 artistSongs');
  assert.match(artistCall.url, /id=7763/, '选精确同名歌手');
});

test('searchArtistQueue：源不支持歌手能力时返回 null 且不请求 artistSongs', async t => {
  const { searcher, requests } = artistFixture(t, { lx: lxConfig({ sources: ['kw'] }) });
  assert.equal(await searcher.searchArtistQueue('邓紫棋'), null);
  assert.ok(requests.every(r => !r.url.includes('/api/music/artistSongs')), 'kw 不支持歌手搜索，直接跳过');
});

test('searchArtistQueue：首批直链全部解析失败时返回 null（交给单曲兜底）', async t => {
  const { searcher } = artistFixture(t, {
    count: 4,
    urlHandler: () => jsonResp({ error: '音源解析失败' }, 500),
  });
  assert.equal(await searcher.searchArtistQueue('邓紫棋'), null);
});

test('searchArtistQueue：lxserver 未启用时返回 null', async t => {
  const { searcher } = artistFixture(t, { lx: lxConfig({ enabled: false, sources: ['wy'] }) });
  assert.equal(await searcher.searchArtistQueue('邓紫棋'), null);
});

// ===== 直链 TTL =====
// 直链是签名 CDN，解析那一刻开始倒计时。队列会预解析后续曲目，用户长时间暂停后再播
// 就会拿到过期链接，表现为「起播失败」。所以缓存必须带时刻，过期就得重解析。

/** 可控时钟：把 Date.now 往后拨，模拟「暂停了很久」 */
function withClock(t) {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  const clock = t.mock.method(Date, 'now', () => realNow() + offset);
  return {
    advance(ms) { offset += ms; },
    /** 时钟拨到 TTL 之后（再留 1 秒余量） */
    expire() { offset += DIRECT_URL_TTL_MS + 1000; },
  };
}

const urlCallCount = (requests) => requests.filter(r => r.url.includes('/api/music/url')).length;

test('searchArtistQueue：TTL 未到期时命中缓存，重复取同一首不再发解析请求', async t => {
  const clock = withClock(t);
  const { searcher, requests } = artistFixture(t, { count: 4 });
  const queue = await searcher.searchArtistQueue('邓紫棋');
  assert.equal(urlCallCount(requests), 2, '预解析前 2 首');

  // 播完一首歌的时间尺度内，缓存依然新鲜
  clock.advance(DIRECT_URL_TTL_MS - 1000);
  assert.match(queue.peekUrl(0), /歌1\.mp3$/, '未过期仍可直接起播');

  // 缓存命中时 resolveOne 直接返回，连 lookahead 都不会触发
  assert.match(await queue.resolveUrl(0), /歌1\.mp3$/);
  await flush();
  assert.equal(urlCallCount(requests), 2, '未过期不该重新解析');
});

test('searchArtistQueue：TTL 到期后 peekUrl 返回空，resolveUrl 重新解析拿新直链', async t => {
  const clock = withClock(t);
  // 每次解析给不同 URL，才能确认拿到的是「新」链接而不是旧缓存
  let seq = 0;
  const { searcher, requests } = artistFixture(t, {
    count: 4,
    urlHandler: (url, init) => {
      seq += 1;
      const body = JSON.parse(init?.body || '{}');
      return jsonResp({ url: `https://audio.test/${body.songInfo?.name || 'x'}-${seq}.mp3`, type: '320k' });
    },
  });
  const queue = await searcher.searchArtistQueue('邓紫棋');
  const first = queue.peekUrl(0);
  assert.match(first, /歌1-1\.mp3$/, '首批解析到的是第一版链接');
  assert.equal(urlCallCount(requests), 2);

  clock.expire();
  assert.equal(queue.peekUrl(0), '', '过期后不该再把旧链接交出去');
  assert.equal(queue.peekUrl(1), '', '同一批预解析的其它曲目一起过期');

  const refreshed = await queue.resolveUrl(0);
  assert.ok(refreshed && refreshed !== first, '过期后必须重新解析');
  assert.match(refreshed, /歌1-3\.mp3$/, '拿到的是新签的链接');
  assert.equal(queue.peekUrl(0), refreshed, '新链接写回缓存');
  assert.ok(urlCallCount(requests) > 2, '确实重新发了 /api/music/url');
});

test('searchArtistQueue：TTL 到期不会误伤未解析的曲目（仍按需解析一次）', async t => {
  const clock = withClock(t);
  const { searcher, requests } = artistFixture(t, { count: 6 });
  const queue = await searcher.searchArtistQueue('邓紫棋');
  assert.equal(queue.peekUrl(4), '', '第 5 首本来就没解析');

  clock.expire();
  const fifth = await queue.resolveUrl(4);
  assert.match(fifth, /歌5\.mp3$/);
  await flush();
  // 第 5 首自身 + lookahead 第 6 首（第 7 首越界不计）
  assert.equal(urlCallCount(requests), 2 + 2, '只解析未解析过的曲目，不会把整队重刷一遍');
  assert.match(queue.peekUrl(5), /歌6\.mp3$/, '第 6 首由 lookahead 顺手预热');
});
