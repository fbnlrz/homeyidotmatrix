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

module.exports = {
  probeBleTopology,
  probeNotifications,
  probeFeatureMatrix,
  probeAeService,
  probeAeChallenge,
};
