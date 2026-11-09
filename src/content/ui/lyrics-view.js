/**
 * Spicy Lyrics for Chrome — the lyric column.
 *
 * Renders every line of the current LyricsDoc up front (virtualisation is not
 * needed below ~400 lines: off-screen rows are simply `visibility: hidden`),
 * and moves the stack through one of three motion models selected by
 * `settings.lyricMode`:
 *
 *   cinema  the original behaviour. The active line rests at 42% of the stage
 *           and a critically damped spring pulls the stack to it; depth is
 *           bucketed per row (dim / blur / scale / slight tilt) and a per-line
 *           swell + accent bloom peaks at the middle of the line.
 *
 *   flow    continuous motion. Every line owns a "centre time" (its midpoint)
 *           and an anchor pixel offset; the scroll target is interpolated
 *           between neighbouring anchors from the playback clock, so the stack
 *           glides through the whole line instead of snapping at boundaries.
 *           Per-row opacity / blur / scale are driven continuously from the
 *           fractional distance to the stack position, which also makes the
 *           upcoming line brighten before it becomes active. Long instrumental
 *           gaps simply spread the same interpolation over a longer interval,
 *           so they drift instead of stalling.
 *
 *   simple  Spicy's "simple" mode: centred, uniform, flat. No blur, no scale,
 *           no tilt, no overshoot — only the active line is bright and only the
 *           word fill animates. The stack eases to the next line without a
 *           spring.
 *
 * Word timing is painted once per frame into the `--p` custom property of
 * spans that are created exactly once per document; no span is ever recreated
 * during playback and no object is allocated in the steady-state frame path.
 *
 * The view owns no timer of its own: `tick(state, frameNow)` is called from the
 * overlay's single rAF loop. Timing comes from `SL.store.positionNow()` plus
 * `settings.offsetMs`.
 *
 * Public surface (internal to the overlay):
 *   SL.lyricsView.create(root, { onSeek }) -> {
 *     el, setDoc(doc, settings), applySettings(settings), tick(state, now),
 *     measure(), destroy()
 *   }
 */
