'use strict';

const Animations = require('./Animations');

/**
 * Idle screensaver — when the user hasn't sent any Flow-driven content
 * for N minutes, automatically run a background animation/effect on a
 * loop. The first user-initiated write cancels the screensaver until the
 * next idle period.
 *
 * Settings (per device):
 *   screensaver_enabled       — checkbox
 *   screensaver_idle_minutes  — 1-1440
 *   screensaver_type          — animation name | 'rainbow' | 'random'
 */
class Screensaver {

  constructor({ device, client, onLog }) {
    this.device = device;
    this.client = client;
    this.log = onLog || (() => {});
    this._lastActivity = Date.now();
    this._active = false;
    this._timer = null;
    this._cycleTimer = null;
  }

  /** Note that the user just triggered something — resets the idle clock. */
  touch() {
    this._lastActivity = Date.now();
    if (this._active) this._stopCycle();
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), 30 * 1000);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._stopCycle();
  }

  _idleMinutes() {
    const v = parseInt(this.device.getSetting('screensaver_idle_minutes'), 10);
    return Number.isFinite(v) && v > 0 ? v : 10;
  }

  _type() {
    return this.device.getSetting('screensaver_type') || 'plasma';
  }

  async _tick() {
    try {
      if (!this.device.getSetting('screensaver_enabled')) {
        if (this._active) this._stopCycle();
        return;
      }
      if (!this.client.isConnected()) return;
      const idleMs = Date.now() - this._lastActivity;
      const idleThreshold = this._idleMinutes() * 60 * 1000;
      if (!this._active && idleMs >= idleThreshold) {
        this._active = true;
        this.log(`[screensaver] starting (${this._type()})`);
        await this._showOnce();
        // Re-render every 60 s so the animation loops with fresh frames.
        this._cycleTimer = setInterval(() => this._showOnce().catch(() => {}), 60 * 1000);
      }
    } catch (e) {
      this.log(`[screensaver] tick error: ${e.message}`);
    }
  }

  _stopCycle() {
    this._active = false;
    if (this._cycleTimer) {
      clearInterval(this._cycleTimer);
      this._cycleTimer = null;
    }
  }

  async _showOnce() {
    const type = this._type();
    const size = this.device._pixelSize();
    if (type === 'random') {
      const animKeys = ['matrixRain', 'gameOfLife', 'dvdBouncer', 'plasma', 'starfield', 'fireworks'];
      const pick = animKeys[Math.floor(Math.random() * animKeys.length)];
      const gif = Animations[pick](size);
      await this.device.showGif(gif);
      return;
    }
    if (type.startsWith('effect:')) {
      const style = parseInt(type.slice(7), 10);
      await this.device.showEffect(style);
      return;
    }
    if (Animations[type]) {
      const gif = Animations[type](size);
      await this.device.showGif(gif);
      return;
    }
    // Fallback — built-in horizontal rainbow effect.
    await this.device.showEffect(0);
  }
}

module.exports = Screensaver;
