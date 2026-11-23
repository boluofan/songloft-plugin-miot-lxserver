import assert from 'node:assert/strict';
import test from 'node:test';
import { loader } from './chat_loader.mjs';

// client.ts 只依赖 types.ts（type-only + LxError 类），用 loader 直接加载真实实现
const load = loader({
  '../types': {}, // lxserver/types.ts 只从 types.ts 做 type import，运行期无依赖
});
const { LxServerClient } = load('../src/lxserver/client.ts');
const { LxError } = load('../src/lxserver/types.ts');

function setupFetch(t, handler) {
  const previous = globalThis.songloft;
  globalThis.songloft = { log: { info() {}, warn() {}, error() {} } };
  t.after(() => { globalThis.songloft = previous; });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, init });
    return handler(url, init, requests.length);
  });
  return requests;
}

function config(overrides = {}) {
  return {
    enabled: true, host: 'http://lx.test:9527', token: '', quality: '320k',
    allowQualityFallback: true, sources: ['kw', 'kg'], searchTimeout: 6, urlTimeout: 12,
    ...overrides,
  };
}

const songInfo = (overrides = {}) => ({
  name: '晴天', singer: '周杰伦', source: 'kw', songmid: '228908',
  interval: '04:29', img: 'https://img.test/cover.jpg',
  types: [{ type: '128k' }, { type: '320k' }],
  ...overrides,
});

const jsonResp = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
});

test('search v2.1.2 裸数组形态', async t => {
  setupFetch(t, () => jsonResp([songInfo(), songInfo({ songmid: '2', name: '稻香' })]));
  const client = new LxServerClient(config());
  const tracks = await client.searchSongs('kw', '晴天');
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].name, '晴天');
  assert.equal(tracks[0].id, '228908');
  assert.equal(tracks[0].duration, 269, 'interval mm:ss → 秒');
});

test('search v2.1.3+ {list} 对象形态', async t => {
  const requests = setupFetch(t, () => jsonResp({ list: [songInfo({ source: 'kg' })], total: 100, hasMore: true }));
  const client = new LxServerClient(config());
  const tracks = await client.searchSongs('kg', '晴天');
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].source, 'kg');
  const url = requests[0].url;
  assert.match(url, /source=kg/);
  assert.match(url, /limit=20/);
});

test('search 200 错误信封抛 LxError 而非静默为空', async t => {
  setupFetch(t, () => jsonResp({ error: '不支持的音源' }));
  const client = new LxServerClient(config());
  await assert.rejects(() => client.searchSongs('xx', '晴天'), (e) => e instanceof LxError && /不支持的音源/.test(e.message));
});

test('平台主 ID 规则：kg 用 hash、mg 用 copyrightId、其余 songmid', async t => {
  setupFetch(t, () => jsonResp([
    songInfo({ source: 'kg', songmid: 'numeric', hash: 'HASH123' }),
    songInfo({ source: 'mg', songmid: 'm1', copyrightId: 'CPR456' }),
    songInfo({ source: 'tx', songmid: 'MID789' }),
  ]));
  const client = new LxServerClient(config());
  const tracks = await client.searchSongs('kw', 'x');
  assert.equal(tracks[0].id, 'HASH123');
  assert.equal(tracks[1].id, 'CPR456');
  assert.equal(tracks[2].id, 'MID789');
});

test('匿名模式不发鉴权头', async t => {
  const requests = setupFetch(t, () => jsonResp([songInfo()]));
  const client = new LxServerClient(config({ token: '' }));
  await client.searchSongs('kw', '晴天');
  const headers = requests[0].init.headers;
  assert.equal(headers['x-user-token'], undefined);
  assert.equal(headers['x-user-name'], undefined);
});

test('token 由 verify 反查用户名，x-user-name + x-user-token 成对注入', async t => {
  const requests = setupFetch(t, (url) => {
    if (url.includes('/api/user/auth/verify')) return jsonResp({ valid: true, username: 'alice' });
    return jsonResp([songInfo()]);
  });
  const client = new LxServerClient(config({ token: 'lx_tk_abc' }));
  await client.searchSongs('kw', '晴天');
  const searchReq = requests.find(r => r.url.includes('/api/music/search'));
  assert.equal(searchReq.init.headers['x-user-token'], 'lx_tk_abc');
  assert.equal(searchReq.init.headers['x-user-name'], 'alice', '用户名由 token 反查，不手填');
  assert.equal((await client.authState()).mode, 'user');
});

