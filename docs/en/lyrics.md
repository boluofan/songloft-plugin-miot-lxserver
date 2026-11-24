# Lyrics on the smart speaker player page

The smart speaker player page reads lyrics through the host's `/api/v1/songs/{id}/lyric` endpoint. When a song has no existing lyrics, the host calls registered lyric search plugins and caches successful results in the library. The smart speaker plugin does not need separate lyric provider settings.

This plugin is itself a lyric provider, but **lyric support is tied to the built-in lxserver source**: enabling the source registers the plugin with the host, which then calls `/lyric-search` for songs without lyrics. The plugin finds the track by title/artist through the built-in source and normalizes the provider's fields into the host's format (`lyric` / `tlyric` / `rlyric` / `lxlyric`, all LRC text). Hits are cached in the library by the host, so later reads skip the search. Turning the source off unregisters the provider — built-in source songs cannot be searched and this plugin no longer supplies lyrics either; the host asks other providers instead.

1. Enable the built-in lxserver source in this plugin's settings and fill in its address — the lyric provider starts and stops with this switch; there is no separate lyric setting. With it off, built-in source songs cannot be searched and lyrics are no longer supplied by this plugin.
2. If you do not use the built-in source, install and enable the Lyrics Search plugin instead, then turn on lyric search in its configuration page and save. Enabling the plugin alone does not enable searching.
3. Play a library song in the smart speaker plugin and click the lyrics button, or swipe left on the mobile fullscreen player.

The page shows a loading message while searching. A missing result prompts you to check the lyric search plugin; a failed request shows an error and a button to fetch lyrics again. Retrying uses the host's `refresh=1` behavior, which still protects file, embedded, and manual lyrics. Responses from an earlier song cannot overwrite the page after switching songs or stopping playback.

The lyric proxy waits up to 30 seconds, allowing room for the host's 15-second search budget per provider. Multiple providers timing out in sequence can still exceed this proxy budget; retry if necessary. Results depend on song metadata, provider coverage, and connectivity.

These are lyrics on the plugin's web page. Lyrics on a speaker's own touchscreen use the separate touchscreen lyrics setting and depend on Music API support and cloud catalog matching. External songs pushed without library import have no valid library song ID and cannot use this lyric endpoint.
