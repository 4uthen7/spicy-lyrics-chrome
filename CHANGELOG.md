# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] — 2026-11-09

Visuals and line transitions now follow the desktop Spicy Lyrics / Beautiful
Lyrics sources (upstream repos, see `docs/reference-spicy-beautiful.md`).

### Fixed

- **Line transitions no longer feel slow / "last line shows again".** Line focus
  transitions were 0.5 s; the outgoing line stayed visible while the next one
  brightened. Opacity/blur now settle in 0.18-0.2 s, the active line is promoted
  immediately, and the scroll spring was stiffened (settle ~300 ms instead of
  ~500 ms).
- **Clock is anchored to Spotify's own lyric highlight.** When the native lyrics
  view (opened by the bootstrap) advances a line, the extension clock is pulled
  forward to that line's start time, so line changes no longer wait for the
  quantised seek bar. Bounded to one line length and never backwards.
- Seek-bar readings are now only used as a lower bound: the clock never steps
  backwards on a stale sample, and an unchanged sample leaves the clock alone
  instead of dragging it back.

### Added

- **Soft karaoke sweep** ported from Spicy Lyrics: a 2x-wide dim→bright gradient
  with a fade band slides across each word, instead of a hard background-size cut.
- **Per-syllable bounce** ported from Spicy's animator splines: scale
  0.95→1.05→1, a small upward kick and a glow that blooms as the syllable is sung
  (`--ws`, `--wy`, `--wb`, `--wo` per word).
- Simple mode gets the wider fade and stronger contrast used by Spicy's simple
  renderer.
- Diagnostics expose the clock source, anchor count and recent clock samples.
- `docs/reference-spicy-beautiful.md` documents every ported constant and file.

### Verification

- e2e: 44/44 checks, including a deterministic render-lab check of the syllable
  bounce (`--ws 1.041`, `--wy -0.0083em`, glow 14 px at a frozen position), native
  highlight anchors (>=1 per sampled window) and monotonic clock under a
  one-second-quantised position source.

## [1.1.1] — 2026-11-09

Karaoke highlight no longer drifts backwards or jitters around the same spot.

### Fixed

- **Playback clock was re-based from quantised DOM readings.** The web player's
  seek bar updates in steps (and its clock text only has second resolution), so
  every poll wrote a value slightly behind the interpolated clock, producing the
  "highlight jumps back, then creeps forward again" jitter. The clock now pulls
  forward only and trims its rate by at most 8% to converge; only jumps over
  1.5 s are treated as seeks. A small backward delta is treated as quantisation,
  never as a seek.
- **Exact clock source**: when the page exposes its playback media element
  (`<audio>`/`<video>` with a matching duration, not looping, position agreeing
  with the DOM), `currentTime` is used as the clock. That removes the seek-bar
  quantisation lag entirely.
- Diagnostics now include the clock source, rate, recent seek count and a ring
  buffer of DOM/clock/error samples, so a remaining offset can be diagnosed.

### Added

- Fine sync controls: 10 ms steps in the popup offset slider and ±10/±100 buttons
  in the in-overlay settings panel.

### Verification

- e2e now checks that the clock never steps backwards under a 1 s-quantised
  position source, stays within one quantisation step of the player, keeps its
  rate correction subtle, treats large jumps as seeks, and uses the media-element
  clock when present (41/41 checks).

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
