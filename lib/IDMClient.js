'use strict';

const IDMProtocol = require('./IDMProtocol');

// Backoff base for reconnect attempts; the last entry repeats forever,
// so the client keeps retrying every 30s indefinitely (the display may simply
// be powered off for hours). ±20% jitter is applied per attempt to keep
// multiple devices from waking up in lock-step after a Homey-wide BLE blip.
const RECONNECT_BASE_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
const RECONNECT_JITTER = 0.2;

// If the previous successful connection survived for less than this many ms,
// treat the next drop as part of an ongoing flap and *don't* reset the attempt
// counter — otherwise a wobbly link would loop forever at the 1s base delay.
const FLAP_UPTIME_MS = 10_000;

// Hard ceiling for a single `_doConnect` invocation. Some Homey BLE stacks
// will hang in `ble.find()` for minutes when the radio is in a bad state;
// the loop must always make forward progress.
const CONNECT_TIMEOUT_MS = 20_000;

// Default for `_waitConnected`. write() callers can override via opts.
const WAIT_CONNECTED_TIMEOUT_MS = 15_000;

class IDMClient {

  /**
   * @param {object} opts
   * @param {object} opts.homey            Homey app/device instance (for ble + log)
   * @param {string} opts.uuid             BLE peripheral UUID (from pairing)
   * @param {string} [opts.address]        Optional MAC address (advertised)
   * @param {function} [opts.onLog]        Optional log forwarder
   * @param {function} [opts.onConnected]  Called after every successful (re)connect
   * @param {function} [opts.onDisconnected] Called exactly once per connection drop
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
    this._disconnectHandler = null;
    this._stopped = false;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._loopRunning = false;
    this._connectPromise = null;
    this._writeQueue = Promise.resolve();
    this._notificationListeners = new Set();
    this._activeNotificationSub = null;
    this._lastSeen = 0;
    this._lastWriteAt = 0;
    this._disconnectFired = true; // no connection yet → no pending drop
    this._lastConnectedAt = 0;
    this._lastDisconnectedAt = 0;
    this._totalConnects = 0;
    this._totalDisconnects = 0;
    this._lastError = null;
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
    if (this._activeNotificationSub || !this.isConnected()) return;
    const sub = await this.subscribeNotifications(buf => {
      this._lastSeen = Date.now();
      for (const cb of this._notificationListeners) {
        try { cb(buf); } catch (e) {
          try { this.log && this.log('notification listener error:', e.message); }
          catch (_) { /* give up logging */ }
        }
      }
    });
    if (sub) this._activeNotificationSub = sub;
  }

  async _tearDownNotificationSubscription() {
    const sub = this._activeNotificationSub;
    this._activeNotificationSub = null;
    if (sub && typeof sub.unsubscribe === 'function') {
      try { await sub.unsubscribe(); } catch (e) { /* link likely gone, ignore */ }
    }
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
   * Single connect-wait with a deadline — used by write() so a Flow card
   * fails fast with a useful error instead of hanging forever while the
   * background loop keeps retrying. Default 15s, overridable per write.
   */
  async _waitConnected(timeoutMs = WAIT_CONNECTED_TIMEOUT_MS) {
    if (this.isConnected()) return;
    this._ensureLoop();
    let timer;
    try {
      await Promise.race([
        this._connectPromise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Display not reachable (still trying to reconnect in the background)')),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  _nextDelay(attempt, lastUptimeMs) {
    // If the link just collapsed within FLAP_UPTIME_MS of being up, push the
    // schedule one step further so we don't loop at 1s forever.
    const effectiveAttempt = lastUptimeMs > 0 && lastUptimeMs < FLAP_UPTIME_MS
      ? attempt + 1
      : attempt;
    const idx = Math.min(effectiveAttempt, RECONNECT_BASE_DELAYS_MS.length - 1);
    const base = RECONNECT_BASE_DELAYS_MS[idx];
    const jitter = 1 + ((Math.random() * 2 - 1) * RECONNECT_JITTER);
    return Math.round(base * jitter);
  }

  _ensureLoop() {
    if (this._stopped || this._loopRunning || this.isConnected()) return;
    this._loopRunning = true;
    let resolveConnect, rejectConnect;
    this._connectPromise = new Promise((res, rej) => { resolveConnect = res; rejectConnect = rej; });
    // Don't let an unobserved rejection (stop() while retrying) crash the app.
    this._connectPromise.catch(() => {});

    const attempt = async () => {
      this._reconnectTimer = null;
      if (this._stopped) {
        this._loopRunning = false;
        rejectConnect(new Error('IDMClient stopped'));
        return;
      }
      try {
        await this._doConnectWithTimeout();
        this._loopRunning = false;
        this._reconnectAttempt = 0;
        this._lastError = null;
        this._lastConnectedAt = Date.now();
        this._totalConnects += 1;
        this._lastSeen = Date.now();
        this._disconnectFired = false;
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
        const uptime = this._lastConnectedAt
          ? Date.now() - this._lastConnectedAt - 1 // -1 so freshly-failed first connect doesn't trigger flap
          : 0;
        const delay = this._nextDelay(this._reconnectAttempt, uptime);
        this._reconnectAttempt += 1;
        this._lastError = e.message;
        this.log && this.log(`[ble] connect attempt ${this._reconnectAttempt} failed (${e.message}), retrying in ${(delay / 1000).toFixed(1)}s`);
        this._reconnectTimer = setTimeout(attempt, delay);
      }
    };
    attempt();
  }

  async _doConnectWithTimeout() {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`connect timeout after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this._doConnect(), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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

    // Named handler so we can remove it again on disconnect/_markDead — otherwise
    // the closure leaks and may fire after we've already torn down the connection.
    this._disconnectHandler = () => this._onDisconnect();
    if (peripheral.once) {
      peripheral.once('disconnect', this._disconnectHandler);
    } else if (peripheral.on) {
      peripheral.on('disconnect', this._disconnectHandler);
    }
    return this;
  }

  _onDisconnect() {
    if (this._disconnectFired) return; // _markDead already handled it
    this.log && this.log('[ble] disconnected', this.uuid);
    this._fireDisconnect();
    if (this._stopped) return;
    this._ensureLoop();
  }

  /**
   * Treat the connection as dead after a failed write — the peripheral's
   * 'disconnect' event sometimes lags or never fires when the link drops
   * mid-write, which would leave us holding stale characteristic handles.
   */
  _markDead(reason) {
    if (this._disconnectFired) return;
    this.log && this.log(`[ble] marking connection dead (${reason})`);
    const peripheral = this.peripheral;
    this._fireDisconnect();
    if (peripheral && peripheral.disconnect) {
      peripheral.disconnect().catch(() => {});
    }
    if (this._stopped) return;
    this._ensureLoop();
  }

  /**
   * Fire the user-facing onDisconnected callback exactly once per connection
   * drop, then drop our handles. Both _onDisconnect and _markDead funnel
   * through here.
   */
  _fireDisconnect() {
    this._disconnectFired = true;
    this._lastDisconnectedAt = Date.now();
    this._totalDisconnects += 1;
    this._clearConnection();
    // Fire-and-forget; the user callback may be async, but we don't want a
    // slow listener to block the reconnect loop.
    Promise.resolve()
      .then(() => this.onDisconnected())
      .catch(e => { this.log && this.log('onDisconnected handler error:', e && e.message); });
  }

  _clearConnection() {
    if (this.peripheral && this._disconnectHandler && typeof this.peripheral.removeListener === 'function') {
      try { this.peripheral.removeListener('disconnect', this._disconnectHandler); }
      catch (e) { /* SDK may not expose removeListener */ }
    }
    this._disconnectHandler = null;
    // Tear down the previous notification subscription — re-subscribing on
    // the new peripheral happens after the next successful _doConnect.
    if (this._activeNotificationSub) {
      const sub = this._activeNotificationSub;
      this._activeNotificationSub = null;
      Promise.resolve(sub.unsubscribe && sub.unsubscribe()).catch(() => {});
    }
    this.peripheral = null;
    this.service = null;
    this.writeChar = null;
    this.notifyChar = null;
    // Forget any cached AE service handles too; they belong to the dead peripheral.
    this._aeService = null;
    this._aeWriteChar = null;
    this._aeNotifyChar = null;
  }

  async disconnect() {
    this._stopped = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._loopRunning = false;
    this._notificationListeners.clear();
    await this._tearDownNotificationSubscription();
    if (this.peripheral) {
      try { await this.peripheral.disconnect(); } catch (e) { /* ignore */ }
    }
    this._clearConnection();
    // Reset the queue so any straggling .catch chains don't keep references
    // to dead peripherals alive across app restarts.
    this._writeQueue = Promise.resolve();
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
   *   waitConnectedMs     — how long to wait for an in-flight reconnect before
   *                          giving up with a clear error (default 15000)
   */
  async write(payload, opts = {}) {
    const {
      withResponse = false,
      interChunkDelayMs = 0,
      ackPredicate = null,
      ackTimeoutMs = 1500,
      waitConnectedMs = WAIT_CONNECTED_TIMEOUT_MS,
    } = opts;
    const buffers = Array.isArray(payload) ? payload : [payload];
    const job = this._writeQueue.then(async () => {
      await this._waitConnected(waitConnectedMs);
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
        this._lastWriteAt = Date.now();
      } catch (e) {
        this._markDead(e.message);
        throw e;
      }
    });
    // Swallow rejection on the *queue chain* (so the next write isn't poisoned),
    // but surface a single log line — silent failures here were impossible to debug.
    this._writeQueue = job.catch(err => {
      try { this.log && this.log(`[ble] queued write failed: ${err && err.message}`); }
      catch (_) { /* never throw from queue tail */ }
    });
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

  /** ms since the most recent successful write to the device; null if none yet. */
  msSinceLastWrite() {
    if (!this._lastWriteAt) return null;
    return Date.now() - this._lastWriteAt;
  }

  /**
   * Snapshot of the current connection state for diagnostics. Returned object
   * is meant for read-only display in settings / diagnostic bundle.
   */
  getConnectionState() {
    return {
      connected: this.isConnected(),
      stopped: this._stopped,
      lastConnectedAt: this._lastConnectedAt || null,
      lastDisconnectedAt: this._lastDisconnectedAt || null,
      uptimeMs: this.isConnected() && this._lastConnectedAt
        ? Date.now() - this._lastConnectedAt : 0,
      reconnectAttempt: this._reconnectAttempt,
      totalConnects: this._totalConnects,
      totalDisconnects: this._totalDisconnects,
      lastError: this._lastError,
    };
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

// Export constants alongside the class so tests / device code can introspect.
IDMClient.RECONNECT_BASE_DELAYS_MS = RECONNECT_BASE_DELAYS_MS;
IDMClient.RECONNECT_JITTER = RECONNECT_JITTER;
IDMClient.FLAP_UPTIME_MS = FLAP_UPTIME_MS;
IDMClient.CONNECT_TIMEOUT_MS = CONNECT_TIMEOUT_MS;
IDMClient.WAIT_CONNECTED_TIMEOUT_MS = WAIT_CONNECTED_TIMEOUT_MS;

module.exports = IDMClient;
