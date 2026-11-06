/**
 * Spicy Lyrics for Chrome — dynamic album-art background.
 *
 * Renders the full-bleed scenery behind the lyrics:
 *   - a heavily blurred, slowly drifting copy of the album art
 *   - three huge, saturated colour blobs sampled from that art (palette)
 *   - a dimming scrim, a colour wash, a vignette and a light film grain
 *
 * Everything is transform/opacity/filter only; the drifting layers are driven
 * by CSS keyframes so the renderer's rAF loop never touches them. Track changes
 * crossfade by painting the inactive slot and flipping an `is-active` class.
 *
 * The public surface is `SL.background.create(stageEl)` which returns
 * `{ el, setTrack(track), setSettings(settings), destroy() }`. It is internal to
 * the overlay and not part of the documented extension API.
 */
(function () {
  'use strict';
  const SL = (globalThis.SL = globalThis.SL || {});
  if (SL.background) return;
  const util = SL.util;

  const PALETTE_CACHE_MAX = 10;
  const paletteCache = new Map();

  // ---------------------------------------------------------------------------
  // Colour helpers
  // ---------------------------------------------------------------------------

  function hashStr(input) {
    const str = String(input == null ? '' : input);
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function hslHex(h, s, l) {
    const rgb = util.hslToRgb(((h % 1) + 1) % 1, util.clamp(s, 0, 1), util.clamp(l, 0, 1));
    return util.rgbToHex(rgb.r, rgb.g, rgb.b);
  }

  function withAlpha(hex, alpha) {
    const rgb = util.hexToRgb(hex);
    if (!rgb) return 'rgba(255,255,255,' + alpha + ')';
    return 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + alpha + ')';
  }

  function mixHex(from, to, t) {
    const a = util.hexToRgb(from);
    const b = util.hexToRgb(to);
    if (!a || !b) return from;
    return util.rgbToHex(
      util.lerp(a.r, b.r, t),
      util.lerp(a.g, b.g, t),
      util.lerp(a.b, b.b, t)
    );
  }

  /** Deterministic palette from a track id, used before/without artwork. */
  function seedPalette(seed) {
    const h = (hashStr(seed) % 3600) / 3600;
    return {
      accent: hslHex(h, 0.6, 0.63),
      accent2: hslHex(h + 0.085, 0.72, 0.52),
      wash: hslHex(h + 0.02, 0.42, 0.3),
      base: hslHex(h + 0.5, 0.32, 0.13),
    };
  }

  /** CSS-safe url() token for a background-image. */
  function cssUrl(url) {
    return 'url("' + String(url).replace(/["\\\n\r]/g, encodeURIComponent) + '")';
  }

  // ---------------------------------------------------------------------------
  // Palette extraction (32x32 canvas, quantised buckets)
  // ---------------------------------------------------------------------------

  function paletteFromPixels(data) {
    const buckets = new Map();
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let count = 0;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a < 180) continue;
      const hsl = util.rgbToHsl(r, g, b);
      // Skip almost-black pixels: they carry no useful hue for the wash.
      if (hsl.l < 0.07) continue;
      sumR += r;
      sumG += g;
      sumB += b;
      count++;
      const key =
        (Math.round(hsl.h * 24) & 31) |
        ((Math.round(hsl.s * 7) & 7) << 5) |
        ((Math.round(hsl.l * 7) & 7) << 8);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { h: hsl.h, s: hsl.s, l: hsl.l, count: 0, weight: 0 };
        buckets.set(key, bucket);
      }
      bucket.count++;
      bucket.weight += 0.4 + hsl.s * 2.2;
    }

    if (!count) return null;

    const avg = util.rgbToHsl(sumR / count, sumG / count, sumB / count);
    const ranked = Array.from(buckets.values())
      .map((b) => ({
        h: b.h,
        s: b.s,
        l: b.l,
        score: b.weight * (0.55 + b.s) * (1 - Math.abs(b.l - 0.52) * 0.9),
      }))
      .sort((a, b) => b.score - a.score);

    const vibrant = ranked.filter((c) => c.s > 0.16 && c.l > 0.1);
    const accent = vibrant[0] || ranked[0] || { h: avg.h, s: 0.55, l: 0.6 };
    const accent2 =
      vibrant.find(
        (c) =>
          Math.abs(((c.h - accent.h + 1.5) % 1) - 0.5) > 0.055 && c.s > 0.12
      ) ||
      vibrant[1] ||
      { h: accent.h + 0.09, s: accent.s, l: Math.max(0.28, accent.l - 0.1) };

    return {
      accent: hslHex(accent.h, util.clamp(accent.s, 0.42, 0.82), util.clamp(accent.l, 0.5, 0.68)),
      accent2: hslHex(accent2.h, util.clamp(accent2.s, 0.4, 0.85), util.clamp(accent2.l, 0.42, 0.6)),
      wash: hslHex(avg.h, util.clamp(avg.s, 0.22, 0.6), util.clamp(avg.l * 0.7, 0.16, 0.36)),
      base: hslHex(avg.h, 0.3, 0.11),
    };
  }

  function extractPalette(url) {
    if (!url) return Promise.resolve(null);
    if (paletteCache.has(url)) return Promise.resolve(paletteCache.get(url));

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (value) {
          if (paletteCache.size >= PALETTE_CACHE_MAX) {
            paletteCache.delete(paletteCache.keys().next().value);
          }
          paletteCache.set(url, value);
        }
        resolve(value);
      };

      const img = new Image();
      // Works for data: URLs, fails gracefully (taint/CORS) for remote art.
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      const timer = setTimeout(() => finish(null), 4000);

      img.onload = () => {
        try {
          const size = 32;
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          const side = Math.min(img.naturalWidth || size, img.naturalHeight || size);
          if (!ctx || !side) {
            finish(null);
            return;
          }
          ctx.drawImage(
            img,
            ((img.naturalWidth || size) - side) / 2,
            ((img.naturalHeight || size) - side) / 2,
            side,
            side,
            0,
            0,
            size,
            size
          );
          const data = ctx.getImageData(0, 0, size, size).data;
          finish(paletteFromPixels(data));
        } catch (err) {
          // Tainted canvas / decode failure — caller falls back to the seed.
          finish(null);
        }
      };
      img.onerror = () => finish(null);
      img.src = url;
    });
  }

  // ---------------------------------------------------------------------------
  // Instance
  // ---------------------------------------------------------------------------

  const SLOT_HTML =
    '<div class="sl-bg-cover"></div>' +
    '<div class="sl-blob sl-blob-1"></div>' +
    '<div class="sl-blob sl-blob-2"></div>' +
    '<div class="sl-blob sl-blob-3"></div>';

  const CHROME_HTML =
    '<div class="sl-bg-scrim"></div>' +
    '<div class="sl-bg-wash"></div>' +
    '<div class="sl-bg-vignette"></div>' +
    '<div class="sl-bg-grain"></div>';

  const FALLBACK_PALETTE = seedPalette('spicy-lyrics');

  function create(stageEl) {
    const el = document.createElement('div');
    el.className = 'sl-bg';
    el.setAttribute('aria-hidden', 'true');

    const slots = ['a', 'b'].map((id) => {
      const slot = document.createElement('div');
      slot.className = 'sl-bg-slot';
      slot.dataset.slot = id;
      slot.innerHTML = SLOT_HTML;
      el.appendChild(slot);
      return {
        el: slot,
        cover: slot.querySelector('.sl-bg-cover'),
        blobs: Array.from(slot.querySelectorAll('.sl-blob')),
      };
    });
    el.insertAdjacentHTML('beforeend', CHROME_HTML);
    stageEl.prepend(el);

    let active = 0;
    let lastKey = null;
    let lastSettingsSig = '';
    let destroyed = false;

    function applyPalette(palette) {
      const target = stageEl.style;
      target.setProperty('--sl-accent', palette.accent);
      target.setProperty('--sl-accent-2', palette.accent2);
      target.setProperty('--sl-accent-soft', withAlpha(palette.accent, 0.42));
      target.setProperty('--sl-accent-faint', withAlpha(palette.accent, 0.16));
      target.setProperty('--sl-base', palette.base);
      target.setProperty('--sl-hl-2', mixHex(palette.accent, '#ffffff', 0.9));
      el.style.setProperty('--sl-wash', withAlpha(palette.wash, 0.55));
    }

    function paintSlot(slot, track, palette) {
      const hasArt = !!(track && track.coverUrl);
      if (hasArt) {
        slot.cover.style.backgroundImage = cssUrl(track.coverUrl);
        slot.el.classList.add('has-art');
      } else {
        slot.cover.style.backgroundImage = 'none';
        slot.el.classList.remove('has-art');
      }
      const colors = [palette.accent, palette.accent2, palette.wash];
      slot.blobs.forEach((blob, i) => {
        blob.style.setProperty('--b', colors[i % colors.length]);
      });
      // Restart the drift so a fresh track does not pop mid-cycle.
      void slot.el.offsetWidth;
    }

    function setTrack(track) {
      if (destroyed) return;
      const key = track ? track.coverUrl || track.id || track.title || '' : '';
      if (key === lastKey) return;
      lastKey = key;

      const seed = seedPalette(
        track && (track.id || track.uri || track.title || track.artist) || 'spicy-lyrics'
      );
      const hasArt = !!(track && track.coverUrl);
      applyPalette(hasArt ? seed : FALLBACK_PALETTE);

      const next = slots[1 - active];
      paintSlot(next, track, seed);
      requestAnimationFrame(() => {
        if (destroyed) return;
        next.el.classList.add('is-active');
        slots[active].el.classList.remove('is-active');
        active = 1 - active;
        if (hasArt && track.coverUrl) {
          const requestKey = key;
          const slot = next;
          extractPalette(track.coverUrl).then((palette) => {
            if (destroyed || lastKey !== requestKey || !palette) return;
            applyPalette(palette);
            paintSlot(slot, track, palette);
          });
        }
      });
    }

    function setSettings(settings) {
      if (destroyed || !settings) return;
      const sig = [
        settings.showBackground ? 1 : 0,
        settings.backgroundBlur,
        settings.backgroundDim,
        settings.reduceMotion ? 1 : 0,
      ].join('|');
      if (sig === lastSettingsSig) return;
      lastSettingsSig = sig;
      const blurPx = 4 + util.clamp(settings.backgroundBlur, 0, 200) * 0.92;
      el.style.setProperty('--sl-bg-blur', blurPx.toFixed(1) + 'px');
      // Map the stored 0..0.95 dim to a slightly gentler scrim so the default
      // (0.62) keeps the artwork's colour instead of flattening it to grey.
      el.style.setProperty(
        '--sl-bg-dim',
        String(util.clamp(settings.backgroundDim, 0, 0.95) * 0.72)
      );
      el.classList.toggle('is-background-off', !settings.showBackground);
      el.classList.toggle('is-motion-off', !!settings.reduceMotion);
    }

    function destroy() {
      destroyed = true;
      el.remove();
    }

    // Start with a stable dark wash so the first painted frame already has depth.
    applyPalette(FALLBACK_PALETTE);
    slots[0].el.classList.add('is-active');

    return { el, setTrack, setSettings, destroy };
  }

  SL.background = { create };
})();
