'use strict';

const { GifWriter } = require('omggif');

/**
 * Procedural animations rendered into animated GIFs at runtime. Each function
 * returns a Buffer ready for IDMProtocol.buildGifChunks() → device.showGif().
 *
 *   matrixRain     — falling green characters
 *   gameOfLife     — Conway's GoL with a colorful palette
 *   dvdBouncer     — the classic bouncing rectangle
 *   plasma         — sin-wave color blob
 *   starfield      — moving white pixels on black
 *   fireworks      — particle bursts
 *
 * Output palette is global, fitted to 64 colors; frame delays are 80–120 ms
 * for natural motion. All animations loop seamlessly.
 */

function _writeGif(frames, size, paletteColors, delayCs = 10) {
  // omggif requires a power-of-two palette
  let palSize = 2;
  while (palSize < paletteColors.length) palSize *= 2;
  while (paletteColors.length < palSize) paletteColors.push(0);
  // First palette entry is treated as the background.
  const outBuf = new Uint8Array(Math.max(2048, size * size * frames.length * 2 + 4096));
  const writer = new GifWriter(outBuf, size, size, {
    palette: paletteColors,
    loop: 0,
  });
  for (let i = 0; i < frames.length; i++) {
    writer.addFrame(0, 0, size, size, frames[i], { delay: delayCs, disposal: 2 });
  }
  return Buffer.from(outBuf.slice(0, writer.end()));
}

function _emptyFrame(size, paletteIndex = 0) {
  return new Uint8Array(size * size).fill(paletteIndex);
}

// -------- Matrix rain --------

function matrixRain(size = 32, frameCount = 16) {
  // Palette: black, dark green, mid green, bright green, white
  const palette = [0x000000, 0x003300, 0x008822, 0x00ff44, 0xddffdd];
  const frames = [];
  // Each column has a head position, and trails fade behind.
  const cols = size;
  const heads = Array.from({ length: cols }, () => Math.floor(Math.random() * size * 2) - size);
  const speeds = Array.from({ length: cols }, () => 0.5 + Math.random() * 1.0);
  for (let f = 0; f < frameCount; f++) {
    const frame = _emptyFrame(size, 0);
    for (let c = 0; c < cols; c++) {
      const head = Math.floor(heads[c]);
      for (let trail = 0; trail < 8; trail++) {
        const y = head - trail;
        if (y < 0 || y >= size) continue;
        let p;
        if (trail === 0) p = 4;           // white head
        else if (trail < 2) p = 3;        // bright green
        else if (trail < 5) p = 2;        // mid green
        else p = 1;                       // dark green
        frame[y * size + c] = p;
      }
      heads[c] += speeds[c];
      if (heads[c] - 8 > size) heads[c] = -Math.random() * 8;
    }
    frames.push(frame);
  }
  return _writeGif(frames, size, palette, 9);
}

// -------- Conway's Game of Life --------

function gameOfLife(size = 32, frameCount = 30) {
  const palette = [0x000000, 0x224488, 0x6688cc, 0xaaccff];
  let grid = new Uint8Array(size * size);
  // Random seed — ~30% alive
  for (let i = 0; i < grid.length; i++) grid[i] = Math.random() < 0.3 ? 1 : 0;
  const frames = [];
  for (let f = 0; f < frameCount; f++) {
    const frame = _emptyFrame(size, 0);
    for (let i = 0; i < grid.length; i++) if (grid[i]) {
      // Age-based palette: brighter for newer cells
      frame[i] = Math.min(3, 1 + (f & 2));
    }
    frames.push(frame);
    grid = _golStep(grid, size);
  }
  return _writeGif(frames, size, palette, 18);
}

function _golStep(g, size) {
  const out = new Uint8Array(g.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = (x + dx + size) % size;
          const ny = (y + dy + size) % size;
          n += g[ny * size + nx];
        }
      }
      const i = y * size + x;
      out[i] = (g[i] ? (n === 2 || n === 3) : (n === 3)) ? 1 : 0;
    }
  }
  return out;
}

// -------- DVD bouncer --------

function dvdBouncer(size = 32, frameCount = 60) {
  const palette = [0x000000, 0xff3366, 0x33ccff, 0xffcc00, 0x66ff66, 0xff66ff];
  const frames = [];
  const boxW = Math.max(8, size / 4);
  const boxH = Math.max(5, size / 5);
  let x = Math.floor(Math.random() * (size - boxW));
  let y = Math.floor(Math.random() * (size - boxH));
  let dx = 1, dy = 1;
  let colorIdx = 1;
  for (let f = 0; f < frameCount; f++) {
    const frame = _emptyFrame(size, 0);
    for (let r = 0; r < boxH; r++) {
      for (let c = 0; c < boxW; c++) {
        frame[(y + r) * size + (x + c)] = colorIdx;
      }
    }
    frames.push(frame);
    x += dx; y += dy;
    let bounced = false;
    if (x <= 0)              { x = 0;              dx = 1;  bounced = true; }
    if (y <= 0)              { y = 0;              dy = 1;  bounced = true; }
    if (x + boxW >= size)    { x = size - boxW;    dx = -1; bounced = true; }
    if (y + boxH >= size)    { y = size - boxH;    dy = -1; bounced = true; }
    if (bounced) colorIdx = 1 + ((colorIdx) % (palette.length - 1));
  }
  return _writeGif(frames, size, palette, 7);
}

