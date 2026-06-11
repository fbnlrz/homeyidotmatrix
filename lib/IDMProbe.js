'use strict';

const IDMProtocol = require('./IDMProtocol');

const GATT_DEVICE_INFO_SERVICE = '180a';
const GATT_MANUFACTURER_NAME = '2a29';
const GATT_MODEL_NUMBER = '2a24';
const GATT_FIRMWARE_REV = '2a26';
const GATT_HARDWARE_REV = '2a27';

function _safeUtf8(buf) {
  try { return buf.toString('utf8').replace(/\0+$/, ''); } catch { return null; }
}

function _hex(buf) {
  return Buffer.isBuffer(buf) ? buf.toString('hex') : null;
}

/**
 * Walk all services/characteristics, report their UUIDs + properties.
 * Read GATT Device Info if exposed.
 */
async function probeBleTopology(peripheral) {
  const services = await peripheral.discoverAllServicesAndCharacteristics();
  const result = { services: [], device: {} };

  for (const service of services) {
    const chars = service.characteristics || [];
    const entry = {
      uuid: service.uuid,
      characteristics: chars.map(c => ({ uuid: c.uuid })),
    };
    result.services.push(entry);

    if (service.uuid && service.uuid.toLowerCase().endsWith(GATT_DEVICE_INFO_SERVICE)) {
      for (const c of chars) {
        const lo = (c.uuid || '').toLowerCase();
        if (!c.properties || !c.properties.read) continue;
        try {
          const data = await c.read();
          if (lo.endsWith(GATT_MANUFACTURER_NAME)) result.device.manufacturer = _safeUtf8(data);
          else if (lo.endsWith(GATT_MODEL_NUMBER)) result.device.model = _safeUtf8(data);
          else if (lo.endsWith(GATT_FIRMWARE_REV)) result.device.firmware = _safeUtf8(data);
          else if (lo.endsWith(GATT_HARDWARE_REV)) result.device.hardware = _safeUtf8(data);
        } catch (e) { /* ignore */ }
      }
    }
  }
  return result;
}

/**
 * Subscribe to all characteristics that expose subscribeToNotifications for
 * `durationMs`, return collected packets. Homey's BleCharacteristic does not
 * expose properties cleanly, so we try-and-skip rather than gate on .properties.
 */
async function probeNotifications(peripheral, { durationMs = 3000 } = {}) {
  const captured = [];
  const subs = [];
  const services = peripheral.services || [];
  for (const service of services) {
    for (const c of (service.characteristics || [])) {
      if (typeof c.subscribeToNotifications !== 'function') continue;
      try {
        const sub = await c.subscribeToNotifications(buffer => {
          captured.push({
            ts: Date.now(),
            charUuid: c.uuid,
            hex: _hex(buffer),
            length: buffer.length,
          });
        });
        subs.push({ char: c, sub });
      } catch (e) { /* ignore */ }
    }
  }
  await new Promise(r => setTimeout(r, durationMs));
  for (const { char } of subs) {
    try {
      if (typeof char.unsubscribeFromNotifications === 'function') {
        await char.unsubscribeFromNotifications();
      }
    } catch (e) { /* ignore */ }
  }
  return captured;
}

/**
 * Send safe-default opcodes and record which produced notifications.
 * NOTE: This actively writes to the device. It restores brightness at the end.
 * `client` must be a connected IDMClient.
 */
async function probeFeatureMatrix(client, { onLog } = {}) {
  const log = onLog || (() => {});
  const results = { features: {}, samples: [] };
  const inbox = [];
  const sub = await client.subscribeNotifications(buf => {
    inbox.push({ ts: Date.now(), hex: buf.toString('hex') });
  });

  const sendAndWait = async (label, buffer, waitMs = 250) => {
    const before = inbox.length;
    const t0 = Date.now();
    try {
      await client.write(buffer);
      await new Promise(r => setTimeout(r, waitMs));
      const after = inbox.slice(before);
      const sample = {
        feature: label,
        sentHex: buffer.toString('hex'),
        latencyMs: Date.now() - t0,
        acks: after.map(x => x.hex),
        ack: after[0] && after[0].hex,
      };
      results.samples.push(sample);
      return sample;
    } catch (e) {
      const sample = { feature: label, sentHex: buffer.toString('hex'), error: e.message };
      results.samples.push(sample);
      return sample;
    }
  };

  // Power: toggle off then on
  results.features.power = {
    off: await sendAndWait('screenOff', IDMProtocol.buildScreenOff()),
    on:  await sendAndWait('screenOn',  IDMProtocol.buildScreenOn()),
    supported: true,
  };

  // Brightness sweep (percent 5..100)
  const brightSamples = [];
  for (const p of [5, 25, 50, 75, 100]) {
    brightSamples.push(await sendAndWait(`brightness:${p}`, IDMProtocol.buildBrightness(p)));
  }
  results.features.brightness = { range: '5-100', samples: brightSamples, supported: true };

  // Clock styles 0..7
  const clockSamples = [];
  for (let s = 0; s < 8; s++) {
    clockSamples.push(await sendAndWait(`clock:${s}`, IDMProtocol.buildClock({ style: s })));
  }
  results.features.clock = { modes: [0, 1, 2, 3, 4, 5, 6, 7], samples: clockSamples, supported: true };

  // Chronograph reset
  results.features.chronograph = {
    reset: await sendAndWait('chrono:reset', IDMProtocol.buildChronograph(0)),
    supported: true,
  };

  // Countdown disable
  results.features.countdown = {
    disable: await sendAndWait('countdown:disable', IDMProtocol.buildCountdown({ mode: 0, minutes: 0, seconds: 0 })),
    supported: true,
  };

  // Scoreboard 0:0
  results.features.scoreboard = {
    zero: await sendAndWait('scoreboard:0:0', IDMProtocol.buildScoreboard(0, 0)),
    supported: true,
  };

  // Restore brightness to a moderate default
  await sendAndWait('brightness:restore', IDMProtocol.buildBrightness(50));

  try { sub && sub.unsubscribe && await sub.unsubscribe(); } catch (e) { /* ignore */ }
  results.notifications = inbox;
  return results;
}

