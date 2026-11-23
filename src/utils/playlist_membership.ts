/// <reference types="@songloft/plugin-sdk" />

import { callHostAPI } from './http';

/**
 * 判断歌曲是否在某个歌单里。
 *
 * 优先用宿主的 `GET /playlists/{id}/song-ids` 轻量接口（只回 id 数组），避免为了判断一个
 * id 就把整个歌单的完整 Song 拉下来——收藏歌单动辄几千首，字段多、JSON 解析也重。
 *
 * 该接口是 2.10.0 之后才加的（commit a929c82），老宿主会 404；请求失败时降级回
 * `playlists.getSongs`，行为与改造前一致。
 */
export async function isSongInPlaylist(playlistId: number, songId: number): Promise<boolean> {
  try {
    const resp = await callHostAPI<{ ids?: number[] }>(
      'GET',
      `/api/v1/playlists/${playlistId}/song-ids`,
      undefined,
      { timeoutMs: 5000 },
    );
    // 空歌单返回 { ids: [], total: 0 }：是合法响应，直接判定为「不在」，不要当失败去降级
    if (Array.isArray(resp?.ids)) {
      return resp.ids.some(id => Number(id) === songId);
    }
  } catch (e) {
    songloft.log.info(`[PlaylistMembership] song-ids unavailable, falling back to getSongs: ${String(e)}`);
  }

  const songs = await songloft.playlists.getSongs(playlistId, { limit: 100000 });
  return songs.some(song => Number(song.id) === songId);
}
