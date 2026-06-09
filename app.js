'use strict';

const Homey = require('homey');

async function _fetchUrlBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

class IDMApp extends Homey.App {

  async onInit() {
    this.log('iDotMatrix app starting');
    this._registerFlowActions();
  }

  _registerFlowActions() {
    const reg = (id, handler) => {
      const card = this.homey.flow.getActionCard(id);
      card.registerRunListener(async args => handler.call(this, args));
    };

    reg('show_text', async args => {
      await args.device.showText(args.text, {
        color: args.color,
        mode: parseInt(args.mode, 10),
        speed: parseInt(args.speed, 10),
      });
    });

    reg('show_image_url', async args => {
      const buf = await _fetchUrlBuffer(args.url);
      if (args.kind === 'gif') {
        await args.device.showGif(buf);
      } else {
        await args.device.showImage(buf);
      }
    });

    reg('show_clock', async args => {
      await args.device.showClock({
        style: parseInt(args.style, 10),
        showDate: !!args.show_date,
        hour24: !!args.hour24,
        color: args.color,
      });
    });

    reg('start_countdown', async args => {
      await args.device.setCountdown({
        action: parseInt(args.action, 10),
        minutes: parseInt(args.minutes, 10),
        seconds: parseInt(args.seconds, 10),
      });
    });

    reg('set_scoreboard', async args => {
      await args.device.setScoreboard(
        parseInt(args.score_a, 10),
        parseInt(args.score_b, 10),
      );
    });

    reg('chronograph', async args => {
      await args.device.chronograph(parseInt(args.action, 10));
    });

    reg('probe_capabilities', async args => {
      await args.device.probeCapabilities();
    });
  }
}

module.exports = IDMApp;
