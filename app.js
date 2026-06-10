'use strict';

const Homey = require('homey');
const path = require('path');
const MediaStore = require('./lib/MediaStore');
const RemoteMediaIndex = require('./lib/RemoteMediaIndex');
const StickerPack = require('./lib/StickerPack');
const { ImagePipeline, isGif } = require('./lib/ImagePipeline');
const DiagnosticBundle = require('./lib/DiagnosticBundle');

async function _fetchUrlBuffer(url, { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } finally {
    clearTimeout(t);
  }
}

class IDMApp extends Homey.App {

  async onInit() {
    this.diagnostics = new DiagnosticBundle(this);
    this._wrapLog();
    this.log('iDotMatrix app starting');

    this.media = new MediaStore(this);
    await this.media.init();
    if (this.media.dir) {
      this.log(`media store ready at ${this.media.dir}`);
      this.log('upload media via:  POST http://<homey-ip>/api/app/com.idotmatrix/media/<filename>');
    }

    this.stickers = new StickerPack(__dirname);
    const stickerList = await this.stickers.list();
    this.log(`sticker pack: ${stickerList.length} bundled assets`);

    this.imagePipeline = new ImagePipeline({ logger: (...a) => this.log('[pipeline]', ...a) });

    this._registerFlowActions();
    this._registerFlowTriggers();
    this._registerFlowConditions();
  }

  _wrapLog() {
    // Newer Homey SDKs mark this.log/this.error non-writable. We try to wrap
    // them so every log line lands in the diagnostic ring buffer; if the
    // property is locked, the diagnostic bundle still works for explicit
    // push() calls from inside this app — we just won't auto-capture log()
    // output from other parts of the SDK.
    const origLog = this.log.bind(this);
    const origError = this.error.bind(this);
    const wrappedLog = (...a) => { this.diagnostics.pushLog('log', a); origLog(...a); };
    const wrappedError = (...a) => { this.diagnostics.pushLog('error', a); origError(...a); };
    for (const [name, fn] of [['log', wrappedLog], ['error', wrappedError]]) {
      try {
        Object.defineProperty(this, name, {
          value: fn,
          writable: true,
          configurable: true,
          enumerable: false,
        });
      } catch (e) {
        // Property locked by the SDK — skip silently.
      }
    }
  }

