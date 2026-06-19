'use strict';

const crypto = require('crypto');
const { Jimp } = require('jimp');
const { resizeAnimatedGif } = require('./gifResize');

const DEFAULT_CACHE_BYTES = 32 * 1024 * 1024;

/**
 * Detect GIF89a/GIF87a by magic bytes.
 */
function isGif(buf) {
  return buf.length >= 6
    && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46
    && buf[3] === 0x38 && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61;
}

/**
 * Unified pipeline that turns any input image (PNG, JPG, BMP, WEBP, GIF)
 * into something the iDotMatrix can render.
 *
 * Options:
 *   targetSize  — output square in pixels (16/32/64)
 *   fit         — 'contain' (letterbox preserving aspect ratio, default),
 *                 'cover' (crop-fill), 'stretch' (squash to square),
 *                 'center' (no resize, crop or pad from center — keeps
 *                  original pixels untouched, ideal for pre-made 32×32 art)
 *   background  — hex colour for letterbox padding and transparent areas
 *   dither      — Floyd-Steinberg quantization to a 16-color palette
 *                 (smaller PNGs, looks better for photos on coarse pixels)
 *
 * Results are cached by SHA-256(input + opts) with LRU eviction so flows
 * that re-show the same image are instant on subsequent runs.
 */
class ImagePipeline {

  constructor({ logger, cacheBytes = DEFAULT_CACHE_BYTES } = {}) {
    this.log = logger || (() => {});
    this.cacheBytes = cacheBytes;
    this.cache = new Map(); // insertion-ordered for LRU
    this.cacheBytesUsed = 0;
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Prepare a buffer for display.
   * @returns {{ kind: 'gif'|'png', buffer: Buffer, fromCache: boolean }}
   */
  async prepare(input, opts = {}) {
    const normalized = _normalizeOptions(opts);
    const key = this._cacheKey(input, normalized);
    const cached = this.cache.get(key);
    if (cached) {
      this.hits += 1;
      // LRU bump
      this.cache.delete(key);
      this.cache.set(key, cached);
      return { kind: cached.kind, buffer: cached.buffer, fromCache: true };
    }
    this.misses += 1;

    const gif = isGif(input);
    const buffer = gif
      ? await this._prepareGif(input, normalized)
      : await this._preparePng(input, normalized);
    const kind = gif ? 'gif' : 'png';
    this._cachePut(key, { kind, buffer });
    return { kind, buffer, fromCache: false };
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? this.hits / total : 0,
      entries: this.cache.size,
      bytes: this.cacheBytesUsed,
    };
  }

  clearCache() {
    this.cache.clear();
    this.cacheBytesUsed = 0;
  }

  async _preparePng(buf, opts) {
    const img = await Jimp.read(buf);
    const { targetSize, fit, background, dither } = opts;
    const bgRgb = _parseColor(background);
    const bgInt = _rgbaToInt(bgRgb.r, bgRgb.g, bgRgb.b, 255);

    // Composite the input over the background so transparent areas pick up the
    // chosen colour instead of becoming garbage on the device.
    const composited = new Jimp({ width: img.width, height: img.height, color: bgInt });
    composited.composite(img, 0, 0);

    let output;
    if (fit === 'stretch') {
      composited.resize({ w: targetSize, h: targetSize });
      output = composited;
    } else if (fit === 'cover') {
      const scale = targetSize / Math.min(composited.width, composited.height);
      composited.scale(scale);
      const x = Math.floor((composited.width - targetSize) / 2);
      const y = Math.floor((composited.height - targetSize) / 2);
      composited.crop({ x, y, w: targetSize, h: targetSize });
      output = composited;
    } else if (fit === 'center') {
      // No resize — pad or crop from centre. Best for pre-sized pixel art.
      output = new Jimp({ width: targetSize, height: targetSize, color: bgInt });
      const dx = Math.floor((targetSize - composited.width) / 2);
      const dy = Math.floor((targetSize - composited.height) / 2);
      output.composite(composited, dx, dy);
    } else { // 'contain'
      const scale = targetSize / Math.max(composited.width, composited.height);
      composited.scale(scale);
      output = new Jimp({ width: targetSize, height: targetSize, color: bgInt });
      const dx = Math.floor((targetSize - composited.width) / 2);
      const dy = Math.floor((targetSize - composited.height) / 2);
      output.composite(composited, dx, dy);
    }

    if (dither) {
      _floydSteinbergDither(output, 16);
    }

    return output.getBuffer('image/png', { colorType: 2, deflateLevel: 9 });
  }

  async _prepareGif(buf, opts) {
    const { targetSize, fit, background } = opts;
    return resizeAnimatedGif(buf, targetSize, { fit, background });
  }

  _cacheKey(buf, opts) {
    const h = crypto.createHash('sha256');
    h.update(buf);
    // Sort keys so { fit:'cover', targetSize:32 } and { targetSize:32, fit:'cover' }
    // produce the same hash — otherwise identical lookups miss the cache.
    h.update(JSON.stringify(opts, opts ? Object.keys(opts).sort() : undefined));
    return h.digest('hex');
  }

  _cachePut(key, value) {
    const size = value.buffer.length;
    while (this.cacheBytesUsed + size > this.cacheBytes && this.cache.size > 0) {
      const oldestKey = this.cache.keys().next().value;
      const oldest = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      this.cacheBytesUsed -= oldest.size;
    }
    this.cache.set(key, { kind: value.kind, buffer: value.buffer, size });
    this.cacheBytesUsed += size;
  }
}

function _normalizeOptions(o) {
  const targetSize = Math.max(8, Math.min(128, parseInt(o.targetSize, 10) || 32));
  const fit = ['contain', 'cover', 'stretch', 'center'].includes(o.fit) ? o.fit : 'contain';
  const background = _parseColor(o.background || '#000000');
  const dither = !!o.dither;
  return {
    targetSize,
    fit,
    background: `#${_hex2(background.r)}${_hex2(background.g)}${_hex2(background.b)}`,
    dither,
  };
}

function _hex2(n) {
  return Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0');
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

function _rgbaToInt(r, g, b, a) {
  return (((r & 0xff) << 24) | ((g & 0xff) << 16) | ((b & 0xff) << 8) | (a & 0xff)) >>> 0;
}

/**
 * Floyd-Steinberg dither to a uniform `levels^3` colour palette per channel.
 * `levels` is the number of quantization steps per channel (16 → 4096 colors
 * before reduction; visually equivalent to a 16-palette on a small display).
 */
function _floydSteinbergDither(img, levels) {
  const w = img.width;
  const h = img.height;
  const data = img.bitmap.data;
  const step = 255 / (levels - 1);
  // Work over an in-place error-diffusing pass.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const old = data[i + c];
        const newVal = Math.round(old / step) * step;
        const err = old - newVal;
        data[i + c] = _clamp(newVal);
        if (x + 1 < w) data[i + 4 + c] = _clamp(data[i + 4 + c] + err * 7 / 16);
        if (y + 1 < h) {
          if (x > 0) data[i - 4 + w * 4 + c] = _clamp(data[i - 4 + w * 4 + c] + err * 3 / 16);
          data[i + w * 4 + c] = _clamp(data[i + w * 4 + c] + err * 5 / 16);
          if (x + 1 < w) data[i + 4 + w * 4 + c] = _clamp(data[i + 4 + w * 4 + c] + err * 1 / 16);
        }
      }
    }
  }
}

function _clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

module.exports = { ImagePipeline, isGif };
