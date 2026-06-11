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
    const driver = homey.drivers.getDriver('idotmatrix');
    const devices = driver ? driver.getDevices() : [];
    if (!devices.length) throw new Error('no devices paired');
    for (const dev of devices) await dev.showAnimation(params.name);
    return { ok: true, devices: devices.length };
  },

  async previewEffect({ homey, params }) {
    const driver = homey.drivers.getDriver('idotmatrix');
    const devices = driver ? driver.getDevices() : [];
    if (!devices.length) throw new Error('no devices paired');
    for (const dev of devices) await dev.showEffect(parseInt(params.style, 10));
    return { ok: true, devices: devices.length };
  },

  async previewSolidColor({ homey, body }) {
    const color = body && body.color ? body.color : '#ffffff';
    const driver = homey.drivers.getDriver('idotmatrix');
    const devices = driver ? driver.getDevices() : [];
    if (!devices.length) throw new Error('no devices paired');
    for (const dev of devices) await dev.showSolidColor(color);
    return { ok: true, devices: devices.length };
  },

  async previewPixelArt({ homey, body }) {
    let buf;
    if (Buffer.isBuffer(body)) buf = body;
    else if (body && body.type === 'Buffer' && Array.isArray(body.data)) buf = Buffer.from(body.data);
    else throw new Error('expected raw PNG bytes');
    const driver = homey.drivers.getDriver('idotmatrix');
    const devices = driver ? driver.getDevices() : [];
    if (!devices.length) throw new Error('no iDotMatrix devices paired');
    for (const dev of devices) {
      await dev.showImage(buf);
    }
    return { ok: true, devices: devices.length };
  },
};
