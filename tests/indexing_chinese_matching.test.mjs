import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const modules = new Map();

// src/utils/http.ts 要引 @songloft/plugin-sdk（本机没有 toolchain 源码），
// 而歌手匹配这一侧只需要 callHostAPI 一个出口 —— 换成可编程桩，
// 用来驱动「歌手名名录 → /songs?artist= 精确取歌」两步链路。
let hostAPIHandler = async () => { throw new Error('host API not stubbed'); };
const httpStub = {
  callHostAPI: (method, path, body, options) => hostAPIHandler(method, path, body, options),
};

function loadSource(url) {
  if (modules.has(url.href)) return modules.get(url.href);
  const { outputText } = ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const exports = {};
  modules.set(url.href, exports);
  new Function('require', 'exports', outputText)(name => {
    if (name === '../utils/http') return httpStub;
    assert.ok(name.startsWith('.'), `unexpected runtime dependency: ${name}`);
    return loadSource(new URL(`${name}.ts`, url));
  }, exports);
  return exports;
}

const { IndexingManager } = loadSource(new URL('../src/indexing/manager.ts', import.meta.url));

/** 宿主接口桩：handler 收到 (method, path)，返回体照真实形状给 */
function stubHostAPI(handler) {
  const calls = [];
  hostAPIHandler = async (method, path) => {
    calls.push({ method, path });
    return handler(method, path);
  };
  return calls;
}

async function createIndex(songs, playlistSongs = new Map([[1, songs]])) {
  globalThis.songloft = {
    log: { info() { }, warn() { }, error() { } },
    songs: {
      list: async () => songs,
      getById: async id => songs.find(song => song.id === id),
    },
    playlists: {
      list: async () => [...playlistSongs].map(([id, tracks]) => ({ id, name: `歌单${id}`, song_count: tracks.length })),
      getSongs: async id => playlistSongs.get(id),
    },
  };
  const manager = new IndexingManager();
  assert.equal((await manager.refresh()).success, true);
  assert.equal(await manager.waitForPlaylistCache(), true);
  // 默认让宿主接口不可用：走索引扫描的老用例不受影响，需要名录链路的用例自己再桩一次
  hostAPIHandler = async () => { throw new Error('host API not stubbed'); };
  return manager;
}

for (const [artist, query] of [
  ['劉德華', '刘德华'],
  ['刘德华', '劉德華'],
  ['劉德华', '刘德華'],
  ['周杰倫', '周杰伦'],
  ['鄧紫棋', '邓紫棋'],
  ['張學友', '张学友'],
]) {
  test(`artist playback matches ${query} against ${artist} and deduplicates playlists`, async () => {
    const songs = [
      { id: 1, title: '第一首', artist },
      { id: 2, title: '第二首', artist },
      { id: 3, title: '其他歌曲', artist: '林俊杰' },
    ];
    const manager = await createIndex(songs, new Map([[1, songs], [2, [songs[0]]]]));
    const matches = manager.findSongsByArtist(query);
    assert.deepEqual(matches.map(song => song.songId), [1, 2]);
    assert.ok(matches.every(song => song.artist === artist));
    assert.deepEqual(manager.findSongsByArtist('刘得华'), []);
  });
}

for (const [title, artist, query] of [
  ['愛你一萬年', '劉德華', '爱你一万年'],
  ['爱你一万年', '刘德华', '愛你一萬年'],
  ['愛你一万年', '劉德華', '刘德华 爱你一萬年'],
  ['後來', '劉若英', '后来'],
  ['發如雪', '周杰倫', '发如雪'],
  ['紅豆', '王菲', '《红豆》'],
]) {
  test(`song search and playlist location match ${query} against ${title}`, async () => {
    const song = { id: 7, title, artist, album: '經典專輯' };
    const manager = await createIndex([song]);
    const matches = manager.searchSong(query);
    assert.equal(matches[0]?.id, song.id);
    assert.equal(matches[0].title, title);
    assert.equal(matches[0].artist, artist);
    assert.equal(matches[0].album, song.album);
    const location = await manager.findSongByName(query);
    assert.equal(location?.songId, song.id);
    assert.equal(location.songTitle, title);
  });
}

