/**
 * Spicy Lyrics for Chrome — the lyric column.
 *
 * Renders every line of the current LyricsDoc up front (virtualisation is not
 * needed below ~400 lines: off-screen rows are simply `visibility: hidden`),
 * drives a critically damped spring so the active line rests at 42% of the
 * stage height, and paints word-by-word karaoke progress through the `--p`
 * custom property (see styles/lyrics.css).
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
  const SPRING_K = 168;
  const SPRING_C = 2 * Math.sqrt(SPRING_K) * 0.84;
  const INTERLUDE_GAP_MS = 3500;
  const MAX_MANUAL_SCROLL = 0.34; // fraction of stage height

  const WHITESPACE = /[ \t]+/;

  function el(tag, cls) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  function create(root, opts) {
    opts = opts || {};
    const column = el('div', 'sl-column');
    const stack = el('div', 'sl-stack');
    column.appendChild(stack);
    root.appendChild(column);
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Lyrics');
    root.setAttribute('aria-live', 'off');

    let doc = null;
    let settings = SL.store ? SL.store.DEFAULT_SETTINGS : {};
    let settingsSig = '';
    let builtDots = null;
    let rows = [];
    let lineRows = [];
    let rowByLine = [];
    let measureDirty = true;
    let anchorY = 0;
    let y = 0;
    let v = 0;
    let lastNow = 0;
    let lastSeekSeq = -1;
    let activeIdx = -1;
    let activeWordEl = null;
    let paused = false;
    let manual = 0;
    let lastWheelAt = 0;
    let isStatic = false;
    let destroyed = false;

    // -------------------------------------------------------------------------
    // DOM construction
    // -------------------------------------------------------------------------

    function pushDots(fragment, lineIdx, anchor, extraClass) {
      const rowEl = el('div', 'sl-row');
      rowEl.dataset.kind = 'dots';
      rowEl.dataset.level = '3';
      if (extraClass) rowEl.classList.add(extraClass);
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
          const dots = pushDots(fragment, i, i);
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
          pushDots(fragment, i, i + 0.5, 'is-gap-dots');
        }
      }
      stack.appendChild(fragment);
      builtDots = !!(settings && settings.showInterludeDots);
      applyStaticProgress();
      applyActive(activeIndexAt(0), true);
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

      anchorY = height * ANCHOR;
      stack.style.paddingTop = anchorY.toFixed(2) + 'px';
      stack.style.paddingBottom = Math.max(height * 0.3, height - anchorY).toFixed(2) + 'px';

      const base = util.clamp(width * 0.049, 15, 80) * (Number(settings.fontSize) || 1);
      root.style.setProperty('--sl-fs', base.toFixed(2) + 'px');

      for (const row of lineRows) row.lineEl.style.fontSize = base.toFixed(2) + 'px';
      const naturals = lineRows.map((row) => row.inner.offsetWidth);
      const limit = width * 0.995;
      for (let i = 0; i < lineRows.length; i++) {
        const natural = naturals[i];
        if (natural > limit) {
          const fit = util.clamp((width / natural) * 0.985, 0.5, 1);
          lineRows[i].lineEl.style.fontSize = (base * fit).toFixed(2) + 'px';
        }
      }
      // One geometry read after all writes.
      for (const row of rows) {
        row.center = row.rowEl.offsetTop + row.rowEl.offsetHeight / 2;
      }
      measureDirty = false;
      lastNow = 0; // force a clean spring step / snap next tick
      y = 0;
      v = 0;
      const row = rowByLine[activeIdx];
      if (row) y = anchorY - row.center;
      stack.style.transform = 'translate3d(0,' + y.toFixed(2) + 'px,0)';
      if (opts.onMeasure) opts.onMeasure();
    }

    // -------------------------------------------------------------------------
    // Timing
    // -------------------------------------------------------------------------

    function activeIndexAt(positionMs) {
      const lines = (doc && doc.lines) || [];
      const n = lines.length;
      if (!n) return -1;
      const pos = positionMs;
      if (isStatic) {
        const duration = (SL.store.get().track && SL.store.get().track.durationMs) || 0;
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

    function applyActive(idx, force) {
      if (idx === activeIdx && !force) return;
      activeIdx = idx;
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

    function paintActiveRow(pos) {
      const row = rowByLine[activeIdx];
      if (!row || row.kind !== 'line') return;

      if (isStatic) {
        setRowProgress(row, 1);
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
          if (p > 0 && p < 1) activeWord = word.el;
        }
        if (activeWord !== activeWordEl) {
          if (activeWordEl) activeWordEl.classList.remove('is-active');
          if (activeWord) activeWord.classList.add('is-active');
          activeWordEl = activeWord;
        }
        row.p = null;
      } else if (row.textEl) {
        const line = row.line;
        const start = Number(line.startMs) || 0;
        const end = Math.max(Number(line.endMs) || start + 2500, start + 200);
        const p = util.clamp((pos - start) / (end - start), 0, 1);
        if (row.p !== p) {
          row.p = p;
          row.textEl.style.setProperty('--p', p.toFixed(4));
        }
      }
    }

    // -------------------------------------------------------------------------
    // Tick
    // -------------------------------------------------------------------------

    function tick(state, frameNow) {
      if (destroyed || !doc) return;
      if (measureDirty) measure();

      const playback = state.playback || {};
      const pos = SL.store.positionNow() + (Number(settings.offsetMs) || 0);
      let snap = false;

      if (playback.seekSeq !== lastSeekSeq) {
        lastSeekSeq = playback.seekSeq;
        snap = true;
      }

      const idx = activeIndexAt(pos);
      if (idx !== activeIdx) applyActive(idx);
      paintActiveRow(pos);

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

      const row = rowByLine[activeIdx];
      const target = (row ? anchorY - row.center : 0) + manual;
      const reduced = !!(settings && settings.reduceMotion);
      const dt = lastNow ? util.clamp((frameNow - lastNow) / 1000, 0.001, 0.05) : 0.016;
      lastNow = frameNow;

      if (reduced || snap || y === 0) {
        y = target;
        v = 0;
      } else {
        const accel = (target - y) * SPRING_K - v * SPRING_C;
        v += accel * dt;
        y += v * dt;
      }
      const snapped = Math.round(y * 2) / 2;
      stack.style.transform = 'translate3d(0,' + snapped.toFixed(1) + 'px,0)';
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
      const sig = [
        settings.wordHighlight,
        settings.fontSize,
        settings.lineGap,
        settings.reduceMotion,
        settings.showRomanization,
        settings.showInterludeDots,
      ].join('|');
      if (sig === settingsSig) return false;
      settingsSig = sig;

      root.dataset.highlight = settings.wordHighlight === 'solid' ? 'solid' : 'gradient';
      root.classList.toggle('is-static-motion', !!settings.reduceMotion);
      root.classList.toggle('show-roman', settings.showRomanization !== false);
      root.style.setProperty('--sl-gap', String(settings.lineGap == null ? 1 : settings.lineGap));

      const needsMeasure =
        prev.fontSize !== settings.fontSize || prev.lineGap !== settings.lineGap;
      const dotsChanged = builtDots !== null && builtDots !== !!settings.showInterludeDots;
      if (dotsChanged && doc) {
        build();
        measure();
      } else if (needsMeasure) {
        measureDirty = true;
        measure();
      }
      return true;
    }

    function setDoc(nextDoc, nextSettings) {
      if (destroyed) return;
      doc = nextDoc && Array.isArray(nextDoc.lines) && nextDoc.lines.length ? nextDoc : null;
      if (nextSettings) adoptSettings(nextSettings);
      if (!doc) {
        stack.textContent = '';
        rows = [];
        lineRows = [];
        rowByLine = [];
        activeIdx = -1;
        activeWordEl = null;
        return;
      }
      build();
      measure();
    }

    function applySettings(nextSettings) {
      adoptSettings(nextSettings || {});
    }

    function destroy() {
      destroyed = true;
      if (observer) observer.disconnect();
      root.removeEventListener('click', onClick);
      root.removeEventListener('wheel', onWheel);
      stack.textContent = '';
      rows = [];
      lineRows = [];
      rowByLine = [];
    }

    return { el: root, setDoc, applySettings, tick, measure, destroy };
  }

  SL.lyricsView = { create };
})();
