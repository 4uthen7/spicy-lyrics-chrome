/**
 * Native lyrics DOM scraper.
 *
 * The current Spotify build renders line-synced lyrics as a list of
 * `[data-testid="lyrics-line"]` nodes inside a read-along scroll container;
 * older builds/demo harnesses use `[data-testid="fullscreen-lyric"]`. The DOM
 * carries no timing attributes, so line timings are reconstructed from
 * observation:
 *
 *   - each scrape records the position of the currently highlighted line;
 *   - repeated observations over the same track accumulate anchors, which are
 *     linearly interpolated into per-line start times;
 *   - when no line is highlighted (or the panel has never been observed while
 *     playing) the document degrades to static (`syncType: 'static'`).
 *
 * This is intentionally the last-resort source: it is lossy and improves the
 * more the track is played. The color-lyrics payload is always preferred.
 *
 * Active-line detection follows recon: the build hashes its class names, so
 * the active line is found as the line carrying a class token that appears on
 * exactly one line (plus aria/class/opacity fallbacks and a viewport-centre
 * fallback). Two empty spacer lines are prepended by the view; they only shift
 * DOM indexes, which the learned-anchor map keys on.
 *
 * UNVERIFIED: the whole lyric list is assumed to be rendered at once (not
 * virtualized). Everything Spotify-specific is isolated in DOM_SELECTORS.
 */