test('playlist-local song lookup keeps multi-term matching with traditional titles', async () => {
  const manager = await createIndex([
    { id: 1, title: '萬年', artist: '其他歌手' },
    { id: 2, title: '愛你一萬年', artist: '劉德華' },
  ]);
  assert.deepEqual(await manager.findSongInPlaylist(1, '爱你 万年'), { index: 1, found: true, songId: 2 });
  assert.deepEqual(await manager.findSongInPlaylist(1, '爱你一万年'), { index: 1, found: true, songId: 2 });
});

test('playlist cache fallback matches songs absent from the global index', async () => {
  const song = { id: 1, title: '愛你一萬年', artist: '劉德華' };
  const manager = await createIndex([], new Map([[1, [song]]]));
  assert.equal((await manager.findSongByName('爱你一万年'))?.songId, song.id);
});

test('standalone songs match simplified queries without refreshing again', async () => {
  const song = { id: 1, title: '愛你一萬年', artist: '劉德華', type: 'remote', url: 'https://example.com/song.mp3' };
  const manager = await createIndex([song], new Map());
  globalThis.songloft.songs.list = async () => { assert.fail('matching an indexed song must not refresh'); };
  assert.equal(await manager.findSongByName('爱你一万年'), null);
  assert.deepEqual(await manager.findStandaloneSongByName('爱你一万年'), song);
});

test('imported songs use the same normalization in both index and playlist cache', async () => {
  const manager = await createIndex([]);
  const song = { id: 9, title: '練習', artist: '劉德華', album: '經典' };
  manager.addImportedSong(song, 1);
  assert.equal(manager.searchSong('练习')[0]?.id, song.id);
  assert.equal((await manager.findSongByName('练习'))?.songId, song.id);
  assert.equal(manager.findSongsByArtist('刘德华')[0]?.songId, song.id);
  assert.deepEqual(await manager.findSongInPlaylist(1, '练习'), { index: 0, found: true, songId: 9 });
});

test('literal guard still rejects homophones while preserving Latin and emoji queries', async () => {
  const manager = await createIndex([
    { id: 1, title: '稻香', artist: '周杰倫' },
    { id: 2, title: 'Hello 😀', artist: 'Adele' },
  ]);
  assert.deepEqual(manager.searchSong('到香'), []);
  assert.equal(await manager.findSongByName('到香'), null);
  assert.deepEqual(manager.searchSong('林俊杰 稻香'), []);
  assert.equal(manager.searchSong('HELLO 😀')[0]?.id, 2);
  assert.deepEqual(manager.searchSong(''), []);
  assert.deepEqual(manager.findSongsByArtist('   '), []);
});

// ===== 全曲库匹配歌手（includeLibrary） =====
// 歌单歌曲缓存只有「属于某个歌单」的歌；以解析型/直链导入的独立远程歌曲不在任何歌单里，
// 只用缓存匹配会把它们漏掉，导致「本地没有该歌手」→ 白跑一次在线搜索。

test('全曲库匹配：不在任何歌单里的歌也能按歌手找到', async () => {
  const songs = [
    { id: 1, title: '歌单内', artist: '刘德华', type: 'local', url: '/songs/1' },
    { id: 2, title: '独立导入', artist: '刘德华', type: 'remote', url: '/api/v1/songs/2/play' },
    { id: 3, title: '别人的歌', artist: '林俊杰', type: 'local', url: '/songs/3' },
  ];
  // 只有 1 号在歌单里
  const manager = await createIndex(songs, new Map([[1, [songs[0]]]]));

  assert.deepEqual(
    manager.findSongsByArtist('刘德华').map((loc) => loc.songId),
    [1],
    '默认仍只扫歌单缓存（老调用方不受影响）',
  );

  const all = manager.findSongsByArtist('刘德华', { includeLibrary: true });
  assert.deepEqual(all.map((loc) => loc.songId), [1, 2]);
  assert.equal(all[0].libraryOnly, undefined, '歌单内的不标 libraryOnly');
  assert.equal(all[1].libraryOnly, true);
  assert.equal(all[1].playlistId, 0, '不在歌单里用 0 表示');

  assert.deepEqual(
    (await manager.loadArtistSongs(all)).map((song) => song.id),
    [1, 2],
    '水合后歌单内的在前、独立导入的在后',
  );
});

