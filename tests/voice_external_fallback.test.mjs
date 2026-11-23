import assert from 'node:assert/strict';
import test from 'node:test';
import { loader } from './chat_loader.mjs';

const load = loader({
  '../playback/voice_resume': {},
  '../playback/sleep_timer': {},
  '../config/manager': {},
  '../account/manager': {},
  '../service/service': {},
  '../player/manager': { resolvePlaylistResumeStart: async () => null },
  '../indexing/manager': {},
  '../group/coordinator': {},
  '../player/url_builder': {
    playbackOptionsOf: config => ({ forceMP3: config.force_mp3 }),
    URLBuilder: { buildSongURL: async song => `http://host${song.url}` },
  },
  '../voicecmd/ai_analyzer': {},
  '../handlers/playlist': {},
  '../utils/http': {
    getHostAPIBaseUrl: async () => 'http://host',
    getHostBaseUrl: async () => 'http://host',
  },
  '../utils/favorites': {},
  '../memory': {},
  '../sleep_timer': {},
});
const { MusicCommandService } = load('../src/music/service.ts');
const { OnlineSearcher } = load('../src/voicecmd/online_searcher.ts');
const song = { title: '忘情水', artist: '刘德华', url: 'https://source/song.mp3', duration: 240 };

function fixture(t, options = {}) {
  const previous = { songloft: globalThis.songloft, fetch: globalThis.fetch };
  t.after(() => { Object.assign(globalThis, previous); });
  const requests = [], pushes = [], speech = [], localPlays = [], queuePlays = [], events = [];
  const config = {
    search_priority: options.priority || 'parallel',
    external_search_enabled: options.enabled ?? true,
    external_search_sources: [
      { id: 'topone', name: 'topone', enabled: true, url: 'https://topone/search', token: 'fixture-token' },
      { id: 'backup', name: 'backup', enabled: true, url: 'https://backup/search', token: 'fixture-token' },
    ],
    external_search_timeout: 0.01,
    external_search_no_import: options.noImport || false,
    external_search_playlist_id: options.append || '',
    interrupt_tts_hint_enabled: false,
  };
  globalThis.songloft = {
    log: { info() { }, warn() { }, error() { } },
    plugin: { getToken: async () => 'fixture-token' },
    playlists: { getSongs: async () => options.localSongs || [] },
  };
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    if (url.endsWith('/search')) {
      if (options.searchError) throw new Error('source unavailable');
      if (options.whitespaceMiss && /\s/.test(body.keyword)) return { status: 200, text: async () => JSON.stringify({ code: 404, data: null }) };
      return { status: 200, text: async () => JSON.stringify({ code: 0, data: options.miss || (options.firstMiss && url.includes('topone')) ? null : (options.searchSong || song) }) };
    }
    if (url === 'http://host/api/v1/songs/remote') {
      events.push('import');
      if (options.importError) throw new Error('import unavailable');
      return { text: async () => JSON.stringify({ songs: [{ id: 42, url: '/api/v1/songs/42/play' }] }) };
    }
    if (url === 'http://host/api/v1/playlists/7/songs') return {};
    assert.fail(`unexpected URL ${url}`);
  };
  const pm = {
    isPlaying: () => false,
    hasPlaylist: () => options.active || false,
    next: async () => { localPlays.push('next'); return true; },
    prepareForNewPlayback: () => events.push('prepare'),
    setAnnounceOnSongChange() { },
    getPrimary: () => ({ account_id: 'account', device_id: 'speaker' }),
    play: async (...args) => { localPlays.push(args); return true; },
    playPlaylistFromSong: async (...args) => { localPlays.push(args); return true; },
    playWithSongs: async (...args) => { localPlays.push(args); return true; },
    playStandaloneSong: async (track, index) => {
      assert.equal(index, engine.indexingManager);
      queuePlays.push(track); events.push('queue'); return options.playOK ?? true;
    },
    getCurrentSong: () => options.localSongs?.[0],
  };
  const engine = Object.create(MusicCommandService.prototype);
  engine.cancelPendingResume = () => events.push('cancel');
  engine.configManager = { getConfig: async () => config, getDevices: async () => [] };
  engine.playlistManagerMap = { get: () => pm, getOrCreate: async () => pm };
  engine.minaService = {
    stopPlay: async () => { events.push('stop'); return true; },
    textToSpeech: async (_account, _device, text) => speech.push(text),
    playURL: async (...args) => { events.push('push'); pushes.push(args); return options.playOK ?? true; },
  };
  engine.indexingManager = {
    isIndexReady: () => options.ready ?? true,
    waitForReady: async () => options.ready ?? true,
    refresh: async () => ({ success: options.ready ?? true }),
    waitForPlaylistCache: async () => true,
    isPlaylistCacheReady: () => true,
    // 语音预览只用索引廉价近似（不额外打宿主接口），真正执行才走 resolveArtistSongs
    findSongsByArtist: () => options.artistLocs || [],
    // 歌手口令必须走全曲库链路：真实实现内部先试宿主名录（/songs/names + /songs?artist=），
    // 不可用时回退到 includeLibrary 的索引扫描。这里按夹具给的位置直接水合成完整歌曲，
    // 水合口径与真实 loadArtistSongs 一致（只留 songId 命中、且有播放地址的）。
    resolveArtistSongs: async () => {
      const locs = options.artistLocs || [];
      return (options.localSongs || []).filter(s => locs.some(l => l.songId === s.id));
    },
    findSongByName: async () => null,
    findStandaloneSongByName: async () => null,
    findPlaylistByNameWithRefresh: async () => options.playlist || null,
    searchPlaylist: () => options.defaults || [],
    getStatus: () => ({ ready: true, playlist_count: 0, is_refreshing: false }),
    addImportedSong: (...args) => events.push(['index', ...args]),
  };
  engine.onlineSearcher = new OnlineSearcher(engine.configManager);
  return { engine, requests, pushes, speech, localPlays, queuePlays, events };
}

