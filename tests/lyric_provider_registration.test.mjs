import assert from 'node:assert/strict';
import test from 'node:test';
import { loader } from './chat_loader.mjs';

const mod = loader()('../src/handlers/lyric_provider.ts');
const { syncLyricProvider, unregisterLyricProvider, resetLyricProviderStateForTest } = mod;

function setup(t) {
  const previous = globalThis.songloft;
  const calls = [];
  globalThis.songloft = {
    lyrics: {
      registerProvider: () => calls.push('register'),
      unregisterProvider: () => calls.push('unregister'),
    },
    log: { info() {}, warn() {} },
  };
  t.after(() => { globalThis.songloft = previous; resetLyricProviderStateForTest(); });
  resetLyricProviderStateForTest();
  return calls;
}

const enabled = { lxserver: { enabled: true, host: 'http://lx.test:9527' } };
const disabled = { lxserver: { enabled: false, host: 'http://lx.test:9527' } };
const noHost = { lxserver: { enabled: true, host: '' } };

test('内置源启用时注册，重复同步不再重复注册', t => {
  const calls = setup(t);
  syncLyricProvider(enabled);
  syncLyricProvider(enabled);
  syncLyricProvider({ lxserver: { enabled: true, host: 'http://other:9527' } });
  assert.deepEqual(calls, ['register'], '地址变更不改变注册状态');
});

test('关闭内置源立即取消注册，重新启用会再注册', t => {
  const calls = setup(t);
  syncLyricProvider(enabled);
  syncLyricProvider(disabled);
  assert.deepEqual(calls, ['register', 'unregister'], '关源即停止提供歌词');
  syncLyricProvider(enabled);
  assert.deepEqual(calls, ['register', 'unregister', 'register'], '再开再挂上');
});

test('未启用或没填地址的源不注册，幂等不产生多余调用', t => {
  const calls = setup(t);
  syncLyricProvider(disabled);
  syncLyricProvider(noHost);
  syncLyricProvider(null);
  assert.deepEqual(calls, [], '歌词不随无效配置提供');
});

test('卸载时只反注册一次，重复卸载不报错', t => {
  const calls = setup(t);
  syncLyricProvider(enabled);
  unregisterLyricProvider();
  unregisterLyricProvider();
  assert.deepEqual(calls, ['register', 'unregister']);
});
