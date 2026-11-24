import assert from 'node:assert/strict';
import test from 'node:test';
import { loader } from './chat_loader.mjs';

// 真实 MusicCommandService + 真实 OnlineSearcher，只 mock 宿主侧依赖。
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
    callHostAPI: async () => ({}),
  },
  '../utils/favorites': {},
  '../memory': {},
  '../sleep_timer': {},
});
const { MusicCommandService } = load('../src/music/service.ts');
const { OnlineSearcher } = load('../src/voicecmd/online_searcher.ts');
const { getDefaultVoiceCommands } = load('../src/voicecmd/defaults.ts');

const jsonResp = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(data),
});

function fixture(t) {
  const previous = { songloft: globalThis.songloft, fetch: globalThis.fetch };
  t.after(() => { Object.assign(globalThis, previous); });
  const requests = [], speech = [], plays = [];
  const config = {
    search_priority: 'parallel',
    external_search_enabled: false,
    external_search_timeout: 2,
    external_search_sources: [],
    external_search_no_import: true,
    lxserver: {
      enabled: true, host: 'http://lx.test:9527', token: '', quality: '320k',
      allowQualityFallback: true, sources: ['wy'], searchTimeout: 6, urlTimeout: 12,
      artist_queue_enabled: true,
    },
  };
  globalThis.songloft = {
    log: { info() {}, warn() {}, error() {} },
    plugin: { getToken: async () => 'fixture-token' },
  };
  globalThis.fetch = async (url) => {
    requests.push(url);
    if (url.includes('/leaderboard/boards')) {
      return jsonResp({ list: [{ id: 'wy__3778678', name: '热歌榜', bangid: '3778678', source: 'wy' }], source: 'wy' });
    }
    if (url.includes('/leaderboard/list')) {
      return jsonResp({
        list: [1, 2, 3].map(i => ({ name: `榜曲${i}`, singer: '某歌手', source: 'wy', songmid: `wy${i}`, interval: '04:00', types: [{ type: '320k' }] })),
        total: 3,
      });
    }
    if (url.includes('/api/music/url')) return jsonResp({ url: 'https://audio.test/song.mp3', type: '320k' });
    return jsonResp([]);
  };
  const pm = {
    isPlaying: () => false,
    hasPlaylist: () => false,
    prepareForNewPlayback: () => {},
    setAnnounceOnSongChange() {},
    setSongUrlResolver() {},
    playWithSongs: async (...args) => { plays.push(args); return true; },
    getCurrentSong: () => ({ id: 0, title: '榜曲1', artist: '某歌手' }),
  };
  const engine = Object.create(MusicCommandService.prototype);
  engine.cancelPendingResume = () => {};
  engine.configManager = {
    getConfig: async () => config,
    getVoiceCommands: async () => getDefaultVoiceCommands(),
    getDevices: async () => [],
  };
  engine.playlistManagerMap = { get: () => pm, getOrCreate: async () => pm };
  engine.minaService = {
    stopPlay: async () => true,
    textToSpeech: async (_a, _d, text) => speech.push(text),
  };
  engine.indexingManager = {};
  engine.onlineSearcher = new OnlineSearcher(engine.configManager);
  return { engine, requests, speech, plays, config };
}

/** 直接调私有匹配 + 分发（走真实 matchCommand → executeCommand） */
async function runQuery(h, query) {
  const rule = await h.engine.matchRuleCommand(query);
  if (!rule) return { rule: null };
  const played = await h.engine.executeCommand(rule, 'account', 'speaker', query);
  return { rule, played };
}

test('「播放热歌榜」匹配为 play_chart 命令且榜单名提取正确', async t => {
  const h = fixture(t);
  const { rule } = await runQuery(h, '播放热歌榜');
  assert.ok(rule, '规则命中');
  assert.equal(rule.command.type, 'play_chart');
  assert.equal(rule.keyword, '播放热歌榜');
  assert.equal(rule.argument, '', '关键词本身含榜名');
});

test('平台全称前缀：口令命中 play_chart，参数只留榜名', async t => {
  const h = fixture(t);
  const { rule } = await runQuery(h, '播放QQ音乐热搜榜');
  assert.ok(rule);
  assert.equal(rule.command.type, 'play_chart');
  assert.equal(rule.keyword, '播放QQ音乐');
  assert.equal(rule.argument, '热搜榜');
});

test('泛请求「播放QQ音乐的歌」不会被平台前缀关键词吃成榜单', async t => {
  const h = fixture(t);
  const { rule } = await runQuery(h, '播放QQ音乐的歌');
  assert.notEqual(rule?.command.type, 'play_chart');
});

test('平台全称前缀只拉该平台目录', async t => {
  const h = fixture(t);
  const { rule } = await runQuery(h, '播放QQ音乐热歌榜');
  assert.equal(rule.command.type, 'play_chart');
  assert.ok(h.requests.some(u => u.includes('/leaderboard/boards')), '拉了榜单目录');
  const boardReq = h.requests.find(u => u.includes('/leaderboard/boards'));
  assert.equal(new URL(boardReq).searchParams.get('source'), 'tx');
  assert.ok(h.speech.some(s => s.includes('正在加载榜单热歌榜')));
});

