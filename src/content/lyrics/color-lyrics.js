/**
 * Parser for Spotify's `color-lyrics` JSON payload.
 *
 * The web player fetches this from spclient:
 *   GET /color-lyrics/v2/track/<id>?format=json&market=from_token&...
 *
 * Observed shape (documented by the existing desktop clients):
 *
 *   { lyrics: { syncType, provider, language, lines: [
 *       { startTimeMs: "1234", endTimeMs: "5678", words: "line text",
 *         syllables: [{ numChars, startTimeMs, endTimeMs }, ...] } ] } }
 *
 * Timings are decimal strings. `endTimeMs` is frequently "0" (unknown).
 * Syllables address the line text by UTF-16 unit counts (`numChars`), so words
 * are reconstructed by slicing `words` at those boundaries. A few providers
 * also send an explicit syllable `text`; that wins when present because it is
 * already display-ready.
 *
 * Outputs the shared LyricsDoc contract from src/shared/contract.js.
 */
(function () {
  'use strict';
  const SL = (globalThis.SL = globalThis.SL || {});
  SL.lyrics = SL.lyrics || {};
  if (SL.lyrics.parseColorLyrics) return;

  /** A silent gap longer than this becomes an isInterlude line. */
  const INTERLUDE_GAP_MS = 4000;
  /** Used when neither an end time nor a next line can bound a line. */
  const FALLBACK_LINE_MS = 4000;
  const MIN_LINE_MS = 250;

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function num(value) {
    if (typeof value === 'number') return isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
      const n = Number(value);
      return isFinite(n) ? n : null;
    }
    return null;
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /**
   * Rebuilds display words from a line's syllable metadata.
   * Returns `{ words, lastSyllableEnd }`; word timings may be null and are
   * filled by finalizeTimeline once the line bounds are known.
   */
  function buildWords(text, syllables) {
    const words = [];
    let cursor = 0;
    let prevEndedWithSpace = false;
    let lastSyllableEnd = null;

    for (const syllable of syllables) {
      if (!syllable || typeof syllable !== 'object') continue;

      let fragment = '';
      const numChars = num(syllable.numChars);
      if (typeof syllable.text === 'string' && syllable.text.length) {
        // Some providers ship the display chunk directly; trust it over slicing.
        fragment = syllable.text;
        cursor += fragment.length;
      } else if (numChars != null && numChars >= 0) {
        const count = clamp(Math.round(numChars), 0, Math.max(0, text.length - cursor));
        fragment = text.slice(cursor, cursor + count);
        cursor += count;
      } else {
        continue;
      }

      const startMs = num(syllable.startTimeMs);
      const endMs = num(syllable.endTimeMs);
      if (endMs != null && endMs > 0) {
        lastSyllableEnd = lastSyllableEnd == null ? endMs : Math.max(lastSyllableEnd, endMs);
      }

      const trimmed = fragment.trim();
      if (!trimmed) {
        // Whitespace-only chunks do not render but still separate words.
        if (fragment.length) prevEndedWithSpace = true;
        continue;
      }

      const leadingSpace = /^\s/.test(fragment);
      const trailingSpace = /\s$/.test(fragment);
      const partOfPrevious = !leadingSpace && !prevEndedWithSpace && words.length > 0;
      words.push({
        text: trimmed,
        startMs: startMs != null ? startMs : null,
        endMs: endMs != null && endMs > 0 ? endMs : null,
        partOfPrevious,
      });
      prevEndedWithSpace = trailingSpace;
    }
    return { words, lastSyllableEnd };
  }

  /**
   * Sorts, de-overlaps, fills missing word/line ends, applies the offset and
   * inserts interlude markers. Mutates/returns fresh line objects.
   *
   * rawLines: [{ text, startMs, endMs|null, lastEnd|null, words:[], align,
   *              isBackground, isInterlude? }]
   */
  function finalizeTimeline(rawLines, options) {
    const offsetMs = options && Number.isFinite(Number(options.offsetMs)) ? Math.round(Number(options.offsetMs)) : 0;
    const lines = [];

    for (const raw of rawLines) {
      if (!raw || typeof raw.text !== 'string') continue;
      const words = Array.isArray(raw.words)
        ? raw.words
            .filter((w) => w && typeof w.text === 'string')
            .map((w) => ({
              text: w.text,
              startMs: w.startMs != null ? w.startMs + offsetMs : null,
              endMs: w.endMs != null ? w.endMs + offsetMs : null,
              partOfPrevious: !!w.partOfPrevious,
            }))
        : [];
      lines.push({
        text: raw.text,
        startMs: (raw.startMs != null ? raw.startMs : 0) + offsetMs,
        endMs: raw.endMs != null ? raw.endMs + offsetMs : null,
        lastEnd: raw.lastEnd != null ? raw.lastEnd + offsetMs : null,
        words,
        align: raw.align === 'left' || raw.align === 'right' ? raw.align : 'center',
        isBackground: !!raw.isBackground,
        isInterlude: !!raw.isInterlude,
      });
    }

    // Pull every time back above zero before sorting; offsetting the whole doc
    // is uniform, but a negative offset can park lines on top of each other.
    for (const line of lines) {
      if (line.startMs < 0) line.startMs = 0;
      if (line.lastEnd != null && line.lastEnd < 0) line.lastEnd = 0;
      if (line.endMs != null && line.endMs < 0) line.endMs = 0;
      for (const word of line.words) {
        if (word.startMs != null && word.startMs < 0) word.startMs = 0;
        if (word.endMs != null && word.endMs < 0) word.endMs = 0;
      }
    }

    lines.sort((a, b) => a.startMs - b.startMs);

    const knownDurations = lines
      .filter((l) => l.endMs != null && l.endMs > l.startMs)
      .map((l) => l.endMs - l.startMs);
    const defaultDuration = clamp(median(knownDurations) || FALLBACK_LINE_MS, 800, 8000);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const nextStart = i + 1 < lines.length ? lines[i + 1].startMs : null;

      // Forward-fill word starts. A syllable without timing inherits the end of
      // the previous syllable; the line start is the floor for the first word.
      let cursor = line.startMs;
      for (const word of line.words) {
        if (word.startMs == null || word.startMs < line.startMs) word.startMs = cursor;
        if (word.startMs < line.startMs) word.startMs = line.startMs;
        cursor = word.startMs;
      }

      let lastWordEnd = null;
      for (const word of line.words) {
        if (word.endMs != null && word.endMs > word.startMs) {
          lastWordEnd = lastWordEnd == null ? word.endMs : Math.max(lastWordEnd, word.endMs);
        }
      }

      let end = line.endMs != null && line.endMs > line.startMs ? line.endMs : null;
      if (line.lastEnd != null && line.lastEnd > line.startMs) end = Math.max(end || 0, line.lastEnd);
      if (lastWordEnd != null && lastWordEnd > line.startMs) end = Math.max(end || 0, lastWordEnd);
      if (end == null) {
        // No end anywhere: keep the line under the next line's start so gaps stay
        // visible for interlude detection instead of stretching across silence.
        const room = nextStart != null ? nextStart - line.startMs : defaultDuration;
        end = line.startMs + clamp(room, MIN_LINE_MS, Math.max(MIN_LINE_MS, defaultDuration));
      }
      if (nextStart != null && end > nextStart) end = nextStart;
      if (end <= line.startMs) end = line.startMs + MIN_LINE_MS;
      line.endMs = end;

      // Backward-fill word ends so each fragment stops where the next starts.
      let boundary = line.endMs;
      for (let k = line.words.length - 1; k >= 0; k--) {
        const word = line.words[k];
        if (word.endMs == null || word.endMs <= word.startMs) word.endMs = boundary;
        if (word.endMs > boundary) word.endMs = boundary;
        if (word.endMs <= word.startMs) word.endMs = word.startMs + 1;
        boundary = word.startMs;
      }
    }

    // Interlude markers: any silent window longer than INTERLUDE_GAP_MS,
    // including a lead-in before the first line.
    const output = [];
    let previousEnd = 0;
    for (const line of lines) {
      if (line.isInterlude) {
        output.push(line);
        previousEnd = line.endMs;
        continue;
      }
      if (line.startMs - previousEnd > INTERLUDE_GAP_MS) {
        output.push({
          text: '',
          startMs: previousEnd,
          endMs: line.startMs,
          words: [],
          align: 'center',
          isBackground: false,
          isInterlude: true,
        });
      }
      output.push(line);
      if (line.endMs > previousEnd) previousEnd = line.endMs;
    }

    return { lines: output, wordSynced: output.some((l) => l.words.length > 0) };
  }

  function buildDoc(fields) {
    return {
      trackId: fields.trackId != null ? String(fields.trackId) : '',
      syncType: fields.syncType,
      lines: fields.lines,
      source: fields.source || 'spclient',
      fetchedAt: Date.now(),
      offsetMs: fields.offsetMs,
      meta: {
        provider: fields.provider || 'unknown',
        language: fields.language || null,
        syncTypeRaw: fields.syncTypeRaw || null,
        interludeGapMs: INTERLUDE_GAP_MS,
      },
    };
  }

  /**
   * Content-based word-sync inference.
   *
   * Spotify labels most karaoke payloads "LINE_SYNCED" even when they carry
   * usable syllables, so the sync type is derived from the data: a line is
   * word-synced when it has at least two syllables whose numChars add up to the
   * full line text length (trailing spaces included). Explicit `UNSYNCED` still
   * always means static.
   */
  function syllableCharTotal(syllables) {
    let total = 0;
    let count = 0;
    for (const syllable of syllables) {
      const numChars = num(syllable && syllable.numChars);
      if (numChars == null) continue;
      total += Math.max(0, Math.round(numChars));
      count += 1;
    }
    return { total, count };
  }

  function isWordSyncedLine(item) {
    const { total, count } = syllableCharTotal(item.syllables);
    if (count >= 2 && total === item.text.length) return true;
    if (count === 0) {
      // Providers that ship explicit syllable text instead of numChars: two or
      // more display chunks are only meaningful as per-word timing.
      const explicit = item.syllables.filter((s) => s && typeof s.text === 'string' && s.text.length).length;
      return explicit >= 2;
    }
    return false;
  }

  /**
   * @param {object} json  the raw color-lyrics response body
   * @param {{trackId?: string, offsetMs?: number, source?: string}} [options]
   * @returns {SL.LyricsDoc|null}
   */
  function parseColorLyrics(json, options) {
    const opts = options || {};
    try {
      if (!json || typeof json !== 'object') return null;

      let lyrics = null;
      if (json.lyrics && typeof json.lyrics === 'object') lyrics = json.lyrics;
      else if (Array.isArray(json.lines)) lyrics = json; // tolerate unwrapped payloads
      if (!lyrics || !Array.isArray(lyrics.lines) || lyrics.lines.length === 0) return null;

      const declared = typeof lyrics.syncType === 'string' ? lyrics.syncType.toUpperCase() : '';
      const rawLines = [];
      let anyTiming = false;
      let hasText = false;

      for (const item of lyrics.lines) {
        if (!item || typeof item !== 'object') continue;
        const text = typeof item.words === 'string' ? item.words : typeof item.text === 'string' ? item.text : '';
        const startMs = num(item.startTimeMs);
        const endMs = num(item.endTimeMs);
        const syllables = Array.isArray(item.syllables) ? item.syllables : [];
        const parsed = buildWords(text, syllables);

        if ((startMs != null && startMs > 0) || (endMs != null && endMs > 0)) anyTiming = true;
        if (text.trim().length) hasText = true;

        rawLines.push({
          text,
          startMs: startMs != null ? startMs : 0,
          endMs: endMs != null && endMs > 0 ? endMs : null,
          lastEnd: parsed.lastSyllableEnd,
          words: parsed.words,
          syllables,
          align: 'center',
          isBackground: false,
        });
      }

      if (!rawLines.length || !hasText) return null;

      const offsetMs = Number.isFinite(Number(opts.offsetMs)) ? Math.round(Number(opts.offsetMs)) : 0;
      const staticMode = declared === 'UNSYNCED' || !anyTiming;

      if (staticMode) {
        const staticLines = rawLines.map((line) => ({
          text: line.text,
          startMs: 0,
          endMs: 0,
          words: [],
          align: 'center',
          isBackground: false,
          isUnsynced: true,
        }));
        return buildDoc({
          trackId: opts.trackId,
          syncType: 'static',
          lines: staticLines,
          source: opts.source || 'spclient',
          offsetMs,
          provider: lyrics.provider || lyrics.providerDisplayName,
          language: lyrics.language,
          syncTypeRaw: lyrics.syncType,
        });
      }

      // Content inference: word sync needs syllable coverage, not the label.
      const wordSynced = rawLines.some((line) => isWordSyncedLine(line));
      if (!wordSynced) {
        for (const line of rawLines) line.words = [];
      } else {
        // Lines without full syllable coverage stay wordless; the renderer falls
        // back to a line-level highlight for them.
        for (const line of rawLines) {
          if (!isWordSyncedLine(line)) line.words = [];
        }
      }

      const finalized = finalizeTimeline(rawLines, { offsetMs });
      return buildDoc({
        trackId: opts.trackId,
        syncType: finalized.wordSynced ? 'word' : 'line',
        lines: finalized.lines,
        source: opts.source || 'spclient',
        offsetMs,
        provider: lyrics.provider || lyrics.providerDisplayName,
        language: lyrics.language,
        syncTypeRaw: lyrics.syncType,
      });
    } catch (err) {
      // Parsing must never take the content script down: malformed payloads are
      // reported as "no lyrics" and the source chain moves on.
      SL.log && SL.log('color-lyrics parse failed', err);
      return null;
    }
  }

  SL.lyrics.parseColorLyrics = parseColorLyrics;
})();
