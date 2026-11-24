# Play history reporting

[中文](../play-history-report.md)

Speaker-side playback was never reported to the host, so the host App's play-history panel stayed empty for plugin playback, `play_count` counted only App-side plays, and plugins subscribing to `onPlayEvent` could not see speaker playback. This feature reports once when the device confirms that audio actually started.

## Host contract

The endpoint is `POST /api/v1/songs/{id}/played?source=miot`. A row is persisted only when `type=play` **and** both `context_type` and `context_key` are non-empty; omitting either still broadcasts the event without writing history. Within one context, the host upserts by song and increments `play_count`, keeping the most recent 50 entries. Older hosts lack the route; after the first 404/405 a process-wide flag disables further attempts.

## When to report

Reporting happens only on the first false→true transition of `playbackConfirmed`. All four confirmation points (verified push failure, landing verify, stop-poll position advance, post-reload takeover) go through `PlaylistManager.markPlaybackConfirmed()`; repeated confirmations are filtered by `reportedSongId`. Reporting is deliberately **not** done when pushing the URL — an offline or interrupted device would be recorded as a play. Resuming the same song after a pause does not count again.

Reporting is fire-and-forget with a 3-second timeout; failures are logged only and never block delivery or track advance.

## Queue-to-context mapping

| Queue source | `context_type` / `context_key` | Result |
| --- | --- | --- |
| Real playlist (play_playlist / favorites / page selection) | `playlist` / host playlist id | Persisted |
| Artist command (catalog hit) | `artist` / canonical credit from the catalog | Persisted |
| Artist command (catalog unavailable or no match) | `artist` / raw voice query | Persisted (a slightly off key is better than no history) |
| Artist queue restored after restart | `artist` / persisted credit | Persisted |
| "All songs" virtual playlist | no context | Event broadcast only, no history (the host has no matching context) |
| Single-song / online temporary queue (`song.id === 0`) | — | Skipped entirely (host would 404) |

The canonical credit comes from `IndexingManager.resolveArtistCredit()`, which reuses the in-process artist-name catalog cache and the existing fuzzy-match scoring, so it adds no host request. On older hosts without the catalog route it returns an empty string and the caller falls back to the raw query.

## Verification

`tests/play_history_report.test.mjs` uses a programmable `callHostAPI` stub to cover all four URL mappings, once-per-session deduplication, `song.id=0` skipping, 404 backoff, and credit resolution/fallback. The full `node --test tests/*.test.mjs` suite, type check, build and package validation pass. Real-device audio output, the actual display in the host App's history panel, and long-term operation remain unverified.
