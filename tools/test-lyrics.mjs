#!/usr/bin/env node
/**
 * Unit tests for the lyrics pipeline parsers (and the MAIN-world injector).
 *
 *   node tools/test-lyrics.mjs
 *
 * No dependencies and no browser: every parser file is executed inside a bare
 * Node `vm` context with a minimal global surface. Fixtures live in
 * demo/fixtures/lyrics-*.json. Prints PASS/FAIL per case and exits non-zero on
 * any failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'demo', 'fixtures');

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function equal(actual, expected, message) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) throw new Error((message || 'value mismatch') + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function readSource(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function makeContext(extra) {
  const sandbox = Object.assign(
    {
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      performance: { now: () => Date.now() },
    },
    extra || {},
  );
  vm.createContext(sandbox);
  return sandbox;
}

function load(sandbox, relativePath) {
  const code = readSource(relativePath);
  vm.runInContext(code, sandbox, { filename: relativePath });
  return sandbox;
}

// ---------------------------------------------------------------------------
// Parser sandbox (shared, read-only between tests)
// ---------------------------------------------------------------------------

const parserCtx = makeContext();
load(parserCtx, 'src/shared/contract.js');
load(parserCtx, 'src/content/lyrics/color-lyrics.js');
load(parserCtx, 'src/content/lyrics/ttml.js');
load(parserCtx, 'src/content/lyrics/dom-scraper.js');
const SL = parserCtx.SL;

// ---------------------------------------------------------------------------
// Fake DOM for the scraper
// ---------------------------------------------------------------------------

const LINE_SELECTORS = SL.lyrics.DOM_SELECTORS.lines;

function fakeLine(text, options) {
  const opts = options || {};
  const attrs = Object.assign({}, opts.attrs || {});
  if (opts.style) attrs.style = opts.style;
  const children = (opts.children || []).map((childText) => ({ textContent: childText }));
  return {
    textContent: text,
    children,
    className: opts.className || '',
    _active: !!opts.active,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    matches(selector) {
      if (!this._active) return false;
      return (
        selector === '[aria-current="true"]' ||
        selector === '[data-active="true"]' ||
        selector === '[aria-selected="true"]' ||
        selector === '.active' ||
        selector === '.selected' ||
        selector === '[class*="active" i]' ||
        selector === '[class*="selected" i]'
      );
    },
  };
}

function fakeContainer(lines) {
  return {
    querySelectorAll(selector) {
      return LINE_SELECTORS.indexOf(selector) !== -1 ? lines : [];
    },
  };
}

// ---------------------------------------------------------------------------
// Test registry
// ---------------------------------------------------------------------------

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// --- files compile ---------------------------------------------------------

test('all owned pipeline files compile', () => {
  const files = [
    'src/content/lyrics/color-lyrics.js',
    'src/content/lyrics/ttml.js',
    'src/content/lyrics/dom-scraper.js',
    'src/content/lyrics/sources.js',
    'src/content/player/state.js',
    'src/content/bridge.js',
    'src/content/inject-main.js',
  ];
  for (const file of files) {
    // eslint-disable-next-line no-new
    new vm.Script(readSource(file), { filename: file });
  }
});

// --- color-lyrics ----------------------------------------------------------

test('color-lyrics: line-synced payload', () => {
  const doc = SL.lyrics.parseColorLyrics(readFixture('lyrics-line.json'), { trackId: 'track-line', offsetMs: 0 });
  assert(doc, 'expected a document');
  equal(doc.syncType, 'line', 'syncType');
  equal(doc.source, 'spclient', 'source');
  equal(doc.trackId, 'track-line', 'trackId');
  equal(doc.lines.length, 3, 'line count');
  equal(doc.lines.map((line) => line.startMs), [0, 4200, 8600], 'start times');
  for (const line of doc.lines) {
    equal(line.words, [], 'line-synced lines must not carry words');
    assert(line.endMs > line.startMs, 'line end after start: ' + JSON.stringify(line));
  }
  assert(doc.lines[0].endMs <= 4200, 'first line must not overlap the second');
});

test('color-lyrics: word-synced payload inferred from syllables', () => {
  const doc = SL.lyrics.parseColorLyrics(readFixture('lyrics-word.json'), { trackId: 'track-word' });
  assert(doc, 'expected a document');
  equal(doc.syncType, 'word', 'content inference must override LINE_SYNCED');
  equal(doc.lines.length, 2, 'line count');

  const first = doc.lines[0];
  equal(first.words.map((word) => word.text), ['Never', 'gonna', 'give', 'you', 'up'], 'first line words');
  equal(first.words.map((word) => word.partOfPrevious), [false, false, false, false, false], 'first line continuation flags');

  const second = doc.lines[1];
  equal(second.words.map((word) => word.text), ['so', 'hap', 'py', 'now'], 'second line words');
  equal(second.words.map((word) => word.partOfPrevious), [false, false, true, false], 'second line continuation flags');

  // Reconstruct the display line from the contract's spacing rule.
  const reconstructed = second.words
    .map((word, index) => (index > 0 && !word.partOfPrevious ? ' ' : '') + word.text)
    .join('');
  equal(reconstructed, second.text, 'word fragments must rebuild the line text');

  for (const line of doc.lines) {
    for (const word of line.words) {
      assert(Number.isFinite(word.startMs) && Number.isFinite(word.endMs), 'word has finite timing');
      assert(word.endMs > word.startMs, 'word end after start');
      assert(word.startMs >= line.startMs, 'word starts inside its line');
    }
  }
  assert(first.words[0].startMs === 1000, 'first word start');
  assert(first.words[4].endMs <= first.endMs, 'last word ends inside line');
});

test('color-lyrics: interlude gaps over 4s', () => {
  const doc = SL.lyrics.parseColorLyrics(readFixture('lyrics-interlude.json'), { trackId: 'track-gap' });
  assert(doc, 'expected a document');
  equal(doc.syncType, 'line', 'syncType');
  const interludes = doc.lines.filter((line) => line.isInterlude);
  equal(interludes.length, 2, 'leading gap + mid-song gap');
  equal(interludes.map((line) => [line.startMs, line.endMs]), [[0, 5000], [9000, 16000]], 'interlude windows');
  for (const interlude of interludes) {
    equal(interlude.text, '', 'interlude has no text');
    equal(interlude.words, [], 'interlude has no words');
  }
  equal(doc.lines.filter((line) => !line.isInterlude).length, 3, 'sung lines preserved');
  for (let i = 0; i < doc.lines.length - 1; i++) {
    assert(doc.lines[i].endMs <= doc.lines[i + 1].startMs, 'timeline does not overlap at ' + i);
  }
});

test('color-lyrics: UNSYNCED payload becomes static', () => {
  const doc = SL.lyrics.parseColorLyrics(readFixture('lyrics-unsynced.json'), { trackId: 'track-static' });
  assert(doc, 'expected a document');
  equal(doc.syncType, 'static', 'syncType');
  equal(doc.lines.length, 2, 'line count');
  for (const line of doc.lines) {
    equal(line.words, [], 'static lines carry no words');
    equal(line.isUnsynced, true, 'static lines are marked unsynced');
    equal([line.startMs, line.endMs], [0, 0], 'static lines have no timing');
  }
});

test('color-lyrics: offset application', () => {
  const payload = readFixture('lyrics-word.json');
  const base = SL.lyrics.parseColorLyrics(payload, { trackId: 'track-offset', offsetMs: 0 });
  const shifted = SL.lyrics.parseColorLyrics(payload, { trackId: 'track-offset', offsetMs: 500 });
  assert(base && shifted, 'both documents parse');
  for (let i = 0; i < base.lines.length; i++) {
    equal(shifted.lines[i].startMs, base.lines[i].startMs + 500, 'line offset at ' + i);
    equal(shifted.lines[i].endMs, base.lines[i].endMs + 500, 'line end offset at ' + i);
    for (let k = 0; k < base.lines[i].words.length; k++) {
      equal(shifted.lines[i].words[k].startMs, base.lines[i].words[k].startMs + 500, 'word offset');
    }
  }
  equal(shifted.offsetMs, 500, 'doc offset recorded');
});

test('color-lyrics: negative offset is clamped and sorted', () => {
  const payload = readFixture('lyrics-word.json');
  const doc = SL.lyrics.parseColorLyrics(payload, { trackId: 'track-neg', offsetMs: -2000 });
  assert(doc, 'expected a document');
  for (const line of doc.lines) {
    assert(line.startMs >= 0, 'no negative starts');
    assert(line.endMs > line.startMs, 'positive durations');
  }
});

test('color-lyrics: overlapping lines are de-overlapped', () => {
  const payload = {
    lyrics: {
      syncType: 'LINE_SYNCED',
      lines: [
        { startTimeMs: '1000', endTimeMs: '5000', words: 'a' },
        { startTimeMs: '3000', endTimeMs: '4000', words: 'b' },
        { startTimeMs: '-200', endTimeMs: '-100', words: 'c' },
      ],
    },
  };
  const doc = SL.lyrics.parseColorLyrics(payload, { trackId: 'track-overlap' });
  assert(doc, 'expected a document');
  assert(doc.lines[0].startMs === 0, 'negative line clamped to 0 and sorted first');
  for (let i = 0; i < doc.lines.length - 1; i++) {
    assert(doc.lines[i].endMs <= doc.lines[i + 1].startMs, 'overlap removed at ' + i);
  }
  for (const line of doc.lines) assert(line.endMs > line.startMs, 'positive line duration');
});

test('color-lyrics: malformed input returns null', () => {
  const malformed = [
    null,
    undefined,
    {},
    'nope',
    42,
    { lyrics: null },
    { lyrics: { syncType: 'LINE_SYNCED' } },
    { lyrics: { syncType: 'LINE_SYNCED', lines: [] } },
    { lyrics: { syncType: 'LINE_SYNCED', lines: 'no' } },
    { lyrics: { syncType: 'LINE_SYNCED', lines: [{ words: '' }] } },
  ];
  for (const value of malformed) {
    equal(SL.lyrics.parseColorLyrics(value, { trackId: 'x' }), null, 'expected null for ' + JSON.stringify(value));
  }
});

// --- TTML ------------------------------------------------------------------

const duetTTML = readFixture('lyrics-duet.json').ttml;

test('ttml: word timing, background vocals and duet sides', () => {
  const doc = SL.lyrics.parseTTML(duetTTML, { trackId: 'track-ttml' });
  assert(doc, 'expected a document');
  equal(doc.syncType, 'word', 'syncType');
  equal(doc.source, 'ttml', 'source');
  equal(doc.lines.length, 4, 'line count');
  equal(doc.meta.duet, true, 'duet detected');
  equal(doc.meta.agents, ['v1', 'v2'], 'agents collected');

  equal(doc.lines.map((line) => line.align), ['left', 'right', 'left', 'right'], 'duet alignment');
  equal(doc.lines[0].text, 'Hello world', 'first line text');
  equal(doc.lines[0].words.map((word) => word.text), ['Hello', 'world'], 'first line words');
  equal(doc.lines[1].text, 'Answer line', 'second line text');
  equal(doc.lines[2].text, 'Main (echo) text', 'mixed background line text');
  equal(doc.lines[2].isBackground, false, 'mixed line is not all-background');
  equal(doc.lines[3].isBackground, true, 'pure background line flagged');
  equal(doc.lines[3].words.map((word) => word.text), ['(ooh)', '(ahh)'], 'nested background words');

  for (const line of doc.lines) {
    for (const word of line.words) {
      assert(Number.isFinite(word.startMs) && word.endMs > word.startMs, 'word timing for ' + word.text);
    }
  }
});

test('ttml: offset application', () => {
  const base = SL.lyrics.parseTTML(duetTTML, { trackId: 'track-ttml' });
  const shifted = SL.lyrics.parseTTML(duetTTML, { trackId: 'track-ttml', offsetMs: 750 });
  assert(base && shifted, 'both documents parse');
  for (let i = 0; i < base.lines.length; i++) {
    equal(shifted.lines[i].startMs, base.lines[i].startMs + 750, 'line offset at ' + i);
  }
});

test('ttml: untimed document becomes static', () => {
  const doc = SL.lyrics.parseTTML('<tt><body><div><p>plain words only</p></div></body></tt>', { trackId: 'tt-static' });
  assert(doc, 'expected a document');
  equal(doc.syncType, 'static', 'syncType');
  equal(doc.lines.length, 1, 'line count');
  equal(doc.lines[0].text, 'plain words only', 'text');
});

test('ttml: malformed input returns null', () => {
  const malformed = [null, undefined, '', '   ', 'garbage', 42, '<tt></tt>', '<tt><body></body></tt>'];
  for (const value of malformed) {
    equal(SL.lyrics.parseTTML(value, { trackId: 'x' }), null, 'expected null for ' + JSON.stringify(value));
  }
});

// --- DOM scraper -----------------------------------------------------------

test('dom scraper: exact data-start-ms timings and timestamp stripping', () => {
  SL.lyrics.resetDomLearning();
  const lines = [
    fakeLine('Line one 0:01', { attrs: { 'data-start-ms': '0', 'data-end-ms': '4000' } }),
    fakeLine('Line two 0:05', { attrs: { 'data-start-ms': '4000', 'data-end-ms': '8000' } }),
    fakeLine('Line three', { attrs: { 'data-start-ms': '8000', 'data-end-ms': '12000' } }),
    fakeLine('Line four', { attrs: { 'data-start-ms': '12000', 'data-end-ms': '16000' } }),
  ];
  const doc = SL.lyrics.scrapeNative(fakeContainer(lines), { trackId: 'dom-dataset' });
  assert(doc, 'expected a document');
  equal(doc.syncType, 'line', 'syncType');
  equal(doc.lines.map((line) => line.text), ['Line one', 'Line two', 'Line three', 'Line four'], 'timestamps stripped');
  equal(doc.lines.map((line) => line.startMs), [0, 4000, 8000, 12000], 'dataset start times');
  equal(doc.meta.datasetTimings, true, 'dataset path recorded');
});

test('dom scraper: line timing learned from active-line observations', () => {
  SL.lyrics.resetDomLearning();
  const lines = Array.from({ length: 6 }, (_, i) => fakeLine('Line ' + (i + 1), { active: i === 0 }));
  const container = fakeContainer(lines);

  const first = SL.lyrics.scrapeNative(container, { trackId: 'dom-learn', positionMs: 5000 });
  assert(first && first.syncType === 'line', 'first observation must be line-synced');
  equal(first.lines.length, 6, 'all lines present');
  assert(first.lines[0].startMs === 5000, 'active line anchored to observed position');

  lines.forEach((line, i) => {
    line._active = i === 3;
  });
  const second = SL.lyrics.scrapeNative(container, { trackId: 'dom-learn', positionMs: 11000 });
  assert(second, 'second observation parses');
  equal(second.lines[3].startMs, 11000, 'second anchor recorded');

  lines.forEach((line, i) => {
    line._active = i === 5;
  });
  const third = SL.lyrics.scrapeNative(container, { trackId: 'dom-learn', positionMs: 17000 });
  assert(third, 'third observation parses');
  equal(third.lines[5].startMs, 17000, 'third anchor recorded');
  for (let i = 0; i < third.lines.length - 1; i++) {
    assert(third.lines[i].startMs < third.lines[i + 1].startMs, 'timeline increases at ' + i);
    assert(third.lines[i].endMs <= third.lines[i + 1].startMs, 'no overlap at ' + i);
  }
  const anchors = SL.lyrics.getDomAnchors('dom-learn');
  equal(Object.keys(anchors).length, 3, 'three anchors learned');
});

test('dom scraper: lyrics-line, translation child and unique-class active', () => {
  SL.lyrics.resetDomLearning();
  const lines = [
    fakeLine('', { className: 'MFEBmMwUCW5Qmg8VwGim JraMqx9ZQax6C3ZIaMn2' }),
    fakeLine('First line', {
      className: 'MFEBmMwUCW5Qmg8VwGim NToFVceZLenbhmfcDb3s',
      children: ['First line', '[translation]'],
      attrs: { 'data-start-ms': '0', 'data-end-ms': '4000' },
    }),
    fakeLine('Second line', {
      className: 'MFEBmMwUCW5Qmg8VwGim xp5WpqjB3u9hFHWKn2aE',
      attrs: { 'data-start-ms': '4000', 'data-end-ms': '9000' },
    }),
    fakeLine('Third line', {
      className: 'MFEBmMwUCW5Qmg8VwGim tixQoLB1xUrPglVJ91J4',
      attrs: { 'data-start-ms': '9000', 'data-end-ms': '13000' },
    }),
  ];
  const doc = SL.lyrics.scrapeNative(fakeContainer(lines), { trackId: 'dom-lyrics-line', positionMs: 5000 });
  assert(doc, 'expected a document');
  equal(doc.syncType, 'line', 'syncType');
  equal(doc.meta.datasetTimings, true, 'dataset timings used');
  equal(doc.lines.map((line) => line.text), ['First line', 'Second line', 'Third line'], 'spacer skipped, translation stripped');
  equal(doc.lines.map((line) => line.startMs), [0, 4000, 9000], 'timings from data attrs');
});

test('dom scraper: active line by unique hashed class', () => {
  SL.lyrics.resetDomLearning();
  const base = 'MFEBmMwUCW5Qmg8VwGim';
  const lines = Array.from({ length: 5 }, (_, i) => {
    const role = i === 2 ? 'xp5WpqjB3u9hFHWKn2aE' : i < 2 ? 'NToFVceZLenbhmfcDb3s' : 'tixQoLB1xUrPglVJ91J4';
    return fakeLine('Line ' + (i + 1), { className: base + ' ' + role });
  });
  const doc = SL.lyrics.scrapeNative(fakeContainer(lines), { trackId: 'dom-unique-class', positionMs: 7000 });
  assert(doc, 'expected a document');
  equal(doc.meta.activeIndex, 2, 'unique-class line is active');
  equal(doc.lines[2].startMs, 7000, 'active line anchored to position');
});

test('dom scraper: active line by inline opacity', () => {
  SL.lyrics.resetDomLearning();
  const base = 'MFEBmMwUCW5Qmg8VwGim';
  const lines = Array.from({ length: 4 }, (_, i) => fakeLine('Line ' + (i + 1), {
    className: base,
    style: i === 1 ? 'opacity: 1' : 'opacity: 0.35',
  }));
  const doc = SL.lyrics.scrapeNative(fakeContainer(lines), { trackId: 'dom-opacity', positionMs: 6000 });
  assert(doc, 'expected a document');
  equal(doc.meta.activeIndex, 1, 'highest-opacity line is active');
});

test('dom scraper: no observations degrades to static', () => {
  SL.lyrics.resetDomLearning();
  const lines = [fakeLine('Static one'), fakeLine('Static two')];
  const doc = SL.lyrics.scrapeNative(fakeContainer(lines), { trackId: 'dom-static' });
  assert(doc, 'expected a document');
  equal(doc.syncType, 'static', 'syncType');
  equal(doc.lines.map((line) => line.text), ['Static one', 'Static two'], 'text preserved');
  for (const line of doc.lines) equal(line.isUnsynced, true, 'marked unsynced');
});

test('dom scraper: empty container returns null', () => {
  equal(SL.lyrics.scrapeNative(fakeContainer([]), { trackId: 'dom-empty' }), null, 'null for no lines');
  equal(SL.lyrics.scrapeNative(null, { trackId: 'dom-empty' }), null, 'null without a root');
});

// --- MAIN-world injector ---------------------------------------------------

async function runInjectorTest() {
  let fakeWindow = null;

  const makeWindow = () => {
    const listeners = new Map();
    const messages = [];
    const calls = [];
    const cover = 'https://i.scdn.co/image/ab67616d0000b273cover1';
    const payload = {
      lyrics: {
        syncType: 'UNSYNCED',
        provider: 'test',
        lines: [{ startTimeMs: '0', endTimeMs: '0', words: 'sniffed line', syllables: [] }],
      },
    };
    const lyricsResponse = {
      ok: true,
      status: 200,
      clone() {
        return { json: async () => payload, text: async () => JSON.stringify(payload) };
      },
      json: async () => payload,
    };
    const emptyJsonResponse = {
      ok: true,
      status: 200,
      clone() {
        return { json: async () => ({}), text: async () => '{}' };
      },
      json: async () => ({}),
    };
    const fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
      calls.push({ url, init });
      if (url.indexOf('spclient.wg.spotify.com/color-lyrics/') !== -1) return lyricsResponse;
      if (url.indexOf('spclient.wg.spotify.com/metadata/') !== -1) return emptyJsonResponse;
      throw new Error('unexpected fetch ' + url);
    };
    return {
      location: { origin: 'http://127.0.0.1:1234', href: 'http://127.0.0.1:1234/demo/' },
      fetch,
      XMLHttpRequest: class FakeXHR {
        open() {}
        send() {}
        setRequestHeader() {}
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        const list = listeners.get(type) || [];
        const index = list.indexOf(fn);
        if (index !== -1) list.splice(index, 1);
      },
      postMessage(message) {
        messages.push(message);
      },
      dispatch(data) {
        for (const fn of listeners.get('message') || []) fn({ source: fakeWindow, data });
      },
      _messages: messages,
      _calls: calls,
      _lyricsResponse: lyricsResponse,
      _payload: payload,
      _cover: cover,
    };
  };

  fakeWindow = makeWindow();
  const context = makeContext({ window: fakeWindow });
  load(context, 'src/content/inject-main.js');

  const authHeaders = {
    Authorization: 'Bearer user-token',
    'App-Platform': 'WebPlayer',
    'Spotify-App-Version': '1.3.10.15.g21d156ee0039',
  };

  // 1. transparency + capture of the /image/ URL variant.
  assert(fakeWindow.fetch.__spicyWrapped === true, 'fetch must be wrapped');
  const lyricsUrl =
    'https://spclient.wg.spotify.com/color-lyrics/v2/track/abc123/image/' +
    encodeURIComponent(fakeWindow._cover) +
    '?format=json&vocalRemoval=false';
  const response = await fakeWindow.fetch(lyricsUrl, { headers: authHeaders });
  assert(response === fakeWindow._lyricsResponse, 'wrapped fetch must return the original Response');
  await sleep(10);

  const captures = fakeWindow._messages.filter((message) => message.type === 'color-lyrics');
  assert(captures.length >= 1, 'sniffer must post a capture');
  equal(captures[0].trackId, 'abc123', 'track id parsed from /image/ URL');
  equal(captures[0].format, 'json', 'capture format');
  equal(captures[0].payload, fakeWindow._payload, 'full JSON captured');
  equal(captures[0].imageUrl, fakeWindow._cover, 'cover image URL extracted');
  assert(fakeWindow._calls.every((call) => call.url.indexOf('get_access_token') === -1), 'no /get_access_token request');

  // 2. replay after bridge-ready.
  fakeWindow._messages.length = 0;
  fakeWindow.dispatch({ source: 'spicy-isolated', type: 'bridge-ready' });
  const replayed = fakeWindow._messages.filter((message) => message.type === 'color-lyrics');
  assert(replayed.length >= 1, 'replay after bridge-ready');
  equal(replayed[0].imageUrl, fakeWindow._cover, 'replay keeps the image URL');

  // 3. direct fetch reuses the captured bearer (no token minting).
  fakeWindow._messages.length = 0;
  fakeWindow.dispatch({
    source: 'spicy-isolated',
    type: 'request-direct-lyrics',
    trackId: 'abc123',
    nonce: 'nonce-1',
  });
  let direct = null;
  for (let attempt = 0; attempt < 50 && !direct; attempt++) {
    await sleep(10);
    direct = fakeWindow._messages.find((message) => message.type === 'direct-lyrics-result');
  }
  assert(direct, 'direct-lyrics-result posted');
  equal(direct.nonce, 'nonce-1', 'nonce echoed');
  equal(direct.ok, true, 'direct request succeeded');
  equal(direct.json, fakeWindow._payload, 'direct JSON returned');

  const directCall = fakeWindow._calls.find((call) => call.url.indexOf('spclient.wg.spotify.com/color-lyrics/v2/track/abc123?') !== -1);
  assert(directCall, 'direct spclient call made');
  equal(directCall.url, 'https://spclient.wg.spotify.com/color-lyrics/v2/track/abc123?format=json&market=from_token', 'bare variant, no productType');
  equal(directCall.init.headers.Authorization, 'Bearer user-token', 'captured bearer reused');
  equal(directCall.init.headers['App-Platform'], 'WebPlayer', 'App-Platform header');
  equal(directCall.init.headers['Spotify-App-Version'], authHeaders['Spotify-App-Version'], 'Spotify-App-Version header');

  // 4. auth is also captured from non-lyrics spclient traffic and keyed by id.
  await fakeWindow.fetch('https://spclient.wg.spotify.com/metadata/4/track/metaTrack123', {
    headers: {
      Authorization: 'Bearer user-token-2',
      'App-Platform': 'WebPlayer',
      'Spotify-App-Version': '1.3.10.15.g21d156ee0039',
    },
  });
  fakeWindow._messages.length = 0;
  fakeWindow.dispatch({
    source: 'spicy-isolated',
    type: 'request-direct-lyrics',
    trackId: 'metaTrack123',
    nonce: 'nonce-2',
  });
  let direct2 = null;
  for (let attempt = 0; attempt < 50 && !direct2; attempt++) {
    await sleep(10);
    direct2 = fakeWindow._messages.find((message) => message.type === 'direct-lyrics-result');
  }
  assert(direct2 && direct2.ok, 'direct request worked from metadata-captured auth');
  const metaCall = fakeWindow._calls.find((call) => call.url.indexOf('/track/metaTrack123?') !== -1);
  equal(metaCall.init.headers.Authorization, 'Bearer user-token-2', 'per-track auth used');
}

test('main-world injector: fetch sniffer, replay, direct fetch', runInjectorTest);

// --- resolver (local TTML import) ------------------------------------------

function makeFakeChrome() {
  const memory = new Map();
  return {
    storage: {
      sync: {
        get: async () => ({}),
        set: async () => {},
      },
      local: {
        get: async (key) => {
          if (key == null) return Object.fromEntries(memory);
          return memory.has(key) ? { [key]: memory.get(key) } : {};
        },
        set: async (entries) => {
          for (const [key, value] of Object.entries(entries)) memory.set(key, value);
        },
        remove: async (keys) => {
          for (const key of keys) memory.delete(key);
        },
      },
    },
  };
}

test('sources: importTTML publishes the document and seeds the cache', async () => {
  const ctx = makeContext({ chrome: makeFakeChrome() });
  load(ctx, 'src/shared/contract.js');
  load(ctx, 'src/shared/store.js');
  load(ctx, 'src/content/lyrics/color-lyrics.js');
  load(ctx, 'src/content/lyrics/ttml.js');
  load(ctx, 'src/content/lyrics/dom-scraper.js');
  load(ctx, 'src/content/lyrics/sources.js');

  const resolver = ctx.SL;
  resolver.store.setTrack({
    id: 'import-track',
    uri: 'spotify:track:import-track',
    title: 'Import',
    artist: 'Tester',
    album: 'Local',
    coverUrl: '',
    durationMs: 200000,
    trackUrl: null,
  });

  const result = await resolver.lyrics.importTTML(duetTTML);
  assert(result.ok, 'import must succeed: ' + JSON.stringify(result));
  equal(result.syncType, 'word', 'imported sync type');
  equal(result.lines, 4, 'imported line count');

  const doc = resolver.store.get().lyrics;
  assert(doc, 'document published to the store');
  equal(doc.source, 'ttml', 'source kept as ttml');
  equal(doc.meta.imported, true, 'import marker present');
  equal(resolver.store.get().lyricsStatus, 'ready', 'status ready');

  const cached = await resolver.store.readCache('import-track');
  assert(cached, 'imported document cached under the track id');
  equal(cached.trackId, 'import-track', 'cache keyed by track');
  equal(cached.meta.imported, true, 'cache keeps the import marker');

  // Malformed import keeps the current document.
  const before = resolver.store.get().lyrics;
  const bad = await resolver.lyrics.importTTML('not xml at all');
  equal(bad.ok, false, 'malformed import fails');
  assert(typeof bad.error === 'string' && bad.error.length > 0, 'failure carries an error string');
  equal(resolver.store.get().lyrics, before, 'current document untouched on failure');

  // No track selected: refused.
  resolver.store.setTrack({ id: null, uri: null });
  const noTrack = await resolver.lyrics.importTTML(duetTTML);
  equal(noTrack.ok, false, 'import refused without a current track');
});

test('sources: sniffed payload promotes a real track id and resolves', async () => {
  const ctx = makeContext({ chrome: makeFakeChrome() });
  load(ctx, 'src/shared/contract.js');
  load(ctx, 'src/shared/store.js');
  load(ctx, 'src/content/lyrics/color-lyrics.js');
  load(ctx, 'src/content/lyrics/ttml.js');
  load(ctx, 'src/content/lyrics/dom-scraper.js');
  load(ctx, 'src/content/lyrics/sources.js');

  const resolver = ctx.SL;
  const realId = '4cOdK2wGLETKBW3PvgPWqT';
  const cover = 'https://i.scdn.co/image/ab67616d0000b273cover1';
  resolver.store.setTrack({
    id: null,
    key: 'np:deadbeef',
    title: 'Neon Paralysis',
    artist: 'MIRA',
    album: '',
    coverUrl: cover,
    durationMs: 133000,
  });
  resolver.store.patch({ ui: { nativeLyricsOpen: true } });
  resolver.lyrics.attach();

  const payload = readFixture('lyrics-word.json');
  resolver.lyrics.capture(realId, {
    format: 'json',
    payload,
    url: 'https://spclient.wg.spotify.com/color-lyrics/v2/track/' + realId + '/image/' + encodeURIComponent(cover) + '?format=json&vocalRemoval=false',
    imageUrl: cover,
  });

  equal(resolver.store.get().track.id, realId, 'real id promoted onto the store');
  equal(resolver.store.get().track.uri, 'spotify:track:' + realId, 'uri built from the promoted id');

  for (let attempt = 0; attempt < 100 && resolver.store.get().lyricsStatus !== 'ready'; attempt++) {
    await sleep(10);
  }
  const state = resolver.store.get();
  equal(state.lyricsStatus, 'ready', 'document resolved after promotion');
  equal(state.lyrics.source, 'spclient', 'resolved from the sniffed payload');
  equal(state.lyrics.syncType, 'word', 'word sync preserved');
  equal(state.lyrics.trackId, realId, 'document keyed by the real id');
  const cached = await resolver.store.readCache(realId);
  assert(cached, 'document cached under the real id');
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  console.log('spicy lyrics pipeline tests\n');
  for (const entry of tests) {
    try {
      await entry.fn();
      passed += 1;
      console.log('PASS  ' + entry.name);
    } catch (err) {
      failed += 1;
      const details = (err && err.stack ? err.stack : String(err)).split('\n').slice(0, 4).join('\n      ');
      failures.push({ name: entry.name, details });
      console.log('FAIL  ' + entry.name);
      console.log('      ' + (err && err.message ? err.message : String(err)));
    }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + tests.length + ' total');
  if (failures.length) {
    console.log('\nfailures:');
    for (const failure of failures) {
      console.log(' - ' + failure.name);
      console.log('   ' + failure.details);
    }
    process.exitCode = 1;
  }
}

await run();
