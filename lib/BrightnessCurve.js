'use strict';

const IDMProtocol = require('./IDMProtocol');

/**
 * Time-of-day automatic brightness. Reads settings every minute and writes
 * a brightness opcode only when the target percentage actually changes —
 * avoids flooding the BLE link.
 *
 * Settings on the device:
 *   curve_enabled        — checkbox
 *   curve_day_brightness — 5–100, brightness during the day window
 *   curve_night_brightness — 5–100, brightness outside of it
 *   curve_day_start      — "HH:MM" string
 *   curve_night_start    — "HH:MM" string
 */
class BrightnessCurve {

  constructor({ device, client, onLog }) {
    this.device = device;
    this.client = client;
    this.log = onLog || (() => {});
    this._timer = null;
    this._lastApplied = null;
  }

  start() {
    if (this._timer) return;
    this._tick();
    this._timer = setInterval(() => this._tick(), 60 * 1000);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async _tick() {
    try {
      if (!this.device.getSetting('curve_enabled')) return;
      const target = this._currentTarget();
      if (target === this._lastApplied) return;
      if (!this.client.isConnected()) return;
      await this.client.write(IDMProtocol.buildBrightness(target));
      // Keep capability in sync so Homey UI reflects it
      await this.device.setCapabilityValue('dim', target / 100).catch(() => {});
      this._lastApplied = target;
      this.log(`[curve] brightness → ${target}%`);
    } catch (e) {
      this.log(`[curve] tick error: ${e.message}`);
    }
  }

  _currentTarget() {
    const day = _clampPct(this.device.getSetting('curve_day_brightness'), 80);
    const night = _clampPct(this.device.getSetting('curve_night_brightness'), 15);
    const dayStart = _parseTime(this.device.getSetting('curve_day_start'), 7, 0);
    const nightStart = _parseTime(this.device.getSetting('curve_night_start'), 22, 0);
    const now = new Date();
    const m = now.getHours() * 60 + now.getMinutes();
    const ds = dayStart.h * 60 + dayStart.m;
    const ns = nightStart.h * 60 + nightStart.m;
    // Day is the interval [ds, ns) (wrap-around supported)
    const inDay = ds < ns ? (m >= ds && m < ns) : (m >= ds || m < ns);
    return inDay ? day : night;
  }
}

function _clampPct(v, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(5, Math.min(100, n));
}
function _parseTime(s, fh, fm) {
  if (typeof s !== 'string') return { h: fh, m: fm };
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { h: fh, m: fm };
  return { h: Math.max(0, Math.min(23, parseInt(m[1], 10))), m: Math.max(0, Math.min(59, parseInt(m[2], 10))) };
}

module.exports = BrightnessCurve;
