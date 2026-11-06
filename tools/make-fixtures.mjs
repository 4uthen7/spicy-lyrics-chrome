#!/usr/bin/env node
/**
 * Generates the demo color-lyrics fixtures (what Spotify's web player receives
 * for the mock tracks) from plain timed lyric text. Keeping the generator in
 * the repo means the demo can be regenerated if timings need to move.
 *
 *   node tools/make-fixtures.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = join(root, 'demo/fixtures');
mkdirSync(fixtureDir, { recursive: true });

/** @type {Array<[number, string]>} start time (ms) and text */
const NEON = [
  [1000, 'city lights are bleeding through the blinds'],
  [5200, 'i keep the radio on just to hear the noise'],
  [9800, 'every signal bends around me'],
  [13600, 'static in the shape of your voice'],
  [18800, ''],
  [19400, 'neon paralysis'],
  [22800, 'hold me in the frequency'],
  [26600, 'neon paralysis'],
  [30200, 'nothing here is moving but me'],
  [35200, 'the floor is humming like a wire'],
  [39600, 'i trace the exit signs until they blur'],
  [44400, 'you said the morning had a price'],
  [48600, 'and i have always been a poor believer'],
  [54800, ''],
  [55400, 'neon paralysis'],
  [58800, 'hold me in the frequency'],
  [62600, 'neon paralysis'],
  [66200, 'nothing here is moving but me'],
  [72400, 'wait for the drop, wait for the light'],
  [77200, 'wait for the part where i survive'],
  [82400, 'all of the hours i could not name'],
  [87400, 'burn in the same electric flame'],
  [93800, ''],
  [100200, 'neon paralysis'],
  [103800, 'hold me in the frequency'],
  [107400, 'neon paralysis'],
  [111000, 'nothing here is moving, nothing here is moving'],
  [118000, 'neon paralysis'],
  [121600, 'and the city keeps on humming'],
  [128000, ''],
];

/** @type {Array<[number, string]>} */
const GLASSHOUSE = [
  [2000, 'paper radio'],
  [6000, 'tune the rooms we used to know'],
  [10400, 'glasshouse in the snow'],
  [14800, 'every window keeps the cold'],
  [19600, 'i learned to sleep inside the sound'],
  [24400, 'of everything that lets me down'],
  [29200, 'paper radio'],
  [33600, 'say the words and let them go'],
  [38800, ''],
  [44000, 'oh, the wires are singing low'],
  [49000, 'oh, the wires are singing low'],
  [54800, 'glasshouse in the snow'],
  [59400, 'i am warmer than i know'],
  [64400, 'paper radio'],
  [68800, 'paper radio'],
];

const TRACKS = [
  {
    file: 'color-lyrics-word.json',
    lines: NEON,
    duration: 133000,
    provider: 'Musixmatch',
    syllables: true,
  },
  {
    file: 'color-lyrics-line.json',
    lines: GLASSHOUSE,
    duration: 74000,
    provider: 'Musixmatch',
    syllables: false,
  },
];

const EMPTY_GAP_MS = 3000;

/** Split a line into word spans whose durations are proportional to their length. */
function timeWords(startMs, endMs, text) {
  const tokens = text.match(/\S+\s*/g) || [];
  if (!tokens.length) return [];
  const weights = tokens.map((t) => Math.max(1, t.replace(/\s+/g, '').length));
  const total = weights.reduce((a, b) => a + b, 0);
  const span = endMs - startMs;
  let cursor = startMs;
  return tokens.map((t, i) => {
    const dur = (span * weights[i]) / total;
    const word = { text: t, startMs: Math.round(cursor), endMs: Math.round(cursor + dur) };
    cursor += dur;
    return word;
  });
}

/**
 * Build syllables that concatenate back to the exact line text, including the
 * trailing spaces (Spotify counts numChars over the raw line string).
 */
function buildSyllables(words) {
  const out = [];
  for (const word of words) {
    const body = word.text.replace(/\s+$/, '');
    const trailing = word.text.slice(body.length);
    const chunks = [];
    const target = body.length > 8 ? 3 : 2;
    for (let i = 0; i < body.length; i += target) chunks.push(body.slice(i, i + target));
    const step = (word.endMs - word.startMs) / chunks.length;
    chunks.forEach((chunk, i) => {
      const isLast = i === chunks.length - 1;
      out.push({
        startTimeMs: String(Math.round(word.startMs + step * i)),
        endTimeMs: String(Math.round(word.startMs + step * (i + 1))),
        numChars: chunk.length + (isLast ? trailing.length : 0),
      });
    });
  }
  return out;
}

function buildDoc({ lines, duration, provider, syllables }, trackId) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const [start, text] = lines[i];
    const nextStart = i + 1 < lines.length ? lines[i + 1][0] : duration;
    if (!text) continue;
    // A line ends at the next start, but stretched lines get a sane ceiling.
    const end = Math.min(nextStart - 220, start + Math.max(1400, Math.min(6200, (nextStart - start) * 0.92)));
    const words = timeWords(start, end, text);
    out.push({
      startTimeMs: String(start),
      endTimeMs: String(end),
      words: text,
      syllables: syllables ? buildSyllables(words) : [],
      alternatives: [],
    });
  }
  return {
    lyrics: {
      syncType: 'LINE_SYNCED',
      lines: out,
      provider,
      providerLyricsId: 'demo-' + trackId,
      providerDisplayName: provider,
      colors: { background: -16777216, text: -1, highlightText: -16777216 },
      hasVocalRemoval: false,
    },
    colors: { background: -16777216, text: -1, highlightText: -16777216 },
  };
}

const trackIds = {
  'color-lyrics-word.json': '4cOdK2wGLETKBW3PvgPWqT',
  'color-lyrics-line.json': '2Fxmhks0bxGSBdJ92vM42m',
};

for (const track of TRACKS) {
  const doc = buildDoc(track, trackIds[track.file]);
  writeFileSync(join(fixtureDir, track.file), JSON.stringify(doc, null, 2) + '\n');
  const wordCount = doc.lyrics.lines.reduce((n, l) => n + l.syllables.length, 0);
  console.log(`${track.file}: ${doc.lyrics.lines.length} lines, ${wordCount} syllables, ${JSON.stringify(doc).length} bytes`);
}

// Interlude gaps are implied by empty timed lines in NEON/GLASSHOUSE; the
// renderer derives isInterlude from the gap, so no extra marker is needed.
console.log('empty timed entries (gaps):', NEON.filter(([, t]) => !t).length + GLASSHOUSE.filter(([, t]) => !t).length);
