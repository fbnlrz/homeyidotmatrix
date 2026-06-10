'use strict';

const IDMProtocol = require('./IDMProtocol');

/**
 * Periodically writes a tiny no-op-ish opcode to the device and waits for the
 * accompanying ack on fa03. If the ack doesn't come within `ackTimeoutMs`,
 * the connection is assumed dead — even if Homey's BLE layer hasn't fired a
 * disconnect event yet — and the client is told to reset.
 *
 * We use the brightness opcode with the device's current brightness as a
 * harmless probe: it does not change visible state and the device always
 * returns 0x05 0x00 0x04 0x80 0x01 within a few hundred ms.
 */
class Heartbeat {

  constructor({ client, getBrightnessPercent, intervalMs = 60_000, ackTimeoutMs = 2500, onSilentDeath, onLog }) {
    this.client = client;
    this.getBrightnessPercent = getBrightnessPercent || (() => 50);
    this.intervalMs = intervalMs;
    this.ackTimeoutMs = ackTimeoutMs;
    this.onSilentDeath = onSilentDeath || (() => {});
    this.log = onLog || (() => {});
    this._timer = null;
    this._stopped = false;
  }

  start() {
    if (this._timer || this._stopped) return;
    this._timer = setTimeout(() => this._tick(), this.intervalMs);
  }

  stop() {
    this._stopped = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  async _tick() {
    this._timer = null;
    if (this._stopped) return;
    try {
      if (!this.client.isConnected()) {
        // The client is already attempting reconnect — nothing to do here.
        this._scheduleNext();
        return;
      }
      const percent = Math.max(5, Math.min(100, Math.round(this.getBrightnessPercent())));
      await this.client.write(IDMProtocol.buildBrightness(percent), {
        ackPredicate: buf => buf.length >= 5 && buf[0] === 0x05 && buf[2] === 0x04,
        ackTimeoutMs: this.ackTimeoutMs,
      });
      const stale = this.client.msSinceLastSeen();
      if (stale !== null && stale > this.intervalMs + this.ackTimeoutMs * 2) {
        this.log(`[heartbeat] no notifications in ${stale}ms — declaring link dead`);
        this.onSilentDeath();
      }
    } catch (e) {
      this.log(`[heartbeat] write failed: ${e.message}`);
    }
    this._scheduleNext();
  }

  _scheduleNext() {
    if (this._stopped) return;
    this._timer = setTimeout(() => this._tick(), this.intervalMs);
  }
}

module.exports = Heartbeat;