/**
 * Reverse-engineering probe for the undocumented secondary service 0xAE00.
 * Sends a series of safe "fingerprint" patterns to ae01 and records every
 * notification that comes back on ae02. The result is a structured JSON
 * report — patterns that elicit a response are candidates for further
 * decoding.
 *
 * The probes are arranged from "least likely to break anything" outward:
 *   1. single-byte pings: 0x00, 0x01, 0xff
 *   2. two-byte query patterns (potential read commands)
 *   3. short fa-service-style patterns adapted to ae
 *   4. classic OTA framing: [0xAA, 0x55, ...] (very common in vendor BLE)
 *   5. mesh-control framing: [0x05, X, Y, Z, …] for X >= 0x80
 *
 * Each probe waits 250 ms for notifications before moving on. The total
 * runtime is bounded to ~15 s so we don't sit on the BLE link forever.
 */
async function probeAeService(client, { onLog } = {}) {
  const log = onLog || (() => {});
  const inbox = [];
  let sub = null;
  try {
    sub = await client.subscribeAeNotifications(buf => {
      inbox.push({ ts: Date.now(), hex: buf.toString('hex'), length: buf.length });
    });
  } catch (e) {
    log(`[ae] subscribe failed: ${e.message}`);
  }

  const samples = [];
  const sendAndWait = async (label, bytes, waitMs = 250) => {
    const before = inbox.length;
    const t0 = Date.now();
    let error = null;
    try {
      await client.writeAe(Buffer.from(bytes));
    } catch (e) {
      error = e.message;
    }
    await new Promise(r => setTimeout(r, waitMs));
    const responses = inbox.slice(before);
    samples.push({
      label,
      sentHex: Buffer.from(bytes).toString('hex'),
      latencyMs: Date.now() - t0,
      responses: responses.map(r => r.hex),
      error,
    });
  };

  // --- single byte pings ---
  for (const b of [0x00, 0x01, 0x02, 0x10, 0x80, 0xa0, 0xaa, 0xff]) {
    await sendAndWait(`ping:0x${b.toString(16).padStart(2, '0')}`, [b]);
  }

  // --- 2-byte query patterns (read-style) ---
  for (const pair of [[0x00, 0x00], [0x01, 0x00], [0x02, 0x00], [0xaa, 0x55], [0x55, 0xaa]]) {
    await sendAndWait(`q2:${pair.map(b => b.toString(16).padStart(2, '0')).join('')}`, pair);
  }

  // --- FA-style short commands adapted to ae ---
  //   FA used [length, 0, opcode, subop, …]; try the same shape on ae.
  for (const op of [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x10, 0x80]) {
    await sendAndWait(`fa-style-op:0x${op.toString(16).padStart(2, '0')}`,
      [0x04, 0x00, op, 0x80]);
  }

  // --- OTA-style framing: [0xAA, 0x55, type, …] ---
  for (const type of [0x00, 0x01, 0x10, 0x20, 0x80]) {
    await sendAndWait(`ota:0xaa55-${type.toString(16).padStart(2, '0')}`,
      [0xaa, 0x55, type, 0x00, 0x00, 0x00, 0x00]);
  }

  // --- Length-prefixed empty frames ---
  for (const len of [4, 5, 6, 7, 8]) {
    const buf = new Array(len).fill(0);
    buf[0] = len;
    await sendAndWait(`len-empty:${len}`, buf);
  }

  // --- Possible status-query patterns ---
  await sendAndWait('status:0500',  [0x05, 0x00, 0x80, 0x80, 0x00]);
  await sendAndWait('status:info',  [0x06, 0x00, 0x01, 0x80, 0x00, 0x00]);
  await sendAndWait('status:ver',   [0x05, 0x00, 0x02, 0x80, 0x00]);

  // --- Idle period to catch any delayed notifications ---
  await new Promise(r => setTimeout(r, 1000));

  if (sub && sub.unsubscribe) {
    try { await sub.unsubscribe(); } catch (e) { /* ignore */ }
  }

  // Summary: which probes actually elicited a notification, plus the unique
  // response patterns seen — those are the strongest leads.
  const productive = samples.filter(s => s.responses && s.responses.length > 0);
  const uniqueResponses = Array.from(new Set(samples.flatMap(s => s.responses || [])));

  return {
    probedAt: new Date().toISOString(),
    totalProbes: samples.length,
    productiveProbes: productive.length,
    uniqueResponses,
    productive,
    samples,
    notifications: inbox,
  };
}

