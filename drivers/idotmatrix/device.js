'use strict';

const Homey = require('homey');
const IDMProtocol = require('../../lib/IDMProtocol');
const IDMClient = require('../../lib/IDMClient');
const IDMProbe = require('../../lib/IDMProbe');
const Heartbeat = require('../../lib/Heartbeat');
const RssiHistory = require('../../lib/RssiHistory');
const Playlist = require('../../lib/Playlist');
const WordClock = require('../../lib/WordClock');
const Weather = require('../../lib/Weather');
const Animations = require('../../lib/Animations');
const BrightnessCurve = require('../../lib/BrightnessCurve');
const Screensaver = require('../../lib/Screensaver');
const Font = require('../../lib/font8x16');

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

    // Migrate existing paired devices: newly-introduced capabilities have to
    // be added explicitly, otherwise the device card stays on the old layout
    // (just onoff was the symptom in v0.8.0).
    for (const cap of ['light_hue', 'light_saturation', 'idm_mode']) {
      if (!this.hasCapability(cap)) {
        try { await this.addCapability(cap); }
        catch (e) { this.log('addCapability failed for', cap, ':', e.message); }
      }
    }
    // Remove the old light_mode if it slipped in from a previous version.
    if (this.hasCapability('light_mode')) {
      try { await this.removeCapability('light_mode'); } catch (e) { /* ignore */ }
    }

    this.registerCapabilityListener('onoff', v => this._setOnOff(v));
    this.registerCapabilityListener('dim', v => this._setBrightness(v));
    this.registerCapabilityListener('idm_mode', v => this._setMode(v));

    // Color picker: hue + saturation arrive together. Batch them so we send
    // exactly one fullscreen-color command per pick.
    this.registerMultipleCapabilityListener(
      ['light_hue', 'light_saturation'],
      async values => {
        const h = typeof values.light_hue === 'number'
          ? values.light_hue : (this.getCapabilityValue('light_hue') || 0);
        const s = typeof values.light_saturation === 'number'
          ? values.light_saturation : (this.getCapabilityValue('light_saturation') || 1);
        const { r, g, b } = _hsvToRgb(h, s, 1);
        try { await this.client.write(IDMProtocol.buildFullscreenColor(r, g, b)); }
        catch (e) { this.error('color set failed:', e.message); }
      },
      300,
    );

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
    this.rssiHistory = new RssiHistory(120); // 120 samples × 30 s = 1 h
    this._rssiTimer = this.homey.setInterval(() => this._sampleRssi(), 30_000);

    // Day/night brightness curve — opt-in via settings, polls every minute.
    this.brightnessCurve = new BrightnessCurve({
      device: this, client: this.client, onLog: (...a) => this.log(...a),
    });
    this.brightnessCurve.start();

    this.screensaver = new Screensaver({
      device: this, client: this.client, onLog: (...a) => this.log(...a),
    });
    this.screensaver.start();
  }

  /** Called by every user-initiated content method to reset the idle clock. */
  _touchActivity() {
    if (this.screensaver) this.screensaver.touch();
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
        if (this.rssiHistory) this.rssiHistory.push(rssi);
        await this.setSettings({ last_rssi: `${rssi} dBm` }).catch(() => {});
      }
    } catch (e) { /* ignore */ }
  }

  /** Default text color from device settings, fallback to user-supplied. */
  _defaultColor(fallback = '#ffffff') {
    return (this.getSetting('default_color') || '').trim() || fallback;
  }

  /**
   * BLE upload throughput probe. Sends a fixed sequence of write-without-
   * response writes, measures total time, returns bytes/sec.
   */
  async measureBleSpeed({ sizeBytes = 4000, chunkSize = 200 } = {}) {
    if (!this.client.isConnected()) await this.client.connect();
    const buf = Buffer.alloc(sizeBytes, 0);
    // Pretend it's a clock command so the device ignores the payload but
    // still buffers the bytes. Actually use buildDiyMode then nothing —
    // safer: do raw writes that the device will discard for being malformed.
    const start = Date.now();
    try {
      // Write the payload chunk by chunk via the underlying char,
      // bypassing the protocol layer so we measure pure BLE throughput.
      for (let i = 0; i < buf.length; i += chunkSize) {
        const slice = buf.subarray(i, i + chunkSize);
        await this.client.writeChar.write(slice, true); // withoutResponse=true
      }
    } catch (e) {
      throw new Error(`speed test write failed: ${e.message}`);
    }
    const ms = Date.now() - start;
    return {
      bytes: buf.length,
      ms,
      bytesPerSecond: Math.round((buf.length / ms) * 1000),
      kbps: Math.round((buf.length * 8 / ms)),
    };
  }

  async _onClientConnected() {
    this.log('Connected to iDotMatrix');
    await this.setAvailable().catch(() => {});
    try { await this.client.write(IDMProtocol.buildSetTime(new Date())); } catch (e) { /* ignore */ }
    if (this.heartbeat) this.heartbeat.start();
    this._updateConnectionDiagnostics();
    // Fire trigger card.
    try { await this._triggerConnectionEvent(true); } catch (e) { /* ignore */ }
  }

  async _onClientDisconnected() {
    await this.setUnavailable(this.homey.__('error.disconnected') || 'Disconnected').catch(() => {});
    // Pause the heartbeat while the link is down — the reconnect loop is the
    // single source of truth for getting us back, and a heartbeat write
    // against a disconnected client would just queue, wait 15s and fail.
    if (this.heartbeat) this.heartbeat.stop();
    this._updateConnectionDiagnostics();
    try { await this._triggerConnectionEvent(false); } catch (e) { /* ignore */ }
  }

  /** Push a snapshot of the BLE connection state into device settings. */
  _updateConnectionDiagnostics() {
    if (!this.client || typeof this.client.getConnectionState !== 'function') return;
    const s = this.client.getConnectionState();
    const fmt = ts => (ts ? new Date(ts).toISOString() : '—');
    this.setSettings({
      last_connected_at: fmt(s.lastConnectedAt),
      last_disconnected_at: fmt(s.lastDisconnectedAt),
      reconnect_attempts: String(s.reconnectAttempt),
      last_disconnect_reason: s.lastError || '—',
    }).catch(() => { /* settings field may not exist on older installs */ });
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

  /** Mode-picker listener — runs the relevant built-in display mode. */
  async _setMode(mode) {
    try {
      switch (mode) {
        case 'clock':       return this.showClock({});
        case 'countdown':   return this.setCountdown({ action: 1, minutes: 5, seconds: 0 });
        case 'scoreboard':  return this.setScoreboard(0, 0);
        case 'chronograph': return this.chronograph(1);
        case 'rainbow_h':   return this.showEffect(0);
        case 'rainbow_v':   return this.showEffect(3);
        case 'random_px':   return this.showEffect(6);
        case 'color': {
          const h = this.getCapabilityValue('light_hue') || 0;
          const s = this.getCapabilityValue('light_saturation') || 1;
          const { r, g, b } = _hsvToRgb(h, s, 1);
          return this.client.write(IDMProtocol.buildFullscreenColor(r, g, b));
        }
        case 'music_sync':  return this.startMusicSync(1);
        case 'test':        return this.showTestPattern();
        default:            return;
      }
    } catch (e) {
      this.error('_setMode failed:', e.message);
    }
  }

  async showText(text, { color, mode = 1, speed = 95, mirror = false, colorMode = 1 } = {}) {
    const { r, g, b } = _parseColor(color || this._defaultColor('#ff0000'));
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

  /** Play a procedural animation (matrix, gol, dvd, plasma, starfield, fireworks). */
  /** Music-sync visualization driven by the device's built-in microphone. */
  async startMusicSync(type = 1) {
    await this.client.write(IDMProtocol.buildMusicSyncStart(type));
  }
  async stopMusicSync() {
    await this.client.write(IDMProtocol.buildMusicSyncStop());
  }

  async showAnimation(name) {
    const size = this._pixelSize();
    let gif;
    if (name && name.startsWith('plasma:')) {
      const variant = name.slice('plasma:'.length);
      gif = Animations.plasmaVariant(size, 30, variant);
    } else {
      const fn = Animations[name];
      if (!fn) throw new Error(`unknown animation: ${name}`);
      gif = fn(size);
    }
    await this.showGif(gif);
    this._logActivity({ type: 'animation', name });
  }

  /** "X days since/until [date]" big-digit display. */
  async showDayCounter({ targetIso, mode = 'until', color = '#00ff44' } = {}) {
    const t = new Date(targetIso);
    if (!Number.isFinite(t.getTime())) throw new Error('invalid date');
    const now = new Date();
    const oneDay = 24 * 60 * 60 * 1000;
    const days = mode === 'since'
      ? Math.max(0, Math.floor((now - t) / oneDay))
      : Math.max(0, Math.ceil((t - now) / oneDay));
    const size = this._pixelSize();
    const c = _parseColor(color);
    const gif = Animations.dayCounter(size, days, '', _packRgb(c.r, c.g, c.b), 0x000000);
    await this.showGif(gif);
  }

  /** Show 2-3 lines of text statically stacked (rendered as a PNG image). */
  async showMultilineText(lines, { color = '#ffffff', background = '#000000' } = {}) {
    const size = this._pixelSize();
    const png = await _renderMultilinePng(size, lines.filter(Boolean), _parseColor(color), _parseColor(background));
    await this.showImage(png);
  }

  /** Show the current date in the given format. */
  async showDate({ format = 'dd.MM', color = '#ffffff', mode = 0, mirror = false, locale = 'en' } = {}) {
    const text = _formatDate(new Date(), format, locale);
    if (mode === 0) {
      // Static — render as PNG so it doesn't scroll
      await this.showMultilineText([text], { color });
    } else {
      await this.showText(text, { color, mode, speed: 90, mirror });
    }
  }

  /** Show a countdown to a future ISO timestamp. */
  async showCountdownTo({ targetIso, label = '', color = '#ffffff', mode = 1, mirror = false } = {}) {
    const t = new Date(targetIso);
    if (!Number.isFinite(t.getTime())) throw new Error('invalid target time');
    const text = _formatTimeUntil(t, label);
    await this.showText(text, { color, mode, speed: 90, mirror });
  }

  /** Pick a random sticker from the bundled pack and show it. */
  async showRandomSticker() {
    const stickers = await this.homey.app.stickers.list();
    if (!stickers.length) throw new Error('no stickers available');
    const pick = stickers[Math.floor(Math.random() * stickers.length)];
    const buf = await this.homey.app.stickers.read(pick.name);
    await this.homey.app._renderImage(this, buf, { kind: 'auto', fit: 'center', sourceLabel: `sticker/${pick.name}` });
    this._logActivity({ type: 'sticker', name: pick.name });
  }

  /** Show a horizontal progress bar. */
  async showProgressBar(percent, fg = '#00ff44', bg = '#222222') {
    const c = _parseColor(fg);
    const b = _parseColor(bg);
    const size = this._pixelSize();
    const gif = Animations.progressBar(
      size, percent,
      _packRgb(c.r, c.g, c.b),
      _packRgb(b.r, b.g, b.b),
      0xffffff,
    );
    await this.showGif(gif);
  }

  /** Show a meter: value/max as a horizontal bar plus optional value text. */
  async showMeter(value, max, { color = '#00ff44', bg = '#222222' } = {}) {
    const percent = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
    await this.showProgressBar(percent, color, bg);
  }

  /**
   * Show one piece of content, then automatically restore something else after
   * a delay. If `restore` is 'off' → screen off; 'clock' → clock; 'black' →
   * solid black; 'effect:N' → built-in effect N.
   */
  async showTemporarily(showFn, seconds, restore = 'black') {
    try {
      await showFn();
      this._scheduleRestore(seconds, restore);
    } catch (e) {
      this.error('showTemporarily:', e.message);
      throw e;
    }
  }

  _scheduleRestore(seconds, restore) {
    if (this._restoreTimer) clearTimeout(this._restoreTimer);
    const myTimer = setTimeout(async () => {
      // Only null the field if this is still the active timer — a follow-up
      // showTemporarily() may have replaced it while our async work was
      // already pending in the event loop.
      if (this._restoreTimer === myTimer) this._restoreTimer = null;
      try {
        if (restore === 'off') {
          await this._setOnOff(false);
        } else if (restore === 'clock') {
          await this.showClock({});
        } else if (restore && restore.startsWith('effect:')) {
          const n = parseInt(restore.slice(7), 10);
          await this.showEffect(n);
        } else {
          await this.showSolidColor('#000000');
        }
      } catch (e) {
        this.error('auto-restore failed:', e.message);
      }
    }, Math.max(1, seconds) * 1000);
    this._restoreTimer = myTimer;
  }

  /**
   * Play a small sequence of items with delays in between. Each item is
   * `{ type, value, delayMs }` — supported types:
   *   text          — value = text
   *   color         — value = hex color
   *   sticker       — value = filename (resolved via app.stickers)
   *   animation     — value = animation name
   *   effect        — value = style index
   *   off / on      — toggle screen
   */
  async playSequence(steps, { loop = false } = {}) {
    const run = async () => {
      for (const s of steps) {
        if (this._sequenceStopped) return;
        try {
          await this._runSequenceStep(s);
        } catch (e) {
          this.error('[sequence]', s, e.message);
        }
        if (this._sequenceStopped) return;
        if (s.delayMs) {
          // Interruptible sleep so stopSequence() takes effect immediately
          // instead of waiting out a multi-second delay.
          await this._interruptibleDelay(s.delayMs);
        }
      }
    };
    do {
      await run();
    } while (loop && !this._sequenceStopped);
  }

  _interruptibleDelay(ms) {
    return new Promise(resolve => {
      const step = 100;
      const start = Date.now();
      const check = () => {
        if (this._sequenceStopped || Date.now() - start >= ms) return resolve();
        setTimeout(check, step);
      };
      check();
    });
  }

  stopSequence() { this._sequenceStopped = true; }

  async _runSequenceStep(s) {
    switch (s.type) {
      case 'text':       return this.showText(s.value || '', s.opts || {});
      case 'color':      return this.showSolidColor(s.value);
      case 'animation':  return this.showAnimation(s.value);
      case 'effect':     return this.showEffect(parseInt(s.value, 10));
      case 'sticker':    {
        const app = this.homey.app;
        if (!app.stickers) throw new Error('sticker pack unavailable');
        const buf = await app.stickers.read(s.value);
        await this.showImage(buf);
        return;
      }
      case 'on':         return this._setOnOff(true);
      case 'off':        return this._setOnOff(false);
      default: throw new Error(`unknown step type: ${s.type}`);
    }
  }

  _logActivity(event) {
    if (this.homey.app && this.homey.app.activity) {
      this.homey.app.activity.add({
        device: this.getName(),
        ...event,
      });
    }
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
    if (pngBuffer.length > IDMProtocol.MAX_IMAGE_BYTES) {
      throw new Error(`image too large: ${pngBuffer.length} bytes (max ${IDMProtocol.MAX_IMAGE_BYTES})`);
    }
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
    if (gifBuffer.length > IDMProtocol.MAX_IMAGE_BYTES) {
      throw new Error(`gif too large: ${gifBuffer.length} bytes (max ${IDMProtocol.MAX_IMAGE_BYTES})`);
    }
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

  /**
   * Run the AE-service reverse-engineering probe — sends a series of safe
   * fingerprint patterns to ae01 and records what comes back on ae02.
   *
   * NOTE: the AE-service reverse-engineering Flow cards have been removed
   * from the user-facing UI (see docs/AE-SERVICE.md for findings). The
   * lib/IDMProbe.js functions remain available for future investigation.
   */

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
    await this._teardown();
  }

  /**
   * Homey calls onUninit when the app is being stopped or upgraded without
   * deleting the device. Mirror the cleanup so timers and the reconnect loop
   * don't leak across app restarts.
   */
  async onUninit() {
    this.log('Device uninitializing');
    await this._teardown();
  }

  async _teardown() {
    this.stopPlaylist();
    this.stopSequence();
    if (this._restoreTimer) { clearTimeout(this._restoreTimer); this._restoreTimer = null; }
    if (this.heartbeat) this.heartbeat.stop();
    if (this.brightnessCurve) this.brightnessCurve.stop();
    if (this.screensaver) this.screensaver.stop();
    if (this._rssiTimer) { this.homey.clearInterval(this._rssiTimer); this._rssiTimer = null; }
    try { if (this.client) await this.client.disconnect(); } catch (e) { /* ignore */ }
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

/**
 * Render N text lines stacked vertically into a single PNG, using the
 * built-in 5×7 font scaled to fit. 1 line → ~3× scale, 2 → ~2×, 3+ → 1×.
 */
async function _renderMultilinePng(size, lines, fg, bg) {
  const { Jimp } = require('jimp');
  const bgInt = (((bg.r << 24) | (bg.g << 16) | (bg.b << 8) | 0xff) >>> 0);
  const fgInt = (((fg.r << 24) | (fg.g << 16) | (fg.b << 8) | 0xff) >>> 0);
  const img = new Jimp({ width: size, height: size, color: bgInt });
  const n = Math.max(1, lines.length);
  // Pick a per-pixel scale based on how many lines fit; keep at least 5 px row height per line.
  const charH = 7; // base glyph height
  const totalRowsAvail = size - 2;
  const scale = Math.max(1, Math.floor(totalRowsAvail / (charH * n + (n - 1))));
  const lineH = charH * scale;
  const charW = 5 * scale + scale; // 5 px glyph + 1 px tracking
  const totalH = lineH * n + (n - 1) * scale;
  const startY = Math.floor((size - totalH) / 2);
  for (let li = 0; li < n; li++) {
    const text = String(lines[li] || '');
    const width = text.length * charW;
    let x = Math.max(0, Math.floor((size - width) / 2));
    const y = startY + li * (lineH + scale);
    for (const ch of text) {
      const glyph = Font.getGlyph ? Font.getGlyph(ch) : null;
      if (glyph) _blitGlyph(img, glyph, x, y, scale, fgInt);
      x += charW;
    }
  }
  return img.getBuffer('image/png', { colorType: 2, deflateLevel: 9 });
}

function _blitGlyph(img, glyphRows, x0, y0, scale, color) {
  for (let r = 0; r < 7; r++) {
    const row = glyphRows[r] || 0;
    for (let c = 0; c < 5; c++) {
      if (!((row >> (4 - c)) & 1)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = x0 + c * scale + dx;
          const py = y0 + r * scale + dy;
          if (px >= 0 && px < img.width && py >= 0 && py < img.height) {
            img.setPixelColor(color >>> 0, px, py);
          }
        }
      }
    }
  }
}

/** Format a Date per a simple token string (dd, MM, yyyy, EEE). */
function _formatDate(d, fmt, locale) {
  const pad2 = n => String(n).padStart(2, '0');
  const dows = {
    en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    de: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
    nl: ['Zo', 'Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za'],
  };
  const dow = (dows[locale] || dows.en)[d.getDay()];
  return String(fmt || 'dd.MM')
    .replace(/yyyy/g, String(d.getFullYear()))
    .replace(/yy/g, pad2(d.getFullYear() % 100))
    .replace(/MM/g, pad2(d.getMonth() + 1))
    .replace(/M/g, String(d.getMonth() + 1))
    .replace(/dd/g, pad2(d.getDate()))
    .replace(/d/g, String(d.getDate()))
    .replace(/EEE/g, dow);
}

/** "in 2h 15m", "2d 3h", "1m 20s" — short human-readable countdown. */
function _formatTimeUntil(target, label) {
  let s = Math.max(0, Math.round((target.getTime() - Date.now()) / 1000));
  if (s === 0) return label ? `${label} now` : 'now';
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600);  s -= h * 3600;
  const m = Math.floor(s / 60);    s -= m * 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${h}h`);
  if (!d) parts.push(`${m}m`);
  if (!d && !h) parts.push(`${s}s`);
  return label ? `${label}: ${parts.join(' ')}` : parts.join(' ');
}

function _hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q;
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

function _packRgb(r, g, b) {
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
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
