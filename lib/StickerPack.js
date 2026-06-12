'use strict';

const fs = require('fs/promises');
const path = require('path');
const RemoteMediaIndex = require('./RemoteMediaIndex');

/**
 * Bundled stickers shipped inside the app — a handful of small ready-to-show
 * PNG/GIF assets so users have something to play with before they upload
 * their own. Lives under `assets/stickers/`. Files are read on demand and
 * served through the same image pipeline as remote URLs.
 *
 * Optional remote pack: if a `remoteUrl` is configured (set via
 * homey.settings 'remote_sticker_url'), the listing is augmented with the
 * filenames from that URL's directory listing or index.json. Remote bytes
 * are fetched on demand and cached in memory (small LRU); no filesystem
 * persistence so app updates don't accumulate stale files.
 *
 * Add new stickers by dropping image files into assets/stickers/ — they show
 * up in the Flow card autocomplete automatically.
 */
class StickerPack {

  constructor(rootDir, { remoteUrl = null, cacheBytes = 4 * 1024 * 1024 } = {}) {
    this.dir = path.join(rootDir, 'assets', 'stickers');
    this.remoteUrl = remoteUrl || null;
    this.cacheBytes = cacheBytes;
    this._remoteCache = new Map(); // name → Buffer (insertion-ordered → LRU on overflow)
    this._remoteCacheUsed = 0;
    this._remoteIndex = null; // { ts, items }
    this._remoteIndexTtlMs = 5 * 60 * 1000;
  }

  setRemoteUrl(url) {
    if (url === this.remoteUrl) return;
    this.remoteUrl = url || null;
    this._remoteIndex = null;
    this._remoteCache.clear();
    this._remoteCacheUsed = 0;
  }

  async list() {
    const bundled = await this._listBundled();
    if (!this.remoteUrl) return bundled;
    let remote = [];
    try {
      remote = await this._listRemote();
    } catch (e) {
      // Remote unreachable — fall back to bundled silently so the UI doesn't
      // break when the user's sticker server is down.
      remote = [];
    }
    const seen = new Set(bundled.map(b => b.name));
    const merged = bundled.slice();
    for (const r of remote) {
      if (seen.has(r.name)) continue; // bundled wins on collision
      merged.push({ ...r, source: 'remote' });
    }
    return merged;
  }

  async _listBundled() {
    try {
      const entries = await fs.readdir(this.dir, { withFileTypes: true });
      const out = [];
      for (const e of entries) {
        if (!e.isFile()) continue;
        const ext = path.extname(e.name).toLowerCase();
        if (!['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'].includes(ext)) continue;
        out.push({ name: e.name, source: 'bundled' });
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  async _listRemote() {
    const now = Date.now();
    if (this._remoteIndex && now - this._remoteIndex.ts < this._remoteIndexTtlMs) {
      return this._remoteIndex.items;
    }
    const items = await RemoteMediaIndex.list(this.remoteUrl);
    this._remoteIndex = { ts: now, items };
    return items;
  }

  async read(name) {
    const safe = String(name || '').replace(/[\\/]/g, '').replace(/^\.+/, '');
    if (!safe) throw new Error('invalid sticker name');
    // Bundled first — overrides remote on collision.
    try {
      return await fs.readFile(path.join(this.dir, safe));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (!this.remoteUrl) throw new Error(`sticker not found: ${safe}`);
    return this._readRemote(safe);
  }

  async _readRemote(name) {
    const cached = this._remoteCache.get(name);
    if (cached) {
      // refresh LRU position
      this._remoteCache.delete(name);
      this._remoteCache.set(name, cached);
      return cached;
    }
    const buf = await RemoteMediaIndex.fetchFile(this.remoteUrl, name);
    this._cachePut(name, buf);
    return buf;
  }

  _cachePut(name, buf) {
    while (this._remoteCacheUsed + buf.length > this.cacheBytes && this._remoteCache.size > 0) {
      const oldestKey = this._remoteCache.keys().next().value;
      const oldest = this._remoteCache.get(oldestKey);
      this._remoteCache.delete(oldestKey);
      this._remoteCacheUsed -= oldest.length;
    }
    if (buf.length > this.cacheBytes) return; // never cache something bigger than the cap
    this._remoteCache.set(name, buf);
    this._remoteCacheUsed += buf.length;
  }
}

module.exports = StickerPack;