/**
 * Stage-2 AE probe — targets what the first round found.
 *
 * Round 1 (probeAeService) discovered that sending `0x00` to ae01 produces
 * a 17-byte response of the form `01 <16 high-entropy bytes>`. This looks
 * like a challenge-response auth handshake (common for OTA / privileged
 * BLE channels). This stage clarifies:
 *
 *   A. Whether the 16-byte payload is a *fresh nonce* (different each
 *      time) or a *fixed device identifier* (same every time).
 *   B. What the device does when we send back common auth-response shapes
 *      (echo, zeroed, XORed, etc.) — does it respond with success/failure?
 *   C. Whether the simple auth pattern unlocks other write commands on ae01.
 *
 * The probe is non-destructive — every write is a small auth-ish frame.
 */
async function probeAeChallenge(client, { onLog } = {}) {
  const log = onLog || (() => {});
  const inbox = [];
  let sub = null;
  try {
    sub = await client.subscribeAeNotifications(buf => {
      inbox.push({ ts: Date.now(), hex: buf.toString('hex'), length: buf.length });
    });
  } catch (e) {
    log(`[ae2] subscribe failed: ${e.message}`);
  }

  const sendAndCapture = async (label, bytes, waitMs = 300) => {
    const before = inbox.length;
    const t0 = Date.now();
    let error = null;
    try { await client.writeAe(Buffer.from(bytes)); }
    catch (e) { error = e.message; }
    await new Promise(r => setTimeout(r, waitMs));
    return {
      label,
      sentHex: Buffer.from(bytes).toString('hex'),
      latencyMs: Date.now() - t0,
      responses: inbox.slice(before).map(r => r.hex),
      error,
    };
  };

  // ---- A. Nonce uniqueness test ----
  const challengeSamples = [];
  for (let i = 0; i < 5; i++) {
    const s = await sendAndCapture(`nonce-${i}`, [0x00]);
    challengeSamples.push(s);
  }
  const uniquePayloads = new Set(challengeSamples
    .flatMap(s => s.responses)
    .map(r => r.slice(2)) // strip leading 01 type byte
  );
  const nonceVerdict = uniquePayloads.size === challengeSamples.length
    ? 'FRESH_NONCE'           // unique every time → real challenge
    : uniquePayloads.size === 1
      ? 'FIXED_VALUE'         // same every time → probably device ID
      : 'PARTIAL_CACHE';      // mixed — maybe time-windowed

  // Pick the latest captured challenge to use in echo/XOR tests.
  const lastResp = challengeSamples.reverse().find(s => s.responses.length > 0);
  const challenge = lastResp ? Buffer.from(lastResp.responses[0].slice(2), 'hex') : Buffer.alloc(16);

  // ---- B. Auth response shapes ----
  const authProbes = [];
  // Try sending the challenge back verbatim with various type-byte prefixes.
  for (const prefix of [0x01, 0x02, 0x03, 0x04, 0x80, 0xaa]) {
    authProbes.push(await sendAndCapture(
      `echo-prefix:0x${prefix.toString(16).padStart(2, '0')}`,
      [prefix, ...challenge],
    ));
  }
  // Try a zero-padded "I have no key" reply.
  authProbes.push(await sendAndCapture('zero-reply', [0x02, ...Buffer.alloc(16)]));
  // Try all-0xff response.
  authProbes.push(await sendAndCapture('ff-reply', [0x02, ...Buffer.alloc(16).fill(0xff)]));
  // Try XOR with a well-known constant.
  const xorMask = 0x5a;
  const xored = Buffer.from(Array.from(challenge, b => b ^ xorMask));
  authProbes.push(await sendAndCapture('xor:0x5a', [0x02, ...xored]));
  // Try inverted nibbles.
  const inverted = Buffer.from(Array.from(challenge, b => ~b & 0xff));
  authProbes.push(await sendAndCapture('inverted', [0x02, ...inverted]));

  // ---- C. After-auth: does FA accept additional commands now? ----
  // We don't actually write to FA in this probe; just record whether any
  // notifications appeared on AE during the auth attempts.
  const productiveAuthProbes = authProbes.filter(p => p.responses.length > 0);

  if (sub && sub.unsubscribe) {
    try { await sub.unsubscribe(); } catch (e) { /* ignore */ }
  }

  return {
    probedAt: new Date().toISOString(),
    nonceTest: {
      verdict: nonceVerdict,
      uniquePayloadCount: uniquePayloads.size,
      totalSamples: challengeSamples.length,
      sampledChallenges: Array.from(uniquePayloads),
    },
    capturedChallenge: challenge.toString('hex'),
    authProbes,
    productiveAuthProbes,
    notifications: inbox,
    interpretation: _interpretAeFindings(nonceVerdict, productiveAuthProbes.length),
  };
}

function _interpretAeFindings(verdict, productiveAuth) {
  const hints = [];
  if (verdict === 'FRESH_NONCE') {
    hints.push('16-byte payload changes per request → looks like a cryptographic challenge nonce.');
    hints.push('Likely a challenge-response auth protocol guarding OTA / privileged ops.');
    hints.push('Next step: reverse-engineer the iDotMatrix Android app to find the shared key.');
  } else if (verdict === 'FIXED_VALUE') {
    hints.push('Payload identical across requests → probably a fixed device ID, MAC-derived value, or serial number.');
    hints.push('Check if the 16 bytes appear anywhere on the device label / packaging.');
  } else {
    hints.push('Payload partially unique — could be time-windowed or counter-based.');
  }
  if (productiveAuth > 0) {
    hints.push(`${productiveAuth} auth-response shape(s) elicited a reply — those are leads for the response format.`);
  } else {
    hints.push('No auth-response shape was accepted — proper key required (see Android app).');
  }
  return hints;
}

