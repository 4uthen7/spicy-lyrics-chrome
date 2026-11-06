/**
 * Spicy Lyrics for Chrome — page-video mirror.
 *
 * Spotify renders a <video> when the current item is a music video or a video
 * podcast. The extension cannot move or pause it, so the background style
 * 'video' mirrors its frames into one canvas with drawImage (cover-cropped) and
 * puts that canvas in the overlay. A canvas fed by a cross-origin video is
 * tainted, which is fine: the element is displayed directly and no pixel is
 * ever read back (no getImageData, no toDataURL).
 *
 * Detection is read-only and defensive:
 *   - a <video> must have decoded dimensions, be at least 64x64 on screen,
 *     intersect the viewport and be visible (not display:none / hidden / 0opacity)
 *   - the largest one wins; prefer one that is actually playing
 *   - the page video is never mutated: no play(), pause(), currentTime writes,
 *     class/style changes or DOM moves
 *
 * Frames arrive through requestVideoFrameCallback when available (falls back to
 * rAF) and are throttled to ~30fps. A 1s watchdog re-scans so a pause, an SPA
 * navigation or a new video is picked up without the overlay's frame loop
 * having to know about it.
 *
 * Public surface (used by background.js only):
 *   SL.videoBg.create(hostEl, { onState }) ->
 *     { el, setActive(bool), state(), destroy() }
 *   SL.videoBg.state() -> last observed { found, playing, width, height, mode }
 */
