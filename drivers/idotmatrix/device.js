'use strict';

const Homey = require('homey');
const IDMProtocol = require('../../lib/IDMProtocol');
const IDMClient = require('../../lib/IDMClient');
const IDMProbe = require('../../lib/IDMProbe');
const Heartbeat = require('../../lib/Heartbeat');
const Playlist = require('../../lib/Playlist');
const WordClock = require('../../lib/WordClock');
const Weather = require('../../lib/Weather');

// fa03 ack pattern: 0x05 0x00 <cmd> <subcmd> 0x01. The image upload opcode
// uses cmd 0x01 with subcmd 0x00 (per-chunk accepted) or 0x03 (upload done).
function _isImageChunkAck(buf) {
  return buf && buf.length >= 5 && buf[0] === 0x05 && buf[2] === 0x01;
}
function _isGenericAck(buf) {
  return buf && buf.length >= 5 && buf[0] === 0x05 && buf[4] === 0x01;
}

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
      onConnected: () => this._onClientConnected(),
      onDisconnected: () => this._onClientDisconnected(),
    });

    this.registerCapabilityListener('onoff', v => this._setOnOff(v));
    this.registerCapabilityListener('dim', v => this._setBrightness(v));

    await this.setUnavailable(this.homey.__('error.disconnected') || 'Disconnected').catch(() => {});
    this.client.start();

    this.heartbeat = new Heartbeat({
      client: this.client,
      getBrightnessPercent: () => this._brightnessPercent(),
      intervalMs: 60_000,
      ackTimeoutMs: 2500,
      onSilentDeath: () => this.client._markDead('heartbeat ack timeout'),
      onLog: (...a) => this.log(...a),
    });

    // Periodic RSSI sample so settings + diagnostic export reflect a fresh value.
    this._rssiTimer = this.homey.setInterval(() => this._sampleRssi(), 90_000);
  }

  _brightnessPercent() {
    const dim = this.getCapabilityValue('dim');
    if (typeof dim !== 'number') return 50;
    return Math.max(5, Math.round(dim * 100));
  }

  async _sampleRssi() {
    if (!this.client.isConnected()) return;
    try {
      const rssi = await this.client.readRssi();
      if (typeof rssi === 'number') {
        await this.setSettings({ last_rssi: `${rssi} dBm` }).catch(() => {});
      }
    } catch (e) { /* ignore */ }
  }

  async _onClientConnected() {
    this.log('Connected to iDotMatrix');
    await this.setAvailable().catch(() => {});
    try { await this.client.write(IDMProtocol.buildSetTime(new Date())); } catch (e) { /* ignore */ }
    if (this.heartbeat) this.heartbeat.start();
    // Fire trigger card.
    try { await this._triggerConnectionEvent(true); } catch (e) { /* ignore */ }
  }

  async _onClientDisconnected() {
    await this.setUnavailable(this.homey.__('error.disconnected') || 'Disconnected').catch(() => {});
    try { await this._triggerConnectionEvent(false); } catch (e) { /* ignore */ }
  }

  async _triggerConnectionEvent(connected) {
    const cardId = connected ? 'device_connected' : 'device_disconnected';
    try {
      const card = this.homey.flow.getDeviceTriggerCard(cardId);
      if (card) await card.trigger(this, {}, {});
    } catch (e) { /* card may not be registered yet */ }
  }

  async _setOnOff(value) {
    const cmd = value ? IDMProtocol.buildScreenOn() : IDMProtocol.buildScreenOff();
    await this.client.write(cmd);
  }

  async _setBrightness(value) {
    const percent = Math.max(5, Math.round(value * 100));
    await this.client.write(IDMProtocol.buildBrightness(percent));
  }

  async showText(text, { color = '#ff0000', mode = 1, speed = 95, mirror = false, colorMode = 1 } = {}) {
    const { r, g, b } = _parseColor(color);
    const buf = IDMProtocol.buildText(text || '', {
      mode, speed, colorMode, r, g, b, mirror: !!mirror,
    });
    await this.client.write(buf, { withResponse: true });
  }

  /** Fill the whole display with a solid RGB color (instant single opcode). */
  async showSolidColor(color) {
    const { r, g, b } = _parseColor(color);
    await this.client.write(IDMProtocol.buildFullscreenColor(r, g, b));
  }

  /** Trigger one of the device's 7 built-in animated effect styles (0-6). */
  async showEffect(style, colors = [[255, 0, 0], [0, 0, 255]]) {
    await this.client.write(IDMProtocol.buildEffect(style, colors));
  }

  /** Blink between color and black `times` cycles. */
  async flash({ color = '#ffffff', times = 5, onMs = 150, offMs = 150 } = {}) {
    const c = _parseColor(color);
    for (let i = 0; i < times; i++) {
      await this.client.write(IDMProtocol.buildFullscreenColor(c.r, c.g, c.b));
      await new Promise(r => setTimeout(r, onMs));
      await this.client.write(IDMProtocol.buildFullscreenColor(0, 0, 0));
      if (i < times - 1) await new Promise(r => setTimeout(r, offMs));
    }
  }

  /** Procedural alignment pattern: checkerboard + corner markers + center cross. */
  async showTestPattern() {
    const size = this._pixelSize();
    const png = await _renderTestPatternPng(size);
    await this.showImage(png);
  }

  /** "It is twenty past seven" style time in EN/DE/NL. */
  async showWordClock({ locale = 'en', color = '#ffffff', mode = 1, mirror = false } = {}) {
    const text = WordClock.format(locale, new Date());
    await this.showText(text, { color, mode, speed: 90, mirror });
  }

  /** Fetch temperature from open-meteo and scroll "21°C *" style. */
  async showWeather({ latitude, longitude, units = 'celsius', color = '#80c0ff', mode = 1, mirror = false } = {}) {
    const w = await Weather.fetchCurrent({ latitude, longitude, units });
    const text = `${Math.round(w.temperature)}${w.temperatureUnit} ${w.icon}`;
    await this.showText(text, { color, mode, speed: 90, mirror });
  }

  _pixelSize() {
    const v = parseInt(this.getSetting('pixel_size'), 10);
    return Number.isFinite(v) && v > 0 ? v : 32;
  }

  /**
   * Send a prepared PNG buffer (already at display resolution) to the device.
   * Optionally ack-gated on the per-chunk notification for reliability.
   */
  async showImage(pngBuffer, { ackGated = true } = {}) {
    await this.client.write(IDMProtocol.buildDiyMode(1));
    await new Promise(r => setTimeout(r, 50));
    const payload = IDMProtocol.buildImagePayload(pngBuffer);
    await this.client.write(payload, {
      withResponse: false,
      ackPredicate: ackGated ? _isImageChunkAck : null,
      ackTimeoutMs: 2500,
    });
  }

  /**
   * Send a prepared GIF (already at display resolution). The protocol's GIF
   * upload uses per-chunk Buffers, so we ack-gate between Buffers if enabled.
   */
  async showGif(gifBuffer, { ackGated = true } = {}) {
    await this.client.write(IDMProtocol.buildDiyMode(1));
    await new Promise(r => setTimeout(r, 50));
    const chunks = IDMProtocol.buildGifChunks(gifBuffer);
    await this.client.write(chunks, {
      withResponse: false,
      ackPredicate: ackGated ? _isImageChunkAck : null,
      ackTimeoutMs: 2500,
    });
  }

  async showClock({ style = 0, showDate = true, hour24 = true, color = '#ffffff' } = {}) {
    const { r, g, b } = _parseColor(color);
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
    const rssi = await this.client.readRssi();
    const result = {
      probedAt: new Date().toISOString(),
      rssi,
      device: topology.device,
      services: topology.services,
      features: featureMatrix.features,
      samples: featureMatrix.samples,
      notifications: featureMatrix.notifications,
    };
    const json = JSON.stringify(result, null, 2);
    this.log('Probe result:\n' + json);
    try {
      await this.setSettings({
        probe_result: json,
        last_rssi: typeof rssi === 'number' ? `${rssi} dBm` : '',
      });
    } catch (e) {
      this.log('Failed to persist probe result to settings:', e.message);
    }
    return result;
  }

  /** Playlist control. */
  startPlaylist({ resolveItems, sendItem, intervalSeconds, shuffle }) {
    this.stopPlaylist();
    this.playlist = new Playlist({
      device: this,
      resolveItems,
      sendItem,
      intervalMs: (intervalSeconds || 10) * 1000,
      shuffle,
      onLog: (...a) => this.log(...a),
    });
    this.playlist.start();
  }

  stopPlaylist() {
    if (this.playlist) {
      this.playlist.stop();
      this.playlist = null;
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('flip') && this.client.isConnected()) {
      await this.client.write(IDMProtocol.buildFlip(!!newSettings.flip));
    }
  }

  async onDeleted() {
    this.log('Device deleted, disconnecting');
    this.stopPlaylist();
    if (this.heartbeat) this.heartbeat.stop();
    if (this._rssiTimer) this.homey.clearInterval(this._rssiTimer);
    try { await this.client.disconnect(); } catch (e) { /* ignore */ }
  }
}