async function execute(engine, action, name, entry = 'ai') {
  if (entry === 'rule') {
    return engine.executeCommand({ command: { type: action }, keyword: '播放', argument: name }, 'account', 'speaker');
  }
  return engine.executeAIResult({ action, params: { [action === 'play_artist' ? 'artist' : 'playlist']: name }, confidence: 'high' }, 'account', 'speaker');
}

for (const [action, name] of [['play_artist', '刘德华'], ['play_playlist', '抖音热门榜']]) {
  for (const entry of ['ai', 'rule']) {
    for (const priority of ['local_first', 'external_first', 'parallel']) {
      test(`${entry} ${action} falls back to import and push (${priority})`, async t => {
        const f = fixture(t, { priority, firstMiss: true });
        const played = await execute(f.engine, action, name, entry);
        const searches = f.requests.filter(r => r.url.endsWith('/search'));
        assert.equal(searches.length, 2);
        for (const r of searches) assert.deepEqual(r.body, { keyword: name, quality: '320k' });
        assert.equal(f.requests.filter(r => r.url.endsWith('/songs/remote')).length, 1);
        assert.deepEqual(f.pushes, []);
        // 入库成「解析型」：不落当天就失效的直链，改存引用，播放时宿主回调本插件现解析
        const [imported] = f.requests.find(r => r.url.endsWith('/songs/remote')).body;
        assert.equal(imported.url, '', '直链不入库');
        assert.equal(imported.plugin_entry_path, 'miot');
        assert.equal(imported.dedup_key, `topone:backup:${song.title}|${song.artist}`, '同一首歌只占一行');
        assert.deepEqual(JSON.parse(imported.source_data), {
          v: 1, owner: 'miot', kind: 'topone', source_id: 'backup', keyword: name,
          name: song.title, singer: song.artist, duration: 240,
        });
        const [track] = f.queuePlays;
        assert.equal(track.title, song.title);
        assert.equal(track.artist, song.artist);
        assert.equal(track.id, 42);
        assert.equal(track.url, '/api/v1/songs/42/play');
        assert.equal(track.type, 'remote');
        assert.equal(track.hit_source, 'topone');
        assert.deepEqual(f.speech, []);
        assert.equal(f.events.filter(e => e === 'prepare').length, 1);
        assert.equal(f.events.filter(e => e === 'stop').length, 1);
        assert.ok(f.events.indexOf('import') < f.events.indexOf('queue'));
        assert.equal(f.events.filter(e => Array.isArray(e) && e[0] === 'index').length, 1);
        if (action === 'play_artist') assert.deepEqual(played, { songName: song.title, artist: song.artist });
      });
    }
  }
  for (const failure of ['disabled', 'miss', 'searchError', 'importError', 'playError']) {
    test(`${action} reports failure: ${failure}`, async t => {
      const f = fixture(t, { enabled: failure !== 'disabled', [failure]: true, playOK: failure !== 'playError' });
      await execute(f.engine, action, name);
      assert.equal(f.speech.length, 1);
      assert.ok(f.speech[0].includes(name));
      if (failure === 'disabled') assert.deepEqual(f.requests, []);
      if (['disabled', 'miss', 'searchError', 'importError'].includes(failure)) assert.deepEqual(f.pushes, []);
    });
  }
  test(`${action} keeps no-import playback in a temporary queue without importing`, async t => {
    const f = fixture(t, { noImport: true });
    await execute(f.engine, action, name);
    assert.equal(f.requests.filter(r => !r.url.endsWith('/search')).length, 0);
    assert.deepEqual(f.pushes, []);
    assert.equal(f.queuePlays[0].id, 0);
    assert.equal(f.queuePlays[0].url, song.url);
    assert.deepEqual(f.speech, []);
  });
  test(`${action} passes the player for configured playlist continuation`, async t => {
    const f = fixture(t, { append: '7' });
    await execute(f.engine, action, name);
    assert.ok(f.requests.some(r => r.url.endsWith('/playlists/7/songs')));
    assert.deepEqual(f.localPlays, [[7, 42]]);
    assert.deepEqual(f.pushes, []);
    assert.deepEqual(f.speech, []);
  });
  test(`${action} still searches externally when the index is unavailable`, async t => {
    const f = fixture(t, { ready: false });
    await execute(f.engine, action, name);
    assert.equal(f.queuePlays.length, 1);
    assert.deepEqual(f.speech, []);
  });
}