/**
 * Stage 3 — characterize the AE-service response space.
 *
 * Stage 2 found:
 *   - Sending 0x00 triggers a 17-byte `01 <16 random-looking bytes>` reply
 *   - Repeated 0x00 cycles through a small pool of pre-computed values
 *   - None of the obvious auth-response shapes (echo, zero, XOR, invert)
 *     elicit any acknowledgment from the device
 *
 * This stage tries to widen the picture:
 *   A. Pool size estimate — send 0x00 thirty times; count unique payloads.
 *   B. Input-space mapping — try every 1-byte input 0x00..0xff and record
 *      which ones produce ANY response (and what response).
 *   C. 2-byte input mapping — common low-byte prefixes paired with the
 *      established trigger 0x00 (0x0001, 0x0002, …, 0x00ff).
 *   D. Handshake attempt — send 0x00 → capture challenge → wait → resend
 *      0x00 with the previous captured payload appended (some OTA stacks
 *      use this `<request> <previous-nonce>` pattern).
 */
async function probeAeMapping(client, { onLog } = {}) {
  const log = onLog || (() => {});
  const inbox = [];
  let sub = null;
  try {
    sub = await client.subscribeAeNotifications(buf => {
      inbox.push({ ts: Date.now(), hex: buf.toString('hex'), length: buf.length });
    });
  } catch (e) {
    log(`[ae3] subscribe failed: ${e.message}`);
  }

  const sendAndCapture = async (label, bytes, waitMs = 200) => {
    const before = inbox.length;
    let error = null;
    try { await client.writeAe(Buffer.from(bytes)); }
    catch (e) { error = e.message; }
    await new Promise(r => setTimeout(r, waitMs));
    const after = inbox.slice(before);
    return {
      label,
      sentHex: Buffer.from(bytes).toString('hex'),
      responses: after.map(r => r.hex),
      error,
    };
  };

  // ---- A. Pool size estimate ----
  log('[ae3] A. pool size estimate (30x 0x00)');
  const poolSamples = [];
  for (let i = 0; i < 30; i++) {
    poolSamples.push(await sendAndCapture(`pool-${i}`, [0x00], 150));
  }
  const poolPayloads = poolSamples.flatMap(s => s.responses).map(r => r.slice(2));
  const poolUnique = new Set(poolPayloads);

  // ---- B. 1-byte input mapping (0x00..0xff) ----
  log('[ae3] B. 1-byte input mapping (256 probes)');
  const byteMap = {};
  for (let b = 0; b <= 255; b++) {
    const s = await sendAndCapture(`1b:0x${b.toString(16).padStart(2, '0')}`, [b], 80);
    if (s.responses.length > 0) {
      byteMap[b.toString(16).padStart(2, '0')] = s.responses;
    }
  }

  // ---- C. 2-byte input mapping (00xx for xx=00..ff) ----
  log('[ae3] C. 2-byte 00xx mapping (256 probes)');
  const twoByteMap = {};
  for (let b = 0; b <= 255; b++) {
    const s = await sendAndCapture(`2b:00${b.toString(16).padStart(2, '0')}`, [0x00, b], 80);
    if (s.responses.length > 0) {
      twoByteMap[`00${b.toString(16).padStart(2, '0')}`] = s.responses;
    }
  }

  // ---- D. Handshake (capture-then-resend) attempt ----
  log('[ae3] D. handshake variant — 0x00 then 0x00 + previous-nonce');
  const initial = await sendAndCapture('handshake-init', [0x00], 200);
  let lastNonce = Buffer.alloc(16);
  if (initial.responses.length > 0) {
    lastNonce = Buffer.from(initial.responses[0].slice(2), 'hex');
  }
  const handshakeFollowups = [];
  // Append previous nonce with various leading opcodes.
  for (const op of [0x00, 0x01, 0x02, 0x03, 0x05, 0x10, 0x80]) {
    handshakeFollowups.push(
      await sendAndCapture(
        `handshake-followup:0x${op.toString(16).padStart(2, '0')}`,
        [op, ...lastNonce],
        300,
      ),
    );
  }
  const productiveFollowups = handshakeFollowups.filter(s => s.responses.length > 0);

  if (sub && sub.unsubscribe) {
    try { await sub.unsubscribe(); } catch (e) { /* ignore */ }
  }

  return {
    probedAt: new Date().toISOString(),
    poolEstimate: {
      samples: poolSamples.length,
      uniquePayloads: poolUnique.size,
      sampledUnique: Array.from(poolUnique),
      verdict: poolUnique.size >= 25 ? 'LARGE_NONCE_SPACE'
        : poolUnique.size >= 10 ? 'MEDIUM_POOL'
        : poolUnique.size >= 3 ? 'SMALL_POOL'
        : 'FIXED_OR_TIGHT',
    },
    inputMap: {
      oneByteTriggers: Object.keys(byteMap),
      oneByte: byteMap,
      twoByteTriggers: Object.keys(twoByteMap),
      twoByte: twoByteMap,
    },
    handshakeFollowups: {
      initial,
      followups: handshakeFollowups,
      productive: productiveFollowups,
    },
    notifications: inbox,
    interpretation: _interpretAeMapping(poolUnique.size, byteMap, twoByteMap, productiveFollowups.length),
  };
}

