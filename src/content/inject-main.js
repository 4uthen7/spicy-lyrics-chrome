/**
 * MAIN-world injector. Runs at document_start, before Spotify's own scripts.
 *
 * Two jobs:
 *
 * 1. Sniff lyric fetches. `fetch` and `XMLHttpRequest` are wrapped just enough
 *    to clone the body of any `/color-lyrics/` response and postMessage it to
 *    the isolated world. The original call-through is always returned
 *    untouched, and every wrapper is wrapped in try/catch: this file must never
 *    throw into the page or change a Response.
 *
 * 2. Capture the page's own spclient auth context (bearer + App-Platform +
 *    Spotify-App-Version headers) and reuse it for the isolated world's
 *    fallback color-lyrics fetch. /get_access_token is 403-blocked for this
 *    build, so no token is minted here: only headers the page already sent are
 *    reused, and a 401 is reported as an error (the caller falls back to the
 *    sniffed payload / DOM scrape).
 *
 * Everything is feature-detected and fails soft.
 */
(function () {
  'use strict';
  try {
    const W = typeof window !== 'undefined' ? window : null;
    if (!W || W.__spicyLyricsInjector) return;
    W.__spicyLyricsInjector = true;

    const MAIN_SOURCE = 'spicy-main';
    const ISOLATED_SOURCE = 'spicy-isolated';
    const COLOR_LYRICS_RE = /\/color-lyrics\//i;
    const TRACK_ID_PATTERNS = [
      /\/color-lyrics\/(?:v\d+\/)?track\/([A-Za-z0-9]+)/i,
      /\/track\/([A-Za-z0-9]+)\/color-lyrics/i,
    ];
    const SPCLIENT_BASE = 'https://spclient.wg.spotify.com/color-lyrics/v2/track/';
    const SPCLIENT_RE = /^https?:\/\/spclient\.wg\.spotify\.com\//i;
    const ANY_TRACK_ID_RE = /\/track\/([A-Za-z0-9]{10,64})/;
    const AUTH_BY_TRACK_LIMIT = 32;

    /**
     * Headers the page used for its last spclient request. The 2026 build
     * validates App-Platform and Spotify-App-Version, so reuse both verbatim.
     * @type {{bearer:string, appPlatform:string, spotifyAppVersion:string, at:number}|null}
     */
    let lastAuth = null;
    /** @type {Map<string, object>} */
    const authByTrack = new Map();
    let requestCounter = 0;

    /**
     * Captures made before the isolated world attached its listener would be
     * lost (the page fetches lyrics before content scripts run at idle). Keep
     * the last payload per track and replay them when the bridge announces
     * itself.
     * @type {Map<string, object>}
     */
    const captureCache = new Map();
    const CAPTURE_CACHE_LIMIT = 16;

    function rememberCapture(trackId, format, payload, url) {
      captureCache.delete(trackId);
      captureCache.set(trackId, { trackId, format, payload, url, at: Date.now() });
      while (captureCache.size > CAPTURE_CACHE_LIMIT) {
        captureCache.delete(captureCache.keys().next().value);
      }
    }

    function trackIdFromUrl(url) {
      if (typeof url !== 'string') return null;
      for (const pattern of TRACK_ID_PATTERNS) {
        const match = pattern.exec(url);
        if (match) return match[1];
      }
      return null;
    }

    function isTtmlRequest(url) {
      return typeof url === 'string' && /[?&]format=ttml(?:&|$)/i.test(url);
    }

    function urlFromInput(input) {
      try {
        if (typeof input === 'string') return input;
        if (input && typeof input.url === 'string') return input.url;
        return String(input);
      } catch {
        return '';
      }
    }

    function post(payload) {
      try {
        W.postMessage(Object.assign({ source: MAIN_SOURCE }, payload, { at: Date.now() }), W.location.origin);
      } catch {
        /* page navigation can invalidate origin; ignore */
      }
    }

    function imageUrlFromUrl(url) {
      if (typeof url !== 'string') return '';
      const match = /\/image\/([^/?#]+)/.exec(url);
      if (!match) return '';
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    }

    function postCapture(trackId, format, payload, url) {
      rememberCapture(trackId, format, payload, url);
      post({
        type: 'color-lyrics',
        trackId,
        format,
        payload,
        url: typeof url === 'string' ? url : undefined,
        imageUrl: imageUrlFromUrl(url) || undefined,
      });
    }

    /** Normalizes Headers / array-of-pairs / plain-object headers to lowercase. */
    function headersToLookup(headers) {
      const lookup = Object.create(null);
      try {
        if (!headers) return lookup;
        if (typeof headers.forEach === 'function') {
          headers.forEach((value, key) => {
            lookup[String(key).toLowerCase()] = String(value);
          });
        } else if (Array.isArray(headers)) {
          for (const pair of headers) {
            if (pair && pair.length >= 2) lookup[String(pair[0]).toLowerCase()] = String(pair[1]);
          }
        } else if (typeof headers === 'object') {
          for (const key of Object.keys(headers)) lookup[key.toLowerCase()] = String(headers[key]);
        }
      } catch {
        /* ignore malformed header objects */
      }
      return lookup;
    }

    function trackIdFromAnyUrl(url) {
      if (typeof url !== 'string') return null;
      const match = ANY_TRACK_ID_RE.exec(url);
      return match ? match[1] : null;
    }

    /** Records the bearer/version headers of a page spclient request. */
    function captureAuth(url, headers) {
      try {
        if (typeof url !== 'string' || !SPCLIENT_RE.test(url)) return;
        const lookup = headersToLookup(headers);
        const authorization = lookup['authorization'] || '';
        const bearerMatch = /^Bearer\s+(.+)$/i.exec(authorization);
        if (!bearerMatch) return;
        const auth = {
          bearer: bearerMatch[1].trim(),
          appPlatform: lookup['app-platform'] || 'WebPlayer',
          spotifyAppVersion: lookup['spotify-app-version'] || '',
          at: Date.now(),
        };
        lastAuth = auth;
        const trackId = trackIdFromAnyUrl(url);
        if (trackId) {
          authByTrack.delete(trackId);
          authByTrack.set(trackId, auth);
          while (authByTrack.size > AUTH_BY_TRACK_LIMIT) {
            authByTrack.delete(authByTrack.keys().next().value);
          }
        }
      } catch {
        /* never let auth capture break the request */
      }
    }

    // -------------------------------------------------------------------------
    // 1a. fetch sniffer
    // -------------------------------------------------------------------------

    async function sniffFetchResponse(response, url) {
      try {
        if (!response || !response.ok || typeof response.clone !== 'function') return;
        const trackId = trackIdFromUrl(url);
        if (!trackId) return;
        if (isTtmlRequest(url)) {
          const text = await response.clone().text();
          if (text && text.trim()) postCapture(trackId, 'ttml', text, url);
        } else {
          const json = await response.clone().json();
          if (json) postCapture(trackId, 'json', json, url);
        }
      } catch {
        /* body already consumed, not JSON, aborted: all fine */
      }
    }

    const nativeFetch = W.fetch;
    if (typeof nativeFetch === 'function' && !nativeFetch.__spicyWrapped) {
      const wrappedFetch = function fetch(input, init) {
        const url = urlFromInput(input);
        try {
          if (url && SPCLIENT_RE.test(url)) {
            captureAuth(url, (init && init.headers) || (input && input.headers));
          }
        } catch {
          /* ignore */
        }
        const promise = nativeFetch.apply(this, arguments);
        try {
          if (url && COLOR_LYRICS_RE.test(url)) {
            promise.then(
              (response) => sniffFetchResponse(response, url),
              () => {},
            );
          }
        } catch {
          /* never break the caller */
        }
        return promise;
      };
      try {
        Object.defineProperty(wrappedFetch, '__spicyWrapped', { value: true });
        W.fetch = wrappedFetch;
      } catch {
        /* non-writable fetch: keep native */
      }
    }

    // -------------------------------------------------------------------------
    // 1b. XHR sniffer
    // -------------------------------------------------------------------------

    try {
      const proto = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
      if (proto && !proto.__spicyWrapped) {
        const nativeOpen = proto.open;
        const nativeSend = proto.send;
        const nativeSetRequestHeader = proto.setRequestHeader;

        proto.open = function open(method, url) {
          try {
            this.__spicyLyricsUrl = urlFromInput(url);
            this.__spicyLyricsHeaders = Object.create(null);
          } catch {
            /* ignore */
          }
          return nativeOpen.apply(this, arguments);
        };

        if (typeof nativeSetRequestHeader === 'function') {
          proto.setRequestHeader = function setRequestHeader(name, value) {
            try {
              if (!this.__spicyLyricsHeaders) this.__spicyLyricsHeaders = Object.create(null);
              this.__spicyLyricsHeaders[String(name).toLowerCase()] = String(value);
            } catch {
              /* ignore */
            }
            return nativeSetRequestHeader.apply(this, arguments);
          };
        }

        proto.send = function send() {
          try {
            const url = this.__spicyLyricsUrl;
            if (url && SPCLIENT_RE.test(url)) captureAuth(url, this.__spicyLyricsHeaders);
            if (url && COLOR_LYRICS_RE.test(url)) {
              this.addEventListener('loadend', () => {
                try {
                  if (this.status < 200 || this.status >= 300) return;
                  const trackId = trackIdFromUrl(url);
                  if (!trackId) return;
                  const ttml = isTtmlRequest(url);
                  let payload = null;
                  if (ttml) {
                    if (this.responseType === '' || this.responseType === 'text') payload = this.responseText;
                  } else if (this.responseType === 'json') {
                    payload = this.response;
                  } else if (this.responseType === '' || this.responseType === 'text') {
                    payload = JSON.parse(this.responseText);
                  }
                  if (payload) postCapture(trackId, ttml ? 'ttml' : 'json', payload, url);
                } catch {
                  /* opaque or binary response: skip */
                }
              });
            }
          } catch {
            /* ignore */
          }
          return nativeSend.apply(this, arguments);
        };

        try {
          Object.defineProperty(proto, '__spicyWrapped', { value: true, configurable: true });
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* XHR unavailable or frozen */
    }

    // -------------------------------------------------------------------------
    // 2. direct spclient fetch service (reuses the page's captured auth)
    // -------------------------------------------------------------------------

    function authForTrack(trackId) {
      return authByTrack.get(trackId) || lastAuth;
    }

    async function fetchDirectLyrics(trackId) {
      const auth = authForTrack(trackId);
      if (!auth || !auth.bearer) {
        throw new Error('no-captured-auth');
      }
      // Bare third-party variant: no productType, no vocalRemoval; the gateway
      // injects market for authenticated sessions.
      const url = SPCLIENT_BASE + encodeURIComponent(trackId) + '?format=json&market=from_token';
      const buildHeaders = (bearer) => {
        const headers = {
          Accept: 'application/json',
          Authorization: 'Bearer ' + bearer,
          'App-Platform': auth.appPlatform || 'WebPlayer',
        };
        if (auth.spotifyAppVersion) headers['Spotify-App-Version'] = auth.spotifyAppVersion;
        return headers;
      };

      let response = await W.fetch(url, { credentials: 'include', headers: buildHeaders(auth.bearer) });
      if (response && response.status === 401) {
        // The page may have refreshed its token since we captured it; retry
        // once with the newest captured bearer, otherwise report the failure.
        const newer = lastAuth;
        if (!newer || !newer.bearer || newer.bearer === auth.bearer) {
          throw new Error('lyrics HTTP 401 (captured token rejected)');
        }
        response = await W.fetch(url, { credentials: 'include', headers: buildHeaders(newer.bearer) });
      }
      if (!response) throw new Error('lyrics fetch failed');
      if (response.status === 204 || response.status === 404) return null;
      if (!response.ok) throw new Error('lyrics HTTP ' + response.status);
      return response.json();
    }

    function postDirectResult(payload) {
      post(Object.assign({ type: 'direct-lyrics-result' }, payload));
    }

    function handleIsolatedMessage(event) {
      try {
        if (event.source !== W) return;
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        if (data.source !== ISOLATED_SOURCE) return;

        // The isolated bridge announces itself once it has a listener; replay
        // every payload sniffed before that point.
        if (data.type === 'bridge-ready') {
          // Snapshot first: postCapture() re-inserts into captureCache, and
          // mutating a Map while iterating its values would never terminate.
          for (const entry of Array.from(captureCache.values())) {
            postCapture(entry.trackId, entry.format, entry.payload, entry.url);
          }
          return;
        }

        if (data.type !== 'request-direct-lyrics') return;

        const nonce = typeof data.nonce === 'string' ? data.nonce : null;
        if (!nonce) return;
        const trackId = typeof data.trackId === 'string' && /^[A-Za-z0-9]{1,64}$/.test(data.trackId)
          ? data.trackId
          : null;
        if (!trackId) {
          postDirectResult({ nonce, trackId: null, ok: false, error: 'bad-track-id' });
          return;
        }

        fetchDirectLyrics(trackId).then(
          (json) => postDirectResult({ nonce, trackId, ok: !!json, json: json || null }),
          (err) => postDirectResult({ nonce, trackId, ok: false, error: String((err && err.message) || err) }),
        );
      } catch (err) {
        requestCounter += 1;
        postDirectResult({
          nonce: null,
          trackId: null,
          ok: false,
          error: 'request-handler-failed-' + requestCounter + ':' + String((err && err.message) || err),
        });
      }
    }

    W.addEventListener('message', handleIsolatedMessage);
  } catch {
    // Absolutely never surface an injector failure into the page.
  }
})();
