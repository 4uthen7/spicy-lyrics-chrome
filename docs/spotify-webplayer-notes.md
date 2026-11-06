# Spotify Web Player recon for the spicy-lyrics Chrome extension

Scope: selector truth, player-state extraction, color-lyrics v2 contract, native-lyrics DOM, and the
failure modes of every acquisition path. Target: **open.spotify.com web player** (Spotify desktop client
and Spicetify are out of scope except where they explain a difference).

Method: fetched the shipped web-player bundles from `open.spotifycdn.com`, grepped the minified JS, and
executed the real app in headless **Chrome 157** over CDP (logged out) to verify what actually renders.
Every claim below is tagged with the artifact that supports it. `UNVERIFIED` means exactly that.

Build observed (from the HTML shell's `appServerConfig`, see `evidence/02-shell-and-bundles.txt`):

| field | value |
|---|---|
| buildVersion | `web-player_2026-11-06_1793928274424_21d156ee0039` |
| clientVersion | `1.3.10.15.g21d156ee0039` |
| webpack target (`u.j`) | `3400` |
| initial chunk hashes | main `web-player.73b73c08.js`, vendor `vendor~web-player.5858da05.js`, encore `encore~web-player.bde3d4f4.js`, css `web-player.9cf426b0.css` |
| lazy chunks used by the player bar | `dwp-now-playing-bar.0af8a902.js` (+ `8153`, `9398`, `5424`, `4076`, `6454`, `1186`) |

The player bar and the lyrics view are **lazy webpack chunks**, not part of the initial bundles. Any
selector work that only reads `web-player.73b73c08.js` will miss `now-playing-widget`, `cover-art-button`,
`playback-progressbar`, `playback-position`, `playback-duration`, `control-button-playpause` etc. The chunk
map is in the webpack runtime (`u.p`/`u.u` at the end of the main bundle, see evidence 02).

---

## 0. TL;DR — what contradicts the extension's current defaults

Reported to the Lead separately, repeated here because the code will be written against this file.

1. `[data-testid="main-view-container"]` **does not exist**. `main-view-container` is a **class**
   (`.main-view-container`, live-verified). Evidence: `03-testid-inventory.txt`, `04-live-dom.txt`.
2. `[data-testid="fullscreen-lyric"]` **does not exist in this build**. Native lyric lines are
   `[data-testid="lyrics-line"]`. Evidence: `08-lyrics-ui-bundle.txt`.
3. `[data-testid="progress-bar"]` exists **twice** in the player bar (seek bar and volume bar). The seek
   one must be scoped: `[data-testid="playback-progressbar"] [data-testid="progress-bar"]`.
   Live-verified in `04-live-dom.txt`.
4. `[data-testid="now-playing-widget"]`, `[data-testid="context-item-info-title"]`,
   `[data-testid="context-item-info-artist"]` are real, but they only exist **when a track is loaded**, and
   the artist testid is on the `<a href="/artist/...">` anchors (one per artist), not on a wrapping div.
   The subtitle div is `data-testid="context-item-info-subtitles"` (plural).
5. **The collapsed player bar does not expose the track id.** The title anchor
   (`a[data-testid="context-item-link"]`) links to the **album** (`/album/<albumId>`) for tracks, not
   `/track/<trackId>` (verified in bundle logic, `06-context-item-bundle.txt` §E). Detecting track changes
   from a `/track/` href will not work. Track id must come from sniffed `spclient` requests (or another
   authenticated source). This is the single most important architectural correction.
6. The web player's own lyrics request is
   `GET https://spclient.wg.spotify.com/color-lyrics/v2/track/{id}/image/{encodeURIComponent(imageUrl)}?format=json&vocalRemoval=<bool>`
   (+ `market`, injected by the transport) — i.e. the **`/image/{imageUrl}` variant**, not the bare
   `/track/{id}` variant. The bare variant is what third-party tools use and is documented publicly; it was
   not observed in this build. `productType=web_player` is **not** used on lyrics requests in this build;
   `productType=web-player` (hyphen) belongs to `GET /api/token`.
7. `GET /get_access_token?reason=transport&productType=web_player` returned **HTTP 403 "URL Blocked"**
   (Varnish 54113) from curl **and** from a same-origin `fetch()` in an anonymous browser session. The 2026
   build obtains its token from `GET /api/token?reason=…&productType=web-player&totp=…&totpVer=61`
   (TOTP-protected). The `/get_access_token` path may still work for a logged-in browser session, but that
   was **UNVERIFIED** here (no account available).
8. `open.spotify.com/lyrics/fullscreen` is a client-side route that the server answers with **404**; there
   is no server-rendered lyrics page to scrape. The lyrics view is mounted by the SPA.

---

## (a) Selector table

Confidence legend:
- **high** = the node/attribute was observed in the live rendered DOM via CDP (or is unambiguous in the
  shipped bundle and its semantics are confirmed by a live sibling).
- **medium** = present in the shipped bundle; not observed live because it requires an authenticated track
  (anonymous playback is blocked in this environment).
- **UNVERIFIED** = not observed/not provable here; treated as a guess.

| # | purpose | selector | from what | confidence |
|---|---|---|---|---|
| 1 | player bar root | `aside[data-testid="now-playing-bar"]` | live DOM (`04-live-dom.txt`), NPB chunk | high |
| 2 | now-playing widget, v1 (default) | `[data-testid="now-playing-widget"]` (`role="region"`, localized `aria-label`) | lazy `dwp-now-playing-bar.0af8a902.js` @33226 (`05-…txt`) | medium (exists; requires track) |
| 3 | now-playing widget, v2 (feature flag, default off) | `[data-testid="now-playing-widget-v2"]` | NPB chunk @43979 | medium |
| 4 | track title text | `[data-testid="context-item-info-title"]` | main chunk module 60296 @3724129 (`06-…txt` §B) | medium |
| 5 | subtitle wrapper | `[data-testid="context-item-info-subtitles"]` (plural) | main chunk module 42237 @3723692 (`06-…txt` §C) | medium |
| 6 | artist link(s) | `a[data-testid="context-item-info-artist"]` (one per artist, `href="/artist/…"`) | main chunk module 86485 (`06-…txt` §D) | medium |
| 7 | title anchor | `a[data-testid="context-item-link"]` | main chunk module 14540 (`06-…txt` §E) | medium |
| 8 | title anchor href for a track | `/album/<albumId>` — **not** `/track/<id>` | module 14540 logic (`06-…txt` §E) | medium (code-verified) |
| 9 | cover art button | `[data-testid="cover-art-button"]` (button, localized `aria-label`) | NPB chunk @30183 (`05-…txt` §ii) | medium |
| 10 | cover image | `[data-testid="cover-art-button"] img` | inferred from cover component in NPB chunk | **UNVERIFIED** (exact node) |
| 11 | cover container (v2 only) | `[data-testid="cover-art-container"]` | NPB chunk | medium |
| 12 | elapsed time (text `m:ss`) | `[data-testid="playback-position"]` (div) | live DOM + chunk 8153 @26110 | high |
| 13 | duration / remaining (text) | `[data-testid="playback-duration"]` (div; click toggles total ↔ `-remaining`) | live DOM + chunk 8153 @28201 | high |
| 14 | position attr on duration | `[data-testid="playback-duration"]` `data-test-position` (current ms) | live DOM + chunk 8153 @28201 | high existence, medium semantics |
| 15 | progress bar wrapper | `[data-testid="playback-progressbar"]` | live DOM + chunk 8153 @14090 | high |
| 16 | seek track (interactive `onPointerDown`) | `[data-testid="progress-bar"]` inside wrapper | live DOM + chunk 8153 | high |
| 17 | seek track background (rect used for ratio) | `[data-testid="progress-bar-background"]` | live DOM + chunk 8153 @… (`background` ref L) | high |
| 18 | seek handle | `[data-testid="progress-bar-handle"]` | live DOM | high |
| 19 | hidden range input (ms position/duration) | `[data-testid="playback-progressbar"] input[type="range"]` | live DOM | high element / medium playing semantics |
| 20 | play/pause button | `[data-testid="control-button-playpause"]` (`aria-label` localized) | live DOM + chunk 9398 @4017 | high |
| 21 | “is playing” icon | pause glyph path: `d` starts `M2.7 1a.7.7 0 0 0-.7.7v12.6` (16px) or `M5.7 3a` (24px) | bundle module 67055 + live DOM (`10-…txt`) | high (icon text is stable) |
| 22 | “is paused” icon | play glyph path: `d` starts `M3 1.713a.7.7 0 0 1 1.05-.607l10.89…` (16px) or `m7.05 3.606` (24px) | bundle module 56039 (`10-…txt`) | high |
| 23 | main content container | `.main-view-container` (class, **not** a testid) | live DOM + main chunk | high |
| 24 | native lyric line | `[data-testid="lyrics-line"]` (div, `dir="auto"`, 2 child divs) | main chunk @3693796 (`08-…txt` §A) | medium (requires lyrics view) |
| 25 | native lyric line text | `[data-testid="lyrics-line"] > div:nth-child(1)` (class `tUO1WBVA3vpkKoCsTCU_`) | main chunk @3693796 | medium |
| 26 | native lyric translation | `[data-testid="lyrics-line"] > div:nth-child(2)` (class `ULuul4Syvtoi_fq4QdBs`) | main chunk | medium |
| 27 | active lyric line | same `[data-testid="lyrics-line"]` + extra class `xp5WpqjB3u9hFHWKn2aE` | main chunk + css (`09-…txt`) | medium (class rotates per build) |
| 28 | passed lyric lines | extra class `NToFVceZLenbhmfcDb3s` | main chunk + css | medium (build-specific) |
| 29 | upcoming lyric lines | extra class `tixQoLB1xUrPglVJ91J4` | main chunk | medium (build-specific) |
| 30 | empty spacer lyric line | extra class `JraMqx9ZQax6C3ZIaMn2` (applied when text is empty) | main chunk + css | medium (build-specific) |
| 31 | lyrics view root | class `bm5I7yGVN8NXt6vH9eiC` (grid, height `calc(100vh - 73px)`) | css + main chunk | medium |
| 32 | lyrics view open? | `document.querySelectorAll('[data-testid="lyrics-line"]').length > 0` | derived from 24 | medium (derivation) |
| 33 | volume seek track (why #16 must be scoped) | second `[data-testid="progress-bar"]` | live DOM | high |
| 34 | media session metadata | `navigator.mediaSession.metadata` (`title`, `artist`, `album`, `artwork[]`), `.playbackState` | bundle `13-media-session.txt` | medium / readability from a content script **UNVERIFIED** |
| 35 | track id in DOM | **none found** (see §b.6) | live DOM + bundle | high (absence within inspected surfaces) |

Literal grep counts for every string requested by the task are in `evidence/16-grep-counts.txt` (22 terms x 10
files). Notable zeros: `fullscreen-lyric`, `lyrics-container`, `lyrics-page`, `context-item-info-album`,
`get_access_token`, `ScClient` — the token endpoint string is not in any shipped JS (the app calls
`/api/token`, built from constants rather than a literal we could find); `color-lyrics` appears once (the host
constant) and `spclient.wg.spotify.com` three times (API host constants). `main-view-container` appears as a
class/CSS name, `now-playing-view` as an analytics/CSS name, `right-sidebar` as CSS/layout names — none of
those are testids.

Testids from the original grep list that are **not** usable as written:
`fullscreen-lyric`, `main-view-container`, `right-sidebar`, `now-playing-view`, `context-item-info-album` — none of these exist as
`data-testid` in this build (live DOM + bundle grep). `cover-art-image` exists once in the main chunk, but it
belongs to a shared cover-art component used by cards/lists, and was not observed in the NPB; use
`cover-art-button` for the player bar instead. `progress-bar` is real but ambiguous (seek + volume), so always
scope it. `lyrics-container`/`lyrics-page` do not exist either; use `[data-testid="lyrics-line"]` and the view
root class.

Evidence index: `docs/evidence/01-http-matrix.txt` (all URLs/status/sizes),
`02-shell-and-bundles.txt`, `03-testid-inventory.txt`, `04-live-dom.txt`,
`05-now-playing-widget-bundle.txt`, `06-context-item-bundle.txt`, `07-color-lyrics-client.txt`,
`08-lyrics-ui-bundle.txt`, `09-lyrics-css.txt`, `10-playpause-icons.txt`, `11-token-and-network.txt`,
`12-locale-strings.txt`, `13-media-session.txt`, `14-external-references.md`,
`15-reconstructed-color-lyrics-schema.json`, `16-grep-counts.txt`.

---

## (b) Player-state extraction recipes

All snippets are for the **isolated world content script** (plain DOM). Poll ~250 ms **and** observe with
`MutationObserver`; Spotify re-renders the bar on SPA navigation and on view changes.

### b.1 Which container to query

```js
const bar = () => document.querySelector('[data-testid="now-playing-bar"]');
const widget = () =>
  document.querySelector('[data-testid="now-playing-widget"]') ||
  document.querySelector('[data-testid="now-playing-widget-v2"]');
```

- `now-playing-bar` exists and is stable (live-verified). `now-playing-widget` appears only with a track.
- Re-query on mutations; do **not** cache node references across navigations.

### b.2 Play / pause (locale-safe)

`aria-label` is localized (`Play`/`Pause` in en, `再生`/`一時停止` in ja — both observed). Compare the SVG
path instead:

```js
const PAUSE_PREFIXES = ['M2.7 1a.7.7', 'M5.7 3a'];          // 16px, 24px
const PLAY_PREFIXES  = ['M3 1.713a.7.7', 'm7.05 3.606'];     // 16px, 24px
function isPlaying() {
  const btn = document.querySelector('[data-testid="control-button-playpause"]');
  const d = btn?.querySelector('svg path')?.getAttribute('d') ?? '';
  if (PAUSE_PREFIXES.some(p => d.startsWith(p))) return true;
  if (PLAY_PREFIXES.some(p => d.startsWith(p))) return false;
  return null; // unknown; do not guess
}
```

The pause path is exactly the glyph the live idle page rendered (`10-playpause-icons.txt`); the play path is
from the shipped icon module. Both were verified in `web-player.73b73c08.js`.
Secondary signal (if it works from the content script, UNVERIFIED): `navigator.mediaSession.playbackState`.

### b.3 Position and duration (ms)

Best source — the visually-hidden range input inside the seek bar:

```js
const range = document.querySelector(
  '[data-testid="playback-progressbar"] input[type="range"]'
);
if (range && range.max > 0) {
  const positionMs = Number(range.value);   // ms
  const durationMs = Number(range.max);     // ms
  // range.getAttribute('aria-valuetext') === `${fmt(position)}/${fmt(duration)}` when active
}
```

Why this is the right node: the seek component is instantiated with `value`/`max` in **milliseconds**
(chunk `8153.ab3c6bb5.js`, the `SeekBar` call receives `value:G, max:H` and `onDragEnd` computes
`seekTo(ratio * max)`), and the a11y props are `{type:"range", min:0, max, value, step:1, "aria-valuetext":…}`
(module 68162). The live DOM confirms the element shape:
`<input type="range" min="0" max="0" step="0" aria-valuetext="-:--/-:--" value="1000">` while idle.
**Caveat (UNVERIFIED):** with a real track playing, `max` is expected to be the track duration in ms; this
was not observed live because anonymous playback is blocked. Use the text fallback below as a cross-check
and to detect garbage (`max === 0`, `step === 0` ⇒ idle).

Text fallback:

```js
const posText = document.querySelector('[data-testid="playback-position"]')?.textContent; // "m:ss"
const durEl   = document.querySelector('[data-testid="playback-duration"]');
const durText = durEl?.textContent;                     // "m:ss" OR "-m:ss" (user can toggle by clicking)
const posAttr = durEl?.getAttribute('data-test-position'); // current position in ms (observed "0" idle)
```

Parse `m:ss`/`h:mm:ss` robustly; when `durText` starts with `-` it is remaining time, so
`duration ≈ position + remaining`. The bundle shows the toggle: click on `playback-duration` switches
between `-{duration-position}` and `{duration}` (chunk `8153`, module for the duration component).

Alternative progress signal: the seek track's inline style
`--progress-bar-transform: <percent>%` (live-verified on `[data-testid="progress-bar"]`). Use only to
validate, not as the primary time source (percent loses precision and depends on CSS interpolation).

### b.4 Track change detection without a track id

Track metadata available in the collapsed bar:

```js
const title  = document.querySelector('[data-testid="context-item-info-title"]')?.textContent ?? '';
const artists = [...document.querySelectorAll('a[data-testid="context-item-info-artist"]')]
  .map(a => a.textContent);
const albumHref = document.querySelector('a[data-testid="context-item-link"]')?.getAttribute('href') ?? '';
// albumHref is "/album/<albumId>" for tracks (verified in bundle); use it only as an album hint.
```

Change key = `title + '\u0000' + artists.join('\u0000') + '\u0000' + albumHref`. This is an approximation:
two different tracks with identical title/artist can collide, and a same-title track on a different album
will produce a different key (useful). Treat the key as “candidate track changed”, then confirm the id via
the sniffer.

No selector exists for the **album name** in the collapsed bar. `navigator.mediaSession.metadata.album`
is set by the player (bundle-verified) but reading it from the content script is **UNVERIFIED** (isolated
world). Do not depend on it for the required `album` field; fall back to the album hint/empty.

### b.5 Cover art

```js
const btn = document.querySelector('[data-testid="cover-art-button"]');
const img = btn?.querySelector('img');
const coverUrl = img?.currentSrc || img?.src || null;
```

The v1 widget’s cover button contains the cover-art component (bundle `05-…txt` §ii). The exact `img`
node was **not** observed live (no track), so the `img` child is UNVERIFIED; it is the obvious structure but
write the code defensively (if no `img`, try `btn.querySelector('picture source')`, then the button’s
`style.backgroundImage`, then give up). For `<img srcset>`, prefer `currentSrc`; if absent, parse `srcset`
and take the largest `w`.

### b.6 Track id (the important one)

**There is no track id in the collapsed player bar DOM.** Evidence:

- The title anchor (`data-testid="context-item-link"`) is built from `getHrefForItem`; for a `TRACK` it
  returns the **album** URL (`e.album.uri → /album/{albumId}`), verified in module 14540 / 60296
  (`06-context-item-bundle.txt` §E). The artist anchors point to `/artist/{id}`.
- No `/track/` href, no `data-uri`/`data-track-uri` attribute, and no testid exposing the URI was found in
  the NPB chunks; in the live idle DOM the player bar contains no `/track/` link either (the page body does
  contain many `/track/` links in lists, so scope any such query to the player bar and expect nothing).
- `MediaMetadata` (the only browser-visible metadata) has no id field.

⇒ Track id must be obtained from network: the Spotify web player’s own `spclient` requests contain the id
in the URL, e.g. `…/color-lyrics/v2/track/<id>/…`, `…/metadata/4/track/<id>`, `…/track-playback/v1/...`
bodies. The extension’s MAIN-world injector should sniff **all** `spclient.wg.spotify.com` URLs and extract
`/track/([A-Za-z0-9]{22})` (and `/album/<id>`, `/artist/<id>` as needed), keyed by timestamp. Correlate the
current DOM title/artist/album-hint with the captured id. If the native lyrics request is the only one
available, the first sniff happens when the user opens Spotify’s lyrics — this is the “open Spotify lyrics
once” premise of the design. For a track never seen in a request, id stays unknown → fall back to
DOM-scrape-only or status “empty”.

### b.7 “Native lyrics view is open”

```js
const nativeLyricsOpen = document.querySelectorAll('[data-testid="lyrics-line"]').length > 0;
```

The lyrics component is only mounted in the lyrics view, and every rendered line has that testid. The view
root also carries class `bm5I7yGVN8NXt6vH9eiC`. Neither was observed live (requires a track); both are
bundle/CSS-verified. Cheap alternative: query the root class first, then the lines.

### b.8 Seek by pointer events

The seek track is a plain `div` with an `onPointerDown` handler. The drag hook computes
`clamp((clientX - rect.left) / rect.width)` using the **background** element’s rect, then on pointerup calls
`seekTo(ratio * max)` (bundle: chunk 8153, modules 27480 + SeekBar). So a click at a point is:

```js
function seekToRatio(ratio) {
  const track = document.querySelector(
    '[data-testid="playback-progressbar"] [data-testid="progress-bar"]'
  );
  const bg = document.querySelector('[data-testid="progress-bar-background"]');
  if (!track || !bg) return false;
  const r = bg.getBoundingClientRect();
  const x = Math.min(Math.max(ratio, 0), 1) * r.width + r.left;
  const y = r.top + r.height / 2;
  const opts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y,
                 pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 };
  track.dispatchEvent(new PointerEvent('pointerdown', opts));
  window.dispatchEvent(new PointerEvent('pointerup', opts));
  return true;
}
```

Caveats: the handler ignores `event.button !== 0`; the drag hook adds `pointermove`/`pointerup` on its own
target (a window/document-like object) when pointerdown fires, so dispatch the up on `window` and optionally
a `pointermove` first if Spotify requires a move to register a drag. **UNVERIFIED at runtime** (no playback
to test against); the bundle logic is unambiguous. Always do an optimistic local seek so the UI does not
snap back if the synthetic event is dropped. Do **not** target the range input (it is `disabled` while idle;
the visible slider is the real control).

### b.9 Re-attach strategy

The player bar re-renders (SPA navigation, track change, view switches). Attach one `MutationObserver` on
`document.body` (subtree childList) and debounce re-bind; keep the 250 ms poll as the fallback for value-only
updates (progress bar values change without mutations of the element set).

---

## (c) color-lyrics v2 request spec and response schema

### c.1 Request (two variants; pick deliberately)

**(c1) The variant the web player itself calls** (verified in build 2026-11-06):

```
GET https://spclient.wg.spotify.com/color-lyrics/v2/track/{trackId}/image/{encodeURIComponent(imageUrl)}
    ?format=json
    &vocalRemoval=false            # boolean string, from the player's vocal-removal setting
    &market=from_token             # injected by the transport for authenticated sessions
    [&clientLanguage=<lang>]       # only when a translation language is selected
Authorization: Bearer <user access token>
App-Platform: WebPlayer
Spotify-App-Version: 1.3.10.15.g21d156ee0039   # current clientVersion; must match the token's client
Accept: application/json
Origin: https://open.spotify.com                # browser context
Referer: https://open.spotify.com/              # browser context
```

`imageUrl` is one of the track’s cover images (the player picks a 600px one, `desiredLabel:"large",
desiredSize:600`). Evidence: `07-color-lyrics-client.txt` §A/B/E; `market` injection at module 5134218
(`market: O.isAnonymous ? N.market : "from_token"`), global headers at module 5137201
(`setGlobalRequestHeaders([["App-Platform",…],["Spotify-App-Version",…]])`).

**(c2) The bare-track variant used by third-party tools** (public reference; not observed in this build):

```
GET https://spclient.wg.spotify.com/color-lyrics/v2/track/{trackId}?format=json&market=from_token
```

Corroborated by the public syrics client (`14-external-references.md`) with the same auth/header shape.
Practical recommendation: **sniff (c1) from the page** and, when constructing a request yourself, try
(c2) first (it does not need an image URL), then (c1) if (c2) fails and you have a cover URL.

**What NOT to trust:** the extension default
`…/color-lyrics/v2/track/{id}?format=json&market=from_token&vocalRemoval=false&productType=web_player`.
`productType=web_player` is not present in any lyrics request in this build (the token endpoint uses
`productType=web-player`). It may be silently ignored by the gateway, but that is **UNVERIFIED**; prefer the
parameters above.

**Auth reality in this environment (2026-11-06):**
- Anonymous token (from the live `/api/token` response, shape below) + `client-token` from
  `clienttoken.spotify.com` → **all** color-lyrics attempts returned **HTTP 400, 0 bytes** (tried with and
  without the extra headers/params; three different track ids). `metadata/4/track/{id}` → 404 with the same
  anonymous token. Conclusion: lyrics require a **user-session** token, not the anonymous web-player token.
- Token endpoints today: the app calls `GET /api/token?reason=transport|init&productType=web-player&totp=
  <6 digits>&totpServer=<6 digits>&totpVer=61`. Without TOTP it answers `400 {"error":{…"Unauthorized
  request"…}}` (2586 bytes). `GET /get_access_token?reason=transport&productType=web_player` → **403
  Varnish "URL Blocked" 54113** (431 bytes) for anonymous sessions, both curl and browser fetch.
  `/get_access_token` with an authenticated session is **UNVERIFIED** (no account available). See
  `01-http-matrix.txt`, `11-token-and-network.txt`.
- The anonymous `/api/token` JSON shape (live-captured, token redacted):
  `{"clientId":"d8a5ed958d274c2e8ee717e6a4b0971d","accessToken":"<140 chars>",
  "accessTokenExpirationTimestampMs":<epoch ms>,"isAnonymous":true,"_notes":"<present>"}`.
  The web player validates exactly `accessToken`, `accessTokenExpirationTimestampMs`, `isAnonymous`.
  For authenticated users `isAnonymous` is false and `market` is `from_token`.
- The `client-token` header value comes from `POST https://clienttoken.spotify.com/v1/clienttoken`
  (`{"response_type":"RESPONSE_GRANTED_TOKEN_RESPONSE","granted_token":{"token":"…"}}`). Whether spclient
  actually requires it for lyrics with a user token is **UNVERIFIED** (third-party clients omit it and use
  just the user bearer — see external refs).

**Recommended acquisition order for the extension** (matches the architecture in task-2, with the endpoint
correction): sniff the page’s own `spclient` traffic (full URL + JSON) → if you must fetch yourself, reuse a
**user** bearer captured from that traffic (and the same `App-Platform`/version headers) and call (c2), then
(c1) if a cover URL is available → DOM scrape only as last resort → `empty`.

### c.2 Response schema — verified fields

Read this as “what the shipped web player reads out of the response” (module 26655,
`07-color-lyrics-client.txt` §C) plus the third-party corroboration for the per-line field names:

```ts
type ColorLyrics = {
  colors: {                    // int32 color values (ARGB-ish; converted with fromInt(...).toCSS(RGB))
    text: number;              // -> --lyrics-color-inactive / text
    highlightText: number;     // -> --lyrics-color-active
    background: number;        // -> --lyrics-color-background
  };
  hasVocalRemoval: boolean;    // read (`?? false`)
  lyrics: {
    syncType: "LINE_SYNCED" | "SYLLABLE_SYNCED" | string;  // only these two are treated as time-synced
    lines: Array<{
      startTimeMs: string;     // stringified integer milliseconds
      words: string;           // full line text
      // endTimeMs?: string;      // UNVERIFIED in-payload; the web player derives end from next line
      // syllables?: Array<...>;  // UNVERIFIED shape; present as an array in public samples (empty for LINE_SYNCED)
    }>;
    provider: string;                     // e.g. "Musixmatch"
    providerDisplayName: string;
    providerLyricsId: string;
    alternatives: Array<{ language: string; lines: Array<{ startTimeMs: string; words: string }> }>;
    previewLines: Array<{ startTimeMs: string; words: string }>;
    capStatus: string;                    // only the literal "CAPPED" is compared
  };
};
```

Verified from bundle only: the field names used in the mapper (`startTimeMs`, `words`), `syncType` values,
`provider`, `providerDisplayName`, `providerLyricsId`, `hasVocalRemoval`, `colors.text/highlightText/
background`, `alternatives` (matched by language prefix for translations), `previewLines`, `capStatus`.
The web player’s **line mapper** is:

```js
function f(line, allLines, i) {
  return {
    start: Number(line.startTimeMs) || 0,
    end: allLines[i + 1]?.startTimeMs ? Number(allLines[i + 1].startTimeMs) : Infinity,
    text: line.words,
  };
}
```

⇒ the web player ignores `endTimeMs` even if present, and never reads `syllables` (grep: the token
`syllables` does not occur in any shipped bundle).


### c.2.1 Example payloads (reconstructed; see evidence/15-…json for the annotated version)

LINE_SYNCED (line-level timings only; `syllables` is present but empty):

```json
{
  "colors": { "text": -1, "highlightText": -1, "background": -14934778 },
  "hasVocalRemoval": false,
  "lyrics": {
    "syncType": "LINE_SYNCED",
    "lines": [
      { "startTimeMs": "0",    "words": "",                        "endTimeMs": "0", "syllables": [] },
      { "startTimeMs": "960",  "words": "One, two, three, four",   "endTimeMs": "0", "syllables": [] },
      { "startTimeMs": "4020", "words": "Ooh-ooh, ooh-ooh-ooh",    "endTimeMs": "0", "syllables": [] }
    ],
    "provider": "Musixmatch",
    "providerDisplayName": "Musixmatch",
    "providerLyricsId": "32707868",
    "alternatives": [],
    "previewLines": [],
    "capStatus": "NONE"
  }
}
```

Fields in the example that are **UNVERIFIED** (reconstructed): `endTimeMs` value semantics (`"0"` vs real
end), empty `syllables` arrays, `capStatus: "NONE"` (only `"CAPPED"` is proven), concrete color integers,
`providerLyricsId` format.

SYLLABLE_SYNCED (word/syllable timings; the extension MUST use these for word-by-word fill):

```json
{
  "colors": { "text": -1, "highlightText": -2039584, "background": -15195059 },
  "hasVocalRemoval": true,
  "lyrics": {
    "syncType": "SYLLABLE_SYNCED",
    "lines": [
      {
        "startTimeMs": "17950", "endTimeMs": "22170",
        "words": "Hello from the other side",
        "syllables": [
          { "startTimeMs": "17950", "endTimeMs": "18620", "numChars": 5 },
          { "startTimeMs": "18620", "endTimeMs": "19100", "numChars": 1 },
          { "startTimeMs": "19100", "endTimeMs": "19720", "numChars": 4 },
          { "startTimeMs": "19720", "endTimeMs": "20400", "numChars": 3 },
          { "startTimeMs": "20400", "endTimeMs": "21430", "numChars": 3 },
          { "startTimeMs": "21430", "endTimeMs": "22170", "numChars": 6 }
        ]
      }
    ],
    "provider": "Musixmatch",
    "providerDisplayName": "Musixmatch",
    "providerLyricsId": "32707868",
    "alternatives": [
      { "language": "es", "lines": [ { "startTimeMs": "17950", "endTimeMs": "22170", "words": "Hola desde el otro lado", "syllables": [] } ] }
    ],
    "previewLines": [],
    "capStatus": "NONE"
  }
}
```

**UNVERIFIED, reconstructed:** the `syllables[]` element shape `{startTimeMs, endTimeMs, numChars}` is not
present in any 2026 artifact captured here (see §c.2). Its meaning is: the first `numChars` UTF-16 code units
of `words` are sung during `[startTimeMs, endTimeMs]`; concatenating syllables in order must reproduce the
line text exactly. Background-vocal/duet markers were **not found anywhere** in the shipped bundle and are
not included; treat any `isBackground`/`x-bg` field as UNVERIFIED until a real payload is captured.

Reconstructed payloads with realistic types for both sync types are in
`evidence/15-reconstructed-color-lyrics-schema.json`; every reconstructed field is marked there. The
syllable object field names `{startTimeMs, endTimeMs, numChars}` are **UNVERIFIED** against a captured 2026
payload (they come from ecosystem knowledge; the public README confirms `syllables` is an array of objects
and is empty for line-synced tracks). Do not build correctness tests on them without a real capture.

### c.3 Parsing rules that follow from the schema

- Lines are ordered by `startTimeMs`; end time = next line’s start. Last line’s end is unknown (`Infinity`);
  synthesize from duration or from audio.
- Empty `words` lines are real payload rows and must be preserved as timing gaps, not dropped before
  computing gaps (the web player prepends two extra empty spacer lines for layout only — those are a UI
  artifact, not payload rows).
- `UNSYNCED`/`isTimeSynced:false` → static lines; the web player renders them with no active-line logic.
- `capStatus === "CAPPED"` → the payload is still valid but the account is capped; show whatever lines are
  returned (the web player also truncates to 5 lines for snippets only, not for the normal view).
- Translations: `alternatives[].language` matched against the user’s selected language by 2-letter prefix;
  the translated line text replaces the visible text but the timing stays from the primary lines.
- 404 means “no lyrics” (`{hasLyrics:false}` in the web player), not “retry forever”.

---

## (d) How the native active lyric line is marked

**Not** with `aria-current`, `data-active`, opacity-only CSS on inline style, or any data attribute. The
active line is the same `div[data-testid="lyrics-line"]` with one **extra hashed class**
(`xp5WpqjB3u9hFHWKn2aE` in this build). The full class scheme in build 2026-11-06:

| role | classes on `div[data-testid="lyrics-line"]` |
|---|---|
| every line | `MFEBmMwUCW5Qmg8VwGim` |
| empty spacer line (text `""`) | `MFEBmMwUCW5Qmg8VwGim` + `JraMqx9ZQax6C3ZIaMn2` |
| passed line (before active) | `MFEBmMwUCW5Qmg8VwGim` + `NToFVceZLenbhmfcDb3s` (CSS: `color:var(--lyrics-color-inactive);opacity:.5`) |
| **active line** | `MFEBmMwUCW5Qmg8VwGim` + `xp5WpqjB3u9hFHWKn2aE` (CSS: `color:var(--lyrics-color-active)`) |
| upcoming line | `MFEBmMwUCW5Qmg8VwGim` + `tixQoLB1xUrPglVJ91J4` |

CSS proof is in `evidence/09-lyrics-css.txt`; JS proof in `08-lyrics-ui-bundle.txt` (the line renderer binds
`JraMqx9ZQax6C3ZIaMn2` to `!text`, and the wrapper used for the active index passes
`className:"xp5WpqjB3u9hFHWKn2aE"`).

The active line is only rendered when the payload is time-synced (`isTimeSynced` true, i.e. syncType
`LINE_SYNCED`/`SYLLABLE_SYNCED`); otherwise every line is rendered in the neutral “snippet” style and there is
no active marker at all. The active line is followed by a “Sync” button (scroll-to-current-line control)
which is a sibling in a Fragment, not a child of the line div.

Because the class hashes rotate on every deploy, hard-coding `xp5WpqjB3u9hFHWKn2aE` is a short-lived hack.
Robust detection that survived the build analysis:

1. Collect all `[data-testid="lyrics-line"]` elements in DOM order.
2. Build a frequency map of their class tokens.
3. Base class = token on 100% of lines. Passed/upcoming/spacer tokens appear on many lines. The active line is
   the one carrying a token that **appears exactly once** across all lines (and is not the base token).
   If several unique tokens appear, prefer the line whose computed color equals the active CSS variable
   (`getComputedStyle(line).color` === computed `--lyrics-color-active` on the view root), and among
   candidates the one whose `getBoundingClientRect()` is nearest the viewport middle.
4. Fallback: `aria-current` is absent, so if neither works, use the playback position plus the timings learned
   from previous plays (the DOM has no timings at all).

Additional structural facts that matter for scraping: two empty lines are **prepended** by the view
(`[...[,,].fill(k), ...lines]`), so DOM line index = payload index + 2; the line text is
`line.children[0]`; translations (if any) are `line.children[1]`.

---

## (e) Web player vs desktop client: word-level timing

**Web player (2026 build): line-level only, no word timing.**

- The renderer maps every payload line to `{start, end, text}` using only `startTimeMs` and `words`
  (`08-…txt` §B). `endTimeMs` is ignored; the end is the next line’s start.
- `syllables` never appears in the shipped bundles at all (`grep` over main+vendor+encore and all downloaded
  lazy chunks: 0 hits). The DOM contains one plain-text `<div>` per line; there are no word spans.
- The stylesheet has no `background-clip: text` / `-webkit-background-clip: text` on lyric classes (only
  unrelated `padding-box`/`content-box`), i.e. no word-fill effect can be produced by the native UI.
- Even when the payload says `SYLLABLE_SYNCED`, the web player treats it as “time-synced” and highlights the
  whole line only.
- So native lyric text scraping can give you **text + line order + which line is active**, never per-word
  timings. Word-by-word karaoke must come from the raw color-lyrics payload (syllables) rendered by our own
  overlay. This is exactly the gap the extension fills.

**Desktop client / Spicetify:** uses the same color-lyrics v2 payload, and for syllable-synced tracks the
syllable data drives per-word highlight (Spicy Lyrics’ core effect). The desktop client additionally
supports TTML lyrics for some content and has filesystem/API access the web player does not. TTML is *not*
referenced anywhere in the web-player bundles (`ttml`, `x-bg`, `ttm:role` ⇒ 0 hits), and no TTML request is
made by the web player, so **TTML is not obtainable from open.spotify.com**. The TTML parser planned in
task-2 is therefore useful only for imported/other sources; its format details are **UNVERIFIED** in this
environment (no TTML artifact captured). Treat the parser as best-effort and do not claim it matches
Spotify’s desktop TTML without a fixture.

---

## (f) Risks / failure modes per data path

### f.1 Sniffed `spclient` fetch (MAIN-world `fetch`/XHR wrapper)

Strengths: exact response bytes, real URL (including the `/image/{imageUrl}` form and `market`), zero auth
handling, works for the logged-in session, and gives you the **track id** from the URL (no other path does).

Risks:
- **Timing/coverage:** the web player only requests lyrics when its own lyrics view is opened for a track
  (`useLyrics` is enabled by `hasLyrics` availability and by the lyrics mode setting). A user who never opens
  native lyrics produces zero lyric payloads. The extension must therefore (a) present the “open Spotify
  lyrics once” hint, and (b) not treat absence as “track has no lyrics”.
- **Breaking Spotify:** wrapping `fetch`/XHR must be transparent — always call through, return the original
  `Response`/`XMLHttpRequest` semantics, and if you need the body, `response.clone().text()` (never consume
  the original). Wrap in try/catch; a thrown wrapper breaks playback and the whole page.
- **Performance/memory:** payloads are small (< 100 KB), but keep a per-track-id map bounded; do not retain
  every response forever across the session.
- **URL extraction:** use the request URL as the key; don’t assume the JSON is always attached (404s also
  appear). Parse `lyrics.syncType` in a try/catch.
- **MV3 MAIN-world constraints:** `inject-main.js` runs at `document_start`; the wrapper must be installed
  before the player boots (it will be, if the content script registers it at document_start). Messages
  between worlds must be validated (`event.source === window`, `data.source === 'spicy-main'`).
- **Retries:** the web player may re-request lyrics after a translation toggle or cap change; dedupe by
  `${trackId}|${clientLanguage}|${vocalRemoval}` and prefer the most recent.
- **UNVERIFIED:** whether responses are ever streamed/opaque or served from a service worker cache in a way
  that bypasses the page’s `fetch` wrapper.

### f.2 Direct token fetch (`/get_access_token` or `/api/token`, then spclient)

Strengths: no dependency on the player opening native lyrics; can fetch on track change immediately.

Risks:
- **Token acquisition is the weak link.** In an anonymous session `/get_access_token` is blocked (403) and
  the current build uses a TOTP-protected `/api/token` that needs the TOTP secret (fetched from a
  versioned external mirror; the captured request used `totpVer=61`). Hard-coding TOTP generation is
  brittle (secret/version rotates) and is a cat-and-mouse dependency.
- If you capture the **user** bearer from page traffic (best option), it expires (~1 h; the token JSON has
  `accessTokenExpirationTimestampMs`) and must be refreshed by re-sniffing. Reusing the request headers
  (`App-Platform`, `Spotify-App-Version`) matters: an outdated `Spotify-App-Version` can be rejected.
- Anonymous tokens are not sufficient for lyrics (observed: 400 with anon bearer). Do not build a path that
  silently runs on the anonymous token.
- CORS: from the content script (isolated world) the `spclient` origin must allow `https://open.spotify.com`
  (it does, `access-control-allow-origin: https://open.spotify.com` was observed on the 404) and you must
  send `credentials` for same-origin token calls; from the page context, use same-origin fetch for
  `/api/token` (cookies required).
- **productType/market**: the extension’s current `productType=web_player` on the lyrics URL is unverified;
  build the request from what the bundle actually sends (see §c.1).
- **Policy/ToS note for the operator:** the `/api/token` error body literally says usage is not permitted
  under Spotify’s Developer Terms; the 2026 client itself only works because it holds the session. Relying on
  the *user’s own* logged-in session via sniffing is materially different from minting tokens yourself; the
  latter is the fragile/legally-gray path.

### f.3 DOM scrape of native lyrics

Strengths: no network, no token, no ToS question; always text-accurate; gives the active line.

Risks:
- **No timings.** You get text + order (+ active line while the panel is open). Timing can only be
  reconstructed incrementally across real playback (record (line, position) pairs when the active marker
  moves). Cold-start UX is poor (first play has no timing); a pause at a line boundary biases timings.
- **Requires the native lyrics view open** — if the user closes it, scraping stops. The extension must detect
  the view and hint at opening it, and must not spam status.
- **Active line class is build-specific** (hashed). The unique-class heuristic above mitigates it; if Spotify
  changes the render (e.g. word spans appear), the heuristic degrades gracefully (no unique class → no
  active line, keep learned timings).
- **DOM churn:** lines re-render on track change and on translation toggle; translation text is in
  `children[1]` and can be mistaken for the lyric if you take the whole line `textContent` (join only the
  first child / skip the translation div when it exists).
- **Two prepended empty spacer lines** shift the index by 2; dedupe learned timings by normalized text and
  ordinal after removing empty lines.
- **Capped/unavailable accounts:** if Spotify returns no lyrics, the view shows a messaging line
  (`web-player.lyrics.noLyrics*`), not `lyrics-line` nodes; do not interpret absence of nodes as “empty
  track”.
- **Layout variants (UNVERIFIED):** the mini-player/PiP (`xpui-pip-mini-player`) and responsive compact
  layouts may not render the same testids; do not assume the player bar exists in every surface. If the
  user is on `open.spotify.com` in a narrow window, the bar markup was not tested here.

### f.4 General / cross-cutting

- **No track id ⇒ no cache key.** The cache must be keyed by (title, artist, album-hint) until a sniffed id
  arrives; migrate the entry when the id appears. Otherwise the same song on a different album would share a
  cache entry. Conversely, the album hint in the title anchor distinguishes releases.
- **Locale**: every aria-label is localized (live ja DOM proved it); never match English text. Use the icon
  paths for play/pause and testids for structure.
- **Testid drift**: everything in the table is a contract of this build. Keep selectors in one module with
  fallbacks and log which selector matched (the extension should be able to degrade rather than break).
- **Ads/podcasts**: `context-item-info-title` exists for ads too (`context-item-info-ad-title` variants),
  and the NPB renders `signup-bar` when logged out. Guard against treating an ad/podcast as a track (no
  `/track/` id in sniffs; lyrics will be unavailable anyway).
- **UNVERIFIED**: behavior with the `enableNowPlayingBarTraits` flag (v2 widget). Default is `false`
  (`tP` in main chunk: `default:!1`), so v1 is expected, but both were implemented in the lazy chunk; support
  both testids.

---

## (g) URLs attempted (status + size)

Full machine-readable list: `evidence/01-http-matrix.txt`. Key rows reproduced here (curl 8.7.1, desktop
Chrome 157 UA, `size_download` bytes):

### Pages / HTML (logged-out visitor)

| URL | status | bytes | note |
|---|---|---|---|
| `https://open.spotify.com/` | 200 | 168891 | full web-player shell, **logged out**; app boots, home page + player bar render |
| `https://open.spotify.com/intl-ja/` | 302 | 17 | locale redirect stub (curl -L lands on `/intl-ja/…`) |
| `https://open.spotify.com/login` | **404** | 4338 | no such route |
| `https://open.spotify.com/intl-ja/login` | **404** | 4338 | no such route |
| `https://open.spotify.com/download` | 200 | 168899 | the same web-player shell |
| `https://open.spotify.com/?nd=1` | 200 | 168891 | same shell |
| `https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp` | 200 | 169127 | track page (no lyrics in the HTML) |
| `https://open.spotify.com/lyrics/fullscreen` | **404** | 4350 | client-only route; no server page |
| `https://accounts.spotify.com/login` | 200 | 30015 | separate login app (Next.js) |

**Answer to “does open.spotify.com serve the player bundle to a logged-out visitor?”: YES.** The 168891-byte
shell is served without cookies and loads `web-player.73b73c08.js`, `vendor~web-player.5858da05.js`,
`encore~web-player.bde3d4f4.js`; the player bar renders (with a `signup-bar` inside). Playback, lyrics,
history and most data require login: clicking play anonymously does nothing (live-tested: the NPB stays
`-:--`, no `now-playing-widget` appears). The shell exposes no access token and no user data.

### Bundles / assets (all 200)

| URL | bytes |
|---|---|
| `https://open.spotifycdn.com/cdn/build/web-player/web-player.73b73c08.js` | 4542980 |
| `…/vendor~web-player.5858da05.js` | 1592046 |
| `…/encore~web-player.bde3d4f4.js` | 575290 |
| `…/web-player.9cf426b0.css` | 516101 |
| `…/dwp-now-playing-bar.0af8a902.js` (lazy) | 59352 |
| `…/8153.ab3c6bb5.js` (seek bar) | 53843 |
| `…/9398.22ff7630.js` (transport controls) | 22656 |
| `…/5424.16cb1d45.js` | 21697 |
| `…/4076.c8b69942.js` | 14972 |
| `…/6454.025fa50a.js` | 12141 |
| `…/1186.99674601.js` | 10991 |
| `https://open.spotifycdn.com/cdn/generated/manifest-web-player.1609946b.json` (PWA manifest) | 422 |
| `https://open.spotifycdn.com/cdn/generated-locales/web-player/en.d77c2d39.json` | 47552 (gzip transfer) |

### Token / auth endpoints

| URL | status | bytes | note |
|---|---|---|---|
| `https://open.spotify.com/get_access_token?reason=transport&productType=web_player` | **403** | 431 | Varnish “URL Blocked” (curl and browser fetch, anonymous) |
| `https://open.spotify.com/get_access_token` | **403** | 431 | same |
| `https://open.spotify.com/api/token` | **400** | 2586 | JSON `{"error":{"code":400,…"Unauthorized request"…}}` (no TOTP) |
| `https://open.spotify.com/api/token?reason=transport&productType=web-player` | **400** | 2586 | same |
| `https://open.spotify.com/api/token?reason=init&productType=web-player&totp=…&totpVer=61` (browser) | 200 | token JSON | captured live; token redacted in evidence |
| `https://open.spotify.com/api/server-time` | 200 | 25 | `{"serverTime":1793938844}` |
| `https://clienttoken.spotify.com/v1/clienttoken` (POST) | 200 | granted_token JSON | `client-token` source |
| `https://open.spotify.com/remote-config-resolver/v3/unauth/configuration` (POST) | 200 | config JSON | feature flags for anonymous |

### Lyrics / metadata data endpoints

| URL | status | bytes | note |
|---|---|---|---|
| `https://spclient.wg.spotify.com/color-lyrics/v2/track/{id}?format=json&market=from_token&vocalRemoval=false&productType=web_player` | **400** | 0 | anonymous bearer + client-token; tried 3 ids and several param sets |
| `https://spclient.wg.spotify.com/color-lyrics/v2/track/{id}/image/{image}` | 404 (empty image) | 0 | path shape only; valid image URL needed and a user token to test |
| `https://spclient.wg.spotify.com/metadata/4/track/{id}?market=from_token` | **404** | 0 | anonymous bearer |
| `https://api.spotify.com/v1/tracks/{id}?market=from_token` | **429** | 80 | `{"error":{"status":429,"message":"API rate limit exceeded"}}` |
| `https://spicylyrics.org/` | 200 | 8859 | Cloudflare challenge page; no app code fetched |

**Not attempted / UNVERIFIED:** any request with a real authenticated user session (no account available in
this environment), a real syllable-synced payload, the `/image/{imageUrl}` lyrics call with a valid image and
token, and the TTML path.

---

## Quick list — everything still UNVERIFIED

- Live DOM for any track-dependent node (`now-playing-widget`, title/artist/cover, `lyrics-line`, active
  line). Everything about them here is from the shipped bundles; no authenticated playback was available.
- The playing semantics of `[data-testid="playback-progressbar"] input[type="range"]` (`max` = duration ms,
  `value` = position ms). Element shape is live-verified; the values are from bundle logic.
- Synthetic seek via `PointerEvent` on the seek track (bundle logic verified; not executed against playback).
- Whether the content script can read `navigator.mediaSession.metadata` / `.playbackState` set by MAIN world.
- The cover `<img>` node inside `[data-testid="cover-art-button"]` (container is verified, child is inferred).
- The `/color-lyrics/v2/track/{id}/image/{imageUrl}` call with a real user token and image URL.
- The bare `/color-lyrics/v2/track/{id}` endpoint in this build (only third-party evidence; 400 with anon token).
- `productType=web_player` on lyrics (not observed anywhere) and `/get_access_token` with an authenticated session.
- The `syllables[]` element shape, `endTimeMs` semantics, `isBackground`/duet/`isRtl` markers, TTML format.
- Mini-player/PiP and narrow-window layouts (different chunk `xpui-pip-mini-player` exists).
- Whether `client-token` is required for spclient lyrics calls when using a user bearer token.

## Appendix — reproduction steps

1. `curl -A '<Chrome 157 UA>' https://open.spotify.com/ -o shell.html` — read the `<script src>` list and the
   base64 `appServerConfig` (see evidence 02).
2. Fetch the three initial bundles + `web-player.9cf426b0.css` from `open.spotifycdn.com`.
3. Extract lazy chunk map from the webpack runtime (`u.p`/`u.u` at the tail of `web-player.73b73c08.js`);
   resolve the ids used by `NowPlayingBar` (`1092, 8166, 6454, 1186, 8153, 5424, 9398, 4076, 3319`) — 3319 is
   `dwp-now-playing-bar`.
4. Grep the chunks for `data-testid` and for the lyrics/color-lyrics modules (offsets in the evidence files).
5. Launch Chrome headless with `--remote-debugging-port` and drive it over CDP with Node’s built-in
   `WebSocket` (no npm deps needed): navigate to open.spotify.com, `Runtime.evaluate` the DOM queries, read
   `Network.*` events for the token calls, screenshot.
6. For playback-dependent nodes: log in manually in a real profile, play a track, open the native lyrics
   view, then repeat the same CDP queries. That is the one missing capture needed to promote the
   “medium/UNVERIFIED” rows in §a to high.
