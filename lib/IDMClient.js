'use strict';

const IDMProtocol = require('./IDMProtocol');

// Backoff schedule for reconnect attempts; the last entry repeats forever,
// so the client keeps retrying every 30s indefinitely (display may simply
// be powered off for hours).
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];

class IDMClient {

  /**
   * @param {object} opts
   * @param {object} opts.homey            Homey app/device instance (for ble + log)
   * @param {string} opts.uuid             BLE peripheral UUID (from pairing)
   * @param {string} [opts.address]        Optional MAC address (advertised)
   * @param {function} [opts.onLog]        Optional log forwarder
   * @param {function} [opts.onConnected]  Called after every successful (re)connect
   * @param {function} [opts.onDisconnected] Called when the connection is lost
   */
  constructor({ homey, uuid, address, onLog, onConnected, onDisconnected }) {
    this.homey = homey;
    this.uuid = uuid;
    this.address = address;
    this.log = onLog || ((...a) => homey.app && homey.app.log && homey.app.log(...a));
    this.onConnected = onConnected || (() => {});
    this.onDisconnected = onDisconnected || (() => {});
    this.peripheral = null;
    this.writeChar = null;
    this.notifyChar = null;
    this._stopped = false;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._loopRunning = false;
    this._connectPromise = null;
    this._writeQueue = Promise.resolve();
    this._notificationListeners = new Set();
    this._notificationsSubscribed = false;
    this._lastSeen = 0;
  }

  /**
   * Add a notification listener. Auto-subscribes on first listener.
   * Returns an unregister function.
   */
  onNotification(cb) {
    this._notificationListeners.add(cb);
    this._ensureNotificationSubscription();
    return () => this._notificationListeners.delete(cb);
  }

  async _ensureNotificationSubscription() {
    if (this._notificationsSubscribed || !this.isConnected()) return;
    const sub = await this.subscribeNotifications(buf => {
      this._lastSeen = Date.now();
      for (const cb of this._notificationListeners) {
        try { cb(buf); } catch (e) { this.log && this.log('notification listener error:', e.message); }
      }
    });
    if (sub) this._notificationsSubscribed = true;
  }

  isConnected() {
    return !!(this.peripheral && this.writeChar);
  }

  /**
   * Kick off the persistent connection loop. Resolves when the first
   * connection succeeds; the loop itself keeps running for the lifetime of
   * the client and re-establishes the link after every disconnect.
   */
  start() {
    this._ensureLoop();
  }

  /**
   * Resolves once connected; rejects only if the client was stopped.
   * Used by write() so commands wait briefly for an in-flight reconnect.
   */
  async connect() {
    if (this._stopped) throw new Error('IDMClient stopped');
    if (this.isConnected()) return this;
    this._ensureLoop();
    return this._connectPromise;
  }