test('loadArtistSongs：跳过电台与无 url 的条目，同一首歌不重复', async () => {
  const songs = [
    { id: 1, title: '正常歌', artist: '刘德华', type: 'local', url: '/songs/1' },
    { id: 2, title: '电台', artist: '刘德华', type: 'radio', url: '/api/v1/songs/2/play' },
    { id: 3, title: '没 url', artist: '刘德华', type: 'remote', url: '' },
  ];
  const manager = await createIndex(songs, new Map([[1, [songs[0]]]]));

  const locs = manager.findSongsByArtist('刘德华', { includeLibrary: true });
  assert.deepEqual(locs.map((loc) => loc.songId), [1, 2, 3], '索引层不判定可播性');

  const loaded = await manager.loadArtistSongs(locs);
  assert.deepEqual(loaded.map((song) => song.id), [1], '电台和空 url 不进队列');
});

test('全曲库匹配：刚导入的歌立刻可被歌手口令命中（无需重建索引）', async () => {
  const manager = await createIndex([], new Map());
  manager.addImportedSong({ id: 42, title: '忘情水', artist: '刘德华' });
  globalThis.songloft.songs.getById = async (id) => (
    id === 42 ? { id: 42, title: '忘情水', artist: '刘德华', type: 'remote', url: '/api/v1/songs/42/play' } : null
  );

  const locs = manager.findSongsByArtist('刘德华', { includeLibrary: true });
  assert.deepEqual(locs.map((loc) => loc.songId), [42]);
  assert.deepEqual(
    (await manager.loadArtistSongs(locs)).map((song) => song.id),
    [42],
  );
});

// ===== 两步式歌手解析（宿主名录 → 精确取歌） =====
// 索引受 max_song_index 限制、且只能拿到索引里那点字段；宿主 /songs/names 给出全量去重署名，
// 再用 /songs?artist= 精确取回完整 Song，能覆盖索引扫不到的歌。

test('resolveArtistSongs：名录命中后精确取歌，且名录走进程内缓存', async () => {
  // 索引刻意留空：一旦回退到索引扫描就必然返回空，能反证结果确实来自宿主链路
  const manager = await createIndex([], new Map());

  const calls = stubHostAPI((method, path) => {
    if (path.startsWith('/api/v1/songs/names')) {
      assert.equal(method, 'GET');
      return { field: 'artist', names: ['刘德华', '林俊杰'], total: 2 };
    }
    assert.match(path, /^\/api\/v1\/songs\?artist=/, '命中署名后要回填 /songs?artist=');
    assert.match(path, /limit=100000/, '一次拿全，不做分页');
    assert.match(path, /exclude_playlist_labels=none/, '索引不排除隐藏歌单，取歌也必须显式 none');
    const artist = decodeURIComponent(/artist=([^&]*)/.exec(path)[1]);
    if (artist !== '刘德华') return { songs: [], total: 0 };
    return {
      // 真实宿主 MarshalJSON 会把 url 填成 /api/v1/songs/{id}/play，可直接播
      songs: [
        { id: 101, title: '索引外的歌', artist: '刘德华', type: 'remote', url: '/api/v1/songs/101/play' },
        { id: 102, title: '电台', artist: '刘德华', type: 'radio', url: '/api/v1/songs/102/play' },
      ],
      total: 2,
    };
  });

  // 繁体口令也要能匹配到简体署名（归一化与索引扫描同口径）
  const songs = await manager.resolveArtistSongs('劉德華');
  assert.deepEqual(songs.map(song => song.id), [101], '电台不进歌手队列');
  assert.equal(songs[0].url, '/api/v1/songs/101/play', '直链/播放地址原样带回');

  // 只问了命中的那个署名，别的署名不白跑一次取歌
  assert.deepEqual(
    calls.filter(call => call.path.startsWith('/api/v1/songs?')).map(call => /artist=([^&]*)/.exec(call.path)[1]),
    [encodeURIComponent('刘德华')],
  );

  await manager.resolveArtistSongs('刘德华');
  assert.equal(
    calls.filter(call => call.path.startsWith('/api/v1/songs/names')).length,
    1,
    '名录全量不分页，进程内缓存 10 分钟，不重复拉',
  );
});

