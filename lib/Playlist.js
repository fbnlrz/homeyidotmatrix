'use strict';

/**
 * Drives a per-device image rotation. Each device may have at most one
 * playlist; starting a new one replaces the previous. The playlist resolves
 * items every cycle (so the underlying source — remote directory, local
 * store — can change between rotations without restarting the playlist).
 */
class Playlist {

  /**
   * @param {object} opts
   * @param {object} opts.device          The Homey device (provides log/error)
   * @param {function} opts.resolveItems  async () => string[] of file names
   * @param {function} opts.sendItem      async (name) => void
   * @param {number} opts.intervalMs      cycle interval
   * @param {boolean} opts.shuffle        randomize order each pass
   */
  constructor({ device, resolveItems, sendItem, intervalMs, shuffle = false, onLog }) {
    this.device = device;
    this.resolveItems = resolveItems;
    this.sendItem = sendItem;
    this.intervalMs = Math.max(2000, intervalMs | 0);
    this.shuffle = shuffle;
    this.log = onLog || ((...a) => device.log('[playlist]', ...a));
    this._stopped = false;
    this._timer = null;
    this._items = [];
    this._index = 0;
  }

  start() {
    if (this._timer || this._stopped) return;
    this.log(`starting rotation every ${this.intervalMs}ms${this.shuffle ? ' (shuffled)' : ''}`);
    this._tick();
  }

  stop() {
    this._stopped = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  async _tick() {
    this._timer = null;
    if (this._stopped) return;
    try {
      if (this._items.length === 0 || this._index >= this._items.length) {
        this._items = await this.resolveItems();
        if (this.shuffle) this._items = _shuffle([...this._items]);
        this._index = 0;
        if (this._items.length === 0) {
          this.log('no items found, will retry next cycle');
        }
      }
      if (this._items.length > 0) {
        const item = this._items[this._index++];
        try {
          await this.sendItem(item);
        } catch (e) {
          this.log(`failed to send ${item}: ${e.message}`);
        }
      }
    } catch (e) {
      this.log(`resolveItems failed: ${e.message}`);
    }
    if (!this._stopped) {
      this._timer = setTimeout(() => this._tick(), this.intervalMs);
    }
  }
}

function _shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = Playlist;