(function () {
  'use strict';
  const SL = (globalThis.SL = globalThis.SL || {});
  if (SL.videoBg) return;

  const MIN_EDGE = 64;
  const SCAN_MS = 1000;
  const MIN_FRAME_MS = 30;
  const WATCHDOG_MS = 1000;
  /** Canvas backing resolution relative to its CSS box; blur hides the rest. */
  const RENDER_SCALE = 0.42;
  const MAX_CANVAS_EDGE = 1280;

  const EMPTY_STATE = Object.freeze({
    found: false,
    playing: false,
    width: 0,
    height: 0,
    mode: 'fallback',
  });

  let lastState = { ...EMPTY_STATE };

  function setLastState(next) {
    lastState = next;
  }

  function isVisible(node) {
    const rect = node.getBoundingClientRect();
    if (rect.width < MIN_EDGE || rect.height < MIN_EDGE) return false;
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    // Require a meaningful piece of the video to be on screen.
    const overlapX = Math.min(rect.right, vw) - Math.max(rect.left, 0);
    const overlapY = Math.min(rect.bottom, vh) - Math.max(rect.top, 0);
    if (overlapX < MIN_EDGE || overlapY < MIN_EDGE) return false;
    const cs = getComputedStyle(node);
    if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (parseFloat(cs.opacity) === 0) return false;
    return true;
  }

  /**
   * Picks the page video to mirror. `found` means a real video element with
   * decoded dimensions exists; `playing` means it is safe to mirror right now.
   */
  function scanPage() {
    let best = null;
    let bestScore = -1;
    let found = false;
    const videos = document.querySelectorAll('video');
    for (const node of videos) {
      if (!node.isConnected || !node.videoWidth || !node.videoHeight) continue;
      if (!isVisible(node)) continue;
      found = true;
      const rect = node.getBoundingClientRect();
      const playing = !node.paused && !node.ended && node.readyState >= 2;
      // Big videos win; a paused one only wins when nothing else is around.
      const score = Math.min(rect.width * rect.height, 8000000) * (playing ? 1 : 0.3);
      if (score > bestScore) {
        bestScore = score;
        best = { video: node, playing };
      }
    }
    return { found, best };
  }

  function create(hostEl, options) {
    const opts = options || {};
    // background.js already rendered the .slbg-video layer; using it directly
    // keeps one wrapper (nesting would let the outer layer's opacity hide the
    // canvas). Fall back to creating one for direct use in tests.
    const owned = !hostEl;
    const el = hostEl || document.createElement('div');
    el.classList.add('slbg-video');
    el.setAttribute('aria-hidden', 'true');
    const canvas = document.createElement('canvas');
    canvas.className = 'slbg-video-canvas';
    el.appendChild(canvas);

    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

    let active = false;
    let destroyed = false;
    let video = null;
    let live = false;
    let frames = 0;
    let lastDraw = 0;
    let rvfcId = 0;
    let rafId = 0;
    let watchdogId = 0;
    let lastScan = 0;
    let resizeObserver = null;
    const state = { ...EMPTY_STATE };

    function emit() {
      if (destroyed) return;
      const next = {
        found: state.found,
        playing: state.playing,
        width: state.width,
        height: state.height,
        mode: state.mode,
      };
      if (
        next.found === lastState.found &&
        next.playing === lastState.playing &&
        next.width === lastState.width &&
        next.height === lastState.height &&
        next.mode === lastState.mode
      ) {
        return;
      }
      lastState = next;
      if (typeof opts.onState === 'function') {
        try {
          opts.onState(next);
        } catch (err) {
          console.error('[spicy] video background state handler failed', err);
        }
      }
    }

    function syncCanvasSize() {
      if (!ctx || destroyed) return;
      const rect = el.getBoundingClientRect();
      const cssW = Math.max(1, rect.width || hostEl.clientWidth || 0);
      const cssH = Math.max(1, rect.height || hostEl.clientHeight || 0);
      const scale = Math.max(
        0.2,
        Math.min(RENDER_SCALE, MAX_CANVAS_EDGE / Math.max(cssW, cssH))
      );
      const width = Math.max(2, Math.round(cssW * scale));
      const height = Math.max(2, Math.round(cssH * scale));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
    }

    function drawCover() {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const cw = canvas.width;
      const ch = canvas.height;
      if (!vw || !vh || cw < 2 || ch < 2) return;
      const scale = Math.max(cw / vw, ch / vh);
      const sw = cw / scale;
      const sh = ch / scale;
      const sx = (vw - sw) / 2;
      const sy = (vh - sh) / 2;
      try {
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, cw, ch);
        frames += 1;
        if (!live) {
          live = true;
          el.classList.add('is-live');
          state.mode = 'mirror';
          emit();
        }
      } catch (err) {
        // A detached or not-yet-decodable source. Keep the fallback visible.
        markFallback();
      }
    }

    function markFallback() {
      live = false;
      frames = 0;
      el.classList.remove('is-live');
      state.mode = 'fallback';
      state.playing = !!(video && !video.paused && !video.ended);
      emit();
    }

    function canMirror() {
      return !!(
        video &&
        video.isConnected &&
        !video.paused &&
        !video.ended &&
        video.readyState >= 2 &&
        video.videoWidth > 0 &&
        video.videoHeight > 0 &&
        isVisible(video)
      );
    }

    function onVideoFrame(now) {
      rvfcId = 0;
      if (!active || destroyed) return;
      if (!canMirror()) {
        markFallback();
        schedule();
        return;
      }
      if (now - lastDraw >= MIN_FRAME_MS) {
        lastDraw = now;
        state.found = true;
        state.playing = true;
        state.width = video.videoWidth;
        state.height = video.videoHeight;
        drawCover();
        emit();
      }
      schedule();
    }

    function onRafFrame(now) {
      rafId = 0;
      if (!active || destroyed) return;
      if (!canMirror()) {
        markFallback();
        schedule();
        return;
      }
      if (now - lastDraw >= MIN_FRAME_MS) {
        lastDraw = now;
        state.found = true;
        state.playing = true;
        state.width = video.videoWidth;
        state.height = video.videoHeight;
        drawCover();
        emit();
      }
      schedule();
    }

    function schedule() {
      if (!active || destroyed || !video) return;
      if (rvfcId || rafId) return;
      if (typeof video.requestVideoFrameCallback === 'function') {
        rvfcId = video.requestVideoFrameCallback(onVideoFrame);
      } else {
        rafId = requestAnimationFrame(onRafFrame);
      }
    }

    function detach() {
      if (rvfcId && video && typeof video.cancelVideoFrameCallback === 'function') {
        try {
          video.cancelVideoFrameCallback(rvfcId);
        } catch {
          /* best effort */
        }
      }
      rvfcId = 0;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      video = null;
      markFallback();
    }

    function attach(next) {
      if (next === video) {
        if (!live && canMirror()) {
          syncCanvasSize();
          lastDraw = 0;
          schedule();
        }
        return;
      }
      video = next;
      frames = 0;
      live = false;
      el.classList.remove('is-live');
      if (!canMirror()) {
        markFallback();
        return;
      }
      syncCanvasSize();
      lastDraw = 0;
      schedule();
    }

    function probe(force) {
      if (!active || destroyed) return;
      const now = performance.now();
      if (!force && now - lastScan < SCAN_MS) return;
      lastScan = now;
      const result = scanPage();
      state.found = result.found;
      if (!result.best) {
        if (video) detach();
        else {
          state.playing = false;
          state.width = 0;
          state.height = 0;
          state.mode = 'fallback';
          emit();
        }
        return;
      }
      state.playing = result.best.playing;
      state.width = result.best.video.videoWidth || 0;
      state.height = result.best.video.videoHeight || 0;
      if (!result.best.playing) {
        if (video) detach();
        else emit();
        return;
      }
      if (video !== result.best.video) {
        attach(result.best.video);
      } else if (!live && canMirror()) {
        attach(video);
      }
      emit();
    }

    function watchdog() {
      if (!active || destroyed) return;
      // Re-scan when the mirrored video disappeared, paused or ended. This is
      // what turns a video track into a new video track or back into artwork.
      if (!video || !canMirror()) probe(true);
      else {
        state.playing = true;
        state.width = video.videoWidth;
        state.height = video.videoHeight;
        emit();
      }
    }

    function setActive(next) {
      if (destroyed) return;
      next = !!next;
      if (next === active) {
        // Already active: let the throttled probe keep watch, do not rescan
        // on every overlay frame.
        if (next) probe(false);
        return;
      }
      active = next;
      if (active) {
        syncCanvasSize();
        probe(true);
        watchdogId = window.setInterval(watchdog, WATCHDOG_MS);
      } else {
        if (watchdogId) window.clearInterval(watchdogId);
        watchdogId = 0;
        if (rvfcId && video && typeof video.cancelVideoFrameCallback === 'function') {
          try {
            video.cancelVideoFrameCallback(rvfcId);
          } catch {
            /* best effort */
          }
        }
        rvfcId = 0;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        el.classList.remove('is-live');
        live = false;
        state.playing = false;
        state.mode = 'fallback';
        emit();
      }
    }

    function stateSnapshot() {
      return {
        found: state.found,
        playing: state.playing,
        width: state.width,
        height: state.height,
        mode: state.mode,
      };
    }

    function destroy() {
      if (destroyed) return;
      setActive(false);
      destroyed = true;
      if (watchdogId) window.clearInterval(watchdogId);
      watchdogId = 0;
      if (resizeObserver) resizeObserver.disconnect();
      resizeObserver = null;
      if (rvfcId && video && typeof video.cancelVideoFrameCallback === 'function') {
        try {
          video.cancelVideoFrameCallback(rvfcId);
        } catch {
          /* best effort */
        }
      }
      rvfcId = 0;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      video = null;
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      el.classList.remove('slbg-video', 'is-live');
      if (owned && el.parentNode) el.parentNode.removeChild(el);
      lastState = { ...EMPTY_STATE };
    }

    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => {
        syncCanvasSize();
      });
      resizeObserver.observe(el);
    }

    return {
      el,
      setActive,
      probe,
      state: stateSnapshot,
      destroy,
    };
  }

  SL.videoBg = {
    create,
    state: () => ({ ...lastState }),
    EMPTY_STATE,
  };
})();
