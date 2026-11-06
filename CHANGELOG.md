# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-11-06

Playback detection fix, cinematic backgrounds, and lyric motion modes.

### Fixed

- **Playback not detected on the live web player.** Track metadata is now read
  from three independent sources: `navigator.mediaSession.metadata` (the web
  player publishes title/artist/album/artwork on every playback update), the
  player-bar DOM with v1/v2-widget fallbacks (visible text lines, artist anchors,
  cover `<img>`), and `document.title`. Play state comes from the play/pause SVG
  glyph, then `mediaSession.playbackState`, then position delta. A track is now
  recognised even when the player bar renders the flagged v2 widget without the
  documented title testids.
- Synthetic track identity is computed after every metadata fallback, so cache
  and resolver keys stay stable when only MediaSession data is available.
- Player polling is wrapped in an error boundary with a diagnostics ring buffer;
  one bad read no longer stops playback observation for the rest of the session.

### Added

- **Background styles** (`showBackground`, `backgroundStyle`, `backgroundMotion`):
  blurred album art with Ken Burns drift, jacket cover panel with a mirrored
  reflection, palette glow blobs, flat tinted base, **page-video mirror**, and a
  user image.
- **Page-video background**: mirrors a visible `<video>` (music videos, video
  podcasts) into a single canvas through `requestVideoFrameCallback` +
  `drawImage`, cover-cropped and blurred. The source element is never touched,
  and no pixel is read back (tainted-canvas safe). Falls back to album art and
  rescans every second.
- **Lyric motion modes**: `flow` (continuous interpolation between line anchors,
  no boundary snap) and `simple` (flat, no blur/scale/tilt), alongside `cinema`.
  Reduced-motion lowers all of them to opacity transitions.
- **Diagnostics**: the popup shows whether the player was detected, and
  "Copy diagnostics" copies a JSON report (selector hits, MediaSession state,
  range-input values, last track read, recent errors, lyrics status) produced by
  `SL.player.diagnostics()`.
- Custom background image upload in the popup (`chrome.storage.local['spicy.bgImage']`).
- New demo harness modes: `?no-dom-track=1` (MediaSession-only detection) and a
  playing `<video>` fixture for the video background.
- e2e expanded to 35 checks covering MediaSession-only detection, all lyric
  modes, background styles, the video mirror and the diagnostics round-trip.

### Changed

- Default background dim lowered to 0.48 and video blur reduced so artwork and
  video read more vividly while keeping lyric contrast.
- Idle copy now explains what to do when playback is not detected.

### Known limitations

- The video background requires a visible page `<video>`; audio-only tracks keep
  the album-art background.
- The direct `spclient` fetch path still depends on a captured bearer; logged-in
  playback was not available in the development environment, so verification is
  MediaSession/DOM/mock based.

## [1.0.0] — 2026-11-06

First public release. Chrome extension that rebuilds the Spicy Lyrics desktop
experience for the Spotify Web Player.

### Added

- **Lyrics acquisition** from Spotify's own data, with four paths: sniffed
  `color-lyrics` response (MAIN-world fetch/XHR wrapper), direct `spclient` fetch
  reusing the page's bearer, native lyrics DOM scraping, and a `chrome.storage.local`
  cache (240-track LRU).
- **Word-by-word animation**: per-syllable karaoke fill via a `--p` custom property
  on `background-clip: text`, gradient or solid fill, spring-driven line stack,
  dimmed and blurred inactive lines, interlude dots, line-click seek.
- **Dynamic backgrounds** derived from the album art palette (32×32 quantisation),
  with blur/dim controls and a deterministic hash palette fallback.
- **Overlay placement**: full main view (Cinema) or right sidebar (Panel), with a
  compact layout below 480 px width and a full-screen fallback when the target
  container is missing.
- **Spotify bootstrap**: when a track has no lyrics yet, the extension opens
  Spotify's own lyrics view once so Spotify performs the request, then reads the
  result (opt-out setting).
- **Settings** in the toolbar popup and in an in-overlay panel (`G`): layout mode,
  word fill style, minimal mode, header, interlude dots, reduced motion, album-art
  background, text size, line spacing, background blur/dim, ±20 s offset.
- **Local TTML import** from the popup for manual word-synced lyrics.
- **2026 web-player DOM support**: class-based `.main-view-container`, hidden
  `input[type="range"]` as the authoritative position source, `lyrics-line`
  testids with a unique active-class token, svg-path play/pause detection, and
  synthetic track identity promoted to the real id from sniffed requests.
- **Tooling**: `tools/build.mjs` (prod/dev packaging + zip), `tools/serve.mjs`
  (Spotify mock harness), `tools/e2e.mjs` (29 checks in Chrome for Testing against
  two DOM shapes), `tools/verify-prod.mjs` (10 packaging checks),
  `tools/test-lyrics.mjs` (23 parser tests), asset/fixture generators.
- **Docs**: `docs/spotify-webplayer-notes.md` with the verified selector table,
  `color-lyrics` request/response contract and evidence excerpts under
  `docs/evidence/`.

### Known limitations

- Word-level sync requires syllable timing in Spotify's payload; otherwise the
  extension falls back to line-level fill.
- The DOM scraping path is line-level only and requires the native lyrics view to
  have been opened at least once.
- Romanisation is not implemented (needs a morphological analyser for kanji);
  lyrics carrying `romanized` data are rendered if present.
- The authenticated direct-fetch path is unverified against a real account; the
  sniffed-capture and DOM paths are the primary ones.
