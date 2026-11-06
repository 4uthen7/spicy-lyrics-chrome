/**
 * Mock player for the 2026-build DOM shape (demo/index-real.html).
 *
 * Mirrors what docs/spotify-webplayer-notes.md verified about the current web
 * player: class-based main view, hidden range input for the seek position, svg
 * path play state, album-href title link (no track id in the DOM), and native
 * lyric lines that are marked active by a single unique class token.
 */
(() => {
  'use strict';

  const TRACKS = [
    {
      id: '4cOdK2wGLETKBW3PvgPWqT',
      title: 'Neon Paralysis',
      artists: ['MIRA', 'Kaito Ren'],
      albumId: '7C2z1VtFjq7Lm3Ck5Vw9Td',
      duration: 133000,
      cover: './fixtures/cover-1.png',
    },
    {
      id: '2Fxmhks0bxGSBdJ92vM42m',
      title: 'Glasshouse',
      artists: ['MIRA'],
      albumId: '3qQ9h3xgKkLm2Np1Rs4TuV',
      duration: 74000,
      cover: './fixtures/cover-2.png',
    },
    {
      id: '0VjIjW4GlUZAMYd2vXMi3b',
      title: 'Paper Radio',
      artists: ['Kaito Ren'],
      albumId: '5pL7w2eRnB4vKc8Yt1GhJm',
      duration: 96000,
      cover: './fixtures/cover-3.png',
    },
  ];

  const PAUSE_PATH =
    'M2.7 1a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7zm8 0a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7z';
  const PLAY_PATH =
    'M3 1.713a.7.7 0 0 1 1.05-.607l10.9 6.288a.7.7 0 0 1 0 1.212L4.05 15.894A.7.7 0 0 1 3 15.288V1.713z';

  const $ = (id) => document.getElementById(id);
  const el = {
    seekRange: $('seek-range'),
    bar: $('playback-progressbar'),
    barFill: $('progress-fill'),
    barThumb: $('progress-thumb'),
    barHandle: $('progress-handle'),
    progressBar: $('progress-bar'),
    position: $('playback-position'),
    duration: $('playback-duration'),
    playpause: $('playpause'),
    ppPath: $('pp-path'),
    home: $('home-view'),
    lyricsPage: $('lyrics-page'),
    lyricsContainer: $('lyrics-container'),
    lyricsTitle: $('lyrics-track-title'),
    lyricsToggle: $('lyrics-toggle'),
    tracklist: $('tracklist'),
    title: $('np-title'),
    artists: $('np-artists'),
    cover: $('np-cover'),
    heroCover: $('hero-cover'),
    heroTitle: $('hero-title'),
    heroSub: $('hero-sub'),
    rightbarCover: $('rightbar-cover'),
    rightbarTitle: $('rightbar-title'),
    rightbarArtist: $('rightbar-artist'),
  };

  const params = new URLSearchParams(location.search);
  const NO_DOM_TRACK = params.has('no-dom-track');

  const state = {
    index: 0,
    pos: 0,
    playing: true,
    lyricsOpen: false,
    lines: [],
    activeIdx: -1,
    lastTs: 0,
    lastSecond: -1,
    tokens: { active: 'active_' + Math.random().toString(36).slice(2, 10), passed: 'passed_' + Math.random().toString(36).slice(2, 10), upcoming: 'upcoming_' + Math.random().toString(36).slice(2, 10) },
  };

  const track = () => TRACKS[state.index];

  function clock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function paint(force) {
    const t = track();
    const ratio = Math.min(1, Math.max(0, state.pos / t.duration));
    // Hidden range input: the real position source in this build.
    el.seekRange.max = String(t.duration);
    el.seekRange.value = String(Math.round(state.pos));
    el.seekRange.setAttribute('aria-valuetext', clock(state.pos) + '/' + clock(t.duration));
    // Visual bar driven by the CSS custom property the player uses.
    el.progressBar.style.setProperty('--progress-bar-transform', (ratio * 100).toFixed(3) + '%');
    el.barFill.style.width = (ratio * 100).toFixed(3) + '%';
    el.barThumb.style.left = (ratio * 100).toFixed(3) + '%';
    el.barHandle.style.left = (ratio * 100).toFixed(3) + '%';
    el.position.setAttribute('data-test-position', String(Math.round(state.pos)));
    const second = Math.floor(state.pos / 1000);
    if (force || second !== state.lastSecond) {
      el.position.textContent = clock(state.pos);
      el.duration.textContent = clock(t.duration);
      state.lastSecond = second;
    }
  }

  function paintPlayState() {
    el.playpause.setAttribute('aria-label', state.playing ? '一時停止' : '再生');
    el.ppPath.setAttribute('d', state.playing ? PAUSE_PATH : PLAY_PATH);
    try {
      if (navigator.mediaSession) navigator.mediaSession.playbackState = state.playing ? 'playing' : 'paused';
    } catch {
      /* ignore */
    }
  }

  function publishMediaMetadata(t) {
    try {
      if (!navigator.mediaSession || typeof MediaMetadata !== 'function') return;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title,
        artist: t.artists.join(', '),
        album: 'Nightdrive',
        artwork: [{ src: new URL(t.cover, location.href).href, sizes: '640x640', type: 'image/png' }],
      });
    } catch {
      /* ignore */
    }
  }

  /**
   * ?no-dom-track=1 simulates a player-bar variant whose title/subtitle testids
   * are absent and whose document title is the shell title. Only MediaSession
   * metadata remains, which is exactly the real-world failure the fallback is
   * for.
   */
  function stripDomTrack() {
    if (!NO_DOM_TRACK) return;
    try {
      const widget = document.querySelector('[data-testid="now-playing-widget"]');
      if (widget) widget.removeAttribute('data-testid');
      const coverButton = document.querySelector('[data-testid="cover-art-button"]');
      if (coverButton) coverButton.removeAttribute('data-testid');
      el.cover.removeAttribute('data-testid');
      el.title.removeAttribute('data-testid');
      el.artists.removeAttribute('data-testid');
      for (const anchor of el.artists.querySelectorAll('a')) {
        anchor.removeAttribute('data-testid');
        anchor.removeAttribute('href');
      }
      const titleSpan = el.title.querySelector('[data-testid="context-item-info-title"]');
      if (titleSpan) titleSpan.removeAttribute('data-testid');
      document.title = 'Spotify - Web Player: Music for everyone';
    } catch {
      /* ignore */
    }
  }

  function paintTrack() {
    const t = track();
    el.title.setAttribute('href', '/album/' + t.albumId);
    const titleSpan = el.title.querySelector('[data-testid="context-item-info-title"]');
    if (titleSpan) titleSpan.textContent = t.title;
    el.artists.textContent = '';
    for (const artist of t.artists) {
      const a = document.createElement('a');
      a.href = '/artist/' + artist.toLowerCase().replace(/\s+/g, '-');
      a.setAttribute('data-testid', 'context-item-info-artist');
      a.textContent = artist;
      el.artists.appendChild(a);
    }
    el.cover.src = t.cover;
    el.heroCover.src = t.cover;
    el.heroTitle.textContent = 'Nightdrive';
    el.heroSub.textContent = t.artists.join(', ') + ' · 3 songs';
    el.rightbarCover.src = t.cover;
    el.rightbarTitle.textContent = t.title;
    el.rightbarArtist.textContent = t.artists.join(', ');
    el.lyricsTitle.textContent = t.title;
    document.title = t.title + ' — song by ' + t.artists.join(', ') + ' | Spotify';
    publishMediaMetadata(t);
    stripDomTrack();
    for (const row of el.tracklist.querySelectorAll('.track-row')) {
      row.classList.toggle('is-playing', row.dataset.index === String(state.index));
    }
  }

  function requestLyrics(t) {
    // Same request shape the real client makes (sniffer keyed on /color-lyrics/),
    // including the headers the extension can learn a bearer token from.
    return fetch('../color-lyrics/v2/track/' + t.id + '/image/' + encodeURIComponent('https://i.scdn.co/image/ab67616d00001e02demo') +
      '?format=json&vocalRemoval=false', {
      headers: {
        Authorization: 'Bearer demo-user-token',
        'App-Platform': 'WebPlayer',
        'Spotify-App-Version': '1.3.10.15.g21d156ee0039',
      },
      credentials: 'same-origin',
    })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
  }

  function buildLyrics(payload) {
    el.lyricsContainer.textContent = '';
    state.lines = [];
    state.activeIdx = -1;
    if (!payload || !payload.lyrics || !Array.isArray(payload.lyrics.lines)) {
      const empty = document.createElement('div');
      empty.className = 'lyricLine';
      empty.textContent = 'Lyrics not available for this track.';
      el.lyricsContainer.appendChild(empty);
      return;
    }
    for (const line of payload.lyrics.lines) {
      const text = (line.words || '').trim();
      if (!text) continue;
      const node = document.createElement('div');
      node.setAttribute('data-testid', 'lyrics-line');
      node.className = 'lyricLine';
      node.dataset.startMs = String(Number(line.startTimeMs) || 0);
      node.textContent = text;
      el.lyricsContainer.appendChild(node);
      state.lines.push({ start: Number(line.startTimeMs) || 0, el: node });
    }
  }

  function paintActive() {
    if (!state.lyricsOpen || !state.lines.length) return;
    let idx = -1;
    for (let i = 0; i < state.lines.length; i++) {
      if (state.lines[i].start <= state.pos + 120) idx = i;
      else break;
    }
    if (idx === state.activeIdx) return;
    state.activeIdx = idx;
    // Exactly one class token is unique to the active line, like the real build.
    state.lines.forEach((line, i) => {
      const tokens = ['actived'];
      if (i < idx) tokens.push('passeded');
      if (i > idx) tokens.push('upcominged');
      if (i === idx) tokens.push('selected'); // unique token
      line.el.className = 'lyricLine ' + tokens.join(' ');
      line.el.dataset.state = i === idx ? 'active' : i < idx ? 'passed' : 'upcoming';
      line.el.style.opacity = i === idx ? '1' : '';
    });
    const line = state.lines[idx];
    if (line) line.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function tick(ts) {
    const dt = state.lastTs ? Math.min(250, ts - state.lastTs) : 0;
    state.lastTs = ts;
    if (state.playing) {
      state.pos += dt;
      if (state.pos >= track().duration) state.pos = 0;
    }
    paint(false);
    paintActive();
    requestAnimationFrame(tick);
  }

  function setTrack(index, opts = {}) {
    state.index = ((index % TRACKS.length) + TRACKS.length) % TRACKS.length;
    state.pos = opts.startAt || 0;
    state.activeIdx = -1;
    paintTrack();
    paint(true);
    const t = track();
    requestLyrics(t).then((payload) => {
      if (track().id !== t.id) return;
      if (state.lyricsOpen) buildLyrics(payload);
      window.__spicyDemo.lastPayload = payload;
    });
  }

  function seekTo(ms) {
    state.pos = Math.max(0, Math.min(track().duration, ms));
    state.activeIdx = -1;
    paint(true);
    paintActive();
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
    el.lyricsToggle.setAttribute('aria-pressed', open ? 'true' : 'false');
    if (open) {
      requestLyrics(track()).then((payload) => {
        if (!state.lyricsOpen) return;
        if (!el.lyricsContainer.querySelector('[data-testid="lyrics-line"]')) buildLyrics(payload);
        window.__spicyDemo.lastPayload = payload;
        state.activeIdx = -1;
        paintActive();
      });
    }
  }

  function seekFromEvent(ev) {
    const rect = el.bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    seekTo(ratio * track().duration);
  }
  el.bar.addEventListener('pointerdown', (ev) => {
    try {
      el.bar.setPointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    seekFromEvent(ev);
  });
  el.bar.addEventListener('pointermove', (ev) => {
    if (ev.buttons & 1) seekFromEvent(ev);
  });
  el.bar.addEventListener('click', seekFromEvent);
  el.seekRange.addEventListener('input', () => seekTo(Number(el.seekRange.value)));

  el.playpause.addEventListener('click', togglePlay);
  $('prev').addEventListener('click', () => setTrack(state.index - 1));
  $('next').addEventListener('click', () => setTrack(state.index + 1));
  el.lyricsToggle.addEventListener('click', () => setLyricsOpen(!state.lyricsOpen));

  TRACKS.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'track-row';
    row.dataset.index = String(i);
    row.innerHTML = '<span>' + (i + 1) + '</span><span class="t-title">' + t.title + '</span><span>' + clock(t.duration) + '</span>';
    row.addEventListener('click', () => setTrack(i));
    el.tracklist.appendChild(row);
  });

  paintPlayState();
  setTrack(0);
  requestAnimationFrame(tick);

  window.__spicyDemo = {
    setTrack,
    seekTo,
    togglePlay,
    setLyricsOpen,
    lastPayload: null,
    get state() {
      return {
        index: state.index,
        pos: state.pos,
        playing: state.playing,
        lyricsOpen: state.lyricsOpen,
        trackId: track().id,
        activeIdx: state.activeIdx,
      };
    },
  };
})();