(function () {
  'use strict';
  const SL = (globalThis.SL = globalThis.SL || {});
  SL.lyrics = SL.lyrics || {};
  if (SL.lyrics.scrapeNative) return;

  /** Adjustable selector table: these are the only Spotify-specific strings. */
  const DOM_SELECTORS = {
    /** Containers that hold the native lyric list, most specific first. */
    container: [
      '[data-testid="read-along-scroll-container"]',
      '[data-testid="lyrics-container"]',
      '[data-testid="fullscreen-lyrics"]',
      '[data-testid="lyrics-page"]',
      '[data-testid="lyrics-line"]',
      '[data-testid="fullscreen-lyric"]',
    ],
    /** Ordered line selectors: current build first, older shapes after. */
    lines: [
      '[data-testid="lyrics-line"]',
      '[data-testid="fullscreen-lyric"]',
    ],
    /** Primary line selector (kept for compatibility/debugging). */
    line: '[data-testid="lyrics-line"]',
    /**
     * Markers that identify the active/highlighted line. The shipped build uses
     * a hashed class, so the unique-class heuristic below is the real path;
     * these cover other builds and the demo harness.
     */
    activeMarkers: [
      '[aria-current="true"]',
      '[aria-selected="true"]',
      '[data-active="true"]',
      '[class*="active" i]',
      '[class*="selected" i]',
      '.active',
      '.selected',
    ],
  };

  const INTERLUDE_GAP_MS = 4000;
  const FALLBACK_LINE_MS = 4000;
  const MIN_LINE_MS = 250;
  const DEFAULT_STEP_MS = 3000;

  /** trackId -> Map<lineIndex, observedPositionMs> */
  const learned = new Map();
  const MAX_LEARNED_TRACKS = 24;

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function queryAll(root, selector) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  function queryAllLines(root) {
    const seen = new Set();
    const out = [];
    for (const selector of DOM_SELECTORS.lines) {
      for (const element of queryAll(root, selector)) {
        if (!seen.has(element)) {
          seen.add(element);
          out.push(element);
        }
      }
    }
    return out;
  }

  function resolveRoot(container) {
    if (container && typeof container.querySelectorAll === 'function') return container;
    if (typeof document === 'undefined') return null;
    for (const selector of DOM_SELECTORS.container) {
      let element = null;
      try {
        element = document.querySelector(selector);
      } catch {
        element = null;
      }
      if (element && queryAllLines(element).length) return element;
    }
    return document;
  }

  function resolveContainerElement() {
    if (typeof document === 'undefined') return null;
    for (const selector of DOM_SELECTORS.container) {
      try {
        const element = document.querySelector(selector);
        if (element) return element;
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  function isActive(element) {
    try {
      if (element.getAttribute) {
        const current = element.getAttribute('aria-current');
        if (current === 'true') return true;
        if (element.getAttribute('data-active') === 'true') return true;
      }
    } catch {
      /* ignore */
    }
    for (const marker of DOM_SELECTORS.activeMarkers) {
      try {
        if (typeof element.matches === 'function' && element.matches(marker)) return true;
      } catch {
        /* ignore */
      }
    }
    return false;
  }

  function elementChildren(element) {
    try {
      return element && element.children ? Array.from(element.children) : [];
    } catch {
      return [];
    }
  }

  /**
   * The build renders two children per line: lyric text then translation. Use
   * the first child so translations/annotations never leak into the line text.
   */
  function primaryLineText(element) {
    if (!element) return '';
    const children = elementChildren(element);
    if (children.length >= 2) {
      const first = typeof children[0].textContent === 'string' ? children[0].textContent : '';
      if (first.trim()) return first;
      return first;
    }
    return element && typeof element.textContent === 'string' ? element.textContent : '';
  }

  /** Strips trailing "0:12" timestamps and bracketed annotation suffixes. */
  function cleanLineText(element) {
    let text = primaryLineText(element);
    text = text.replace(/\s*[•·]\s*\d{1,2}:\d{2}(?:\.\d+)?\s*$/, '');
    text = text.replace(/\s+\d{1,2}:\d{2}(?:\.\d+)?\s*$/, '');
    const children = elementChildren(element);
    if (children.length < 2) text = text.replace(/\s*\[[^\]]{1,80}\]\s*$/, '');
    if (SL.util && SL.util.cleanText) return SL.util.cleanText(text);
    return text.replace(/\s+/g, ' ').trim();
  }

  function classTokens(element) {
    try {
      const raw = typeof element.className === 'string'
        ? element.className
        : (element.getAttribute && element.getAttribute('class')) || '';
      return raw.split(/\s+/).filter(Boolean);
    } catch {
      return [];
    }
  }

  function elementRect(element) {
    try {
      return element && element.getBoundingClientRect ? element.getBoundingClientRect() : null;
    } catch {
      return null;
    }
  }

  /** Title/artist/album hint cleanup for nearest-centre fallback. */
  function nearestIndexToCenter(lineElements, indexes) {
    let centerY = null;
    const container = resolveContainerElement();
    const containerRect = elementRect(container);
    if (containerRect && containerRect.height > 0) centerY = (containerRect.top + containerRect.bottom) / 2;
    if (centerY == null && typeof window !== 'undefined' && window.innerHeight) centerY = window.innerHeight / 2;
    if (centerY == null) return -1; // no layout to compare against

    let best = -1;
    let bestDistance = Infinity;
    for (const index of indexes) {
      const rect = elementRect(lineElements[index]);
      if (!rect || !(rect.height > 0)) continue;
      const distance = Math.abs((rect.top + rect.bottom) / 2 - centerY);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    return best;
  }

  /**
   * Hashed-class heuristic: every line shares the base class plus a role class;
   * the active line is the one carrying a class token that appears exactly once
   * across the rendered lines.
   */
  function findActiveByUniqueClass(lineElements) {
    if (lineElements.length < 3) return -1;
    const frequency = new Map();
    for (const line of lineElements) {
      for (const token of classTokens(line)) frequency.set(token, (frequency.get(token) || 0) + 1);
    }
    const base = new Set();
    for (const [token, count] of frequency) {
      if (count === lineElements.length) base.add(token);
    }
    const candidates = [];
    for (let i = 0; i < lineElements.length; i++) {
      const unique = classTokens(lineElements[i]).some((token) => !base.has(token) && frequency.get(token) === 1);
      if (unique) candidates.push(i);
    }
    if (!candidates.length) return -1;
    if (candidates.length === 1) return candidates[0];
    return nearestIndexToCenter(lineElements, candidates);
  }

  /** Inline opacity/scale emphasis (demo-harness / non-hashed variants). */
  function findActiveByEmphasis(lineElements) {
    const values = lineElements.map((element) => {
      let opacity = null;
      let scale = null;
      try {
        const style = (element.getAttribute && element.getAttribute('style')) || '';
        const opacityMatch = /(?:^|;)\s*opacity\s*:\s*([\d.]+)/.exec(style);
        if (opacityMatch) opacity = Number(opacityMatch[1]);
        const scaleMatch = /scale\(\s*([\d.]+)\s*\)/.exec(style);
        if (scaleMatch) scale = Number(scaleMatch[1]);
      } catch {
        /* ignore */
      }
      return { opacity, scale };
    });

    const opacities = values.map((value) => value.opacity).filter((value) => value != null && isFinite(value));
    if (opacities.length >= 2) {
      const max = Math.max(...opacities);
      const min = Math.min(...opacities);
      if (max >= 0.9 && min <= 0.75 && max - min >= 0.2) {
        const index = values.findIndex((value) => value.opacity === max);
        if (index !== -1) return index;
      }
    }
    const scales = values.map((value) => value.scale).filter((value) => value != null && isFinite(value));
    if (scales.length >= 2) {
      const max = Math.max(...scales);
      const min = Math.min(...scales);
      if (max > 1.02 && max - min > 0.02) {
        const index = values.findIndex((value) => value.scale === max);
        if (index !== -1) return index;
      }
    }
    return -1;
  }

  function findActiveIndex(lineElements) {
    for (let i = 0; i < lineElements.length; i++) {
      if (isActive(lineElements[i])) return i;
    }
    const byClass = findActiveByUniqueClass(lineElements);
    if (byClass !== -1) return byClass;
    const byEmphasis = findActiveByEmphasis(lineElements);
    if (byEmphasis !== -1) return byEmphasis;
    // Last resort: the line nearest the scroll port's vertical centre.
    return nearestIndexToCenter(
      lineElements,
      lineElements.map((_, index) => index),
    );
  }

  function rememberAnchor(trackId, index, positionMs) {
    if (!trackId || index < 0 || !isFinite(positionMs)) return 0;
    let anchors = learned.get(trackId);
    if (!anchors) {
      if (learned.size >= MAX_LEARNED_TRACKS) {
        const oldest = learned.keys().next().value;
        learned.delete(oldest);
      }
      anchors = new Map();
      learned.set(trackId, anchors);
    }
    anchors.set(index, Math.max(0, Math.round(positionMs)));
    return anchors.size;
  }

  function observedPosition(options) {
    if (options && isFinite(options.positionMs)) return options.positionMs;
    if (SL.store && typeof SL.store.positionNow === 'function') {
      try {
        return SL.store.positionNow();
      } catch {
        return 0;
      }
    }
    return 0;
  }

  /**
   * Interpolates anchors into one start time per DOM line index. Returns null
   * when there is nothing to interpolate from.
   */
  function buildTimes(count, anchors) {
    if (!anchors || anchors.size === 0) return null;
    const known = Array.from(anchors.entries())
      .filter(([index, time]) => index >= 0 && index < count && isFinite(time))
      .sort((a, b) => a[0] - b[0]);
    if (!known.length) return null;

    let step = DEFAULT_STEP_MS;
    if (known.length >= 2) {
      const first = known[0];
      const last = known[known.length - 1];
      const indexSpan = last[0] - first[0];
      if (indexSpan > 0) {
        const observed = (last[1] - first[1]) / indexSpan;
        if (observed > 0) step = observed;
      }
    }
    step = clamp(step, 250, 20000);

    const times = new Array(count).fill(null);
    for (const [index, time] of known) times[index] = Math.max(0, Math.round(time));

    // Interpolate between neighbours, extrapolate with the average step.
    for (let k = 0; k < known.length; k++) {
      const [index, time] = known[k];
      const next = known[k + 1];
      if (next) {
        const span = next[0] - index;
        for (let i = index + 1; i < next[0]; i++) {
          const ratio = span > 0 ? (i - index) / span : 0;
          times[i] = Math.round(time + (next[1] - time) * ratio);
        }
      } else {
        for (let i = index + 1; i < count; i++) times[i] = Math.round(time + step * (i - index));
      }
    }

    const firstKnown = known[0][0];
    for (let i = firstKnown - 1; i >= 0; i--) {
      times[i] = Math.max(0, Math.round(times[i + 1] - step));
    }

    // Keep the timeline strictly increasing even when rounding collapses two
    // extrapolated neighbours onto the same millisecond.
    const minStep = Math.max(50, Math.round(step * 0.25));
    for (let i = 1; i < count; i++) {
      if (times[i] != null && times[i - 1] != null && times[i] <= times[i - 1]) {
        times[i] = times[i - 1] + minStep;
      }
    }
    return times;
  }

  /** Local timeline finalization, same rules as the other parsers. */
  function finalizeTimeline(rawLines, offsetMs, options) {
    const opts = options || {};
    const lines = rawLines.map((raw) => ({
      text: raw.text,
      startMs: raw.startMs + offsetMs,
      endMs: raw.endMs != null ? raw.endMs + offsetMs : null,
      words: [],
      align: 'center',
      isBackground: false,
    }));

    for (const line of lines) {
      if (line.startMs < 0) line.startMs = 0;
      if (line.endMs != null && line.endMs < 0) line.endMs = 0;
    }
    lines.sort((a, b) => a.startMs - b.startMs);

    const knownDurations = lines
      .filter((line) => line.endMs != null && line.endMs > line.startMs)
      .map((line) => line.endMs - line.startMs);
    const defaultDuration = clamp(median(knownDurations) || FALLBACK_LINE_MS, 800, 8000);

    for (let i = 0; i < lines.length; i++) {
      const nextStart = i + 1 < lines.length ? lines[i + 1].startMs : null;
      let end = lines[i].endMs != null && lines[i].endMs > lines[i].startMs ? lines[i].endMs : null;
      if (end == null) {
        end = nextStart != null
          ? Math.min(nextStart, lines[i].startMs + defaultDuration)
          : lines[i].startMs + defaultDuration;
      }
      if (nextStart != null && end > nextStart) end = nextStart;
      if (end <= lines[i].startMs) end = lines[i].startMs + Math.min(MIN_LINE_MS, nextStart != null ? Math.max(1, nextStart - lines[i].startMs) : MIN_LINE_MS);
      if (end <= lines[i].startMs) end = lines[i].startMs + 1;
      lines[i].endMs = end;
    }

    const output = [];
    // Learned timelines are anchored mid-song, so their lead-in gap is an
    // artifact of the first observation, not a real instrumental intro.
    let previousEnd = opts.allowLeadingInterlude === false && lines.length ? lines[0].startMs : 0;
    for (const line of lines) {
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
    return output;
  }

  /**
   * @param {Element|Document|null} container
   * @param {{trackId?: string, offsetMs?: number, positionMs?: number}} [options]
   * @returns {SL.LyricsDoc|null}
   */
  function scrapeNative(container, options) {
    const opts = options || {};
    try {
      const root = resolveRoot(container);
      if (!root) return null;
      const lineElements = queryAllLines(root);
      if (!lineElements.length) return null;

      const entries = [];
      let activeIndex = -1;
      for (let i = 0; i < lineElements.length; i++) {
        const text = cleanLineText(lineElements[i]);
        entries.push({ text });
        if (activeIndex === -1 && isActive(lineElements[i])) activeIndex = i;
      }
      if (!entries.some((entry) => entry.text.length)) return null;
      // Explicit markers first, then the hashed-unique-class heuristic used by
      // the shipped build, then inline emphasis and closest-to-centre.
      if (activeIndex === -1) activeIndex = findActiveIndex(lineElements);

      const trackId = opts.trackId != null ? String(opts.trackId) : '';
      const offsetMs = Number.isFinite(Number(opts.offsetMs)) ? Math.round(Number(opts.offsetMs)) : 0;

      // Some players (and the demo harness) mirror payload timings onto the
      // line nodes as data-start-ms/data-end-ms. Exact values beat observation.
      const datasetLines = [];
      for (let i = 0; i < lineElements.length; i++) {
        const text = entries[i].text;
        if (!text) continue;
        const element = lineElements[i];
        const rawStart = element.getAttribute ? element.getAttribute('data-start-ms') : null;
        const rawEnd = element.getAttribute ? element.getAttribute('data-end-ms') : null;
        if (rawStart == null) continue;
        const start = Number(rawStart);
        const end = Number(rawEnd);
        if (!isFinite(start) || start < 0) continue;
        datasetLines.push({
          text,
          startMs: Math.round(start),
          endMs: isFinite(end) && end > start ? Math.round(end) : null,
        });
      }
      if (datasetLines.length >= 2) {
        return {
          trackId,
          syncType: 'line',
          lines: finalizeTimeline(datasetLines, offsetMs, { allowLeadingInterlude: true }),
          source: 'dom',
          fetchedAt: Date.now(),
          offsetMs,
          meta: { provider: 'dom', datasetTimings: true, activeIndex, anchors: 0 },
        };
      }

      const positionMs = observedPosition(opts);
      if (activeIndex >= 0 && trackId) rememberAnchor(trackId, activeIndex, positionMs);

      const anchors = trackId ? learned.get(trackId) : null;
      const times = anchors ? buildTimes(entries.length, anchors) : null;

      if (!times) {
        // No observation yet: expose the text so the renderer can show plain,
        // unsynced lyrics instead of an empty panel.
        const staticLines = entries
          .filter((entry) => entry.text.length)
          .map((entry) => ({
            text: entry.text,
            startMs: 0,
            endMs: 0,
            words: [],
            align: 'center',
            isBackground: false,
            isUnsynced: true,
          }));
        if (!staticLines.length) return null;
        return {
          trackId,
          syncType: 'static',
          lines: staticLines,
          source: 'dom',
          fetchedAt: Date.now(),
          offsetMs,
          meta: { provider: 'dom', anchors: 0, activeIndex: -1 },
        };
      }

      const rawLines = [];
      for (let i = 0; i < entries.length; i++) {
        if (!entries[i].text.length) continue;
        rawLines.push({ text: entries[i].text, startMs: times[i] != null ? times[i] : 0 });
      }
      if (!rawLines.length) return null;

      return {
        trackId,
        syncType: 'line',
        lines: finalizeTimeline(rawLines, offsetMs, { allowLeadingInterlude: false }),
        source: 'dom',
        fetchedAt: Date.now(),
        offsetMs,
        meta: {
          provider: 'dom',
          anchors: anchors ? anchors.size : 0,
          activeIndex,
          observedPositionMs: Math.round(positionMs),
        },
      };
    } catch (err) {
      SL.log && SL.log('dom scrape failed', err);
      return null;
    }
  }

  scrapeNative.DOM_SELECTORS = DOM_SELECTORS;
  SL.lyrics.DOM_SELECTORS = DOM_SELECTORS;
  SL.lyrics.scrapeNative = scrapeNative;
  SL.lyrics.resetDomLearning = () => learned.clear();
  SL.lyrics.getDomAnchors = (trackId) => {
    const anchors = learned.get(trackId);
    return anchors ? Object.fromEntries(anchors) : null;
  };
})();