test('artist suffix is removed before external search', async t => {
  const f = fixture(t);
  await execute(f.engine, 'play_artist', '刘德华的歌曲');
  assert.equal(f.requests[0].body.keyword, '刘德华');
});

test('artist cache hit with no loadable songs falls back externally', async t => {
  const f = fixture(t, { artistLocs: [{ playlistId: 7, songId: 9 }] });
  await execute(f.engine, 'play_artist', '刘德华');
  assert.equal(f.queuePlays.length, 1);
});

test('local artist songs keep random playback without external requests', async t => {
  const localSongs = [{ id: 9, title: '本地歌曲', artist: '刘德华' }];
  const f = fixture(t, { artistLocs: [{ playlistId: 7, songId: 9 }], localSongs });
  await execute(f.engine, 'play_artist', '刘德华');
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.localPlays, [[localSongs, 0, 'random', '歌手: 刘德华', '刘德华']]);
});

test('artist songs outside every playlist play locally without external search', async t => {
  // 以解析型/直链导入的独立远程歌曲：歌手命中，但不在任何歌单里
  const localSongs = [{ id: 9, title: '独立导入的歌', artist: '刘德华', type: 'remote', url: '/api/v1/songs/9/play' }];
  const f = fixture(t, {
    artistLocs: [{ playlistId: 0, songId: 9, libraryOnly: true }],
    localSongs,
  });
  const played = await execute(f.engine, 'play_artist', '刘德华');
  assert.deepEqual(f.requests, [], '本地已有该歌手，不该再去在线搜索');
  assert.deepEqual(f.localPlays, [[localSongs, 0, 'random', '歌手: 刘德华', '刘德华']]);
  assert.deepEqual(played, { songName: '独立导入的歌', artist: '刘德华' });
});

test('local playlist hit keeps playlist playback without external requests', async t => {
  const f = fixture(t, { playlist: { id: 7, name: '抖音热门榜', songCount: 2 } });
  await execute(f.engine, 'play_playlist', '抖音热门榜');
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.localPlays, [[7, 0]]);
});

test('empty named playlist falls back externally', async t => {
  const f = fixture(t, { playlist: { id: 7, name: '抖音热门榜', songCount: 0 } });
  await execute(f.engine, 'play_playlist', '抖音热门榜');
  assert.equal(f.queuePlays.length, 1);
  assert.deepEqual(f.localPlays, []);
});

