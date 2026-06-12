'use strict';

/**
 * Homey Web API endpoints for managing locally-stored media.
 *
 * Reachable at:
 *   GET    /api/app/com.idotmatrix/media          → list files
 *   POST   /api/app/com.idotmatrix/media/:name    → upload (body = raw bytes)
 *   DELETE /api/app/com.idotmatrix/media/:name    → delete
 *
 * Auth: Homey enforces the standard developer/session token on the API layer.
 * In `homey app run` dev mode, requests from localhost are usually accepted
 * without a token; for installed apps, use a Homey bearer token.
 *
 * Example uploads from a workstation:
 *   curl -X POST --data-binary @pumpkin.gif \
 *     http://<homey-ip>/api/app/com.idotmatrix/media/pumpkin.gif
 *
 *   # Powershell
 *   Invoke-RestMethod -Uri http://<homey-ip>/api/app/com.idotmatrix/media/pumpkin.gif `
 *     -Method Post -InFile pumpkin.gif -ContentType application/octet-stream
 */
module.exports = {

  async listMedia({ homey, query }) {
    const items = await homey.app.media.list();
    // Optional thumbnails (?withData=1) — small files inlined as data URLs so
    // the settings page can <img> them without a separate request per file.
    if (query && (query.withData === '1' || query.withData === 'true')) {
      for (const it of items) {
        if (it.size > 100 * 1024) continue; // skip oversized
        try {
          const buf = await homey.app.media.read(it.name);
          const ext = (it.name.split('.').pop() || 'png').toLowerCase();
          const mime = ext === 'gif' ? 'image/gif'
            : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
            : ext === 'bmp' ? 'image/bmp'
            : ext === 'webp' ? 'image/webp'
            : 'image/png';
          it.dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
        } catch (e) { /* skip on read error */ }
      }
    }
    return items;
  },

  async uploadMedia({ homey, params, body }) {
    const name = params.name;
    if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error('invalid filename: only letters, digits, dot, underscore and dash allowed');
    }
    let buf;
    if (Buffer.isBuffer(body)) {
      buf = body;
    } else if (body && body.type === 'Buffer' && Array.isArray(body.data)) {
      buf = Buffer.from(body.data);
    } else if (typeof body === 'string') {
      buf = Buffer.from(body, 'binary');
    } else if (body && typeof body === 'object') {
      // Homey may JSON-parse if Content-Type was application/json.
      throw new Error('Upload as raw bytes: set Content-Type: application/octet-stream and put file in body');
    } else {
      throw new Error('empty upload body');
    }
    return homey.app.media.write(name, buf);
  },

  async deleteMedia({ homey, params }) {
    await homey.app.media.remove(params.name);
    return { ok: true };
  },

  /**
   * Aggregate diagnostic dump. Returns app + device state, image-pipeline
   * cache stats, RSSI, recent log lines, last probe result per device — a
   * single JSON object that's safe to paste into a bug report.
   */
  async diagnostic({ homey }) {
    return homey.app.diagnostics.build();
  },

  /**
   * Live preview: take a PNG buffer from the settings-page editor and push
   * it to every paired iDotMatrix device without saving to the library.
   */
  async activityLog({ homey }) {
    return homey.app.activity ? homey.app.activity.list() : [];
  },

  async previewAnimation({ homey, params }) {
    return _broadcast(homey, dev => dev.showAnimation(params.name));
  },

  async previewEffect({ homey, params }) {
    return _broadcast(homey, dev => dev.showEffect(parseInt(params.style, 10)));
  },

  async previewSolidColor({ homey, body }) {
    const color = body && body.color ? body.color : '#ffffff';
    return _broadcast(homey, dev => dev.showSolidColor(color));
  },

  async rssiHistory({ homey }) {
    const driver = homey.drivers.getDriver('idotmatrix');
    const devices = driver ? driver.getDevices() : [];
    return devices
      .map(d => {
        const data = d.getData();
        if (!data || !data.id) return null;
        return {
          id: data.id,
          name: d.getName(),
          samples: d.rssiHistory ? d.rssiHistory.list() : [],
        };
      })
      .filter(Boolean);
  },

  async flowStats({ homey }) {
    return homey.app.flowStats ? homey.app.flowStats.list() : [];
  },

  async speedTest({ homey }) {
    const driver = homey.drivers.getDriver('idotmatrix');
    const devices = driver ? driver.getDevices() : [];
    // allSettled so one device's BLE failure doesn't skip the rest.
    const settled = await Promise.allSettled(devices.map(async dev => {
      const r = await dev.measureBleSpeed({ sizeBytes: 4000, chunkSize: 200 });
      return { name: dev.getName(), ...r };
    }));
    return settled.map((res, i) => res.status === 'fulfilled'
      ? res.value
      : { name: devices[i].getName(), error: res.reason && res.reason.message });
  },

  async smokeTest({ homey }) {
    const driver = homey.drivers.getDriver('idotmatrix');
    const devices = driver ? driver.getDevices() : [];
    if (!devices.length) throw new Error('no devices paired');
    const dev = devices[0];
    const steps = [];
    const step = async (name, fn) => {
      const t0 = Date.now();
      try { await fn(); steps.push({ name, ok: true, ms: Date.now() - t0 }); }
      catch (e) { steps.push({ name, ok: false, ms: Date.now() - t0, error: e.message }); }
    };
    await step('solid red',  () => dev.showSolidColor('#ff0000'));
    await new Promise(r => setTimeout(r, 500));
    await step('solid green',() => dev.showSolidColor('#00ff00'));
    await new Promise(r => setTimeout(r, 500));
    await step('effect 0',   () => dev.showEffect(0));
    await new Promise(r => setTimeout(r, 800));
    await step('clock',      () => dev.showClock({}));
    await new Promise(r => setTimeout(r, 800));
    await step('text HELLO', () => dev.showText('HELLO', { color: '#ffaa00' }));
    return { device: dev.getName(), steps };
  },

  async fontGlyphs() {
    const Font = require('./lib/font8x16');
    const out = {};
    for (const code of Object.keys(Font)) {
      if (code === 'getGlyph' || isNaN(parseInt(code, 10))) continue;
      const buf = Font[code];
      if (!Buffer.isBuffer(buf)) continue;
      out[String.fromCharCode(parseInt(code, 10))] = Array.from(buf);
    }
    return out;
  },

  /**
   * Configure the remote sticker pack URL. Pass an empty string to clear.
   * The StickerPack hot-swaps without an app restart.
   */
  async setStickerRemoteUrl({ homey, body }) {
    const url = body && typeof body.url === 'string' ? body.url.trim() : '';
    homey.settings.set('remote_sticker_url', url || null);
    return { ok: true, url: url || null };
  },

  async getStickerRemoteUrl({ homey }) {
    return { url: homey.settings.get('remote_sticker_url') || null };
  },

  async previewPixelArt({ homey, body }) {
    let buf;
    if (Buffer.isBuffer(body)) buf = body;
    else if (body && body.type === 'Buffer' && Array.isArray(body.data)) buf = Buffer.from(body.data);
    else throw new Error('expected raw PNG bytes');
    return _broadcast(homey, dev => dev.showImage(buf), 'no iDotMatrix devices paired');
  },
};

/**
 * Broadcast one async operation to every paired iDotMatrix device.
 * Throws when no device is paired; otherwise resolves after every device
 * has either succeeded or failed (no early bail).
 */
async function _broadcast(homey, op, emptyMsg = 'no devices paired') {
  const driver = homey.drivers.getDriver('idotmatrix');
  const devices = driver ? driver.getDevices() : [];
  if (!devices.length) throw new Error(emptyMsg);
  const settled = await Promise.allSettled(devices.map(d => op(d)));
  const errors = settled
    .map((s, i) => (s.status === 'rejected' ? { name: devices[i].getName(), error: s.reason && s.reason.message } : null))
    .filter(Boolean);
  return { ok: errors.length === 0, devices: devices.length, errors };
}