function _interpretAeMapping(poolSize, oneByteMap, twoByteMap, productiveFollowups) {
  const hints = [];
  if (poolSize >= 25) {
    hints.push(`Pool size ≥${poolSize} unique values in 30 samples → looks like a real cryptographic nonce.`);
  } else if (poolSize >= 10) {
    hints.push(`Pool size ${poolSize} — pre-computed nonce pool with refresh.`);
  } else if (poolSize >= 3) {
    hints.push(`Pool size only ${poolSize} → small fixed pool, possibly per-connection nonces.`);
  } else {
    hints.push(`Pool size ${poolSize} — pseudo-static; could be a device fingerprint with light obfuscation.`);
  }
  const oneByteCount = Object.keys(oneByteMap).length;
  const twoByteCount = Object.keys(twoByteMap).length;
  hints.push(`${oneByteCount} of 256 single-byte inputs produced a response.`);
  hints.push(`${twoByteCount} of 256 two-byte (00xx) inputs produced a response.`);
  if (productiveFollowups > 0) {
    hints.push(`${productiveFollowups} handshake-followup shape(s) produced a response — that's a strong lead.`);
  } else {
    hints.push('Handshake followups all ignored — device still wants the proper crypto reply.');
  }
  hints.push('Path to full unlock: decompile the iDotMatrix Android APK and find the shared secret used in AES/CMAC operations on bytes from this service.');
  return hints;
}

/**
 * Stage 4 — determinism / structural test.
 *
 * Stage 3 showed that 2-byte inputs (00xx) all elicit unique-looking 16-byte
 * responses — strong evidence of a keyed HMAC-style transform. This stage:
 *
 *   A. DETERMINISM — send a small set of fixed inputs many times each,
 *      bucket responses, and report whether the device returns the same
 *      value every time (pure function) or rotates through values (
 *      session/nonce-dependent).
 *
 *   B. STRUCTURE — try patterned 17-byte inputs (all-zeros, all-FF,
 *      sequential, XOR-pairs) and look for structural relationships
 *      between input and output (prefix/suffix tells, linear leaks).
 *
 *   C. AVALANCHE — toggle one bit in the input, see how many bits change
 *      in the output. Real cryptographic MACs hit ~50%; weak/linear ones
 *      hit ~1-10%.
 */
async function probeAeDeterminism(client, { onLog } = {}) {
  const log = onLog || (() => {});
  const inbox = [];
  let sub = null;
  try {
    sub = await client.subscribeAeNotifications(buf => {
      inbox.push({ ts: Date.now(), hex: buf.toString('hex'), length: buf.length });
    });
  } catch (e) {
    log(`[ae4] subscribe failed: ${e.message}`);
  }

  const sendAndCapture = async (label, bytes, waitMs = 250) => {
    const before = inbox.length;
    let error = null;
    try { await client.writeAe(Buffer.from(bytes)); }
    catch (e) { error = e.message; }
    await new Promise(r => setTimeout(r, waitMs));
    return {
      label,
      sentHex: Buffer.from(bytes).toString('hex'),
      responses: inbox.slice(before).map(r => r.hex),
      error,
    };
  };

  // ---- A. Determinism per fixed input ----
  log('[ae4] A. determinism (5 fixed inputs × 8 reps each)');
  const detTargets = [
    { name: 'len1:00',    bytes: [0x00] },
    { name: 'len2:0000',  bytes: [0x00, 0x00] },
    { name: 'len2:0042',  bytes: [0x00, 0x42] },
    { name: 'len2:00ff',  bytes: [0x00, 0xff] },
    { name: 'len4:00010203', bytes: [0x00, 0x01, 0x02, 0x03] },
  ];
  const determinismResults = [];
  for (const t of detTargets) {
    const reps = [];
    for (let i = 0; i < 8; i++) {
      reps.push(await sendAndCapture(`${t.name}-rep${i}`, t.bytes, 200));
    }
    // Collect first response of each rep, since some inputs produce 2 notifications.
    const first = reps.map(r => (r.responses[0] || null));
    const second = reps.map(r => (r.responses[1] || null));
    const firstUnique = new Set(first.filter(Boolean));
    const secondUnique = new Set(second.filter(Boolean));
    determinismResults.push({
      input: t.name,
      sentHex: Buffer.from(t.bytes).toString('hex'),
      replies: reps.map(r => r.responses),
      firstResponseUnique: firstUnique.size,
      secondResponseUnique: secondUnique.size,
      verdict: firstUnique.size === 1 ? 'DETERMINISTIC'
        : firstUnique.size <= 3 ? 'SMALL_ROTATION'
        : 'HIGH_VARIANCE',
      firstSampledValues: Array.from(firstUnique),
    });
  }

  // ---- B. Structural patterns ----
  log('[ae4] B. structural inputs');
  const structPatterns = [
    { name: 'all-zeros-17',  bytes: new Array(17).fill(0x00) },
    { name: 'all-ones-17',   bytes: new Array(17).fill(0xff) },
    { name: 'sequential-17', bytes: Array.from({ length: 17 }, (_, i) => i) },
    { name: 'alternating-17',bytes: Array.from({ length: 17 }, (_, i) => i & 1 ? 0xff : 0x00) },
    { name: 'len-prefix-zeros-16', bytes: [0x10, ...new Array(16).fill(0x00)] },
    { name: 'len-prefix-ones-16',  bytes: [0x10, ...new Array(16).fill(0xff)] },
    { name: 'len8-zeros', bytes: [0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00] },
    { name: 'len4-zeros', bytes: [0x04, 0x00, 0x00, 0x00] },
  ];
  const structResults = [];
  for (const p of structPatterns) {
    structResults.push(await sendAndCapture(p.name, p.bytes));
  }

  // ---- C. Avalanche test (single-bit flips) ----
  log('[ae4] C. avalanche test (5 bit flips on len4:00010203)');
  const baseBytes = [0x00, 0x01, 0x02, 0x03];
  const baseResp = await sendAndCapture('avalanche-base', baseBytes);
  const baseHex = baseResp.responses[0] ? baseResp.responses[0].slice(2) : null;
  const avalanche = [];
  const flipPositions = [
    [0, 0x01], [1, 0x01], [2, 0x01], [3, 0x01], [3, 0x80],
  ];
  for (const [byteIdx, bitMask] of flipPositions) {
    const flipped = baseBytes.slice();
    flipped[byteIdx] ^= bitMask;
    const r = await sendAndCapture(`flip-byte${byteIdx}-bit:0x${bitMask.toString(16)}`, flipped);
    const respHex = r.responses[0] ? r.responses[0].slice(2) : null;
    const bitDelta = respHex && baseHex ? _bitDistance(respHex, baseHex) : null;
    avalanche.push({
      flip: `byte${byteIdx} ^= 0x${bitMask.toString(16).padStart(2, '0')}`,
      sentHex: r.sentHex,
      responseHex: r.responses[0],
      bitDeltaFromBase: bitDelta, // count of bits that changed (0-128)
    });
  }

  if (sub && sub.unsubscribe) {
    try { await sub.unsubscribe(); } catch (e) { /* ignore */ }
  }

  return {
    probedAt: new Date().toISOString(),
    determinism: determinismResults,
    structural: structResults,
    avalanche: { base: baseResp, flips: avalanche },
    notifications: inbox,
    interpretation: _interpretAeDeterminism(determinismResults, avalanche),
  };
}