test('token 失效时降级匿名，不阻断搜索', async t => {
  setupFetch(t, (url) => {
    if (url.includes('/api/user/auth/verify')) return jsonResp({ valid: false });
    return jsonResp([songInfo()]);
  });
  const client = new LxServerClient(config({ token: 'bad' }));
  const tracks = await client.searchSongs('kw', '晴天');
  assert.equal(tracks.length, 1);
  assert.equal((await client.authState()).mode, 'invalid');
});

test('token/基址切换作废鉴权缓存（防串号）', async t => {
  const requests = setupFetch(t, (url, init) => {
    if (url.includes('/api/user/auth/verify')) {
      const token = init.headers['x-user-token'];
      return token === 'lx_tk_A' ? jsonResp({ valid: true, username: 'alice' }) : jsonResp({ valid: true, username: 'bob' });
    }
    return jsonResp([songInfo()]);
  });
  const clientA = new LxServerClient(config({ host: 'http://a.test', token: 'lx_tk_A' }));
  const clientB = new LxServerClient(config({ host: 'http://b.test', token: 'lx_tk_B' }));
  await clientA.searchSongs('kw', '晴天');
  await clientB.searchSongs('kw', '晴天');
  const verifyUrls = requests.filter(r => r.url.includes('/verify')).map(r => r.url);
  assert.equal(verifyUrls.length, 2, '两个 token 各自反查一次');
  assert.match(verifyUrls[0], /a\.test/);
  assert.match(verifyUrls[1], /b\.test/);
  assert.equal((await clientA.authState()).user, 'alice');
  assert.equal((await clientB.authState()).user, 'bob');
});

test('音质阶梯降级：flac 失败后依次 320k、128k', async t => {
  const requests = setupFetch(t, (url, init) => {
    if (url.includes('/api/music/url')) {
      const { quality } = JSON.parse(init.body);
      if (quality === 'flac') return jsonResp({ error: '无损源解析失败' }, 500);
      return jsonResp({ url: `https://audio.test/${quality}.mp3`, type: quality });
    }
    return jsonResp([songInfo()]);
  });
  const client = new LxServerClient(config({ quality: 'flac', allowQualityFallback: true }));
  const playable = await client.resolveUrlLadder(songInfo());
  assert.equal(playable.type, '320k');
  assert.equal(playable.url, 'https://audio.test/320k.mp3');
  const urlQualities = requests
    .filter(r => r.url.includes('/api/music/url'))
    .map(r => JSON.parse(r.init.body).quality);
  assert.deepEqual(urlQualities, ['flac', '320k']);
});

test('关闭降级时只请求指定音质', async t => {
  const requests = setupFetch(t, () => jsonResp({ url: 'https://audio.test/x.mp3', type: 'flac' }));
  const client = new LxServerClient(config({ quality: 'flac', allowQualityFallback: false }));
  await client.resolveUrlLadder(songInfo());
  assert.equal(requests.length, 1);
});

test('直链解析必须回传完整 songInfo（含 hash）', async t => {
  const requests = setupFetch(t, () => jsonResp({ url: 'https://audio.test/x.mp3', type: '320k' }));
  const client = new LxServerClient(config());
  const si = songInfo({ source: 'kg', hash: 'HASH', extra: 'keep-me' });
  await client.musicUrl(si, '320k');
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.songInfo.hash, 'HASH');
  assert.equal(body.songInfo.extra, 'keep-me', 'songInfo 必须原样回传');
  assert.equal(body.quality, '320k');
});

test('多源聚合失败隔离：坏源不影响好源，按 sources 顺序返回', async t => {
  setupFetch(t, (url) => {
    if (url.includes('source=bad')) return jsonResp({ error: 'bad source' });
    if (url.includes('source=kw')) return jsonResp([songInfo({ songmid: '1' })]);
    if (url.includes('source=kg')) return jsonResp([songInfo({ source: 'kg', songmid: '2', hash: 'H' })]);
    return jsonResp([]);
  });
  const client = new LxServerClient(config());
  const tracks = await client.searchAggregate('晴天', ['bad', 'kw', 'kg']);
  assert.equal(tracks.length, 2);
  assert.deepEqual(tracks.map(t => t.source), ['kw', 'kg']);
});

test('探活用匿名轻接口，鉴权失败不误报不可达', async t => {
  const requests = setupFetch(t, (url) => {
    if (url.includes('/api/user/auth/verify')) return jsonResp({ valid: false });
    return jsonResp([]);
  });
  const client = new LxServerClient(config({ token: 'bad' }));
  const st = await client.status();
  assert.equal(st.reachable, true);
  assert.ok(requests.every(r => !r.url.includes('/verify')), '探活不触发 verify');
});