test('平台全称出现在参数里也能识别（播放榜单 + 平台 + 榜名）', async t => {
  const h = fixture(t);
  const { rule } = await runQuery(h, '播放榜单网易云新歌榜');
  assert.ok(rule);
  assert.equal(rule.command.type, 'play_chart');
  assert.equal(rule.argument, '网易云新歌榜');
  await h.engine.executeCommand(rule, 'account', 'speaker');
  const boardReq = h.requests.find(u => u.includes('/leaderboard/boards'));
  assert.equal(new URL(boardReq).searchParams.get('source'), 'wy');
  assert.ok(h.speech.some(s => s.includes('正在加载榜单新歌榜')));
});

test('「播放榜单飙升榜」把榜单名提取为参数', async t => {
  const h = fixture(t);
  const { rule } = await runQuery(h, '播放榜单飙升榜');
  assert.ok(rule);
  assert.equal(rule.command.type, 'play_chart');
  assert.equal(rule.argument, '飙升榜');
});

test('常见榜名按字面生效：播放飙升榜 / 播放新歌榜 / 播放排行榜(=热歌榜)', async t => {
  const h = fixture(t);
  const prevFetch = globalThis.fetch;
  const boards = ['热歌榜', '飙升榜', '新歌榜'].map((name, i) => ({
    id: `wy__${i}`, name, bangid: String(i + 1), source: 'wy',
  }));
  globalThis.fetch = async (url) => {
    if (url.includes('/leaderboard/boards')) return jsonResp({ list: boards, source: 'wy' });
    return prevFetch(url);
  };
  for (const [query, expected] of [
    ['播放飙升榜', '飙升榜'],
    ['播放新歌榜', '新歌榜'],
    ['播放排行榜', '热歌榜'],
  ]) {
    h.requests.length = 0;
    h.speech.length = 0;
    h.plays.length = 0;
    const { rule, played } = await runQuery(h, query);
    assert.equal(rule?.command.type, 'play_chart', `${query} 命中榜单口令`);
    assert.equal(rule?.argument, '', `${query} 榜名在关键词里`);
    assert.ok(played, `${query} 起播`);
    assert.ok(h.speech.some(s => s.includes(`正在加载榜单${expected}`)), `${query} → ${expected}`);
    assert.equal(h.plays.length, 1, `${query} 只起播一次`);
  }
});

test('泛称映射只改完整名称，不误改真实榜名', async t => {
  const { normalizeChartSpeechName } = load('../src/voicecmd/defaults.ts');
  assert.equal(normalizeChartSpeechName('排行榜'), '热歌榜');
  assert.equal(normalizeChartSpeechName('UK排行榜周榜'), 'UK排行榜周榜');
  assert.equal(normalizeChartSpeechName('排行榜热歌'), '排行榜热歌');
});

test('play_chart 执行：拉榜单 → 组临时队列 → 起播（不入库）', async t => {
  const h = fixture(t);
  const { rule, played } = await runQuery(h, '播放热歌榜');
  assert.equal(rule.command.type, 'play_chart');
  assert.ok(played, '返回正在播放的曲目');
  assert.equal(played.songName, '榜曲1');
  assert.ok(h.requests.some(u => u.includes('/leaderboard/boards')), '拉了榜单目录');
  assert.ok(h.requests.some(u => u.includes('/leaderboard/list')), '拉了榜单曲目');
  assert.equal(h.plays.length, 1, '起播一次');
  const [songs, startIndex, mode, label] = h.plays[0];
  assert.equal(startIndex, 0);
  assert.equal(mode, 'order');
  assert.match(label, /^榜单:/);
  assert.equal(songs[0].id, 0, '不入库临时队列');
  assert.equal(songs[0].url, '', '直链留空由懒解析钩子补');
  assert.ok(h.speech.some(s => s.includes('正在加载榜单热歌榜')), '起播前有 TTS 提示');
});

test('play_chart 入库形态：走 importSongs，队列用真实 id', async t => {
  const h = fixture(t);
  h.config.external_search_no_import = false;
  // mock 宿主 remote 入库响应
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === 'http://host/api/v1/songs/remote') return jsonResp({ count: 3, songs: [1, 2, 3].map(i => ({ id: 40 + i, url: `/api/v1/songs/${40 + i}/play` })) });
    return prevFetch(url);
  };
  const { played } = await runQuery(h, '播放热歌榜');
  assert.ok(played);
  assert.equal(h.plays.length, 1);
  const [songs] = h.plays[0];
  assert.equal(songs[0].id, 41, '入库形态用真实 id');
  assert.match(songs[0].url, /\/api\/v1\/songs\//, '解析型歌曲 url 是宿主播放端点');
});

test('play_chart 榜单无结果：TTS 提示，不起播', async t => {
  const h = fixture(t);
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/leaderboard/boards')) return jsonResp({ list: [], source: 'wy' });
    return prevFetch(url);
  };
  const { played } = await runQuery(h, '播放热歌榜');
  assert.equal(played, null);
  assert.equal(h.plays.length, 0);
  assert.ok(h.speech.some(s => s.includes('没找到榜单热歌榜')), '给出明确提示');
});
