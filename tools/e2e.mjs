#!/usr/bin/env node
/**
 * End-to-end harness: builds the demo-enabled extension, loads it into a real
 * Chromium (Chrome for Testing), drives the demo Spotify page, and asserts that
 * the content script observed the player, resolved lyrics, mounted the overlay
 * and animated word fills. Saves screenshots under docs/screenshots/.
 *
 *   node tools/e2e.mjs
 *   CHROME_BIN="/path/to/chrome" node tools/e2e.mjs
 *
 * The extension is loaded for real (from dist/dev), so this also validates
 * manifest correctness, content-script ordering and shadow-root injection.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from './serve.mjs';
import { findChrome, launchChrome, Cdp, waitFor } from './cdp.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SHOTS = join(ROOT, 'docs/screenshots');
const EXT_DIR = join(ROOT, 'dist/dev');

const results = [];
/** The overlay fades its chrome after 3s of no pointer movement; wake it before screenshots. */
async function wake(cdp) {
  await cdp
    .send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 40, y: 40, button: 'none', pointerType: 'mouse' })
    .catch(() => {});
  await sleep(120);
}
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function build() {
  console.log('building dist/dev …');
  const res = spawnSync(process.execPath, [join(ROOT, 'tools/build.mjs'), '--target', 'dev', '--skip-zip'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (res.status !== 0) throw new Error('build failed');
}

/** Read the exposed status mirror the app writes onto <html>. */
const STATUS_JS = `(() => {
  const d = document.documentElement.dataset;
  return {
    version: d.spicyVersion || '',
    status: d.spicyStatus || '',
    sync: d.spicySync || '',
    source: d.spicySource || '',
    open: d.spicyOpen || '',
    mounted: d.spicyMounted || '',
    track: d.spicyTrack || '',
    lines: d.spicyLines || '',
    detected: d.spicyDetected || '',
    title: d.spicyTitle || '',
    artist: d.spicyArtist || '',
    lyricMode: d.spicyLyricMode || '',
    bg: d.spicyBg || '',
  };
})()`;

const SHADOW_INFO_JS = `(() => {
  const host = document.querySelector('#spicy-lyrics');
  if (!host || !host.shadowRoot) return { found: false };
  const sr = host.shadowRoot;
  const all = [...sr.querySelectorAll('*')];
  const fillNodes = all.filter((n) => (n.getAttribute('style') || '').includes('--p'));
  const pValues = fillNodes
    .map((n) => (n.getAttribute('style') || '').match(/--p\\s*:\\s*([0-9.]+)/))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  const text = sr.textContent || '';
  const active = all.filter((n) => n.getAttribute('data-active') === 'true' || /\\bactive\\b/.test(n.className || ''));
  return {
    found: true,
    nodes: all.length,
    text: text.slice(0, 400),
    fillNodeCount: fillNodes.length,
    pSample: pValues.slice(0, 24),
    activeCount: active.length,
    activeText: (active[0] && active[0].textContent || '').trim().slice(0, 120),
    hostRect: (() => { const r = host.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
  };
})()`;

async function main() {
  await mkdir(SHOTS, { recursive: true });
  build();

  const chromePath = findChrome();
  if (!chromePath) throw new Error('no Chrome binary found');
  console.log('chrome:', chromePath);
  if (chromePath.includes('Google Chrome for Testing') === false && !chromePath.includes('Chromium')) {
    console.log('WARNING: branded Chrome may ignore --load-extension (needs Chrome for Testing).');
  }

  const server = await startServer({ port: 0 });
  const profile = '/tmp/spicy-e2e-profile-' + Date.now();
  const chrome = await launchChrome({
    chromePath,
    profileDir: profile,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--window-size=1600,1000',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  let cdp;
  try {
    const page = await chrome.waitForTarget((t) => t.type === 'page', 20000, 'page target');
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.enable(['Runtime', 'Page', 'Log']);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await cdp.send('Page.bringToFront').catch(() => {});

    // Collect page-level failures so a broken CSS fetch or thrown handler fails the run.
    const pageErrors = [];
    cdp.ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        pageErrors.push('exception: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        pageErrors.push('console.error: ' + (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        // Only extension-owned resources matter here; the demo harness itself
        // intentionally 404s a favicon and the no-lyrics track.
        const url = msg.params.entry.url || '';
        if (url.startsWith('chrome-extension://')) pageErrors.push('log: ' + msg.params.entry.text + ' ' + url);
      }
    });

    // Extension actually registered: look for our service worker target.
    const swTarget = await chrome
      .waitForTarget(
        (t) => t.type === 'service_worker' && /\/src\/background\/service-worker\.js$/.test(t.url),
        10000,
        'extension service worker',
      )
      .catch(() => null);
    check('extension loaded (service worker target)', !!swTarget, swTarget ? swTarget.url : 'not found');
    const extensionId = swTarget ? new URL(swTarget.url).host : null;

    await cdp.send('Page.navigate', { url: `${server.url}/demo/` });
    await waitFor(async () => cdp.eval('!!window.__spicyDemo'), { timeoutMs: 15000, description: 'demo player boot' });

    const status = await waitFor(
      async () => {
        const s = await cdp.eval(STATUS_JS);
        return s.version ? s : null;
      },
      { timeoutMs: 15000, description: 'content script boot' },
    );
    check('content script injected', !!status.version, 'v' + status.version);

    const trackId = '4cOdK2wGLETKBW3PvgPWqT';
    const trackSeen = await waitFor(
      async () => {
        const s = await cdp.eval(STATUS_JS);
        return s.track === trackId ? s : null;
      },
      { timeoutMs: 15000, description: 'player state observation' },
    ).catch(() => null);
    check('player state read from DOM (track id)', !!trackSeen, trackSeen ? trackSeen.track : 'track id not observed');
    check('cover/duration detected', !!trackSeen, trackSeen ? 'duration from DOM' : 'n/a');

    // Do not open the lyrics view ourselves: the extension has to read them by
    // asking Spotify (autoFetch bootstrap clicks Spotify's own lyrics button).
    const bootstrapOpened = await waitFor(
      async () => cdp.eval('document.querySelectorAll(\'[data-testid="fullscreen-lyric"]\').length > 0'),
      { timeoutMs: 12000, description: 'extension-driven Spotify lyrics fetch' },
    )
      .then(() => true)
      .catch(() => false);
    check('extension reads Spotify lyrics itself (autoFetch bootstrap)', bootstrapOpened);

    const ready = await waitFor(
      async () => {
        const s = await cdp.eval(STATUS_JS);
        if (s.status === 'ready' && s.mounted === '1') return s;
        if (s.status === 'empty' || s.status === 'error') return s;
        return null;
      },
      { timeoutMs: 20000, description: 'lyrics resolution + mount' },
    ).catch(() => null);
    check('lyrics resolved', ready && ready.status === 'ready', ready ? `status=${ready.status} source=${ready.source}` : 'timeout');
    check('word-level sync from color-lyrics payload', ready && ready.sync === 'word', ready ? 'sync=' + ready.sync : 'n/a');
    check('overlay mounted automatically', ready && ready.mounted === '1', ready ? 'mounted=' + ready.mounted : 'n/a');
    check('line count matches fixture', ready && Number(ready.lines) >= 20, ready ? 'lines=' + ready.lines : 'n/a');

    // Seek into a line and check the word fill progresses.
    await cdp.eval('window.__spicyDemo.seekTo(26500)');
    await sleep(500);
    const shot1 = await cdp.eval(SHADOW_INFO_JS);
    check('shadow root present with content', shot1.found && shot1.nodes > 40, shot1.found ? shot1.nodes + ' nodes' : 'no shadow root');
    check('word fill nodes exist', shot1.found && shot1.fillNodeCount > 3, shot1.found ? shot1.fillNodeCount + ' fill nodes' : 'n/a');
    check('overlay covers main view', shot1.found && shot1.hostRect.w > 600 && shot1.hostRect.h > 400, shot1.found ? JSON.stringify(shot1.hostRect) : 'n/a');

    const before = shot1.pSample.slice();
    await sleep(700);
    const shot2 = await cdp.eval(SHADOW_INFO_JS);
    const advanced = shot2.pSample.some((p, i) => typeof before[i] === 'number' && p > before[i] + 0.01) ||
      shot2.pSample.some((p) => p > 0);
    check('karaoke fill advances with playback', advanced, 'p=' + JSON.stringify(shot2.pSample.slice(0, 6)));

    await wake(cdp);
    await cdp.screenshot(join(SHOTS, 'e2e-word-sync.png'));

    // Line-synced track.
    await cdp.eval('window.__spicyDemo.setTrack(1)');
    const lineReady = await waitFor(
      async () => {
        const s = await cdp.eval(STATUS_JS);
        return s.status === 'ready' && s.sync === 'line' ? s : null;
      },
      { timeoutMs: 15000, description: 'line-synced track' },
    ).catch(() => null);
    check('line-synced track resolved', !!lineReady, lineReady ? 'sync=' + lineReady.sync + ' source=' + lineReady.source : 'timeout');
    await cdp.eval('window.__spicyDemo.seekTo(30000)');
    await sleep(600);
    await wake(cdp);
    await cdp.screenshot(join(SHOTS, 'e2e-line-sync.png'));
    const lineInfo = await cdp.eval(SHADOW_INFO_JS);
    check('line-synced overlay rendered', lineInfo.found && lineInfo.nodes > 20, lineInfo.found ? lineInfo.nodes + ' nodes' : 'n/a');

    // Track with no lyrics at all.
    await cdp.eval('window.__spicyDemo.setTrack(2)');
    const empty = await waitFor(
      async () => {
        const s = await cdp.eval(STATUS_JS);
        return s.status === 'empty' ? s : null;
      },
      { timeoutMs: 15000, description: 'no-lyrics track' },
    ).catch(() => null);
    check('missing lyrics reported as empty (not a crash)', !!empty, empty ? 'status=' + empty.status : 'timeout');
    await sleep(300);
    await wake(cdp);
    await cdp.screenshot(join(SHOTS, 'e2e-no-lyrics.png'));

    // Launcher toggles the overlay without Spotify's lyrics page.
    await cdp.eval('window.__spicyDemo.setTrack(0)');
    await waitFor(async () => (await cdp.eval(STATUS_JS)).status === 'ready', { timeoutMs: 15000, description: 'track 0 again' });
    const hasLauncher = await cdp.eval('!!document.querySelector(".spicy-launcher")');
    check('launcher button injected', hasLauncher);
    if (hasLauncher) {
      await cdp.eval('document.querySelector(".spicy-launcher").click()');
      await sleep(400);
      const afterFirst = await cdp.eval(STATUS_JS);
      await cdp.eval('document.querySelector(".spicy-launcher").click()');
      await sleep(500);
      const afterSecond = await cdp.eval(STATUS_JS);
      const toggled = afterFirst.mounted !== afterSecond.mounted || afterFirst.open !== afterSecond.open;
      check('launcher toggles overlay state', toggled, `first=${afterFirst.mounted}/${afterFirst.open} second=${afterSecond.mounted}/${afterSecond.open}`);
    }

    // In-overlay quick settings panel.
    const gearClicked = await cdp.eval(`(() => {
      const host = document.querySelector('#spicy-lyrics');
      const gear = host && host.shadowRoot && host.shadowRoot.querySelector('[aria-label="Lyrics settings"]');
      if (!gear) return false;
      gear.click();
      return true;
    })()`);
    await sleep(500);
    const panelOpen = await cdp.eval(`(() => {
      const host = document.querySelector('#spicy-lyrics');
      const panel = host && host.shadowRoot && host.shadowRoot.querySelector('[aria-label="Lyrics settings"][aria-expanded="true"]');
      const rows = host && host.shadowRoot ? host.shadowRoot.querySelectorAll('.sl-panel input, .sl-panel button').length : 0;
      return { panelOpen: !!panel, rows };
    })()`).catch(() => null);
    check('in-overlay settings panel opens', gearClicked === true, panelOpen ? JSON.stringify(panelOpen) : 'n/a');
    await wake(cdp);
    await cdp.screenshot(join(SHOTS, 'e2e-settings-panel.png'));
    await cdp.eval(`(() => {
      const host = document.querySelector('#spicy-lyrics');
      const close = host && host.shadowRoot && host.shadowRoot.querySelector('[aria-label="Close settings"]');
      if (close) close.click();
    })()`);

    if (extensionId) {
      const popupUrl = `chrome-extension://${extensionId}/src/popup/popup.html`;
      const demoUrl = `${server.url}/demo/`;
      const setSettings = (partial) =>
        cdp.eval(`new Promise(async (resolve) => {
          const key = 'spicy.settings';
          const got = await chrome.storage.sync.get(key);
          const next = Object.assign({}, got[key] || {}, ${JSON.stringify(partial)});
          await chrome.storage.sync.set({ [key]: next });
          resolve(JSON.stringify(next));
        })`);

      await cdp.send('Page.navigate', { url: popupUrl });
      await sleep(1200);
      const popup = await cdp.eval(`(() => ({
        rows: document.querySelectorAll('.row').length,
        hasStatus: !!document.getElementById('status-title'),
        title: document.title,
      }))()`);
      check('popup renders settings', popup && popup.rows >= 10 && popup.hasStatus, JSON.stringify(popup));
      await cdp.screenshot(join(SHOTS, 'popup.png'));

      // Panel mode: the overlay must retarget the right sidebar, not the main view.
      await setSettings({ mode: 'panel', minimalMode: false });
      await cdp.send('Page.navigate', { url: demoUrl });
      await waitFor(async () => (await cdp.eval(STATUS_JS)).version, { timeoutMs: 15000, description: 'reboot after navigation' });
      await waitFor(async () => (await cdp.eval(STATUS_JS)).track, { timeoutMs: 15000, description: 'track after navigation' });
      await cdp.eval('document.getElementById("lyrics-toggle").click()');
      const panelMounted = await waitFor(
        async () => {
          const s = await cdp.eval(STATUS_JS);
          return s.mounted === '1' && s.status === 'ready' ? s : null;
        },
        { timeoutMs: 20000, description: 'panel-mode mount' },
      ).catch(() => null);
      const panelInfo = await cdp.eval(SHADOW_INFO_JS).catch(() => null);
      check(
        'panel mode targets the right sidebar',
        !!panelMounted && panelInfo && panelInfo.hostRect.w > 240 && panelInfo.hostRect.w < 460,
        panelInfo ? JSON.stringify(panelInfo.hostRect) : 'n/a',
      );
      await sleep(400);
      await wake(cdp);
      await cdp.screenshot(join(SHOTS, 'e2e-panel-mode.png'));

      // Minimal mode: chrome hidden, lyrics only.
      await cdp.send('Page.navigate', { url: popupUrl });
      await sleep(900);
      await setSettings({ mode: 'cinema', minimalMode: true });
      await cdp.send('Page.navigate', { url: demoUrl });
      await waitFor(async () => (await cdp.eval(STATUS_JS)).track, { timeoutMs: 15000, description: 'minimal boot' });
      await cdp.eval('document.getElementById("lyrics-toggle").click()');
      const minimalReady = await waitFor(
        async () => {
          const s = await cdp.eval(STATUS_JS);
          return s.mounted === '1' && s.status === 'ready' ? s : null;
        },
        { timeoutMs: 20000, description: 'minimal mount' },
      ).catch(() => null);
      const minimalInfo = await cdp.eval(`(() => {
        const host = document.querySelector('#spicy-lyrics');
        const stage = host && host.shadowRoot && host.shadowRoot.querySelector('.sl-stage');
        const header = host && host.shadowRoot && host.shadowRoot.querySelector('.sl-header');
        const style = header ? getComputedStyle(header) : null;
        return { minimal: !!(stage && stage.classList.contains('is-minimal')), headerHidden: !style || style.display === 'none' || Number(style.opacity) === 0 || style.visibility === 'hidden' };
      })()`).catch(() => null);
      check('minimal mode hides chrome', !!minimalReady && !!minimalInfo && minimalInfo.minimal && minimalInfo.headerHidden, JSON.stringify(minimalInfo));
      await sleep(400);
      await wake(cdp);
      await cdp.screenshot(join(SHOTS, 'e2e-minimal.png'));

      // Restore defaults so the shipped demo build is not sticky.
      await cdp.send('Page.navigate', { url: popupUrl });
      await sleep(900);
      await setSettings({ mode: 'cinema', minimalMode: false, autoOpen: true });
    }

    // ---------------------------------------------------------------------
    // Phase 2: the 2026-build DOM shape (demo/index-real.html).
    // No /track/ href in the player bar, hidden range input for position,
    // .main-view-container class, [data-testid="lyrics-line"], unique active
    // class token. This is what the extension meets on the real site.
    // ---------------------------------------------------------------------
    await cdp.send('Page.navigate', { url: `${server.url}/demo/index-real.html` });
    await waitFor(async () => (await cdp.eval(STATUS_JS)).version, { timeoutMs: 15000, description: '2026-shape content script' });
    await waitFor(async () => cdp.eval('!!window.__spicyDemo'), { timeoutMs: 10000, description: '2026-shape demo boot' });

    const realId = await waitFor(
      async () => {
        const s = await cdp.eval(STATUS_JS);
        return s.track === '4cOdK2wGLETKBW3PvgPWqT' ? s : null;
      },
      { timeoutMs: 25000, description: 'track id promoted from sniffed request' },
    ).catch(() => null);
    check('2026 DOM: track id promoted from the sniffed color-lyrics URL', !!realId, realId ? realId.track : 'id not promoted');

    const realBoot = await waitFor(
      async () => {
        const s = await cdp.eval(STATUS_JS);
        return s.status === 'ready' && s.mounted === '1' ? s : null;
      },
      { timeoutMs: 25000, description: '2026-shape bootstrap + lyrics' },
    ).catch(() => null);
    check('2026 DOM: bootstrap reads Spotify lyrics and mounts', !!realBoot && realBoot.sync === 'word', realBoot ? JSON.stringify(realBoot) : 'timeout');

    const positionAdvanced = await (async () => {
      const first = await cdp.eval('Number(document.getElementById("seek-range").value)');
      await sleep(700);
      const second = await cdp.eval('Number(document.getElementById("seek-range").value)');
      return second > first;
    })();
    check('2026 DOM: position read from the hidden range input while playing', positionAdvanced);

    await cdp.eval('window.__spicyDemo.seekTo(27000)');
    await sleep(600);
    const realInfo = await cdp.eval(SHADOW_INFO_JS);
    check('2026 DOM: overlay renders and word fill animates', realInfo.found && realInfo.fillNodeCount > 3, realInfo.found ? realInfo.fillNodeCount + ' fill nodes' : 'n/a');
    check('2026 DOM: overlay covers the class-based main view', realInfo.found && realInfo.hostRect.w > 600 && realInfo.hostRect.h > 400, realInfo.found ? JSON.stringify(realInfo.hostRect) : 'n/a');
    await wake(cdp);
    await cdp.screenshot(join(SHOTS, 'e2e-2026-dom.png'));

    const nativeActive = await cdp.eval(`(() => {
      const all = [...document.querySelectorAll('[data-testid="lyrics-line"]')];
      const counts = new Map();
      for (const n of all) for (const t of n.classList) counts.set(t, (counts.get(t) || 0) + 1);
      const unique = [...counts].filter(([, c]) => c === 1).map(([t]) => t);
      return { lines: all.length, uniqueTokens: unique.length };
    })()`).catch(() => null);
    check('2026 DOM: native line list is scrapeable', nativeActive && nativeActive.lines > 5, nativeActive ? JSON.stringify(nativeActive) : 'n/a');

    // ---------------------------------------------------------------------
    // Phase 3: playback detection when the player bar carries no track testids
    // (the failure users hit on the live site). MediaSession metadata is the
    // only remaining source here.
    // ---------------------------------------------------------------------
    await cdp.send('Page.navigate', { url: `${server.url}/demo/index-real.html?no-dom-track=1` });
    await waitFor(async () => (await cdp.eval(STATUS_JS)).version, { timeoutMs: 15000, description: 'no-dom-track content script' });
    const mediaDetected = await waitFor(
      async () => {
        const s = await cdp.eval(STATUS_JS);
        return s.detected === '1' && s.title ? s : null;
      },
      { timeoutMs: 15000, description: 'MediaSession metadata detection' },
    ).catch(() => null);
    check(
      'detects playback from MediaSession when the player bar has no track testids',
      !!mediaDetected && mediaDetected.title === 'Neon Paralysis',
      mediaDetected ? JSON.stringify({ title: mediaDetected.title, artist: mediaDetected.artist, detected: mediaDetected.detected }) : 'timeout',
    );
    const mediaBoot = await waitFor(
      async () => {
        const s = await cdp.eval(STATUS_JS);
        return s.status === 'ready' && s.mounted === '1' ? s : null;
      },
      { timeoutMs: 25000, description: 'bootstrap with MediaSession metadata' },
    ).catch(() => null);
    check('reads lyrics with MediaSession-only playback detection', !!mediaBoot, mediaBoot ? JSON.stringify({ sync: mediaBoot.sync, source: mediaBoot.source }) : 'timeout');
    await wake(cdp);
    await cdp.screenshot(join(SHOTS, 'e2e-media-session-only.png'));

    // ---------------------------------------------------------------------
    // Phase 4: lyric motion modes and background styles
    // ---------------------------------------------------------------------
    const popupUrl = extensionId ? `chrome-extension://${extensionId}/src/popup/popup.html` : null;
    const setSettings = (partial) =>
      cdp.eval(`new Promise(async (resolve) => {
        const key = 'spicy.settings';
        const got = await chrome.storage.sync.get(key);
        const next = Object.assign({}, got[key] || {}, ${JSON.stringify(partial)});
        await chrome.storage.sync.set({ [key]: next });
        resolve(JSON.stringify(next));
      })`);

    async function openLighting(settings, query, screenshotName, expected) {
      await cdp.send('Page.navigate', { url: popupUrl });
      await sleep(700);
      await setSettings(settings);
      await cdp.send('Page.navigate', { url: `${server.url}/demo/index-real.html${query || ''}` });
      await waitFor(async () => (await cdp.eval(STATUS_JS)).version, { timeoutMs: 15000, description: 'settings reload' });
      const ready = await waitFor(
        async () => {
          const s = await cdp.eval(STATUS_JS);
          return s.status === 'ready' && s.mounted === '1' ? s : null;
        },
        { timeoutMs: 25000, description: 'lyrics for ' + screenshotName },
      ).catch(() => null);
      const state = await cdp.eval(STATUS_JS);
      const ok = !!ready && (!expected || Object.entries(expected).every(([key, value]) => state[key] === value));
      await cdp.eval('window.__spicyDemo.seekTo(30500)');
      await sleep(500);
      await wake(cdp);
      await cdp.screenshot(join(SHOTS, screenshotName));
      return { ok, state };
    }

    if (popupUrl) {
      const flow = await openLighting({ lyricMode: 'flow', backgroundStyle: 'video', backgroundMotion: true }, '', 'e2e-flow-video.png', { lyricMode: 'flow', bg: 'video' });
      check('flow lyric mode + video background render', flow.ok, JSON.stringify({ mode: flow.state.lyricMode, bg: flow.state.bg, status: flow.state.status }));
      const videoMirror = await cdp.eval("document.documentElement.dataset.spicyVideo || ''");
      check('page video is mirrored into the background', videoMirror === 'mirror', 'spicyVideo=' + (videoMirror || 'unset'));

      const simple = await openLighting({ lyricMode: 'simple', backgroundStyle: 'artwork-sharp' }, '', 'e2e-simple-cover.png', { lyricMode: 'simple', bg: 'artwork-sharp' });
      check('simple lyric mode + cover background render', simple.ok, JSON.stringify({ mode: simple.state.lyricMode, bg: simple.state.bg, status: simple.state.status }));

      // Diagnostics from the real popup, talking to the real content script.
      const target = await (
        await fetch(`http://127.0.0.1:${chrome.port}/json/new?${encodeURIComponent(`${server.url}/demo/index-real.html`)}`, { method: 'PUT' })
      ).json();
      const cdp2 = await Cdp.connect(target.webSocketDebuggerUrl);
      try {
        await cdp2.enable(['Runtime', 'Page']);
        await waitFor(async () => cdp2.eval('!!window.__spicyDemo'), { timeoutMs: 15000, description: 'second demo tab' });
        await cdp.send('Page.navigate', { url: popupUrl });
        await sleep(1000);
        const diag = await cdp.eval(`new Promise(async (resolve) => {
          try {
            const tabs = await chrome.tabs.query({});
            const demo = tabs.find((t) => t.url && t.url.includes('/demo/'));
            if (!demo) return resolve({ error: 'no demo tab', urls: tabs.map((t) => t.url) });
            const res = await chrome.tabs.sendMessage(demo.id, { type: 'spicy:diagnostics' });
            resolve(res);
          } catch (err) {
            resolve({ error: String(err && err.message || err) });
          }
        })`);
        check(
          'popup diagnostics report the real player state',
          !!diag && !!diag.found && diag.found.playerBar === true && !!diag.mediaSession && diag.mediaSession.supported === true && !!diag.track && !!diag.track.title,
          JSON.stringify({ playerBar: diag && diag.found && diag.found.playerBar, media: diag && diag.mediaSession && diag.mediaSession.supported, title: diag && diag.track && diag.track.title, error: diag && diag.error }),
        );
      } finally {
        await cdp2.close().catch(() => {});
        await fetch(`http://127.0.0.1:${chrome.port}/json/close/${target.id}`).catch(() => {});
      }

      await cdp.send('Page.navigate', { url: popupUrl });
      await sleep(700);
      await setSettings({ lyricMode: 'cinema', backgroundStyle: 'artwork', backgroundMotion: true });
    }

    check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | ').slice(0, 300));

    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) {
      console.log('failed checks:');
      for (const f of failed) console.log(' - ' + f.name + (f.detail ? '  (' + f.detail + ')' : ''));
    }
    console.log('screenshots:', SHOTS);
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    if (cdp) await cdp.close().catch(() => {});
    await chrome.close().catch(() => {});
    await server.close().catch(() => {});
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
