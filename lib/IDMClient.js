'use strict';

const IDMProtocol = require('./IDMProtocol');

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];

class IDMClient {

  /**
   * @param {object} opts
   * @param {object} opts.homey       Homey app/device instance (for ble + log)
   * @param {string} opts.uuid        BLE peripheral UUID (from pairing)
   * @param {string} [opts.address]   Optional MAC address (advertised)
   * @param {function} [opts.onLog]   Optional log forwarder
   */
  constructor({ homey, uuid, address, onLog }) {
    this.homey = homey;
    this.uuid = uuid;
    this.address = address;
    this.log = onLog || ((...a) => homey.app && homey.app.log && homey.app.log(...a));
    this.peripheral = null;
    this.writeChar = null;
    this.notifyChar = null;
    this._connecting = null;
    this._reconnectAttempt = 0;
    this._stopped = false;
    this._writeQueue = Promise.resolve();
  }

  isConnected() {
    return !!(this.peripheral && this.writeChar);
  }

  async connect() {
    if (this._stopped) throw new Error('IDMClient stopped');
    if (this.isConnected()) return this;
    if (this._connecting) return this._connecting;
    this._connecting = this._doConnect().finally(() => { this._connecting = null; });
    return this._connecting;
  }

  async _doConnect() {
    const advertisement = await this.homey.ble.find(this.uuid);
    const peripheral = await advertisement.connect();
    const services = await peripheral.discoverAllServicesAndCharacteristics();

    // Log every discovered service+char so we can see Homey's actual UUID format.
    for (const svc of services) {
      this.log && this.log(`[ble] service uuid=${svc.uuid}`);
      const chars = svc.characteristics || [];
      for (const c of chars) {
        const props = Object.entries(c.properties || {})
          .filter(([, v]) => v).map(([k]) => k).join(',');
        this.log && this.log(`[ble]   char uuid=${c.uuid} props=${props}`);
      }
    }

    const service = _findService(services, IDMProtocol.SERVICE_SHORT_UUID);
    if (!service) {
      await peripheral.disconnect().catch(() => {});
      const uuids = services.map(s => s.uuid).join(', ');
      throw new Error(`iDotMatrix service ${IDMProtocol.SERVICE_SHORT_UUID} not found. Discovered: ${uuids || '(none)'}`);
    }
    const writeChar = _findChar(service, IDMProtocol.WRITE_SHORT_UUID);
    const notifyChar = _findChar(service, IDMProtocol.NOTIFY_SHORT_UUID);
    if (!writeChar) {
      await peripheral.disconnect().catch(() => {});
      throw new Error(`Write characteristic ${IDMProtocol.WRITE_SHORT_UUID} not found on iDotMatrix service`);
    }

    this.peripheral = peripheral;
    this.service = service;
    this.writeChar = writeChar;
    this.notifyChar = notifyChar;
    this._reconnectAttempt = 0;

    if (peripheral.on) {
      peripheral.on('disconnect', () => this._onDisconnect());
    }
    return this;
  }

  _onDisconnect() {
    this.log && this.log('iDotMatrix disconnected', this.uuid);
    this.peripheral = null;
    this.writeChar = null;
    this.notifyChar = null;
    if (this._stopped) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this._reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this._reconnectAttempt += 1;
    setTimeout(() => {
      this.connect().catch(err => this.log && this.log('Reconnect failed:', err.message));
    }, delay);
  }

  async disconnect() {
    this._stopped = true;
    if (this.peripheral) {
      try { await this.peripheral.disconnect(); } catch (e) { /* ignore */ }
    }
    this.peripheral = null;
    this.writeChar = null;
    this.notifyChar = null;
  }

  /**
   * Sequential write. Accepts single Buffer or array of Buffers.
   * Splits oversized buffers by MTU (maxWriteWithoutResponseSize when available).
   */
  async write(payload, { withResponse = false, interChunkDelayMs = 0 } = {}) {
    const buffers = Array.isArray(payload) ? payload : [payload];
    this._writeQueue = this._writeQueue.then(async () => {
      if (!this.isConnected()) await this.connect();
      const mtu = this._maxChunkSize();
      for (const buf of buffers) {
        for (let i = 0; i < buf.length; i += mtu) {
          const slice = buf.subarray(i, i + mtu);
          await this.writeChar.write(slice, !withResponse);
          if (interChunkDelayMs > 0) await new Promise(r => setTimeout(r, interChunkDelayMs));
        }
      }
    });
    return this._writeQueue;
  }

  _maxChunkSize() {
    if (this.writeChar && typeof this.writeChar.maxWriteWithoutResponseSize === 'number') {
      return Math.max(20, this.writeChar.maxWriteWithoutResponseSize);
    }
    // Conservative default — Homey BLE typical MTU is 23 (20 bytes payload).
    return 20;
  }

  /**
   * Subscribe to fa03 notifications via Homey's BleCharacteristic.subscribeToNotifications.
   * Returns an object with an `unsubscribe()` method, or null if the char isn't there.
   */
  async subscribeNotifications(onData) {
    if (!this.notifyChar) return null;
    const c = this.notifyChar;
    if (typeof c.subscribeToNotifications !== 'function') {
      this.log && this.log('[ble] notify char has no subscribeToNotifications method');
      return null;
    }
    try {
      await c.subscribeToNotifications(buf => {
        try { onData(buf); } catch (e) { this.log && this.log('Notify handler error:', e.message); }
      });
      return { unsubscribe: async () => {
        try {
          if (typeof c.unsubscribeFromNotifications === 'function') {
            await c.unsubscribeFromNotifications();
          }
        } catch (e) { /* ignore */ }
      }};
    } catch (e) {
      this.log && this.log('[ble] subscribeToNotifications failed:', e.message);
      return null;
    }
  }
}

function _normalizeUuid(u) {
  return String(u || '').toLowerCase().replace(/-/g, '');
}

/**
 * Locate a BleService by 16-bit short uuid (e.g. 'fa00'). Matches against
 * the service's reported UUID regardless of whether Homey returns the short
 * form ('fa00'), the full 128-bit form ('0000fa00-…' or '0000fa00…'), with
 * or without dashes.
 */
function _findService(services, shortUuid) {
  const want = shortUuid.toLowerCase();
  for (const svc of services) {
    const norm = _normalizeUuid(svc.uuid);
    if (norm === want) return svc;
    // Full 128-bit form: starts with '0000<short>' and ends with the SIG base.
    if (norm.length === 32 && norm.startsWith('0000' + want) && norm.endsWith('00001000800000805f9b34fb')) {
      return svc;
    }
    // Fallback: any UUID that contains the short uuid in the standard slot.
    if (norm.includes(want)) return svc;
  }
  return null;
}

function _findChar(service, shortUuid) {
  const chars = service.characteristics || [];
  const want = shortUuid.toLowerCase();
  for (const c of chars) {
    const norm = _normalizeUuid(c.uuid);
    if (norm === want) return c;
    if (norm.length === 32 && norm.startsWith('0000' + want) && norm.endsWith('00001000800000805f9b34fb')) {
      return c;
    }
    if (norm.includes(want)) return c;
  }
  return null;
}

module.exports = IDMClient;
