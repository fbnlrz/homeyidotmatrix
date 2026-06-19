'use strict';

const IDMProtocol = require('./IDMProtocol');

/**
 * Hourly auto-healthcheck. Runs a tiny, harmless probe pair against the
 * display and surfaces the result through device settings + the activity
 * log so users can spot a slowly degrading pairing before it stops
 * working entirely.
 *
 * The probe is:
 *   1. Read RSSI (no BLE write needed — just a peripheral attribute)
 *   2. Send a brightness opcode set to the current dim level and wait for
 *      the fa03 ack within 2.5s.
 *
 * Status classification:
 *   - OK    — both succeeded, ack in under 1s
 *   - WARN  — both succeeded but ack >1s OR RSSI < -85 dBm
 *   - FAIL  — ack timeout OR write rejected
 *
 * The check is silent: it never changes display state, never writes the
 * brightness opcode when the user just wrote one (activity-aware skip,
 * mirrors Heartbeat behaviour) and never runs while reconnecting.
 */
class HealthCheck {

  constructor({ device, client, intervalMs = 60 * 60 * 1000, onLog }) {
    this.device = device;
    this.client = client;
    this.intervalMs = intervalMs;
    this.log = onLog || (() => {});
    this._timer = null;
    this._stopped = false;
  }

  start() {
    if (this._timer || this._stopped) return;
    // Stagger initial run so multiple devices don't healthcheck in lockstep
    // right after startup.
    const initialDelay = Math.round(this.intervalMs * (0.1 + Math.random() * 0.2));
    this._timer = setTimeout(() => this._tick(), initialDelay);
  }

  stop() {
    this._stopped = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  async _tick() {
    this._timer = null;
    if (this._stopped) return;
    try {
      const result = await this._runOnce();
      await this._record(result);
    } catch (e) {
      this.log(`[healthcheck] tick error: ${e.message}`);
    }
    if (!this._stopped) {
      this._timer = setTimeout(() => this._tick(), this.intervalMs);
    }
  }

  async _runOnce() {
    const out = {
      ts: Date.now(),
      status: 'FAIL',
      ackMs: null,
      rssi: null,
      error: null,
    };
    if (!this.client.isConnected()) {
      out.error = 'not connected';
      return out;
    }
    // RSSI read is cheap and skippable.
    try { out.rssi = await this.client.readRssi(); } catch (_) { /* ignore */ }

    // Skip the brightness probe if a user write just landed — proves liveness.
    const sinceWrite = this.client.msSinceLastWrite();
    if (sinceWrite !== null && sinceWrite < this.intervalMs / 6) {
      out.status = this._classify(0, out.rssi);
      return out;
    }

    const dim = this.device.getCapabilityValue('dim');
    const percent = Math.max(5, Math.min(100, Math.round((typeof dim === 'number' ? dim : 0.5) * 100)));
    const start = Date.now();
    try {
      await this.client.write(IDMProtocol.buildBrightness(percent), {
        ackPredicate: buf => buf.length >= 5 && buf[0] === 0x05 && buf[2] === 0x04,
        ackTimeoutMs: 2500,
      });
      out.ackMs = Date.now() - start;
      out.status = this._classify(out.ackMs, out.rssi);
    } catch (e) {
      out.error = e.message;
      out.ackMs = Date.now() - start;
      out.status = 'FAIL';
    }
    return out;
  }

  _classify(ackMs, rssi) {
    if (typeof rssi === 'number' && rssi < -85) return 'WARN';
    if (ackMs > 1000) return 'WARN';
    return 'OK';
  }

  async _record(result) {
    const summary = `${result.status} · ack=${result.ackMs ?? '—'}ms · rssi=${result.rssi ?? '—'}${result.error ? ' · ' + result.error : ''}`;
    this.log(`[healthcheck] ${summary}`);
    try {
      await this.device.setSettings({
        last_healthcheck_at: new Date(result.ts).toISOString(),
        last_healthcheck_status: summary,
      });
    } catch (_) { /* settings may not exist on older installs */ }
    // Also feed the activity log so the settings page surfaces it.
    if (this.device.homey && this.device.homey.app && this.device.homey.app.activity) {
      try {
        this.device.homey.app.activity.add({
          device: this.device.getName(),
          type: 'healthcheck',
          name: result.status,
          text: summary,
        });
      } catch (_) { /* ignore */ }
    }
  }
}

module.exports = HealthCheck;