  /**
   * Single connect attempt with a deadline — used by write() so a Flow
   * card fails fast with a useful error instead of hanging forever while
   * the background loop keeps retrying.
   */
  async _waitConnected(timeoutMs = 15000) {
    if (this.isConnected()) return;
    this._ensureLoop();
    await Promise.race([
      this._connectPromise,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('Display not reachable (still trying to reconnect in the background)')),
        timeoutMs,
      )),
    ]);
  }

  _ensureLoop() {
    if (this._stopped || this._loopRunning || this.isConnected()) return;
    this._loopRunning = true;
    let resolveConnect, rejectConnect;
    this._connectPromise = new Promise((res, rej) => { resolveConnect = res; rejectConnect = rej; });
    // Don't let an unobserved rejection (stop() while retrying) crash the app.
    this._connectPromise.catch(() => {});

    const attempt = async () => {
      if (this._stopped) {
        this._loopRunning = false;
        rejectConnect(new Error('IDMClient stopped'));
        return;
      }
      try {
        await this._doConnect();
        this._loopRunning = false;
        this._reconnectAttempt = 0;
        this._notificationsSubscribed = false;
        this._lastSeen = Date.now();
        this.log && this.log('[ble] connected');
        // Re-arm notifications after every reconnect so listeners keep working.
        if (this._notificationListeners.size > 0) {
          await this._ensureNotificationSubscription();
        }
        resolveConnect(this);
        try { await this.onConnected(); } catch (e) {
          this.log && this.log('onConnected handler error:', e.message);
        }
      } catch (e) {
        const delay = RECONNECT_DELAYS_MS[Math.min(this._reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
        this._reconnectAttempt += 1;
        this.log && this.log(`[ble] connect attempt ${this._reconnectAttempt} failed (${e.message}), retrying in ${delay / 1000}s`);
        this._reconnectTimer = setTimeout(attempt, delay);
      }
    };
    attempt();
  }

  async _doConnect() {
    const advertisement = await this.homey.ble.find(this.uuid);
    const peripheral = await advertisement.connect();
    let services;
    try {
      services = await peripheral.discoverAllServicesAndCharacteristics();
    } catch (e) {
      await peripheral.disconnect().catch(() => {});
      throw e;
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

    if (peripheral.once) {
      peripheral.once('disconnect', () => this._onDisconnect());
    } else if (peripheral.on) {
      peripheral.on('disconnect', () => this._onDisconnect());
    }
    return this;
  }

  _onDisconnect() {
    if (!this.peripheral) return; // already handled (e.g. _markDead raced the event)
    this.log && this.log('[ble] disconnected', this.uuid);
    this._clearConnection();
    if (this._stopped) return;
    try { this.onDisconnected(); } catch (e) { /* never break the loop */ }
    this._ensureLoop();
  }

  /**
   * Treat the connection as dead after a failed write — the peripheral's
   * 'disconnect' event sometimes lags or never fires when the link drops
   * mid-write, which would leave us holding stale characteristic handles.
   */
  _markDead(reason) {
    if (!this.peripheral) return;
    this.log && this.log(`[ble] marking connection dead (${reason})`);
    const peripheral = this.peripheral;
    this._clearConnection();
    peripheral.disconnect && peripheral.disconnect().catch(() => {});
    if (this._stopped) return;
    try { this.onDisconnected(); } catch (e) { /* ignore */ }
    this._ensureLoop();
  }

  _clearConnection() {
    this.peripheral = null;
    this.service = null;
    this.writeChar = null;
    this.notifyChar = null;
  }

  async disconnect() {
    this._stopped = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._loopRunning = false;
    if (this.peripheral) {
      try { await this.peripheral.disconnect(); } catch (e) { /* ignore */ }
    }
    this._clearConnection();
  }

  /**
   * Sequential write. Accepts single Buffer or array of Buffers.
   * Splits oversized buffers by MTU. Writes are serialized through a queue;
   * a failed write never poisons the queue for subsequent commands.
   *
   * Options:
   *   withResponse        — request BLE-level write response (slow, default false)
   *   interChunkDelayMs   — fixed delay between BLE chunks (default 0)
   *   ackPredicate        — fn(notifBuf) → true if the notification confirms one
   *                          app-level message was consumed by the device. When set,
   *                          we wait for that ack between each Buffer in `payload`
   *                          (so callers can group an image/GIF chunk per Buffer).
   *   ackTimeoutMs        — how long to wait for an ack before falling back to
   *                          time delay (default 1500)
   */
  async write(payload, opts = {}) {
    const {
      withResponse = false,
      interChunkDelayMs = 0,
      ackPredicate = null,
      ackTimeoutMs = 1500,
    } = opts;
    const buffers = Array.isArray(payload) ? payload : [payload];
    const job = this._writeQueue.then(async () => {
      await this._waitConnected();
      const mtu = this._maxChunkSize();
      try {
        for (let bi = 0; bi < buffers.length; bi++) {
          const buf = buffers[bi];
          const ackWait = ackPredicate
            ? this._waitForAck(ackPredicate, ackTimeoutMs)
            : null;
          for (let i = 0; i < buf.length; i += mtu) {
            const slice = buf.subarray(i, i + mtu);
            await this.writeChar.write(slice, !withResponse);
            if (interChunkDelayMs > 0) await new Promise(r => setTimeout(r, interChunkDelayMs));
          }
          if (ackWait) {
            const acked = await ackWait;
            if (!acked) {
              // Ack didn't come — small safety delay then continue.
              await new Promise(r => setTimeout(r, 100));
            }
          }
        }
      } catch (e) {
        this._markDead(e.message);
        throw e;
      }
    });
    this._writeQueue = job.catch(() => {});
    return job;
  }

  /**
   * Resolve true when a notification matching `predicate` arrives within
   * `timeoutMs`, otherwise false.
   */
  _waitForAck(predicate, timeoutMs) {
    return new Promise(resolve => {
      let done = false;
      const finish = ok => {
        if (done) return;
        done = true;
        unsub();
        clearTimeout(timer);
        resolve(ok);
      };
      const unsub = this.onNotification(buf => {
        try { if (predicate(buf)) finish(true); } catch { /* ignore */ }
      });
      const timer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  /** Returns the latest available RSSI in dBm, or null. */
  async readRssi() {
    if (!this.peripheral) return null;
    if (typeof this.peripheral.updateRssi === 'function') {
      try { return await this.peripheral.updateRssi(); } catch { /* fall through */ }
    }
    if (typeof this.peripheral.rssi === 'number') return this.peripheral.rssi;
    return null;
  }

  /** ms since the most recent notification arrived; null if none yet. */
  msSinceLastSeen() {
    if (!this._lastSeen) return null;
    return Date.now() - this._lastSeen;
  }

  _maxChunkSize() {
    if (this.writeChar && typeof this.writeChar.maxWriteWithoutResponseSize === 'number') {
      return Math.max(20, this.writeChar.maxWriteWithoutResponseSize);
    }
    // Homey BLE doesn't expose maxWriteWithoutResponseSize on this SDK, but
    // the negotiated MTU on iDotMatrix is 517 (confirmed via nRF Connect).
    // 200 leaves comfortable headroom even on low-MTU peers.
    return 200;
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

  /**
   * Find + cache the undocumented secondary service (ae00) and its
   * characteristics ae01 (write-without-response) and ae02 (notify).
   * Used by the AE-service reverse-engineering probe.
   */
  async _ensureAeService() {
    if (this._aeWriteChar) return;
    if (!this.peripheral) await this.connect();
    // Re-list the services from the live peripheral so we can locate ae00.
    const services = await this.peripheral.discoverAllServicesAndCharacteristics();
    const svc = _findService(services, 'ae00');
    if (!svc) throw new Error('AE service (ae00) not exposed by this device');
    const write = _findChar(svc, 'ae01');
    const notify = _findChar(svc, 'ae02');
    if (!write) throw new Error('ae01 characteristic missing');
    this._aeService = svc;
    this._aeWriteChar = write;
    this._aeNotifyChar = notify;
  }

  /** Raw write to ae01. */
  async writeAe(payload, { withResponse = false } = {}) {
    await this._ensureAeService();
    await this._aeWriteChar.write(payload, !withResponse);
  }

  /** Subscribe to ae02 notifications. Returns an unsubscribe handle or null. */
  async subscribeAeNotifications(onData) {
    await this._ensureAeService();
    const c = this._aeNotifyChar;
    if (!c || typeof c.subscribeToNotifications !== 'function') return null;
    try {
      await c.subscribeToNotifications(buf => {
        try { onData(buf); } catch (e) { this.log && this.log('AE notify handler error:', e.message); }
      });
      return {
        unsubscribe: async () => {
          try {
            if (typeof c.unsubscribeFromNotifications === 'function') {
              await c.unsubscribeFromNotifications();
            }
          } catch (e) { /* ignore */ }
        },
      };
    } catch (e) {
      this.log && this.log('[ble] AE subscribeToNotifications failed:', e.message);
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
