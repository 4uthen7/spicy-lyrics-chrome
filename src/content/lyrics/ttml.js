/**
 * Parser for Spotify's TTML lyric documents (the timed-text format used by the
 * desktop client and by /color-lyrics?format=ttml).
 *
 * The subset handled here is the one Spotify/Apple-style karaoke TTML uses:
 *
 *   <tt ...>
 *     <body><div>
 *       <p begin="00:00:01.000" end="00:00:04.500" ttm:agent="v1">
 *         <span begin="1.0s" end="1.5s">Hello </span>
 *         <span begin="1.5s" end="2.0s">world</span>
 *         <span ttm:role="x-bg" begin="2.0s" end="2.4s">(echo)</span>
 *       </p>
 *     </div></body>
 *   </tt>
 *
 * A tiny XML reader is implemented inline instead of using DOMParser so the
 * parser is testable in a bare Node VM and never depends on the live DOM.
 *
 * UNVERIFIED: duet side assignment. Spotify's TTML is expected to use
 * ttm:agent ids (v1/v2) for duet parts, in first-appearance order, but that has
 * not been checked against a real duet payload here. First agent -> left,
 * second -> right; a single agent (or none) stays centered.
 */
(function () {
  'use strict';
  const SL = (globalThis.SL = globalThis.SL || {});
  SL.lyrics = SL.lyrics || {};
  if (SL.lyrics.parseTTML) return;

  const INTERLUDE_GAP_MS = 4000;
  const FALLBACK_LINE_MS = 4000;
  const MIN_LINE_MS = 250;

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // ---------------------------------------------------------------------------
  // Minimal XML reader
  // ---------------------------------------------------------------------------

  function decodeEntities(text) {
    if (text.indexOf('&') === -1) return text;
    return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        if (isFinite(code) && code >= 0) {
          try {
            return String.fromCodePoint(code);
          } catch {
            return match;
          }
        }
        return match;
      }
      switch (body) {
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case 'apos': return "'";
        case 'nbsp': return '\u00a0';
        default: return match;
      }
    });
  }

  function parseAttributes(source) {
    const attrs = Object.create(null);
    const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let match;
    while ((match = re.exec(source))) {
      const value = match[2] != null ? match[2] : match[3];
      attrs[match[1]] = decodeEntities(value == null ? '' : value);
    }
    return attrs;
  }

  /** Parses the XML subset into { type, name, attrs, children } nodes. */
  function parseXml(source) {
    const root = { type: 'element', name: '#document', attrs: Object.create(null), children: [] };
    const stack = [root];
    const length = source.length;
    let i = 0;

    const pushText = (raw, decoded) => {
      if (!raw) return;
      stack[stack.length - 1].children.push({ type: 'text', value: decoded ? raw : decodeEntities(raw) });
    };

    while (i < length) {
      const lt = source.indexOf('<', i);
      if (lt === -1) {
        pushText(source.slice(i), false);
        break;
      }
      if (lt > i) pushText(source.slice(i, lt), false);

      if (source.startsWith('<!--', lt)) {
        const end = source.indexOf('-->', lt + 4);
        i = end === -1 ? length : end + 3;
        continue;
      }
      if (source.startsWith('<![CDATA[', lt)) {
        const end = source.indexOf(']]>', lt + 9);
        const cdata = source.slice(lt + 9, end === -1 ? length : end);
        pushText(cdata, true);
        i = end === -1 ? length : end + 3;
        continue;
      }
      if (source.startsWith('<?', lt)) {
        const end = source.indexOf('?>', lt + 2);
        i = end === -1 ? length : end + 2;
        continue;
      }
      if (source.startsWith('<!', lt)) {
        const end = source.indexOf('>', lt + 2);
        i = end === -1 ? length : end + 1;
        continue;
      }

      // Find the tag end, skipping over quoted attribute values.
      let j = lt + 1;
      let quote = '';
      while (j < length) {
        const ch = source[j];
        if (quote) {
          if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === '>') {
          break;
        }
        j++;
      }
      if (j >= length) break;

      let tag = source.slice(lt + 1, j);
      let selfClosing = false;
      if (tag.endsWith('/')) {
        selfClosing = true;
        tag = tag.slice(0, -1);
      }

      if (tag.startsWith('/')) {
        const name = tag.slice(1).trim();
        for (let k = stack.length - 1; k > 0; k--) {
          if (stack[k].name === name) {
            stack.length = k;
            break;
          }
        }
        i = j + 1;
        continue;
      }

      const nameMatch = /^([^\s/>]+)/.exec(tag);
      if (!nameMatch) {
        i = j + 1;
        continue;
      }
      const element = {
        type: 'element',
        name: nameMatch[1],
        attrs: parseAttributes(tag.slice(nameMatch[1].length)),
        children: [],
      };
      stack[stack.length - 1].children.push(element);
      if (!selfClosing) stack.push(element);
      i = j + 1;
    }

    return root;
  }

  function localName(name) {
    const idx = name.indexOf(':');
    return idx === -1 ? name : name.slice(idx + 1);
  }

  function attr(element, name) {
    if (!element || !element.attrs) return null;
    if (name in element.attrs) return element.attrs[name];
    // Accept namespace-prefixed forms regardless of the prefix used by the file.
    const want = name.indexOf(':') === -1 ? name : localName(name);
    for (const key of Object.keys(element.attrs)) {
      if (localName(key) === want) return element.attrs[key];
    }
    return null;
  }

  function textContent(node) {
    if (!node) return '';
    if (node.type === 'text') return node.value;
    let out = '';
    for (const child of node.children || []) out += textContent(child);
    return out;
  }

  function collectElements(node, name, out) {
    for (const child of node.children || []) {
      if (child.type !== 'element') continue;
      if (localName(child.name) === name) out.push(child);
      else collectElements(child, name, out);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Timing values
  // ---------------------------------------------------------------------------

  /**
   * TTML time expression -> ms. Supports hh:mm:ss(.fff), mm:ss(.fff),
   * "<n>s", "<n>ms" and bare seconds. Frame counts are not supported and yield
   * null rather than a guessed value.
   */
  function parseTime(value) {
    if (value == null) return null;
    const text = String(value).trim();
    if (!text) return null;

    let match = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(text);
    if (match) {
      return Math.round((Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000);
    }
    match = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(text);
    if (match) return Math.round((Number(match[1]) * 60 + Number(match[2])) * 1000);
    match = /^(\d+(?:\.\d+)?)ms$/i.exec(text);
    if (match) return Math.round(Number(match[1]));
    match = /^(\d+(?:\.\d+)?)s$/i.exec(text);
    if (match) return Math.round(Number(match[1]) * 1000);
    match = /^(\d+(?:\.\d+)?)$/.exec(text);
    if (match) return Math.round(Number(match[1]) * 1000);
    return null;
  }

  // ---------------------------------------------------------------------------
  // Document -> raw lines
  // ---------------------------------------------------------------------------

  /**
   * Collects the leaf spans of one <p> as word candidates. Background role and
   * timing attributes are inherited down nested spans.
   */
  function collectWordSpans(paragraph) {
    const words = [];

    const walk = (node, inherited) => {
      for (const child of node.children || []) {
        if (child.type !== 'element') continue;
        const name = localName(child.name);
        if (name !== 'span') {
          walk(child, inherited);
          continue;
        }
        const role = attr(child, 'ttm:role') || attr(child, 'role');
        const background = inherited.background || role === 'x-bg';
        const begin = parseTime(attr(child, 'begin'));
        const end = parseTime(attr(child, 'end'));
        const inheritedBegin = begin != null ? begin : inherited.begin;
        const inheritedEnd = end != null ? end : inherited.end;

        // A span that holds more spans is a grouping node; descend into it.
        const hasElementChild = (child.children || []).some((c) => c.type === 'element');
        if (hasElementChild) {
          walk(child, {
            background,
            begin: inheritedBegin,
            end: inheritedEnd,
          });
          continue;
        }

        const rawText = textContent(child);
        if (!rawText) continue;
        words.push({
          rawText,
          begin: inheritedBegin,
          end: inheritedEnd,
          isBackground: background,
        });
      }
    };

    const paragraphRole = attr(paragraph, 'ttm:role') || attr(paragraph, 'role');
    walk(paragraph, { background: paragraphRole === 'x-bg', begin: null, end: null });
    return words;
  }

  function buildLine(paragraph, inheritedAgent) {
    const begin = parseTime(attr(paragraph, 'begin'));
    const end = parseTime(attr(paragraph, 'end'));
    const agent = attr(paragraph, 'ttm:agent') || attr(paragraph, 'agent') || inheritedAgent || null;
    const paragraphRole = attr(paragraph, 'ttm:role') || attr(paragraph, 'role');

    const spanWords = collectWordSpans(paragraph);
    const words = [];
    let previousEndedWithSpace = false;

    for (const span of spanWords) {
      const trimmed = span.rawText.trim();
      if (!trimmed) {
        if (span.rawText.length) previousEndedWithSpace = true;
        continue;
      }
      const leadingSpace = /^\s/.test(span.rawText);
      const trailingSpace = /\s$/.test(span.rawText);
      words.push({
        text: trimmed,
        startMs: span.begin,
        endMs: span.end,
        partOfPrevious: !leadingSpace && !previousEndedWithSpace && words.length > 0,
        isBackground: span.isBackground,
      });
      previousEndedWithSpace = trailingSpace;
    }

    let lineText;
    if (words.length) {
      lineText = words
        .map((word, index) => (index > 0 && !word.partOfPrevious ? ' ' : '') + word.text)
        .join('');
    } else {
      lineText = textContent(paragraph).replace(/\s+/g, ' ').trim();
    }

    const allBackground = words.length > 0 ? words.every((word) => word.isBackground) : paragraphRole === 'x-bg';

    // A <p> without begin still has a usable start when its first span is timed.
    let firstWordStart = null;
    for (const word of words) {
      if (word.startMs != null && (firstWordStart == null || word.startMs < firstWordStart)) {
        firstWordStart = word.startMs;
      }
    }

    return {
      text: lineText,
      startMs: begin != null ? begin : firstWordStart != null ? firstWordStart : 0,
      endMs: end != null && end > 0 ? end : null,
      words,
      align: 'center',
      isBackground: allBackground,
      agent,
      hasTiming: begin != null || end != null || spanWords.some((word) => word.begin != null),
    };
  }

  // ---------------------------------------------------------------------------
  // Shared timeline finalization (mirrors color-lyrics.js; kept local so each
  // parser stays independently loadable and testable).
  // ---------------------------------------------------------------------------

  function finalizeTimeline(rawLines, options) {
    const offsetMs = options && Number.isFinite(Number(options.offsetMs)) ? Math.round(Number(options.offsetMs)) : 0;
    const lines = [];

    for (const raw of rawLines) {
      if (!raw || typeof raw.text !== 'string') continue;
      const words = (raw.words || []).map((word) => ({
        text: word.text,
        startMs: word.startMs != null ? word.startMs + offsetMs : null,
        endMs: word.endMs != null ? word.endMs + offsetMs : null,
        partOfPrevious: !!word.partOfPrevious,
      }));
      lines.push({
        text: raw.text,
        startMs: (raw.startMs != null ? raw.startMs : 0) + offsetMs,
        endMs: raw.endMs != null ? raw.endMs + offsetMs : null,
        words,
        align: raw.align || 'center',
        isBackground: !!raw.isBackground,
      });
    }

    for (const line of lines) {
      if (line.startMs < 0) line.startMs = 0;
      if (line.endMs != null && line.endMs < 0) line.endMs = 0;
      for (const word of line.words) {
        if (word.startMs != null && word.startMs < 0) word.startMs = 0;
        if (word.endMs != null && word.endMs < 0) word.endMs = 0;
      }
    }

    lines.sort((a, b) => a.startMs - b.startMs);

    const knownDurations = lines
      .filter((line) => line.endMs != null && line.endMs > line.startMs)
      .map((line) => line.endMs - line.startMs);
    const defaultDuration = clamp(median(knownDurations) || FALLBACK_LINE_MS, 800, 8000);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const nextStart = i + 1 < lines.length ? lines[i + 1].startMs : null;

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
      if (lastWordEnd != null && lastWordEnd > line.startMs) end = Math.max(end || 0, lastWordEnd);
      if (end == null) {
        const room = nextStart != null ? nextStart - line.startMs : defaultDuration;
        end = line.startMs + clamp(room, MIN_LINE_MS, Math.max(MIN_LINE_MS, defaultDuration));
      }
      if (nextStart != null && end > nextStart) end = nextStart;
      if (end <= line.startMs) end = line.startMs + MIN_LINE_MS;
      line.endMs = end;

      let boundary = line.endMs;
      for (let k = line.words.length - 1; k >= 0; k--) {
        const word = line.words[k];
        if (word.endMs == null || word.endMs <= word.startMs) word.endMs = boundary;
        if (word.endMs > boundary) word.endMs = boundary;
        if (word.endMs <= word.startMs) word.endMs = word.startMs + 1;
        boundary = word.startMs;
      }
    }

    const output = [];
    let previousEnd = 0;
    for (const line of lines) {
      if (line.text === '' && line.endMs > line.startMs) {
        // Explicit empty timed line only occurs for interlude markers.
        line.isInterlude = true;
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

    return { lines: output, wordSynced: output.some((line) => line.words.length > 0) };
  }

  // ---------------------------------------------------------------------------
  // Public parser
  // ---------------------------------------------------------------------------

  /**
   * @param {string} xmlText
   * @param {{trackId?: string, offsetMs?: number, source?: string}} [options]
   * @returns {SL.LyricsDoc|null}
   */
  function parseTTML(xmlText, options) {
    const opts = options || {};
    try {
      if (typeof xmlText !== 'string') return null;
      const source = xmlText.replace(/^\uFEFF/, '').trim();
      if (!source || source.indexOf('<') === -1) return null;

      const tree = parseXml(source);
      const paragraphs = collectElements(tree, 'p', []);
      if (!paragraphs.length) return null;

      const rawLines = [];
      let hasTiming = false;
      let hasText = false;

      const walk = (node, inheritedAgent) => {
        for (const child of node.children || []) {
          if (child.type !== 'element') continue;
          const name = localName(child.name);
          const agent = attr(child, 'ttm:agent') || attr(child, 'agent') || inheritedAgent || null;
          if (name === 'p') {
            const line = buildLine(child, agent);
            if (line.hasTiming) hasTiming = true;
            if (line.text.trim()) hasText = true;
            rawLines.push({
              text: line.text,
              startMs: line.startMs,
              endMs: line.endMs,
              words: line.words,
              align: 'center',
              isBackground: line.isBackground,
              agent: line.agent,
            });
          } else {
            walk(child, agent);
          }
        }
      };
      walk(tree, null);

      if (!rawLines.length || !hasText) return null;

      // Duet side: agents in first-appearance order. First agent -> left, second
      // -> right; a single (or absent) agent stays centered. UNVERIFIED mapping.
      const agentOrder = [];
      for (const line of rawLines) {
        if (line.agent && agentOrder.indexOf(line.agent) === -1) agentOrder.push(line.agent);
      }
      const duet = agentOrder.length >= 2;
      const alignByAgent = new Map();
      agentOrder.forEach((agent, index) => {
        alignByAgent.set(agent, duet ? (index % 2 === 0 ? 'left' : 'right') : 'center');
      });
      for (const line of rawLines) {
        line.align = alignByAgent.get(line.agent) || 'center';
      }

      // Timed and untimed paragraphs mixed: untimed text is still a valid line,
      // but the doc is only line/word-synced when at least one paragraph has
      // timing. Everything untimed becomes a static document.
      if (!hasTiming) {
        const staticLines = rawLines.map((line) => ({
          text: line.text,
          startMs: 0,
          endMs: 0,
          words: [],
          align: line.align,
          isBackground: line.isBackground,
          isUnsynced: true,
        }));
        return {
          trackId: opts.trackId != null ? String(opts.trackId) : '',
          syncType: 'static',
          lines: staticLines,
          source: opts.source || 'ttml',
          fetchedAt: Date.now(),
          offsetMs: Number.isFinite(Number(opts.offsetMs)) ? Math.round(Number(opts.offsetMs)) : 0,
          meta: { provider: 'ttml', language: null, interludeGapMs: INTERLUDE_GAP_MS },
        };
      }

      const offsetMs = Number.isFinite(Number(opts.offsetMs)) ? Math.round(Number(opts.offsetMs)) : 0;
      const finalized = finalizeTimeline(rawLines, { offsetMs });
      return {
        trackId: opts.trackId != null ? String(opts.trackId) : '',
        syncType: finalized.wordSynced ? 'word' : 'line',
        lines: finalized.lines,
        source: opts.source || 'ttml',
        fetchedAt: Date.now(),
        offsetMs,
        meta: {
          provider: 'ttml',
          language: null,
          interludeGapMs: INTERLUDE_GAP_MS,
          agents: agentOrder.slice(),
          duet: agentOrder.length >= 2,
        },
      };
    } catch (err) {
      SL.log && SL.log('ttml parse failed', err);
      return null;
    }
  }

  SL.lyrics.parseTTML = parseTTML;
})();
