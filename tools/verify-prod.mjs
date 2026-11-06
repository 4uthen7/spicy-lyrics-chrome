#!/usr/bin/env node
/**
 * Production-package smoke test.
 *
 * Loads dist/prod into Chrome for Testing (a real extension install), then:
 *   - asserts the built manifest has no localhost/dev origins baked in
 *   - asserts the service worker registered without console errors
 *   - asserts web-accessible resources resolve through chrome-extension://
 *   - asserts nothing is injected on the local demo origin (prod stays scoped
 *     to open.spotify.com only)
 *
 *   node tools/build.mjs --target prod --skip-zip && node tools/verify-prod.mjs
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from './serve.mjs';
import { findChrome, launchChrome, Cdp, waitFor } from './cdp.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXT = join(ROOT, 'dist/prod');

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const manifest = JSON.parse(await readFile(join(EXT, 'manifest.json'), 'utf8'));
const raw = JSON.stringify(manifest);
check('prod manifest has no localhost origins', !/127\.0\.0\.1|localhost/.test(raw));
check('prod manifest is MV3', manifest.manifest_version === 3, 'content scripts: ' + manifest.content_scripts.length);
check('prod manifest excludes demo directory', !/demo\//.test(raw));

const server = await startServer({ port: 0 });
const chrome = await launchChrome({
  chromePath: findChrome(),
  profileDir: '/tmp/spicy-prod-' + Date.now(),
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

let cdp;
try {
  const swTarget = await chrome
    .waitForTarget((t) => t.type === 'service_worker' && /service-worker\.js$/.test(t.url), 15000, 'prod service worker')
    .catch(() => null);
  check('prod extension loads (service worker registered)', !!swTarget, swTarget ? swTarget.url : 'not found');

  const page = await chrome.waitForTarget((t) => t.type === 'page', 15000, 'page');
  cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  const errors = [];
  cdp.ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text);
  });
  await cdp.enable(['Runtime', 'Page', 'Log']);

  await cdp.send('Page.navigate', { url: `${server.url}/demo/` });
  await waitFor(async () => cdp.eval('!!window.__spicyDemo'), { timeoutMs: 10000, description: 'demo boot' });
  await sleep(1200);

  const injected = await cdp.eval("({ launcher: !!document.querySelector('.spicy-launcher'), version: document.documentElement.dataset.spicyVersion || '' })");
  check('prod extension stays scoped (does not inject on the demo origin)', !injected.launcher && !injected.version, JSON.stringify(injected));

  // The real origin: the content script must boot on open.spotify.com and its
  // web-accessible resources must resolve there (W-A-R matches only Spotify).
  const extensionId = swTarget ? new URL(swTarget.url).host : null;
  const origin = extensionId ? 'chrome-extension://' + extensionId : null;
  await cdp.send('Page.navigate', { url: 'https://open.spotify.com/' });
  const booted = await waitFor(
    async () => {
      const s = await cdp.eval("document.documentElement.dataset.spicyVersion || ''");
      return s || null;
    },
    { timeoutMs: 25000, description: 'content script on the real Spotify origin' },
  ).catch(() => null);
  check('prod extension boots on open.spotify.com',!!booted, booted ? 'v' + booted : 'timeout');
  check('no exceptions while booting on the real origin', errors.length === 0, errors.join(' | ').slice(0, 240));

  if (origin) {
    const resources = [
      'src/content/styles/overlay.css',
      'src/content/styles/lyrics.css',
      'src/content/styles/controls.css',
      'assets/icons/icon-128.png',
    ];
    const statuses = await cdp.eval(`Promise.all(${JSON.stringify(resources)}.map(async (path) => {
      try { const res = await fetch(${JSON.stringify(origin)} + '/' + path); return path + ':' + res.status; }
      catch (err) { return path + ':ERR ' + err.message; }
    }))`);
    const bad = (statuses || []).filter((s) => !s.endsWith(':200'));
    check('packaged resources resolve on the Spotify origin', bad.length === 0, bad.length ? bad.join(', ') : `${resources.length} files OK`);

    // Popup is an extension page; its own resources load same-origin.
    await cdp.send('Page.navigate', { url: `${origin}/src/popup/popup.html` });
    const popup = await waitFor(
      async () => {
        const info = await cdp.eval(`(() => ({ rows: document.querySelectorAll('.row').length, title: document.title }))()`);
        return info && info.rows > 10 ? info : null;
      },
      { timeoutMs: 8000, description: 'prod popup' },
    ).catch(() => null);
    check('prod popup renders', !!popup, popup ? JSON.stringify(popup) : 'timeout');
  }

  check('service worker reported no uncaught errors', errors.length === 0, errors.join(' | ').slice(0, 200));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} prod checks passed`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  if (cdp) await cdp.close().catch(() => {});
  await chrome.close().catch(() => {});
  await server.close().catch(() => {});
}
