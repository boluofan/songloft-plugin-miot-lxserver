# songloft-jsplugin-miot

A Songloft plugin for sending music to smart speakers through MIoT. [中文](README.md).

“MIoT”, “MiHome” and other protocol/product names belong to their respective trademark owners. Names are used only for interoperability and identification; this plugin has no affiliation, authorization or endorsement from those owners.

## Development

```bash
npm install
npm run dev
npm run build       # dist/miot.jsplugin.zip
npm run validate
```

### Lynx frontend

Following the bili plugin, the frontend uses ReactLynx native elements and `@songloft/lynx-plugin-sdk`. It produces `main.lynx.bundle`, `main.web.bundle` and an automatically generated HTML fallback. Song lists, mini/full players and all six settings categories (devices, playback, voice, AI, schedules and toolbox) are retained.

Domain state uses standalone `@vue/reactivity`, without Vue components or a DOM renderer. HTTP, status/chat sockets, favorite notifications and back navigation use host bridges; frontend code does not read Tokens. The frontend pins published `@songloft/lynx-plugin-sdk@2.21.0`, uses public apiGet/apiPost/apiPut/apiDelete methods and shares PluginSocket for status/chat connections.

Update the matching server and Lynx client together. Older GET/POST-only bridges cannot provide complete editing and live connections; upgrading only the plugin is insufficient. HTML fallback needs server-provided `web-core/`. Static preparation removes legacy Vue output while preserving the builder's generated entry. Icons use inline native SVG to avoid missing fonts in nested frames. Commands, browser scripts and coverage limits are in the [verification record](docs/en/lynx-migration.md).

## Description

A smart-speaker control plugin with a built-in LX Music (lxserver) online search client. It does not bundle third-party device protocols or account systems; users are responsible for compliant integration.

## Device groups (multiple rooms)

Controls on any member apply to the other speakers in its group. A group shares one playlist, index, playback mode, transition timer and random sequence.

- Supported operations: playlist playback, pause/resume/stop, previous/next, playback mode, volume and direct URL playback.
- Plugin controls, voice commands and scheduled tasks share the same group behavior. Automatic transitions and resume also use the shared queue.
- One offline/failing member logs a warning without blocking the others. After recovery, the next group command replaces its playback state.
- Each device belongs to at most one group. Moving it removes old membership; removing members or deleting a group restores independent playback.

Open Settings → Devices → Device groups, create a group and select at least two managed speakers. Groups persist across restarts. Cloud commands are independent, so small start-time differences are expected; there is no frame-level synchronization protocol.

## Scheduled tasks and Chinese public holidays

Weekly schedules support three modes:

- Ignore holidays (default): follow selected weekdays.
- Public holidays only: require both an official holiday and a selected weekday.
- Actual working days: skip public holidays and include officially reassigned weekend workdays.

Data comes from MIT-licensed [NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn). The `prebuild` hook downloads the current and following year through jsDelivr/GitHub raw and compiles data into the bundle. Runtime access is offline. Before next year's official announcement, empty data means ordinary-day handling, and holiday-only rules do not run. Update regularly for new arrangements. Committed data permits offline builds.

## Online search and built-in LX Music (lxserver)

When a voice request misses the local library, miot runs an online search. The plugin ships with a **native, built-in** lxserver (LX Music sync server) client: search and direct-URL resolution both happen in-process, with no relay plugin required. On a miss or error it falls back to the user's external topone sources, which remain fully supported.

### Configuration

Settings → Voice → **Built-in LX Music source (lxserver)**:

- **Enable switch**: opt in to built-in search (off by default).
- **Server URL**: e.g. `https://lx.example.com:9527`.
- **User token**: optional (`lx_tk_...`). The plugin resolves the username through `/api/user/auth/verify` and authenticates with a paired `x-user-name` + `x-user-token`; leaving it empty means anonymous access to public sources only.
- **Default quality**: `320k` (default) / `flac` / `128k`; URL resolution degrades through `flac → 320k → 128k`.
- **Sources**: kw / kg / tx / wy / mg searched concurrently, ranked and deduplicated by match score.
- **Online artist queue** (off by default): when the local library has no songs for the requested artist, lxserver fetches a batch of that artist's popular songs and plays the whole queue instead of just the first hit. **Only the `tx` and `wy` sources support artist lookup**; other sources are skipped. If no direct URL can be resolved it falls back to the previous "play only the top-1 track" behaviour. The queue is temporary (nothing is imported), and only the first 2 tracks are resolved before playback starts — the rest are resolved just before they are needed, so a 10-track queue does not delay first playback by several seconds.

Both search response shapes are supported (legacy bare array and v2.1.3+ `{list,...}` object). All field mapping and compatibility fallbacks live in `src/lxserver/provider.ts`, so adapting to future server changes touches one place only.

### Local matching for "play artist X"

Deciding whether the local library has this artist **merges the results of two paths**; only when both come up empty does the plugin go online:

