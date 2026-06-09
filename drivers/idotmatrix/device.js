'use strict';

const Homey = require('homey');
const IDMProtocol = require('../../lib/IDMProtocol');
const IDMClient = require('../../lib/IDMClient');
const IDMProbe = require('../../lib/IDMProbe');

class IDMDevice extends Homey.Device {

  async onInit() {
    this.log('iDotMatrix device initializing:', this.getName());
    const { id } = this.getData();
    const { address } = this.getStore();
    this.client = new IDMClient({
      homey: this.homey,
      uuid: id,
      address,
      onLog: (...a) => this.log(...a),
    });

    this.registerCapabilityListener('onoff', v => this._setOnOff(v));
    this.registerCapabilityListener('dim', v => this._setBrightness(v));

    this._connectInBackground();
  }

  async _connectInBackground() {
    try {
      await this.client.connect();
      await this.setAvailable();
      this.log('Connected to iDotMatrix');
      // Sync time on (re)connect — clock mode needs it.
      try { await this.client.write(IDMProtocol.buildSetTime(new Date())); } catch (e) { /* ignore */ }
    } catch (e) {
      this.log('Initial connect failed:', e.message);
      await this.setUnavailable(this.homey.__('error.disconnected') || 'Disconnected').catch(() => {});
      // The client's reconnect loop will keep trying via the disconnect handler;
      // but on initial failure there's no peripheral yet, so we retry here.
      setTimeout(() => this._connectInBackground(), 10000);
    }
  }

  async _setOnOff(value) {
    const cmd = value ? IDMProtocol.buildScreenOn() : IDMProtocol.buildScreenOff();
    await this.client.write(cmd);
  }

  async _setBrightness(value) {
    // dim: 0..1 → 5..100 percent (protocol min is 5)
    const percent = Math.max(5, Math.round(value * 100));
    await this.client.write(IDMProtocol.buildBrightness(percent));
    if (percent <= 5 && value === 0 && this.getCapabilityValue('onoff')) {
      // Optional: turning fully down does not power off; user can use onoff explicitly.
    }
  }

  // ---- public methods used by app-level Flow listeners ----

  async showText(text, { color = '#ff0000', mode = 1, speed = 95 } = {}) {
    const { r, g, b } = _parseColor(color);
    const buf = IDMProtocol.buildText(text || '', {
      mode, speed, colorMode: 1, r, g, b,
    });
    await this.client.write(buf, { withResponse: true });
  }

  _pixelSize() {
    const v = parseInt(this.getSetting('pixel_size'), 10);
    return Number.isFinite(v) && v > 0 ? v : 32;
  }

  async showImage(pngBuffer) {
    const payload = IDMProtocol.buildImagePayload(pngBuffer);
    await this.client.write(payload, { withResponse: true });
  }

  async showGif(gifBuffer) {
    const chunks = IDMProtocol.buildGifChunks(gifBuffer);
    await this.client.write(chunks, { withResponse: true });
  }

  async showClock({ style = 0, showDate = true, hour24 = true, color = '#ffffff' } = {}) {
    const { r, g, b } = _parseColor(color);
    // (Re-)sync time before showing the clock.
    try { await this.client.write(IDMProtocol.buildSetTime(new Date())); } catch (e) { /* ignore */ }
    await this.client.write(IDMProtocol.buildClock({
      style, visibleDate: showDate, hour24, r, g, b,
    }));
  }

  async setCountdown({ action = 1, minutes = 0, seconds = 0 } = {}) {
    await this.client.write(IDMProtocol.buildCountdown({ mode: action, minutes, seconds }));
  }

  async setScoreboard(a, b) {
    await this.client.write(IDMProtocol.buildScoreboard(a, b));
  }

  async chronograph(action = 1) {
    await this.client.write(IDMProtocol.buildChronograph(action));
  }

  async probeCapabilities() {
    if (!this.client.isConnected()) await this.client.connect();
    const topology = await IDMProbe.probeBleTopology(this.client.peripheral);
    const featureMatrix = await IDMProbe.probeFeatureMatrix(this.client, {
      onLog: (...a) => this.log('[probe]', ...a),
    });
    const result = {
      probedAt: new Date().toISOString(),
      device: topology.device,
      services: topology.services,
      features: featureMatrix.features,
      samples: featureMatrix.samples,
      notifications: featureMatrix.notifications,
    };
    const json = JSON.stringify(result, null, 2);
    this.log('Probe result:\n' + json);
    try {
      await this.setSettings({ probe_result: json });
    } catch (e) {
      this.log('Failed to persist probe result to settings:', e.message);
    }
    return result;
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('flip') && this.client.isConnected()) {
      await this.client.write(IDMProtocol.buildFlip(!!newSettings.flip));
    }
  }

  async onDeleted() {
    this.log('Device deleted, disconnecting');
    try { await this.client.disconnect(); } catch (e) { /* ignore */ }
  }
}

function _parseColor(input) {
  if (!input) return { r: 255, g: 255, b: 255 };
  // Accept '#rrggbb' or '#rgb' or 'rrggbb'
  let hex = String(input).replace(/^#/, '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (hex.length !== 6) return { r: 255, g: 255, b: 255 };
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

module.exports = IDMDevice;
