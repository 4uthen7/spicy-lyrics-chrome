/**
 * Spicy Lyrics — render lab driver.
 *
 * Standalone harness for the visual layer: fake Spotify shell (render-lab.html),
 * fake store, deterministic fixtures and a fake clock, so headless Chrome can
 * screenshot the overlay at an exact playback position.
 *
 * Query parameters:
 *   ?mode=word|line|static   fixture / sync type (default word)
 *   ?t=<ms>                  freeze the playback clock at this position
 *   ?full=1                  cover the whole viewport instead of #view
 *   ?align=center|left       override the fixture line alignment
 *   ?dim=0.62&blur=90        background tuning
 *   ?fs=1&gap=1              type tuning
 *   ?hl=gradient|solid       word highlight mode
 *   ?lyric_mode=cinema|flow|simple  lyric motion model
 *   ?bg=artwork|artwork-sharp|gradient|solid|video|image   background style
 *   ?bgmotion=0              disable background drift (backgroundMotion:false)
 *   ?solo=1                  collapse the fake shell to the panel-mode column
 *   ?debug=1                 show a background/video state readout
 *   ?pause=1                 render the paused/breathing state
 *
 * No network, no build step, no dependencies. The artwork is generated into a
 * data: URL on a canvas so palette extraction works on file:// pages too.
 */
