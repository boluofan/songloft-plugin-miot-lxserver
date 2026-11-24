import { readSetup } from './setup-source.mjs';
import assert from 'node:assert/strict';
import ts from 'typescript';
import test from 'node:test';
import { ref, computed, reactive } from '@vue/reactivity';

function transpile(source, expose) {
  const cleaned = source
    .replace(/^import[\s\S]*?;\r?\n/gm, '')
    .replace(/^export /gm, '');
  return ts.transpileModule(`${cleaned}\nreturn {${expose}};`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
}

/** 抽出 VoiceSettings 的 createState，只测新增配置控件的状态与保存逻辑。 */
function voiceHarness(overrides = {}) {
  const lx = Object.assign(
    {
      enabled: false,
      host: '',
      token: '',
      quality: '320k',
      allowQualityFallback: true,
      sources: ['kw', 'kg', 'tx', 'wy', 'mg'],
      searchTimeout: 6,
      urlTimeout: 12,
      artist_queue_enabled: false,
    },
    overrides.lxserver,
  );
  const state = {
    config: {
      external_search_timeout: 6,
      song_match_threshold: 70,
      lxserver: lx,
      external_search_no_import: false,
      external_search_playlist_id: '',
      play_announcement_wait_mode: 'auto',
    },
    playlists: [],
    searchProviders: [],
  };
  const calls = [];
  const notifications = [];
  const watchers = [];
  const env = {
    WebSocket: function () {},
    onPush: () => {},
    displayText: (v) => String(v ?? ''),
    usePageState: () => ({}),
    NativeView: 'view',
    classes: () => '',
    styleObject: () => ({}),
    renderItems: () => [],
    computed,
    onMounted: () => {},
    onUnmounted: () => {},
    reactive,
    ref,
    watch: (_get, cb) => watchers.push(cb),
    SectionCard: 'view',
    SettingRow: 'view',
    SlButton: 'view',
    SlCheckbox: 'view',
    SlIcon: 'view',
    SlInput: 'view',
    SlSelect: 'view',
    SlSwitch: 'view',
    VoiceSectionNav: 'view',
    del: async () => {},
    post: async () => ({}),
    pluginWebSocketUrl: '',
    navigation: { page: '', settingsCategory: '' },
    addWebhook: async () => {},
    clearMemory: async () => {},
    confirmAction: () => true,
    deleteWebhook: async () => {},
    loadConversationMessages: async () => {},
    loadMemory: async () => {},
    loadSearchProviders: async () => {},
    loadVoiceData: async () => {},
    managedDevices: () => [],
    messageOf: (e) => String(e),
    notify: (text, kind) => notifications.push([text, kind]),
    playlistLabel: (p) => p.name,
    refreshIndex: async () => {},
    saveConfig: async (patch) => {
      calls.push(['save', structuredClone(patch)]);
      if (patch.lxserver) state.config.lxserver = { ...state.config.lxserver, ...patch.lxserver };
      else Object.assign(state.config, patch);
    },
    saveVoiceCommands: async () => {},
    state,
  };
  const source = readSetup('views/settings/VoiceSettings.tsx');
  const js = transpile(
    source,
    'lxSearchTimeout,lxUrlTimeout,lxSourcesDisplay,toggleLxSource,moveLxSource,saveLxNumber,saveLxserver',
  );
  const page = new Function(...Object.keys(env), js)(...Object.values(env));
  return { ...page, state, calls, notifications, watchers };
}

/** 抽出 PlaybackSettings 的 createState，测智能续播超时与公告等待方式。 */
function playbackHarness() {
  const state = {
    config: {
      song_transition_offset: 0,
      play_announcement_delay: 3,
      smart_resume_timeout: 30,
      play_announcement_wait_mode: 'auto',
    },
  };
  const calls = [];
  const env = {
    SlIcon: 'view',
    displayText: (v) => String(v ?? ''),
    usePageState: () => ({}),
    NativeView: 'view',
    classes: () => '',
    styleObject: () => ({}),
    renderItems: () => [],
    computed,
    ref,
    SectionCard: 'view',
    SettingRow: 'view',
    SlButton: 'view',
    SlInput: 'view',
    SlSelect: 'view',
    SlSwitch: 'view',
    SlDisclosure: 'view',
    messageOf: (e) => String(e),
    notify: () => {},
    saveConfig: async (patch) => {
      calls.push(['save', structuredClone(patch)]);
      Object.assign(state.config, patch);
    },
    post: async () => ({}),
    state,
  };
  const source = readSetup('views/settings/PlaybackSettings.tsx');
  const js = transpile(source, 'smartResumeTimeout,saveNumber');
  const page = new Function(...Object.keys(env), js)(...Object.values(env));
  return { ...page, state, calls, saveConfig: env.saveConfig };
}

test('搜索音源多选：勾选追加到末尾、取消移除、至少保留一个', () => {
  const h = voiceHarness({ lxserver: { sources: ['kg', 'tx'] } });
  h.toggleLxSource('kw', true);
  assert.deepEqual(h.state.config.lxserver.sources, ['kg', 'tx', 'kw']);
  h.toggleLxSource('tx', false);
  assert.deepEqual(h.state.config.lxserver.sources, ['kg', 'kw']);

  // 取消最后一个被拒绝，并给出提示
  h.toggleLxSource('kg', false);
  assert.deepEqual(h.state.config.lxserver.sources, ['kw']);
  const callsBefore = h.calls.length;
  h.toggleLxSource('kw', false);
  assert.deepEqual(h.state.config.lxserver.sources, ['kw']);
  assert.equal(h.calls.length, callsBefore);
  assert.ok(h.notifications.some(([text]) => text.includes('至少保留一个')));
});

test('搜索音源多选：展示顺序为已启用（配置顺序）在前、未启用在后', () => {
  const h = voiceHarness({ lxserver: { sources: ['tx', 'kw'] } });
  assert.deepEqual(h.lxSourcesDisplay.value, [
    'tx',
    'kw',
    'kg',
    'wy',
    'mg',
  ]);
});

test('搜索音源排序：上下移只交换已启用音源，边界不动', () => {
  const h = voiceHarness({ lxserver: { sources: ['kw', 'kg', 'tx'] } });
  h.moveLxSource('tx', -1);
  assert.deepEqual(h.state.config.lxserver.sources, ['kw', 'tx', 'kg']);
  h.moveLxSource('kw', 1);
  assert.deepEqual(h.state.config.lxserver.sources, ['tx', 'kw', 'kg']);
  // 已经是第一个，上移无效
  const before = [...h.state.config.lxserver.sources];
  const callsBefore = h.calls.length;
  h.moveLxSource('tx', -1);
  h.moveLxSource('kg', 1);
  assert.deepEqual(h.state.config.lxserver.sources, before);
  assert.equal(h.calls.length, callsBefore);
  // 未启用的音源不参与排序
  h.moveLxSource('wy', 1);
  assert.deepEqual(h.state.config.lxserver.sources, before);
});


test('lxserver 超时输入按各自边界钳制后写入 lxserver 子对象', () => {
  const h = voiceHarness();
  h.saveLxNumber('searchTimeout', '999', 1, 30);
  assert.equal(h.state.config.lxserver.searchTimeout, 30);
  assert.equal(h.lxSearchTimeout.value, '30');
  h.saveLxNumber('urlTimeout', '1', 3, 60);
  assert.equal(h.state.config.lxserver.urlTimeout, 3);
  assert.equal(h.lxUrlTimeout.value, '3');
  h.saveLxNumber('searchTimeout', '', 1, 30);
  assert.equal(h.state.config.lxserver.searchTimeout, 1);
  const lxPatch = h.calls.filter(([, p]) => p.lxserver).at(-1)[1].lxserver;
  assert.equal(lxPatch.searchTimeout, 1);
  // saveLxserver 每次都带完整 lxserver 子对象，其余字段不应丢失
  assert.equal(lxPatch.allowQualityFallback, true);
  assert.equal(lxPatch.urlTimeout, 3);
});

test('音质降级开关写入 lxserver.allowQualityFallback', () => {
  const h = voiceHarness();
  h.saveLxserver({ allowQualityFallback: false });
  assert.equal(h.state.config.lxserver.allowQualityFallback, false);
  assert.equal(h.calls.at(-1)[1].lxserver.allowQualityFallback, false);
});

test('智能续播超时按 5..120 钳制并回写输入框', async () => {
  const h = playbackHarness();
  h.saveNumber('smart_resume_timeout', '999', 5, 120);
  await Promise.resolve();
  assert.equal(h.state.config.smart_resume_timeout, 120);
  assert.equal(h.smartResumeTimeout.value, '120');
  h.saveNumber('smart_resume_timeout', '1', 5, 120);
  await Promise.resolve();
  assert.equal(h.state.config.smart_resume_timeout, 5);
});

test('公告等待方式写入合法枚举值', async () => {
  const h = playbackHarness();
  h.state.config.play_announcement_wait_mode = 'poll';
  await h.saveConfig({ play_announcement_wait_mode: 'poll' });
  assert.equal(h.state.config.play_announcement_wait_mode, 'poll');
  assert.deepEqual(h.calls.at(-1), ['save', { play_announcement_wait_mode: 'poll' }]);
});
