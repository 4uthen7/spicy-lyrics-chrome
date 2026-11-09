/**
 * Spotify web player observer.
 *
 * The content script cannot read Spotify's internal player state, so this module
 * polls and observes the player bar DOM and re-bases `SL.store`:
 *
 *   - track identity/title/artist/album/cover from the now-playing widget
 *   - duration + position from the progress bar / time labels
 *   - play state from the play/pause button label, with a position-delta
 *     fallback for localised or unfamiliar labels
 *   - native lyrics panel open/closed for the acquisition fallback
 *
 * A 250 ms interval is the backbone; a MutationObserver only schedules an extra
 * poll (throttled) so control interactions feel instant. Everything is looked
 * up through SELECTORS on every poll, so a re-rendered player bar is picked up
 * automatically and a recon-found selector fix is a one-line change.
 *
 * Selectors reflect the recon evidence in docs/evidence/04-live-dom.txt and
 * 03-testid-inventory.txt (shipped build, logged-out player bar):
 *   - position/duration come from the HIDDEN range input inside
 *     div[data-testid="playback-progressbar"]; value/max are milliseconds and
 *     max is only meaningful once a track is loaded;
 *   - the visual progress is div[data-testid="progress-bar"] with a
 *     `--progress-bar-transform: NN%` inline style;
 *   - play/pause labels are localised, so the SVG glyph is used as a fallback;
 *   - the collapsed player bar does not expose the track id in an href
 *     (context-item-link points at the ALBUM for tracks), so ids are resolved
 *     from an internal track link or the track page when the titles match; the
 *     lyrics resolver can also adopt an id from a sniffed color-lyrics URL.
 *
 * UNVERIFIED: exact behaviour of real Spotify's seek handlers (the demo shape is
 * verified), and whether the page-URL track-id heuristic survives every layout.
 */
