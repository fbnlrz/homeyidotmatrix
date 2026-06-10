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

  async listMedia({ homey }) {
    return homey.app.media.list();
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
};
