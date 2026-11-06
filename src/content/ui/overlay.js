/**
 * Spicy Lyrics for Chrome — overlay lifecycle and composition root.
 *
 * Public API consumed by src/content/app.js:
 *   SL.overlay.mount({ target, onSeek, onClose }) -> void
 *   SL.overlay.unmount() -> void
 *   SL.overlay.isMounted() -> boolean
 *   SL.overlay.toggle(force?) -> void            writes SL.store.ui.open only
 *   SL.overlay.setStatus(text|null) -> void
 *   SL.overlay.refreshTarget() -> void
 *   SL.overlay.openSettings() -> void
 *
 * `mount` builds a host element (#spicy-lyrics) on document.body with an open
 * shadow root, injects the stylesheets into that root, then composes the
 * background, lyric column and controls inside it. The host is sized to the
 * rect of `target()` on mount, on resize/scroll and on a slow poll, so the
 * overlay covers Spotify's main view (or right sidebar in panel mode) and
 * never the player bar or the left navigation.
 *
 * A single rAF loop reads SL.store each frame. There are no pushed per-frame
 * callbacks from the data layer, and no DOM polling for Spotify state.
 */
(function () {
  'use strict';
  const SL = (globalThis.SL = globalThis.SL || {});
  if (SL.overlay) return;

  const HOST_ID = 'spicy-lyrics';
  const CSS_DIR = 'src/content/styles/';
  const CSS_FILES = ['overlay.css', 'lyrics.css', 'controls.css', 'background.css'];
  const TARGET_REFRESH_MS = 500;
  const FETCH_TIMEOUT_MS = 900;

  /**
   * Minimal inline stylesheet kept as the last-resort fallback when neither
   * fetch(chrome.runtime.getURL(...)) nor a cloned <link data-sl-css> can load
   * the real stylesheets (e.g. the page was opened straight from file://).
   * It is intentionally small: readable dark lyrics, no scenery.
   */
  const CRITICAL_CSS = `
    :host { all: initial; display: block; }
    :host { --sl-font: "SpotifyMixUI", "SpotifyMix", "CircularSp", "Circular", "CircularStd", -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif; --sl-accent: #ff5c8a; --sl-hl-2: #ffd7e4; }
    .sl-stage { position: absolute; inset: 0; overflow: hidden; background: #07070b; font-family: var(--sl-font); color: #fff; }
    .sl-bg { position: absolute; inset: 0; background: radial-gradient(120% 90% at 50% 40%, #241018, #07070b 70%); pointer-events: none; }
    .sl-lyrics { position: absolute; inset: 0; overflow: hidden; display: flex; }
    .sl-column { width: min(1100px, 84%); margin: 0 auto; position: relative; height: 100%; }
    .sl-stack { position: relative; will-change: transform; display: flex; flex-direction: column; gap: 26px; }
    .sl-row { display: block; }
    .sl-line { font-size: 44px; font-weight: 800; line-height: 1.18; letter-spacing: -0.015em; color: rgba(255,255,255,.32); }
    .sl-row[data-level="0"] .sl-line { color: #fff; }
    .sl-w, .sl-t { color: transparent; background-image: linear-gradient(90deg, #fff, var(--sl-hl-2)); background-color: rgba(255,255,255,.34); -webkit-background-clip: text; background-clip: text; background-size: calc(var(--p, 0) * 100%) 100%; background-repeat: no-repeat; }
    .sl-header { position: absolute; top: 0; left: 0; right: 0; display: flex; justify-content: space-between; padding: 26px 34px; }
    .sl-header .sl-title { font-size: 15px; margin: 0; font-weight: 700; }
    .sl-header .sl-sub { margin: 4px 0 0; font-size: 11px; letter-spacing: .12em; text-transform: uppercase; opacity: .55; }
    .sl-actions { display: flex; align-items: center; gap: 8px; }
    .sl-badge { font-size: 10px; letter-spacing: .14em; opacity: .6; }
    .sl-icon { width: 34px; height: 34px; border-radius: 50%; border: 1px solid rgba(255,255,255,.15); background: rgba(255,255,255,.07); color: #fff; display: grid; place-items: center; cursor: pointer; }
    .sl-icon svg { width: 16px; height: 16px; }
    .sl-panel { position: absolute; top: 74px; right: 30px; width: 320px; padding: 16px; border-radius: 16px; background: rgba(18,18,24,.92); color: #fff; }
    .sl-status { position: absolute; left: 50%; bottom: 7%; transform: translateX(-50%); padding: 9px 15px; border-radius: 999px; background: rgba(14,14,18,.85); font-size: 12px; color: rgba(255,255,255,.85); }
    .sl-idle { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; opacity: .8; }
    .sl-stage[data-open="0"] { visibility: hidden; opacity: 0; }
    .sl-stage[data-waiting="1"] { visibility: hidden; }
    .sl-stage[data-has-doc="0"] .sl-lyrics { opacity: 0; }
    .sl-idle[hidden] { display: none; }
  `;

  // ---------------------------------------------------------------------------
  // Module state
  // ---------------------------------------------------------------------------

  let host = null;
  let shadow = null;
  let stage = null;
  let bg = null;
  let view = null;
  let controls = null;
  let idleEl = null;
  let idleText = null;
  let idleSub = null;

  let mounted = false;
  let buildToken = 0;
  let opts = { target: null, onSeek: null, onClose: null };
  let rafId = 0;
  let unsub = null;
  let pendingStatus;

  let lastTargetNode = null;
  let lastGeomKey = '';
  let lastVisible = null;
  let lastDoc = null;
  let lastIdleSig = '';
  let lastGeomAt = 0;

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  function cssUrl(name) {
    try {
      if (globalThis.chrome && chrome.runtime && typeof chrome.runtime.getURL === 'function') {
        return chrome.runtime.getURL(CSS_DIR + name);
      }
    } catch (err) {
      /* not an extension context */
    }
    return '../../' + CSS_DIR + name;
  }

  function appendStyle(root, text, label) {
    const style = document.createElement('style');
    style.setAttribute('data-sl', label);
    style.textContent = text;
    root.appendChild(style);
  }

  function fetchCss(name) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (text) => {
        if (settled) return;
        settled = true;
        resolve(text || null);
      };
      const timer = setTimeout(() => finish(null), FETCH_TIMEOUT_MS);
      try {
        fetch(cssUrl(name), { cache: 'force-cache' })
          .then((response) => {
            if (!response.ok) throw new Error('http ' + response.status);
            return response.text();
          })
          .then((text) => {
            clearTimeout(timer);
            finish(text);
          })
          .catch(() => {
            clearTimeout(timer);
            finish(null);
          });
      } catch (err) {
        clearTimeout(timer);
        finish(null);
      }
    });
  }

  function cloneDocumentLinks(root, missing) {
    // Fallback for file:// (the render lab): the page links the same stylesheets
    // as data-sl-css and we clone those links into the shadow root.
    const links = Array.from(document.querySelectorAll('link[data-sl-css]')).filter((link) => {
      const file = link.getAttribute('data-sl-css');
      return !missing.length || missing.includes(file);
    });
    if (!links.length) return Promise.resolve(false);
    return Promise.all(
      links.map(
        (link) =>
          new Promise((resolve) => {
            const clone = link.cloneNode(true);
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              resolve(true);
            };
            clone.addEventListener('load', finish, { once: true });
            clone.addEventListener('error', finish, { once: true });
            root.appendChild(clone);
            setTimeout(finish, 1200);
          })
      )
    ).then(() => true);
  }

  async function injectStyles(root) {
    appendStyle(root, CRITICAL_CSS, 'critical');
    const texts = await Promise.all(CSS_FILES.map((name) => fetchCss(name)));
    const missing = [];
    texts.forEach((text, i) => {
      if (text) appendStyle(root, text, CSS_FILES[i]);
      else missing.push(CSS_FILES[i]);
    });
    if (missing.length) {
      const ok = await cloneDocumentLinks(root, missing);
      if (!ok) console.warn('[spicy] stylesheet fallback failed for', missing.join(', '));
    }
  }

  // ---------------------------------------------------------------------------
  // Host + stage
  // ---------------------------------------------------------------------------

  function ensureHost() {
    const stale = document.getElementById(HOST_ID);
    if (stale && stale !== host) stale.remove();
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-spicy-overlay', '');
    // The host is sized to the target rect; the stage lives inside it.
    host.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;' +
      'pointer-events:none;overflow:hidden;contain:layout paint style;' +
      'border-radius:0;background:transparent;';
    document.body.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
  }

  function buildStage() {
    stage = document.createElement('div');
    stage.className = 'sl-stage';
    stage.dataset.open = '0';
    stage.dataset.hasDoc = '0';
    stage.dataset.waiting = '0';
    shadow.appendChild(stage);

    bg = SL.background.create(stage);

    const lyrics = document.createElement('div');
    lyrics.className = 'sl-lyrics';
    stage.appendChild(lyrics);
    view = SL.lyricsView.create(lyrics, {
      onSeek: (positionMs) => {
        if (typeof opts.onSeek === 'function') opts.onSeek(positionMs);
      },
    });

    idleEl = document.createElement('div');
    idleEl.className = 'sl-idle';
    idleEl.setAttribute('aria-hidden', 'true');
    idleEl.innerHTML =
      '<div class="sl-idle-bars"><i></i><i></i><i></i><i></i></div>' +
      '<div class="sl-idle-title"></div>' +
      '<div class="sl-idle-sub"></div>';
    idleText = idleEl.querySelector('.sl-idle-title');
    idleSub = idleEl.querySelector('.sl-idle-sub');
    stage.appendChild(idleEl);

    controls = SL.controls.create(stage, {
      onClose: () => {
        if (typeof opts.onClose === 'function') opts.onClose();
      },
    });

    if (pendingStatus !== undefined) {
      controls.setStatus(pendingStatus);
      pendingStatus = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Geometry
  // ---------------------------------------------------------------------------

  function radiusOf(node) {
    try {
      const value = getComputedStyle(node).borderTopLeftRadius || '0px';
      const radius = parseFloat(value);
      return isFinite(radius) ? Math.min(Math.max(radius, 0), 28) : 0;
    } catch (err) {
      return 0;
    }
  }

  function refreshTarget(force) {
    if (!host || !stage) return;
    let node = null;
    try {
      node = typeof opts.target === 'function' ? opts.target() : null;
    } catch (err) {
      node = null;
    }
    lastTargetNode = node && node.isConnected ? node : null;

    let rect = null;
    if (lastTargetNode) {
      try {
        const r = lastTargetNode.getBoundingClientRect();
        if (r && r.width > 4 && r.height > 4) rect = r;
      } catch (err) {
        rect = null;
      }
    }

    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);
    let geom;
    if (rect) {
      geom = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        radius: radiusOf(lastTargetNode),
        waiting: false,
      };
    } else {
      // Spotify has not rendered the container yet. Stay invisible rather than
      // guessing a rect that might cover the player bar.
      geom = { x: 0, y: 0, w: vw, h: vh, radius: 0, waiting: true };
    }

    const key = [geom.x, geom.y, geom.w, geom.h, geom.radius, geom.waiting ? 1 : 0].join(',');
    if (!force && key === lastGeomKey) return;
    lastGeomKey = key;

    host.style.left = geom.x + 'px';
    host.style.top = geom.y + 'px';
    host.style.width = geom.w + 'px';
    host.style.height = geom.h + 'px';
    host.style.borderRadius = geom.radius + 'px';
    stage.dataset.waiting = geom.waiting ? '1' : '0';
    // Panel mode renders into Spotify's ~340px right sidebar; the narrow
    // treatment keeps the header from eating the column and stops long lines
    // wrapping into 3-4 rows.
    stage.classList.toggle('is-compact', geom.w < 480);
    if (!geom.waiting) view.measure();
  }

  // ---------------------------------------------------------------------------
  // Store synchronisation
  // ---------------------------------------------------------------------------

  function updateIdle(state) {
    if (!idleEl) return;
    const hasDoc = !!(state.lyrics && state.lyrics.lines && state.lyrics.lines.length);
    const status = state.lyricsStatus;
    const track = state.track || {};
    let mode = 'idle';
    let title = 'Lyrics are on the way';
    let sub = track.title ? track.title + (track.artist ? ' — ' + track.artist : '') : '';

    if (status === 'loading') {
      mode = 'loading';
      title = 'Finding lyrics';
      sub = 'Reading the lyrics Spotify already loaded for this track';
    } else if (status === 'empty') {
      mode = 'empty';
      title = 'No synced lyrics';
      sub = 'This track has no word- or line-synced lyrics yet.';
    } else if (status === 'error') {
      mode = 'error';
      title = 'Lyrics unavailable';
      sub = state.lyricsError || 'The lyrics provider request failed.';
    } else if (!track.title) {
      title = 'Playback not detected';
      sub = 'Play a track in Spotify. Still empty? Open the extension popup and copy diagnostics.';
    }

    const sig = [hasDoc ? 1 : 0, mode, title, sub].join('\u0001');
    if (sig === lastIdleSig) return;
    lastIdleSig = sig;
    idleEl.hidden = hasDoc;
    idleEl.dataset.mode = mode;
    idleText.textContent = title;
    idleSub.textContent = sub;
    stage.dataset.hasDoc = hasDoc ? '1' : '0';
  }

  function visibleNow(state) {
    if (!lastTargetNode || !stage) return false;
    const settings = state.settings || {};
    if (settings.enabled === false) return false;
    const ui = state.ui || {};
    if (ui.dismissed) return false;
    if (ui.open) return true;
    return !!(settings.autoOpen && ui.nativeLyricsOpen);
  }

  function sync(state, now) {
    if (!stage || !view || !controls || !bg) return;

    bg.setSettings(state.settings);
    bg.setTrack(state.track);

    if (state.lyrics !== lastDoc) {
      lastDoc = state.lyrics;
      view.setDoc(lastDoc, state.settings);
    }
    view.applySettings(state.settings);
    controls.update(state);
    updateIdle(state);

    const visible = visibleNow(state);
    if (visible !== lastVisible) {
      lastVisible = visible;
      stage.dataset.open = visible ? '1' : '0';
      if (visible) {
        refreshTarget(true);
        view.measure();
      }
    }

    if (visible) view.tick(state, now);
    // Background probe: starts/stops the page-video mirror and retries a
    // missing custom image. Decorative drift itself is CSS on the compositor.
    bg.tick(SL.store.positionNow(), !!(state.playback && state.playback.isPlaying));
  }

  // ---------------------------------------------------------------------------
  // Frame loop
  // ---------------------------------------------------------------------------

  function frame(now) {
    rafId = 0;
    if (!mounted || !stage) return;
    rafId = requestAnimationFrame(frame);
    if (now - lastGeomAt > TARGET_REFRESH_MS) {
      lastGeomAt = now;
      refreshTarget(false);
    }
    sync(SL.store.get(), now);
  }

  function startLoop() {
    if (!rafId) rafId = requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function mount(options) {
    if (mounted) {
      opts = Object.assign(opts, options || {});
      refreshTarget(true);
      return;
    }
    opts = { target: null, onSeek: null, onClose: null, ...(options || {}) };
    if (!document.body) {
      // Extremely early call (document_start); retry on the next task.
      setTimeout(() => mount(options), 40);
      return;
    }
    mounted = true;
    const token = ++buildToken;
    pendingStatus = undefined;
    lastDoc = null;
    lastVisible = null;
    lastGeomKey = '';
    lastIdleSig = '';

    ensureHost();
    unsub = SL.store.subscribe((state) => {
      if (!mounted) return;
      // The rAF loop does the real work; this only shortens the latency of the
      // first store write after mount (styles may still be loading).
      if (controls) controls.update(state);
    });
    window.addEventListener('resize', onWindowResize, { passive: true });
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });

    injectStyles(shadow).then(() => {
      if (!mounted || token !== buildToken || !shadow) return;
      buildStage();
      refreshTarget(true);
      lastGeomAt = performance.now();
      startLoop();
    });
  }

  function unmount() {
    if (!mounted && !host) return;
    mounted = false;
    buildToken++;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    if (unsub) unsub();
    unsub = null;
    window.removeEventListener('resize', onWindowResize);
    document.removeEventListener('scroll', onScroll, true);
    if (view) view.destroy();
    if (controls) controls.destroy();
    if (bg) bg.destroy();
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    shadow = null;
    stage = null;
    bg = null;
    view = null;
    controls = null;
    idleEl = null;
    idleText = null;
    idleSub = null;
    lastTargetNode = null;
    lastDoc = null;
    lastVisible = null;
    lastGeomKey = '';
    lastIdleSig = '';
    pendingStatus = undefined;
  }

  function isMounted() {
    return !!(mounted && host && host.isConnected);
  }

  function toggle(force) {
    const state = SL.store.get();
    const next = typeof force === 'boolean' ? force : !state.ui.open;
    // Contract: toggle writes ui.open and nothing else.
    SL.store.patch({ ui: { open: next } }, 'overlay:toggle');
  }

  function setStatus(text) {
    if (!controls) {
      pendingStatus = text == null ? null : String(text);
      return;
    }
    controls.setStatus(text == null ? null : String(text));
  }

  function openSettings() {
    if (controls) controls.openPanel();
  }

  // A resize changes the target rect immediately; scrolls can move it too
  // (Spotify's right sidebar scrolls independently), so both force a measure.
  function onWindowResize() {
    refreshTarget(true);
  }

  const onScroll = SL.util.frameThrottle(() => refreshTarget(true));

  // ---------------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------------

  SL.overlay = {
    mount,
    unmount,
    isMounted,
    toggle,
    setStatus,
    refreshTarget: () => refreshTarget(true),
    openSettings,
    show: () => {
      if (!mounted) return;
      refreshTarget(true);
      sync(SL.store.get(), performance.now());
    },
  };
})();
