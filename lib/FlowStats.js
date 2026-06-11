'use strict';

/**
 * Per-Flow-card invocation counter — separates successes from errors and
 * records the timestamp of the latest run for each card id.
 */
class FlowStats {
  constructor() {
    this.entries = {};
  }
  record(id, ok, errMessage) {
    const e = this.entries[id] || { runs: 0, errors: 0, lastRunAt: null, lastError: null };
    e.runs += 1;
    if (!ok) {
      e.errors += 1;
      e.lastError = errMessage || 'unknown';
    }
    e.lastRunAt = Date.now();
    this.entries[id] = e;
  }
  list() {
    return Object.entries(this.entries)
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => (b.lastRunAt || 0) - (a.lastRunAt || 0));
  }
}

module.exports = FlowStats;
