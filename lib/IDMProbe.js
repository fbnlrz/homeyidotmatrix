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

function _safePropertiesDump(c) {
  if (!c) return null;
  try {
    if (c.properties == null) return null;
    if (Array.isArray(c.properties)) return c.properties;
    if (typeof c.properties === 'object') {
      const out = {};
      for (const k of Object.keys(c.properties)) out[k] = c.properties[k];
      return out;
    }
    return String(c.properties);
  } catch { return null; }
}

function _methodNames(o) {
  if (!o) return [];
  const out = new Set();
  let cur = o;
  while (cur && cur !== Object.prototype) {
    for (const k of Object.getOwnPropertyNames(cur)) {
      try { if (typeof o[k] === 'function') out.add(k); } catch { /* skip */ }
    }
    cur = Object.getPrototypeOf(cur);
  }
  return Array.from(out).sort();
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
      characteristics: chars.map(c => ({
        uuid: c.uuid,
        // Dump raw shape so the user can see whatever Homey exposes
        // (the structured object below may be empty if Homey uses a
        // different naming scheme — keys + propertiesRaw catch that).
        propertiesRaw: _safePropertiesDump(c),
        properties: {
          read: !!c.properties && c.properties.read,
          write: !!c.properties && c.properties.write,
          writeWithoutResponse: !!c.properties && c.properties.writeWithoutResponse,
          notify: !!c.properties && c.properties.notify,
          indicate: !!c.properties && c.properties.indicate,
        },
        objectKeys: Object.keys(c || {}),
        methodKeys: _methodNames(c),
      })),
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
 * Subscribe to all notify/indicate characteristics for `durationMs`, return collected packets.
 */
async function probeNotifications(peripheral, { durationMs = 3000 } = {}) {
  const captured = [];
  const subs = [];
  const services = peripheral.services || [];
  for (const service of services) {
    for (const c of (service.characteristics || [])) {
      if (!c.properties) continue;
      if (!c.properties.notify && !c.properties.indicate) continue;
      try {
        const sub = await c.subscribe(buffer => {
          captured.push({
            ts: Date.now(),
            charUuid: c.uuid,
            hex: _hex(buffer),
            length: buffer.length,
          });
        });
        subs.push(sub);
      } catch (e) { /* ignore */ }
    }
  }
  await new Promise(r => setTimeout(r, durationMs));
  for (const sub of subs) {
    try { sub && sub.unsubscribe && await sub.unsubscribe(); } catch (e) { /* ignore */ }
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

module.exports = {
  probeBleTopology,
  probeNotifications,
  probeFeatureMatrix,
};
