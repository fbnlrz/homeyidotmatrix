'use strict';

const fs = require('fs/promises');
const path = require('path');

const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);

class MediaStore {

  constructor(homeyApp) {
    this.app = homeyApp;
    // Homey provides a persistent /userdata mount inside the app container.
    // Fall back to other plausible paths used by the SDK runner; if none are
    // writable we degrade to "store disabled" rather than crashing the app.
    this.candidates = [
      process.env.HOMEY_USERDATA_DIR,
      '/userdata',
      '/homey-app-runner/userdata',
      path.join(process.cwd(), 'userdata'),
    ].filter(Boolean).map(d => path.join(d, 'media'));
    this.dir = null;
  }

  async init() {
    for (const cand of this.candidates) {
      try {
        await fs.mkdir(cand, { recursive: true });
        // Probe write permission.
        const probe = path.join(cand, '.write-test');
        await fs.writeFile(probe, '');
        await fs.unlink(probe);
        this.dir = cand;
        return;
      } catch (e) { /* try next */ }
    }
    if (this.app && this.app.log) {
      this.app.log('MediaStore disabled: no writable userdata directory found. Use the remote URL Flow card instead.');
    }
  }

  _requireDir() {
    if (!this.dir) throw new Error('Media store is unavailable on this Homey (no writable userdata). Use Show image from remote server instead.');
  }

  _safeName(name) {
    // Strip any path separators and disallow leading dots — no traversal, no hidden files.
    const cleaned = String(name || '').replace(/[\\/]/g, '').replace(/^\.+/, '');
    if (!cleaned) throw new Error('invalid name');
    const ext = path.extname(cleaned).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      throw new Error(`unsupported extension ${ext || '(none)'} — allow: ${[...ALLOWED_EXT].join(', ')}`);
    }
    return cleaned;
  }

  _pathOf(name) {
    return path.join(this.dir, this._safeName(name));
  }

  async list() {
    if (!this.dir) return [];
    try {
      const entries = await fs.readdir(this.dir, { withFileTypes: true });
      const out = [];
      for (const e of entries) {
        if (!e.isFile()) continue;
        const ext = path.extname(e.name).toLowerCase();
        if (!ALLOWED_EXT.has(ext)) continue;
        const stat = await fs.stat(path.join(this.dir, e.name));
        out.push({ name: e.name, size: stat.size, mtime: stat.mtimeMs });
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  async write(name, buffer) {
    this._requireDir();
    const p = this._pathOf(name);
    await fs.writeFile(p, buffer);
    return { name: path.basename(p), size: buffer.length };
  }

  async read(name) {
    this._requireDir();
    return fs.readFile(this._pathOf(name));
  }

  async remove(name) {
    this._requireDir();
    await fs.unlink(this._pathOf(name));
  }
}

module.exports = MediaStore;
