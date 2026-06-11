'use strict';

const { crc32 } = require('crc');

// On real hardware the iDotMatrix advertises the service as 0x00FA (not 0xFA00 —
// the characteristics inside are fa02/fa03 though). Confirmed via nRF Connect
// and Homey BLE discovery on firmware shipped with IDM-BC5C5F.
const SERVICE_SHORT_UUID = '00fa';
const WRITE_SHORT_UUID = 'fa02';
const NOTIFY_SHORT_UUID = 'fa03';
const NAME_PREFIX = 'IDM-';

// Kept for backwards compatibility with the discovery filter; the runtime
// connect path matches services by short UUID anyway.
const SERVICE_UUID = '000000fa00001000800000805f9b34fb';
const WRITE_CHAR_UUID = '0000fa0200001000800000805f9b34fb';
const NOTIFY_CHAR_UUID = '0000fa0300001000800000805f9b34fb';

const TEXT_SEPARATOR = Buffer.from([0x05, 0xff, 0xff, 0xff]);
const TEXT_BITMAP_WIDTH = 16;
const TEXT_BITMAP_HEIGHT = 32;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function buildScreenOn() {
  return Buffer.from([5, 0, 7, 1, 1]);
}

function buildScreenOff() {
  return Buffer.from([5, 0, 7, 1, 0]);
}

function buildFreeze(freeze = true) {
  return Buffer.from([4, 0, 3, freeze ? 1 : 0]);
}

function buildFlip(flip = true) {
  return Buffer.from([5, 0, 6, 128, flip ? 1 : 0]);
}

function buildBrightness(percent) {
  const v = clamp(Math.round(percent), 5, 100);
  return Buffer.from([5, 0, 4, 128, v]);
}

function buildSetTime(date = new Date()) {
  const year = date.getFullYear() % 100;
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const jsDow = date.getDay();
  const weekday = jsDow === 0 ? 7 : jsDow;
  return Buffer.from([
    11, 0, 1, 128,
    year, month, day, weekday,
    date.getHours(), date.getMinutes(), date.getSeconds(),
  ]);
}

function buildClock({ style = 0, visibleDate = true, hour24 = true, r = 255, g = 255, b = 255 } = {}) {
  const styleByte = (clamp(style, 0, 7))
    | (visibleDate ? 128 : 0)
    | (hour24 ? 64 : 0);
  return Buffer.from([
    8, 0, 6, 1,
    styleByte & 0xff,
    r & 0xff, g & 0xff, b & 0xff,
  ]);
}

function buildCountdown({ mode = 1, minutes = 0, seconds = 0 } = {}) {
  return Buffer.from([
    7, 0, 8, 128,
    clamp(mode, 0, 3),
    clamp(minutes, 0, 99),
    clamp(seconds, 0, 59),
  ]);
}

function buildChronograph(mode = 1) {
  return Buffer.from([5, 0, 9, 128, clamp(mode, 0, 3)]);
}

function buildScoreboard(a = 0, b = 0) {
  const ca = clamp(a, 0, 999);
  const cb = clamp(b, 0, 999);
  // big-endian 16-bit, then sent as [lo, hi] per Python impl
  return Buffer.from([
    8, 0, 10, 128,
    ca & 0xff, (ca >> 8) & 0xff,
    cb & 0xff, (cb >> 8) & 0xff,
  ]);
}

function buildDiyMode(mode = 1) {
  return Buffer.from([5, 0, 4, 1, mode & 0xff]);
}

/**
 * Fill entire display with a solid RGB color.
 * Opcode per python3-idotmatrix-library Fullscreen.setMode().
 */
function buildFullscreenColor(r, g, b) {
  return Buffer.from([7, 0, 2, 2, r & 0xff, g & 0xff, b & 0xff]);
}

/**
 * Trigger one of the device's 7 built-in animated effects.
 *   0 horizontal rainbow, 1 random color pixels on black,
 *   2 random white on changing bg, 3 vertical rainbow,
 *   4 diagonal rainbow ↗, 5 diagonal rainbow ↘, 6 random colored pixels.
 * `colors` is 2-7 RGB triples; some styles use only the first two.
 */