  _registerFlowActions() {
    const card = id => this.homey.flow.getActionCard(id);
    const fire = (id, handler) => {
      card(id).registerRunListener(async args => {
        // All image / display actions run async to dodge the 10s Flow timeout.
        // Errors are logged on the device so the user can find them.
        Promise.resolve()
          .then(() => handler.call(this, args))
          .catch(err => args.device && args.device.error && args.device.error(`${id} failed: ${err.message}`));
      });
    };

    fire('show_text', async args => {
      await args.device.showText(args.text, {
        color: args.color,
        mode: parseInt(args.mode, 10),
        speed: parseInt(args.speed, 10),
      });
    });

    // ---- image cards ----

    fire('show_image_url', async args => {
      const buf = await _fetchUrlBuffer(args.url);
      await this._renderImage(args.device, buf, {
        kind: args.kind,
        fit: args.fit,
        background: args.background,
        dither: args.dither,
        sourceLabel: args.url,
      });
    });

    fire('show_stored_image', async args => {
      const name = args.file && args.file.name;
      if (!name) throw new Error('no file selected');
      const buf = await this.media.read(name);
      await this._renderImage(args.device, buf, {
        kind: 'auto',
        fit: args.fit,
        background: args.background,
        dither: args.dither,
        sourceLabel: `store/${name}`,
      });
    });

    fire('show_remote_image', async args => {
      const baseUrl = args.device.getSetting('media_base_url');
      if (!baseUrl) throw new Error('media_base_url not set on device');
      const name = args.file && args.file.name;
      if (!name) throw new Error('no file selected');
      const { buffer, url } = await RemoteMediaIndex.fetchFile(baseUrl, name);
      await this._renderImage(args.device, buffer, {
        kind: 'auto',
        fit: args.fit,
        background: args.background,
        dither: args.dither,
        sourceLabel: url,
      });
    });

    fire('show_sticker', async args => {
      const name = args.sticker && args.sticker.name;
      if (!name) throw new Error('no sticker selected');
      const buf = await this.stickers.read(name);
      await this._renderImage(args.device, buf, {
        kind: 'auto',
        fit: args.fit || 'center',
        background: args.background,
        sourceLabel: `sticker/${name}`,
      });
    });

    fire('show_sensor_value', async args => {
      const label = (args.label || '').trim();
      const value = args.value;
      const unit = (args.unit || '').trim();
      const text = [label, _formatValue(value, args.decimals), unit].filter(Boolean).join(' ').trim();
      await args.device.showText(text, {
        color: args.color || '#ffffff',
        mode: 1,
        speed: parseInt(args.speed, 10) || 95,
      });
    });

    fire('show_notification', async args => {
      const text = (args.message || '').trim();
      await args.device.showText(text, {
        color: args.color || '#ffaa00',
        mode: 1,
        speed: parseInt(args.speed, 10) || 80,
      });
    });

    // ---- playlist cards ----

    fire('playlist_start_remote', async args => {
      const baseUrl = args.device.getSetting('media_base_url');
      if (!baseUrl) throw new Error('media_base_url not set on device');
      args.device.startPlaylist({
        resolveItems: async () => (await RemoteMediaIndex.list(baseUrl)).map(i => i.name),
        sendItem: async name => {
          const { buffer } = await RemoteMediaIndex.fetchFile(baseUrl, name);
          await this._renderImage(args.device, buffer, {
            kind: 'auto', fit: args.fit, background: args.background, sourceLabel: name,
          });
        },
        intervalSeconds: parseInt(args.interval_seconds, 10),
        shuffle: !!args.shuffle,
      });
    });

    fire('playlist_start_store', async args => {
      args.device.startPlaylist({
        resolveItems: async () => (await this.media.list()).map(i => i.name),
        sendItem: async name => {
          const buf = await this.media.read(name);
          await this._renderImage(args.device, buf, {
            kind: 'auto', fit: args.fit, background: args.background, sourceLabel: name,
          });
        },
        intervalSeconds: parseInt(args.interval_seconds, 10),
        shuffle: !!args.shuffle,
      });
    });

    fire('playlist_stop', async args => {
      args.device.stopPlaylist();
    });

    // ---- other ----

    fire('show_clock', async args => {
      await args.device.showClock({
        style: parseInt(args.style, 10),
        showDate: !!args.show_date,
        hour24: !!args.hour24,
        color: args.color,
      });
    });

    fire('start_countdown', async args => {
      await args.device.setCountdown({
        action: parseInt(args.action, 10),
        minutes: parseInt(args.minutes, 10),
        seconds: parseInt(args.seconds, 10),
      });
    });

    fire('set_scoreboard', async args => {
      await args.device.setScoreboard(parseInt(args.score_a, 10), parseInt(args.score_b, 10));
    });

    fire('chronograph', async args => {
      await args.device.chronograph(parseInt(args.action, 10));
    });

    fire('probe_capabilities', async args => {
      await args.device.probeCapabilities();
    });

    // Sticker autocomplete
    card('show_sticker').registerArgumentAutocompleteListener('sticker', async query => {
      const items = await this.stickers.list();
      const q = String(query || '').toLowerCase();
      return items
        .filter(i => !q || i.name.toLowerCase().includes(q))
        .map(i => ({ name: i.name, description: 'bundled' }));
    });

    // Remote-server file autocomplete
    card('show_remote_image').registerArgumentAutocompleteListener('file', async (query, args) => {
      const baseUrl = args.device.getSetting('media_base_url');
      if (!baseUrl) {
        return [{ name: '(no URL configured)', description: 'Open device settings → Remote media server' }];
      }
      try {
        const items = await RemoteMediaIndex.list(baseUrl);
        const q = String(query || '').toLowerCase();
        return items
          .filter(i => !q || i.name.toLowerCase().includes(q))
          .slice(0, 50)
          .map(i => ({ name: i.name, description: i.size ? `${(i.size / 1024).toFixed(1)} KB` : baseUrl }));
      } catch (e) {
        return [{ name: `(error: ${e.message})`, description: baseUrl }];
      }
    });

    // Stored-file autocomplete
    card('show_stored_image').registerArgumentAutocompleteListener('file', async query => {
      const items = await this.media.list();
      const q = String(query || '').toLowerCase();
      return items
        .filter(i => !q || i.name.toLowerCase().includes(q))
        .map(i => ({ name: i.name, description: `${(i.size / 1024).toFixed(1)} KB` }));
    });
  }