test('empty playlist argument resumes the active playlist without searching', async t => {
  const f = fixture(t, { active: true });
  await f.engine.executePlayPlaylist('', 'account', 'speaker');
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.localPlays, ['next']);
});

test('empty playlist argument with no defaults does not search an empty keyword', async t => {
  const f = fixture(t);
  await f.engine.executePlayPlaylist('', 'account', 'speaker');
  assert.deepEqual(f.requests, []);
});

test('empty artist argument does not trigger external search', async t => {
  const f = fixture(t);
  await f.engine.executePlayArtist('的歌曲', 'account', 'speaker');
  assert.deepEqual(f.requests, []);
});

test('search preview explains the external fallback without executing it', async t => {
  const f = fixture(t);
  for (const [type, name] of [['play_artist', '刘德华'], ['play_playlist', '抖音热门榜']]) {
    const preview = await f.engine.previewSearch(type, name);
    assert.equal(preview.found, false);
    assert.ok(preview.detail.includes('外部搜索'));
  }
  assert.deepEqual(f.requests, []);
});

for (const priority of ['local_first', 'external_first', 'parallel']) {
  for (const entry of ['ai', 'rule']) {
    test(`${entry} play_song imports and pushes after whitespace retry (${priority})`, async t => {
      const f = fixture(t, { priority, whitespaceMiss: true, searchSong: { ...song, title: '山峰山峰等等我 男生合唱版' } });
      const name = '山峰山峰等等我 男生合唱版';
      if (entry === 'ai') {
        await f.engine.executeAIResult({ action: 'play_song', params: { name }, confidence: 'high' }, 'account', 'speaker');
      } else {
        await f.engine.executeCommand({ command: { type: 'play_song' }, keyword: '播放', argument: name }, 'account', 'speaker');
      }
      const searches = f.requests.filter(r => r.url.endsWith('/search'));
      assert.equal(searches.length, 4);
      assert.deepEqual(searches.slice(2).map(r => r.body), [0, 1].map(() => ({ keyword: name.replace(/\s/g, ''), hint: { title: name.replace(/\s/g, '') }, quality: '320k' })));
      assert.equal(f.requests.filter(r => r.url.endsWith('/songs/remote')).length, 1);
      assert.equal(f.queuePlays[0].url, '/api/v1/songs/42/play');
      assert.deepEqual(f.speech, []);
      assert.equal(f.events.filter(e => e === 'prepare').length, 1);
      assert.equal(f.events.filter(e => e === 'stop').length, 1);
    });
  }
}

for (const priority of ['local_first', 'external_first', 'parallel']) {
  test(`real index and HTTP search play the intended radio without importing unrelated topone (${priority})`, async t => {
    const radio = { id: 1933, title: 'CCTV九纪录', artist: '', type: 'radio', url: '/api/v1/songs/1933/play' };
    const f = fixture(t, { priority, localSongs: [radio], searchSong: { ...song, title: '记录', artist: '轻松频率' } });
    globalThis.songloft.songs = { list: async () => [radio], getById: async () => radio };
    globalThis.songloft.playlists.list = async () => [{ id: 7, name: '电台', song_count: 1 }];
    const { IndexingManager } = load('../src/indexing/manager.ts');
    f.engine.indexingManager = new IndexingManager();
    await f.engine.indexingManager.refresh();
    await f.engine.indexingManager.waitForPlaylistCache();
    const result = await f.engine.executeCommand({ command: { type: 'play_song' }, keyword: '播放', argument: 'cctv9记录' }, 'account', 'speaker');
    assert.equal(result.songId, 1933);
    assert.equal(f.localPlays.length, 1);
    assert.deepEqual(f.localPlays[0].slice(0, 2), [7, 1933]);
    assert.deepEqual(f.queuePlays, []);
    assert.equal(f.requests.filter(r => r.url.endsWith('/songs/remote')).length, 0);
    assert.equal(f.requests.filter(r => r.url.endsWith('/search')).length, priority === 'local_first' ? 0 : 2);
    assert.deepEqual(f.speech, []);
    assert.equal(f.events.filter(e => e === 'stop').length, 1);
  });
}