(function () {
  'use strict';
  const SL = (globalThis.SL = globalThis.SL || {});
  if (SL.lyricsView) return;
  const util = SL.util;

  const ANCHOR = 0.42; // active line rests here (fraction of stage height)
  const NEAR = 7; // rows kept painted around the active line
  // Slightly stiffer than a pure "floaty" spring: line-to-line moves should
  // settle in roughly 300 ms (Spicy/Beautiful feel) instead of half a second,
  // without overshooting into the next line.
  const SPRING_K = 232;
  const SPRING_C = 2 * Math.sqrt(SPRING_K) * 0.9;
  const INTERLUDE_GAP_MS = 3500;
  const MAX_MANUAL_SCROLL = 0.34; // fraction of stage height

  /** Seconds of smoothing applied to the flow position (removes velocity kinks). */
  const FLOW_TAU = 0.085;
  /** Seconds of exponential easing used by simple mode for its stack moves. */
  const SIMPLE_TAU = 0.14;
  /** Line-distance at which a flow row reaches zero activity. */
  const FLOW_FALLOFF = 3.1;
  /** Max blur on a fully inactive flow row. */
  const FLOW_BLUR = 3;
  /** Stack crossfade duration on track change. */
  const CROSSFADE_MS = 420;

  const MODES = ['cinema', 'flow', 'simple'];

  function el(tag, cls) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  function normalizeMode(value) {
    return MODES.indexOf(value) >= 0 ? value : 'cinema';
  }

  function create(root, opts) {
    opts = opts || {};
    const column = el('div', 'sl-column');
    let stack = el('div', 'sl-stack');
    column.appendChild(stack);
    root.appendChild(column);
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Lyrics');
    root.setAttribute('aria-live', 'off');

    let doc = null;
    let settings = SL.store ? SL.store.DEFAULT_SETTINGS : {};
    let settingsSig = '';
    let mode = 'cinema';
    let reduced = false;
    let builtDots = null;

    let rows = [];
    let lineRows = [];
    let rowByLine = [];

    // Motion track: one key per timed row (lines + real interlude markers).
    let trackT = []; // centre time in ms, ascending
    let trackY = []; // stack translate that centres that row
    let trackRows = []; // row object per key

    // Styling track: every row (including synthetic gap dots) in doc order.
    let stylePos = []; // fractional index in track space
    let styleRows = [];
    let styleFrom = 1;
    let styleTo = 0;

    let anchorY = 0;
    let measureDirty = true;
    let measuredKey = '';
    let y = 0;
    let yWritten = NaN;
    let v = 0;
    let uSmooth = 0;
    let lastNow = 0;
    let lastSeekSeq = -1;
    let lastRenderedPos = -1;
    let lastRenderedOffset = 0;
    let activeIdx = -1;
    let activeWordEl = null;
    let activeProgress = 0;
    let glowRow = null;
    let paused = false;
    let manual = 0;
    let lastWheelAt = 0;
    let isStatic = false;
    let destroyed = false;
    const fading = [];

    // -------------------------------------------------------------------------
    // DOM construction
    // -------------------------------------------------------------------------

    function pushDots(fragment, lineIdx, anchor, isGap) {
      const rowEl = el('div', 'sl-row');
      rowEl.dataset.kind = 'dots';
      rowEl.dataset.level = '3';
      if (isGap) rowEl.classList.add('is-gap-dots');
      rowEl.innerHTML = '<div class="sl-dots" aria-hidden="true"><i></i><i></i><i></i></div>';
      fragment.appendChild(rowEl);
      const row = {
        kind: 'dots',
        lineIdx,
        anchor,
        rowEl,
        lineEl: null,
        inner: null,
        words: [],
        textEl: null,
        level: 3,
        hidden: false,
        p: null,
        center: 0,
        trackPos: 0,
        isGap: !!isGap,
        vars: null,
      };
      rows.push(row);
      return row;
    }

    function build() {
      stack.textContent = '';
      rows = [];
      lineRows = [];
      rowByLine = [];
      activeIdx = -1;
      activeWordEl = null;
      glowRow = null;
      manual = 0;
      measureDirty = true;

      const lines = (doc && doc.lines) || [];
      isStatic = !!doc && doc.syncType === 'static';
      const fragment = document.createDocumentFragment();

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineWords = Array.isArray(line.words) ? line.words : [];
        const hasText = !!(line.text && line.text.length) || lineWords.length > 0;

        if (line.isInterlude || !hasText) {
          const dots = pushDots(fragment, i, i, false);
          rowByLine[i] = dots;
          continue;
        }

        const rowEl = el('div', 'sl-row');
        rowEl.dataset.kind = 'line';
        rowEl.dataset.line = String(i);
        rowEl.dataset.level = '3';
        rowEl.dataset.align = line.align || 'center';

        const lineEl = el('div', 'sl-line');
        lineEl.dataset.align = line.align || 'center';
        lineEl.dataset.bg = line.isBackground ? '1' : '0';
        const inner = el('div', 'sl-inner');
        lineEl.appendChild(inner);

        const words = [];
        if (lineWords.length) {
          for (let w = 0; w < lineWords.length; w++) {
            const word = lineWords[w];
            if (w > 0 && !word.partOfPrevious) inner.appendChild(document.createTextNode(' '));
            const span = el('span', 'sl-w');
            span.textContent = word.text == null ? '' : String(word.text);
            span.style.setProperty('--p', '0');
            inner.appendChild(span);
            const start = Number(word.startMs) || 0;
            const end = Math.max(Number(word.endMs) || start, start + 35);
            words.push({ el: span, start, end, lastP: null });
          }
        } else {
          const span = el('span', 'sl-t');
          span.textContent = line.text || '';
          span.style.setProperty('--p', '0');
          inner.appendChild(span);
        }
        rowEl.appendChild(lineEl);

        if (line.romanized) {
          const roman = el('div', 'sl-roman');
          roman.textContent = line.romanized;
          rowEl.appendChild(roman);
        }

        fragment.appendChild(rowEl);
        const row = {
          kind: 'line',
          line: line,
          lineIdx: i,
          anchor: i,
          rowEl,
          lineEl,
          inner,
          words,
          textEl: words.length ? null : inner.firstChild,
          level: 3,
          hidden: false,
          p: null,
          center: 0,
          trackPos: 0,
          isGap: false,
          vars: null,
        };
        rows.push(row);
        lineRows.push(row);
        rowByLine[i] = row;

        // Synthetic interlude dots for long instrumental gaps.
        const next = lines[i + 1];
        if (
          settings.showInterludeDots &&
          next &&
          !next.isInterlude &&
          next.startMs - (line.endMs || line.startMs) > INTERLUDE_GAP_MS
        ) {
          pushDots(fragment, i, i + 0.5, true);
        }
      }
      stack.appendChild(fragment);
      builtDots = !!(settings && settings.showInterludeDots);
      buildTrackMeta();
      applyStaticProgress();
      applyActive(activeIndexAt(0), true);
    }

    /** A row's ideal "centre time": its own midpoint, shortened for safety. */
    function lineCenter(line) {
      const s = Number(line && line.startMs) || 0;
      const e = Math.max(Number(line && line.endMs) || 0, s + 500);
      return s + (e - s) * 0.5;
    }

    function buildTrackMeta() {
      trackT = [];
      trackY = [];
      trackRows = [];
      stylePos = [];
      styleRows = [];
      styleFrom = 1;
      styleTo = 0;
      let last = -Infinity;
      const lines = (doc && doc.lines) || [];
      for (const row of rows) {
        if (row.kind === 'line' || !row.isGap) {
          const line = row.kind === 'line' ? row.line : lines[row.lineIdx];
          let t = lineCenter(line);
          // Keep the key list strictly ascending even if the doc overlaps.
          if (!(t > last)) t = last + 1;
          last = t;
          row.trackPos = trackT.length;
          trackT.push(t);
          trackRows.push(row);
        } else {
          row.trackPos = trackT.length - 0.5;
        }
        stylePos.push(row.trackPos);
        styleRows.push(row);
      }
    }

    function applyStaticProgress() {
      if (!isStatic) return;
      for (const row of lineRows) setRowProgress(row, 1);
    }

    // -------------------------------------------------------------------------
    // Measurement: three passes (write sizes, read widths, write fits, read geometry)
    // -------------------------------------------------------------------------

    function measure() {
      if (destroyed || !doc) return;
      const width = column.clientWidth;
      const height = root.clientHeight;
      if (!width || !height) return;

      // The overlay calls measure() on every throttled scroll of the host page.
      // Only the column size and the base type size affect layout, so an
      // unchanged key can skip the expensive fit/reflow passes (and avoid
      // re-snapping the stack when the host merely moved).
      const base = util.clamp(width * 0.049, 15, 80) * (Number(settings.fontSize) || 1);
      const key = width + '|' + height + '|' + base.toFixed(2);
      if (!measureDirty && key === measuredKey) return;
      measuredKey = key;

      anchorY = height * ANCHOR;
      stack.style.paddingTop = anchorY.toFixed(2) + 'px';
      stack.style.paddingBottom = Math.max(height * 0.3, height - anchorY).toFixed(2) + 'px';

      root.style.setProperty('--sl-fs', base.toFixed(2) + 'px');

      // Measure natural (unwrapped) widths so long lines can be fitted; the
      // `is-measuring` class switches lines to nowrap for one geometry read.
      stack.classList.add('is-measuring');
      for (const row of lineRows) row.lineEl.style.fontSize = base.toFixed(2) + 'px';
      const naturals = new Array(lineRows.length);
      for (let i = 0; i < lineRows.length; i++) naturals[i] = lineRows[i].inner.offsetWidth;
      const limit = width * 0.995;
      for (let i = 0; i < lineRows.length; i++) {
        const natural = naturals[i];
        if (natural > limit) {
          const fit = util.clamp((width / natural) * 0.985, 0.5, 1);
          lineRows[i].lineEl.style.fontSize = (base * fit).toFixed(2) + 'px';
        }
      }
      stack.classList.remove('is-measuring');

      // One geometry read after all writes.
      for (const row of rows) {
        row.center = row.rowEl.offsetTop + row.rowEl.offsetHeight / 2;
      }
      trackY.length = 0;
      for (let i = 0; i < trackRows.length; i++) {
        trackY.push(anchorY - trackRows[i].center);
      }

      measureDirty = false;
      snapScroll();
      if (opts.onMeasure) opts.onMeasure();
    }

    // -------------------------------------------------------------------------
    // Timing helpers
    // -------------------------------------------------------------------------

    function currentPos() {
      if (!SL.store) return 0;
      // Positive offset delays the lyrics (they trail the audio), matching the
      // "+ = later" labels in the popup and the overlay panel.
      return SL.store.positionNow() - (Number(settings.offsetMs) || 0);
    }

    function activeIndexAt(positionMs) {
      const lines = (doc && doc.lines) || [];
      const n = lines.length;
      if (!n) return -1;
      const pos = positionMs;
      if (isStatic) {
        const track = SL.store.get().track || {};
        const duration = track.durationMs || 0;
        const first = Number(lines[0].startMs) || 0;
        const last = Number(lines[n - 1].startMs) || 0;
        if (duration > 0 && last - first < 1500) {
          return util.clamp(Math.floor((pos / duration) * n), 0, n - 1);
        }
      }
      let lo = 0;
      let hi = n - 1;
      let ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if ((Number(lines[mid].startMs) || 0) <= pos) {
          ans = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return ans;
    }

    function flowActive() {
      return (
        mode === 'flow' &&
        !isStatic &&
        !reduced &&
        trackT.length > 1 &&
        trackY.length === trackT.length
      );
    }

    /** Continuous position along the track, in line units. */
    function flowTargetAt(pos) {
      const n = trackT.length;
      if (!n) return 0;
      if (pos <= trackT[0]) return 0;
      if (pos >= trackT[n - 1]) return n - 1;
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (trackT[mid] <= pos) lo = mid;
        else hi = mid;
      }
      const t0 = trackT[lo];
      const t1 = trackT[hi];
      return lo + (pos - t0) / Math.max(1, t1 - t0);
    }

    /** Pixel translate for a fractional track position. */
    function flowYAt(u) {
      const n = trackY.length;
      if (!n) return 0;
      if (n === 1) return trackY[0];
      const clamped = util.clamp(u, 0, n - 1);
      const i = Math.min(Math.floor(clamped), n - 2);
      return trackY[i] + (trackY[i + 1] - trackY[i]) * (clamped - i);
    }

    function anchorFor(idx) {
      const row = rowByLine[idx] || rowByLine[0];
      if (!row) return 0;
      return anchorY - row.center;
    }

    // -------------------------------------------------------------------------
    // Painting
    // -------------------------------------------------------------------------

    function setRowProgress(row, p) {
      if (!row) return;
      const q = Math.round(util.clamp(p, 0, 1) * 1000) / 1000;
      if (row.p === q) return;
      row.p = q;
      if (row.words.length) {
        for (const word of row.words) {
          if (word.lastP === q) continue;
          word.lastP = q;
          word.el.style.setProperty('--p', String(q));
        }
      } else if (row.textEl) {
        row.textEl.style.setProperty('--p', String(q));
      }
    }

    function repaintOffscreenLines() {
      if (!doc) return;
      for (const row of lineRows) {
        if (row.lineIdx === activeIdx) continue;
        setRowProgress(row, isStatic ? 1 : row.lineIdx < activeIdx ? 1 : 0);
      }
    }

    function clearRowVars(row) {
      if (!row || !row.lineEl || !row.vars) {
        if (row) row.vars = null;
        return;
      }
      const st = row.lineEl.style;
      st.removeProperty('--o');
      st.removeProperty('--s');
      st.removeProperty('--b');
      st.removeProperty('--bloom');
      st.removeProperty('--swell');
      row.vars = null;
    }

    function clearAllRowVars() {
      for (const row of styleRows) clearRowVars(row);
      glowRow = null;
      styleFrom = 1;
      styleTo = 0;
    }

    function applyActive(idx, force) {
      if (idx === activeIdx && !force) return;
      const previous = activeIdx;
      activeIdx = idx;
      resetRowAnimations(rowByLine[previous]);
      for (const row of rows) {
        const distance = Math.abs((row.anchor == null ? row.lineIdx : row.anchor) - idx);
        let level;
        if (row.kind === 'dots') {
          level = distance < 0.75 ? 0 : util.clamp(Math.round(distance), 1, 3);
        } else {
          level = distance < 0.75 ? 0 : distance < 1.75 ? 1 : distance < 3.75 ? 2 : 3;
        }
        if (row.level !== level) {
          row.level = level;
          row.rowEl.dataset.level = String(level);
        }
        const hidden = distance > NEAR;
        if (row.hidden !== hidden) {
          row.hidden = hidden;
          row.rowEl.style.visibility = hidden ? 'hidden' : '';
        }
      }
      if (activeWordEl) {
        activeWordEl.classList.remove('is-active');
        activeWordEl = null;
      }
      repaintOffscreenLines();
    }

    // --- Per-syllable bounce -------------------------------------------------
    // Ranges ported from Spicy Lyrics' LyricsAnimator (ScaleRange /
    // LetterScaleRange / YOffsetRange / GlowRange) as smooth curves instead of
    // splines: scale 0.95 -> 1.05 -> 1, a small upward kick, and a glow that
    // blooms early and fades as the syllable finishes.
    function smooth01(t) {
      t = util.clamp(t, 0, 1);
      return t * t * (3 - 2 * t);
    }

    function wordAnimation(p) {
      const t = util.clamp(p, 0, 1);
      const scale =
        t < 0.7
          ? 0.95 + (1.0505 - 0.95) * smooth01(t / 0.7)
          : 1.0505 + (1 - 1.0505) * smooth01((t - 0.7) / 0.3);
      const y =
        t < 0.9
          ? 0.01 + (-1 / 60 - 0.01) * smooth01(t / 0.9)
          : (-1 / 60) * (1 - smooth01((t - 0.9) / 0.1));
      let glow;
      if (t <= 0.15) glow = smooth01(t / 0.15);
      else if (t <= 0.6) glow = 1;
      else glow = 1 - smooth01((t - 0.6) / 0.4);
      return { scale, y, glow };
    }

    function setWordAnimation(word, p) {
      const anim = wordAnimation(p);
      const cache = word.anim || (word.anim = {});
      const scale = Math.round(anim.scale * 1000) / 1000;
      const y = Math.round(anim.y * 10000) / 10000;
      const glow = Math.round(anim.glow * 100) / 100;
      if (cache.scale !== scale) {
        cache.scale = scale;
        word.el.style.setProperty('--ws', scale.toFixed(3));
      }
      if (cache.y !== y) {
        cache.y = y;
        word.el.style.setProperty('--wy', y.toFixed(4) + 'em');
      }
      if (cache.glow !== glow) {
        cache.glow = glow;
        word.el.style.setProperty('--wb', (1 + 13 * glow).toFixed(1) + 'px');
        word.el.style.setProperty('--wo', (0.06 + 0.62 * glow).toFixed(3));
      }
      cache.on = true;
    }

    function resetWordAnimation(word) {
      if (!word || !word.anim || !word.anim.on) return;
      word.anim.on = false;
      word.anim.scale = 1;
      word.anim.y = 0;
      word.anim.glow = 0;
      word.el.style.setProperty('--ws', '1');
      word.el.style.setProperty('--wy', '0em');
      word.el.style.setProperty('--wb', '0px');
      word.el.style.setProperty('--wo', '0');
    }

    function resetRowAnimations(row) {
      if (!row || !row.words) return;
      for (const word of row.words) resetWordAnimation(word);
    }

    function paintActiveRow(pos) {
      const row = rowByLine[activeIdx];
      if (!row) {
        activeProgress = 0;
        return;
      }
      if (row.kind !== 'line') {
        activeProgress = 1;
        return;
      }

      if (isStatic) {
        setRowProgress(row, 1);
        activeProgress = 1;
        return;
      }

      if (row.words.length) {
        let activeWord = null;
        for (const word of row.words) {
          const span = Math.max(1, word.end - word.start);
          const p = util.clamp((pos - word.start) / span, 0, 1);
          if (word.lastP !== p) {
            word.lastP = p;
            word.el.style.setProperty('--p', p.toFixed(4));
          }
          if (p > 0 && p < 1) {
            activeWord = word.el;
            setWordAnimation(word, p);
          } else if (word.anim && word.anim.on) {
            resetWordAnimation(word);
          }
        }
        if (activeWord !== activeWordEl) {
          if (activeWordEl) activeWordEl.classList.remove('is-active');
          if (activeWord) activeWord.classList.add('is-active');
          activeWordEl = activeWord;
        }
        row.p = null;
        const line = row.line;
        const start = Number(line.startMs) || 0;
        const end = Math.max(Number(line.endMs) || start + 2500, start + 200);
        activeProgress = util.clamp((pos - start) / (end - start), 0, 1);
      } else if (row.textEl) {
        const line = row.line;
        const start = Number(line.startMs) || 0;
        const end = Math.max(Number(line.endMs) || start + 2500, start + 200);
        const p = util.clamp((pos - start) / (end - start), 0, 1);
        if (row.p !== p) {
          row.p = p;
          row.textEl.style.setProperty('--p', p.toFixed(4));
        }
        activeProgress = p;
      }
    }

    /**
     * Per-line swell + accent bloom on the active line (cinema/flow). The
     * swell peaks mid-line (1.4% scale) and the bloom radius follows a sine so
     * the line "breathes" with its own progress instead of snapping on.
     */
    function paintActiveGlow(row, p) {
      if (glowRow && glowRow !== row) {
        if (glowRow.vars) {
          glowRow.lineEl.style.removeProperty('--swell');
          if (mode !== 'flow') glowRow.lineEl.style.removeProperty('--bloom');
          delete glowRow.vars.swell;
          if (mode !== 'flow') delete glowRow.vars.bloom;
        }
      }
      glowRow = row;
      if (!row || !row.lineEl) return;
      if (reduced || mode === 'simple') {
        clearRowVars(row);
        return;
      }
      const k = Math.sin(Math.PI * util.clamp(p, 0, 1));
      const cache = row.vars || (row.vars = {});
      const swell = Math.round((1 + 0.014 * k) * 1000) / 1000;
      if (cache.swell !== swell) {
        cache.swell = swell;
        row.lineEl.style.setProperty('--swell', swell.toFixed(3));
      }
      if (mode !== 'flow') {
        const bloom = Math.round(k * 30);
        if (cache.bloom !== bloom) {
          cache.bloom = bloom;
          row.lineEl.style.setProperty('--bloom', bloom + 'px');
        }
      }
    }

    /** Smooth 0..1 falloff over the distance from the flow position. */
    function flowActivity(distance) {
      const x = 1 - Math.abs(distance) / FLOW_FALLOFF;
      if (x <= 0) return 0;
      return x * x * (3 - 2 * x);
    }

    /**
     * Continuous depth styling for the rows around the flow position. Rows that
     * leave the window are reset so the bucketed `data-level` rules take over
     * again; everything written here is quantised and cached, so a still frame
     * performs zero style writes.
     */
    function paintFlowStyles(u) {
      const n = stylePos.length;
      if (!n) return;
      let lo = 0;
      if (u >= stylePos[n - 1]) lo = n - 1;
      else if (u > stylePos[0]) {
        let hi = n - 1;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (stylePos[mid] <= u) lo = mid;
          else hi = mid;
        }
      }
      const from = Math.max(0, lo - 4);
      const to = Math.min(n - 1, lo + 5);

      if (styleTo >= styleFrom) {
        for (let i = styleFrom; i <= styleTo; i++) {
          if (i >= from && i <= to) continue;
          const row = styleRows[i];
          if (row && row.lineEl) {
            if (row === glowRow && row.vars) delete row.vars.swell;
            clearRowVars(row);
          }
        }
      }
      styleFrom = from;
      styleTo = to;

      for (let i = from; i <= to; i++) {
        const row = styleRows[i];
        if (!row || !row.lineEl) continue;
        const a = flowActivity(u - stylePos[i]);
        const cache = row.vars || (row.vars = {});

        let q = Math.round((0.13 + 0.87 * a * a) * 40) / 40;
        if (cache.o !== q) {
          cache.o = q;
          row.lineEl.style.setProperty('--o', q.toFixed(3));
        }
        q = Math.round((1 + 0.05 * a) * 500) / 500;
        if (cache.s !== q) {
          cache.s = q;
          row.lineEl.style.setProperty('--s', q.toFixed(3));
        }
        const blur = (1 - a) * (1 - a) * FLOW_BLUR;
        q = Math.round(blur * 4) / 4;
        if (cache.b !== q) {
          cache.b = q;
          row.lineEl.style.setProperty('--b', q.toFixed(2) + 'px');
        }
        q = Math.round(a * a * 28);
        if (cache.bloom !== q) {
          cache.bloom = q;
          row.lineEl.style.setProperty('--bloom', q + 'px');
        }
      }
    }

    // -------------------------------------------------------------------------
    // Scroll
    // -------------------------------------------------------------------------

    function writeTransform(py) {
      const q = Math.round(py * 10) / 10;
      if (q === yWritten) return;
      yWritten = q;
      stack.style.transform = 'translate3d(0,' + q.toFixed(1) + 'px,0)';
    }

    function snapScroll() {
      const pos = currentPos();
      const idx = activeIndexAt(pos);
      if (idx !== -1 && idx !== activeIdx) applyActive(idx, true);
      v = 0;
      lastNow = 0;
      if (trackT.length > 1 && trackY.length === trackT.length) {
        uSmooth = flowTargetAt(pos);
      }
      if (flowActive()) {
        y = flowYAt(uSmooth);
      } else {
        y = anchorFor(activeIdx);
      }
      yWritten = NaN;
      writeTransform(y + manual);
    }

    // -------------------------------------------------------------------------
    // Tick
    // -------------------------------------------------------------------------

    function tick(state, frameNow) {
      if (destroyed || !doc) return;
      if (measureDirty) measure();
      if (measureDirty) return; // still no geometry (hidden overlay)

      const playback = state.playback || {};
      let pos = currentPos();
      let snap = false;

      if (playback.seekSeq !== lastSeekSeq) {
        lastSeekSeq = playback.seekSeq;
        snap = true;
      }
      // Safety net against any clock hiccup: never walk the words backwards
      // between seeks. A stale/anchor correction that moved the clock back used
      // to make a finished line re-read itself; that is worse than a few ms of
      // lag, so the rendered position is monotonic per offset setting.
      const offsetNow = Number(settings.offsetMs) || 0;
      if (snap || offsetNow !== lastRenderedOffset) {
        lastRenderedOffset = offsetNow;
        lastRenderedPos = pos;
      } else if (pos < lastRenderedPos - 120) {
        pos = lastRenderedPos;
      } else {
        lastRenderedPos = pos;
      }

      const idx = activeIndexAt(pos);
      if (idx !== activeIdx) applyActive(idx);
      paintActiveRow(pos);
      paintActiveGlow(rowByLine[activeIdx], activeProgress);

      const nowPaused = !playback.isPlaying;
      if (nowPaused !== paused) {
        paused = nowPaused;
        root.classList.toggle('is-paused', paused);
      }

      // Manual wheel scroll eases back to the synced position shortly after the
      // wheel stops, so the page never drifts permanently out of sync.
      if (manual !== 0 && frameNow - lastWheelAt > 1500) {
        manual *= 0.86;
        if (Math.abs(manual) < 0.6) manual = 0;
      }

      const dt = lastNow ? util.clamp((frameNow - lastNow) / 1000, 0.001, 0.05) : 0.016;
      lastNow = frameNow;

      if (flowActive()) {
        const target = flowTargetAt(pos);
        if (snap || Math.abs(target - uSmooth) > 2.2) uSmooth = target;
        else uSmooth += (target - uSmooth) * (1 - Math.exp(-dt / FLOW_TAU));
        y = flowYAt(uSmooth);
        writeTransform(y + manual);
        paintFlowStyles(uSmooth);
        return;
      }

      const target = anchorFor(activeIdx) + manual;
      const jump = Math.abs(target - y);
      if (snap || reduced || (isStatic && mode !== 'cinema') || jump > root.clientHeight * 0.9) {
        y = target;
        v = 0;
      } else if (mode === 'simple') {
        y += (target - y) * (1 - Math.exp(-dt / SIMPLE_TAU));
        if (Math.abs(target - y) < 0.2) y = target;
        v = 0;
      } else {
        const accel = (target - y) * SPRING_K - v * SPRING_C;
        v += accel * dt;
        y += v * dt;
      }
      if (mode === 'flow' && styleTo >= styleFrom) clearAllRowVars();
      writeTransform(y);
    }

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    function onClick(event) {
      const target = event.target;
      if (!target || !target.closest) return;
      const rowEl = target.closest('.sl-row[data-kind="line"]');
      if (!rowEl || !doc) return;
      const lineIdx = Number(rowEl.dataset.line);
      const line = doc.lines[lineIdx];
      if (!line) return;
      const start = Number(line.startMs);
      if (!isFinite(start)) return;
      if (isStatic && !start) return;
      if (opts.onSeek) opts.onSeek(Math.max(0, start));
    }

    function onWheel(event) {
      if (!doc || !lineRows.length) return;
      if (!event.deltaY) return;
      const max = root.clientHeight * MAX_MANUAL_SCROLL;
      manual = util.clamp(manual - event.deltaY, -max, max);
      lastWheelAt = performance.now();
      event.preventDefault();
      event.stopPropagation();
    }

    root.addEventListener('click', onClick);
    root.addEventListener('wheel', onWheel, { passive: false });

    const observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            measureDirty = true;
          })
        : null;
    if (observer) observer.observe(root);

    // -------------------------------------------------------------------------
    // Settings / doc
    // -------------------------------------------------------------------------

    function adoptSettings(next) {
      const prev = settings || {};
      settings = next || {};
      const nextMode = normalizeMode(settings.lyricMode);
      const nextReduced = !!settings.reduceMotion;
      const sig = [
        settings.wordHighlight,
        settings.fontSize,
        settings.lineGap,
        nextMode,
        nextReduced,
        settings.showRomanization,
        settings.showInterludeDots,
      ].join('|');
      if (sig === settingsSig) return false;
      settingsSig = sig;

      const modeChanged = nextMode !== mode;
      const reducedChanged = nextReduced !== reduced;
      mode = nextMode;
      reduced = nextReduced;

      root.dataset.mode = mode;
      root.dataset.motion = reduced ? 'reduced' : 'full';
      root.dataset.highlight = settings.wordHighlight === 'solid' ? 'solid' : 'gradient';
      root.classList.toggle('is-static-motion', reduced);
      root.classList.toggle('show-roman', settings.showRomanization !== false);
      root.style.setProperty('--sl-gap', String(settings.lineGap == null ? 1 : settings.lineGap));

      if (modeChanged || reducedChanged) clearAllRowVars();

      const needsMeasure =
        prev.fontSize !== settings.fontSize || prev.lineGap !== settings.lineGap || modeChanged || reducedChanged;
      const dotsChanged = builtDots !== null && builtDots !== !!settings.showInterludeDots;
      if (dotsChanged && doc) {
        rebuild(false);
      } else if (needsMeasure) {
        measureDirty = true;
        measure();
      }
      return true;
    }

    // -------------------------------------------------------------------------
    // Stack swap (track change crossfade)
    // -------------------------------------------------------------------------

    // Both halves of the crossfade are started with a forced style flush rather
    // than a rAF, so a background tab (where rAF is paused) still completes the
    // swap instead of leaving the outgoing stack painted underneath forever.
    function retireStack(node, crossfade) {
      if (!node) return;
      node.classList.add('is-leaving');
      if (!crossfade) {
        node.remove();
        return;
      }
      // Flush the "opacity: 1" start state, then transition to 0.
      void node.offsetWidth;
      node.classList.add('is-fading');
      const entry = { node: node, timer: 0 };
      fading.push(entry);
      entry.timer = setTimeout(() => {
        node.remove();
        const i = fading.indexOf(entry);
        if (i >= 0) fading.splice(i, 1);
      }, CROSSFADE_MS + 80);
    }

    function enterStack(node) {
      node.classList.add('is-entering');
      void node.offsetWidth;
      node.classList.add('is-in');
    }

    function rebuild(crossfade) {
      const prev = stack;
      const canFade = crossfade && !!prev && prev.isConnected && !!root.isConnected;
      if (prev) {
        if (canFade) prev.classList.add('is-leaving');
      }
      stack = el('div', 'sl-stack');
      column.appendChild(stack);
      if (canFade) enterStack(stack);
      build();
      measure();
      if (prev) retireStack(prev, canFade);
    }

    function clearAll() {
      for (const row of rows) clearRowVars(row);
      for (const entry of fading.slice()) {
        clearTimeout(entry.timer);
        entry.node.remove();
      }
      fading.length = 0;
      if (stack) stack.textContent = '';
      rows = [];
      lineRows = [];
      rowByLine = [];
      trackT = [];
      trackY = [];
      trackRows = [];
      stylePos = [];
      styleRows = [];
      activeIdx = -1;
      activeWordEl = null;
      glowRow = null;
      yWritten = NaN;
    }

    function setDoc(nextDoc, nextSettings) {
      if (destroyed) return;
      const hadDoc = !!doc;
      doc = nextDoc && Array.isArray(nextDoc.lines) && nextDoc.lines.length ? nextDoc : null;
      if (nextSettings) adoptSettings(nextSettings);
      if (!doc) {
        clearAll();
        return;
      }
      rebuild(hadDoc && !reduced);
    }

    function applySettings(nextSettings) {
      adoptSettings(nextSettings || {});
    }

    function destroy() {
      destroyed = true;
      if (observer) observer.disconnect();
      root.removeEventListener('click', onClick);
      root.removeEventListener('wheel', onWheel);
      for (const entry of fading) clearTimeout(entry.timer);
      fading.length = 0;
      if (stack) stack.textContent = '';
      rows = [];
      lineRows = [];
      rowByLine = [];
      trackT = [];
      trackY = [];
      trackRows = [];
      stylePos = [];
      styleRows = [];
    }

    // Establish the mode attributes before the first tick so a static doc
    // already renders in the right shape.
    adoptSettings(settings);

    return { el: root, setDoc, applySettings, tick, measure, destroy };
  }

  SL.lyricsView = { create };
})();
