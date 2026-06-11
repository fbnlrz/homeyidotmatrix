'use strict';

/**
 * Build a single JSON bundle that a tester can paste into a forum/GitHub
 * issue. Includes app metadata, every paired device's settings + probe
 * result, recent in-app log entries, and the image pipeline cache stats.
 */
class DiagnosticBundle {

  constructor(app) {
    this.app = app;
    this.maxLogEntries = 200;
    this.logBuffer = [];
  }

  /** Push a single log line into the rolling buffer. */
  pushLog(level, args) {
    this.logBuffer.push({
      ts: new Date().toISOString(),
      level,
      msg: args.map(a => (typeof a === 'string' ? a : _safeJson(a))).join(' '),
    });
    if (this.logBuffer.length > this.maxLogEntries) {
      this.logBuffer.shift();
    }
  }

  async build() {
    const manifest = this.app.homey.manifest || {};
    const driver = this.app.homey.drivers.getDriver('idotmatrix');
    const devices = driver ? driver.getDevices() : [];
    const deviceInfo = [];
    for (const device of devices) {
      let rssi = null;
      try {
        if (device.client && typeof device.client.readRssi === 'function') {
          rssi = await device.client.readRssi();
        }
      } catch (e) { /* ignore */ }
      let settings = {};
      try { settings = device.getSettings() || {}; } catch (e) { settings = {}; }
      // Don't dump the probe JSON twice — keep it but mark its size.
      const probeSize = (settings.probe_result || '').length;
      deviceInfo.push({
        name: device.getName(),
        id: device.getData() && device.getData().id,
        available: device.getAvailable ? device.getAvailable() : null,
        capabilities: device.getCapabilities ? device.getCapabilities() : null,
        capabilityValues: _captureCapValues(device),
        rssi,
        msSinceLastSeen: device.client && typeof device.client.msSinceLastSeen === 'function'
          ? device.client.msSinceLastSeen()
          : null,
        settings: {
          ...settings,
          // Truncate probe_result so the bundle stays paste-friendly.
          probe_result: probeSize > 4000
            ? settings.probe_result.slice(0, 4000) + `…(truncated ${probeSize - 4000} chars)`
            : settings.probe_result,
        },
      });
    }

    return {
      generatedAt: new Date().toISOString(),
      app: {
        id: manifest.id,
        version: manifest.version,
        compatibility: manifest.compatibility,
      },
      homey: {
        platform: this.app.homey.platform,
        version: this.app.homey.version,
      },
      devices: deviceInfo,
      imagePipeline: this.app.imagePipeline ? this.app.imagePipeline.stats() : null,
      logs: this.logBuffer.slice(-this.maxLogEntries),
    };
  }
}

function _captureCapValues(device) {
  if (!device.getCapabilities) return null;
  const out = {};
  for (const cap of device.getCapabilities()) {
    try { out[cap] = device.getCapabilityValue(cap); } catch { out[cap] = null; }
  }
  return out;
}

function _safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

module.exports = DiagnosticBundle;
