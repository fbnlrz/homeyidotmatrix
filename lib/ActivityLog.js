'use strict';

/**
 * Rolling per-app log of "what was last shown" — surfaces in the settings
 * page so the user can see at a glance what their Flows did.
 */
class ActivityLog {

  constructor(maxEntries = 30) {
    this.entries = [];
    this.max = maxEntries;
  }

  add(event) {
    this.entries.unshift({ ts: Date.now(), ...event });
    if (this.entries.length > this.max) this.entries.length = this.max;
  }

  list() { return this.entries.slice(); }
  clear() { this.entries.length = 0; }
}

module.exports = ActivityLog;
