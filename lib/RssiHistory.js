'use strict';

/**
 * Rolling RSSI sample buffer per device. Stores up to `max` samples with
 * timestamps; the settings-page canvas draws a small graph from this.
 */
class RssiHistory {
  constructor(max = 60) {
    this.max = max;
    this.samples = [];
  }
  push(rssi) {
    if (typeof rssi !== 'number') return;
    this.samples.push({ ts: Date.now(), rssi });
    if (this.samples.length > this.max) this.samples.shift();
  }
  list() { return this.samples.slice(); }
}

module.exports = RssiHistory;
