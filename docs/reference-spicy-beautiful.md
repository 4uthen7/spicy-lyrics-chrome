# Reference: Spicy Lyrics and Beautiful Lyrics (upstream sources)

The desktop experience this extension copies comes from two open-source Spicetify
extensions. Their sources are the reference for timings and visual constants.

Note about the local machine: Spicetify 2.42.7 is installed (`~/.config/spicetify`),
but the applied extension set is only `escapeToHome.js`. Neither Spicy Lyrics nor
Beautiful Lyrics is present in `~/.config/spicetify/Extensions` or in the patched
`Spotify.app/Contents/Resources/Apps/xpui/extensions`, so the reference used here
is the upstream repositories, not a local install:

- https://github.com/Spikerko/spicy-lyrics
- https://github.com/surfbryce/beautiful-lyrics

## What was ported

### Karaoke sweep (Spicy Lyrics `src/css/Lyrics/Mixed.css`)

- Refreshed simple sweep: a gradient twice the word width plus a fade band is slid
  across each word by `background-position`, so the sung edge is a soft moving fade
  instead of a hard cut. Spicy uses `--SLM_GradientPosition` mapped from -50% to
  100%; this extension maps `--p` (0..1) to `0%..100%` on the same construction.
- Alpha values: Spicy `--gradient-alpha: 0.85`, `--gradient-alpha-end: 0.5`; simple
  mode `1` / `0.3` with a wider fade. This extension uses `.94/.5` (cinema) and
  `1/.34` (simple) with a `0.5em` fade in simple mode.
- Active line gradient and per-word gradient are separate elements in Spicy; this
  extension paints per-word (`.sl-w`) and per-line-text (`.sl-t`).

### Syllable motion (Spicy Lyrics `src/utils/Lyrics/Animator/Lyrics/LyricsAnimator.ts`)

Spline ranges used by Spicy and reproduced here as smooth curves:

- `ScaleRange`: 0.95 -> 1.0505 at t=0.7 -> 1
- `LetterScaleRange`: 0.95 -> 1.175 (word emphasis variant, not used)
- `YOffsetRange`: 0.01em -> -1/60em at t=0.9 -> 0
- `GlowRange`: 0 -> 1 at t=0.15, hold to 0.6, -> 0 at t=1
- `preHiddenDotLineMs = 500`, `BlurMultiplier = 1.25`

This extension applies the same curves per word in `src/content/ui/lyrics-view.js`
(`wordAnimation`, `setWordAnimation`), writing `--ws`, `--wy`, `--wb`, `--wo`.

### Line focus timing

- Spicy: active line `transition: opacity 0.2s cubic-bezier(0.61, 1, 0.88, 1)`.
- Beautiful Lyrics: vocal state opacity 0.51 idle / 1 active / 0.497 sung, with
  `transition: color 0.1s, transform 0.1s`; blur distance capped at 4 lines with
  `BlurScale = 1.25` (max ~5px).
- This extension previously used 0.5s transitions, which read as "the next line
  takes a moment to start". Now: opacity 0.18s, blur 0.2s, row transform 0.34s,
  and the scroll spring raises K from 168 to 232 (settle ~300ms) instead of ~500ms.

### Scroll target

- Beautiful Lyrics centers the active vocal with `scroll-behavior: smooth`, offset
  by one `line-height` when `--use-offset: 1`.
- Spicy Lyrics `ScrollIntoCenterView`: 800ms custom easing with a slight 3%
  overshoot; newer renderer is a virtualizer with the active line centered.
- This extension keeps a spring on the 42% anchor (Spicy desktop places the active
  line above center; flow mode interpolates between line anchors).

### Not ported

- Romanization (`kuroshiro` + `franc-all` in Spicy; Pinyin data in Beautiful) needs
  multi-MB dictionaries. The renderer already accepts `line.romanized`; a dictionary
  would be a separate bundle decision.
- Video/NPV layouts, Spotify-internal color themes, canvas backgrounds (Spicy uses
  `@kawarp/core`), custom fonts (`BeautifulLyrics` webfont), and the settings UI
  structure are out of scope for the Chrome port.

## Sync notes

Both desktop extensions read the position directly from Spicetify's player API,
which is a continuous clock. The Chrome port only has DOM readings, so it adds the
logic described in the README (monotonic clock, native lyric line anchors, exact
media-element clock when present). Line transitions are anchored to Spotify's own
lyric highlight where available, which removes the quantised seek-bar delay.