(function () {
  'use strict';
  const SL = (globalThis.SL = globalThis.SL || {});
  if (SL.player) return;
  const util = SL.util;
  const store = SL.store;

  const POLL_MS = 250;
  const MUTATION_THROTTLE_MS = 150;
  const SEEK_JITTER_MS = 350;
  
  /**
   * Adjustable selector table: ordered candidates, most specific first. Every
   * Spotify-specific string in this module lives here, so a recon fix is a
   * one-line change.
   */
  const SELECTORS = {
    playerBar: [
      '[data-testid="now-playing-bar"]',
      '[data-testid="player-bar"]',
      'footer[data-testid="now-playing-bar"]',
    ],
    nowPlaying: [
      '[data-testid="now-playing-widget"]',
      '[data-testid="now-playing-widget-v2"]',
      '[data-testid="nowplaying-bar"]',
    ],
    /** Hrefs that carry a real /track/<id> (the player bar itself may not). */
    trackLink: [
      '[data-testid="now-playing-widget"] a[href*="/track/"]',
      '[data-testid="now-playing-widget-v2"] a[href*="/track/"]',
      '[data-testid="context-item-link"][href*="/track/"]',
      '[data-testid="nowplaying-track-link"]',
      'footer a[href*="/track/"]',
    ],
    trackLinkInternal: [
      '[data-testid="now-playing-bar"] [data-testid="internal-track-link"][href*="/track/"]',
      '[data-testid="now-playing-widget"] [data-testid="internal-track-link"][href*="/track/"]',
      '[data-testid="now-playing-widget-v2"] [data-testid="internal-track-link"][href*="/track/"]',
    ],
    title: [
      '[data-testid="context-item-info-title"] a',
      '[data-testid="context-item-info-title"]',
      '[data-testid="context-item-link"]',
      '[data-testid="nowplaying-track-link"]',
    ],
    subtitleLinks: [
      '[data-testid="context-item-info-subtitles"] a',
      '[data-testid="context-item-info-artist"]',
      '[data-testid="context-item-info-album"]',
      '[data-testid="context-item-info-subtitles"]',
    ],
    cover: [
      '[data-testid="cover-art-button"] img',
      '[data-testid="cover-art-container"] img',
      '[data-testid="cover-art-image"] img',
      'img[data-testid="cover-art-image"]',
      '[data-testid="cover-art-image"]',
      '[data-testid="CoverSlotCollapsed__container"] img',
      '[data-testid="now-playing-widget"] img',
      '[data-testid="now-playing-widget-v2"] img',
      '[data-testid="now-playing-bar"] img',
    ],
    playPause: [
      '[data-testid="control-button-playpause"]',
      'button[data-testid="control-button-playpause"]',
      'button[aria-label="Play"]',
      'button[aria-label="Pause"]',
    ],
    /** Current build: wrapper contains the hidden range input + visual bar. */
    playbackProgressbar: [
      '[data-testid="playback-progressbar"]',
    ],
    /** Primary position/duration source on the current build (ms value/max). */
    rangeInput: [
      '[data-testid="playback-progressbar"] input[type="range"]',
      '[data-testid="now-playing-bar"] input[type="range"][max]',
    ],
    /** Visual progress bar; carries --progress-bar-transform: NN%. */
    progressBar: [
      '[data-testid="playback-progressbar"] [data-testid="progress-bar"]',
      '[data-testid="progress-bar"]',
      '[data-testid="playback-progressbar"]',
      '[data-testid="playback-bar"] [role="slider"]',
      '[data-testid="now-playing-bar"] [role="slider"][aria-valuenow]',
    ],
    /** Older builds / demo harness: div[role=slider] with aria-valuenow. */
    progressSlider: [
      '[data-testid="progress-bar"][role="slider"]',
      '[data-testid="progress-bar"] [role="slider"]',
      '[role="slider"][aria-valuenow]',
      '[data-testid="progress-bar"]',
    ],
    positionText: [
      '[data-testid="playback-position"]',
      '[data-testid="playback-progressbar"] [data-testid="playback-position"]',
    ],
    durationText: [
      '[data-testid="playback-duration"]',
      '[data-testid="playback-progressbar"] [data-testid="playback-duration"]',
    ],
    lyricsButton: [
      '[data-testid="lyrics-button"]',
      'button[aria-label*="lyric" i]',
    ],
    /** Any match means the native lyrics view is on screen. */
    nativeLyrics: [
      '[data-testid="lyrics-line"]',
      '[data-testid="read-along-scroll-container"]',
      '[data-testid="fullscreen-lyric"]',
      '[data-testid="lyrics-container"]',
      '[data-testid="fullscreen-lyrics"]',
      '[data-testid="lyrics-page"]',
      '[data-testid="lyrics-button"][aria-pressed="true"]',
      'button[data-testid="lyrics-button"][aria-pressed="true"]',
    ],
  };

  const PAUSE_LABELS = /pause|pausa|pausar|pausieren|sospendi|pauzeren|wstrzymaj|пауза|一時停止|일시정지|暫停|暂停|duraklat|pauze|pausa|pauss/i;
  const PLAY_LABELS = /play|reproducir|lecture|wiedergabe|riproduci|afspelen|odtwórz|воспроизвести|再生|재생|播放|تشغيل|spela|toista|spil|afspil/i;

  let started = false;
  let pollTimer = 0;
  let anchorTimer = 0;
  let mutationTimer = 0;
  let observer = null;
  let lastTrackSignature = '';
  let lastRawPosition = null;
  let lastAdvanceAt = 0;
  let lastPlaying = false;
  let lastNativeOpen = null;

  /**
   * Diagnostics ring buffer. The player bar markup differs between Spotify
   * builds (v1 widget vs the flagged v2 widget) and some users get a build
   * where the documented testids are absent, so the popup can ask for a report
   * instead of guessing. Read through SL.player.diagnostics().
   */
  const diag = {
    polls: 0,
    lastOkAt: 0,
    lastError: null,
    errors: [],
    lastTrackRead: null,
    lastMedia: null,
    /** Rolling playback-clock observations, newest last (see diagnostics()). */
    clockSamples: [],
    domSteps: [],
    rate: 1,
    seeks: 0,
    anchors: 0,
    lastDomValue: null,
    nativeLineKey: null,
    lastEarlyKey: null,
  };

  /** Jump beyond this is a real seek (or a badly desynced clock), not jitter. */
  const HARD_JUMP_MS = 1500;
  /** Within this the interpolated clock is considered aligned; no rate change. */
  const ALIGN_DEADBAND_MS = 70;
  /** Max clock rate correction used to converge on the DOM without stepping back. */
  const MAX_RATE_TRIM = 0.08;

  function noteClock(domMs, predictedBefore, afterMs, error, rate, precise) {
    diag.clockSamples.push({
      src: diag.clockSource || 'dom',
      at: Date.now(),
      dom: Math.round(domMs),
      before: Math.round(predictedBefore),
      after: Math.round(afterMs),
      error: Math.round(error),
      rate: Number(rate.toFixed(3)),
      precise: !!precise,
    });
    if (diag.clockSamples.length > 16) diag.clockSamples.shift();
    diag.rate = rate;
  }

  function noteDomStep(domMs) {
    const prev = diag.domSteps[diag.domSteps.length - 1];
    if (!prev) {
      diag.domSteps.push({ at: Date.now(), dom: Math.round(domMs), step: 0 });
      return;
    }
    diag.domSteps.push({ at: Date.now(), dom: Math.round(domMs), step: Math.round(domMs - prev.dom) });
    if (diag.domSteps.length > 16) diag.domSteps.shift();
  }

  function noteError(err) {
    diag.lastError = String((err && err.stack) || err);
    diag.errors.push({ at: Date.now(), message: String((err && err.message) || err) });
    if (diag.errors.length > 8) diag.errors.shift();
  }
  let seekSeqSeen = 0;

  function scopeOf(root) {
    return root && typeof root.querySelectorAll === 'function' ? root : typeof document !== 'undefined' ? document : null;
  }

  function pick(selectors, root) {
    const scope = scopeOf(root);
    if (!scope) return null;
    for (const selector of selectors) {
      try {
        const element = scope.querySelector(selector);
        if (element) return element;
      } catch {
        /* invalid selector candidate: ignore */
      }
    }
    return null;
  }

  function pickAll(selectors, root) {
    const scope = scopeOf(root);
    if (!scope) return [];
    const seen = new Set();
    const out = [];
    for (const selector of selectors) {
      try {
        const list = scope.querySelectorAll(selector);
        for (const element of Array.from(list)) {
          if (!seen.has(element)) {
            seen.add(element);
            out.push(element);
          }
        }
      } catch {
        /* invalid selector candidate: ignore */
      }
    }
    return out;
  }

  function parseClock(value) {
    try {
      return util.parseClock(value);
    } catch {
      return null;
    }
  }

  /**
   * The current build renders a visually-hidden range input inside the seek
   * bar; value/max are milliseconds (UNVERIFIED for a playing track, but the
   * live idle DOM and the SeekBar bundle both use ms).
   */
  function readRangeInput(scope) {
    const input = pick(SELECTORS.rangeInput, scope);
    if (!input) return null;
    const attr = (name) => {
      try {
        return input.getAttribute ? input.getAttribute(name) : null;
      } catch {
        return null;
      }
    };
    const max = Number(attr('max'));
    let value = Number(attr('value'));
    try {
      if (input.type === 'range' && input.value !== '') value = Number(input.value);
    } catch {
      /* ignore */
    }
    return {
      input,
      max: isFinite(max) ? max : null,
      value: isFinite(value) ? value : null,
      ariaValueText: attr('aria-valuetext') || '',
    };
  }

  /** Parses "1:23/3:40" and "-:--/-:--" style aria-valuetext. */
  function parseAriaValueText(valueText) {
    if (!valueText) return null;
    const match = /^\s*([^/]*?)\s*\/\s*([^/]*?)\s*$/.exec(valueText);
    if (!match) return null;
    const positionMs = parseClock(match[1]);
    const durationMs = parseClock(match[2]);
    if (positionMs == null && durationMs == null) return null;
    return { positionMs, durationMs };
  }

  /** Visual seek-bar percentage from --progress-bar-transform: NN%. */
  function readTransformPercent() {
    const bar = pick(SELECTORS.progressBar);
    if (!bar) return null;
    const style = (bar.getAttribute && bar.getAttribute('style')) || '';
    const match = /--progress-bar-transform\s*:\s*(-?\d+(?:\.\d+)?)%/.exec(style);
    if (!match) return null;
    const percent = Number(match[1]);
    return isFinite(percent) ? util.clamp(percent, 0, 100) / 100 : null;
  }

  /** Duration: range max (authoritative when > 0) -> duration text -> slider. */
  function readDurationMs(scope) {
    const range = readRangeInput(scope);
    if (range && range.max > 0) return Math.round(range.max);

    const durationElement = pick(SELECTORS.durationText, scope);
    const textDuration = durationElement ? parseClock(durationElement.textContent) : null;
    if (textDuration && textDuration > 0) return textDuration;

    const slider = pick(SELECTORS.progressSlider, scope);
    if (slider) {
      const rawMax = Number(slider.getAttribute && slider.getAttribute('aria-valuemax'));
      if (isFinite(rawMax) && rawMax > 0) {
        const state = store.get();
        const known = state.track && state.track.durationMs;
        if (known > 0) {
          if (Math.abs(rawMax - known) <= Math.max(2, known * 0.15)) return Math.round(rawMax);
          if (Math.abs(rawMax - known / 1000) <= Math.max(2, (known / 1000) * 0.15)) return Math.round(rawMax * 1000);
        }
        return rawMax > 3600 ? Math.round(rawMax) : Math.round(rawMax * 1000);
      }
    }
    return 0;
  }

  /** Largest candidate from an <img srcset>, else currentSrc/src. */
  function readCoverUrl(widget) {
    let image = pick(SELECTORS.cover, widget) || pick(SELECTORS.cover);
    if (!image && widget && widget !== document && typeof widget.querySelector === 'function') {
      // This build has no cover-art-image testid; the cover is a plain <img>
      // inside the cover-art button / now-playing widget.
      try {
        image = widget.querySelector('img');
      } catch {
        image = null;
      }
    }
    if (!image) return '';
    let best = '';
    let bestWidth = -1;
    const candidates = [image];
    try {
      if (typeof image.querySelectorAll === 'function') candidates.push(...Array.from(image.querySelectorAll('img')));
    } catch {
      /* ignore */
    }
    for (const candidate of candidates) {
      const srcset = candidate.getAttribute && candidate.getAttribute('srcset');
      if (srcset) {
        for (const part of srcset.split(',')) {
          const widthMatch = /^\s*(\S+)\s+(\d+)(?:w|W)\s*$/.exec(part);
          const densityMatch = /^\s*(\S+)\s+(\d+(?:\.\d+)?)x\s*$/.exec(part);
          const bareMatch = /^\s*(\S+)\s*$/.exec(part);
          let score = -1;
          let url = '';
          if (widthMatch) {
            url = widthMatch[1];
            score = Number(widthMatch[2]);
          } else if (densityMatch) {
            // Density descriptors cannot be compared to width descriptors
            // numerically; treat 1x..3x as "smaller than any real width".
            url = densityMatch[1];
            score = Number(densityMatch[2]) * 10;
          } else if (bareMatch) {
            url = bareMatch[1];
            score = 0;
          }
          if (url && score > bestWidth) {
            bestWidth = score;
            best = url;
          }
        }
      }
      const direct = (candidate.currentSrc || (candidate.getAttribute && candidate.getAttribute('src')) || '').trim();
      if (direct && bestWidth < 0) best = direct;
    }
    if (!best && image) {
      const style = image.getAttribute && image.getAttribute('style');
      if (style) {
        const match = /url\(["']?(.*?)["']?\)/.exec(style);
        if (match) best = match[1];
      }
    }
    return best || '';
  }

  /**
   * Stable synthetic identity for builds that do not expose the track id in the
   * player-bar DOM. `track.id` stays null until a sniffed spclient URL supplies
   * the real id; everything cache/resolver-side keys on id || key.
   */
  function hash32(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  function extractTrackId(href) {
    if (!href) return null;
    const match = /\/track\/([A-Za-z0-9]{1,64})/.exec(String(href));
    return match ? match[1] : null;
  }


  /**
   * Track metadata from the MediaSession API.
   *
   * The web player assigns `navigator.mediaSession.metadata` on every playback
   * update (verified in the shipped bundle: web-player.73b73c08.js calls
   * `new MediaMetadata({title, artist, album, artwork})`). This works even when
   * the player-bar DOM uses a widget variant whose title testids differ, and it
   * is language-independent (unlike aria-labels).
   */
  function pickLargestArtwork(artwork) {
    if (!Array.isArray(artwork) || !artwork.length) return '';
    let best = '';
    let bestArea = -1;
    for (const entry of artwork) {
      if (!entry || !entry.src) continue;
      const sizes = String(entry.sizes || '');
      let area = 0;
      for (const size of sizes.split(/\s+/)) {
        const match = /^(\d+)x(\d+)$/.exec(size);
        if (match) area = Math.max(area, Number(match[1]) * Number(match[2]));
        else if (size === 'any') area = Math.max(area, 1e9);
      }
      if (area > bestArea) {
        bestArea = area;
        best = entry.src;
      }
    }
    return best;
  }

  function readMediaSession() {
    try {
      const session = typeof navigator !== 'undefined' ? navigator.mediaSession : null;
      if (!session) return null;
      const meta = session.metadata || null;
      const artwork = meta && meta.artwork ? pickLargestArtwork(meta.artwork) : '';
      const playbackState = typeof session.playbackState === 'string' ? session.playbackState : null;
      return {
        supported: true,
        playbackState,
        title: util.cleanText(meta && meta.title ? meta.title : ''),
        artist: util.cleanText(meta && meta.artist ? meta.artist : ''),
        album: util.cleanText(meta && meta.album ? meta.album : ''),
        artwork,
      };
    } catch (err) {
      return null;
    }
  }

  const SHELL_TITLES = /^(spotify\b|web player|music for everyone|spotify - web player)/i;

  /**
   * Last-resort track text from document.title. The SPA writes
   * "Song - song by Artist | Spotify" (or a localized variant); the shell page
   * title must not be mistaken for a track.
   */
  function readDocumentTitle() {
    try {
      const raw = (typeof document !== 'undefined' && document.title) || '';
      if (!raw) return null;
      const cleaned = raw.replace(/\s*[|·•]\s*Spotify\s*$/i, '').trim();
      if (!cleaned || SHELL_TITLES.test(cleaned)) return null;
      const named = /^(.*?)\s+(?:[-–—·•])\s+(?:song by|by)\s+(.+)$/i.exec(cleaned);
      if (named) {
        return { title: util.cleanText(named[1]), artist: util.cleanText(named[2]) };
      }
      const parts = cleaned.split(/\s+[-–—·•]\s+/);
      if (parts.length === 2 && parts[0] && parts[1]) {
        return { title: util.cleanText(parts[0]), artist: util.cleanText(parts[1]) };
      }
      return { title: cleaned, artist: '' };
    } catch (err) {
      return null;
    }
  }

  /** Visible line breaks inside the now-playing widget (works for both widgets). */
  function readWidgetLines(widget) {
    if (!widget || widget === (typeof document !== 'undefined' ? document : null)) return [];
    try {
      const text = widget.innerText || widget.textContent || '';
      return text
        .split(/\n+/)
        .map((line) => util.cleanText(line))
        .filter(Boolean);
    } catch (err) {
      return [];
    }
  }

  function readTrack() {
    const bar = pick(SELECTORS.playerBar);
    const widget = pick(SELECTORS.nowPlaying, bar);
    // Broadest scope for DOM lookups; widget-only scope is used for text lines
    // so document text is never mistaken for a track.
    const scope = widget || bar || (typeof document !== 'undefined' ? document : null);
    const media = readMediaSession();
    const mediaLines = media ? [media.title, media.artist].filter(Boolean) : [];
    const widgetLines = readWidgetLines(widget);
    diag.lastMedia = media;

    const link = pick(SELECTORS.trackLink, scope);
    const href = (link && link.getAttribute && link.getAttribute('href')) || '';

    // Most builds do not expose the id here; keep the href path for others.
    let id = extractTrackId(href);
    if (!id) {
      const internal = pick(SELECTORS.trackLinkInternal, widget) || pick(SELECTORS.trackLinkInternal, bar || widget);
      const internalHref = (internal && internal.getAttribute && internal.getAttribute('href')) || '';
      id = extractTrackId(internalHref);
    }

    const titleElement = pick(SELECTORS.title, scope);
    let title = titleElement && titleElement.textContent ? util.cleanText(titleElement.textContent) : '';
    if (!title && link && link.textContent) title = util.cleanText(link.textContent);
    // v2 widget / redesign: no title testid, so fall back to the widget's own
    // visible lines, then MediaSession, then document.title.
    if (!title && widgetLines.length) title = widgetLines[0];
    if (!title && media && media.title) title = media.title;
    if (!title) {
      const fromDocument = readDocumentTitle();
      if (fromDocument && fromDocument.title) title = fromDocument.title;
    }

    let artist = '';
    let album = '';
    const arts = [];
    const subtitleElements = pickAll(SELECTORS.subtitleLinks, scope);
    for (const element of subtitleElements) {
      const text = util.cleanText(element.textContent || '');
      if (!text) continue;
      // A subtitle wrapper that contains links is not itself a metadata value;
      // its textContent would concatenate every artist name.
      if (typeof element.querySelector === 'function' && element.querySelector('a[href]')) continue;
      const elementHref = (element.getAttribute && element.getAttribute('href')) || '';
      if (/\/artist\//.test(elementHref)) {
        arts.push(text);
        artist = arts.join(', ');
      } else if (/\/album\//.test(elementHref)) {
        album = album ? album + ', ' + text : text;
      } else if (!artist) {
        // No href classification available: first subtitle is the artist.
        artist = text;
        arts.push(text);
      } else if (!album) {
        album = text;
      }
    }

    // The title anchor's href is the ALBUM path for tracks in this build; it is
    // a useful album hint for the synthetic identity and for cache separation.
    const albumHref = (link && link.getAttribute && link.getAttribute('href')) || '';

    // Fallbacks when the widget hides the subtitle block entirely.
    if (!artist) {
      const artistAnchors = widget ? widget.querySelectorAll('a[href*="/artist/"]') : [];
      for (const anchor of artistAnchors) {
        const text = util.cleanText(anchor.textContent || '');
        if (text) arts.push(text);
      }
      if (arts.length) artist = arts.join(', ');
      else if (widgetLines.length > 1) artist = widgetLines[1];
      else if (media && media.artist) artist = media.artist;
      else {
        const fromDocument = readDocumentTitle();
        if (fromDocument && fromDocument.artist) artist = fromDocument.artist;
      }
    }
    if (!album && media && media.album) album = media.album;

    // Some layouts repeat the artist list in a second, href-less subtitle node.
    if (album && album.replace(/\s+/g, '') === artist.replace(/\s+/g, '')) album = '';

    // Synthetic identity is computed after every metadata fallback, so a build
    // that only surfaces MediaSession data still keys the track consistently.
    const keyParts = [title, artist, album, albumHref].join('|');
    const key = title ? 'np:' + hash32(keyParts) : null;

    const durationMs = readDurationMs(bar || widget || scope);
    const coverUrl = readCoverUrl(widget || scope) || (media && media.artwork) || '';

    const result = {
      id,
      key,
      albumHref,
      uri: id ? 'spotify:track:' + id : null,
      title,
      artist,
      album,
      coverUrl,
      durationMs,
      trackUrl: id ? 'https://open.spotify.com/track/' + id : null,
    };
    diag.lastTrackRead = {
      title,
      artist,
      album,
      hasWidget: !!widget,
      hasPlayerBar: !!bar,
      hasTitleElement: !!titleElement,
      widgetLines: widgetLines.slice(0, 4),
      mediaSession: media ? { title: media.title, artist: media.artist, artwork: !!media.artwork, playbackState: media.playbackState } : null,
      documentTitle: (typeof document !== 'undefined' && document.title) || '',
      coverFrom: coverUrl && media && coverUrl === media.artwork ? 'mediaSession' : coverUrl ? 'dom' : 'none',
    };
    return result;
  }

  // Icon paths are locale-independent (evidence/10-playpause-icons.txt).
  const PAUSE_PATHS = ['M2.7 1a.7.7', 'M5.7 3a'];
  const PLAY_PATHS = ['M3 1.713a.7.7', 'm7.05 3.606'];

  function readPlayingFromIcon(button) {
    if (!button || typeof button.querySelector !== 'function') return null;
    let path = null;
    try {
      path = button.querySelector('svg path');
    } catch {
      path = null;
    }
    const d = (path && path.getAttribute && path.getAttribute('d')) || '';
    if (!d) return null;
    for (const prefix of PAUSE_PATHS) {
      if (d.startsWith(prefix)) return true;
    }
    for (const prefix of PLAY_PATHS) {
      if (d.startsWith(prefix)) return false;
    }
    return null;
  }

  function readPlayLabel() {
    const button = pick(SELECTORS.playPause);
    if (!button) return null;
    // SVG glyph first: aria-label is localised ("一時停止" was captured live).
    const iconPlaying = readPlayingFromIcon(button);
    if (iconPlaying != null) return iconPlaying;
    const label = (button.getAttribute && (button.getAttribute('aria-label') || button.getAttribute('title'))) || '';
    if (PAUSE_LABELS.test(label)) return true;
    if (PLAY_LABELS.test(label)) return false;
    return null;
  }

  /**
   * Exact playback clock from an attached media element.
   *
   * The web player pipes playback through an audio element (it calls
   * createMediaElementSource in the shipped bundle), and video content uses a
   * <video>. When such an element is in the DOM, `currentTime` is a continuous,
   * millisecond-accurate clock that beats the quantised seek bar. Guards keep
   * us from grabbing the wrong element: it must not loop, its duration must
   * match the track, and its position must agree with the DOM reading.
   *
   * UNVERIFIED: whether the playback element is attached to the document in
   * every build; when it is not, the seek-bar path is used.
   */
  function readMediaClock(knownDurationMs, referencePositionMs) {
    if (typeof document === 'undefined') return null;
    const nodes = document.querySelectorAll('audio, video');
    let best = null;
    for (const el of nodes) {
      try {
        if (!el.isConnected || el.loop) continue;
        const duration = Number(el.duration);
        if (!isFinite(duration) || duration <= 1) continue;
        if (knownDurationMs > 0) {
          const tolerance = Math.max(2000, knownDurationMs * 0.04);
          if (Math.abs(duration * 1000 - knownDurationMs) > tolerance) continue;
        }
        const position = Number(el.currentTime);
        if (!isFinite(position) || position < 0 || position > duration + 0.5) continue;
        if (referencePositionMs != null && Math.abs(position * 1000 - referencePositionMs) > 3000) continue;
        const score = (el.paused ? 0 : 2) + (el.readyState >= 2 ? 1 : 0);
        if (!best || score > best.score) {
          best = {
            score,
            positionMs: Math.round(position * 1000),
            durationMs: Math.round(duration * 1000),
            precise: true,
            source: 'media',
          };
        }
      } catch (err) {
        /* a detached or cross-origin element can throw on duration access */
      }
    }
    return best ? { positionMs: best.positionMs, durationMs: best.durationMs, precise: true, source: 'media' } : null;
  }

  /**
   * Position/duration sources, in the order the shipped build prefers:
   *   1. hidden range input inside the seek bar (value/max in ms)
   *   2. its aria-valuetext ("m:ss/m:ss")
   *   3. visible playback-position / playback-duration text
   *   4. --progress-bar-transform percent (visual fallback)
   *   5. older div[role=slider] aria-valuenow builds / demo harness
   * Returns `{positionMs, precise, durationMs}` or null.
   */
  function readPosition(knownDurationMs) {
    let durationMs = knownDurationMs > 0 ? knownDurationMs : 0;

    // 1. current build: hidden range input (only meaningful when max > 0).
    const range = readRangeInput();
    if (range && range.max > 0) {
      durationMs = Math.round(range.max);
      const position = util.clamp(range.value != null ? range.value : 0, 0, range.max);
      return { positionMs: Math.round(position), precise: true, durationMs };
    }

    // 2. same input's accessible text.
    if (range) {
      const fromText = parseAriaValueText(range.ariaValueText);
      if (fromText && fromText.positionMs != null && fromText.durationMs > 0) {
        return { positionMs: fromText.positionMs, precise: false, durationMs: fromText.durationMs };
      }
    }

    // 3. visible clock text.
    const positionElement = pick(SELECTORS.positionText);
    const durationElement = pick(SELECTORS.durationText);
    const textPosition = positionElement ? parseClock(positionElement.textContent) : null;
    const textDuration = durationElement ? parseClock(durationElement.textContent) : null;
    if (!durationMs && textDuration && textDuration > 0) durationMs = textDuration;
    if (textPosition != null) return { positionMs: textPosition, precise: false, durationMs };

    // 4. visual percentage.
    const percent = readTransformPercent();
    if (percent != null && durationMs > 0) {
      return { positionMs: Math.round(percent * durationMs), precise: false, durationMs };
    }

    // 5. older slider builds / demo harness.
    const slider = pick(SELECTORS.progressSlider);
    if (slider) {
      let scale = 1;
      const rawMax = Number(slider.getAttribute && slider.getAttribute('aria-valuemax'));
      if (isFinite(rawMax) && rawMax > 0) {
        if (durationMs > 0) {
          if (Math.abs(rawMax - durationMs) <= Math.max(2, durationMs * 0.15)) scale = 1;
          else if (Math.abs(rawMax - durationMs / 1000) <= Math.max(2, (durationMs / 1000) * 0.15)) scale = 1000;
          else scale = rawMax > 3600 ? 1 : 1000;
        } else {
          scale = rawMax > 3600 ? 1 : 1000;
        }
        if (!durationMs) durationMs = Math.round(rawMax * scale);
      }
      const rawNow = Number(slider.getAttribute && slider.getAttribute('aria-valuenow'));
      if (isFinite(rawNow) && rawNow >= 0) {
        return { positionMs: rawNow * scale, precise: true, durationMs };
      }
    }

    return null;
  }

  /** An element that is actually laid out (hidden containers do not count). */
  function isLaidOut(element) {
    if (!element || !element.isConnected) return false;
    try {
      if (typeof element.checkVisibility === 'function' &&
          !element.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) {
        return false;
      }
    } catch {
      /* fall through to rects */
    }
    try {
      return typeof element.getClientRects === 'function' && element.getClientRects().length > 0;
    } catch {
      return false;
    }
  }

  function isNativeLyricsOpen() {
    if (typeof document === 'undefined') return false;
    for (const selector of SELECTORS.nativeLyrics) {
      let elements;
      try {
        elements = document.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const element of elements) {
        // The page can keep a hidden lyrics container mounted (demo harness and
        // some SPA states); only a laid-out view means "lyrics view is open".
        if (isLaidOut(element)) return true;
      }
    }
    return false;
  }

  function resolvePlaying(labelPlaying, rawPosition) {
    if (labelPlaying != null) {
      lastPlaying = labelPlaying;
      return labelPlaying;
    }
    const now = Date.now();
    if (rawPosition != null) {
      if (lastRawPosition == null) {
        lastRawPosition = rawPosition;
        lastAdvanceAt = now;
        return lastPlaying;
      }
      const delta = rawPosition - lastRawPosition;
      if (delta > 20) {
        lastRawPosition = rawPosition;
        lastAdvanceAt = now;
        lastPlaying = true;
        return true;
      }
      if (delta < -SEEK_JITTER_MS * 2) {
        // A big backward jump while paused means a seek, not a pause transition.
        lastRawPosition = rawPosition;
        lastAdvanceAt = now;
        return lastPlaying;
      }
      if (rawPosition !== lastRawPosition) lastRawPosition = rawPosition;
      if (lastPlaying && now - lastAdvanceAt > 1500) {
        // Position has been pinned for >1.5s: treat as paused.
        lastPlaying = false;
      }
      return lastPlaying;
    }
    return lastPlaying;
  }

  /**
   * The native lyrics view highlights its own active line from Spotify's
   * internal, un-quantised playback position. While that view exists behind the
   * overlay it is a free, high-quality sync anchor: when Spotify moves to a new
   * line we know playback has just crossed that line's start time, so the
   * extension clock can be pulled forward instead of waiting for the coarse
   * seek bar to catch up. This is what stops line changes from running late and
   * the drift that accumulates from them.
   */
  function nativeActiveLine() {
    if (typeof document === 'undefined') return null;
    let nodes;
    try {
      nodes = document.querySelectorAll('[data-testid="lyrics-line"]');
    } catch (err) {
      return null;
    }
    if (!nodes.length) return null;
    const counts = new Map();
    for (const node of nodes) {
      for (const token of node.classList) counts.set(token, (counts.get(token) || 0) + 1);
    }
    for (const node of nodes) {
      let active = false;
      for (const token of node.classList) {
        if (counts.get(token) === 1) {
          active = true;
          break;
        }
      }
      if (active) {
        return { text: util.cleanText(node.textContent || ''), key: util.cleanText(node.textContent || '') };
      }
    }
    return null;
  }

  /**
   * Maps the native view's active line text onto the resolved doc's lines.
   * Repeated lines (chorus) mean a text match is ambiguous, so pick the
   * candidate whose start is closest to the current position.
   */
  function lineInfoForText(text) {
    const lyrics = store.get().lyrics;
    if (!lyrics || !Array.isArray(lyrics.lines) || !text) return null;
    const wanted = text.toLowerCase().replace(/\s+/g, '');
    if (!wanted) return null;
    const now = store.positionNow();
    let best = null;
    for (let i = 0; i < lyrics.lines.length; i++) {
      const line = lyrics.lines[i];
      if (!line || line.isInterlude) continue;
      const own = String(line.text || '').toLowerCase().replace(/\s+/g, '');
      if (!own) continue;
      if (!(own === wanted || own.includes(wanted) || wanted.includes(own))) continue;
      const start = Number(line.startMs);
      if (!isFinite(start) || start < 0) continue;
      let nextStart = null;
      for (let j = i + 1; j < lyrics.lines.length; j++) {
        const next = lyrics.lines[j];
        if (!next || next.isInterlude) continue;
        const value = Number(next.startMs);
        if (isFinite(value) && value > start) {
          nextStart = value;
          break;
        }
      }
      const distance = Math.abs(start - now);
      if (distance > 4000) continue;
      if (!best || distance < best.distance) best = { start, nextStart, index: i, distance };
    }
    return best;
  }

  /**
   * Syncs the extension clock to Spotify's own lyric highlight.
   *
   * Forward: when the native view has already moved to a line whose start time
   * is ahead of our clock, jump to it (this is what keeps line changes from
   * waiting for the coarse seek bar).
   *
   * Backward: if the native view is still on line k but our clock has already
   * run past line k+1's start, the clock is early; pull it back into line k.
   * This second direction is what removes a constant "lyrics are ahead" bias.
   *
   * Both directions are bounded to one line and only apply when the mismatch is
   * large enough to be real, so normal polling noise never moves the clock.
   */
  function anchorToNativeLine() {
    if (!isNativeLyricsOpen()) {
      diag.nativeLineKey = null;
      return;
    }
    const active = nativeActiveLine();
    if (!active) return;
    const info = lineInfoForText(active.text);
    if (!info) return;
    const now = store.positionNow();
    const lineKey = info.start + ':' + active.text;
    const early = info.nextStart != null && now > info.nextStart + 150 && now - (info.start + 120) < 2500;

    if (early) {
      if (diag.lastEarlyKey === lineKey) return;
      diag.lastEarlyKey = lineKey;
      store.setPlayback(info.start + 120, true, { exact: true });
      diag.anchors += 1;
      store.patch({ playback: { anchors: diag.anchors } });
      return;
    }
    diag.lastEarlyKey = null;
    if (active.key === diag.nativeLineKey) return;
    diag.nativeLineKey = active.key;
    // Only a forward correction inside one line's length; a larger jump would
    // mean the line mapping picked the wrong row, so ignore it.
    if (info.start <= now + 20 || info.start - now > 1500) return;
    store.setPlayback(info.start + 40, true, { exact: true });
    diag.anchors += 1;
    store.patch({ playback: { anchors: diag.anchors } });
  }

  function applyPlayback(reading, isPlaying) {
    if (!reading) {
      // No progress DOM at all: still publish the play/pause toggle state.
      store.setPlayback(store.positionNow(), isPlaying, { exact: true });
      return;
    }
    const durationMs = reading.durationMs || undefined;
    const domMs = reading.positionMs;
    noteDomStep(domMs);
    const predicted = store.positionNow();
    const error = domMs - predicted;

    if (!isPlaying) {
      // Paused: the DOM value is the truth. Only call a big delta a seek.
      const seek = Math.abs(error) > HARD_JUMP_MS;
      store.setPlayback(domMs, false, { durationMs, seek, exact: !seek });
      noteClock(domMs, predicted, store.positionNow(), error, 1, reading.precise);
      return;
    }

    if (Math.abs(error) > HARD_JUMP_MS) {
      // Real seek (or the tab was suspended): snap and let the renderer catch up.
      diag.seeks += 1;
      store.setPlayback(domMs, true, { durationMs, seek: true });
      noteClock(domMs, predicted, store.positionNow(), error, 1, reading.precise);
      return;
    }

    // The DOM value is quantised: it is stale between updates, so it may only
    // be used as a *lower bound* on playback. Never set the clock back to it
    // (that was the source of the backward steps). Pull forward when the sample
    // is ahead of the clock; otherwise free-run at 1x until the next sample.
    const domChanged = diag.lastDomValue !== domMs;
    diag.lastDomValue = domMs;
    if (error > 5) {
      // Sample is ahead of the clock: anchor forward. Native line anchors can
      // make this a large, non-seek correction; the renderer glides to it.
      store.setPlayback(domMs, true, { durationMs, exact: true });
      noteClock(domMs, predicted, store.positionNow(), error, 1, reading.precise);
      return;
    }
    store.setPlayback(predicted, true, { durationMs, exact: true, rate: 1 });
    noteClock(domMs, predicted, store.positionNow(), error, 1, reading.precise);
  }

  function pollOnce() {
    diag.polls += 1;
    try {
      pollOnceUnsafe();
      diag.lastOkAt = Date.now();
    } catch (err) {
      noteError(err);
      if (!diag.lastErrorLogged) {
        diag.lastErrorLogged = true;
        console.warn('[spicy] player poll failed', err);
      }
    }
  }

  function pollOnceUnsafe() {
    if (!started) return;
    if (typeof document === 'undefined') return;

    const track = readTrack();
    const previous = store.get().track;

    // A sniffed spclient URL may have promoted a real id for this synthetic
    // track; preserve it while the DOM still cannot expose an id.
    if (!track.id && previous.id && previous.key && track.key === previous.key) {
      track.id = previous.id;
      track.uri = previous.uri || 'spotify:track:' + previous.id;
      track.trackUrl = previous.trackUrl || 'https://open.spotify.com/track/' + previous.id;
    }

    const signature = [
      track.id || '',
      track.key || '',
      track.title,
      track.artist,
      track.album,
      track.coverUrl,
      track.durationMs || 0,
    ].join('\u0001');

    if (signature !== lastTrackSignature) {
      lastTrackSignature = signature;
      // A real id always wins; before one is known the synthetic key is the
      // track identity.
      const identityChanged = track.id || previous.id
        ? track.id !== previous.id
        : (track.key || null) !== (previous.key || null);
      const fields = {
        id: track.id,
        key: track.key,
        uri: track.uri,
        title: track.title,
        artist: track.artist,
        album: track.album,
        coverUrl: track.coverUrl,
        durationMs: track.durationMs || 0,
        trackUrl: track.trackUrl,
      };
      if (identityChanged) {
        // Track changed: setTrack clears the lyrics and the resolver re-runs.
        lastRawPosition = null;
        lastAdvanceAt = Date.now();
        store.setPlayback(0, lastPlaying);
        store.setTrack(fields);
      } else {
        // Same track: refresh metadata without clearing the resolved lyrics.
        store.patch({ track: fields });
      }
    }

    const media = readMediaSession();
    const mediaPlaying =
      media && media.playbackState === 'playing' ? true
        : media && media.playbackState === 'paused' ? false
          : null;
    const labelPlaying = readPlayLabel();
    let reading = readPosition(store.get().track.durationMs);
    const mediaClock = readMediaClock(
      reading ? reading.durationMs : store.get().track.durationMs,
      reading ? reading.positionMs : null,
    );
    if (mediaClock) reading = mediaClock;
    diag.clockSource = reading ? reading.source || 'dom' : 'none';
    const isPlaying = resolvePlaying(labelPlaying != null ? labelPlaying : mediaPlaying, reading ? reading.positionMs : null);
    applyPlayback(reading, isPlaying);
    if (isPlaying) anchorToNativeLine();
    if (store.get().playback.source !== (diag.clockSource || 'none')) {
      store.patch({ playback: { source: diag.clockSource || 'none' } });
    }

    const nativeOpen = isNativeLyricsOpen();
    if (nativeOpen !== lastNativeOpen) {
      lastNativeOpen = nativeOpen;
      store.patch({ ui: { nativeLyricsOpen: nativeOpen } });
    }

    // Drop our own optimistic seek marker once the DOM has caught up.
    const playback = store.get().playback;
    if (playback.seekSeq !== seekSeqSeen) seekSeqSeen = playback.seekSeq;
  }

  function schedulePoll() {
    if (!started || mutationTimer) return;
    mutationTimer = setTimeout(() => {
      mutationTimer = 0;
      pollOnce();
    }, MUTATION_THROTTLE_MS);
  }

  function start() {
    if (started) return;
    if (typeof document === 'undefined') return;
    started = true;
    lastPlaying = false;
    pollOnce();

    pollTimer = setInterval(pollOnce, POLL_MS);
    // The native highlight changes between player polls; a faster timer makes
    // the clock anchor land much closer to the real line transition.
    anchorTimer = setInterval(() => {
      try {
        if (started && store.get().playback.isPlaying) anchorToNativeLine();
      } catch (err) {
        noteError(err);
      }
    }, 80);

    if (typeof MutationObserver === 'function') {
      observer = new MutationObserver(schedulePoll);
      try {
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['aria-valuenow', 'aria-label', 'aria-pressed', 'href', 'src', 'srcset', 'style'],
        });
      } catch {
        observer = null;
      }
    }

    window.addEventListener('popstate', schedulePoll);
    window.addEventListener('hashchange', schedulePoll);
  }

  function stop() {
    if (!started) return;
    started = false;
    clearInterval(pollTimer);
    clearInterval(anchorTimer);
    anchorTimer = 0;
    clearTimeout(mutationTimer);
    pollTimer = 0;
    mutationTimer = 0;
    if (observer) observer.disconnect();
    observer = null;
    window.removeEventListener('popstate', schedulePoll);
    window.removeEventListener('hashchange', schedulePoll);
  }

  /**
   * The seek bar's wrapper and click target on the shipped build:
   *   div[data-testid="playback-progressbar"]
   *     > label > input[type=range] (hidden)
   *     > div[data-testid="progress-bar"] > div[data-testid="progress-bar-background"]
   * Older builds/demo use a single div[role=slider].
   */
  function findSeekSurface() {
    const wrapper = pick(SELECTORS.playbackProgressbar);
    const scopedBar = wrapper ? pick(['[data-testid="progress-bar"]'], wrapper) : null;
    const scopedBackground = wrapper ? pick(['[data-testid="progress-bar-background"]'], wrapper) : null;
    if (wrapper || scopedBar) {
      return {
        wrapper: wrapper || scopedBar,
        target: scopedBar || wrapper,
        background: scopedBackground || scopedBar || wrapper,
      };
    }
    const fallback = pick(SELECTORS.progressBar);
    if (!fallback) return null;
    return {
      wrapper: fallback,
      target: fallback,
      background: pick(['[data-testid="progress-bar-background"]']) || fallback,
    };
  }

  function dispatchSeekSequence(target, x, y) {
    if (!target || typeof target.dispatchEvent !== 'function') return false;
    const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y };
    try {
      if (typeof PointerEvent === 'function') {
        const pointer = Object.assign({}, base, {
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          buttons: 1,
        });
        target.dispatchEvent(new PointerEvent('pointerdown', pointer));
        if (typeof window !== 'undefined') {
          // The seek drag hook installs pointermove/pointerup listeners on the
          // window; send the release there so it always sees it.
          window.dispatchEvent(new PointerEvent('pointermove', Object.assign({}, pointer, { buttons: 1, button: -1 })));
          window.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, pointer, { buttons: 0 })));
        }
      }
      // Older builds/demo harness listen for mouse events on the bar itself.
      target.dispatchEvent(new MouseEvent('mousedown', Object.assign({}, base, { button: 0, buttons: 1 })));
      target.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, base, { button: 0, buttons: 0 })));
      target.dispatchEvent(new MouseEvent('click', Object.assign({}, base, { button: 0, buttons: 0 })));
    } catch {
      return false;
    }
    return true;
  }

  /** Drives the hidden range input when the synthetic pointer sequence is ignored. */
  function setRangeInputValue(targetMs, durationMs) {
    const range = readRangeInput();
    if (!range || !range.input || !(range.max > 0)) return false;
    const input = range.input;
    const ratio = durationMs > 0
      ? util.clamp(targetMs / durationMs, 0, 1)
      : util.clamp(targetMs / range.max, 0, 1);
    const value = Math.round(ratio * range.max);
    try {
      const descriptor = typeof HTMLInputElement !== 'undefined'
        ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
        : null;
      if (descriptor && descriptor.set) descriptor.set.call(input, String(value));
      else input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      if (typeof PointerEvent === 'function') {
        const pointer = {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          buttons: 1,
        };
        input.dispatchEvent(new PointerEvent('pointerdown', pointer));
        input.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, pointer, { buttons: 0 })));
      }
      input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true, button: 0, buttons: 1 }));
      input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true, button: 0, buttons: 0 }));
    } catch {
      return false;
    }
    return true;
  }

  /**
   * Seek: synthetic pointer sequence on the seek track, optimistic localSeek,
   * then a 400 ms re-read; if the position did not change, drive the hidden
   * range input through its native value setter.
   * Returns true when a dispatch path was available (not proof of movement).
   */
  function seek(positionMs) {
    const state = store.get();
    const target = Number(positionMs);
    if (!isFinite(target)) return false;

    let duration = state.track.durationMs;
    if (!(duration > 0)) {
      const range = readRangeInput();
      if (range && range.max > 0) duration = range.max;
    }
    if (!(duration > 0)) return false;

    const clampedTarget = util.clamp(Math.round(target), 0, duration);
    const ratio = util.clamp(clampedTarget / duration, 0.001, 0.999);

    const surface = findSeekSurface();
    let attempted = false;

    if (surface) {
      const rectSource = surface.background || surface.target || surface.wrapper;
      let rect = null;
      try {
        rect = rectSource && rectSource.getBoundingClientRect ? rectSource.getBoundingClientRect() : null;
      } catch {
        rect = null;
      }
      if (!rect || !(rect.width > 0) || !(rect.height > 0)) {
        try {
          rect = surface.target.getBoundingClientRect();
        } catch {
          rect = null;
        }
      }
      if (rect && rect.width > 0 && rect.height > 0) {
        const x = rect.left + rect.width * ratio;
        const y = rect.top + rect.height / 2;
        attempted = dispatchSeekSequence(surface.target, x, y);
      }
    }

    if (!attempted) attempted = setRangeInputValue(clampedTarget, duration);
    if (!attempted) return false;

    store.localSeek(clampedTarget);

    if (typeof setTimeout === 'function') {
      setTimeout(() => {
        try {
          if (!started) return;
          const reading = readPosition(store.get().track.durationMs || duration);
          const observed = reading ? reading.positionMs : store.positionNow();
          if (!isFinite(observed) || Math.abs(observed - clampedTarget) > 1500) {
            if (setRangeInputValue(clampedTarget, duration)) store.localSeek(clampedTarget);
          }
        } catch {
          /* verification is best effort */
        }
      }, 400);
    }
    return true;
  }

  /** Structured snapshot for the popup's diagnostics panel and bug reports. */
  function diagnostics() {
    const state = store.get();
    let range = null;
    try {
      const input = readRangeInput();
      range = input ? { max: input.max, value: input.value, ariaValueText: input.ariaValueText, hasInput: !!input.input } : null;
    } catch (err) {
      range = null;
    }
    const media = readMediaSession();
    return {
      at: new Date().toISOString(),
      url: typeof location !== 'undefined' ? location.href : '',
      polls: diag.polls,
      lastOkAt: diag.lastOkAt ? new Date(diag.lastOkAt).toISOString() : null,
      lastError: diag.lastError,
      errors: diag.errors.slice(-5),
      mediaSession: media ? { ...media } : { supported: false },
      documentTitle: (typeof document !== 'undefined' && document.title) || '',
      found: {
        playerBar: !!pick(SELECTORS.playerBar),
        widget: !!pick(SELECTORS.nowPlaying),
        title: !!pick(SELECTORS.title),
        artist: !!pick(SELECTORS.subtitleLinks),
        cover: !!pick(SELECTORS.cover),
        progressBar: !!pick(SELECTORS.progressBar),
        playButton: !!pick(SELECTORS.playPause),
        range,
      },
      nativeLyricsOpen: isNativeLyricsOpen(),
      mediaElements: typeof document !== 'undefined' ? document.querySelectorAll('video, audio').length : 0,
      track: {
        id: state.track.id,
        key: state.track.key,
        title: state.track.title,
        artist: state.track.artist,
        album: state.track.album,
        coverUrl: state.track.coverUrl ? state.track.coverUrl.slice(0, 120) : '',
        durationMs: state.track.durationMs,
      },
      playback: {
        positionMs: Math.round(store.positionNow()),
        isPlaying: state.playback.isPlaying,
        rate: Number((state.playback.rate || 1).toFixed(4)),
        clockSource: diag.clockSource || 'none',
        seeks: diag.seeks,
        anchors: diag.anchors,
        domStepMs: (() => {
          const steps = diag.domSteps.map((x) => x.step).filter((v) => v > 0);
          if (!steps.length) return 0;
          steps.sort((a, b) => a - b);
          return steps[Math.floor(steps.length / 2)];
        })(),
        clockSamples: diag.clockSamples.slice(-10),
        domSteps: diag.domSteps.slice(-10).map((s) => s.step),
        offsetMs: (state.settings && state.settings.offsetMs) || 0,
      },
      lyrics: {
        status: state.lyricsStatus,
        source: state.lyrics ? state.lyrics.source : null,
        syncType: state.lyrics ? state.lyrics.syncType : null,
        lines: state.lyrics && state.lyrics.lines ? state.lyrics.lines.length : 0,
      },
      lastTrackRead: diag.lastTrackRead,
    };
  }

  SL.player = {
    SELECTORS,
    start,
    stop,
    seek,
    diagnostics,
    /** Forces one synchronous DOM read; useful for tests and the demo harness. */
    refresh: pollOnce,
  };
})();