function _bitDistance(hexA, hexB) {
  if (!hexA || !hexB || hexA.length !== hexB.length) return null;
  let d = 0;
  for (let i = 0; i < hexA.length; i += 2) {
    let x = parseInt(hexA.substr(i, 2), 16) ^ parseInt(hexB.substr(i, 2), 16);
    while (x) { d += x & 1; x >>>= 1; }
  }
  return d;
}

function _interpretAeDeterminism(detResults, avalanche) {
  const hints = [];
  for (const r of detResults) {
    if (r.verdict === 'DETERMINISTIC') {
      hints.push(`Input ${r.input}: returns the same 16-byte tag every time → pure function of input (probably keyed MAC).`);
    } else if (r.verdict === 'SMALL_ROTATION') {
      hints.push(`Input ${r.input}: rotates through ${r.firstResponseUnique} fixed values → small per-session pool.`);
    } else {
      hints.push(`Input ${r.input}: ${r.firstResponseUnique} unique replies in 8 calls → input-independent randomness (real nonce).`);
    }
  }
  // Avalanche analysis
  const validDeltas = avalanche.filter(a => typeof a.bitDeltaFromBase === 'number').map(a => a.bitDeltaFromBase);
  if (validDeltas.length) {
    const avg = validDeltas.reduce((a, b) => a + b, 0) / validDeltas.length;
    hints.push(`Avalanche: average ${avg.toFixed(1)} of 128 output bits change per single-bit input flip.`);
    if (avg > 50 && avg < 78) {
      hints.push('  → Looks like a strong cryptographic transform (AES-CMAC or similar).');
    } else if (avg < 20) {
      hints.push('  → Weak diffusion — could be a linear or trivially keyed transform; may be reverse-engineerable.');
    } else {
      hints.push('  → Moderate diffusion — likely a keyed hash (e.g. truncated SHA-256).');
    }
  }
  hints.push('To extract the key: decompile the iDotMatrix Android APK and look for AES / HMAC / SHA primitives operating on bytes that flow to/from the BLE write characteristic ae01.');
  return hints;
}

/**
 * Test a candidate AE-service key against the device. Given a 16-byte
 * AES-128 key, exercises four common framings and reports which (if any)
 * produces a response whose first 16 bytes match the AES-128 computation
 * of the corresponding input.
 *
 *   • AES-128-ECB(key, payload-padded-to-16)
 *   • AES-128-CBC(key, zero-IV, payload-padded-to-16)
 *   • AES-128-CMAC(key, payload)
 *   • HMAC-SHA256(key, payload) truncated to 16 bytes
 *
 * Returns the match list — if any framing produces a byte-for-byte match
 * with the device's response, that's the cracked auth pattern.
 */
