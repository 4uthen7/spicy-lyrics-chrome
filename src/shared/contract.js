/**
 * Spicy Lyrics for Chrome — shared contract.
 *
 * Loaded first in the isolated world of every matched page. Everything in the
 * extension is a plain IIFE that hangs off `globalThis.SL`; there is no module
 * loader and no build step. Content-script load order guarantees that this file
 * runs before any consumer.
 *
 * ---------------------------------------------------------------------------
 * DATA CONTRACTS
 * ---------------------------------------------------------------------------
 *
 * @typedef {Object} LyricWord
 * @property {string} text       Display text, already split at syllable bounds.
 * @property {number} startMs    Absolute start, already offset-adjusted.
 * @property {number} endMs      Absolute end (> startMs).
 * @property {boolean} [partOfPrevious]  True when this fragment continues the
 *   previous displayed word (syllable split), used to avoid extra spacing.
 *
 * @typedef {Object} LyricLine
 * @property {string} text        Full line text, used for a11y + fallback.
 * @property {number} startMs
 * @property {number} endMs
 * @property {LyricWord[]} words  Empty for line-synced/static lines.
 * @property {string} [romanized] Precomputed romanization, optional.
 * @property {'center'|'left'|'right'} align
 * @property {boolean} isBackground  Background/ad-lib vocal (rendered smaller).
 * @property {boolean} [isInterlude] Instrumental marker (rendered as dots).
 * @property {boolean} [isUnsynced]  No usable timing; rendered as a plain line.
 *
 * @typedef {Object} LyricsDoc
 * @property {string} trackId
 * @property {'word'|'line'|'static'} syncType
 * @property {LyricLine[]} lines   Sorted, de-overlapped, offset applied.
 * @property {'spclient'|'dom'|'ttml'|'cache'} source
 * @property {number} fetchedAt    Date.now() of acquisition.
 * @property {number} offsetMs     Offset applied when parsing (informational).
 * @property {Object} [meta]       e.g. { provider, language, romanizationEnabled }
 *
 * @typedef {Object} TrackInfo
 * @property {string|null} id
 * @property {string|null} uri
 * @property {string} title
 * @property {string} artist
 * @property {string} album
 * @property {string} coverUrl
 * @property {number} durationMs
 * @property {string|null} trackUrl
 *
 * @typedef {Object} Settings
 * @property {boolean} enabled
 * @property {boolean} autoOpen
 * @property {'cinema'|'panel'} mode
 * @property {boolean} showBackground
 * @property {number}  backgroundBlur
 * @property {number}  backgroundDim
 * @property {boolean} minimalMode
 * @property {boolean} showRomanization
 * @property {number}  offsetMs
 * @property {number}  fontSize
 * @property {number}  lineGap
 * @property {'gradient'|'solid'} wordHighlight
 * @property {boolean} hideCredit
 * @property {boolean} reduceMotion
 * @property {boolean} showInterludeDots
 */
(function () {
  'use strict';
  const SL = (globalThis.SL = globalThis.SL || {});
  if (SL.contract) return;

  const contract = {
    version: '1.0.0',
  };

  /** Tiny synchronous event bus. Listeners are never awaited. */
  class Bus {
    constructor() {
      this._map = new Map();
    }
    on(type, fn) {
      let set = this._map.get(type);
      if (!set) this._map.set(type, (set = new Set()));
      set.add(fn);
      return () => this.off(type, fn);
    }
    once(type, fn) {
      const off = this.on(type, (payload) => {
        off();
        fn(payload);
      });
      return off;
    }
    off(type, fn) {
      const set = this._map.get(type);
      if (set) set.delete(fn);
    }
    emit(type, payload) {
      const set = this._map.get(type);
      if (set) {
        for (const fn of Array.from(set)) {
          try {
            fn(payload);
          } catch (err) {
            console.error('[spicy] bus listener failed', type, err);
          }
        }
      }
      const wildcard = this._map.get('*');
      if (wildcard) {
        for (const fn of Array.from(wildcard)) {
          try {
            fn({ type, payload });
          } catch (err) {
            console.error('[spicy] bus wildcard failed', err);
          }
        }
      }
    }
  }

  const util = {
    clamp(v, lo, hi) {
      return v < lo ? lo : v > hi ? hi : v;
    },
    lerp(a, b, t) {
      return a + (b - a) * t;
    },
    smoothstep(t) {
      t = util.clamp(t, 0, 1);
      return t * t * (3 - 2 * t);
    },
    /** parse "1:23" / "1:02:03" / "83" to ms. Returns null when unparseable. */
    parseClock(str) {
      if (str == null) return null;
      const s = String(str).trim();
      if (!s) return null;
      const parts = s.split(':');
      if (parts.length > 3) return null;
      let total = 0;
      for (const part of parts) {
        if (!/^\d+(?:\.\d+)?$/.test(part)) return null;
        total = total * 60 + parseFloat(part);
      }
      return Math.round(total * 1000);
    },
    formatClock(ms) {
      if (!isFinite(ms) || ms < 0) ms = 0;
      const total = Math.floor(ms / 1000);
      const m = Math.floor(total / 60);
      const s = total % 60;
      return m + ':' + String(s).padStart(2, '0');
    },
    /** #rrggbb / #rgb -> {r,g,b} */
    hexToRgb(hex) {
      if (!hex) return null;
      let h = String(hex).trim().replace('#', '');
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      if (!/^[0-9a-f]{6}$/i.test(h)) return null;
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
      };
    },
    rgbToHex(r, g, b) {
      const c = (v) => util.clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
      return '#' + c(r) + c(g) + c(b);
    },
    rgbToHsl(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      let h = 0, s = 0;
      const l = (max + min) / 2;
      if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;
      }
      return { h, s, l };
    },
    hslToRgb(h, s, l) {
      if (s === 0) {
        const v = Math.round(l * 255);
        return { r: v, g: v, b: v };
      }
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      const hue = (t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      return {
        r: Math.round(hue(h + 1 / 3) * 255),
        g: Math.round(hue(h) * 255),
        b: Math.round(hue(h - 1 / 3) * 255),
      };
    },
    /** Deterministic-ish ms since navigation start, used for animation clocks. */
    now() {
      return typeof performance !== 'undefined' ? performance.now() : Date.now();
    },
    raf(fn) {
      return requestAnimationFrame(fn);
    },
    /** Coalesces calls into one animation frame. */
    frameThrottle(fn) {
      let scheduled = false;
      let lastArgs = null;
      const wrapped = (...args) => {
        lastArgs = args;
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          fn(...lastArgs);
        });
      };
      return wrapped;
    },
    debounce(fn, wait) {
      let t = 0;
      return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), wait);
      };
    },
    /** Strips Spotify's trailing " • " decorations and normalizes whitespace. */
    cleanText(str) {
      return String(str == null ? '' : str).replace(/\s+/g, ' ').trim();
    },
    basename(url) {
      try {
        return new URL(url).pathname.split('/').pop() || '';
      } catch {
        return '';
      }
    },
  };

  SL.contract = contract;
  SL.bus = new Bus();
  SL.util = util;
  SL.log = (...args) => {
    if (SL.DEBUG) console.log('[spicy]', ...args);
  };
  SL.DEBUG = false;
})();
