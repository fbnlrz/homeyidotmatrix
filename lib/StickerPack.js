'use strict';

const fs = require('fs/promises');
const path = require('path');

/**
 * Bundled stickers shipped inside the app — a handful of small ready-to-show
 * PNG/GIF assets so users have something to play with before they upload
 * their own. Lives under `assets/stickers/`. Files are read on demand and
 * served through the same image pipeline as remote URLs.
 *
 * Add new stickers by dropping image files into assets/stickers/ — they show
 * up in the Flow card autocomplete automatically.
 */
class StickerPack {

  constructor(rootDir) {
    this.dir = path.join(rootDir, 'assets', 'stickers');
  }

  async list() {
    try {
      const entries = await fs.readdir(this.dir, { withFileTypes: true });
      const out = [];
      for (const e of entries) {
        if (!e.isFile()) continue;
        const ext = path.extname(e.name).toLowerCase();
        if (!['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'].includes(ext)) continue;
        out.push({ name: e.name });
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  async read(name) {
    const safe = String(name || '').replace(/[\\/]/g, '').replace(/^\.+/, '');
    if (!safe) throw new Error('invalid sticker name');
    return fs.readFile(path.join(this.dir, safe));
  }
}

module.exports = StickerPack;