test('resolveArtistSongs：老形态名录返回整串署名时原样回填 ?artist=', async () => {
  // c303d54(2026-07-31) ~ 54e820b(2026-09-14) 之间的宿主：names 返回 DISTINCT songs.artist
  // 整串（如 "刘德华 & 张学友"），songs?artist= 也是整串 Eq。插件必须把名录里的原值回填，
  // 不能拿用户口令里的单个名字去查——那在老宿主上会一个都匹配不到。
  const manager = await createIndex([], new Map());
  const credit = '刘德华 & 张学友';

  const calls = stubHostAPI((method, path) => {
    if (path.startsWith('/api/v1/songs/names')) {
      return { field: 'artist', names: [credit, '其他歌手'], total: 2 };
    }
    const artist = decodeURIComponent(/artist=([^&]*)/.exec(path)[1]);
    assert.equal(artist, credit, '回填的是名录里的整串规范署名，不是用户口令里的单个名字');
    return {
      songs: [{ id: 201, title: '合唱歌曲', artist: credit, type: 'local', url: '/api/v1/songs/201/play' }],
      total: 1,
    };
  });

  // 口令只说了一个搭档，包含匹配命中整串署名，再原样回填即可取到那首合唱
  const songs = await manager.resolveArtistSongs('张学友');
  assert.deepEqual(songs.map(song => song.id), [201], '老形态名录下也能取到歌');
  assert.equal(calls.filter(call => call.path.startsWith('/api/v1/songs?')).length, 1, '只问了命中的那一个署名');
});

test('resolveArtistSongs：索引和名录取并集，remote 歌不会被名录链路挤掉', async () => {
  // 主程序的 AddRemoteSongs → UpsertRemote → Create() 只写 songs 表、不写 song_artists，
  // 所以宿主名录 / ?artist= 看不到插件导入的 remote 歌；索引扫描必须保留。
  const remote = { id: 1, title: '独立导入的 remote 歌', artist: '刘德华', type: 'remote', url: '/api/v1/songs/1/play' };
  const local = { id: 2, title: '本地扫描歌', artist: '刘德华', type: 'local', url: '/api/v1/songs/2/play' };
  const manager = await createIndex([remote], new Map());

  stubHostAPI((method, path) => {
    if (path.startsWith('/api/v1/songs/names')) {
      assert.match(path, /exclude_playlist_labels=none/, '名录也要显式不排除隐藏歌单，与索引口径一致');
      assert.match(path, /type=local,remote/, '电台歌手不进名录，避免无用候选与多余取歌请求');
      // 新主程序artist 维度走 song_artists 关联表，返回拆开的单个歌手
      return { field: 'artist', names: ['刘德华', '其他歌手'], total: 2 };
    }
    assert.match(path, /artist=/);
    // 真实行为：remote 歌没有 song_artists 记录，宿主链路只给本地扫描歌
    return { songs: [local], total: 1 };
  });

  const songs = await manager.resolveArtistSongs('刘德华');
  assert.deepEqual(songs.map(song => song.id), [1, 2], 'remote 歌来自索引、本地歌来自宿主，两者都要在');
  assert.equal(songs[0].title, remote.title, '索引结果在前（保持旧顺序），remote 歌不能被名录链路挤掉');
});

test('resolveArtistSongs：老宿主没有名录接口时落回索引扫描（含不在歌单的歌）', async () => {
  const songs = [
    { id: 1, title: '歌单内', artist: '刘德华', type: 'local', url: '/songs/1' },
    { id: 2, title: '独立导入', artist: '刘德华', type: 'remote', url: '/api/v1/songs/2/play' },
    { id: 3, title: '别人的歌', artist: '林俊杰', type: 'local', url: '/songs/3' },
  ];
  const manager = await createIndex(songs, new Map([[1, [songs[0]]]]));

  let namesCalls = 0;
  stubHostAPI((method, path) => {
    if (path.startsWith('/api/v1/songs/names')) {
      namesCalls++;
      // 2.10.0 之前的宿主没有这条路由，gin 直接 404
      throw new Error(`Host API error 404 GET ${path}: 404 page not found`);
    }
    throw new Error(`unexpected request: ${path}`);
  });

  assert.deepEqual(
    (await manager.resolveArtistSongs('刘德华')).map(song => song.id),
    [1, 2],
    '回退后仍然全曲库匹配（歌单内的在前、独立导入的在后）',
  );
  assert.equal(namesCalls, 1);

  // 404 后在冷却期内不再撞名录接口，省掉每次口令的一次失败往返
  assert.deepEqual((await manager.resolveArtistSongs('刘德华')).map(song => song.id), [1, 2]);
  assert.equal(namesCalls, 1, '冷却期内不重试名录接口');
});

