// 在线歌手队列的「懒解析」行为：队列里未解析直链的临时曲目，只在临播前才补 URL。
// 单独成文件的原因：player_failures.test.mjs 末尾有条历史遗留的异步报错会截断 TAP 输出，
// 放在那里跑不出结果。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');

function loadSource(path, dependencies) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  });
  const exports = {};
  new Function('require', 'exports', outputText)(name => {
    if (name === './library_playlist' || name === '../player/library_playlist') {
      return loadSource('../src/player/library_playlist.ts', {});
    }
    assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}

const http = {
  getHostBaseUrl: () => 'http://speaker.test',
  callHostAPI: async () => ({}),
};
const debug = { isDebugLog: () => false };
const { URLBuilder, playbackOptionsOf } = loadSource('../src/player/url_builder.ts', { '../utils/http': http });
const { PlaylistManager } = loadSource('../src/player/manager.ts', {
  '../playback/device_state': loadSource('../src/playback/device_state.ts', {}),
  '../config/manager': { playlistProgressScope: () => 'account:speaker' },
  './url_builder': { URLBuilder, playbackOptionsOf },
  '../utils/http': http,
  '../utils/debug': debug,
});

function withSongloft(run) {
  const previous = globalThis.songloft;
  globalThis.songloft = {
    log: { info() {}, warn() {}, error() {} },
    plugin: { getToken: async () => 'test-token' },
  };
  return Promise.resolve()
    .then(run)
    .finally(() => { globalThis.songloft = previous; });
}

function makeManager(pushes) {
  const manager = new PlaylistManager('account', 'speaker', {
    getPlayState: async () => ({ status: 1, position: 0, duration: 200, hasPosition: true }),
    playURL: async (_account, _device, url) => { pushes.push(url); return true; },
    stopPlay: async () => true,
    textToSpeech: async () => {},
  }, {
    getConfig: async () => ({}),
    updateDevice: async () => {},
    savePlaylistProgress: async () => {},
  });
  manager.minaService.playURLs = async (targets, ...args) =>
    Promise.all(targets.map(t => manager.minaService.playURL(t.account_id, t.device_id, ...args)));
  return manager;
}

const remoteSong = (title, url) => ({
  id: 0, title, artist: 'X', duration: 200, type: 'remote', url,
});

test('未解析直链的队列曲目：临播前才解析，已解析的不重复解析', async () => {
  await withSongloft(async () => {
    const pushes = [];
    const manager = makeManager(pushes);
    const resolved = [];
    manager.setSongUrlResolver(async (song) => {
      resolved.push(song.title);
      return `https://audio.example/${song.title}.mp3`;
    });

    try {
      // A 已有直链（首批解析），B 待解析，C 已有直链
      const queue = [remoteSong('A', 'https://audio.example/a.mp3'), remoteSong('B', ''), remoteSong('C', 'https://audio.example/c.mp3')];
      assert.equal(await manager.playWithSongs(queue, 0, 'order', '歌手: X', '', undefined, false), true);
      assert.deepEqual(resolved, [], '首曲已有直链，不该触发解析');
      assert.equal(pushes[0], 'https://audio.example/a.mp3');

      assert.equal(await manager.next(), true);
      assert.deepEqual(resolved, ['B'], '只解析即将播放的那一首');
      assert.equal(pushes.at(-1), 'https://audio.example/B.mp3');

      assert.equal(await manager.next(), true);
      assert.deepEqual(resolved, ['B'], '解析结果写回队列，不会重复解析');
      assert.equal(pushes.at(-1), 'https://audio.example/c.mp3');
    } finally {
      manager.setSongUrlResolver(null);
      manager.cleanup();
    }
  });
});

test('解析失败不抛给调用方：只有该首起播失败，后续曲目仍可继续', async () => {
  await withSongloft(async () => {
    const pushes = [];
    const manager = makeManager(pushes);
    manager.setSongUrlResolver(async (song) => {
      if (song.title === 'B') throw new Error('resolve boom');
      return `https://audio.example/${song.title}.mp3`;
    });

    try {
      const queue = [remoteSong('A', 'https://audio.example/a.mp3'), remoteSong('B', ''), remoteSong('C', 'https://audio.example/c.mp3')];
      assert.equal(await manager.playWithSongs(queue, 0, 'order', '歌手: X', '', undefined, false), true);

      // B 解析抛错 → 该首起播失败（返回 false），异常不会冒到调用方
      assert.equal(await manager.next(), false);
      assert.equal(manager.getCurrentSong()?.title, 'B');

      // 队列没被卡死：再切一首照常播放
      assert.equal(await manager.next(), true);
      assert.equal(manager.getCurrentSong()?.title, 'C');
      assert.equal(pushes.at(-1), 'https://audio.example/c.mp3');
    } finally {
      manager.setSongUrlResolver(null);
      manager.cleanup();
    }
  });
});
