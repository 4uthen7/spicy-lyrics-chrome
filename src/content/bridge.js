/**
 * Isolated-world side of the MAIN-world bridge.
 *
 * `inject-main.js` runs in the page world and cannot touch `chrome.*`; this
 * module receives its postMessage traffic, validates it, and feeds the lyrics
 * resolver. It also exposes the request/response path to the authenticated
 * spclient fetch: `requestDirectLyrics(trackId)` posts a nonce-tagged request
 * to the MAIN world and resolves with the parsed LyricsDoc (or null) within 6s.
 *
 * Security/identity checks: every message is accepted only when it came from
 * this window (`event.source === window`) and is tagged `source: 'spicy-main'`.
 */
(function () {
  'use strict';
  const SL = (globalThis.SL = globalThis.SL || {});
  if (SL.bridge) return;

  const MAIN_SOURCE = 'spicy-main';
  const ISOLATED_SOURCE = 'spicy-isolated';
  const DIRECT_TIMEOUT_MS = 6000;
  const TRACK_ID_RE = /^[A-Za-z0-9]{1,64}$/;

  const pending = new Map();
  let started = false;
  let nonceCounter = 0;

  function makeNonce() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch {
      /* fall through */
    }
    nonceCounter += 1;
    return 'sl-' + Date.now().toString(36) + '-' + nonceCounter + '-' + Math.random().toString(36).slice(2);
  }

  function currentOffsetMs() {
    try {
      const state = SL.store && SL.store.get ? SL.store.get() : null;
      const value = Number(state && state.settings && state.settings.offsetMs);
      return Number.isFinite(value) ? Math.round(value) : 0;
    } catch {
      return 0;
    }
  }

  function settle(nonce, doc) {
    const entry = pending.get(nonce);
    if (!entry) return;
    pending.delete(nonce);
    clearTimeout(entry.timer);
    try {
      entry.resolve(doc);
    } catch {
      /* a resolver throwing must not break the message listener */
    }
  }

  function onMessage(event) {
    try {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || typeof data !== 'object' || data.source !== MAIN_SOURCE) return;

      if (data.type === 'color-lyrics') {
        const trackId = typeof data.trackId === 'string' ? data.trackId : '';
        if (!TRACK_ID_RE.test(trackId)) return;
        if (SL.lyrics && typeof SL.lyrics.capture === 'function') {
          SL.lyrics.capture(trackId, data);
        }
        return;
      }

      if (data.type === 'direct-lyrics-result') {
        if (typeof data.nonce !== 'string') return;
        const entry = pending.get(data.nonce);
        if (!entry) return;
        let doc = null;
        if (data.ok && data.json && SL.lyrics && typeof SL.lyrics.parseColorLyrics === 'function') {
          try {
            doc = SL.lyrics.parseColorLyrics(data.json, {
              trackId: entry.trackId,
              offsetMs: entry.offsetMs,
              source: 'spclient',
            });
          } catch {
            doc = null;
          }
        }
        settle(data.nonce, doc);
      }
    } catch (err) {
      SL.log && SL.log('bridge message failed', err);
    }
  }

  function start() {
    if (started) return;
    started = true;
    window.addEventListener('message', onMessage);
    // Ask the injector to replay payloads it sniffed before this listener
    // existed (the page fetches lyrics before content scripts reach idle).
    try {
      window.postMessage({ source: ISOLATED_SOURCE, type: 'bridge-ready' }, window.location.origin);
    } catch {
      /* ignore */
    }
  }

  /**
   * @param {string} trackId
   * @returns {Promise<SL.LyricsDoc|null>}
   */
  function requestDirectLyrics(trackId) {
    return new Promise((resolve) => {
      if (!started) start();
      if (typeof trackId !== 'string' || !TRACK_ID_RE.test(trackId)) {
        resolve(null);
        return;
      }

      const nonce = makeNonce();
      const entry = {
        trackId,
        offsetMs: currentOffsetMs(),
        resolve,
        timer: 0,
      };
      entry.timer = setTimeout(() => settle(nonce, null), DIRECT_TIMEOUT_MS);
      pending.set(nonce, entry);

      try {
        window.postMessage(
          {
            source: ISOLATED_SOURCE,
            type: 'request-direct-lyrics',
            trackId,
            offsetMs: entry.offsetMs,
            nonce,
          },
          window.location.origin,
        );
      } catch {
        settle(nonce, null);
      }
    });
  }

  function stop() {
    if (!started) return;
    started = false;
    window.removeEventListener('message', onMessage);
    for (const nonce of Array.from(pending.keys())) settle(nonce, null);
  }

  SL.bridge = {
    MAIN_SOURCE,
    ISOLATED_SOURCE,
    DIRECT_TIMEOUT_MS,
    start,
    stop,
    requestDirectLyrics,
  };
})();