// -------- Plasma --------

function plasma(size = 32, frameCount = 30) {
  // 16-step rainbow palette
  const palette = [];
  for (let i = 0; i < 16; i++) {
    const h = i / 16;
    palette.push(_hsv(h, 1, 1));
  }
  const frames = [];
  for (let f = 0; f < frameCount; f++) {
    const t = f / frameCount;
    const frame = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = Math.sin(x / 4 + t * 6.28) +
                  Math.sin(y / 3 - t * 6.28) +
                  Math.sin((x + y) / 5 + t * 12.56) +
                  Math.sin(Math.sqrt(x * x + y * y) / 4);
        const idx = Math.floor(((v + 4) / 8) * 15.999) & 15;
        frame[y * size + x] = idx;
      }
    }
    frames.push(frame);
  }
  return _writeGif(frames, size, palette, 8);
}

function _hsv(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return ((Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255)) >>> 0;
}

// -------- Starfield --------

function starfield(size = 32, frameCount = 24) {
  const palette = [0x000020, 0x444477, 0xaaaadd, 0xffffff];
  const stars = [];
  for (let i = 0; i < 40; i++) {
    stars.push({ x: Math.random() * size, y: Math.random() * size, z: Math.random() * 0.04 + 0.005 });
  }
  const frames = [];
  for (let f = 0; f < frameCount; f++) {
    const frame = _emptyFrame(size, 0);
    for (const s of stars) {
      s.x -= s.z * size;
      if (s.x < 0) { s.x = size; s.y = Math.random() * size; }
      const xi = Math.floor(s.x);
      const yi = Math.floor(s.y);
      const brightness = s.z > 0.03 ? 3 : s.z > 0.015 ? 2 : 1;
      if (xi >= 0 && xi < size && yi >= 0 && yi < size) {
        frame[yi * size + xi] = brightness;
      }
    }
    frames.push(frame);
  }
  return _writeGif(frames, size, palette, 7);
}

// -------- Fireworks --------

function fireworks(size = 32, frameCount = 36) {
  const palette = [
    0x000000, 0x222233, 0xff0000, 0xff8800, 0xffff00,
    0x88ff00, 0x00ff88, 0x0088ff, 0x4488ff, 0xff44cc,
  ];
  const particles = [];
  const frames = [];
  for (let f = 0; f < frameCount; f++) {
    // Spawn a burst every ~12 frames
    if (f % 12 === 0) {
      const cx = 4 + Math.random() * (size - 8);
      const cy = 4 + Math.random() * (size / 2);
      const color = 2 + Math.floor(Math.random() * 8);
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * 6.28;
        const speed = 0.6 + Math.random() * 0.5;
        particles.push({
          x: cx, y: cy,
          vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
          life: 12, color,
        });
      }
    }
    const frame = _emptyFrame(size, 0);
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      const xi = Math.floor(p.x);
      const yi = Math.floor(p.y);
      if (xi >= 0 && xi < size && yi >= 0 && yi < size) {
        frame[yi * size + xi] = p.color;
      }
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.08;     // gravity
      p.life -= 1;
      if (p.life <= 0) particles.splice(i, 1);
    }
    frames.push(frame);
  }
  return _writeGif(frames, size, palette, 6);
}

// -------- Progress bar --------

function progressBar(size, percent, fg = 0x00ff44, bg = 0x222222, frame = 0xffffff) {
  // Single-frame "GIF" with bar from 0% (left) to 100% (right)
  const palette = [bg, frame, fg];
  const f = new Uint8Array(size * size).fill(0);
  // Outer border (1 px)
  const top = Math.floor(size * 0.35);
  const bottom = Math.floor(size * 0.65);
  for (let x = 0; x < size; x++) {
    f[top * size + x] = 1;
    f[bottom * size + x] = 1;
  }
  for (let y = top; y <= bottom; y++) {
    f[y * size + 0] = 1;
    f[y * size + size - 1] = 1;
  }
  // Fill
  const fillWidth = Math.round((size - 2) * Math.max(0, Math.min(100, percent)) / 100);
  for (let y = top + 1; y < bottom; y++) {
    for (let x = 1; x <= fillWidth; x++) {
      f[y * size + x] = 2;
    }
  }
  return _writeGif([f], size, palette, 100);
}

