import assert from 'node:assert/strict';
import test from 'node:test';
import { loader, flush } from './chat_loader.mjs';

// 每个用例用独立的 loader：playHistoryUnsupported 是模块级探活标记，
// 404 降级用例不能污染其它用例。
let originalSongloft;

test.before(() => {
  originalSongloft = globalThis.songloft;
});

test.after(() => {
  globalThis.songloft = originalSongloft;
});

function fixture(callHostAPI) {
  const calls = [];
  globalThis.songloft = {
    log: { info() {}, warn() {}, error() {} },
    plugin: { getToken: async () => 'fixture-token' },
  };
  const load = loader({
    '../utils/http': {
      getHostBaseUrl: () => 'http://speaker.test',
      callHostAPI: async (...args) => {
        calls.push(args);
        if (callHostAPI) return callHostAPI(...args);
        return {};
      },
    },
  });
  const configManager = {
    getPlaylistProgress: async () => null,
    getDevices: async () => [],
  };
  const { PlaylistManager } = load('../src/player/manager.ts');
  const pm = new PlaylistManager('account', 'speaker', {}, configManager);
  pm.playCurrent = async () => true;
  pm.persistState = async () => {};
  pm.loadPlaylistSongs = async () => ({
    songs: [{ id: 7, title: '测试曲', artist: '测试歌手', duration: 100, url: '/api/v1/songs/7/play' }],
    audiobook: false,
  });
  return { pm, calls, load };
}

function confirmFirstPlay(pm) {
  pm.playStartTimeMs = 1000;
  pm.playbackConfirmed = false;
  pm.reportedSongId = 0;
  pm['markPlaybackConfirmed']();
}

function playedPaths(calls) {
  return calls
    .filter(([method, path]) => method === 'POST' && path.startsWith('/api/v1/songs/') && path.includes('/played?'))
    .map(([, path]) => path);
}

test('真歌单按宿主歌单 id 落库，只报一次', async () => {
  const { pm, calls } = fixture();
  await pm.play(42, 0, 'order');
  assert.deepEqual(pm.playHistoryContext, { type: 'playlist', key: '42' });

  confirmFirstPlay(pm);
  pm['markPlaybackConfirmed'](); // 外停轮询/landing verify 的重复确认
  await flush();
  assert.deepEqual(playedPaths(calls), [
    '/api/v1/songs/7/played?source=miot&type=play&context_type=playlist&context_key=42',
  ]);
});

test('歌手口令用规范署名做 context_key', async () => {
  const { pm, calls } = fixture();
  const songs = [{ id: 7, title: '测试曲', artist: '周杰伦', duration: 100, url: '/api/v1/songs/7/play' }];
  await pm.playWithSongs(songs, 0, 'random', '歌手: 周杰伦', '周杰伦', undefined, undefined, '周杰伦');
  assert.deepEqual(pm.playHistoryContext, { type: 'artist', key: '周杰伦' });

  confirmFirstPlay(pm);
  await flush();
  assert.deepEqual(playedPaths(calls), [
    '/api/v1/songs/7/played?source=miot&type=play&context_type=artist&context_key=%E5%91%A8%E6%9D%B0%E4%BC%A6',
  ]);
});

test('名录未命中回退口令原文', async () => {
  const { pm, calls } = fixture();
  const songs = [{ id: 7, title: '测试曲', artist: '周杰倫', duration: 100, url: '/api/v1/songs/7/play' }];
  await pm.playWithSongs(songs, 0, 'random', '歌手: 周杰倫', '周杰倫', undefined, undefined, '周杰倫');

  confirmFirstPlay(pm);
  await flush();
  assert.deepEqual(playedPaths(calls), [
    '/api/v1/songs/7/played?source=miot&type=play&context_type=artist&context_key=%E5%91%A8%E6%9D%B0%E5%80%AB',
  ]);
});

test('「全部歌曲」虚拟歌单只发事件不落库', async () => {
  const { pm, calls } = fixture();
  const { ALL_SONGS_PLAYLIST_ID } = loader()('../src/player/library_playlist.ts');
  await pm.play(ALL_SONGS_PLAYLIST_ID, 0, 'order');
  assert.equal(pm.playHistoryContext, undefined);

  confirmFirstPlay(pm);
  await flush();
  // 缺 context_type/context_key：宿主只广播事件，不写历史
  assert.deepEqual(playedPaths(calls), [
    '/api/v1/songs/7/played?source=miot&type=play',
  ]);
});

test('id=0 的在线临时队列整条跳过', async () => {
  const { pm, calls } = fixture();
  pm.songs = [{ id: 0, title: '临时曲', artist: '某歌手', duration: 100, url: 'https://temp/song.mp3' }];
  pm.currentIndex = 0;
  confirmFirstPlay(pm);
  await flush();
  assert.deepEqual(playedPaths(calls), []);
});

test('404 后整进程不再发上报请求', async () => {
  const { pm, calls } = fixture(async () => {
    throw new Error('Host API error 404 POST /api/v1/songs/7/played');
  });
  await pm.play(42, 0, 'order');
  confirmFirstPlay(pm);
  await flush();
  assert.equal(playedPaths(calls).length, 1);

  // 换一首歌（重置会话去重）也不能再请求
  pm.songs = [{ id: 8, title: '第二首', artist: '测试歌手', duration: 100, url: '/api/v1/songs/8/play' }];
  pm.currentIndex = 0;
  confirmFirstPlay(pm);
  await flush();
  assert.equal(playedPaths(calls).length, 1);
});

test('resolveArtistCredit 名录命中取规范署名，不可用回退空串', async () => {
  const load = loader({
    '../utils/http': {
      getHostBaseUrl: () => 'http://speaker.test',
      callHostAPI: async () => ({}),
    },
  });
  const { IndexingManager } = load('../src/indexing/manager.ts');
  const manager = new IndexingManager({}, {}, {});
  manager.artistNamesCache = {
    names: ['周杰伦', '刘德华'],
    norm: ['周杰伦', '刘德华'],
    at: Date.now(),
  };
  assert.equal(await manager.resolveArtistCredit('周杰倫'), '周杰伦');
  assert.equal(await manager.resolveArtistCredit('不存在'), '');
  manager.artistNamesCache = null;
  manager.artistNamesFailedAt = Date.now();
  assert.equal(await manager.resolveArtistCredit('周杰伦'), '');
});
