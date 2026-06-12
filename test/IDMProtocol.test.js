'use strict';

/**
 * Byte-level fixtures derived from the python3-idotmatrix-library source.
 * Each `buildXxx` opcode here was cross-checked against the original
 * bytearray([…]) literal in that repo. If the device firmware ever
 * changes an opcode, these are the first place to update.
 *
 * Run with: node test/IDMProtocol.test.js
 */

const P = require('../lib/IDMProtocol');

let passed = 0;
let failed = 0;

function eq(label, got, want) {
  const g = Buffer.isBuffer(got) ? got.toString('hex') : String(got);
  const w = Buffer.isBuffer(want) ? want.toString('hex') : String(want);
  if (g === w) {
    passed++;
    console.log('  ok  ', label);
  } else {
    failed++;
    console.log('  FAIL', label);
    console.log('       got: ', g);
    console.log('       want:', w);
  }
}

function approx(label, cond, detail) {
  if (cond) { passed++; console.log('  ok  ', label); }
  else { failed++; console.log('  FAIL', label, detail || ''); }
}

console.log('IDMProtocol — opcode fixtures (vs python3-idotmatrix-library)');

eq('screenOn',            P.buildScreenOn(),                          Buffer.from([5, 0, 7, 1, 1]));
eq('screenOff',           P.buildScreenOff(),                         Buffer.from([5, 0, 7, 1, 0]));
eq('freeze',              P.buildFreeze(true),                        Buffer.from([4, 0, 3, 1]));
eq('unfreeze',            P.buildFreeze(false),                       Buffer.from([4, 0, 3, 0]));
eq('flip true',           P.buildFlip(true),                          Buffer.from([5, 0, 6, 128, 1]));
eq('flip false',          P.buildFlip(false),                         Buffer.from([5, 0, 6, 128, 0]));
eq('brightness 5',        P.buildBrightness(5),                       Buffer.from([5, 0, 4, 128, 5]));
eq('brightness 50',       P.buildBrightness(50),                      Buffer.from([5, 0, 4, 128, 50]));
eq('brightness 100',      P.buildBrightness(100),                     Buffer.from([5, 0, 4, 128, 100]));
eq('brightness clamp <5', P.buildBrightness(0),                       Buffer.from([5, 0, 4, 128, 5]));
eq('brightness clamp>100',P.buildBrightness(255),                     Buffer.from([5, 0, 4, 128, 100]));
eq('chrono reset',        P.buildChronograph(0),                      Buffer.from([5, 0, 9, 128, 0]));
eq('chrono start',        P.buildChronograph(1),                      Buffer.from([5, 0, 9, 128, 1]));
eq('countdown disable',   P.buildCountdown({ mode: 0, minutes: 0, seconds: 0 }),
                          Buffer.from([7, 0, 8, 128, 0, 0, 0]));
eq('countdown 5m 30s',    P.buildCountdown({ mode: 1, minutes: 5, seconds: 30 }),
                          Buffer.from([7, 0, 8, 128, 1, 5, 30]));
eq('scoreboard 0:0',      P.buildScoreboard(0, 0),                    Buffer.from([8, 0, 10, 128, 0, 0, 0, 0]));
eq('scoreboard 12:34',    P.buildScoreboard(12, 34),                  Buffer.from([8, 0, 10, 128, 12, 0, 34, 0]));
eq('scoreboard 999:999',  P.buildScoreboard(999, 999),                Buffer.from([8, 0, 10, 128, 0xe7, 0x03, 0xe7, 0x03]));
eq('scoreboard clamp neg',P.buildScoreboard(-5, 1500),                Buffer.from([8, 0, 10, 128, 0, 0, 0xe7, 0x03]));
eq('diy mode 1',          P.buildDiyMode(1),                          Buffer.from([5, 0, 4, 1, 1]));

// Clock: byte 4 = style | (date<<7) | (hour24<<6)
eq('clock style 1 date+24h+RGB',
   P.buildClock({ style: 1, visibleDate: true, hour24: true, r: 255, g: 0, b: 128 }),
   Buffer.from([8, 0, 6, 1, 1 | 128 | 64, 0xff, 0x00, 0x80]));
eq('clock style 0 nodate 12h',
   P.buildClock({ style: 0, visibleDate: false, hour24: false, r: 255, g: 255, b: 255 }),
   Buffer.from([8, 0, 6, 1, 0, 0xff, 0xff, 0xff]));

// SetTime — JS getDay() Sun=0 → 7, others unchanged; python uses weekday() Mon=0 +1
{
  const d = new Date(2026, 5, 9, 18, 47, 2); // Tue
  eq('setTime 2026-06-09 18:47:02 Tue',
     P.buildSetTime(d),
     Buffer.from([11, 0, 1, 128, 26, 6, 9, 2, 18, 47, 2]));
}

// Reset is a 2-buffer sequence
const reset = P.buildReset();
approx('reset → 2 buffers', Array.isArray(reset) && reset.length === 2);
eq('reset[0]', reset[0], Buffer.from('04000380', 'hex'));
eq('reset[1]', reset[1], Buffer.from('0500048050', 'hex'));

