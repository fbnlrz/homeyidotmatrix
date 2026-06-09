'use strict';

const { GifReader, GifWriter } = require('omggif');

/**
 * Resize an animated GIF to `targetSize x targetSize` using nearest-neighbor
 * scaling (preserves pixel art crispness). Output stays an animated GIF with
 * the same frame count + per-frame delays as the input.
 *
 * @param {Buffer} input    GIF89a/GIF87a buffer
 * @param {number} targetSize  e.g. 32 — output is square
 * @returns {Buffer} new GIF buffer
 */
function resizeAnimatedGif(input, targetSize) {
  const reader = new GifReader(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
  const srcW = reader.width;
  const srcH = reader.height;
  const numFrames = reader.numFrames();

  // Decode every frame to RGBA (composited against the previous frames per
  // disposal method — omggif handles disposal via decodeAndBlitFrameRGBA when
  // called sequentially with the same pixel buffer reused).
  const fullRGBA = new Uint8Array(srcW * srcH * 4);
  const frames = [];
  for (let i = 0; i < numFrames; i++) {
    reader.decodeAndBlitFrameRGBA(i, fullRGBA);
    // Take a snapshot of the fully-composited canvas at this frame.
    frames.push({
      rgba: new Uint8Array(fullRGBA), // copy
      info: reader.frameInfo(i),
    });
  }

  // Nearest-neighbor scale each composited frame to targetSize.
  const scaled = frames.map(f => ({
    rgba: _nearestScaleRGBA(f.rgba, srcW, srcH, targetSize, targetSize),
    delay: f.info.delay, // hundredths of a second
  }));

  // Build a global palette by collecting unique colors across all scaled frames.
  // Cap at 256 entries (GIF limit). If more, quantize via simple bucket reduction.
  const palette = _buildGlobalPalette(scaled);

  // Convert each frame's RGBA to indexed pixels using the global palette.
  const indexedFrames = scaled.map(f => _rgbaToIndexed(f.rgba, palette));

  // Encode.
  const outBuf = new Uint8Array(Math.max(1024, targetSize * targetSize * frames.length * 2 + 4096));
  const writer = new GifWriter(outBuf, targetSize, targetSize, {
    palette,
    loop: 0, // loop forever
  });
  for (let i = 0; i < indexedFrames.length; i++) {
    writer.addFrame(0, 0, targetSize, targetSize, indexedFrames[i], {
      delay: scaled[i].delay,
      disposal: 2, // restore to background → clean frames, no leftover ghosting
    });
  }
  return Buffer.from(outBuf.slice(0, writer.end()));
}

function _nearestScaleRGBA(src, sw, sh, dw, dh) {
  const dst = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
      const si = (sy * sw + sx) * 4;
      const di = (y * dw + x) * 4;
      dst[di] = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = src[si + 3];
    }
  }
  return dst;
}

/**
 * Build a palette of up to 256 RGB entries (alpha ignored — transparent
 * pixels collapse to black). For pixel art with few colors this preserves
 * everything; for richer images we drop the least-frequent colors.
 *
 * Palette length MUST be a power of 2 for omggif (256, 128, 64, 32, 16, 8, 4, 2).
 */
function _buildGlobalPalette(frames) {
  const counts = new Map();
  for (const f of frames) {
    const rgba = f.rgba;
    for (let i = 0; i < rgba.length; i += 4) {
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const key = (r << 16) | (g << 8) | b;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  let colors = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
  if (colors.length > 256) colors = colors.slice(0, 256);
  // Pad up to next power of 2.
  let palSize = 2;
  while (palSize < colors.length) palSize *= 2;
  while (colors.length < palSize) colors.push(0);
  return colors;
}

function _rgbaToIndexed(rgba, palette) {
  // Build a quick lookup for the exact palette entries we have. Pixels that
  // exactly match get O(1) lookup; non-matches fall back to nearest-color search.
  const exact = new Map();
  for (let i = 0; i < palette.length; i++) exact.set(palette[i], i);
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    const hit = exact.get(key);
    if (hit !== undefined) {
      out[p] = hit;
      continue;
    }
    // Nearest color via Euclidean distance in RGB.
    let best = 0;
    let bestDist = Infinity;
    for (let j = 0; j < palette.length; j++) {
      const c = palette[j];
      const dr = ((c >> 16) & 0xff) - rgba[i];
      const dg = ((c >> 8) & 0xff) - rgba[i + 1];
      const db = (c & 0xff) - rgba[i + 2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestDist) { bestDist = d; best = j; }
    }
    out[p] = best;
  }
  return out;
}

module.exports = { resizeAnimatedGif };
