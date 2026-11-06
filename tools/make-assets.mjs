#!/usr/bin/env node
/**
 * Generates the extension icons and the demo album covers as real PNGs.
 * No dependencies: a minimal RGB(A) PNG encoder over node:zlib.
 *
 *   node tools/make-assets.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Tiny raster helpers
// ---------------------------------------------------------------------------
function canvas(w, h) {
  const buf = Buffer.alloc(w * h * 3);
  return {
    w,
    h,
    buf,
    set(x, y, r, g, b, a = 1) {
      x = Math.round(x);
      y = Math.round(y);
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = (y * w + x) * 3;
      buf[i] = Math.round(buf[i] + (r - buf[i]) * a);
      buf[i + 1] = Math.round(buf[i + 1] + (g - buf[i + 1]) * a);
      buf[i + 2] = Math.round(buf[i + 2] + (b - buf[i + 2]) * a);
    },
    blend(x, y, color, a) {
      this.set(x, y, color[0], color[1], color[2], a);
    },
    fill(color) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) this.set(x, y, color[0], color[1], color[2], 1);
    },
    disc(cx, cy, radius, color, alpha = 1, feather = 1.5) {
      const r2 = radius * radius;
      const x0 = Math.max(0, Math.floor(cx - radius - feather));
      const x1 = Math.min(w - 1, Math.ceil(cx + radius + feather));
      const y0 = Math.max(0, Math.floor(cy - radius - feather));
      const y1 = Math.min(h - 1, Math.ceil(cy + radius + feather));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const d = Math.hypot(x - cx, y - cy);
          if (d > radius + feather) continue;
          const a = alpha * Math.min(1, Math.max(0, (radius + feather - d) / feather));
          if (a > 0) this.blend(x, y, color, a);
        }
      }
    },
    // Rounded rectangle coverage via signed distance.
    roundRect(x0, y0, ww, hh, radius, color, alpha = 1) {
      const cx = x0 + ww / 2;
      const cy = y0 + hh / 2;
      const hx = ww / 2 - radius;
      const hy = hh / 2 - radius;
      for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, Math.ceil(y0 + hh)); y++) {
        for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x0 + ww)); x++) {
          const dx = Math.abs(x - cx) - hx;
          const dy = Math.abs(y - cy) - hy;
          const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
          const d = outside + Math.min(Math.max(dx, dy), 0) - radius;
          if (d < 0.5) this.blend(x, y, color, alpha * Math.min(1, 0.5 - d));
        }
      }
    },
  };
}

function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255];
}

// Deterministic PRNG so regenerated assets are byte-identical.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Icons: rounded-square gradient with a 5-bar equalizer glyph
// ---------------------------------------------------------------------------
function makeIcon(size) {
  const c = canvas(size, size);
  const r = size * 0.22;
  // Diagonal gradient background (spicy orange -> hot pink -> violet).
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = (x / size) * 0.55 + (y / size) * 0.45;
      const col = t < 0.5 ? hsl(18 + t * 30, 0.95, 0.6 - t * 0.1) : hsl(330 + (t - 0.5) * 60, 0.9, 0.55 - (t - 0.5) * 0.1);
      c.set(x, y, col[0], col[1], col[2], 1);
    }
  }
  // Soft highlight blob top-left.
  c.disc(size * 0.32, size * 0.26, size * 0.42, [255, 255, 255], 0.22, size * 0.22);
  // Mask to rounded square.
  const masked = canvas(size, size);
  const rr = (x, y) => {
    const cx = size / 2, cy = size / 2;
    const hx = size / 2 - r, hy = size / 2 - r;
    const dx = Math.abs(x + 0.5 - cx) - hx;
    const dy = Math.abs(y + 0.5 - cy) - hy;
    const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
    return outside + Math.min(Math.max(dx, dy), 0) - r;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = rr(x, y);
      if (d < 0.5) {
        const a = Math.min(1, 0.5 - d);
        const i = (y * size + x) * 3;
        masked.set(x, y, c.buf[i], c.buf[i + 1], c.buf[i + 2], a);
      }
    }
  }
  // Equalizer bars.
  const bars = [0.34, 0.58, 0.82, 0.5, 0.28];
  const barW = Math.max(2, size * 0.1);
  const gap = size * 0.055;
  const total = bars.length * barW + (bars.length - 1) * gap;
  let bx = (size - total) / 2;
  const baseY = size * 0.5;
  for (const frac of bars) {
    const h = size * 0.52 * frac;
    masked.roundRect(bx, baseY - h / 2, barW, h, barW / 2, [255, 255, 255], 0.96);
    bx += barW + gap;
  }
  return encodePng(size, size, masked.buf);
}

// ---------------------------------------------------------------------------
// Demo covers: abstract "album art" so the background palette extraction has
// something real to work with.
// ---------------------------------------------------------------------------
function makeCover(size, seed, hueBase) {
  const c = canvas(size, size);
  const rand = rng(seed);

  // Vertical duotone base.
  for (let y = 0; y < size; y++) {
    const t = y / size;
    const top = hsl(hueBase, 0.62, 0.12);
    const bot = hsl(hueBase + 40, 0.7, 0.3);
    for (let x = 0; x < size; x++) {
      c.set(x, y, top[0] + (bot[0] - top[0]) * t, top[1] + (bot[1] - top[1]) * t, top[2] + (bot[2] - top[2]) * t, 1);
    }
  }

  // Hard-edged colour fields: big discs with tight feather.
  for (let i = 0; i < 3; i++) {
    const col = hsl(hueBase + 30 + i * 28 + rand() * 18, 0.85, 0.3 + i * 0.12 + rand() * 0.08);
    c.disc(size * (0.18 + rand() * 0.64), size * (0.15 + rand() * 0.6), size * (0.1 + rand() * 0.22), col, 0.88, 1.2);
  }

  // Rotated square plate for structure.
  {
    const a = rand() * 0.8 + 0.2;
    const side = size * (0.26 + rand() * 0.22);
    const cx = size * (0.3 + rand() * 0.4);
    const cy = size * (0.3 + rand() * 0.4);
    const col = hsl(hueBase + 180 + rand() * 40, 0.7, 0.55);
    const cos = Math.cos(a), sin = Math.sin(a);
    for (let v = -side; v <= side; v++) {
      for (let u = -side; u <= side; u++) {
        const px = cx + u * cos - v * sin;
        const py = cy + u * sin + v * cos;
        if (Math.abs(u) < side / 2 && Math.abs(v) < side / 2) c.set(px, py, col[0], col[1], col[2], 0.7);
      }
    }
  }

  // Fine horizontal light streaks.
  for (let i = 0; i < 70; i++) {
    const y = rand() * size;
    const h = size * (0.002 + rand() * 0.01);
    const col = hsl(hueBase + 200 + rand() * 70, 0.4, 0.82);
    for (let yy = y; yy < Math.min(size, y + h); yy++) {
      for (let x = 0; x < size; x++) c.set(x, yy, col[0], col[1], col[2], 0.07);
    }
  }

  // Grain.
  for (let i = 0; i < size * size * 0.06; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const v = rand() > 0.5 ? 255 : 0;
    c.set(x, y, v, v, v, 0.045);
  }

  // Bottom shade + vignette for contrast under lyrics.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const bottom = Math.max(0, (y / size - 0.55) / 0.45);
      const radial = Math.hypot(x - size / 2, y - size / 2) / (size * 0.7);
      const shade = Math.min(0.85, bottom * 0.5 + Math.max(0, (radial - 0.6)) * 0.85);
      if (shade > 0) c.set(x, y, 0, 0, 0, shade);
    }
  }
  return encodePng(size, size, c.buf);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------
const iconsDir = join(root, 'assets/icons');
const fixtureDir = join(root, 'demo/fixtures');
mkdirSync(iconsDir, { recursive: true });
mkdirSync(fixtureDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(iconsDir, `icon-${size}.png`), makeIcon(size));
}
writeFileSync(join(fixtureDir, 'cover-1.png'), makeCover(640, 1337, 12));
writeFileSync(join(fixtureDir, 'cover-2.png'), makeCover(640, 20260214, 208));
writeFileSync(join(fixtureDir, 'cover-3.png'), makeCover(640, 424242, 285));

console.log('wrote icons:', [16, 32, 48, 128].join(', '));
console.log('wrote covers: cover-1.png cover-2.png cover-3.png');
