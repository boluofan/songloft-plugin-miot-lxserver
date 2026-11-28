import type { VoiceCommand } from '../types';

// 语音口语里的平台全称 → 内置音源别名。
// 这是全项目唯一允许出现平台全称的文件（语音识别必需，用户已明确豁免命名约定）；
// 其余代码、UI、文档仍只使用 kw / kg / tx / wy / mg 别名。
// 长名排在短名前面，避免「网易云」先命中「网易云音乐」的前半段留下残字。
const SPEECH_SOURCE_ALIASES: ReadonlyArray<{ speech: string; source: string }> = [
  { speech: '网易云音乐', source: 'wy' },
  { speech: '网易云', source: 'wy' },
  { speech: 'QQ音乐', source: 'tx' },
  { speech: 'qq音乐', source: 'tx' },
  { speech: '酷狗音乐', source: 'kg' },
  { speech: '酷狗', source: 'kg' },
  { speech: '酷我音乐', source: 'kw' },
  { speech: '酷我', source: 'kw' },
  { speech: '咪咕音乐', source: 'mg' },
  { speech: '咪咕', source: 'mg' },
];

/** 从文本里找出第一个平台口语前缀，返回别名与剥掉该前缀后的剩余文本。 */
export function parseSpeechSource(text: string): { source: string; rest: string } | null {
  const raw = String(text ?? '');
  for (const { speech, source } of SPEECH_SOURCE_ALIASES) {
    const idx = raw.indexOf(speech);
    if (idx >= 0) {
      return { source, rest: raw.slice(0, idx) + raw.slice(idx + speech.length) };
    }
  }
  return null;
}

/** 生成「播放/放 + 平台全称」的规则关键词，供榜单口令使用。 */
function buildChartSpeechKeywords(): string[] {
  const keywords: string[] = [];
  for (const { speech } of SPEECH_SOURCE_ALIASES) {
    keywords.push(`播放${speech}`, `放${speech}`);
  }
  return keywords;
}

/**
 * 榜单口语别名归一化：泛称「排行榜」按热歌榜处理。
 * 只匹配完整名称，避免把「UK排行榜周榜」等真实榜名误改。
 */
export function normalizeChartSpeechName(name: string): string {
  return name === '排行榜' ? '热歌榜' : name;
}

export function getDefaultVoiceCommands(): VoiceCommand[] {
  return [
    { type: 'play_playlist', keywords: ['播放歌单', '放歌单', '播放列表'], enabled: true },
    { type: 'play_artist', keywords: ['播放歌手'], enabled: true },
    // 榜单关键词 = 通用说法 + 平台全称前缀（如「播放QQ音乐热搜榜」），两者都走 play_chart。
    { type: 'play_chart', keywords: ['播放榜单', '播放热歌榜', '播放飙升榜', '播放新歌榜', '播放排行榜', '放榜单', '放榜', ...buildChartSpeechKeywords()], enabled: true },
    { type: 'play_song', keywords: ['播放歌曲', '放歌曲', '我想听'], enabled: true },
    { type: 'play_index', keywords: ['播放第', '跳到第', '切到第', '跳转到第'], enabled: true },
    { type: 'set_play_mode', keywords: ['随机播放', '随机模式'], param: 'random', enabled: true },
    { type: 'set_play_mode', keywords: ['单曲循环', '循环播放这首'], param: 'single', enabled: true },
    { type: 'set_play_mode', keywords: ['单曲播放', '只播放这首', '播完这首停止'], param: 'singlePlay', enabled: true },
    { type: 'set_play_mode', keywords: ['列表循环', '循环播放'], param: 'loop', enabled: true },
    { type: 'set_play_mode', keywords: ['顺序播放'], param: 'order', enabled: true },
    { type: 'next', keywords: ['下一首', '切歌', '换一首', '下一曲'], enabled: true },
    { type: 'previous', keywords: ['上一首', '上一曲'], enabled: true },
    { type: 'resume', keywords: ['继续播放', '恢复播放', '继续', '接着播', '接着放', 'resume'], enabled: true },
    { type: 'stop', keywords: ['暂停播放', '停止播放', '暂停音乐', '停一下', 'pause', 'stop', '停止', '别播了', '关掉音乐', '关机', '关闭', '暂停'], enabled: true },
    { type: 'favorite', keywords: ['收藏歌曲', '收藏这首歌', '喜欢这首歌', '收藏这首'], param: 'add', enabled: true },
    { type: 'favorite', keywords: ['取消收藏', '取消收藏歌曲'], param: 'remove', enabled: true },
    { type: 'sleep_timer', keywords: ['分钟后停止播放', '分钟后暂停播放', '分钟后停止', '分钟后关闭', '小时后停止播放', '小时后停止', '小时后关闭', '首歌后停止播放', '首歌后停止', '首后停止播放', '首后停止', '首歌后暂停', '首后关闭'], enabled: true },
    { type: 'cancel_sleep_timer', keywords: ['取消定时', '取消倒计时', '取消睡眠定时', '取消定时停止'], enabled: true },
    { type: 'query_sleep_timer', keywords: ['还有多久停', '定时还剩', '倒计时还剩', '还剩多久'], enabled: true },
  ];
}
