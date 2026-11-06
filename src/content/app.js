/**
 * App shell: the only file that knows about both the data layer and the
 * renderer. It decides when the overlay should exist, keeps it pointed at the
 * right Spotify container, adds the toolbar launcher, and mirrors a tiny status
 * surface into `document.documentElement.dataset` so the harness and users can
 * see what the extension thinks is happening.
 */
(() => {
  'use strict';
  const SL = globalThis.SL;
  if (!SL || !SL.store || SL.app) return;

  const VERSION = '1.1.0';
  const LOG = (...args) => console.log('[spicy]', ...args);

  const HOST_SELECTORS = {
    main: [
      '.main-view-container',
      '[data-testid="main-view-container"]',
      '.Root__main-view',
      '#main',
    ],
    panel: [
      '[data-testid="right-sidebar"]',
      '.Root__right-sidebar',
      '[data-testid="now-playing-view"]',
      '[data-testid="right-sidebar-container"]',
    ],
    lyrics: [
      '[data-testid="lyrics-line"]',
      '[data-testid="lyrics-container"]',
      '[data-testid="lyrics-page"]',
      '[data-testid="read-along-scroll-container"]',
    ],
  };

  const app = {
    version: VERSION,
    started: false,
    mountSync: 0,
    nativeSynced: false,
    lastStatus: undefined,
    launcher: null,
  };

  // ---------------------------------------------------------------------------
  // Overlay lifecycle
  // ---------------------------------------------------------------------------

  function resolveTarget() {
    const settings = SL.store.get().settings;
    const primary = settings.mode === 'panel' ? HOST_SELECTORS.panel : HOST_SELECTORS.main;
    const order = settings.mode === 'panel' ? [...primary, ...HOST_SELECTORS.main] : primary;
    for (const selector of order) {
      const el = document.querySelector(selector);
      if (el && el.getClientRects().length) return el;
    }
    return null;
  }

  function shouldShow() {
    const state = SL.store.get();
    if (!state.settings.enabled) return false;
    if (state.ui.open && !state.ui.dismissed) return true;
    if (state.settings.autoOpen && state.ui.nativeLyricsOpen && !state.ui.dismissed) return true;
    return false;
  }

  function onSeek(positionMs) {
    if (!Number.isFinite(positionMs)) return;
    try {
      SL.player.seek(positionMs);
    } catch (err) {
      console.warn('[spicy] seek failed', err);
    }
  }

  function onClose() {
    SL.store.patch({ ui: { open: false, dismissed: true } }, 'app:close');
  }

  function ensureOverlay() {
    if (!SL.overlay || typeof SL.overlay.mount !== 'function') {
      // Renderer failed to load; do not spam. Report once.
      if (!app.mountSync) LOG('overlay module missing');
      return;
    }
    if (SL.overlay.isMounted && SL.overlay.isMounted()) return;
    try {
      SL.overlay.mount({ target: resolveTarget, onSeek, onClose });
      SL.store.patch({ ui: { mounted: true } }, 'app:mount');
    } catch (err) {
      console.error('[spicy] mount failed', err);
      SL.store.patch({ ui: { lastError: String(err && err.message || err) } }, 'app:mount-error');
    }
  }

  function removeOverlay() {
    if (!SL.overlay || !SL.overlay.isMounted || !SL.overlay.isMounted()) return;
    try {
      SL.overlay.unmount();
    } catch (err) {
      console.warn('[spicy] unmount failed', err);
    }
    SL.store.patch({ ui: { mounted: false } }, 'app:unmount');
  }

  function syncMount() {
    const want = shouldShow();
    const mounted = !!(SL.overlay && SL.overlay.isMounted && SL.overlay.isMounted());
    if (want && !mounted) {
      ensureOverlay();
      if (SL.overlay && SL.overlay.show) SL.overlay.show();
    } else if (!want && mounted) {
      removeOverlay();
    }
    updateStatusPill();
    updateLauncher();
  }

  function updateStatusPill() {
    if (!SL.overlay || typeof SL.overlay.setStatus !== 'function') return;
    const state = SL.store.get();
    if (!state.ui.mounted) {
      app.lastStatus = undefined;
      return;
    }
    let text = null;
    if (state.lyricsStatus === 'loading') text = 'Finding lyrics…';
    else if (state.lyricsStatus === 'empty') {
      // The overlay renders its own empty state; only add the actionable hint
      // when the native lyrics view has not been opened for this track yet.
      text = state.ui.nativeLyricsOpen ? null : 'Tip: open Spotify’s lyrics view once for this track';
    } else if (state.lyricsStatus === 'error') {
      text = 'Lyrics unavailable: ' + (state.lyricsError || 'unknown error');
    }
    if (text !== app.lastStatus) {
      app.lastStatus = text;
      try {
        SL.overlay.setStatus(text);
      } catch (err) {
        console.warn('[spicy] setStatus failed', err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Native lyrics view detection (mount trigger)
  // ---------------------------------------------------------------------------

  function nativeLyricsOpen() {
    for (const selector of HOST_SELECTORS.lyrics) {
      const node = document.querySelector(selector);
      // Spotify keeps the lyrics page mounted but hidden between visits, so
      // presence alone is not enough: require a laid-out box.
      if (node && node.isConnected && node.getClientRects().length > 0) return true;
    }
    return false;
  }

  function pollNativeLyrics() {
    const open = nativeLyricsOpen();
    if (open !== SL.store.get().ui.nativeLyricsOpen) {
      SL.store.patch({ ui: { nativeLyricsOpen: open } }, 'app:native-lyrics');
    }
  }

  // ---------------------------------------------------------------------------
  // Bootstrap: ask Spotify itself for the lyrics
  //
  // The web player only requests color-lyrics once its own lyrics view is shown.
  // Rather than guessing a token, the extension clicks Spotify's lyrics button
  // when a track has no lyrics yet, lets Spotify fetch them exactly as the user
  // would, then reads what Spotify got (sniffed payload or the rendered DOM).
  // Our own overlay mounts on top of that view. This is the "read the default
  // Spotify lyrics" path, and it is a setting users can turn off.
  // ---------------------------------------------------------------------------

  const LYRICS_BUTTON_RE = /lyric|歌詞|歌詞を表示|가사|歌词|letra|paroles|testo|liedtext|letras/i;
  let bootstrapTimer = 0;
  let bootstrappedTrackId = null;

  function findLyricsButton() {
    const direct = document.querySelector('[data-testid="lyrics-button"]');
    if (direct) return direct;
    for (const node of document.querySelectorAll('button, [role="button"]')) {
      if (!node.isConnected) continue;
      const label = node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent || '';
      if (LYRICS_BUTTON_RE.test(label) && label.length < 80) return node;
    }
    return null;
  }

  /** Identity of the track: real id when the sniffer has promoted one, else
   *  the player's synthetic key (the current build exposes no track id). */
  function trackIdentity(state) {
    const track = state.track || {};
    if (track.id) return track.id;
    if (track.key) return track.key;
    if (track.title) return [track.title, track.artist || ''].join('|');
    return null;
  }

  function maybeBootstrapFetch() {
    clearTimeout(bootstrapTimer);
    const state = SL.store.get();
    if (!state.settings.enabled || !state.settings.autoOpen || !state.settings.autoFetch) return;
    const identity = trackIdentity(state);
    if (!identity || state.ui.nativeLyricsOpen || state.ui.dismissed) return;
    if (state.lyricsStatus === 'ready' || state.lyricsStatus === 'loading') return;
    if (state.lyricsStatus !== 'empty' && state.lyricsStatus !== 'error') return;
    if (bootstrappedTrackId === identity) return;
    const trackId = identity;
    bootstrapTimer = setTimeout(() => {
      const current = SL.store.get();
      if (current.track.id !== trackId || current.ui.nativeLyricsOpen || current.lyricsStatus === 'ready') return;
      const button = findLyricsButton();
      if (!button) return;
      bootstrappedTrackId = trackId;
      try {
        button.click();
        LOG('bootstrap: opened Spotify lyrics to read them', trackId);
      } catch (err) {
        console.warn('[spicy] bootstrap click failed', err);
      }
    }, 2500);
  }

  // ---------------------------------------------------------------------------
  // Launcher button (outside the overlay, so it stays clickable when closed)
  // ---------------------------------------------------------------------------

  const LAUNCHER_CSS = `
    .spicy-launcher {
      position: fixed;
      right: 18px;
      bottom: 104px;
      z-index: 2147483000;
      display: flex;
      align-items: center;
      gap: 8px;
      height: 34px;
      padding: 0 13px 0 10px;
      border: 1px solid rgba(255,255,255,.14);
      border-radius: 999px;
      background: rgba(18,18,20,.82);
      color: #f2f2f5;
      font: 650 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Noto Sans JP", Roboto, sans-serif;
      letter-spacing: .01em;
      cursor: pointer;
      backdrop-filter: blur(14px) saturate(140%);
      -webkit-backdrop-filter: blur(14px) saturate(140%);
      box-shadow: 0 8px 26px rgba(0,0,0,.45);
      transition: transform .16s ease, background .16s ease, opacity .16s ease;
      opacity: .82;
    }
    .spicy-launcher:hover { opacity: 1; transform: translateY(-1px); background: rgba(30,30,34,.94); }
    .spicy-launcher[data-active="1"] { opacity: 1; border-color: rgba(255,120,150,.5); }
    .spicy-launcher[data-hidden="1"] { display: none; }
    .spicy-launcher .spicy-dot {
      width: 16px; height: 16px; border-radius: 5px;
      background: linear-gradient(135deg, #ff9a4d, #ff5c8a 55%, #b04dff);
      box-shadow: 0 0 12px rgba(255,92,138,.5);
      flex: 0 0 auto;
    }
    .spicy-launcher .spicy-bars { display: flex; align-items: flex-end; gap: 1.5px; height: 12px; }
    .spicy-launcher .spicy-bars i { display: block; width: 2px; background: currentColor; border-radius: 1px; opacity: .9; }
    .spicy-launcher .spicy-bars i:nth-child(1) { height: 5px; }
    .spicy-launcher .spicy-bars i:nth-child(2) { height: 10px; }
    .spicy-launcher .spicy-bars i:nth-child(3) { height: 7px; }
    .spicy-launcher[data-playing="1"] .spicy-bars i { animation: spicy-eq .9s ease-in-out infinite alternate; }
    .spicy-launcher[data-playing="1"] .spicy-bars i:nth-child(2) { animation-delay: .15s; }
    .spicy-launcher[data-playing="1"] .spicy-bars i:nth-child(3) { animation-delay: .3s; }
    @keyframes spicy-eq { from { transform: scaleY(.45); } to { transform: scaleY(1); } }
    @media (prefers-reduced-motion: reduce) {
      .spicy-launcher[data-playing="1"] .spicy-bars i { animation: none; }
    }
  `;

  function injectLauncherStyle() {
    if (document.getElementById('spicy-launcher-style')) return;
    const style = document.createElement('style');
    style.id = 'spicy-launcher-style';
    style.textContent = LAUNCHER_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function buildLauncher() {
    if (app.launcher && app.launcher.isConnected) return app.launcher;
    injectLauncherStyle();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'spicy-launcher';
    btn.title = 'Spicy Lyrics (Alt+Shift+L)';
    btn.setAttribute('aria-label', 'Toggle Spicy Lyrics');
    btn.innerHTML =
      '<span class="spicy-dot"></span>' +
      '<span class="spicy-bars"><i></i><i></i><i></i></span>' +
      '<span class="spicy-label">Spicy</span>';
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleOverlay();
    });
    document.body.appendChild(btn);
    app.launcher = btn;
    updateLauncher();
    return btn;
  }

  function updateLauncher() {
    const btn = app.launcher;
    if (!btn) return;
    const state = SL.store.get();
    const open = shouldShow();
    btn.dataset.active = open ? '1' : '0';
    btn.dataset.playing = state.playback.isPlaying ? '1' : '0';
    btn.dataset.hidden = (state.ui.mounted && !state.settings.showHeader) ? '1' : '0';
    btn.setAttribute('aria-pressed', open ? 'true' : 'false');
  }

  function toggleOverlay() {
    const state = SL.store.get();
    if (!state.settings.enabled) {
      SL.store.updateSettings({ enabled: true });
      SL.store.saveSettings();
    }
    if (shouldShow()) {
      onClose();
    } else {
      SL.store.patch({ ui: { open: true, dismissed: false } }, 'app:toggle');
    }
  }

  // ---------------------------------------------------------------------------
  // Debug/status mirror
  // ---------------------------------------------------------------------------

  let mirrorQueued = false;
  function mirrorStatus() {
    if (mirrorQueued) return;
    mirrorQueued = true;
    requestAnimationFrame(() => {
      mirrorQueued = false;
      const state = SL.store.get();
      const root = document.documentElement;
      if (!root) return;
      root.dataset.spicyVersion = VERSION;
      root.dataset.spicyStatus = state.lyricsStatus || 'idle';
      root.dataset.spicySync = state.lyrics ? state.lyrics.syncType : '';
      root.dataset.spicySource = state.lyrics ? state.lyrics.source : '';
      root.dataset.spicyOpen = shouldShow() ? '1' : '0';
      root.dataset.spicyTitle = state.track.title || '';
      root.dataset.spicyArtist = state.track.artist || '';
      root.dataset.spicyDetected = state.track.title || state.track.id ? '1' : '0';
      root.dataset.spicyLyricMode = state.settings.lyricMode || '';
      root.dataset.spicyBg = state.settings.backgroundStyle || '';
      root.dataset.spicyMounted = (SL.overlay && SL.overlay.isMounted && SL.overlay.isMounted()) ? '1' : '0';
      root.dataset.spicyTrack = state.track.id || '';
      root.dataset.spicyKey = state.track.key || '';
      if (state.lyrics && state.lyrics.lines) root.dataset.spicyLines = String(state.lyrics.lines.length);
      else delete root.dataset.spicyLines;
    });
  }

  // ---------------------------------------------------------------------------
  // Messages from the popup and the service worker
  // ---------------------------------------------------------------------------

  function currentStatusPayload() {
    const state = SL.store.get();
    return {
      ok: true,
      detected: !!(state.track.title || state.track.id),
      title: state.track.title,
      artist: state.track.artist,
      album: state.track.album,
      status: state.lyricsStatus,
      syncType: state.lyrics ? state.lyrics.syncType : '',
      source: state.lyrics ? state.lyrics.source : '',
      lyricMode: state.settings.lyricMode,
      backgroundStyle: state.settings.backgroundStyle,
      open: shouldShow(),
      mounted: !!(SL.overlay && SL.overlay.isMounted && SL.overlay.isMounted()),
      errors: state.ui.lastError || null,
    };
  }

  function handleMessage(message) {
    if (!message || typeof message.type !== 'string') return false;
    switch (message.type) {
      case 'spicy:toggle':
        toggleOverlay();
        return true;
      case 'spicy:open-overlay':
        SL.store.patch({ ui: { open: true, dismissed: false } }, 'app:open');
        return true;
      case 'spicy:get-state':
        return currentStatusPayload();
      case 'spicy:diagnostics':
        return SL.player && SL.player.diagnostics ? SL.player.diagnostics() : { ok: false, error: 'player diagnostics unavailable' };
      case 'spicy:clear-cache':
        SL.store.clearCache().then(() => {
          const state = SL.store.get();
          if (state.track.id && SL.lyrics && SL.lyrics.attach) SL.lyrics.attach();
        });
        return true;
      default:
        return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  function wireGlobalEvents() {
    SL.store.subscribe((state, reason) => {
      if (reason === 'track' || reason === 'lyrics' || reason === 'lyrics-status' || reason === 'settings') maybeBootstrapFetch();
      if (reason === 'lyrics' || reason === 'lyrics-status') updateStatusPill();
      if (reason === 'settings' || reason === 'track' || reason === 'playback' || reason === 'settings') updateLauncher();
      if (reason === 'settings') {
        // Mode changes retarget the overlay; the renderer re-resolves target()
        // itself, but the mount state may differ if the target vanished.
        if (SL.overlay && SL.overlay.isMounted && SL.overlay.isMounted()) SL.overlay.refreshTarget?.();
      }
      mirrorStatus();
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || typeof message.type !== 'string' || !message.type.startsWith('spicy:')) return false;
      if (message.type === 'spicy:get-state') {
        sendResponse(currentStatusPayload());
        return false;
      }
      if (message.type === 'spicy:diagnostics') {
        try {
          sendResponse(SL.player && SL.player.diagnostics ? SL.player.diagnostics() : { ok: false });
        } catch (err) {
          sendResponse({ ok: false, error: String((err && err.message) || err) });
        }
        return false;
      }
      if (message.type === 'spicy:import-ttml') {
        if (!SL.lyrics || typeof SL.lyrics.importTTML !== 'function') {
          sendResponse({ ok: false, error: 'TTML import is not available' });
          return false;
        }
        SL.lyrics
          .importTTML(String(message.text || ''))
          .then((result) => sendResponse(result))
          .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
        return true;
      }
      handleMessage(message);
      return false;
    });

    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        const entry = changes[SL.store.SETTINGS_KEY];
        if (entry && entry.newValue) SL.store.setSettings(entry.newValue);
      });
    }

    document.addEventListener(
      'keydown',
      (ev) => {
        if (ev.altKey && ev.shiftKey && (ev.key === 'l' || ev.key === 'L')) {
          ev.preventDefault();
          ev.stopPropagation();
          toggleOverlay();
        }
      },
      true,
    );

    window.addEventListener('resize', () => {
      if (SL.overlay && SL.overlay.refreshTarget) SL.overlay.refreshTarget();
    });

    // Spotify is a SPA: the player bar and the lyrics page can be swapped out
    // at any time, so re-check the anchor elements instead of trusting a ref.
    const observer = new MutationObserver(() => {
      if (app.launcher && !app.launcher.isConnected) {
        app.launcher = null;
        buildLauncher();
      }
      pollNativeLyrics();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setInterval(() => {
      pollNativeLyrics();
      if (!app.launcher) buildLauncher();
    }, 400);
  }

  async function start() {
    if (app.started) return;
    app.started = true;

    await SL.store.loadSettings();
    SL.store.patch({ ready: true }, 'app:ready');

    try {
      if (SL.bridge && SL.bridge.start) SL.bridge.start();
    } catch (err) {
      console.warn('[spicy] bridge start failed', err);
    }
    try {
      if (SL.player && SL.player.start) SL.player.start();
    } catch (err) {
      console.warn('[spicy] player start failed', err);
    }
    try {
      if (SL.lyrics && SL.lyrics.attach) SL.lyrics.attach();
    } catch (err) {
      console.warn('[spicy] lyrics attach failed', err);
    }

    pollNativeLyrics();
    buildLauncher();
    wireGlobalEvents();

    let lastMountCheck = 0;
    const loop = () => {
      const now = performance.now();
      if (now - lastMountCheck > 120) {
        lastMountCheck = now;
        syncMount();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    syncMount();
    maybeBootstrapFetch();
    mirrorStatus();
    LOG('ready', VERSION);
  }

  // Read-only debug handle for the harness (does not expose the store).
  SL.app = {
    version: VERSION,
    get status() {
      return currentStatusPayload();
    },
    toggle: toggleOverlay,
    refresh: syncMount,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
