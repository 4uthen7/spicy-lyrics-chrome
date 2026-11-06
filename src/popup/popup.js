/** Popup: settings UI plus a live status read from the active Spotify tab. */
(() => {
  'use strict';
  const SL = globalThis.SL;
  const $ = (id) => document.getElementById(id);

  const TOGGLES = ['enabled', 'autoOpen', 'autoFetch', 'minimalMode', 'showHeader', 'showInterludeDots', 'showBackground', 'backgroundMotion', 'reduceMotion'];
  const SELECTS = ['mode', 'wordHighlight', 'lyricMode', 'backgroundStyle'];
  const RANGES = {
    fontSize: (v) => Number(v).toFixed(2) + 'x',
    lineGap: (v) => Number(v).toFixed(2) + 'x',
    backgroundBlur: (v) => Math.round(v) + 'px',
    backgroundDim: (v) => Number(v).toFixed(2),
    offsetMs: (v) => (v > 0 ? '+' : '') + Math.round(v) + ' ms',
  };

  let settings = { ...SL.store.DEFAULT_SETTINGS };

  function paint() {
    for (const key of TOGGLES) {
      const input = $(key);
      if (input) input.checked = !!settings[key];
    }
    for (const key of SELECTS) {
      const input = $(key);
      if (input) input.value = settings[key];
    }
    for (const [key, fmt] of Object.entries(RANGES)) {
      const input = $(key);
      const out = $(key + '-out');
      if (input) input.value = settings[key];
      if (out) out.textContent = fmt(settings[key]);
    }
    document.body.classList.toggle('is-disabled', !settings.enabled);
    $('toggle-overlay').disabled = !settings.enabled;
  }

  function commit(partial) {
    settings = SL.store.updateSettings(partial);
    SL.store.saveSettings();
    paint();
  }

  function wire() {
    for (const key of TOGGLES) {
      const input = $(key);
      if (input) input.addEventListener('change', () => commit({ [key]: input.checked }));
    }
    for (const key of SELECTS) {
      const input = $(key);
      if (input) input.addEventListener('change', () => commit({ [key]: input.value }));
    }
    for (const key of Object.keys(RANGES)) {
      const input = $(key);
      if (input) input.addEventListener('input', () => commit({ [key]: Number(input.value) }));
    }
    $('toggle-overlay').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'spicy:toggle' }).catch(() => {});
      setTimeout(refreshStatus, 120);
    });
    $('clear-cache').addEventListener('click', async () => {
      const btn = $('clear-cache');
      btn.textContent = 'Clearing…';
      try {
        const res = await chrome.runtime.sendMessage({ type: 'spicy:clear-cache' });
        btn.textContent = 'Cleared ' + ((res && res.cleared) || 0);
      } catch {
        btn.textContent = 'Failed';
      }
      setTimeout(() => (btn.textContent = 'Clear cache'), 1400);
    });
    const fileInput = $('ttml-file');
    $('import-ttml').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const btn = $('import-ttml');
      btn.textContent = 'Reading…';
      try {
        const text = await file.text();
        const tab = await activeTab();
        if (!tab || !tab.url || !tab.url.startsWith('https://open.spotify.com/')) throw new Error('Open a Spotify tab first');
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'spicy:import-ttml', text });
        btn.textContent = res && res.ok ? 'Imported ' + res.lines + ' lines' : 'Import failed';
      } catch {
        btn.textContent = 'Import failed';
      }
      fileInput.value = '';
      setTimeout(() => (btn.textContent = 'Import…'), 2200);
      refreshStatus();
    });
    $('copy-diag').addEventListener('click', async () => {
      const btn = $('copy-diag');
      try {
        const tab = await activeTab();
        const diag = tab ? await chrome.tabs.sendMessage(tab.id, { type: 'spicy:diagnostics' }) : { error: 'no Spotify tab' };
        const text = JSON.stringify(diag, null, 2);
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copied';
        console.log('[spicy] diagnostics', text);
      } catch (err) {
        btn.textContent = 'Copy failed';
        console.error('[spicy] diagnostics failed', err);
      }
      setTimeout(() => (btn.textContent = 'Copy diagnostics'), 1800);
    });

    const bgPick = $('bg-image');
    $('bg-image-pick').addEventListener('click', () => bgPick.click());
    bgPick.addEventListener('change', async () => {
      const file = bgPick.files && bgPick.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          await chrome.storage.local.set({ 'spicy.bgImage': String(reader.result) });
          commit({ backgroundStyle: 'image', showBackground: true });
        } catch (err) {
          console.warn('[spicy] background image save failed', err);
        }
      };
      reader.readAsDataURL(file);
      bgPick.value = '';
    });
    $('bg-image-clear').addEventListener('click', async () => {
      await chrome.storage.local.remove('spicy.bgImage').catch(() => {});
      commit({ backgroundStyle: 'artwork' });
    });

    $('reset').addEventListener('click', async () => {
      settings = SL.store.setSettings(SL.store.DEFAULT_SETTINGS);
      SL.store.saveSettings();
      paint();
      await refreshStatus();
    });
  }

  async function activeTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return (tabs && tabs[0]) || null;
  }

  async function refreshStatus() {
    const pill = $('status-pill');
    const title = $('status-title');
    const sub = $('status-sub');
    pill.className = 'pill is-off';
    pill.textContent = 'off';
    const tab = await activeTab();
    const onSpotify = tab && tab.url && tab.url.startsWith('https://open.spotify.com/');
    if (!onSpotify) {
      title.textContent = 'Not on Spotify';
      sub.textContent = 'Open open.spotify.com and play a song.';
      $('source-label').textContent = '—';
      const hint = $('detect-hint');
      hint.textContent = '';
      hint.classList.remove('is-warn');
      return;
    }
    try {
      const state = await chrome.tabs.sendMessage(tab.id, { type: 'spicy:get-state' });
      if (!state || !state.ok) throw new Error('no state');
      $('source-label').textContent = state.source ? state.source + ' · ' + (state.syncType || '?') : '—';
      const hint = $('detect-hint');
      if (state.detected) {
        hint.textContent = 'player detected';
        hint.classList.remove('is-warn');
      } else {
        hint.textContent = 'player bar not detected';
        hint.classList.add('is-warn');
      }
      title.textContent = state.title || 'Nothing playing';
      sub.textContent = [state.artist, state.open ? 'overlay open' : 'overlay closed'].filter(Boolean).join(' · ') || 'Waiting for playback';
      if (!settings.enabled) {
        pill.className = 'pill is-off';
        pill.textContent = 'off';
      } else if (state.syncType === 'word') {
        pill.className = 'pill is-word';
        pill.textContent = 'word';
      } else if (state.syncType === 'line') {
        pill.className = 'pill is-line';
        pill.textContent = 'line';
      } else {
        pill.className = 'pill';
        pill.textContent = state.status || 'idle';
      }
    } catch {
      title.textContent = 'Spotify tab is ready';
      sub.textContent = 'Reload the tab once after installing the extension.';
      pill.className = 'pill is-off';
      pill.textContent = 'reload';
    }
  }

  try {
    $('version').textContent = 'v' + chrome.runtime.getManifest().version;
  } catch {
    /* ignore */
  }

  (async () => {
    try {
      await SL.store.loadSettings();
      settings = SL.store.get().settings;
    } catch {
      settings = SL.store.sanitizeSettings({});
    }
    paint();
    wire();
    await refreshStatus();
    setInterval(refreshStatus, 1200);
  })();
})();
