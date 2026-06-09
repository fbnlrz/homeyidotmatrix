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
    await peripheral.discoverAllServicesAndCharacteristics();

    const service = await peripheral.getService(IDMProtocol.SERVICE_UUID);
    if (!service) {
      await peripheral.disconnect().catch(() => {});
      throw new Error(`Service ${IDMProtocol.SERVICE_UUID} not found`);
    }
    const writeChar = await service.getCharacteristic(IDMProtocol.WRITE_CHAR_UUID);
    let notifyChar = null;
    try {
      notifyChar = await service.getCharacteristic(IDMProtocol.NOTIFY_CHAR_UUID);
    } catch (e) {
      // notify is optional
    }

    this.peripheral = peripheral;
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

  async subscribeNotifications(onData) {
    if (!this.notifyChar) return null;
    try {
      const sub = await this.notifyChar.subscribe(buffer => {
        try { onData(buffer); } catch (e) { this.log && this.log('Notify handler error:', e.message); }
      });
      return sub;
    } catch (e) {
      this.log && this.log('Notify subscribe failed:', e.message);
      return null;
    }
  }
}

module.exports = IDMClient;