// -------- Confetti (denser fireworks-like burst) --------

function confetti(size = 32, frameCount = 30) {
  const palette = [
    0x000000, 0xff3366, 0x33ccff, 0xffcc00, 0x66ff66,
    0xff66ff, 0x00ffff, 0xff8800, 0x8866ff, 0xffff44,
  ];
  const parts = [];
  // Initial big burst plus continuous fall
  for (let i = 0; i < 60; i++) {
    parts.push({
      x: 4 + Math.random() * (size - 8),
      y: -Math.random() * size * 0.5,
      vx: (Math.random() - 0.5) * 0.6,
      vy: 0.4 + Math.random() * 0.8,
      color: 1 + Math.floor(Math.random() * 9),
    });
  }
  const frames = [];
  for (let f = 0; f < frameCount; f++) {
    const frame = _emptyFrame(size, 0);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      const xi = Math.floor(p.x);
      const yi = Math.floor(p.y);
      if (xi >= 0 && xi < size && yi >= 0 && yi < size) {
        frame[yi * size + xi] = p.color;
      }
      p.x += p.vx;
      p.y += p.vy;
      p.vx += (Math.random() - 0.5) * 0.05;
      if (p.y > size + 2) {
        p.y = -1;
        p.x = Math.random() * size;
        p.vx = (Math.random() - 0.5) * 0.6;
        p.color = 1 + Math.floor(Math.random() * 9);
      }
    }
    frames.push(frame);
  }
  return _writeGif(frames, size, palette, 6);
}

// -------- Plasma palette variations --------

const PLASMA_PALETTES = {
  rainbow: null, // computed at runtime
  sunset:  [0x000033, 0x331a4d, 0x66264d, 0x99334d, 0xcc4d33, 0xff8033, 0xffb84d, 0xffe066, 0xffff99, 0xffffcc, 0xff66aa, 0xff3366, 0xcc1f4d, 0x661f33, 0x33001a, 0x000000],
  ocean:   [0x000022, 0x001144, 0x002266, 0x003388, 0x0044aa, 0x0066cc, 0x0088dd, 0x00aaee, 0x33ccff, 0x66ddff, 0x99eeff, 0xccf5ff, 0xffffff, 0xaaffcc, 0x66cc99, 0x003366],
  fire:    [0x000000, 0x110000, 0x220000, 0x440000, 0x660000, 0x881100, 0xaa2200, 0xcc3300, 0xee4400, 0xff6600, 0xff8822, 0xffaa44, 0xffcc66, 0xffee88, 0xffffaa, 0xffffcc],
  forest:  [0x001100, 0x002200, 0x003300, 0x114411, 0x225522, 0x336633, 0x447744, 0x558855, 0x669966, 0x77aa77, 0x88bb88, 0x99cc99, 0xaaddaa, 0xbbeebb, 0xccffcc, 0xddffdd],
};

function plasmaVariant(size = 32, frameCount = 30, variant = 'rainbow') {
  let palette;
  if (variant === 'rainbow' || !PLASMA_PALETTES[variant]) {
    palette = [];
    for (let i = 0; i < 16; i++) palette.push(_hsv(i / 16, 1, 1));
  } else {
    palette = PLASMA_PALETTES[variant].slice();
  }
  const frames = [];
  for (let f = 0; f < frameCount; f++) {
    const t = f / frameCount;
    const frame = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = Math.sin(x / 4 + t * 6.28) +
                  Math.sin(y / 3 - t * 6.28) +
                  Math.sin((x + y) / 5 + t * 12.56) +
                  Math.sin(Math.sqrt(x * x + y * y) / 4);
        frame[y * size + x] = Math.floor(((v + 4) / 8) * 15.999) & 15;
      }
    }
    frames.push(frame);
  }
  return _writeGif(frames, size, palette, 8);
}

// -------- Snake (auto-playing) --------

function snake(size = 32, frameCount = 60) {
  const palette = [0x000000, 0x00aa44, 0x00ff66, 0xff3333, 0x442222];
  let body = [{ x: size >> 1, y: size >> 1 }];
  let dir = { x: 1, y: 0 };
  const food = { x: 4 + Math.floor(Math.random() * (size - 8)), y: 4 + Math.floor(Math.random() * (size - 8)) };
  const frames = [];
  for (let f = 0; f < frameCount; f++) {
    // Steer toward food with simple greedy heuristic
    const head = body[0];
    if (head.x !== food.x && Math.random() < 0.5) dir = { x: Math.sign(food.x - head.x), y: 0 };
    else if (head.y !== food.y) dir = { x: 0, y: Math.sign(food.y - head.y) };
    const next = { x: (head.x + dir.x + size) % size, y: (head.y + dir.y + size) % size };
    body.unshift(next);
    if (next.x === food.x && next.y === food.y) {
      food.x = 2 + Math.floor(Math.random() * (size - 4));
      food.y = 2 + Math.floor(Math.random() * (size - 4));
    } else {
      body.pop();
    }
    const frame = _emptyFrame(size, 0);
    frame[food.y * size + food.x] = 3;
    for (let i = 0; i < body.length; i++) {
      const seg = body[i];
      frame[seg.y * size + seg.x] = i === 0 ? 2 : 1;
    }
    frames.push(frame);
  }
  return _writeGif(frames, size, palette, 9);
}

