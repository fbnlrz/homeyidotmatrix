'use strict';

const fs = require('fs/promises');
const path = require('path');

const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);

class MediaStore {

  constructor(homeyApp) {
    this.app = homeyApp;
    // userdata persists across app updates; HOMEY_USERDATA_DIR is the
    // canonical location on Homey Pro. Fall back to a sibling folder for
    // local dev runs.
    const base = process.env.HOMEY_USERDATA_DIR || path.join(process.cwd(), '.userdata');
    this.dir = path.join(base, 'media');
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
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
    const p = this._pathOf(name);
    await fs.writeFile(p, buffer);
    return { name: path.basename(p), size: buffer.length };
  }

  async read(name) {
    return fs.readFile(this._pathOf(name));
  }

  async remove(name) {
    await fs.unlink(this._pathOf(name));
  }
}

module.exports = MediaStore;
