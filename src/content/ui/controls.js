/**
 * Spicy Lyrics for Chrome — header, quick settings, status pill, idle chrome.
 *
 * Everything here is chrome around the lyric column: the track header with the
 * sync badge, the glass settings panel, the transient status pill, pointer /
 * keyboard handling and the hide-after-3s-of-idle behaviour.
 *
 * Public surface (internal to the overlay):
 *   SL.controls.create(stageEl, { onClose }) -> {
 *     headerEl, panelEl, statusEl,
 *     update(state), setStatus(text|null), flashStatus(text),
 *     openPanel(), closePanel(), togglePanel(), isPanelOpen(), destroy()
 *   }
 */
(function () {
  'use strict';
  const SL = (globalThis.SL = globalThis.SL || {});
  if (SL.controls) return;
  const util = SL.util;

  const ICON_GEAR =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>';
  const ICON_CLOSE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

  const TOGGLES = [
    { key: 'showBackground', label: 'Album art background' },
    { key: 'backgroundMotion', label: 'Background motion' },
    { key: 'showInterludeDots', label: 'Interlude dots' },
    { key: 'minimalMode', label: 'Minimal chrome' },
    { key: 'reduceMotion', label: 'Reduce motion' },
  ];

  const RANGES = [
    { key: 'fontSize', label: 'Font size', min: 0.6, max: 1.8, step: 0.02 },
    { key: 'lineGap', label: 'Line spacing', min: 0.6, max: 2, step: 0.02 },
    { key: 'backgroundBlur', label: 'Background blur', min: 0, max: 200, step: 1 },
    { key: 'backgroundDim', label: 'Background dim', min: 0, max: 0.95, step: 0.01 },
  ];

  function fmt(key, value) {
    switch (key) {
      case 'fontSize':
      case 'lineGap':
        return Number(value).toFixed(2) + '×';
      case 'backgroundBlur':
        return Math.round(value) + 'px';
      case 'backgroundDim':
        return Math.round(value * 100) + '%';
      case 'offsetMs':
        return (value > 0 ? '+' : '') + Math.round(value) + ' ms';
      default:
        return String(value);
    }
  }

  function syncLabel(doc, status) {
    if (!doc) return status === 'loading' ? 'SYNCING LYRICS' : 'NO LYRICS';
    const kind =
      doc.syncType === 'word'
        ? 'WORD SYNCED'
        : doc.syncType === 'line'
          ? 'LINE SYNCED'
          : 'STATIC LYRICS';
    const source = { spclient: 'SPCLIENT', dom: 'SPOTIFY', ttml: 'TTML', cache: 'CACHE' }[
      doc.source
    ] || String(doc.source || '').toUpperCase() || 'LYRICS';
    return kind + ' · ' + source;
  }

  function create(stage, callbacks) {
    callbacks = callbacks || {};

    // -------------------------------------------------------------------------
    // Header
    // -------------------------------------------------------------------------
    const header = document.createElement('header');
    header.className = 'sl-header';
    header.innerHTML =
      '<div class="sl-meta">' +
      '<h1 class="sl-title"></h1>' +
      '<p class="sl-sub"><span class="sl-artist"></span><span class="sl-sep">·</span><span class="sl-album"></span></p>' +
      '</div>' +
      '<div class="sl-actions">' +
      '<span class="sl-badge" title="Lyric source"><i class="sl-badge-dot"></i><span class="sl-badge-text">NO LYRICS</span></span>' +
      '<button type="button" class="sl-icon sl-open-settings" aria-label="Lyrics settings" aria-expanded="false" title="Settings — G">' +
      ICON_GEAR +
      '</button>' +
      '<button type="button" class="sl-icon sl-close" aria-label="Close lyrics" title="Close — Esc">' +
      ICON_CLOSE +
      '</button>' +
      '</div>';
    stage.appendChild(header);

    const titleEl = header.querySelector('.sl-title');
    const artistEl = header.querySelector('.sl-artist');
    const albumEl = header.querySelector('.sl-album');
    const sepEl = header.querySelector('.sl-sep');
    const badgeEl = header.querySelector('.sl-badge-text');
    const gearBtn = header.querySelector('.sl-open-settings');
    const closeBtn = header.querySelector('.sl-close');

    // -------------------------------------------------------------------------
    // Status pill
    // -------------------------------------------------------------------------
    const statusEl = document.createElement('div');
    statusEl.className = 'sl-status';
    statusEl.setAttribute('role', 'status');
    statusEl.hidden = true;
    statusEl.innerHTML = '<span class="sl-status-dot"></span><span class="sl-status-text"></span>';
    stage.appendChild(statusEl);
    const statusText = statusEl.querySelector('.sl-status-text');
    let statusTimer = 0;

    function setStatus(text) {
      clearTimeout(statusTimer);
      if (!text) {
        statusEl.hidden = true;
        statusEl.classList.remove('is-visible');
        return;
      }
      statusText.textContent = String(text);
      statusEl.hidden = false;
      // Force a frame so the transition runs when re-showing the same pill.
      requestAnimationFrame(() => statusEl.classList.add('is-visible'));
    }

    function flashStatus(text) {
      setStatus(text);
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => setStatus(null), 1800);
    }

    // -------------------------------------------------------------------------
    // Settings panel
    // -------------------------------------------------------------------------
    const panel = document.createElement('div');
    panel.className = 'sl-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Lyrics settings');
    panel.tabIndex = -1;
    panel.hidden = true;

    const toggleRows = TOGGLES.map(
      (t) =>
        '<label class="sl-toggle-row">' +
        '<span class="sl-toggle-label">' +
        t.label +
        '</span>' +
        '<input type="checkbox" data-key="' +
        t.key +
        '"><i class="sl-switch" aria-hidden="true"></i>' +
        '</label>'
    ).join('');

    const rangeRows = RANGES.map(
      (r) =>
        '<label class="sl-range-row">' +
        '<span class="sl-range-top"><span class="sl-range-label">' +
        r.label +
        '</span><span class="sl-range-value" data-value="' +
        r.key +
        '"></span></span>' +
        '<input type="range" data-key="' +
        r.key +
        '" min="' +
        r.min +
        '" max="' +
        r.max +
        '" step="' +
        r.step +
        '">' +
        '</label>'
    ).join('');

    panel.innerHTML =
      '<div class="sl-panel-head">' +
      '<span class="sl-panel-title">Lyrics settings</span>' +
      '<button type="button" class="sl-icon sl-panel-close" data-action="close-panel" aria-label="Close settings">' +
      ICON_CLOSE +
      '</button>' +
      '</div>' +
      '<div class="sl-panel-body">' +
      '<div class="sl-group"><div class="sl-group-title">Style</div>' +
      '<div class="sl-seg-row"><span class="sl-toggle-label">Lyrics</span>' +
      '<div class="sl-seg sl-seg-wide" role="group" aria-label="Lyric motion mode">' +
      '<button type="button" data-seg-key="lyricMode" data-seg-value="cinema">Cinema</button>' +
      '<button type="button" data-seg-key="lyricMode" data-seg-value="flow">Flow</button>' +
      '<button type="button" data-seg-key="lyricMode" data-seg-value="simple">Simple</button>' +
      '</div></div>' +
      '<div class="sl-seg-row"><span class="sl-toggle-label">Background</span>' +
      '<div class="sl-seg sl-seg-wide" role="group" aria-label="Background style">' +
      '<button type="button" data-seg-key="backgroundStyle" data-seg-value="artwork">Art</button>' +
      '<button type="button" data-seg-key="backgroundStyle" data-seg-value="artwork-sharp">Cover</button>' +
      '<button type="button" data-seg-key="backgroundStyle" data-seg-value="gradient">Glow</button>' +
      '<button type="button" data-seg-key="backgroundStyle" data-seg-value="solid">Flat</button>' +
      '<button type="button" data-seg-key="backgroundStyle" data-seg-value="video">Video</button>' +
      '<button type="button" data-seg-key="backgroundStyle" data-seg-value="image">Custom</button>' +
      '</div></div>' +
      '</div>' +
      '<div class="sl-group"><div class="sl-group-title">Highlight</div>' +
      '<div class="sl-seg-row"><span class="sl-toggle-label">Word fill</span>' +
      '<div class="sl-seg" role="group" aria-label="Word fill style">' +
      '<button type="button" data-seg-key="wordHighlight" data-seg-value="gradient">Gradient</button>' +
      '<button type="button" data-seg-key="wordHighlight" data-seg-value="solid">Solid</button>' +
      '</div></div>' +
      '<div class="sl-offset-row"><span class="sl-toggle-label">Sync offset</span>' +
      '<div class="sl-offset-ctrl">' +
      '<button type="button" class="sl-mini" data-offset="-100" aria-label="Offset lyrics 100 milliseconds earlier">−100</button>' +
      '<span class="sl-offset-value" data-value="offsetMs"></span>' +
      '<button type="button" class="sl-mini" data-offset="100" aria-label="Offset lyrics 100 milliseconds later">+100</button>' +
      '</div></div>' +
      '</div>' +
      '<div class="sl-group"><div class="sl-group-title">Layout</div>' +
      rangeRows +
      '</div>' +
      '<div class="sl-group"><div class="sl-group-title">Playback</div>' +
      toggleRows +
      '</div>' +
      '</div>' +
      '<div class="sl-panel-foot"><span class="sl-hint">G settings · ↑↓ offset · Esc close</span><span class="sl-brand">SPICY LYRICS</span></div>';
    stage.appendChild(panel);

    const offsetValue = panel.querySelector('[data-value="offsetMs"]');
    const segButtons = Array.from(panel.querySelectorAll('[data-seg-key]'));
    const rangeInputs = Array.from(panel.querySelectorAll('input[type="range"][data-key]'));
    const checkInputs = Array.from(panel.querySelectorAll('input[type="checkbox"][data-key]'));

    let panelOpen = false;
    let lastSettingsJson = '';

    function renderPanel(settings) {
      for (const input of checkInputs) {
        const on = !!settings[input.dataset.key];
        if (input.checked !== on) input.checked = on;
      }
      for (const input of rangeInputs) {
        const value = Number(settings[input.dataset.key]);
        if (document.activeElement !== input && Math.abs(Number(input.value) - value) > 1e-6) {
          input.value = String(value);
        }
        const label = panel.querySelector('[data-value="' + input.dataset.key + '"]');
        if (label) label.textContent = fmt(input.dataset.key, value);
      }
      for (const button of segButtons) {
        const active = settings[button.dataset.segKey] === button.dataset.segValue;
        button.classList.toggle('is-on', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
      if (offsetValue) offsetValue.textContent = fmt('offsetMs', settings.offsetMs || 0);
    }

    function openPanel() {
      if (panelOpen) return;
      panelOpen = true;
      panel.hidden = false;
      requestAnimationFrame(() => panel.classList.add('is-open'));
      gearBtn.setAttribute('aria-expanded', 'true');
      stage.classList.add('has-panel');
      renderPanel(SL.store.get().settings);
      wake();
      panel.focus({ preventScroll: true });
    }

    function closePanel() {
      if (!panelOpen) return;
      panelOpen = false;
      panel.classList.remove('is-open');
      gearBtn.setAttribute('aria-expanded', 'false');
      stage.classList.remove('has-panel');
      window.setTimeout(() => {
        if (!panelOpen) panel.hidden = true;
      }, 180);
      wake();
    }

    function togglePanel() {
      if (panelOpen) closePanel();
      else openPanel();
    }

    // -------------------------------------------------------------------------
    // Panel interaction
    // -------------------------------------------------------------------------

    function persist(partial) {
      SL.store.updateSettings(partial);
      SL.store.saveSettings();
    }

    panel.addEventListener('change', (event) => {
      const input = event.target;
      if (input.matches && input.matches('input[type="checkbox"][data-key]')) {
        persist({ [input.dataset.key]: input.checked });
      }
    });

    panel.addEventListener('input', (event) => {
      const input = event.target;
      if (input.matches && input.matches('input[type="range"][data-key]')) {
        persist({ [input.dataset.key]: Number(input.value) });
      }
    });

    panel.addEventListener('click', (event) => {
      const target = event.target;
      if (!target || !target.closest) return;
      if (target.closest('[data-action="close-panel"]')) {
        closePanel();
        return;
      }
      const seg = target.closest('[data-seg-key]');
      if (seg) {
        persist({ [seg.dataset.segKey]: seg.dataset.segValue });
        return;
      }
      const offset = target.closest('[data-offset]');
      if (offset) {
        const delta = Number(offset.dataset.offset) || 0;
        const next = util.clamp((SL.store.get().settings.offsetMs || 0) + delta, -20000, 20000);
        persist({ offsetMs: next });
        flashStatus('SYNC OFFSET ' + fmt('offsetMs', next));
      }
    });

    // -------------------------------------------------------------------------
    // Idle chrome
    // -------------------------------------------------------------------------
    let idleTimer = 0;
    let idle = false;

    function wake() {
      clearTimeout(idleTimer);
      if (idle) {
        idle = false;
        stage.classList.remove('is-idle');
      }
      idleTimer = window.setTimeout(() => {
        if (panelOpen) return;
        // The app can mount us through autoOpen (Spotify's own lyrics view) as
        // well as through ui.open; either way the chrome should fade.
        if (stage.dataset.open !== '1') return;
        idle = true;
        stage.classList.add('is-idle');
      }, 3000);
    }

    const onPointerActivity = () => wake();
    stage.addEventListener('pointermove', onPointerActivity, { passive: true });
    stage.addEventListener('pointerdown', onPointerActivity, { passive: true });

    // -------------------------------------------------------------------------
    // Keyboard
    // -------------------------------------------------------------------------
    function onKeyDown(event) {
      const state = SL.store.get();
      if (!state.ui.open || !state.settings.enabled) return;
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        if (event.key === 'Escape' && panelOpen) {
          event.preventDefault();
          closePanel();
        }
        return;
      }
      if (event.key === 'Escape') {
        if (panelOpen) {
          event.preventDefault();
          event.stopPropagation();
          closePanel();
        } else if (callbacks.onClose) {
          event.preventDefault();
          event.stopPropagation();
          callbacks.onClose();
        }
        return;
      }
      if (event.key === 'g' || event.key === 'G') {
        event.preventDefault();
        togglePanel();
        return;
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        const delta = event.key === 'ArrowUp' ? 100 : -100;
        const next = util.clamp((state.settings.offsetMs || 0) + delta, -20000, 20000);
        event.preventDefault();
        persist({ offsetMs: next });
        flashStatus('SYNC OFFSET ' + fmt('offsetMs', next));
      }
    }

    window.addEventListener('keydown', onKeyDown, true);

    gearBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      togglePanel();
    });
    closeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (callbacks.onClose) callbacks.onClose();
    });

    // -------------------------------------------------------------------------
    // Update from store
    // -------------------------------------------------------------------------

    let lastMeta = '';

    function update(state) {
      const track = state.track || {};
      const doc = state.lyrics;
      const title = track.title || 'Nothing playing';
      const artist = track.artist || '';
      const album = track.album || '';
      const metaSig = [title, artist, album, syncLabel(doc, state.lyricsStatus)].join('\u0001');
      if (metaSig !== lastMeta) {
        lastMeta = metaSig;
        titleEl.textContent = title;
        artistEl.textContent = artist;
        albumEl.textContent = album;
        sepEl.hidden = !artist || !album;
        badgeEl.textContent = syncLabel(doc, state.lyricsStatus);
        header.classList.toggle('is-idle-ready', false);
      }

      const settings = state.settings || {};
      const chromeHidden = settings.minimalMode || settings.showHeader === false;
      stage.classList.toggle('is-chrome-hidden', !!chromeHidden);
      stage.classList.toggle('is-minimal', !!settings.minimalMode);

      const settingsJson = JSON.stringify(settings);
      if (settingsJson !== lastSettingsJson) {
        lastSettingsJson = settingsJson;
        renderPanel(settings);
      }

      // Keep the idle countdown alive while the overlay is visible so the
      // chrome fades on a page the user is simply watching.
      if (stage.dataset.open === '1' && !idleTimer) wake();
    }

    function destroy() {
      clearTimeout(idleTimer);
      clearTimeout(statusTimer);
      window.removeEventListener('keydown', onKeyDown, true);
      stage.removeEventListener('pointermove', onPointerActivity);
      stage.removeEventListener('pointerdown', onPointerActivity);
      header.remove();
      panel.remove();
      statusEl.remove();
    }

    // Start the idle countdown immediately so a mouse-less page settles down.
    wake();

    return {
      headerEl: header,
      panelEl: panel,
      statusEl,
      update,
      setStatus,
      flashStatus,
      openPanel,
      closePanel,
      togglePanel,
      isPanelOpen: () => panelOpen,
      destroy,
    };
  }

  SL.controls = { create };
})();
