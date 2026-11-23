import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const modules = new Map();

// e2e 里 utils/http 要引 @songloft/plugin-sdk（本机没有 toolchain 源码），
// 这里只需要 callHostAPI 一个出口 —— 换成可编程桩。
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
    // playlist_membership.ts 用 './http'，其他模块可能用 '../utils/http'，两个都指到同一个桩
    if (name === './http' || name === '../utils/http') return httpStub;
    assert.ok(name.startsWith('.'), `unexpected runtime dependency: ${name}`);
    return loadSource(new URL(`${name}.ts`, url));
  }, exports);
  return exports;
}

const { isSongInPlaylist } = loadSource(new URL('../src/utils/playlist_membership.ts', import.meta.url));

/** 记录宿主调用 + 允许按需桩返回 */
function stubHost(handler) {
  const calls = [];
  hostAPIHandler = async (method, path) => {
    calls.push({ method, path });
    return handler(method, path);
  };
  return calls;
}

/** getSongs 记录器：降级分支才该被走到 */
function stubLibrary(songs) {
  const getSongsCalls = [];
  globalThis.songloft = {
    log: { info() { }, warn() { }, error() { } },
    playlists: {
      getSongs: async (id, opts) => {
        getSongsCalls.push({ id, opts });
        return songs;
      },
    },
  };
  return getSongsCalls;
}

test('isSongInPlaylist：命中 song-ids 时不再拉完整歌曲', async () => {
  const getSongsCalls = stubLibrary([
    { id: 1, title: '不该被读到的歌' },
  ]);
  const calls = stubHost((method, path) => {
    assert.equal(method, 'GET');
    assert.equal(path, '/api/v1/playlists/7/song-ids', '用轻量 id 接口，不带多余参数');
    return { ids: [3, 5, 9], total: 3 };
  });

  assert.equal(await isSongInPlaylist(7, 5), true);
  assert.equal(await isSongInPlaylist(7, 6), false, '不在 id 列表里就是没收藏');
  assert.equal(calls.length, 2);
  assert.equal(getSongsCalls.length, 0, '轻量接口够用时绝不回退拉完整歌曲');
});

test('isSongInPlaylist：空歌单是合法响应，判定为不在且不降级', async () => {
  const getSongsCalls = stubLibrary([{ id: 1 }]);
  stubHost(() => ({ ids: [], total: 0 }));

  assert.equal(await isSongInPlaylist(7, 1), false);
  assert.equal(getSongsCalls.length, 0, '空数组不是失败，别当 404 去降级');
});

test('isSongInPlaylist：老宿主没有 song-ids 接口时降级拉完整歌曲', async () => {
  const getSongsCalls = stubLibrary([{ id: 11 }, { id: 12 }]);
  stubHost(() => {
    // 2.10.0 之前的宿主没有这条路由
    throw new Error(`Host API error 404 GET /api/v1/playlists/7/song-ids: 404 page not found`);
  });

  assert.equal(await isSongInPlaylist(7, 12), true, '降级后仍然给出正确结果');
  assert.equal(getSongsCalls.length, 1);
  assert.equal(getSongsCalls[0].id, 7);
  assert.equal(getSongsCalls[0].opts?.limit, 100000, '降级口径与改造前一致');
});

test('isSongInPlaylist：id 以字符串返回时也能正确比较', async () => {
  stubLibrary([]);
  stubHost(() => ({ ids: ['21', '22'], total: 2 }));

  assert.equal(await isSongInPlaylist(7, 22), true);
  assert.equal(await isSongInPlaylist(7, 23), false);
});