// -------- Pong (auto-playing) --------

function pong(size = 32, frameCount = 90) {
  const palette = [0x000000, 0xffffff, 0x444444];
  const padW = 2;
  const padH = 5;
  let ballX = size / 2, ballY = size / 2;
  let vx = 0.55, vy = 0.3;
  let pLY = (size - padH) / 2;
  let pRY = (size - padH) / 2;
  const frames = [];
  for (let f = 0; f < frameCount; f++) {
    ballX += vx;
    ballY += vy;
    if (ballY <= 0 || ballY >= size - 1) vy = -vy;
    // Pad collisions
    if (ballX <= padW + 1 && ballY >= pLY && ballY <= pLY + padH) vx = Math.abs(vx);
    if (ballX >= size - padW - 2 && ballY >= pRY && ballY <= pRY + padH) vx = -Math.abs(vx);
    if (ballX < 0) { ballX = size / 2; ballY = size / 2; vx = 0.55; }
    if (ballX > size) { ballX = size / 2; ballY = size / 2; vx = -0.55; }
    // Lazy AI tracks ball y
    pLY += Math.sign(ballY - (pLY + padH / 2)) * 0.4;
    pRY += Math.sign(ballY - (pRY + padH / 2)) * 0.4;
    pLY = Math.max(0, Math.min(size - padH, pLY));
    pRY = Math.max(0, Math.min(size - padH, pRY));
    const frame = _emptyFrame(size, 0);
    // Centerline
    for (let y = 0; y < size; y += 2) frame[y * size + (size >> 1)] = 2;
    // Pads
    for (let y = 0; y < padH; y++) {
      for (let x = 0; x < padW; x++) {
        frame[(Math.floor(pLY) + y) * size + x] = 1;
        frame[(Math.floor(pRY) + y) * size + (size - 1 - x)] = 1;
      }
    }
    // Ball
    const bx = Math.floor(ballX);
    const by = Math.floor(ballY);
    if (bx >= 0 && bx < size && by >= 0 && by < size) frame[by * size + bx] = 1;
    frames.push(frame);
  }
  return _writeGif(frames, size, palette, 6);
}

// -------- Day counter (single static frame) --------

function dayCounter(size, days, label, color = 0x00ff44, bg = 0x000000) {
  // Render "N\nlabel" as multi-line glyph blocks. We'll render via PNG path
  // outside this module — return a single-frame GIF here for consistency.
  // The number itself uses big segment-style digits.
  const palette = [bg, color, 0x444444];
  const frame = _emptyFrame(size, 0);
  const digits = String(days);
  const digitW = Math.floor((size - 2) / Math.max(1, digits.length));
  const digitH = Math.floor(size * 0.6);
  const y0 = Math.floor((size - digitH) / 2);
  // 7-segment style — each digit is `digitW × digitH`, simple block style.
  // For brevity render each digit as scaled-up font glyph.
  const FontGlyph = require('./font8x16');
  const xPad = Math.floor((size - digitW * digits.length) / 2);
  for (let i = 0; i < digits.length; i++) {
    const ch = digits[i];
    const glyph = FontGlyph.getGlyph ? FontGlyph.getGlyph(ch) : [0,0,0,0,0,0,0];
    const scale = Math.max(1, Math.floor(Math.min(digitW / 5, digitH / 7)));
    const x0 = xPad + i * digitW + Math.floor((digitW - 5 * scale) / 2);
    for (let r = 0; r < 7; r++) {
      const row = glyph[r] || 0;
      for (let c = 0; c < 5; c++) {
        if (!((row >> (4 - c)) & 1)) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const px = x0 + c * scale + dx;
            const py = y0 + r * scale + dy;
            if (px >= 0 && px < size && py >= 0 && py < size) frame[py * size + px] = 1;
          }
        }
      }
    }
  }
  return _writeGif([frame], size, palette, 100);
}

module.exports = {
  matrixRain,
  gameOfLife,
  dvdBouncer,
  plasma,
  starfield,
  fireworks,
  confetti,
  plasmaVariant,
  snake,
  pong,
  progressBar,
  dayCounter,
};