  _registerFlowTriggers() {
    // Triggers are configured via app.json; we just need to grab handles so
    // device.js can call .trigger(device, tokens, state).
    this._triggers = {
      connected: this.homey.flow.getDeviceTriggerCard('device_connected'),
      disconnected: this.homey.flow.getDeviceTriggerCard('device_disconnected'),
    };
  }

  _registerFlowConditions() {
    const card = id => this.homey.flow.getConditionCard(id);
    card('is_connected').registerRunListener(async args => {
      return args.device && args.device.client && args.device.client.isConnected();
    });
    card('brightness_above').registerRunListener(async args => {
      const dim = args.device.getCapabilityValue('dim');
      const threshold = parseFloat(args.percent) / 100;
      return typeof dim === 'number' && dim > threshold;
    });
  }

  /**
   * Unified rendering path. Every image source — URL, remote server, local
   * store, sticker pack — goes through this so behaviour, caching, fit
   * options and conversion are identical regardless of where the bytes
   * came from.
   */
  async _renderImage(device, buf, opts = {}) {
    const log = (...m) => device.log('[image]', ...m);
    const t0 = Date.now();
    const sourceLabel = opts.sourceLabel || '(unnamed)';
    log(`source=${sourceLabel} bytes=${buf.length} magic=${buf.slice(0, 4).toString('hex')}`);

    const kind = opts.kind || 'auto';
    const looksGif = isGif(buf);
    const treatAsGif = kind === 'gif' || (kind === 'auto' && looksGif);

    const targetSize = device._pixelSize();
    const fit = opts.fit || 'contain';
    const background = opts.background || '#000000';

    // For static non-GIF input the pipeline returns a PNG buffer. For GIF
    // input it returns a resized animated GIF.
    const prepared = await this.imagePipeline.prepare(buf, {
      targetSize,
      fit,
      background,
      dither: !!opts.dither,
    });
    log(`prepared kind=${prepared.kind} bytes=${prepared.buffer.length} fromCache=${prepared.fromCache} in ${Date.now() - t0}ms`);

    const tBle = Date.now();
    if (treatAsGif && prepared.kind === 'gif') {
      await device.showGif(prepared.buffer);
    } else {
      // If user forced 'png' on a GIF, the pipeline still emitted gif; fall back
      // to converting the first frame via a one-shot static path. Otherwise just
      // send the PNG.
      if (prepared.kind === 'gif') {
        log('forced PNG mode but input was GIF — sending GIF as-is');
        await device.showGif(prepared.buffer);
      } else {
        await device.showImage(prepared.buffer);
      }
    }
    log(`BLE upload done in ${Date.now() - tBle}ms total ${Date.now() - t0}ms`);
  }
}

function _formatValue(value, decimals) {
  const d = parseInt(decimals, 10);
  const n = parseFloat(value);
  if (Number.isFinite(n) && Number.isFinite(d) && d >= 0) return n.toFixed(d);
  if (Number.isFinite(n)) return String(n);
  return String(value ?? '');
}

module.exports = IDMApp;
