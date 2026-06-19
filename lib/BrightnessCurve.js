'use strict';

const IDMProtocol = require('./IDMProtocol');
const { sunTimes } = require('./sun');

/**
 * Time-of-day automatic brightness. Reads settings every minute and writes
 * a brightness opcode only when the target percentage actually changes —
 * avoids flooding the BLE link.
 *
 * Settings on the device:
 *   curve_enabled        — checkbox
 *   curve_day_brightness — 5–100, brightness during the day window
 *   curve_night_brightness — 5–100, brightness outside of it
 *   curve_day_start      — "HH:MM" string (ignored when curve_use_sun is on)
 *   curve_night_start    — "HH:MM" string (ignored when curve_use_sun is on)
 *   curve_use_sun        — checkbox; when on, day_start/night_start are
 *                          replaced by the locally-computed sunrise/sunset.
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
    const now = new Date();
    const m = now.getHours() * 60 + now.getMinutes();
    const { ds, ns } = this._dayWindow(now);
    // Day is the interval [ds, ns) (wrap-around supported)
    const inDay = ds < ns ? (m >= ds && m < ns) : (m >= ds || m < ns);
    return inDay ? day : night;
  }

  /**
   * Resolve start of day / start of night in minutes since local midnight.
   * Honors curve_use_sun when set and a usable lat/lon is available; falls
   * back to the configured HH:MM strings otherwise.
   */
  _dayWindow(now) {
    const useSun = !!this.device.getSetting('curve_use_sun');
    if (useSun) {
      const { lat, lon } = this._geo();
      const t = sunTimes(now, lat, lon);
      if (t.sunriseMinutes !== null && t.sunsetMinutes !== null) {
        return { ds: t.sunriseMinutes, ns: t.sunsetMinutes };
      }
    }
    const dayStart = _parseTime(this.device.getSetting('curve_day_start'), 7, 0);
    const nightStart = _parseTime(this.device.getSetting('curve_night_start'), 22, 0);
    return { ds: dayStart.h * 60 + dayStart.m, ns: nightStart.h * 60 + nightStart.m };
  }

  _geo() {
    // Homey exposes the controller's geolocation on the app's homey object.
    // Stored on the device for caching; fall back to NaN so sunTimes() skips.
    const h = this.device && this.device.homey;
    let lat = NaN; let lon = NaN;
    if (h && h.geolocation) {
      // SDK3 returns synchronous accessors on the geolocation object.
      lat = typeof h.geolocation.getLatitude === 'function' ? Number(h.geolocation.getLatitude()) : NaN;
      lon = typeof h.geolocation.getLongitude === 'function' ? Number(h.geolocation.getLongitude()) : NaN;
    }
    return { lat, lon };
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