test('resolveArtistSongs：并发冷启动只拉一次名录', async () => {
  const manager = await createIndex([], new Map());
  let namesCalls = 0;
  stubHostAPI(async (method, path) => {
    if (path.startsWith('/api/v1/songs/names')) {
      namesCalls++;
      // 让第一条请求悬着，第二条必然撞上「在飞」而去重
      await new Promise(resolve => setTimeout(resolve, 5));
      return { field: 'artist', names: ['刘德华'], total: 1 };
    }
    return { songs: [{ id: 7, title: '名录里的歌', artist: '刘德华', type: 'local', url: '/songs/7' }], total: 1 };
  });

  const [first, second] = await Promise.all([
    manager.resolveArtistSongs('刘德华'),
    manager.resolveArtistSongs('刘德华'),
  ]);
  assert.deepEqual(first.map(song => song.id), [7]);
  assert.deepEqual(second.map(song => song.id), [7]);
  assert.equal(namesCalls, 1, '并发冷启动共用同一次名录请求');
});

test('chained character variants share one search key', async () => {
  const manager = await createIndex([{ id: 1, title: '薴花', artist: '测试歌手' }]);
  for (const query of ['薴花', '苧花', '苎花']) {
    assert.equal(manager.searchSong(query)[0]?.id, 1, query);
    assert.equal((await manager.findSongByName(query))?.songId, 1, query);
  }
});

test('standalone continuation loads exact artists from the library including songs outside playlists', async () => {
  const songs = [
    { id: 1, title: '点播歌曲', artist: '劉德華', type: 'remote', url: '/songs/1', duration: 300 },
    { id: 2, title: '未加入歌单', artist: '刘德华', type: 'local', url: '/songs/2', duration: 250 },
    { id: 3, title: '近似歌手', artist: '刘德华翻唱', url: '/songs/3' },
    { id: 4, title: '电台', artist: '刘德华', type: 'radio', url: '/radio' },
    { id: 5, title: '失效记录', artist: '刘德华', url: '' },
    { id: 6, title: '已删除', artist: '刘德华', url: '/songs/6' },
  ];
  const manager = await createIndex(
    songs,
    new Map([
      [1, [songs[0]]],
      [2, [songs[0]]],
    ]),
  );
  const read = [];
  globalThis.songloft.songs.getById = async (id) => {
    read.push(id);
    if (id === 6) throw new Error('deleted');
    return songs.find((song) => song.id === id);
  };
  assert.deepEqual(
    (await manager.loadLibrarySongsByArtist('刘德华')).map((song) => song.id),
    [1, 2],
  );
  assert.equal(read.filter((id) => id === 1).length, 1);
  assert.ok(!read.includes(3), 'automatic continuation must not use fuzzy artist matches');
  assert.deepEqual(await manager.loadLibrarySongsByArtist(''), []);
});

test('artist queue loading stops after cancellation and limits concurrent detail reads', async () => {
  const songs = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, title: `歌曲${i}`, artist: '歌手', url: '/song' }));
  const manager = await createIndex(songs, new Map());
  let current = true,
    active = 0,
    peak = 0;
  const pending = [];
  globalThis.songloft.songs.getById = async (id) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => pending.push(resolve));
    active--;
    return songs.find((song) => song.id === id);
  };
  const loading = manager.loadLibrarySongsByArtist('歌手', () => current);
  assert.equal(peak, 4);
  current = false;
  pending.forEach((resolve) => resolve());
  assert.deepEqual(await loading, []);
  assert.equal(pending.length, 4, 'cancelled work must not start more bridge requests');
});

test('standalone continuation joins Eric周興哲 and 周兴哲 without fuzzy matches or artist lists', async () => {
  const songs = [
    'Eric周興哲', '周兴哲', '周兴哲翻唱', 'Eric、周兴哲', '周兴哲 / 周杰伦', 'Other周兴哲',
  ].map((artist, i) => ({ id: i + 1, title: `歌曲${i}`, artist, type: 'local', url: `/songs/${i + 1}` }));
  const manager = await createIndex(songs, new Map());
  assert.deepEqual((await manager.loadLibrarySongsByArtist('Eric周兴哲')).map(song => song.id), [1, 2]);
  assert.deepEqual((await manager.loadLibrarySongsByArtist('周興哲')).map(song => song.id), [1, 2, 6]);

  globalThis.songloft.songs.getById = async id => id === 2 ? { ...songs[1], artist: '周兴哲 / 周杰伦' } : songs[id - 1];
  assert.deepEqual((await manager.loadLibrarySongsByArtist('Eric周兴哲')).map(song => song.id), [1]);
});