async function testAeKey(client, keyInput, ivInput, { onLog } = {}) {
  const log = onLog || (() => {});
  const crypto = require('crypto');

  // Accept ASCII string OR hex (32/64 hex chars). Strip whitespace + common
  // copy-paste cruft (quotes, "0x" prefixes) before classifying.
  const clean = s => String(s || '')
    .replace(/^"+|"+$/g, '')
    .replace(/^'+|'+$/g, '')
    .replace(/^0x/i, '')
    .replace(/\s+/g, '')
    .trim();
  const stripped = clean(keyInput);
  const looksHex = /^[0-9a-fA-F]+$/.test(stripped) && (stripped.length === 32 || stripped.length === 48 || stripped.length === 64);
  let keyBuf;
  if (looksHex) {
    keyBuf = Buffer.from(stripped, 'hex');
  } else {
    keyBuf = Buffer.from(stripped, 'utf8');
  }
  if (![16, 24, 32].includes(keyBuf.length)) {
    throw new Error(`AES key must be 16, 24, or 32 bytes; got ${keyBuf.length} (input length ${stripped.length}, classified as ${looksHex ? 'hex' : 'ascii'})`);
  }
  log(`[ae-key] using ${keyBuf.length}-byte key (AES-${keyBuf.length * 8})`);

  // Optional custom IV from user — accept hex (32 chars) or ASCII (16 chars)
  let customIv = null;
  if (ivInput) {
    const ivClean = clean(ivInput);
    if (/^[0-9a-fA-F]{32}$/.test(ivClean)) customIv = Buffer.from(ivClean, 'hex');
    else customIv = Buffer.from(ivClean, 'utf8').slice(0, 16);
    if (customIv.length < 16) {
      const pad = Buffer.alloc(16 - customIv.length);
      customIv = Buffer.concat([customIv, pad]);
    }
    log(`[ae-key] custom IV (hex): ${customIv.toString('hex')}`);
  }

  const aesCipher = keyBuf.length === 16 ? 'aes-128'
    : keyBuf.length === 24 ? 'aes-192'
    : 'aes-256';

  const inbox = [];
  const sub = await client.subscribeAeNotifications(buf => {
    inbox.push({ ts: Date.now(), hex: buf.toString('hex'), length: buf.length });
  });

  // First capture a fresh session nonce by sending 0x00 — some IV schemes
  // re-use the nonce as the IV.
  let capturedNonce = null;
  try {
    await client.writeAe(Buffer.from([0x00]));
    await new Promise(r => setTimeout(r, 300));
    if (inbox.length) capturedNonce = Buffer.from(inbox[inbox.length - 1].hex.slice(2), 'hex');
  } catch { /* ignore */ }

  const probe = async (label, inputBytes) => {
    const before = inbox.length;
    try { await client.writeAe(Buffer.from(inputBytes)); }
    catch (e) { return { label, error: e.message }; }
    await new Promise(r => setTimeout(r, 350));
    const responses = inbox.slice(before).map(r => r.hex);
    // Device replies are `01 || tag` (17 bytes).
    const tags = responses.map(r => r.slice(2));

    const input = Buffer.from(inputBytes);
    const padded = _padPkcs7(input, 16);
    const zeroPadded = Buffer.concat([input, Buffer.alloc(16 - input.length, 0)]);

    const ivs = [
      { name: 'zero-bytes',    iv: Buffer.alloc(16) },
      { name: 'ascii-zeros',   iv: Buffer.alloc(16, 0x30) }, // "0000000000000000"
      { name: 'ones',          iv: Buffer.alloc(16, 0xff) },
      { name: 'first16-of-key',iv: keyBuf.slice(0, 16) },
      { name: 'input-padded',  iv: padded.slice(0, 16) },
    ];
    if (capturedNonce) ivs.push({ name: 'captured-nonce', iv: capturedNonce });
    if (customIv) ivs.push({ name: 'custom-iv', iv: customIv });

    const candidates = {};
    candidates.ecb = _cipherFirstBlock(`${aesCipher}-ecb`, keyBuf, null, padded);
    candidates['ecb-zeropad'] = _cipherFirstBlock(`${aesCipher}-ecb`, keyBuf, null, zeroPadded);
    for (const { name, iv } of ivs) {
      try { candidates[`cbc-pkcs7-${name}`] = _cipherFirstBlock(`${aesCipher}-cbc`, keyBuf, iv, padded); } catch { /* skip */ }
      try { candidates[`cbc-zero-${name}`]  = _cipherFirstBlock(`${aesCipher}-cbc`, keyBuf, iv, zeroPadded); } catch { /* skip */ }
      // Also try decryption (some vendors mix this up)
      try { candidates[`dec-cbc-${name}`]   = _cipherDecryptFirst(`${aesCipher}-cbc`, keyBuf, iv, padded); } catch { /* skip */ }
    }
    if (keyBuf.length === 16) {
      try { candidates['cmac'] = _aesCmac(keyBuf, input); } catch { /* skip */ }
    }
    candidates.hmacSha256 = crypto.createHmac('sha256', keyBuf).update(input).digest().slice(0, 16).toString('hex');

    const matches = [];
    for (const tag of tags) {
      for (const [mode, candHex] of Object.entries(candidates)) {
        if (candHex && tag === candHex) matches.push({ mode, tag });
      }
    }
    return {
      label,
      sentHex: input.toString('hex'),
      deviceResponses: responses,
      candidates,
      matches,
    };
  };

  const samples = [];
  samples.push(await probe('len2:0000', [0x00, 0x00]));
  samples.push(await probe('len2:0042', [0x00, 0x42]));
  samples.push(await probe('len4:00010203', [0x00, 0x01, 0x02, 0x03]));
  samples.push(await probe('len4:deadbeef', [0xde, 0xad, 0xbe, 0xef]));

  if (sub && sub.unsubscribe) {
    try { await sub.unsubscribe(); } catch (e) { /* ignore */ }
  }

  const matchSet = new Set();
  for (const s of samples) for (const m of (s.matches || [])) matchSet.add(m.mode);

  return {
    probedAt: new Date().toISOString(),
    keyAscii: _isPrintable(keyBuf) ? keyBuf.toString('utf8') : null,
    keyHex: keyBuf.toString('hex'),
    keyBits: keyBuf.length * 8,
    customIvHex: customIv ? customIv.toString('hex') : null,
    capturedSessionNonce: capturedNonce ? capturedNonce.toString('hex') : null,
    samples,
    matchedModes: Array.from(matchSet),
    verdict: matchSet.size ? 'KEY_MATCHES' : 'NO_MATCH',
    interpretation: matchSet.size
      ? [`🎯 KEY ACCEPTED — modes matched: ${Array.from(matchSet).join(', ')}. AE auth is cracked.`]
      : [
        'No match — but SMALL_ROTATION on simple inputs strongly implies a per-session IV/counter mixed in.',
        'In the APK, open the CALLER of AESUtils.encrypt() inside the OTA flow and look at exactly what is passed as `bArr` (the IV) and what plaintext is being passed.',
        'It is likely the device prepends a session counter or includes the captured nonce in the plaintext before encrypting.',
      ],
  };
}

