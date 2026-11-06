/**
 * Spicy Lyrics for Chrome — album-art background engine.
 *
 * Builds the full-bleed scenery behind the lyric column. The visual target is
 * the Spicetify "Beautiful Lyrics" / "Spicy Lyrics" desktop look: album art
 * that bleeds past the edges, heavy blur, slow Ken Burns drift, a palette wash
 * and grain, plus an optional sharp cover panel with a mirrored reflection.
 *
 * Styles (settings.backgroundStyle):
 *   artwork        blurred full-bleed cover + drift + vignette + grain
 *   artwork-sharp  that blur plus a sharp cover panel with a mirror reflection
 *   gradient       palette radial blobs drifting on a dark base
 *   solid          flat dark base tinted by the dominant palette colour
 *   video          the page's own <video> mirrored through one canvas
 *   image          chrome.storage.local['spicy.bgImage'] as the backdrop
 *
 * Costs: the blurred cover, blobs and panel are static layers moved by CSS
 * keyframes on the compositor. The only per-frame work here is the ~30fps video
 * canvas (owned by video-bg.js) and a throttled probe that decides whether the
 * page video is mirrorable. Nothing is re-created per frame and no layout is
 * read inside a paint path.
 *
 * Public surface:
 *   SL.background.create(stageEl) -> { el, setTrack(t), setSettings(s),
 *                                      tick(positionMs, isPlaying),
 *                                      destroy() }
 *   SL.background.videoState() -> { found, playing, width, height,
 *                                   mode: 'mirror'|'fallback' }
 *
 * The instance is internal to the overlay; overlay.js owns its lifecycle.
 */