// Image payload header (small PNG):
//   idkBytes(2) + [0,0,0] + pngLenBytes(4) + chunkBytes
{
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // 16-byte fake PNG header
  const payload = P.buildImagePayload(png);
  approx('image payload total length', payload.length === 2 + 3 + 4 + png.length);
  // First 2 bytes = idk = pngLen + chunkCount = 16 + 1 = 17 (LE)
  eq('image idk bytes', payload.subarray(0, 2), Buffer.from([0x11, 0x00]));
  // Bytes 2..5 = [0, 0, 0]
  eq('image first-chunk flag', payload.subarray(2, 5), Buffer.from([0, 0, 0]));
  // Bytes 5..9 = png length (LE 32-bit)
  eq('image png length', payload.subarray(5, 9), Buffer.from([0x10, 0x00, 0x00, 0x00]));
}

// GIF chunk header layout (single small chunk):
//   [size_lo, size_hi, 1, 0, flag, len(4), crc(4), 5, 0, 13]
{
  const gif = Buffer.from('474946383961' + '00'.repeat(10), 'hex'); // 16 bytes
  const chunks = P.buildGifChunks(gif);
  approx('gif single chunk', chunks.length === 1);
  const c = chunks[0];
  approx('gif chunk size byte', c[0] === (16 + 16) & 0xff && c[1] === 0,
    `got [${c[0]},${c[1]}]`);
  eq('gif static [2..5]', c.subarray(2, 5), Buffer.from([1, 0, 0])); // flag=0 first chunk
  eq('gif total len bytes', c.subarray(5, 9), Buffer.from([0x10, 0, 0, 0]));
  // Bytes 13..16 = static [5, 0, 13]
  eq('gif tail bytes', c.subarray(13, 16), Buffer.from([5, 0, 13]));
}

// Fullscreen color opcode (python: bytearray([7, 0, 2, 2, r, g, b]))
eq('fullscreen red',   P.buildFullscreenColor(255, 0, 0),   Buffer.from([7, 0, 2, 2, 255, 0, 0]));
eq('fullscreen black', P.buildFullscreenColor(0, 0, 0),     Buffer.from([7, 0, 2, 2, 0, 0, 0]));

// Effect opcode (python: bytearray([length, 0, 3, 2, style, 90, rgb_count, ...rgb]))
{
  const e = P.buildEffect(0, [[255, 0, 0], [0, 0, 255]]);
  eq('effect rainbow 2 colors', e,
     Buffer.from([12, 0, 3, 2, 0, 90, 2, 255, 0, 0, 0, 0, 255]));
}
{
  const e = P.buildEffect(6, [[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
  eq('effect 3 colors', e,
     Buffer.from([15, 0, 3, 2, 6, 90, 3, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
}

// Text packet header layout
{
  const txt = P.buildText('A', { r: 255, g: 0, b: 0 });
  approx('text packet ≥ 16 byte header', txt.length > 16);
  // Bytes [2..5] = [3, 0, 0]
  eq('text header static', txt.subarray(2, 5), Buffer.from([3, 0, 0]));
  // Tail bytes [13..16] = [0, 0, 12]
  eq('text header tail', txt.subarray(13, 16), Buffer.from([0, 0, 12]));
}

// Mirror flips horizontal scroll direction so the camera reflection reads
// in the natural direction. meta byte 4 (after 16-byte header + 2 num_chars
// + 2 static) carries the mode.
{
  const MODE_OFFSET = 16 + 2 + 2;
  const m1 = P.buildText('A', { mode: 1, mirror: false });
  const m1m = P.buildText('A', { mode: 1, mirror: true });
  const m2m = P.buildText('A', { mode: 2, mirror: true });
  const m3m = P.buildText('A', { mode: 3, mirror: true });
  eq('mode 1 no-mirror keeps 1', Buffer.from([m1[MODE_OFFSET]]), Buffer.from([1]));
  eq('mode 1 mirrored → 2', Buffer.from([m1m[MODE_OFFSET]]), Buffer.from([2]));
  eq('mode 2 mirrored → 1', Buffer.from([m2m[MODE_OFFSET]]), Buffer.from([1]));
  eq('mode 3 mirrored stays 3', Buffer.from([m3m[MODE_OFFSET]]), Buffer.from([3]));
}

// ---- Input validation edge cases ---------------------------------------------

function throws(label, fn) {
  try { fn(); failed++; console.log('  FAIL', label, '(expected throw)'); }
  catch (_) { passed++; console.log('  ok  ', label); }
}

throws('buildText rejects > MAX_TEXT_CHARS', () => P.buildText('A'.repeat(P.MAX_TEXT_CHARS + 1)));
throws('buildImagePayload rejects non-Buffer', () => P.buildImagePayload('not a buffer'));
throws('buildImagePayload rejects huge buffer', () => P.buildImagePayload(Buffer.alloc(P.MAX_IMAGE_BYTES + 1)));
throws('buildGifChunks rejects non-Buffer', () => P.buildGifChunks(null));
throws('buildEffect rejects non-array colors', () => P.buildEffect(0, 'red'));
throws('buildEffect rejects malformed triple', () => P.buildEffect(0, [[1, 2, 3], [4, 5]]));

// buildText with a valid edge length should still succeed
{
  const big = P.buildText('A'.repeat(P.MAX_TEXT_CHARS));
  approx('long text still produces a buffer', big.length > 64);
}

// buildImagePayload masks idk correctly for medium-sized payloads
{
  const png = Buffer.alloc(8192, 0);
  const out = P.buildImagePayload(png);
  // idk = 8192 + chunks_count(2) = 8194 → low byte 0x02, high 0x20
  eq('idk LE bytes for 8KB png', out.subarray(0, 2), Buffer.from([0x02, 0x20]));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
