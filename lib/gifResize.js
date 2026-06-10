'use strict';

const { GifReader, GifWriter } = require('omggif');

/**
 * Resize an animated GIF to `targetSize x targetSize` using nearest-neighbor
 * scaling (preserves pixel art crispness). Output stays an animated GIF with
 * the same frame count + per-frame delays as the input.
 *
 * Options:
 *   fit         — 'contain' (letterbox preserving aspect, default),
 *                 'cover' (crop-fill), 'stretch' (squash to square),
 *                 'center' (no resize, crop or pad from centre)
 *   background  — hex color used for transparent pixels and letterbox padding
 *                 (default '#000000')
 *
 * @param {Buffer} input         GIF89a/GIF87a buffer
 * @param {number} targetSize    output is targetSize × targetSize
 * @param {object} [opts]
 * @returns {Buffer}             new GIF buffer
 */
function resizeAnimatedGif(input, targetSize, opts = {}) {
  const fit = ['contain', 'cover', 'stretch', 'center'].includes(opts.fit) ? opts.fit : 'contain';
  const bg = _parseColor(opts.background || '#000000');
  const bgRgb = [bg.r, bg.g, bg.b];

  const reader = new GifReader(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
  const srcW = reader.width;
  const srcH = reader.height;
  const numFrames = reader.numFrames();

  // Decode every frame, composited against the running canvas so disposal
  // methods + transparency are honored. Pixels that ended up transparent in
  // the source get replaced with the background colour.
  const fullRGBA = new Uint8Array(srcW * srcH * 4);
  const frames = [];
  for (let i = 0; i < numFrames; i++) {
    reader.decodeAndBlitFrameRGBA(i, fullRGBA);
    const snapshot = new Uint8Array(fullRGBA);
    _flattenTransparency(snapshot, bgRgb);
    frames.push({ rgba: snapshot, info: reader.frameInfo(i) });
  }

  const scaled = frames.map(f => ({
    rgba: _fitRGBA(f.rgba, srcW, srcH, targetSize, fit, bgRgb),
    delay: f.info.delay,
  }));

  const palette = _buildGlobalPalette(scaled);
  const indexedFrames = scaled.map(f => _rgbaToIndexed(f.rgba, palette));

  const outBuf = new Uint8Array(Math.max(1024, targetSize * targetSize * frames.length * 2 + 4096));
  const writer = new GifWriter(outBuf, targetSize, targetSize, {
    palette,
    loop: 0,
  });
  for (let i = 0; i < indexedFrames.length; i++) {
    writer.addFrame(0, 0, targetSize, targetSize, indexedFrames[i], {
      delay: scaled[i].delay,
      disposal: 2,
    });
  }
  return Buffer.from(outBuf.slice(0, writer.end()));
}

/**
 * Resize/crop RGBA from (sw x sh) to (target x target) according to fit mode.
 * Nearest-neighbor in all paths — preserves pixel art crispness.
 */
function _fitRGBA(src, sw, sh, target, fit, bgRgb) {
  if (fit === 'stretch') {
    return _nearestScaleRGBA(src, sw, sh, target, target);
  }
  if (fit === 'center') {
    // No scaling — pad or crop centered.
    return _centerCropPad(src, sw, sh, target, bgRgb);
  }
  if (fit === 'cover') {
    // Scale so the smaller side equals target, then crop the larger axis.
    const scale = target / Math.min(sw, sh);
    const dw = Math.round(sw * scale);
    const dh = Math.round(sh * scale);
    const scaled = _nearestScaleRGBA(src, sw, sh, dw, dh);
    return _centerCropPad(scaled, dw, dh, target, bgRgb);
  }
  // contain (default): scale so the larger side equals target, then pad the smaller.
  const scale = target / Math.max(sw, sh);
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const scaled = _nearestScaleRGBA(src, sw, sh, dw, dh);
  return _centerCropPad(scaled, dw, dh, target, bgRgb);
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
 * Center the source inside a target×target canvas; crop or pad as needed.
 * Padding uses bgRgb.
 */
function _centerCropPad(src, sw, sh, target, bgRgb) {
  const dst = new Uint8Array(target * target * 4);
  for (let i = 0; i < dst.length; i += 4) {
    dst[i] = bgRgb[0]; dst[i + 1] = bgRgb[1]; dst[i + 2] = bgRgb[2]; dst[i + 3] = 255;
  }
  const offX = Math.floor((target - sw) / 2);
  const offY = Math.floor((target - sh) / 2);
  const x0 = Math.max(0, offX);
  const y0 = Math.max(0, offY);
  const x1 = Math.min(target, offX + sw);
  const y1 = Math.min(target, offY + sh);
  for (let y = y0; y < y1; y++) {
    const sy = y - offY;
    for (let x = x0; x < x1; x++) {
      const sx = x - offX;
      const si = (sy * sw + sx) * 4;
      const di = (y * target + x) * 4;
      dst[di] = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = src[si + 3];
    }
  }
  return dst;
}

function _flattenTransparency(rgba, bgRgb) {
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) {
      rgba[i] = bgRgb[0]; rgba[i + 1] = bgRgb[1]; rgba[i + 2] = bgRgb[2]; rgba[i + 3] = 255;
    }
  }
}

function _parseColor(input) {
  if (!input) return { r: 0, g: 0, b: 0 };
  let hex = String(input).replace(/^#/, '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (hex.length !== 6) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

/**
 * Build a palette of up to 256 RGB entries (alpha already flattened).
 * For palette-heavy inputs we drop the least-frequent colors.
 * omggif requires a power-of-two palette size (2, 4, 8, …, 256).
 */
function _buildGlobalPalette(frames) {
  const counts = new Map();
  for (const f of frames) {
    const rgba = f.rgba;
    for (let i = 0; i < rgba.length; i += 4) {
      const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  let colors = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
  if (colors.length > 256) colors = colors.slice(0, 256);
  let palSize = 2;
  while (palSize < colors.length) palSize *= 2;
  while (colors.length < palSize) colors.push(0);
  return colors;
}

function _rgbaToIndexed(rgba, palette) {
  const exact = new Map();
  for (let i = 0; i < palette.length; i++) exact.set(palette[i], i);
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    const hit = exact.get(key);
    if (hit !== undefined) { out[p] = hit; continue; }
    let best = 0, bestDist = Infinity;
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
