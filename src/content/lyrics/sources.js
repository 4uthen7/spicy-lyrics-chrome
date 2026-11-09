/**
 * Lyrics acquisition pipeline.
 *
 * `attach()` watches the store for track changes and resolves one LyricsDoc per
 * track, in this order:
 *
 *   1. chrome.storage.local cache           (instant, survives reloads)
 *   2. MAIN-world direct fetch via bridge   (spclient, authenticated)
 *   3. captured spclient payload            (the player's own fetch, sniffed)
 *   4. native lyrics DOM scrape             (only while the panel is open)
 *   5. status 'empty'
 *
 * Cache hits are offset-rebased in place so a settings change does not force a
 * network round-trip. Successful documents are written back to the cache.
 * In-flight work for the previous track is abandoned as soon as a new track is
 * observed; stale resolutions never publish.
 *
 * Track identity: the shipped player bar does not expose the Spotify track id,
 * so the player publishes a synthetic `track.key` (title/artist/album hint).
 * The resolver keys cache and documents on `track.id || track.key` until a
 * sniffed spclient URL supplies the real id. A captured lyrics payload is then
 * attributed to the current DOM track (its URL embeds the cover image, or the
 * native lyrics view is open) and the real id is promoted onto the store, which
 * re-resolves against that payload immediately.
 *
 * The bridge feeds captures through `SL.lyrics.capture(trackId, message)`; a
 * captured payload is also allowed to upgrade a DOM-scraped document because it
 * carries real word timings.
 */
