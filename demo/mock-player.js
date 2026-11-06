/**
 * Demo harness player.
 *
 * Simulates the Spotify web player: a clock, the now-playing bar testids, the
 * native lyrics page and the color-lyrics network request. The extension runs
 * unmodified against this page, so this file is the reference for what the
 * real observer has to read.
 */
(() => {
  'use strict';

  const TRACKS = [
    {
      id: '4cOdK2wGLETKBW3PvgPWqT',
      title: 'Neon Paralysis',
      artist: 'MIRA / Kaito Ren',
      album: 'Nightdrive',
      duration: 133000,
      cover: './fixtures/cover-1.png',
      lyrics: '../color-lyrics/v2/track/4cOdK2wGLETKBW3PvgPWqT?format=json&market=from_token&vocalRemoval=false&productType=web_player',
    },
    {
      id: '2Fxmhks0bxGSBdJ92vM42m',
      title: 'Glasshouse',
      artist: 'MIRA',
      album: 'Late Night Signal',
      duration: 74000,
      cover: './fixtures/cover-2.png',
      lyrics: '../color-lyrics/v2/track/2Fxmhks0bxGSBdJ92vM42m?format=json&market=from_token&vocalRemoval=false&productType=web_player',
    },
    {
      id: '0VjIjW4GlUZAMYd2vXMi3b',
      title: 'Paper Radio',
      artist: 'Kaito Ren',
      album: 'Glasshouse',
      duration: 96000,
      cover: './fixtures/cover-3.png',
      lyrics: '../color-lyrics/v2/track/0VjIjW4GlUZAMYd2vXMi3b?format=json&market=from_token&vocalRemoval=false&productType=web_player',
    },
  ];

  const $ = (id) => document.getElementById(id);
  const el = {
    npCover: $('np-cover'),
    npTitle: $('np-title'),
    npArtist: $('np-artist'),
    npAlbum: $('np-album'),
    heroCover: $('hero-cover'),
    heroTitle: $('hero-title'),
    heroSub: $('hero-sub'),
    rightbarCover: $('rightbar-cover'),
    rightbarTitle: $('rightbar-title'),
    rightbarArtist: $('rightbar-artist'),
    position: $('playback-position'),
    duration: $('playback-duration'),
    progress: $('progress-bar'),
    fill: $('progress-fill'),
    thumb: $('progress-thumb'),
    playpause: $('playpause'),
    home: $('home-view'),
    lyricsPage: $('lyrics-page'),
    lyricsContainer: $('lyrics-container'),
    lyricsTrackTitle: $('lyrics-track-title'),
    lyricsToggle: $('lyrics-toggle'),
    tracklist: $('tracklist'),
  };

  const state = {
    index: 0,
    pos: 0,
    playing: true,
    lyricsOpen: false,
    /** @type {Array<{start:number,end:number,text:string,el:HTMLElement}>} */
    lyricLines: [],
    activeLine: -1,
    lastTs: 0,
    lastTextAt: 0,
    lastPos: -1,
  };

  const track = () => TRACKS[state.index];

  // -------------------------------------------------------------------------
  // DOM writing
  // -------------------------------------------------------------------------
  function clockText(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  }

  function paintProgress(force) {
    const t = track();
    const ratio = Math.min(1, Math.max(0, state.pos / t.duration));
    el.fill.style.width = (ratio * 100).toFixed(3) + '%';
    el.thumb.style.left = (ratio * 100).toFixed(3) + '%';
    el.progress.setAttribute('aria-valuemax', String(t.duration));
    el.progress.setAttribute('aria-valuenow', String(Math.round(state.pos)));
    const now = performance.now();
    if (force || now - state.lastTextAt > 240 || Math.floor(state.pos / 1000) !== Math.floor(state.lastPos / 1000)) {
      el.position.textContent = clockText(state.pos);
      el.duration.textContent = clockText(t.duration);
      state.lastTextAt = now;
      state.lastPos = state.pos;
    }
  }

  function paintPlayState() {
    el.playpause.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
    el.playpause.textContent = state.playing ? '⏸' : '▶';
  }

  function paintNowPlaying() {
    const t = track();
    el.npCover.src = t.cover;
    el.npTitle.textContent = t.title;
    el.npTitle.setAttribute('href', '/track/' + t.id);
    el.npArtist.textContent = t.artist;
    el.npArtist.setAttribute('href', '/artist/' + encodeURIComponent(t.artist));
    el.npAlbum.textContent = t.album;
    el.heroCover.src = t.cover;
    el.heroTitle.textContent = t.album;
    el.heroSub.textContent = t.artist + ' · 3 songs';
    el.rightbarCover.src = t.cover;
    el.rightbarTitle.textContent = t.title;
    el.rightbarArtist.textContent = t.artist;
    el.lyricsTrackTitle.textContent = t.title;
    document.title = t.title + ' — song by ' + t.artist + ' | Spotify';
    for (const row of el.tracklist.querySelectorAll('.track-row')) {
      row.classList.toggle('is-playing', row.dataset.index === String(state.index));
    }
  }

  // -------------------------------------------------------------------------
  // Native lyrics (what the extension scrapes / sniffs)
  // -------------------------------------------------------------------------
  function requestLyrics(t) {
    // Real player does exactly this: a color-lyrics GET with platform headers.
    // The extension's main-world sniffer wraps fetch and captures the JSON.
    return fetch(t.lyrics, {
      headers: {
        'App-Platform': 'WebPlayer',
        Authorization: 'Bearer demo-token',
      },
      credentials: 'same-origin',
    })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
  }

  function buildLyricDom(payload) {
    el.lyricsContainer.textContent = '';
    state.lyricLines = [];
    state.activeLine = -1;
    if (!payload || !payload.lyrics || !payload.lyrics.lines) {
      const empty = document.createElement('div');
      empty.className = 'lyrics-empty';
      empty.textContent = 'Lyrics not available for this track.';
      el.lyricsContainer.appendChild(empty);
      return;
    }
    for (const line of payload.lyrics.lines) {
      const text = (line.words || '').trim();
      if (!text) continue;
      const start = Number(line.startTimeMs) || 0;
      const end = Number(line.endTimeMs) || 0;
      const node = document.createElement('div');
      node.setAttribute('data-testid', 'fullscreen-lyric');
      node.className = 'lyric-line';
      node.dataset.lineIndex = String(state.lyricLines.length);
      node.dataset.startMs = String(start);
      const span = document.createElement('span');
      span.textContent = text;
      node.appendChild(span);
      el.lyricsContainer.appendChild(node);
      state.lyricLines.push({ start, end, text, el: node });
    }
  }

  function paintActiveLyric() {
    if (!state.lyricsOpen || !state.lyricLines.length) return;
    const pos = state.pos;
    let idx = -1;
    for (let i = 0; i < state.lyricLines.length; i++) {
      if (state.lyricLines[i].start <= pos + 120) idx = i;
      else break;
    }
    if (idx === state.activeLine) return;
    state.activeLine = idx;
    state.lyricLines.forEach((line, i) => {
      const active = i === idx;
      line.el.classList.toggle('active', active);
      if (active) line.el.setAttribute('aria-current', 'true');
      else line.el.removeAttribute('aria-current');
      line.el.style.opacity = active ? '1' : '';
    });
    const line = state.lyricLines[idx];
    if (line) line.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // -------------------------------------------------------------------------
  // Clock
  // -------------------------------------------------------------------------
  function tick(ts) {
    const dt = state.lastTs ? Math.min(250, ts - state.lastTs) : 0;
    state.lastTs = ts;
    if (state.playing) {
      state.pos += dt;
      if (state.pos >= track().duration) {
        state.pos = 0;
      }
    }
    paintProgress(false);
    paintActiveLyric();
    requestAnimationFrame(tick);
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------
  function setTrack(index, opts = {}) {
    state.index = ((index % TRACKS.length) + TRACKS.length) % TRACKS.length;
    state.pos = opts.startAt || 0;
    state.activeLine = -1;
    paintNowPlaying();
    paintProgress(true);
    const t = track();
    const request = requestLyrics(t);
    request.then((payload) => {
      if (track().id !== t.id) return;
      if (state.lyricsOpen) buildLyricDom(payload);
      window.__spicyDemo.lastPayload = payload;
    });
  }

  function seekTo(ms) {
    state.pos = Math.max(0, Math.min(track().duration, ms));
    state.activeLine = -1;
    paintProgress(true);
    paintActiveLyric();
  }

  function togglePlay() {
    state.playing = !state.playing;
    paintPlayState();
  }

  function setLyricsOpen(open) {
    state.lyricsOpen = open;
    el.home.hidden = open;
    el.lyricsPage.hidden = !open;
    el.lyricsToggle.classList.toggle('is-active', open);
    if (open && !el.lyricsContainer.querySelector('[data-testid="fullscreen-lyric"]') && !el.lyricsContainer.textContent) {
      requestLyrics(track()).then((payload) => {
        if (state.lyricsOpen) buildLyricDom(payload);
        window.__spicyDemo.lastPayload = payload;
      });
    } else if (open) {
      state.activeLine = -1;
      paintActiveLyric();
    }
  }

  // Progress bar seeking (the extension also clicks this element).
  function seekFromEvent(ev) {
    const rect = el.progress.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    seekTo(ratio * track().duration);
  }
  el.progress.addEventListener('pointerdown', (ev) => {
    el.progress.setPointerCapture(ev.pointerId);
    seekFromEvent(ev);
  });
  el.progress.addEventListener('pointermove', (ev) => {
    if (ev.buttons & 1) seekFromEvent(ev);
  });
  el.progress.addEventListener('click', seekFromEvent);

  el.playpause.addEventListener('click', togglePlay);
  $('next').addEventListener('click', () => setTrack(state.index + 1));
  $('prev').addEventListener('click', () => setTrack(state.index - 1));
  el.lyricsToggle.addEventListener('click', () => setLyricsOpen(!state.lyricsOpen));

  // Tracklist rows
  TRACKS.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'track-row';
    row.dataset.index = String(i);
    row.innerHTML = '<span>' + (i + 1) + '</span><span class="t-title">' + t.title +
      '</span><span class="t-dur">' + clockText(t.duration) + '</span>';
    row.addEventListener('click', () => setTrack(i));
    el.tracklist.appendChild(row);
  });

  paintPlayState();
  setTrack(0);
  requestAnimationFrame(tick);

  // Public hooks used by tools/e2e.mjs.
  window.__spicyDemo = {
    setTrack,
    seekTo,
    togglePlay,
    setLyricsOpen,
    get state() {
      return { index: state.index, pos: state.pos, playing: state.playing, lyricsOpen: state.lyricsOpen, trackId: track().id };
    },
    lastPayload: null,
  };
})();