function buildEffect(style, colors = [[255, 0, 0], [0, 0, 255]]) {
  const rgbCount = clamp(colors.length, 2, 7);
  const length = 6 + rgbCount * 3;
  const out = Buffer.alloc(length + 1);
  out[0] = length;
  out[1] = 0;
  out[2] = 3;
  out[3] = 2;
  out[4] = clamp(style, 0, 6);
  out[5] = 90;
  out[6] = rgbCount;
  for (let i = 0; i < rgbCount; i++) {
    const c = colors[i] || [0, 0, 0];
    out[7 + i * 3 + 0] = c[0] & 0xff;
    out[7 + i * 3 + 1] = c[1] & 0xff;
    out[7 + i * 3 + 2] = c[2] & 0xff;
  }
  return out;
}

function buildReset() {
  return [
    Buffer.from([0x04, 0x00, 0x03, 0x80]),
    Buffer.from([0x05, 0x00, 0x04, 0x80, 0x50]),
  ];
}

function _splitChunks(buf, size) {
  const out = [];
  for (let i = 0; i < buf.length; i += size) {
    out.push(buf.subarray(i, i + size));
  }
  return out;
}

function _writeInt16LE(value) {
  const b = Buffer.alloc(2);
  b.writeInt16LE(value & 0xffff, 0);
  return b;
}

function _writeUInt32LE(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0, 0);
  return b;
}

/**
 * Builds a single concatenated PNG-upload buffer.
 * Mirrors derkalle4/python3-idotmatrix-library Image._createPayloads:
 *   header per chunk = idk(int16 LE) + [0,0, firstFlag(0|2)] + pngLen(int32 LE) + chunk
 */
function buildImagePayload(pngBuffer) {
  const chunks = _splitChunks(pngBuffer, 4096);
  const idk = pngBuffer.length + chunks.length;
  const idkBytes = _writeInt16LE(idk);
  const pngLenBytes = _writeUInt32LE(pngBuffer.length);
  const parts = [];
  chunks.forEach((chunk, i) => {
    parts.push(
      idkBytes,
      Buffer.from([0, 0, i > 0 ? 2 : 0]),
      pngLenBytes,
      chunk,
    );
  });
  return Buffer.concat(parts);
}

/**
 * Builds a sequence of GIF-upload chunks. One BLE write per chunk.
 * Mirrors python3-idotmatrix-library Gif._createPayloads:
 *   per chunk: 16-byte header with totalSize LE(2), flag, totalLen LE(4) at [5..9],
 *   crc32 LE(4) at [9..13], static tail [0,0,13]. Static [2..4]=[1,0,0].
 */
function buildGifChunks(gifBuffer) {
  const chunks = _splitChunks(gifBuffer, 4096);
  const totalLen = gifBuffer.length;
  const totalLenBuf = _writeUInt32LE(totalLen);
  const crc = crc32(gifBuffer);
  const crcBuf = _writeUInt32LE(crc);

  return chunks.map((chunk, i) => {
    const header = Buffer.alloc(16);
    // Static template per python3-idotmatrix-library Gif._createPayloads:
    //   [size_lo, size_hi, 1, 0, flag, len(4), crc(4), 5, 0, 13]
    header[2] = 1;
    header[3] = 0;
    header[4] = i > 0 ? 2 : 0;
    totalLenBuf.copy(header, 5);
    crcBuf.copy(header, 9);
    header[13] = 5;
    header[14] = 0;
    header[15] = 13;
    const chunkSize = header.length + chunk.length;
    header.writeUInt16LE(chunkSize & 0xffff, 0);
    return Buffer.concat([header, chunk]);
  });
}

/**
 * Convert a string of characters into the bitmap byte-stream the device expects.
 * Renders each char into a 16x32 monochrome bitmap using a built-in 8x16 font (doubled to 16x32),
 * then concatenates: separator + 64 bytes per char.
 *
 * The Python impl uses PIL+TTF for nicer fonts. We use a built-in pixel font so
 * the Homey app is self-contained. Supports ASCII printable range; non-printable falls back to space.
 */