(() => {
  'use strict';

  const Q = new URLSearchParams(location.search);
  const MODE = (Q.get('mode') || 'word').toLowerCase();
  const HAS_T = Q.has('t');
  const FIXED_T = HAS_T ? Math.max(0, Number(Q.get('t')) || 0) : null;
  const FULL = Q.get('full') === '1';
  const PAUSED = Q.get('pause') === '1';
  const ALIGN = Q.get('align') || 'center';
  const BG = (Q.get('bg') || 'artwork').toLowerCase();
  const SOLO = Q.get('solo') === '1';
  const DEBUG = Q.get('debug') === '1';
  const BARE = Q.get('bare') === '1';
  const BG_STYLES = ['artwork', 'artwork-sharp', 'gradient', 'solid', 'video', 'image'];
  const BG_STYLE = BG_STYLES.includes(BG) ? BG : 'artwork';
  const num = (key, fallback) => (Q.has(key) ? Number(Q.get(key)) : fallback);
  const fixtureUrl = (name) => new URL('./fixtures/' + name, location.href).href;

  // ---------------------------------------------------------------------------
  // Error surface: a render-lab bug should be visible in a screenshot.
  // ---------------------------------------------------------------------------
  const errorEl = document.getElementById('lab-error');
  function showError(message) {
    if (!errorEl) return;
    errorEl.textContent = String(message);
    errorEl.classList.add('is-on');
  }
  window.addEventListener('error', (event) => {
    showError(event.message + (event.filename ? '\n' + event.filename + ':' + event.lineno : ''));
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    showError('Unhandled rejection: ' + (reason && (reason.stack || reason.message) || reason));
  });

  // ---------------------------------------------------------------------------
  // chrome.* stub, installed before any extension file reads it.
  // ---------------------------------------------------------------------------
  window.chrome = window.chrome || {};
  window.chrome.runtime = {
    id: 'render-lab',
    getURL: (path) => new URL('../' + path, location.href).href,
  };
  // In-memory chrome.storage.local so the 'image' style can be exercised the
  // same way the popup writes chrome.storage.local['spicy.bgImage'].
  const labLocal = {
    /** @type {Record<string, unknown>} */
    data: Object.create(null),
    /** @type {Set<Function>} */
    listeners: new Set(),
  };
  function labLocalChanged(changes) {
    for (const fn of labLocal.listeners) {
      try {
        fn(changes, 'local');
      } catch (err) {
        console.error('[lab] storage listener failed', err);
      }
    }
  }
  window.__labStorage = labLocal;
  window.chrome.storage = {
    sync: {
      get: async (keys) => {
        const out = {};
        if (typeof keys === 'string') out[keys] = labLocal.data[keys];
        return out;
      },
      set: async () => {},
    },
    local: {
      get: async (keys) => {
        const out = {};
        if (typeof keys === 'string') out[keys] = labLocal.data[keys];
        else if (Array.isArray(keys)) keys.forEach((k) => (out[k] = labLocal.data[k]));
        else if (keys && typeof keys === 'object') {
          for (const k of Object.keys(keys)) out[k] = labLocal.data[k] ?? keys[k];
        } else {
          Object.assign(out, labLocal.data);
        }
        return out;
      },
      set: async (entries) => {
        if (!entries || typeof entries !== 'object') return;
        const changes = {};
        for (const key of Object.keys(entries)) {
          changes[key] = { oldValue: labLocal.data[key], newValue: entries[key] };
          labLocal.data[key] = entries[key];
        }
        labLocalChanged(changes);
      },
      remove: async (keys) => {
        const list = Array.isArray(keys) ? keys : [keys];
        const changes = {};
        for (const key of list) {
          changes[key] = { oldValue: labLocal.data[key], newValue: undefined };
          delete labLocal.data[key];
        }
        labLocalChanged(changes);
      },
    },
    onChanged: {
      addListener(fn) {
        if (typeof fn === 'function') labLocal.listeners.add(fn);
      },
      removeListener(fn) {
        labLocal.listeners.delete(fn);
      },
    },
  };

  const SL = globalThis.SL;
  if (!SL || !SL.store || !SL.overlay) {
    showError('Extension modules did not load. Check the script tags in render-lab.html.');
    return;
  }

  // ---------------------------------------------------------------------------
  // Deterministic fake artwork
  // ---------------------------------------------------------------------------
  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function makeArt({ base, colors, seed }) {
    const size = 720;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const random = rng(seed);

    const grad = ctx.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, colors[0]);
    grad.addColorStop(0.5, base);
    grad.addColorStop(1, colors[2]);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    ctx.globalCompositeOperation = 'screen';
    ctx.filter = 'blur(58px)';
    colors.forEach((color, i) => {
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.arc(
        size * (0.22 + 0.56 * random()),
        size * (0.18 + 0.6 * random()),
        size * (0.16 + 0.16 * random()),
        0,
        Math.PI * 2
      );
      ctx.fill();
      ctx.globalAlpha = 1;
    });
    ctx.filter = 'none';

    // A soft light source so the blurred background gets some structure.
    const light = ctx.createRadialGradient(size * 0.7, size * 0.22, 0, size * 0.7, size * 0.22, size * 0.6);
    light.addColorStop(0, 'rgba(255,255,255,0.32)');
    light.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, size, size);

    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(size * 0.5, size * 0.54, size * 0.285, 0.2, Math.PI * 1.62);
    ctx.stroke();

    // Film grain.
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < 1400; i++) {
      ctx.fillRect(random() * size, random() * size, 1.4, 1.4);
    }
    ctx.globalAlpha = 1;

    // Vignette.
    const vignette = ctx.createRadialGradient(
      size / 2, size / 2, size * 0.24,
      size / 2, size / 2, size * 0.78
    );
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.5)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, size, size);

    return canvas.toDataURL('image/png');
  }

  const artA = makeArt({ base: '#1a0a12', colors: ['#ff2d6f', '#ff8a3d', '#7b1fa2'], seed: 7 });
  const artB = makeArt({ base: '#07121a', colors: ['#2fe0c8', '#3d7bff', '#b36bff'], seed: 19 });

  // Palette extraction and the artwork layer read real files here. Headless
  // Chrome needs --allow-file-access-from-files for the canvas pixel read;
  // without it the engine falls back to its stable hash palette (still fine).
  const COVER_A = fixtureUrl('cover-3.png');
  const COVER_B = fixtureUrl('cover-1.png');
  const CUSTOM_IMAGE = fixtureUrl('cover-2.png');
  const VIDEO_CLIP = fixtureUrl('canvas-loop.mp4');

  const TRACK_A = {
    id: 'render-lab-wide-home',
    uri: 'spotify:track:render-lab-wide-home',
    title: 'Wide Home',
    artist: 'Wren Adeline',
    album: 'Cinema Static',
    coverUrl: Q.get('cover') === '1' ? COVER_B : COVER_A,
    durationMs: 212000,
    trackUrl: null,
  };
  const TRACK_B = {
    id: 'render-lab-glass-hours',
    uri: 'spotify:track:render-lab-glass-hours',
    title: 'Glass Hours',
    artist: 'Sable Hour',
    album: 'Night Arithmetic',
    coverUrl: COVER_B,
    durationMs: 164000,
    trackUrl: null,
  };

  // ---------------------------------------------------------------------------
  // Fixtures (original lyrics, fictional tracks)
  // ---------------------------------------------------------------------------

  /** Word-synced fixture: [text, startMs, endMs, { align, isBackground }] */
  const WORD_TABLE = [
    ['Dust on the projector light', 9200, 12600],
    ['we rehearse the same goodbye', 12900, 16400],
    ['Every frame is burning slow', 16700, 20600],
    ["and I'm still in the opening scene", 20900, 25800],
    ['Hold the wide shot', 26200, 29900, { align: 'left' }],
    ['hold it, hold it', 30200, 33400, { align: 'right', isBackground: true }],
    ['Say it like you mean it', 33800, 37800],
    ["There's a cinema inside my chest", 38100, 42600],
    ['every seat is taken by your ghost', 42900, 47400],
    ['and the reels keep running', 47700, 51800],
    ['keep running—', 52100, 55200],
    ['I could watch it forever', 60600, 64800, { align: 'right' }],
    ['the same scene, the same light', 65100, 69400],
    ['Hold the wide shot', 69700, 74200],
    ['hold it, hold it', 74500, 78800, { align: 'right', isBackground: true }],
    ['Say it like you mean it', 79100, 83400],
    ['Say it like you mean it', 83700, 88400],
    ['and the light never leaves', 88700, 92600],
    ['the light never leaves', 92900, 97400],
    ["There's a cinema inside my chest", 97700, 101800],
    ['every seat is taken by your ghost', 102100, 106200],
    ['and the reels keep running', 106500, 110600],
    ['keep running—', 110900, 114200],
    ['Wide home, wide home', 124000, 128500],
    ['nothing ends, it just dissolves', 128800, 132600],
    ['Wide home, wide home', 132900, 137000],
  ];

  function buildWords(text, startMs, endMs) {
    const tokens = text.split(' ');
    const weights = tokens.map((token) => Math.max(2, token.replace(/[^\p{L}\p{N}]+/gu, '').length) + 1);
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const span = Math.max(380, endMs - startMs);
    const words = [];
    let cursor = startMs;
    tokens.forEach((token, i) => {
      const remaining = Math.max(70, endMs - cursor);
      const dur =
        i === tokens.length - 1
          ? remaining
          : Math.max(110, Math.round((span * weights[i]) / total));
      const start = cursor;
      const end = Math.min(endMs, start + dur);
      cursor = end;
      const letters = token.replace(/[^\p{L}]+/gu, '');
      // Split a couple of long words into timed syllables to exercise
      // `partOfPrevious` (no gap between the fragments).
      if (letters.length >= 7 && letters === token && i % 3 === 1) {
        const cut = Math.max(2, Math.floor(token.length * 0.6));
        const mid = Math.round(start + (end - start) * 0.55);
        words.push({ text: token.slice(0, cut), startMs: start, endMs: mid });
        words.push({ text: token.slice(cut), startMs: mid, endMs: end, partOfPrevious: true });
      } else {
        words.push({ text: token, startMs: start, endMs: end });
      }
    });
    return words;
  }

  function makeWordDoc() {
    return {
      trackId: TRACK_A.id,
      syncType: 'word',
      source: 'spclient',
      fetchedAt: Date.now(),
      offsetMs: 0,
      meta: { provider: 'Spicy Lyrics', language: 'en' },
      lines: WORD_TABLE.map(([text, startMs, endMs, opts = {}]) => ({
        text,
        startMs,
        endMs,
        words: buildWords(text, startMs, endMs),
        align: opts.align || ALIGN,
        isBackground: !!opts.isBackground,
      })),
    };
  }

  /** Line-synced fixture: words are empty, the whole line fills. */
  const LINE_TABLE = [
    ['Glass hours in the hallway', 6000, 10200],
    ['I count the light in panes', 10500, 14800],
    ['Every window is a screen', 15100, 19600],
    ['and the city plays itself', 19900, 24400],
    ['Static on the seventh floor', 24700, 29200],
    ['the tape is running out', 29500, 33800],
    ['Hold the signal', 34100, 37400],
    ['hold it steady', 37700, 40400, { align: 'right', isBackground: true }],
    ['Glass hours, nothing breaks', 45200, 49800],
    ['I could live inside the frame', 50100, 54800],
    ['where the night is always late', 55100, 59600],
    ['and the colours never fade', 59900, 64400],
    ['Glass hours in the hallway', 64700, 69000],
    ['I count the light in panes', 69300, 73400],
    ['Every window is a screen', 73700, 78000],
    ['and the city plays itself', 78300, 82700],
    ['Static on the seventh floor', 83000, 87200],
    ['the tape is running out', 87500, 91600],
    ['Hold the signal', 91900, 95000],
    ['hold it steady', 95300, 98000, { align: 'right', isBackground: true }],
  ];

  function makeLineDoc() {
    return {
      trackId: TRACK_B.id,
      syncType: 'line',
      source: 'ttml',
      fetchedAt: Date.now(),
      offsetMs: 0,
      meta: { provider: 'Spicy Lyrics', language: 'en' },
      lines: LINE_TABLE.map(([text, startMs, endMs, opts = {}]) => ({
        text,
        startMs,
        endMs,
        words: [],
        align: opts.align || ALIGN,
        isBackground: !!opts.isBackground,
      })),
    };
  }

  function makeStaticDoc() {
    const doc = makeWordDoc();
    doc.syncType = 'static';
    doc.source = 'cache';
    doc.lines = doc.lines.map((line, i) => ({
      ...line,
      words: [],
      startMs: 4000 + i * 2600,
      endMs: 4000 + i * 2600 + 2200,
    }));
    return doc;
  }

  const fixture =
    MODE === 'line' ? { track: TRACK_B, doc: makeLineDoc() }
    : MODE === 'static' ? { track: TRACK_A, doc: makeStaticDoc() }
    : { track: TRACK_A, doc: makeWordDoc() };

  // ---------------------------------------------------------------------------
  // Shell fill
  // ---------------------------------------------------------------------------
  function paintShell(track) {
    const cover = document.getElementById('pb-cover');
    if (cover) cover.src = track.coverUrl;
    const title = document.getElementById('pb-title');
    if (title) title.textContent = track.title;
    const sideCover = document.getElementById('side-cover');
    if (sideCover) sideCover.src = track.coverUrl;
    const sideTitle = document.getElementById('side-title');
    if (sideTitle) sideTitle.textContent = track.title;
    const sideArtist = document.getElementById('side-artist');
    if (sideArtist) sideArtist.textContent = track.artist;
    const artist = document.getElementById('pb-artist');
    if (artist) artist.textContent = track.artist;
    const duration = document.getElementById('pb-duration');
    if (duration) duration.textContent = SL.util.formatClock(track.durationMs);
    const libArt = document.querySelectorAll('.lib-art');
    const washes = [
      ['#ff2d6f', '#3a0d1d'],
      ['#2fe0c8', '#07222a'],
      ['#b36bff', '#1b0c2c'],
      ['#ff8a3d', '#2a1407'],
      ['#3d7bff', '#0a1630'],
    ];
    libArt.forEach((el, i) => {
      const pair = washes[i % washes.length];
      el.style.background = `linear-gradient(140deg, ${pair[0]}, ${pair[1]})`;
      el.style.backgroundSize = 'cover';
    });
    document.title = 'Spicy Lyrics — ' + track.title + ' · ' + track.artist;
  }

  // ---------------------------------------------------------------------------
  // Fake clock + store
  // ---------------------------------------------------------------------------
  const startAt = MODE === 'line' ? 51000 : MODE === 'static' ? 76000 : 42000;

  if (FIXED_T !== null) {
    // Freeze time completely: positionNow() stays at FIXED_T forever.
    const FIXED_NOW = 1000000;
    SL.util.now = () => FIXED_NOW;
    SL.store.setPlayback(FIXED_T, !PAUSED);
  } else {
    SL.store.setPlayback(startAt, !PAUSED);
    window.setInterval(() => {
      if (PAUSED) return;
      const state = SL.store.get();
      if (!state.playback.isPlaying) return;
      // Re-base ~4x a second; the renderer interpolates between bases.
      SL.store.setPlayback(SL.store.positionNow() + 250, true);
    }, 250);
  }

  const defaults = SL.store.DEFAULT_SETTINGS;
  SL.store.setSettings({
    ...defaults,
    showHeader: true,
    showBackground: true,
    backgroundStyle: BG_STYLE,
    backgroundMotion: Q.get('bgmotion') !== '0',
    backgroundDim: num('dim', 0.48),
    backgroundBlur: num('blur', 92),
    fontSize: num('fs', 1),
    lineGap: num('gap', 1),
    wordHighlight: Q.get('hl') === 'solid' ? 'solid' : 'gradient',
    showInterludeDots: Q.get('dots') !== '0',
    reduceMotion: Q.get('motion') === '0',
    lyricMode: (() => {
      const value = (Q.get('lyric_mode') || Q.get('lyricMode') || '').toLowerCase();
      return value === 'flow' || value === 'simple' ? value : 'cinema';
    })(),
  });

  paintShell(fixture.track);

  SL.store.setTrack(fixture.track);
  if (Q.get('empty') === '1') SL.store.setLyricsStatus('empty');
  else if (Q.get('loading') === '1') SL.store.setLyricsStatus('loading');
  else SL.store.setLyrics(fixture.doc, 'ready');

  // ---------------------------------------------------------------------------
  // Lab environment for the background styles
  // ---------------------------------------------------------------------------

  if (SOLO) document.body.classList.add('lab-solo-panel');

  // ?bare=1 hides the lyric/idle/control layers so a screenshot shows the
  // background alone (used for contrast measurements and background review).
  function hideOverlayContent() {
    const host = document.getElementById('spicy-lyrics');
    const root = host && host.shadowRoot;
    if (!root) {
      window.setTimeout(hideOverlayContent, 40);
      return;
    }
    const style = document.createElement('style');
    style.setAttribute('data-lab', 'bare');
    style.textContent =
      '.sl-lyrics,.sl-idle,.sl-header,.sl-status,.sl-panel{visibility:hidden !important;}';
    root.appendChild(style);
  }
  if (BARE) hideOverlayContent();

  // A real page <video> for ?bg=video: the engine mirrors whatever visible
  // <video> the page has, exactly like Spotify's music-video element. The clip
  // is the Lead's generated fixture; if it cannot autoplay in this run we fall
  // back to a canvas captureStream, which still yields a real HTMLVideoElement.
  function installPageVideo() {
    const video = document.createElement('video');
    video.className = 'lab-page-video';
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('aria-hidden', 'true');
    video.src = VIDEO_CLIP;
    document.body.insertBefore(video, document.body.firstChild);
    const canvasFallback = () => {
      if (video.dataset.labFallback === '1') return;
      video.dataset.labFallback = '1';
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext('2d');
      const draw = () => {
        const t = performance.now() / 1000;
        const grad = ctx.createLinearGradient(0, 0, 640, 360);
        grad.addColorStop(0, 'hsl(' + ((t * 24) % 360) + ', 80%, 34%)');
        grad.addColorStop(0.55, 'hsl(' + ((t * 24 + 120) % 360) + ', 72%, 22%)');
        grad.addColorStop(1, 'hsl(' + ((t * 24 + 240) % 360) + ', 82%, 40%)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 640, 360);
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(320 + Math.sin(t) * 160, 180 + Math.cos(t * 1.3) * 90, 90, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        requestAnimationFrame(draw);
      };
      draw();
      try {
        video.srcObject = canvas.captureStream(30);
        video.play().catch(() => {});
      } catch (err) {
        showError('Page video fallback failed: ' + err);
      }
    };
    video.addEventListener('playing', () => {
      window.__labVideoPlaying = true;
    });
    video.addEventListener('error', canvasFallback);
    window.setTimeout(() => {
      if (!window.__labVideoPlaying) canvasFallback();
    }, 1500);
    const attempt = video.play();
    if (attempt && typeof attempt.catch === 'function') attempt.catch(() => canvasFallback());
    return video;
  }

  function prepareCustomImage() {
    labLocal.data['spicy.bgImage'] = CUSTOM_IMAGE;
  }

  if (BG_STYLE === 'video') installPageVideo();
  if (BG_STYLE === 'image') prepareCustomImage();

  // ?debug=1: light-DOM readout of the effective background + video mirror.
  if (DEBUG) {
    const box = document.getElementById('lab-debug');
    if (box) {
      box.classList.add('is-on');
      window.setInterval(() => {
        const host = document.getElementById('spicy-lyrics');
        const root = host && host.shadowRoot;
        const bgRoot = root && root.querySelector('.sl-bg');
        const stage = root && root.querySelector('.sl-stage');
        const state = (SL.background.videoState && SL.background.videoState()) || {};
        const accent = stage ? getComputedStyle(stage).getPropertyValue('--sl-accent').trim() : '';
        const pv = document.querySelector('.lab-page-video');
        let pvText = 'none';
        if (pv) {
          const r = pv.getBoundingClientRect();
          pvText = [
            'paused=' + pv.paused,
            'rs=' + pv.readyState,
            'dim=' + pv.videoWidth + 'x' + pv.videoHeight,
            'rect=' + Math.round(r.width) + 'x' + Math.round(r.height),
            'errcode=' + (pv.error ? pv.error.code : 0),
            'src=' + (pv.currentSrc || pv.src || '').split('/').pop(),
          ].join(' ');
        }
        const diag = bgRoot
          ? ' ticks=' + (bgRoot.dataset.ticks || '0') +
            ' visible=' + (bgRoot.dataset.visible || '-') +
            ' mirror=' + (bgRoot.dataset.mirror || '-') +
            ' vActive=' + (bgRoot.dataset.videoActive || '-')
          : '';
        const stageRect = stage ? stage.getBoundingClientRect() : null;
        const stackEl = root && root.querySelector('.sl-stack');
        box.textContent =
          'bg=' + BG_STYLE +
          '  applied=' + ((bgRoot && bgRoot.dataset.style) || '-') +
          '  accent=' + (accent || '-') +
          '\nvideo found=' + !!state.found +
          ' playing=' + !!state.playing +
          ' mode=' + (state.mode || '-') +
          ' ' + (state.width || 0) + 'x' + (state.height || 0) +
          '\ndataset.spicyVideo=' + (document.documentElement.dataset.spicyVideo || '""') +
          '\npageVideo: ' + pvText +
          '\nstage=' + (stageRect ? Math.round(stageRect.width) + 'x' + Math.round(stageRect.height) + '@' + Math.round(stageRect.left) : '-') +
          ' stack=' + ((stackEl && stackEl.className) || '-') +
          ' col=' + ((root && root.querySelector('.sl-column') && Math.round(root.querySelector('.sl-column').clientWidth)) || '-') +
          ' fs=' + (stage ? getComputedStyle(stage).getPropertyValue('--sl-fs').trim() : '-');
      }, 250);
    }
  }

  // ---------------------------------------------------------------------------
  // Mount
  // ---------------------------------------------------------------------------
  const targetName = Q.get('target') || 'view';
  const target = () => {
    if (FULL) return document.documentElement;
    if (targetName === 'side') return document.getElementById('side');
    return document.getElementById('view');
  };

  SL.overlay.mount({
    target,
    onSeek: (positionMs) => {
      SL.store.localSeek(positionMs);
    },
    onClose: () => {
      SL.store.patch({ ui: { open: false, dismissed: true } });
    },
  });
  SL.store.patch({ ui: { open: true, dismissed: false } });

  // Headless virtual time can stop part-way through the open/crossfade
  // transitions, which makes screenshots non-deterministic. Once the shadow
  // root exists, neutralise transitions in the lab so a capture always shows
  // the settled state. (Animation keyframes still run; they are cosmetic.)
  let hushTimer = 0;
  hushTimer = window.setInterval(() => {
    const host = document.getElementById('spicy-lyrics');
    const root = host && host.shadowRoot;
    if (!root) return;
    const style = document.createElement('style');
    style.setAttribute('data-lab', 'hush');
    style.textContent = '*,*::before,*::after{transition:none !important;}';
    root.appendChild(style);
    window.clearInterval(hushTimer);
  }, 30);
  window.setTimeout(() => window.clearInterval(hushTimer), 5000);

  // ---------------------------------------------------------------------------
  // Keep the header awake for deterministic screenshots (headless has no mouse,
  // and the idle timer would otherwise fade it out after 3 seconds).
  // ---------------------------------------------------------------------------
  if (Q.get('idle') !== '1') {
    window.setInterval(() => {
      const host = document.getElementById('spicy-lyrics');
      const stage = host && host.shadowRoot && host.shadowRoot.querySelector('.sl-stage');
      if (stage) {
        stage.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
      }
    }, 700);
  }

  // Status pill demo (?status=text) — the app wires setStatus, the lab mirrors it.
  if (Q.has('status')) SL.overlay.setStatus(Q.get('status'));

  // Quick settings panel open state (?panel=1).
  if (Q.get('panel') === '1') {
    const openPanel = () => {
      const host = document.getElementById('spicy-lyrics');
      const root = host && host.shadowRoot;
      const panel = root && root.querySelector('.sl-panel');
      if (panel) SL.overlay.openSettings();
      else window.setTimeout(openPanel, 40);
    };
    window.setTimeout(openPanel, 120);
  }

  window.__lab = {
    mode: MODE,
    fixedT: FIXED_T,
    bg: BG_STYLE,
    store: SL.store,
    overlay: SL.overlay,
    SL,
    background: SL.background,
    videoState: () => (SL.background.videoState ? SL.background.videoState() : null),
  };
})();