1. **Index scan (mandatory base)**: scans the playlist song caches plus the whole-library in-memory index, so imported songs that belong to no playlist are still found. This step cannot be skipped: the host stores artists in a `song_artists` join table, but `POST /songs/remote` only writes the `songs` table, so remote songs imported by this plugin are invisible to the host REST path below.
2. **Artist catalog + exact fetch (additive, host ≥ 2.10.0)**: `GET /api/v1/songs/names?field=artist&exclude_playlist_labels=none&type=local,remote` returns every distinct artist name (cached in-process for 10 minutes); the command is matched against that catalog with the same normalization (traditional→simplified, punctuation stripped) and scoring used by the index search, and the matching names are fetched with `GET /api/v1/songs?artist=<name>&exclude_playlist_labels=none`. The catalog contains individual artists (multi-value credits are split), and the exact fetch matches by normalized key so duets are returned for either collaborator. This path covers songs beyond the index size cap. The explicit `type=local,remote` filter is there because radio artists would be skipped anyway (no playback URL), so they only eat candidate slots and trigger useless fetch requests.

Results are merged by song id (index results first, preserving the "in playlists → standalone" order). On hosts without the catalog endpoint (404/400), or when nothing matches or the exact fetch returns nothing, the plugin naturally degrades to the index scan alone. Neither path queues radio entries or songs without a playback URL, and queue construction, random playback, and restart restoration of the temporary artist playlist are unchanged.

### Two test entry points

- **Test connection** (inside the built-in source card): checks only the lxserver URL and token (health probe + token-to-username lookup).
- **Online search test**: runs the exact same search path as voice playback. It takes only a keyword and does not care whether the hit comes from the built-in or an external source; the output reports the hit source (`Built-in lxserver` / `External topone`).

### Common online-search settings

Search priority, match threshold, timeout, **direct-link play without import**, and auto-append to playlist apply to **both** built-in and external sources.

- **Direct-link play without import** (off by default): when on, results with an http(s) direct URL are pushed straight to the speaker instead of being added to the library — useful for short-lived signed CDN links that would otherwise pile up as dead entries. The auto-append group is hidden while this is on, because appending requires a library song id (the setting is preserved and returns when switched off).
  - In this mode the URL is fetched by the plugin on the spot — it never goes through the host's resolver and never touches the library. Only when the speaker cannot decode the source format (webm/opus/flac/m4a and friends) does playback borrow the host's `/api/v1/proxy/transcode`; that URL is a transcoding channel, nothing more.
  - "Play artist X" pre-resolves the following tracks, but signed URLs expire, so the queue's **direct-URL cache is valid for 5 minutes**: once stale, the URL is re-resolved right before playback, which prevents a start failure after a long pause.
- With the switch off, **hits are imported as references (resolution-type source)**: the library stores how to obtain the track, never the direct URL. At playback time the host calls back into this plugin at `POST /api/music/url` to resolve a fresh URL, so entries never rot when signatures expire, they can be favourited and replayed, and `dedup_key` keeps one row per track. The first play costs one extra resolve round-trip (~0.3–1s); afterwards the host caches the audio. The source identity exposed to the host is the `entryPath` from `plugin.json`.
  - Built-in lxserver: the reference holds the `platform + track identity`, so the URL is re-fetched by id.
  - External topone sources: such sources usually only expose a search endpoint, with no "get URL by id". The reference therefore records **how the track was found** (source id, search keyword, and title/artist/duration hints) and playback simply re-runs that search. If the original source was removed or failed transiently, the remaining enabled sources are tried in configured order.

> The first release covers online search and direct-link playback only. Lyrics, playlist reading, AI recommendations and multi-user / per-room playlists are not implemented yet; extension points are reserved.

## Releases

Releases are tag-driven; the version is semver matching the tag (`1.1.0` ↔ `v1.1.0`), and the workflow plus bump rules are documented in [releases](docs/en/releases.md).

## Registering a search provider

When local library search misses, miot can call configured external sources. Plugins register as candidates; users decide whether to enable them.

1. Implement `POST /api/search/topone` with request `{ keyword, hint?: { title, artist, duration }, quality? }`. Success returns `{ code: 0, msg, data: { title, artist, album?, duration?, cover_url?, url?, plugin_entry_path?, source_data?, dedup_key?, lyric?, lyric_source? } }`; misses/errors use nonzero `code` and `data: null`. Deadline: six seconds. See the API specification dialog in miot settings; ytdlp, bili and subsonic are examples.
2. Declare `inter-plugin` permission and register through `songloft.comm` during `onInit`:

```ts
function registerToMiot() {
  let attempts = 0;
  const tryRegister = async () => {
    attempts++;
    try {
      if (!songloft.comm || typeof songloft.comm.call !== 'function') return;
      await songloft.comm.call('miot', 'register-search-provider', {
        name: 'My source',
        searchPath: '/api/search/topone',
        icon: '',
      });
    } catch (error) {
      if (attempts < 5) setTimeout(tryRegister, 3000);
    }
  };
  setTimeout(tryRegister, 2000);
}
```

Registration is idempotent by trusted caller entry path. Do not send `entryPath`: the host supplies caller identity. `name` defaults to the caller entry path; `searchPath` defaults to `/api/search/topone`; `icon` is optional. Optional `unregister-search-provider` takes an empty payload, typically during `onDeinit`. Delayed retries tolerate startup ordering or absent/older miot installations without blocking initialization.

Registration only adds a candidate. miot verifies installed/active state using the host plugin list, and removed plugins disappear. Built-in ytdlp/bili/subsonic use the same registration while retaining fallback entries for older plugins.

## Author and disclaimer

hanxi. This project is free and intended only for private personal learning and technical research. Commercial use, selling, monetization or distribution for profit is prohibited. Users supply and manage third-party credentials and data, retain ownership, and are responsible for local legal compliance and consequences of misuse. Using the project means accepting these statements.

## License

Apache-2.0 © 2026 hanxi
