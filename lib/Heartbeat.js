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
 *
 * The probe is *activity-aware*: if any normal write happened within the
 * heartbeat interval, we skip the probe — the recent write already proved
 * the link is alive, and we avoid the race where the heartbeat clobbers a
 * brightness value the user just changed.
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
        // Client is already reconnecting — poll a bit faster so we resume
        // heartbeating quickly after the link comes back, but don't compete
        // with the reconnect loop.
        this._scheduleNext(Math.min(10_000, this.intervalMs));
        return;
      }
      // Activity-aware skip: a recent successful write proves the link is up.
      const sinceWrite = this.client.msSinceLastWrite();
      if (sinceWrite !== null && sinceWrite < this.intervalMs) {
        this._scheduleNext();
        return;
      }
      const percent = Math.max(5, Math.min(100, Math.round(this.getBrightnessPercent())));
      await this.client.write(IDMProtocol.buildBrightness(percent), {
        ackPredicate: buf => buf.length >= 5 && buf[0] === 0x05 && buf[2] === 0x04,
        ackTimeoutMs: this.ackTimeoutMs,
      });
      const stale = this.client.msSinceLastSeen();
      if (
        stale !== null
        && stale > this.intervalMs + this.ackTimeoutMs * 2
        && this.client.isConnected() // re-check; markDead may have raced us
      ) {
        this.log(`[heartbeat] no notifications in ${stale}ms — declaring link dead`);
        this.onSilentDeath();
      }
    } catch (e) {
      this.log(`[heartbeat] write failed: ${e.message}`);
    }
    this._scheduleNext();
  }

  _scheduleNext(delayMs) {
    if (this._stopped) return;
    this._timer = setTimeout(() => this._tick(), delayMs || this.intervalMs);
  }
}

module.exports = Heartbeat;
