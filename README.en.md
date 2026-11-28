# songloft-plugin-miot-plus

**A personal customized build based on the [upstream songloft-plugin-miot](https://github.com/songloft-org/songloft-plugin-miot)**: it ships with a native built-in lxserver online search source, plus customizations for voice commands, artist matching, reference-based imports and releases.

Common capabilities — device groups, scheduled tasks, voice/AI chat, advanced voice handoff, the Lynx frontend — are identical to upstream and are not repeated here; see the [upstream README](https://github.com/songloft-org/songloft-plugin-miot#readme). [中文](README.md).

> "MIoT", "MiHome" and other protocol/product names belong to their respective trademark owners. Names are used only for interoperability and identification; this plugin has no affiliation, authorization or endorsement from those owners.

## Differences from upstream

| Capability | Upstream | This build |
| --- | --- | --- |
| Online search | user-configured external topone sources only | **native built-in lxserver**: search and URL resolution run in-process, no relay plugin needed; external topone sources remain as fallback |
| Sources | — | built-in kw / kg / tx / wy / mg, individually toggleable and orderable by search priority |
| Artist commands | plain local matching | **index scan + host artist catalog union**: imported remote songs are absent from the `song_artists` join table and invisible to the host REST path, so the index path is mandatory |
| Artist online songs | top-1 only | whole queue supported, URLs resolved lazily just before playback; temporary queue, nothing imported |
| Chart playback | — | charts matched dynamically by `name`, played as a queue, no hardcoded chart IDs |
| Import behaviour | direct URLs stored in the library | optional **reference import**: the library stores how to obtain a track and the host calls back into `POST /api/music/url` at playback time, so expired signatures do not rot entries |
| Direct-play mode | — | optional direct-link playback without import; URLs carry a 5-minute TTL and are re-resolved before playback once stale |
| Command priority | local rules first, AI as fallback | fixed controls and command memory stay local-first; **search commands are AI-first with local fallback**, with a circuit breaker after repeated AI failures; volume commands are handled by the speaker itself |
| Releases | automatic on push to main, date/serial versions | **tag-driven** semver matching the tag (`1.1.0` ↔ `v1.1.0`), version advanced on this branch |

## Built-in lxserver online search

When a voice request misses the local library, an online search runs across both the built-in lxserver source and configured external topone sources, falling back automatically on a miss or error. Search and URL resolution both happen in-process.

### Command resolution order (customized)

A voice command is handled in this order:

1. **Fixed controls** (stop, play mode, favourite, sleep timer, next/previous) — local rules, executed immediately on match.
2. **Command memory** — a previously successful request ends here, saving one resolution round-trip.
3. **AI parsing** — only when enabled and not in cooldown, and only executed when `confidence !== 'low'` and `action !== 'unknown'`.
4. **Local search commands** — song / artist / chart / playlist, used as the fallback when AI is low-confidence, returns unknown or fails.
5. If still unmatched, hand off to AI chat / voice resume.

Three consecutive AI failures trigger a 60-second cooldown, during which local commands are used directly so every request does not wait for a timeout first. **Volume commands ("louder", "softer", "set volume to X") are no longer handled by the plugin — the speaker handles them natively.** Explicit volume controls in scheduled tasks and the web volume slider remain.

### Local matching for "play artist X" (customized)

Deciding whether the local library has this artist **merges the results of two paths**; only when both come up empty does the plugin go online:

1. **Index scan (mandatory base)**: scans playlist song caches plus the whole-library in-memory index, so imported songs that belong to no playlist are still found. This step cannot be skipped: the host stores artists in a `song_artists` join table, but `POST /songs/remote` only writes the `songs` table, so remote songs imported by this plugin are invisible to the host REST path below.
2. **Artist catalog + exact fetch (additive, host ≥ 2.10.0)**: `GET /api/v1/songs/names?field=artist&exclude_playlist_labels=none&type=local,remote` returns every distinct artist name (cached in-process for 10 minutes); the command is matched against that catalog with the same normalization (traditional→simplified, punctuation stripped) and scoring used by the index search, and matching names are fetched with `GET /api/v1/songs?artist=<name>&exclude_playlist_labels=none`. The catalog contains individual artists and the exact fetch matches by normalized key so duets are returned for either collaborator. The explicit `type=local,remote` filter excludes radio artists, which would be skipped anyway (no playback URL) and only consume candidate slots.

Results are merged by song id (index results first, preserving the "in playlists → standalone" order). On hosts without the catalog endpoint (404/400), or when nothing matches or the exact fetch returns nothing, the plugin naturally degrades to the index scan alone.

### Configuration

Settings → Voice → **Built-in lxserver source**:

- **Enable switch**: opt in to built-in search (off by default).
- **Server URL**: e.g. `https://lx.example.com:9527`.
- **User token**: optional (`lx_tk_...`). The plugin resolves the username through `/api/user/auth/verify` and authenticates with a paired `x-user-name` + `x-user-token`; leaving it empty means anonymous access to public sources only.
- **Default quality**: `320k` (default) / `flac` / `128k`; URL resolution degrades through `flac → 320k → 128k`.
- **Quality fallback** (on by default): when off, only the selected quality is requested.
- **Sources**: kw / kg / tx / wy / mg, multi-select (at least one required); use the arrows to reorder — the order is the search priority. Sources are searched concurrently and ranked/deduplicated by match score. **Only tx and wy support artist lookup**; other sources are skipped.
- **Search timeout**: 1–30 seconds (default 6); **URL timeout**: 3–60 seconds (default 12).
- **Online artist queue** (off by default): when the local library has no songs for the requested artist, lxserver fetches a batch of that artist's popular songs and plays the whole queue instead of just the first hit. Only tx and wy support artist lookup; if no URL can be resolved it falls back to the top-1 single. The queue is temporary, and only the first 2 tracks are resolved before playback starts.
- **Chart playback**: say "play the hot chart" or "play the rising chart" and the plugin pulls the whole chart from the service. Charts are matched by their `name` (exact match first, ties broken by source order); no chart IDs are hardcoded. All five sources support charts. An unknown chart or a total first-batch resolution failure produces a TTS notice.

Both search response shapes are supported (legacy bare array and v2.1.3+ `{list,...}` object). All field mapping and compatibility fallbacks live in `src/lxserver/provider.ts`.

### Two test entry points

- **Test connection** (inside the built-in source card): checks only the server URL and token (health probe + token-to-username lookup).
- **Online search test**: runs the exact same search path as voice playback; the output reports the hit source (`Built-in lxserver` / `External topone`).

### Common online-search settings

Search priority, match threshold, timeout, **direct-link play without import**, and auto-append to playlist apply to **both** built-in and external sources.

- **Direct-link play without import** (off by default): results with an http(s) direct URL are pushed straight to the speaker instead of being added to the library — useful for short-lived signed CDN links. The auto-append group is hidden while this is on. In this mode the URL is fetched by the plugin on the spot and never goes through the host's resolver; only when the speaker cannot decode the source format (webm/opus/flac/m4a and friends) does playback borrow the host's `/api/v1/proxy/transcode`. The queue's direct-URL cache is valid for 5 minutes and re-resolved right before playback once stale.
- With the switch off, **hits are imported as references (resolution-type source)**: the library stores how to obtain the track, never the direct URL. At playback time the host calls back into `POST /api/music/url` to resolve a fresh URL, so entries never rot when signatures expire, can be favourited and replayed, and `dedup_key` keeps one row per track. The first play costs one extra resolve round-trip (~0.3–1s).
  - Built-in lxserver: the reference holds `platform + track identity`, so the URL is re-fetched by id.
  - External topone sources: the reference records **how the track was found** (source id, keyword and title/artist/duration hints) and playback re-runs that search, falling back to other enabled sources in configured order if the original source is missing or fails.

## Play history (customized)

Playback confirmed by the device is reported to the host: real playlists are keyed by playlist id and artist commands by the canonical name from the catalog; the "all songs" virtual playlist emits events only. See [play history reporting](docs/en/play-history-report.md).

## Releases (different from upstream)

Releases are **tag-driven**; the version is semver matching the tag (`1.1.0` ↔ `v1.1.0`), patch increments by default, and branch pushes do not build packages. See [releases](docs/en/releases.md).

## Development

```bash
npm install
npm run dev
npm run build       # dist/miot.jsplugin.zip
npm run validate
```

## Disclaimer

This project is free and intended only for private personal learning and technical research. Commercial use, selling, monetization or distribution for profit is prohibited. It bundles no third-party device protocols or account systems; users supply and manage third-party credentials and data, retain ownership, and are responsible for local legal compliance and consequences of misuse. Using the project means accepting these statements.

## License

Apache-2.0 © 2026 hanxi

## Credits

This plugin is customized from the upstream [songloft-org/songloft-plugin-miot](https://github.com/songloft-org/songloft-plugin-miot). Thanks to the upstream author for the smart-speaker plugin, Lynx frontend and host bridge work. For common features and troubleshooting, refer to that repository.