(function () {
  'use strict';
  const SL = (globalThis.SL = globalThis.SL || {});
  SL.lyrics = SL.lyrics || {};
  if (SL.lyrics.attach) return;

  const store = SL.store;
  const NATIVE_WAIT_MS = 4000;
  const NATIVE_POLL_MS = 200;
  const CAPTURE_LIMIT = 8;
  const MIN_DOM_LINES_FOR_CACHE = 3;

  /** trackId -> { kind: 'color-lyrics'|'ttml', json?|text?, at } */
  const captured = new Map();

  let attached = false;
  let unsubscribe = null;
  let currentTrackId = null;
  let currentTrackObservedAt = 0;
  let inflight = null;
  let resolveSeq = 0;
  let lastOffsetMs = null;
  let lastEnabled = null;
  let lastNativeOpen = false;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function settings() {
    const state = store.get();
    return (state && state.settings) || {};
  }

  function offsetMs() {
    const value = Number(settings().offsetMs);
    return Number.isFinite(value) ? Math.round(value) : 0;
  }

  function isDoc(doc) {
    return !!doc && Array.isArray(doc.lines) && doc.lines.length > 0 && typeof doc.syncType === 'string';
  }

  function resolutionKey(track) {
    if (!track) return null;
    if (track.id) return track.id;
    return track.key || null;
  }

  function isSpotifyTrackId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9]{22}$/.test(value);
  }

  function nativeLyricsOpenNow() {
    const state = store.get();
    return !!(state.ui && state.ui.nativeLyricsOpen);
  }

  /**
   * The web player only fetches lyrics when its own lyrics view is shown, and
   * the app shell bootstraps that view on demand (autoFetch). A sniffed payload
   * that arrives while the view is closed is therefore kept for later instead of
   * being published, otherwise the bootstrap would see a "ready" track and never
   * ask Spotify for the lyrics.
   */
  /**
   * A warm cache must not short-circuit the app's autoFetch bootstrap: with the
   * native lyrics view closed, a ready document would stop the shell from
   * opening Spotify's lyrics (and on id-less builds the bootstrap is also what
   * proves the real track id). Defer only when a sniffed payload can satisfy
   * the resolution once the view opens.
   */
  function shouldDeferCacheForBootstrap(trackId) {
    const state = store.get();
    if (state.ui && (state.ui.nativeLyricsOpen || state.ui.open)) return false;
    return captured.has(trackId);
  }

  function publishCapturedForCurrent() {
    const state = store.get();
    const key = resolutionKey(state.track);
    if (!key) return false;
    const entry = captured.get(key);
    if (!entry) return false;
    const doc = parseCapture(entry, key);
    if (!isDoc(doc)) return false;
    const current = state.lyrics;
    const currentSource = current && current.source;
    const originDom = !!(current && current.meta && current.meta.originalSource === 'dom');
    const upgrade =
      !current ||
      state.lyricsStatus !== 'ready' ||
      currentSource === 'dom' ||
      originDom ||
      (current.syncType !== 'word' && doc.syncType === 'word');
    if (!upgrade) return false;
    return publish(doc, key, resolveSeq);
  }

  function urlBasename(value) {
    try {
      return new URL(String(value), 'https://local.invalid/').pathname.split('/').pop() || '';
    } catch {
      return '';
    }
  }

  function extractImageUrl(url) {
    if (typeof url !== 'string') return '';
    const match = /\/image\/([^/?#]+)/.exec(url);
    if (!match) return '';
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  /**
   * Strong attribution signal: the player's own lyrics URL embeds the cover
   * image URL of the track it is fetching for. Compare basenames (the URL can
   * carry a size prefix).
   */
  function captureMatchesCover(entry, track) {
    if (!entry || !track || !track.coverUrl || !entry.imageUrl) return false;
    const captureBase = urlBasename(entry.imageUrl);
    const coverBase = urlBasename(track.coverUrl);
    return !!captureBase && !!coverBase && captureBase === coverBase;
  }

  /**
   * Promotes a sniffed real track id onto the store when the current DOM track
   * has none. Attribution is the cover-image match; while the native lyrics
   * view is open the player is fetching for the currently displayed item, so
   * that is accepted as a fallback (UNVERIFIED but narrow).
   */
  function adoptTrackId(realTrackId) {
    if (!isSpotifyTrackId(realTrackId)) return false;
    const state = store.get();
    const track = state.track || {};
    if (track.id || !track.title) return false;
    try {
      store.setTrack({
        id: realTrackId,
        uri: 'spotify:track:' + realTrackId,
        trackUrl: 'https://open.spotify.com/track/' + realTrackId,
      });
      return true;
    } catch {
      return false;
    }
  }

  function isStale(trackId, seq) {
    return seq !== resolveSeq || trackId !== currentTrackId;
  }

  /** Shifts a cached doc by the difference between cached and current offset. */
  function rebaseDoc(doc, deltaMs) {
    if (!deltaMs) return doc;
    const lines = doc.lines.map((line) => {
      const next = {
        ...line,
        startMs: Math.max(0, line.startMs + deltaMs),
        endMs: Math.max(0, line.endMs + deltaMs),
        words: (line.words || []).map((word) => ({
          ...word,
          startMs: Math.max(0, word.startMs + deltaMs),
          endMs: Math.max(0, word.endMs + deltaMs),
        })),
      };
      if (next.endMs <= next.startMs) next.endMs = next.startMs + 1;
      for (const word of next.words) {
        if (word.endMs <= word.startMs) word.endMs = word.startMs + 1;
      }
      return next;
    });
    return {
      ...doc,
      lines,
      source: 'cache',
      offsetMs: (Number(doc.offsetMs) || 0) + deltaMs,
      meta: { ...(doc.meta || {}), originalSource: doc.source },
    };
  }

  async function readCache(trackId) {
    try {
      if (!store || typeof store.readCache !== 'function') return null;
      const doc = await store.readCache(trackId);
      if (!isDoc(doc) || doc.trackId !== trackId) return null;
      const delta = offsetMs() - (Number(doc.offsetMs) || 0);
      return rebaseDoc(doc, delta);
    } catch {
      return null;
    }
  }

  function shouldCache(doc) {
    if (!isDoc(doc)) return false;
    if (doc.source !== 'dom') return true;
    return doc.syncType !== 'static' && doc.lines.length >= MIN_DOM_LINES_FOR_CACHE;
  }

  function cacheDoc(doc) {
    try {
      if (store && typeof store.writeCache === 'function' && shouldCache(doc)) {
        store.writeCache(doc);
      }
    } catch {
      /* cache failures are never fatal */
    }
  }

  /** Publishes a document if the resolution that produced it is still current. */
  function publish(doc, trackId, seq) {
    if (!isDoc(doc)) return false;
    if (isStale(trackId, seq)) return false;
    if (typeof doc.trackId !== 'string' || !doc.trackId) doc = { ...doc, trackId };
    store.setLyrics(doc, 'ready');
    cacheDoc(doc);
    return true;
  }

  function normalizeCapture(trackId, message) {
    if (!message || typeof message !== 'object') return null;
    const format = message.format === 'ttml' ? 'ttml' : 'color-lyrics';
    if (format === 'ttml') {
      const text = typeof message.payload === 'string'
        ? message.payload
        : typeof message.ttml === 'string'
          ? message.ttml
          : null;
      if (!text) return null;
      return { kind: 'ttml', text, at: Date.now(), url: message.url || null, imageUrl: '' };
    }
    let json = message.payload !== undefined ? message.payload : message.json;
    if (typeof json === 'string') {
      try {
        json = JSON.parse(json);
      } catch {
        return null;
      }
    }
    if (!json || typeof json !== 'object') return null;
    const url = typeof message.url === 'string' ? message.url : null;
    const imageUrl = typeof message.imageUrl === 'string' && message.imageUrl
      ? message.imageUrl
      : extractImageUrl(url);
    return { kind: 'color-lyrics', json, at: Date.now(), url, imageUrl };
  }

  function parseCapture(entry, trackId) {
    if (!entry) return null;
    const opts = { trackId, offsetMs: offsetMs() };
    if (entry.kind === 'ttml') {
      return typeof SL.lyrics.parseTTML === 'function' ? SL.lyrics.parseTTML(entry.text, opts) : null;
    }
    return typeof SL.lyrics.parseColorLyrics === 'function' ? SL.lyrics.parseColorLyrics(entry.json, opts) : null;
  }

  // -------------------------------------------------------------------------
  // Capture handling
  // -------------------------------------------------------------------------

  /**
   * Called by the isolated-world bridge for every sniffed color-lyrics/ttml
   * response. Message shape: `{format, payload, trackId, url, at}`.
   */
  function capture(trackId, message) {
    if (typeof trackId !== 'string' || !trackId) return;
    const entry = normalizeCapture(trackId, message);
    if (!entry) return;

    captured.delete(trackId);
    captured.set(trackId, entry);
    while (captured.size > CAPTURE_LIMIT) {
      const oldest = captured.keys().next().value;
      captured.delete(oldest);
    }

    // Track id promotion: the player bar cannot expose the id, so the first
    // sniffed lyrics URL is how the synthetic track becomes a real one.
    let state = store.get();
    let currentKey = resolutionKey(state.track);
    if (currentKey && currentKey !== trackId && !(state.track && state.track.id)) {
      const nativeOpen = !!(state.ui && state.ui.nativeLyricsOpen);
      if (captureMatchesCover(entry, state.track)) {
        if (adoptTrackId(trackId)) return; // onState re-resolves with the real id
      } else if (nativeOpen) {
        if (adoptTrackId(trackId)) return;
      } else if (captured.size === 1 && entry.at >= currentTrackObservedAt - 1500) {
        // The page fetched lyrics while no native view was open (SPA state) and
        // this is the only candidate id since the track was observed; adopt it
        // so the app's autoFetch bootstrap can address the track by real id.
        if (adoptTrackId(trackId)) return;
      } else if (typeof setTimeout === 'function') {
        // The native view may still be opening; retry attribution briefly.
        setTimeout(() => {
          const retryState = store.get();
          if (retryState.track && !retryState.track.id && retryState.ui && retryState.ui.nativeLyricsOpen) {
            adoptTrackId(trackId);
          }
        }, 600);
        return;
      }
      if (currentKey !== trackId) return;
    }

    if (!attached) return;
    state = store.get();
    currentKey = resolutionKey(state.track);
    if (trackId !== currentKey) return;

    const current = state.lyrics;
    const currentSource = current && current.source;
    const originDom = !!(current && current.meta && current.meta.originalSource === 'dom');
    const doc = parseCapture(entry, trackId);
    if (!isDoc(doc)) return;
    // Wait for the native lyrics view (and the app's autoFetch bootstrap).
    if (!nativeLyricsOpenNow()) return;

    // A spclient payload may replace a DOM-derived document (it carries real
    // word timings), and a word document may replace a line-level one. Never
    // downgrade a ready spclient/ttml word document with a duplicate capture.
    const upgrade =
      !current ||
      state.lyricsStatus !== 'ready' ||
      currentSource === 'dom' ||
      originDom ||
      (current.syncType !== 'word' && doc.syncType === 'word');
    if (!upgrade) return;

    publish(doc, trackId, resolveSeq);
  }

  function findNativeContainer() {
    try {
      if (typeof document === 'undefined') return null;
      const selectors = (SL.lyrics.DOM_SELECTORS && SL.lyrics.DOM_SELECTORS.container) || [];
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element) return element;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function scrapeNow(trackId) {
    if (typeof SL.lyrics.scrapeNative !== 'function') return null;
    const container = findNativeContainer();
    return SL.lyrics.scrapeNative(container || (typeof document !== 'undefined' ? document : null), {
      trackId,
      offsetMs: offsetMs(),
      positionMs: store.positionNow(),
    });
  }

  /**
   * The native panel renders asynchronously after it opens; give it a moment to
   * expose lines and to mark an active line before accepting a static scrape.
   * Aborts early when a sniffed payload has already published a document.
   */
  async function scrapeWithWait(trackId, seq, allowReadyShortcut) {
    const deadline = Date.now() + NATIVE_WAIT_MS;
    let timedDoc = null;
    let staticDoc = null;

    while (Date.now() < deadline) {
      if (isStale(trackId, seq)) return null;
      if (allowReadyShortcut !== false && currentReadyDoc(trackId)) return null;
      const state = store.get();
      if (!state.ui || !state.ui.nativeLyricsOpen) break;

      const doc = scrapeNow(trackId);
      if (isDoc(doc)) {
        if (doc.syncType !== 'static' && doc.lines.some((line) => !line.isInterlude)) {
          timedDoc = doc;
          break;
        }
        if (!staticDoc) staticDoc = doc;
      }
      await sleep(NATIVE_POLL_MS);
    }

    if (timedDoc) return timedDoc;
    return staticDoc;
  }

  function markAttempt(name) {
    try {
      const state = store.get();
      const attempts = Array.isArray(state.attempts) ? state.attempts.slice() : [];
      attempts.push(name);
      store.patch({ attempts });
    } catch {
      /* attempt bookkeeping is advisory */
    }
  }

  const CAPTURE_WAIT_MS = 1200;
  const CAPTURE_POLL_MS = 100;

  function currentReadyDoc(trackId) {
    const state = store.get();
    return state.lyricsStatus === 'ready' && isDoc(state.lyrics) && state.lyrics.trackId === trackId
      ? state.lyrics
      : null;
  }

  /**
   * The player/native panel starts its color-lyrics request immediately on
   * track change, so a sniffed payload is usually milliseconds away. Give it a
   * short window before paying for the direct network path.
   */
  async function waitForCapture(trackId, seq) {
    const deadline = Date.now() + CAPTURE_WAIT_MS;
    while (true) {
      if (isStale(trackId, seq)) return null;
      const entry = captured.get(trackId);
      if (entry) return entry;
      if (Date.now() >= deadline) return null;
      await sleep(CAPTURE_POLL_MS);
    }
  }

  // If a resolve finishes empty while Spotify's lyric view is (or becomes) open,
  // try again shortly: the panel renders asynchronously and the player's own
  // request may land just after we gave up. Bounded per track so a genuinely
  // lyric-less track does not poll forever.
  const emptyRetries = new Map();
  let emptyRetryTimer = 0;

  function scheduleEmptyRetry(trackId, seq) {
    if (typeof setTimeout !== 'function' || !trackId) return;
    const attempts = emptyRetries.get(trackId) || 0;
    if (attempts >= 5) return;
    emptyRetries.set(trackId, attempts + 1);
    if (emptyRetryTimer) clearTimeout(emptyRetryTimer);
    emptyRetryTimer = setTimeout(() => {
      emptyRetryTimer = 0;
      if (!attached) return;
      const state = store.get();
      if (resolutionKey(state.track) !== trackId) return;
      if (state.lyricsStatus !== 'empty') return;
      const nativeOpen = nativeLyricsOpenNow();
      if (!nativeOpen) {
        // The autoFetch bootstrap may still open the view; keep watching.
        scheduleEmptyRetry(trackId, seq);
        return;
      }
      resolve(trackId, { force: true }).catch(() => {});
    }, 1200);
  }

  async function resolve(trackId, opts) {
    const options = opts || {};
    const seq = ++resolveSeq;
    if (!trackId) return null;

    if (settings().enabled === false) {
      store.setLyrics(null);
      store.setLyricsStatus('disabled');
      return null;
    }

    // Dedupe parallel resolves for the same track (track change events can
    // arrive in bursts during SPA navigation).
    if (!options.force && inflight && inflight.trackId === trackId) return inflight.promise;

    // Immediately, so the overlay can show its loading pill.
    store.setLyricsStatus('loading');
    store.patch({ attempts: [] });

    const promise = (async () => {
      // 0. A capture may already have published while this resolve was queued.
      if (!options.force) {
        const ready = currentReadyDoc(trackId);
        if (ready) return ready;
      }

      // 1. cache (unless the bootstrap needs to open Spotify's lyrics first)
      const cached = await readCache(trackId);
      if (isStale(trackId, seq)) return null;
      if (isDoc(cached) && shouldDeferCacheForBootstrap(trackId)) {
        markAttempt('cache');
      } else if (isDoc(cached)) {
        markAttempt('cache');
        const ready = !options.force && currentReadyDoc(trackId);
        if (!ready) publish(cached, trackId, seq);
        return ready || cached;
      } else {
        markAttempt('cache');
      }

      // 2. captured payload (player's own fetch, sniffed in the MAIN world)
      const entry = await waitForCapture(trackId, seq);
      if (isStale(trackId, seq)) return null;
      if (entry && !nativeLyricsOpenNow()) {
        // Keep the payload for when the view opens; the bootstrap needs the
        // chance to trigger Spotify's own lyrics request.
        markAttempt('captured');
      } else if (entry) {
        const doc = parseCapture(entry, trackId);
        if (isDoc(doc)) {
          markAttempt('captured');
          const ready = !options.force && currentReadyDoc(trackId);
          if (!ready) publish(doc, trackId, seq);
          return ready || doc;
        }
        markAttempt('captured');
      }

      // 3. authenticated direct fetch in the MAIN world (real Spotify id only;
      // the injector reuses the bearer captured from the page's own requests)
      if (isSpotifyTrackId(trackId) && SL.bridge && typeof SL.bridge.requestDirectLyrics === 'function') {
        let doc = null;
        try {
          doc = await SL.bridge.requestDirectLyrics(trackId);
        } catch {
          doc = null;
        }
        if (isStale(trackId, seq)) return null;
        if (isDoc(doc)) {
          markAttempt('direct');
          const ready = !options.force && currentReadyDoc(trackId);
          if (!ready) publish(doc, trackId, seq);
          return ready || doc;
        }
        markAttempt('direct');
        // A sniffed payload may have landed while the direct fetch was in
        // flight; prefer it over falling through (and over clearing below).
        if (!options.force) {
          const ready = currentReadyDoc(trackId);
          if (ready) return ready;
        }
      }

      // 4. native DOM fallback, only while its panel is on screen
      const state = store.get();
      if (state.ui && state.ui.nativeLyricsOpen && !isStale(trackId, seq)) {
        const doc = await scrapeWithWait(trackId, seq, !options.force);
        if (isStale(trackId, seq)) return null;
        if (isDoc(doc)) {
          markAttempt('dom');
          const ready = !options.force && currentReadyDoc(trackId);
          if (!ready) publish(doc, trackId, seq);
          return ready || doc;
        }
        markAttempt('dom');
      }

      if (!isStale(trackId, seq)) {
        if (!options.force) {
          const ready = currentReadyDoc(trackId);
          if (ready) return ready;
        }
        store.setLyrics(null);
        store.setLyricsStatus('empty');
        scheduleEmptyRetry(trackId, seq);
      }
      return null;
    })();

    inflight = { trackId, promise };
    try {
      return await promise;
    } finally {
      if (inflight && inflight.promise === promise) inflight = null;
    }
  }

  /** Re-attempts the DOM source when the native lyrics panel opens mid-track. */
  async function upgradeFromDom() {
    const trackId = currentTrackId;
    if (!trackId) return;
    const state = store.get();
    const current = state.lyrics;
    if (current && state.lyricsStatus === 'ready' && current.source !== 'dom') return;

    const seq = ++resolveSeq;
    store.setLyricsStatus('loading');
    const doc = await scrapeWithWait(trackId, seq);
    if (isStale(trackId, seq)) return;
    if (isDoc(doc)) {
      markAttempt('dom');
      publish(doc, trackId, seq);
    } else if (!current) {
      store.setLyrics(null);
      store.setLyricsStatus('empty');
    }
  }

  function onState(state, reason) {
    if (!attached) return;

    const trackId = resolutionKey(state.track);
    if (trackId !== currentTrackId) {
      currentTrackId = trackId;
      emptyRetries.clear();
      if (emptyRetryTimer) {
        clearTimeout(emptyRetryTimer);
        emptyRetryTimer = 0;
      }
      currentTrackObservedAt = Date.now();
      if (!trackId) {
        resolveSeq += 1;
        store.setLyrics(null);
        store.setLyricsStatus('idle');
        return;
      }
      resolve(trackId);
    }

    const activeSettings = state.settings || {};
    const nextOffset = Number.isFinite(Number(activeSettings.offsetMs)) ? Math.round(Number(activeSettings.offsetMs)) : 0;
    if (lastOffsetMs == null) lastOffsetMs = nextOffset;
    if (reason === 'settings' && nextOffset !== lastOffsetMs) {
      lastOffsetMs = nextOffset;
      if (currentTrackId) resolve(currentTrackId, { force: true });
    }

    const enabled = activeSettings.enabled !== false;
    if (lastEnabled == null) lastEnabled = enabled;
    if (enabled !== lastEnabled) {
      lastEnabled = enabled;
      if (currentTrackId) {
        if (!enabled) {
          resolveSeq += 1;
          store.setLyrics(null);
          store.setLyricsStatus('disabled');
        } else {
          resolve(currentTrackId, { force: true });
        }
      }
    }

    const nativeOpen = !!(state.ui && state.ui.nativeLyricsOpen);
    if (nativeOpen && !lastNativeOpen) {
      if (!publishCapturedForCurrent()) upgradeFromDom();
    }
    lastNativeOpen = nativeOpen;
  }

  function attach() {
    if (attached) return;
    attached = true;
    const state = store.get();
    const activeSettings = state.settings || {};
    lastOffsetMs = Number.isFinite(Number(activeSettings.offsetMs)) ? Math.round(Number(activeSettings.offsetMs)) : 0;
    lastEnabled = activeSettings.enabled !== false;
    lastNativeOpen = !!(state.ui && state.ui.nativeLyricsOpen);
    unsubscribe = store.subscribe(onState);

    // If the id is unknown and a payload was replayed before attach, attribute
    // the only candidate to the current DOM track (the page fetches lyrics for
    // the item it is displaying).
    if (state.track && !state.track.id && captured.size === 1) {
      const onlyId = captured.keys().next().value;
      const adopted = adoptTrackId(onlyId);
      if (adopted) return; // store notify re-enters onState and resolves
    }

    const key = resolutionKey(store.get().track);
    if (key) {
      currentTrackId = key;
      currentTrackObservedAt = Date.now();
      resolve(currentTrackId);
    }
  }

  function detach() {
    if (!attached) return;
    attached = false;
    resolveSeq += 1;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
  }

  /**
   * Local TTML import, exposed for the app shell (popup -> background -> here).
   * Replaces the visible document and seeds the cache so the next resolution
   * returns the imported file immediately.
   *
   * Resolves `{ok:false, error}` (never throws) for unusable input or when no
   * track is selected; the current document is left untouched on failure.
   *
   * @param {string} xmlText
   * @returns {Promise<{ok:true, lines:number, syncType:string}|{ok:false, error:string}>}
   */
  async function importTTML(xmlText) {
    try {
      const state = store.get();
      const trackId = resolutionKey(state.track);
      if (!trackId) return { ok: false, error: 'No track is currently playing' };
      if (typeof xmlText !== 'string' || !xmlText.trim()) {
        return { ok: false, error: 'Empty TTML payload' };
      }
      if (typeof SL.lyrics.parseTTML !== 'function') {
        return { ok: false, error: 'TTML parser unavailable' };
      }

      const doc = SL.lyrics.parseTTML(xmlText, { trackId, offsetMs: offsetMs() });
      if (!isDoc(doc)) return { ok: false, error: 'Could not parse TTML lyrics' };

      doc.source = 'ttml';
      doc.meta = { ...(doc.meta || {}), imported: true };

      // Invalidate anything in flight for this track so a late response cannot
      // overwrite the user's import.
      resolveSeq += 1;
      inflight = null;

      store.setLyrics(doc, 'ready');
      cacheDoc(doc);
      markAttempt('ttml-import');

      return { ok: true, lines: doc.lines.length, syncType: doc.syncType };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  SL.lyrics.attach = attach;
  SL.lyrics.detach = detach;
  SL.lyrics.capture = capture;
  SL.lyrics.importTTML = importTTML;
  SL.lyrics.getCaptured = (trackId) => captured.get(trackId) || null;
  SL.lyrics.resolveNow = (trackId) => resolve(trackId || currentTrackId, { force: true });
})();
