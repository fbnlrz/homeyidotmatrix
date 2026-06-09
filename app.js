'use strict';

const Homey = require('homey');
const { Jimp } = require('jimp');

async function _fetchUrlBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Detect "this looks like a GIF" from the magic bytes. Used to route
 * GIF89a/GIF87a via the animated GIF path; everything else (JPG/PNG/WEBP/BMP)
 * gets decoded by Jimp and re-encoded as PNG.
 */
function _isGif(buf) {
  return buf.length >= 6
    && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46
    && buf[3] === 0x38 && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61;
}

/**
 * Decode any image format Jimp understands (JPG, PNG, BMP, TIFF, GIF first frame),
 * resize to `size`x`size`, and return a PNG-encoded Buffer ready for the iDotMatrix
 * image opcode.
 */
async function _toPngForDisplay(buf, size) {
  const img = await Jimp.read(buf);
  img.resize({ w: size, h: size });
  return img.getBuffer('image/png');
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
      // Honor explicit "gif" choice OR auto-detect animated GIF by magic bytes.
      if (args.kind === 'gif' || _isGif(buf)) {
        await args.device.showGif(buf);
        return;
      }
      // Anything else (PNG, JPG/JPEG, BMP, …) → decode + resize + re-encode as PNG.
      const size = args.device._pixelSize();
      const pngBuf = await _toPngForDisplay(buf, size);
      await args.device.showImage(pngBuf);
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