(function () {
  'use strict';
  const SL = (globalThis.SL = globalThis.SL || {});
  if (SL.background) return;
  const util = SL.util;

  const PALETTE_CACHE_MAX = 40;
  /** url -> palette; Map order is used as a cheap LRU. */
  const paletteCache = new Map();
  const STYLES = ['artwork', 'artwork-sharp', 'gradient', 'solid', 'video', 'image'];
  const BG_IMAGE_KEY = (SL.store && SL.store.BG_IMAGE_KEY) || 'spicy.bgImage';
  const EMPTY_VIDEO_STATE = { found: false, playing: false, width: 0, height: 0, mode: 'fallback' };

  let observedVideoState = { ...EMPTY_VIDEO_STATE };

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
    return util.rgbToHex(util.lerp(a.r, b.r, t), util.lerp(a.g, b.g, t), util.lerp(a.b, b.b, t));
  }

  /** Stable palette from a track id/title; used before/without artwork. */
  function seedPalette(seed) {
    const h = (hashStr(seed) % 3600) / 3600;
    return {
      accent: hslHex(h, 0.62, 0.62),
      accent2: hslHex(h + 0.085, 0.74, 0.52),
      wash: hslHex(h + 0.02, 0.44, 0.3),
      base: hslHex(h + 0.5, 0.34, 0.12),
    };
  }

  const FALLBACK_PALETTE = seedPalette('spicy-lyrics');

  function cssUrl(url) {
    return 'url("' + String(url).replace(/["\\\n\r]/g, encodeURIComponent) + '")';
  }

  // ---------------------------------------------------------------------------
  // Palette extraction: one 32x32 canvas, quantised HSL buckets, LRU cache
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
      if (data[i + 3] < 180) continue;
      const hsl = util.rgbToHsl(r, g, b);
      if (hsl.l < 0.06) continue;
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
        (c) => Math.abs(((c.h - accent.h + 1.5) % 1) - 0.5) > 0.055 && c.s > 0.12
      ) ||
      vibrant[1] ||
      { h: accent.h + 0.09, s: accent.s, l: Math.max(0.28, accent.l - 0.1) };

    return {
      accent: hslHex(accent.h, util.clamp(accent.s, 0.44, 0.84), util.clamp(accent.l, 0.5, 0.68)),
      accent2: hslHex(accent2.h, util.clamp(accent2.s, 0.4, 0.86), util.clamp(accent2.l, 0.42, 0.6)),
      wash: hslHex(avg.h, util.clamp(avg.s, 0.22, 0.62), util.clamp(avg.l * 0.7, 0.16, 0.38)),
      base: hslHex(avg.h, 0.32, 0.12),
    };
  }

  function cachePalette(url, palette) {
    if (paletteCache.has(url)) paletteCache.delete(url);
    while (paletteCache.size >= PALETTE_CACHE_MAX) {
      paletteCache.delete(paletteCache.keys().next().value);
    }
    paletteCache.set(url, palette);
  }

  function extractPalette(url) {
    if (!url) return Promise.resolve(null);
    if (paletteCache.has(url)) {
      const cached = paletteCache.get(url);
      // Refresh LRU position.
      paletteCache.delete(url);
      paletteCache.set(url, cached);
      return Promise.resolve(cached);
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (value) cachePalette(url, value);
        resolve(value);
      };

      const img = new Image();
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
          finish(paletteFromPixels(ctx.getImageData(0, 0, size, size).data));
        } catch (err) {
          // Tainted by CORS: caller keeps the deterministic seed palette.
          finish(null);
        }
      };
      img.onerror = () => finish(null);
      img.src = url;
    });
  }

  // ---------------------------------------------------------------------------
  // Layer tree
  // ---------------------------------------------------------------------------

  const TEMPLATE =
    '<div class="slbg-base"></div>' +
    '<div class="slbg-art">' +
    '<div class="slbg-art-slot" data-slot="a"><div class="slbg-art-cover"></div></div>' +
    '<div class="slbg-art-slot" data-slot="b"><div class="slbg-art-cover"></div></div>' +
    '</div>' +
    '<div class="slbg-blobs">' +
    '<div class="slbg-blob slbg-blob-1"></div>' +
    '<div class="slbg-blob slbg-blob-2"></div>' +
    '<div class="slbg-blob slbg-blob-3"></div>' +
    '<div class="slbg-blob slbg-blob-4"></div>' +
    '</div>' +
    '<div class="slbg-video"></div>' +
    '<div class="slbg-scrim"></div>' +
    '<div class="slbg-wash"></div>' +
    '<div class="slbg-glow"></div>' +
    '<div class="slbg-vignette"></div>' +
    '<div class="slbg-sharp">' +
    '<div class="slbg-sharp-glow"></div>' +
    '<div class="slbg-sharp-cover"></div>' +
    '<div class="slbg-sharp-reflection"><div class="slbg-sharp-cover"></div></div>' +
    '</div>' +
    '<div class="slbg-lyric-scrim"></div>' +
    '<div class="slbg-grain"></div>';

  function create(stageEl) {
    const root = document.createElement('div');
    root.className = 'sl-bg slbg';
    root.setAttribute('aria-hidden', 'true');
    root.dataset.style = 'artwork';
    root.innerHTML = TEMPLATE;
    stageEl.prepend(root);

    const artSlots = Array.from(root.querySelectorAll('.slbg-art-slot')).map((el) => ({
      el,
      cover: el.querySelector('.slbg-art-cover'),
    }));
    const blobs = Array.from(root.querySelectorAll('.slbg-blob'));
    const videoHost = root.querySelector('.slbg-video');
    const sharpEl = root.querySelector('.slbg-sharp');
    const sharpGlow = root.querySelector('.slbg-sharp-glow');
    const sharpCover = root.querySelector('.slbg-sharp-cover');
    const sharpReflection = root.querySelector('.slbg-sharp-reflection .slbg-sharp-cover');

    let destroyed = false;
    let settings = {
      showBackground: true,
      backgroundStyle: 'artwork',
      backgroundMotion: true,
      backgroundBlur: 90,
      backgroundDim: 0.48,
      reduceMotion: false,
    };
    let requested = 'artwork';
    let effective = 'artwork';
    let track = null;
    let lastTrackKey = null;
    let palette = FALLBACK_PALETTE;
    let paletteSource = null;
    let bgImage = null;
    let bgImageState = 'idle';
    let bgImageTriedAt = 0;
    let paintedArtUrl = null;
    let activeSlot = 0;
    let paintSeq = 0;
    let mirror = null;
    let lastVideoFlag = null;
    let lastSettingsSig = '';
    let lastTickAt = 0;

    // -------------------------------------------------------------------------
    // Palette application
    // -------------------------------------------------------------------------

    function applyPalette(next) {
      const stage = stageEl.style;
      stage.setProperty('--sl-accent', next.accent);
      stage.setProperty('--sl-accent-2', next.accent2);
      stage.setProperty('--sl-accent-soft', withAlpha(next.accent, 0.42));
      stage.setProperty('--sl-accent-faint', withAlpha(next.accent, 0.16));
      stage.setProperty('--sl-base', next.base);
      stage.setProperty('--sl-hl-2', mixHex(next.accent, '#ffffff', 0.9));
      stage.setProperty('--sl-wash', withAlpha(next.wash, 0.55));

      const body = root.style;
      body.setProperty('--slbg-wash', withAlpha(next.wash, 0.55));
      body.setProperty('--slbg-glow', withAlpha(next.accent, 0.34));
      body.setProperty('--slbg-glow-2', withAlpha(next.accent2, 0.22));
      body.setProperty('--slbg-tint', withAlpha(next.wash, 0.72));
      body.setProperty('--slbg-base', next.base);
      const colors = [
        next.accent,
        next.accent2,
        mixHex(next.accent, next.accent2, 0.5),
        mixHex(next.accent, next.base, 0.45),
      ];
      blobs.forEach((blob, i) => blob.style.setProperty('--c', colors[i % colors.length]));
    }

    function currentTrackSeed() {
      const seed = track && (track.id || track.uri || track.title || track.artist);
      return seedPalette(seed || 'spicy-lyrics');
    }

    function updatePaletteSource() {
      const source =
        requested === 'image' && bgImage
          ? bgImage
          : (track && track.coverUrl) || '';
      if (source === paletteSource) return;
      paletteSource = source;
      const seed = currentTrackSeed();
      palette = seed;
      applyPalette(seed);
      if (!source) return;
      extractPalette(source).then((extracted) => {
        if (destroyed || paletteSource !== source || !extracted) return;
        palette = extracted;
        applyPalette(extracted);
      });
    }

    // -------------------------------------------------------------------------
    // Artwork layers + crossfade
    // -------------------------------------------------------------------------

    function paintArt(url) {
      if (url === paintedArtUrl) return;
      const first = paintedArtUrl === null;
      paintedArtUrl = url || '';

      const image = url ? cssUrl(url) : 'none';
      if (first) {
        const slot = artSlots[activeSlot];
        slot.cover.style.backgroundImage = image;
        slot.el.classList.toggle('has-art', !!url);
        slot.el.classList.add('is-active');
      } else {
        const nextIndex = 1 - activeSlot;
        const next = artSlots[nextIndex];
        const prev = artSlots[activeSlot];
        next.cover.style.backgroundImage = image;
        next.el.classList.toggle('has-art', !!url);
        // Start hidden so the opacity transition actually runs.
        next.el.classList.remove('is-active');
        const token = ++paintSeq;
        requestAnimationFrame(() => {
          if (destroyed || token !== paintSeq) return;
          next.el.classList.add('is-active');
          prev.el.classList.remove('is-active');
        });
        activeSlot = nextIndex;
      }

      sharpGlow.style.backgroundImage = image;
      sharpCover.style.backgroundImage = image;
      sharpReflection.style.backgroundImage = image;
      sharpEl.classList.toggle('has-art', !!url);
    }

    function desiredArtUrl() {
      if (!settings.showBackground) return '';
      if (effective === 'image') return bgImage || '';
      if (effective === 'gradient' || effective === 'solid') return '';
      return (track && track.coverUrl) || '';
    }

    function refreshArt() {
      const url = desiredArtUrl();
      if (url === paintedArtUrl) return;
      paintArt(url);
    }

    // -------------------------------------------------------------------------
    // Background image (custom upload)
    // -------------------------------------------------------------------------

    function readBgImage() {
      bgImageTriedAt = performance.now();
      bgImageState = 'loading';
      let storage = null;
      try {
        storage = globalThis.chrome && chrome.storage && chrome.storage.local;
      } catch (err) {
        storage = null;
      }
      if (!storage || typeof storage.get !== 'function') {
        bgImageState = 'missing';
        applyStyle();
        return;
      }
      let pending;
      try {
        pending = storage.get(BG_IMAGE_KEY);
      } catch (err) {
        bgImageState = 'missing';
        applyStyle();
        return;
      }
      Promise.resolve(pending)
        .then((got) => {
          if (destroyed) return;
          const value = got && got[BG_IMAGE_KEY];
          bgImageState = typeof value === 'string' && value ? 'ready' : 'missing';
          if (bgImageState === 'ready') bgImage = value;
          if (requested === 'image') applyStyle();
        })
        .catch(() => {
          if (destroyed) return;
          bgImageState = 'missing';
          if (requested === 'image') applyStyle();
        });
    }

    function onStorageChanged(changes, area) {
      if (destroyed || area !== 'local' || !changes || !changes[BG_IMAGE_KEY]) return;
      const value = changes[BG_IMAGE_KEY].newValue;
      bgImage = typeof value === 'string' && value ? value : null;
      bgImageState = bgImage ? 'ready' : 'missing';
      if (requested === 'image') applyStyle();
    }

    let storageListenerAttached = false;
    try {
      if (chrome && chrome.storage && chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
        chrome.storage.onChanged.addListener(onStorageChanged);
        storageListenerAttached = true;
      }
    } catch (err) {
      storageListenerAttached = false;
    }

    // -------------------------------------------------------------------------
    // Video mirror
    // -------------------------------------------------------------------------

    function writeVideoFlag(value) {
      if (value === lastVideoFlag) return;
      lastVideoFlag = value;
      try {
        document.documentElement.dataset.spicyVideo = value;
      } catch (err) {
        /* detached document */
      }
    }

    function onVideoState(next) {
      observedVideoState = next;
      const live = next.mode === 'mirror' && effective === 'video' && settings.showBackground;
      root.classList.toggle('is-video-live', live);
      writeVideoFlag(live ? 'mirror' : effective === 'video' ? 'fallback' : '');
    }

    function ensureMirror() {
      if (mirror || destroyed) return mirror;
      if (!SL.videoBg || typeof SL.videoBg.create !== 'function') return null;
      try {
        mirror = SL.videoBg.create(videoHost, { onState: onVideoState });
      } catch (err) {
        console.error('[spicy] video background unavailable', err);
        mirror = null;
      }
      return mirror;
    }

    function updateVideoMode(visible) {
      if (requested === 'video') ensureMirror();
      if (!mirror) {
        if (effective === 'video') onVideoState(EMPTY_VIDEO_STATE);
        return;
      }
      const active = requested === 'video' && settings.showBackground && visible;
      mirror.setActive(active);
      const mirroring = active && observedVideoState.mode === 'mirror';
      writeVideoFlag(effective === 'video' ? (mirroring ? 'mirror' : 'fallback') : '');
    }

    function stageIsVisible() {
      return stageEl.dataset.open === '1' && stageEl.dataset.waiting !== '1';
    }

    // -------------------------------------------------------------------------
    // Style resolution
    // -------------------------------------------------------------------------

    function applyStyle() {
      if (destroyed) return;
      if (!settings.showBackground) {
        effective = requested === 'image' && !bgImage ? 'artwork' : requested;
        root.dataset.style = effective;
        stageEl.dataset.bgstyle = effective;
        root.classList.add('is-bg-off');
        sharpEl.classList.remove('is-on');
        refreshArt();
        updateVideoMode(false);
        writeVideoFlag('');
        return;
      }

      effective = requested === 'image' && !bgImage ? 'artwork' : requested;
      root.dataset.style = effective;
      stageEl.dataset.bgstyle = effective;
      root.classList.remove('is-bg-off');
      sharpEl.classList.toggle('is-on', effective === 'artwork-sharp');
      // First time only; a missing image is retried from tick() on a slow
      // timer so an empty storage key cannot spin read -> applyStyle -> read.
      if (requested === 'image' && !bgImage && bgImageState === 'idle') readBgImage();
      updatePaletteSource();
      refreshArt();
      updateVideoMode(stageIsVisible());
    }

    // -------------------------------------------------------------------------
    // Public instance API
    // -------------------------------------------------------------------------

    function setTrack(nextTrack) {
      if (destroyed || !nextTrack) return;
      const key = [nextTrack.id || nextTrack.uri || '', nextTrack.coverUrl || ''].join('|');
      if (key === lastTrackKey) return;
      lastTrackKey = key;
      track = nextTrack;
      updatePaletteSource();
      refreshArt();
    }

    function setSettings(next) {
      if (destroyed || !next) return;
      const sig = [
        next.showBackground ? 1 : 0,
        next.backgroundStyle,
        next.backgroundMotion ? 1 : 0,
        Number(next.backgroundBlur),
        Number(next.backgroundDim),
        next.reduceMotion ? 1 : 0,
      ].join('|');
      if (sig === lastSettingsSig) return;
      lastSettingsSig = sig;

      settings = {
        showBackground: next.showBackground !== false,
        backgroundStyle: STYLES.includes(next.backgroundStyle) ? next.backgroundStyle : 'artwork',
        backgroundMotion: next.backgroundMotion !== false,
        backgroundBlur: Number(next.backgroundBlur) || 0,
        backgroundDim: Number(next.backgroundDim) || 0,
        reduceMotion: !!next.reduceMotion,
      };
      requested = settings.backgroundStyle;

      const blurPx = 4 + util.clamp(settings.backgroundBlur, 0, 200) * 0.92;
      const dimValue = util.clamp(settings.backgroundDim, 0, 0.95) * 0.72;
      root.style.setProperty('--slbg-blur', blurPx.toFixed(1) + 'px');
      root.style.setProperty('--slbg-dim', dimValue.toFixed(3));
      // Video keeps much more definition than artwork: the moving frames are
      // the point, so only a light blur is applied.
      root.style.setProperty(
        '--slbg-video-blur',
        util.clamp(3 + settings.backgroundBlur * 0.1, 2, 24).toFixed(0) + 'px'
      );
      const motion = settings.backgroundMotion && !settings.reduceMotion;
      root.classList.toggle('is-motion-off', !motion);

      applyStyle();
    }

    /**
     * Cheap probe driven by the overlay's frame loop: decides whether the page
     * video is worth mirroring. The video canvas draws itself from rVFC; this
     * only starts/stops it and retries a missing custom image.
     */
    function tick(positionMs, isPlaying) {
      if (destroyed) return;
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (now - lastTickAt < 250) return;
      lastTickAt = now;
      const visible = stageIsVisible();
      if (requested === 'video') updateVideoMode(visible);
      else if (mirror) mirror.setActive(false);
      if (
        requested === 'image' &&
        !bgImage &&
        bgImageState !== 'loading' &&
        now - bgImageTriedAt > 2000
      ) {
        readBgImage();
      }
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (mirror) {
        try {
          mirror.destroy();
        } catch (err) {
          /* ignore */
        }
        mirror = null;
      }
      if (storageListenerAttached) {
        try {
          chrome.storage.onChanged.removeListener(onStorageChanged);
        } catch (err) {
          /* ignore */
        }
        storageListenerAttached = false;
      }
      writeVideoFlag('');
      observedVideoState = { ...EMPTY_VIDEO_STATE };
      root.remove();
    }

    // -------------------------------------------------------------------------
    // Boot: paint the dark base immediately, then adopt current store state.
    // -------------------------------------------------------------------------

    applyPalette(FALLBACK_PALETTE);
    root.dataset.style = 'artwork';
    stageEl.dataset.bgstyle = 'artwork';

    let initial = null;
    try {
      initial = SL.store && typeof SL.store.get === 'function' ? SL.store.get() : null;
    } catch (err) {
      initial = null;
    }
    if (initial) {
      if (initial.settings) setSettings(initial.settings);
      if (initial.track) setTrack(initial.track);
    }
    if (requested === 'image' && bgImageState === 'idle') readBgImage();
    writeVideoFlag(requested === 'video' ? 'fallback' : '');

    return {
      el: root,
      setTrack,
      setSettings,
      tick,
      destroy,
    };
  }

  SL.background = {
    create,
    videoState: () => ({ ...observedVideoState }),
    STYLES,
  };
})();