function _renderTextBitmaps(text, font, { mirror = false } = {}) {
  const out = [];
  // For camera-mirror playback we keep the character ORDER intact and only
  // horizontally flip each character's bitmap. The mode swap (1↔2) in
  // buildText handles the scroll-direction half. The mirror then flips:
  //   - each glyph back to its normal shape, AND
  //   - the apparent scroll direction back to natural RTL/LTR.
  // Reversing the string here too would over-correct — viewers would see
  // HELLO arrive as O,L,L,E,H instead of H,E,L,L,O.
  const sequence = Array.from(text || '');
  for (const ch of sequence) {
    const code = ch.charCodeAt(0);
    const glyph = font[code] || font[32];
    const bitmap = Buffer.alloc((TEXT_BITMAP_WIDTH * TEXT_BITMAP_HEIGHT) / 8);
    // 8x16 glyph centered, scaled 2x to 16x32
    for (let gy = 0; gy < 16; gy++) {
      const row = glyph[gy] || 0;
      for (let gx = 0; gx < 8; gx++) {
        const on = (row >> (7 - gx)) & 1;
        if (!on) continue;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const x0 = gx * 2 + dx;
            const x = mirror ? (TEXT_BITMAP_WIDTH - 1 - x0) : x0;
            const y = gy * 2 + dy;
            const byteIdx = (y * (TEXT_BITMAP_WIDTH / 8)) + Math.floor(x / 8);
            bitmap[byteIdx] |= (1 << (x % 8));
          }
        }
      }
    }
    out.push(TEXT_SEPARATOR, bitmap);
  }
  return Buffer.concat(out);
}

function buildText(text, opts = {}) {
  const {
    mode = 1,         // 0..8 — see app.json
    speed = 95,       // 1..100
    colorMode = 1,    // 0=white, 1=RGB, 2-5=rainbow
    r = 255, g = 0, b = 0,
    bgMode = 0,
    bgR = 0, bgG = 0, bgB = 0,
    mirror = false,   // horizontally mirror for camera-mirror use cases
    font = require('./font8x16'),
  } = opts;

  const bitmaps = _renderTextBitmaps(text, font, { mirror });
  const numChars = (text || '').length;

  // When mirroring for a camera reflection, flip the horizontal scroll
  // direction too — otherwise marquee text that should scroll RTL in the
  // mirror view ends up scrolling LTR (appears to come in "from behind").
  // Modes 1 = marquee RTL, 2 = marquee LTR; vertical / non-scroll modes
  // (0, 3..8) are unaffected by horizontal mirroring.
  let effectiveMode = mode;
  if (mirror) {
    if (mode === 1) effectiveMode = 2;
    else if (mode === 2) effectiveMode = 1;
  }

  const meta = Buffer.alloc(15);
  meta.writeUInt16LE(numChars, 0);
  meta[2] = 0;
  meta[3] = 1;
  meta[4] = clamp(effectiveMode, 0, 8);
  meta[5] = clamp(speed, 1, 100);
  meta[6] = clamp(colorMode, 0, 5);
  meta[7] = r & 0xff; meta[8] = g & 0xff; meta[9] = b & 0xff;
  meta[10] = bgMode & 0xff;
  meta[11] = bgR & 0xff; meta[12] = bgG & 0xff; meta[13] = bgB & 0xff;
  meta[14] = 0;
  // Note: Python writes meta as 14 bytes after num_chars at [0..1]. We allocate 15 to
  // include the trailing null some firmwares expect; if your device misbehaves try slicing to 14.
  const metaPacked = meta.subarray(0, 14);

  const packet = Buffer.concat([metaPacked, bitmaps]);
  const header = Buffer.alloc(16);
  header[2] = 3; header[3] = 0; header[4] = 0;
  header.writeUInt32LE(packet.length, 5);
  header.writeUInt32LE(crc32(packet) >>> 0, 9);
  header[13] = 0; header[14] = 0; header[15] = 12;
  const total = header.length + packet.length;
  header.writeUInt16LE(total & 0xffff, 0);

  return Buffer.concat([header, packet]);
}

module.exports = {
  SERVICE_UUID,
  WRITE_CHAR_UUID,
  NOTIFY_CHAR_UUID,
  SERVICE_SHORT_UUID,
  WRITE_SHORT_UUID,
  NOTIFY_SHORT_UUID,
  NAME_PREFIX,
  buildScreenOn,
  buildScreenOff,
  buildFreeze,
  buildFlip,
  buildBrightness,
  buildSetTime,
  buildClock,
  buildCountdown,
  buildChronograph,
  buildScoreboard,
  buildDiyMode,
  buildFullscreenColor,
  buildEffect,
  buildReset,
  buildImagePayload,
  buildGifChunks,
  buildText,
};