async function _renderTestPatternPng(size) {
  const { Jimp } = require('jimp');
  const black = (((0 << 24) | (0 << 16) | (0 << 8) | 0xff) >>> 0);
  const img = new Jimp({ width: size, height: size, color: black });
  // Checkerboard
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const on = ((x >> 2) + (y >> 2)) & 1;
      const v = on ? 64 : 0;
      img.setPixelColor((((v << 24) | (v << 16) | (v << 8) | 0xff) >>> 0), x, y);
    }
  }
  // Corner markers
  const corners = [
    [0, 0, 0xff0000ff],
    [size - 3, 0, 0x00ff00ff],
    [0, size - 3, 0x0000ffff],
    [size - 3, size - 3, 0xffffffff],
  ];
  for (const [cx, cy, color] of corners) {
    for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
      img.setPixelColor(color >>> 0, cx + dx, cy + dy);
    }
  }
  // Center yellow cross
  const c = Math.floor(size / 2);
  const yellow = 0xffff00ff;
  for (let i = -3; i <= 3; i++) {
    img.setPixelColor(yellow >>> 0, c, c + i);
    img.setPixelColor(yellow >>> 0, c + i, c);
  }
  return img.getBuffer('image/png', { colorType: 2, deflateLevel: 9 });
}

function _parseColor(input) {
  if (!input) return { r: 255, g: 255, b: 255 };
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
