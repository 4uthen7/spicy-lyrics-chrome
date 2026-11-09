/**
 * Minimal Chrome DevTools Protocol client for Node 24 (global WebSocket).
 * Used by tools/e2e.mjs; no puppeteer dependency.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function findChrome() {
  const candidates = [];
  if (process.env.CHROME_BIN) candidates.push(process.env.CHROME_BIN);
  const roots = ['/tmp/cft/chrome', join(process.env.HOME || '/tmp', '.cache/puppeteer/chrome')];
  for (const root of roots) {
    let entries = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const dir of entries) {
      if (dir.startsWith('.')) continue;
      const channelDir = join(root, dir);
      let archs = [];
      try {
        archs = readdirSync(channelDir).filter((d) => d.startsWith('chrome-'));
      } catch {
        continue;
      }
      for (const arch of archs) {
        const app = join(channelDir, arch, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
        try {
          if (statSync(app).isFile()) candidates.push(app);
        } catch {
          /* not this layout */
        }
      }
    }
  }
  candidates.push('/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  return candidates.find((path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
}

export async function launchChrome({
  chromePath,
  args = [],
  profileDir,
  port = 0,
  headless = true,
}) {
  const listenPort = port || 9000 + Math.floor(Math.random() * 900);
  const flags = [
    headless ? '--headless=new' : '',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    // Without these, a headless page can be treated as occluded and stop
    // requestAnimationFrame, which makes every animation assertion meaningless.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=Translate,OptimizationHints,MediaRouter,CalculateNativeWinOcclusion',
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${listenPort}`,
    'about:blank',
    ...args,
  ].filter(Boolean);

  const proc = spawn(chromePath, flags, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 20000) stderr = stderr.slice(-20000);
  });

  let version = null;
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${listenPort}/json/version`);
      if (res.ok) {
        version = await res.json();
        break;
      }
    } catch {
      /* not up yet */
    }
    if (proc.exitCode !== null) throw new Error('chrome exited early: ' + stderr);
    await sleep(150);
  }
  if (!version) {
    proc.kill('SIGKILL');
    throw new Error('chrome did not expose CDP: ' + stderr);
  }

  return {
    proc,
    port: listenPort,
    version,
    stderr: () => stderr,
    async listTargets() {
      const res = await fetch(`http://127.0.0.1:${listenPort}/json/list`);
      return res.json();
    },
    async waitForTarget(predicate, timeoutMs = 15000, description = 'target') {
      const started = Date.now();
      let last = [];
      while (Date.now() - started < timeoutMs) {
        last = await this.listTargets();
        const hit = last.find(predicate);
        if (hit) return hit;
        await sleep(120);
      }
      throw new Error(`timed out waiting for ${description}; saw: ${JSON.stringify(last.map((t) => t.type + ':' + t.url))}`);
    },
    async close() {
      proc.kill('SIGKILL');
      await sleep(150);
    },
  };
}

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      let message;
      try {
        message = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message + ' ' + JSON.stringify(message.error.data || '')));
        else resolve(message.result);
      } else if (message.method) {
        const list = this.handlers.get(message.method);
        if (list) for (const handler of list) handler(message.params, message);
      }
    });
  }

  /** Subscribe to a CDP event: cdp.on('Runtime.executionContextCreated', fn). */
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(handler);
    return () => this.handlers.get(method).delete(handler);
  }

  static async connect(webSocketDebuggerUrl) {
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async enable(domains = ['Runtime', 'Page']) {
    for (const domain of domains) await this.send(domain + '.enable');
  }

  /** Evaluate in the page's main world and return the value. */
  async eval(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error('eval failed: ' + (details.exception && details.exception.description ? details.exception.description : details.text));
    }
    return result.result ? result.result.value : undefined;
  }

  async screenshot(path) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(shot.data, 'base64'));
    return path;
  }

  async close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

export async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 100, description = 'condition' } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await predicate();
      if (value) return value;
      lastError = null;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${description}${lastError ? ': ' + lastError.message : ''}`);
}