function _isPrintable(buf) {
  for (const b of buf) if (b < 0x20 || b > 0x7e) return false;
  return true;
}

function _cipherFirstBlock(algorithm, key, iv, payload) {
  const crypto = require('crypto');
  const c = iv ? crypto.createCipheriv(algorithm, key, iv) : crypto.createCipheriv(algorithm, key, null);
  c.setAutoPadding(false);
  return c.update(payload).slice(0, 16).toString('hex');
}

function _cipherDecryptFirst(algorithm, key, iv, payload) {
  const crypto = require('crypto');
  const c = iv ? crypto.createDecipheriv(algorithm, key, iv) : crypto.createDecipheriv(algorithm, key, null);
  c.setAutoPadding(false);
  return c.update(payload).slice(0, 16).toString('hex');
}

function _padPkcs7(buf, block) {
  const pad = block - (buf.length % block || block);
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}

function _aesEcbFirstBlock(key, payload) {
  const crypto = require('crypto');
  const c = crypto.createCipheriv('aes-128-ecb', key, null);
  c.setAutoPadding(false);
  return c.update(payload).slice(0, 16).toString('hex');
}

function _aesCbcFirstBlock(key, iv, payload) {
  const crypto = require('crypto');
  const c = crypto.createCipheriv('aes-128-cbc', key, iv);
  c.setAutoPadding(false);
  return c.update(payload).slice(0, 16).toString('hex');
}

/** Tiny AES-CMAC implementation — node doesn't expose it natively. */
function _aesCmac(key, message) {
  const crypto = require('crypto');
  const enc = data => {
    const c = crypto.createCipheriv('aes-128-ecb', key, null);
    c.setAutoPadding(false);
    return c.update(data);
  };
  const dblBE = buf => {
    const out = Buffer.alloc(16);
    let carry = 0;
    for (let i = 15; i >= 0; i--) {
      out[i] = ((buf[i] << 1) | carry) & 0xff;
      carry = (buf[i] >> 7) & 1;
    }
    if (carry) out[15] ^= 0x87; // GF(2^128) reduction polynomial
    return out;
  };
  const zero = Buffer.alloc(16);
  const L = enc(zero);
  const K1 = dblBE(L);
  const K2 = dblBE(K1);

  let n = Math.ceil(message.length / 16) || 1;
  const isFull = (message.length % 16) === 0 && message.length > 0;

  let lastBlock;
  if (isFull) {
    lastBlock = Buffer.alloc(16);
    message.copy(lastBlock, 0, (n - 1) * 16, n * 16);
    for (let i = 0; i < 16; i++) lastBlock[i] ^= K1[i];
  } else {
    lastBlock = Buffer.alloc(16);
    const tailStart = (n - 1) * 16;
    message.copy(lastBlock, 0, tailStart, message.length);
    lastBlock[message.length - tailStart] = 0x80;
    for (let i = 0; i < 16; i++) lastBlock[i] ^= K2[i];
  }

  let X = Buffer.alloc(16);
  for (let i = 0; i < n - 1; i++) {
    const block = message.slice(i * 16, (i + 1) * 16);
    for (let j = 0; j < 16; j++) X[j] ^= block[j];
    X = enc(X);
  }
  for (let j = 0; j < 16; j++) X[j] ^= lastBlock[j];
  return enc(X).toString('hex');
}

module.exports = {
  probeBleTopology,
  probeNotifications,
  probeFeatureMatrix,
  probeAeService,
  probeAeChallenge,
  probeAeMapping,
  probeAeDeterminism,
  testAeKey,
};
