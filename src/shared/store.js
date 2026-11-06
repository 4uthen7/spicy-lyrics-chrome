/**
 * Spicy Lyrics for Chrome — state spine.
 *
 * One mutable state object plus a subscription list. Everything else in the
 * extension is a producer (player observer, lyrics resolver, settings sync) or
 * a consumer (renderer). Consumers read `SL.store.get()` and
 * `SL.store.positionNow()`; they never get per-frame callbacks pushed at them,
 * which keeps the render loop decoupled from DOM observation.
 *
 * Playback position is stored as a base + timestamp so the renderer can
 * interpolate at 60fps without the DOM being polled that often. Every DOM
 * observation re-bases the clock, and any backward/large-forward jump is
 * treated as a seek so the renderer can snap instead of sprinting.
 */
(function () {
  'use strict';
  const SL = (globalThis.SL = globalThis.SL || {});
  if (SL.store) return;
  const { bus } = SL;

  /** @type {SL.Settings} */
  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    autoOpen: true,
    autoFetch: true,
    mode: 'cinema',
    showBackground: true,
    backgroundStyle: 'artwork',
    backgroundMotion: true,
    backgroundBlur: 90,
    backgroundDim: 0.48,
    lyricMode: 'cinema',
    minimalMode: false,
    showRomanization: false,
    offsetMs: 0,
    fontSize: 1,
    lineGap: 1,
    wordHighlight: 'gradient',
    hideCredit: true,
    reduceMotion: false,
    showInterludeDots: true,
    showHeader: true,
  });

  const SETTINGS_KEY = 'spicy.settings';
  /** Custom background image is stored separately (can be a few MB). */
  const BG_IMAGE_KEY = 'spicy.bgImage';
  const BACKGROUND_STYLES = ['artwork', 'artwork-sharp', 'gradient', 'solid', 'video', 'image'];
  const LYRIC_MODES = ['cinema', 'flow', 'simple'];
  const CACHE_PREFIX = 'spicy.lyrics.';

  function sanitizeSettings(raw) {
    const out = { ...DEFAULT_SETTINGS };
    if (!raw || typeof raw !== 'object') return out;
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (!(key in raw)) continue;
      const def = DEFAULT_SETTINGS[key];
      const val = raw[key];
      if (typeof def === 'boolean') out[key] = !!val;
      else if (typeof def === 'number') {
        const n = Number(val);
        if (isFinite(n)) out[key] = n;
      } else if (typeof def === 'string') {
        if (typeof val === 'string' && val) out[key] = val;
      }
    }
    out.mode = out.mode === 'panel' ? 'panel' : 'cinema';
    out.wordHighlight = out.wordHighlight === 'solid' ? 'solid' : 'gradient';
    out.backgroundStyle = BACKGROUND_STYLES.includes(out.backgroundStyle) ? out.backgroundStyle : 'artwork';
    out.lyricMode = LYRIC_MODES.includes(out.lyricMode) ? out.lyricMode : 'cinema';
    out.backgroundBlur = SL.util.clamp(out.backgroundBlur, 0, 200);
    out.backgroundDim = SL.util.clamp(out.backgroundDim, 0, 0.95);
    out.fontSize = SL.util.clamp(out.fontSize, 0.6, 1.8);
    out.lineGap = SL.util.clamp(out.lineGap, 0.6, 2);
    out.offsetMs = SL.util.clamp(Math.round(out.offsetMs), -20000, 20000);
    return out;
  }

  const state = {
    ready: false,
    /** @type {SL.TrackInfo} */
    track: {
      id: null,
      uri: null,
      title: '',
      artist: '',
      album: '',
      coverUrl: '',
      durationMs: 0,
      trackUrl: null,
    },
    playback: {
      positionMs: 0,
      at: SL.util.now(),
      isPlaying: false,
      rate: 1,
      /** Bumped whenever a seek is inferred; renderer snaps on change. */
      seekSeq: 0,
    },
    /** @type {SL.LyricsDoc|null} */
    lyrics: null,
    /** idle | loading | ready | empty | error | disabled */
    lyricsStatus: 'idle',
    lyricsError: null,
    /** @type {SL.Settings} */
    settings: { ...DEFAULT_SETTINGS },
    ui: {
      mounted: false,
      nativeLyricsOpen: false,
      open: false,
      lastError: null,
      /** True once the user hid the overlay for the current track. */
      dismissed: false,
    },
    /** Providers that reported a miss for the current track, for the UI hint. */
    attempts: [],
  };

  const listeners = new Set();
  let disposed = false;

  function snapshot() {
    return state;
  }

  function notify(reason) {
    if (disposed) return;
    for (const fn of Array.from(listeners)) {
      try {
        fn(state, reason);
      } catch (err) {
        console.error('[spicy] store subscriber failed', err);
      }
    }
    bus.emit('state', { state, reason });
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function patch(partial, reason = 'patch') {
    let changed = false;
    for (const key of Object.keys(partial || {})) {
      const next = partial[key];
      if (next === undefined) continue;
      if (next && typeof next === 'object' && !Array.isArray(next) && key in state &&
          state[key] && typeof state[key] === 'object' && !Array.isArray(state[key])) {
        for (const sub of Object.keys(next)) {
          if (state[key][sub] !== next[sub]) {
            state[key][sub] = next[sub];
            changed = true;
          }
        }
      } else if (state[key] !== next) {
        state[key] = next;
        changed = true;
      }
    }
    if (changed) notify(reason);
    return changed;
  }

  function positionNow() {
    const p = state.playback;
    if (!p.isPlaying) return Math.max(0, p.positionMs);
    const elapsed = (SL.util.now() - p.at) * (p.rate || 1);
    const pos = p.positionMs + elapsed;
    if (state.track.durationMs > 0) return Math.min(pos, state.track.durationMs);
    return pos;
  }

  /**
   * Re-bases the playback clock from a DOM observation.
   * @param {number} positionMs
   * @param {boolean} isPlaying
   * @param {{ seek?: boolean, durationMs?: number }} [opts]
   */
  function setPlayback(positionMs, isPlaying, opts = {}) {
    const p = state.playback;
    const prev = positionNow();
    let seek = !!opts.seek;
    if (!seek) {
      const delta = positionMs - prev;
      // A backward jump of any size, or a forward jump beyond what wall-clock
      // interpolation could explain, means the user seeked or the DOM lagged.
      if (delta < -350 || delta > 2500) seek = true;
    }
    p.positionMs = Math.max(0, positionMs);
    p.isPlaying = !!isPlaying;
    p.at = SL.util.now();
    if (seek) p.seekSeq += 1;
    if (opts.durationMs != null && opts.durationMs !== state.track.durationMs) {
      state.track.durationMs = opts.durationMs;
      notify('duration');
    }
    bus.emit('playback', { positionMs: p.positionMs, isPlaying: p.isPlaying, seek });
    if (seek) notify('seek');
    else notify('playback');
  }

  /** Optimistic local seek, so the UI snaps before the DOM confirms. */
  function localSeek(positionMs) {
    state.playback.positionMs = Math.max(0, positionMs);
    state.playback.at = SL.util.now();
    state.playback.seekSeq += 1;
    notify('seek');
  }

  function setTrack(track) {
    const prev = state.track;
    const sameTrack = prev.id && track.id && prev.id === track.id && prev.uri === track.uri;
    const merged = { ...prev, ...track };
    const changed = Object.keys(merged).some((k) => merged[k] !== prev[k]);
    state.track = merged;
    if (!sameTrack) {
      state.lyrics = null;
      state.lyricsStatus = 'idle';
      state.lyricsError = null;
      state.attempts = [];
      state.ui.dismissed = false;
    }
    if (changed) notify('track');
    return !sameTrack;
  }

  function setLyrics(doc, status = 'ready') {
    state.lyrics = doc || null;
    state.lyricsStatus = doc ? status : 'empty';
    state.lyricsError = null;
    notify('lyrics');
  }

  function setLyricsStatus(status, error) {
    state.lyricsStatus = status;
    state.lyricsError = error ? String(error.message || error) : null;
    notify('lyrics-status');
  }

  function setSettings(raw) {
    state.settings = sanitizeSettings(raw);
    notify('settings');
    return state.settings;
  }

  function updateSettings(partial) {
    state.settings = sanitizeSettings({ ...state.settings, ...partial });
    notify('settings');
    return state.settings;
  }

  // ---------------------------------------------------------------------------
  // Settings persistence (chrome.storage.sync with graceful fallback)
  // ---------------------------------------------------------------------------

  function hasStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync;
  }

  async function loadSettings() {
    if (!hasStorage()) return state.settings;
    try {
      const got = await chrome.storage.sync.get(SETTINGS_KEY);
      const raw = got && got[SETTINGS_KEY];
      state.settings = sanitizeSettings(raw || {});
      notify('settings');
    } catch (err) {
      console.warn('[spicy] settings load failed', err);
    }
    return state.settings;
  }

  let saveTimer = 0;
  function saveSettings() {
    if (!hasStorage()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        chrome.storage.sync.set({ [SETTINGS_KEY]: state.settings });
      } catch (err) {
        console.warn('[spicy] settings save failed', err);
      }
    }, 200);
  }

  // ---------------------------------------------------------------------------
  // Lyrics cache (chrome.storage.local, LRU-trimmed)
  // ---------------------------------------------------------------------------

  const CACHE_LIMIT = 240;

  async function readCache(trackId) {
    if (!hasStorage()) return null;
    try {
      const key = CACHE_PREFIX + trackId;
      const got = await chrome.storage.local.get(key);
      const entry = got && got[key];
      if (!entry || !entry.doc) return null;
      return entry.doc;
    } catch {
      return null;
    }
  }

  async function writeCache(doc) {
    if (!hasStorage()) return;
    try {
      const key = CACHE_PREFIX + doc.trackId;
      await chrome.storage.local.set({ [key]: { doc, at: Date.now() } });
      await trimCache();
    } catch (err) {
      console.warn('[spicy] cache write failed', err);
    }
  }

  async function trimCache() {
    try {
      const all = await chrome.storage.local.get(null);
      const entries = Object.keys(all)
        .filter((k) => k.startsWith(CACHE_PREFIX))
        .map((k) => ({ key: k, at: (all[k] && all[k].at) || 0 }))
        .sort((a, b) => a.at - b.at);
      if (entries.length <= CACHE_LIMIT) return;
      const drop = entries.slice(0, entries.length - CACHE_LIMIT).map((e) => e.key);
      await chrome.storage.local.remove(drop);
    } catch {
      /* best effort */
    }
  }

  async function clearCache() {
    if (!hasStorage()) return 0;
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
    if (keys.length) await chrome.storage.local.remove(keys);
    return keys.length;
  }

  SL.store = {
    DEFAULT_SETTINGS,
    SETTINGS_KEY,
    BG_IMAGE_KEY,
    BACKGROUND_STYLES,
    LYRIC_MODES,
    get: snapshot,
    subscribe,
    patch,
    notify,
    positionNow,
    setPlayback,
    localSeek,
    setTrack,
    setLyrics,
    setLyricsStatus,
    setSettings,
    updateSettings,
    sanitizeSettings,
    loadSettings,
    saveSettings,
    readCache,
    writeCache,
    clearCache,
  };
})();
