# Homey iDotMatrix

[![Homey](https://img.shields.io/badge/Homey-Pro-blue)](https://homey.app/)
[![SDK](https://img.shields.io/badge/SDK-v3-brightgreen)](https://apps-sdk-v3.developer.homey.app/)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

Homey Pro integration for [iDotMatrix](https://www.idotmatrix.com/) BLE pixel displays (16×16 / 32×32 / 64×64). Reverse-engineered protocol ported from [`derkalle4/python3-idotmatrix-library`](https://github.com/derkalle4/python3-idotmatrix-library), verified byte-for-byte against the original commands on real hardware (`IDM-BC5C5F`, firmware 2026-06).

## Features

| Capability | Description |
|---|---|
| `onoff` | Power the display on or off |
| `dim` | Brightness 5–100 % |
| Flow: **Show text** | Scrolling text with 9 modes (Marquee, Tetris, Fade, …), color, speed |
| Flow: **Show image from URL** | PNG / JPG / BMP / GIF — auto-detected, decoded with Jimp, resized |
| Flow: **Show image from remote server** | Lists files from any nginx / Apache / Python `http.server` directory or `index.json` |
| Flow: **Show stored image** | Lists files uploaded to the app's local media store (POST endpoint) |
| Flow: **Show clock** | 8 styles, color, optional date + 12/24-hour format |
| Flow: **Countdown** | Disable / Start / Pause / Restart with mm:ss |
| Flow: **Scoreboard** | Two 3-digit counters |
| Flow: **Chronograph** | Reset / Start / Pause / Continue |
| Flow: **Probe capabilities** | Diagnoses the device's BLE services, characteristics, and supported opcodes; persists JSON to device settings |

## Supported hardware

- **Homey Pro (2023 / Early 2019)** — BLE-capable. Homey Bridge / Cloud are not supported.
- Any iDotMatrix display advertising as `IDM-*` with BLE service `0000fa00-…`, write characteristic `0000fa02-…`, notify characteristic `0000fa03-…`. The library also reports an undocumented secondary `ae00` service that may carry OTA / mesh functionality (not used yet).

## Install (community / test)

1. Clone this repo
2. `npm install`
3. `homey app install` (requires `homey` CLI from npm and a Homey Pro on the same LAN)

For development:

```bash
npm install -g homey
npm install
homey app run
```

Then in the Homey mobile/desktop app: **Add device → iDotMatrix Display**.

## Architecture

```
.
├── app.js                       # App entrypoint, Flow action listeners
├── app.json                     # Manifest, drivers, Flow cards, settings, API
├── api.js                       # /api/app/com.idotmatrix/* endpoints (media store)
├── drivers/idotmatrix/
│   ├── driver.js                # BLE discovery + pairing
│   └── device.js                # onInit, capabilities, flow handlers
├── lib/
│   ├── IDMProtocol.js           # Pure-JS opcode builders (testable, no Homey deps)
│   ├── IDMClient.js             # homey.ble wrapper with reconnect + MTU-aware writes
│   ├── IDMProbe.js              # Capability/diagnostic probe
│   ├── MediaStore.js            # File-backed local media store (userdata)
│   ├── RemoteMediaIndex.js      # HTTP directory listing parser (nginx autoindex / index.json)
│   ├── gifResize.js             # Animated-GIF frame-by-frame resize (omggif + NN)
│   └── font8x16.js              # Minimal built-in 5×7 ASCII font
├── locales/{en,de,nl}.json      # Translations
├── assets/                      # App store icons
└── scripts/gen-icons.py         # Regenerates app + driver PNGs
```

### Protocol notes

- **BLE service**: `0000fa00-0000-1000-8000-00805f9b34fb` (advertised as `00FA`)
  - Write characteristic: `0000fa02-…` (write-without-response, MTU 517)
  - Notify characteristic: `0000fa03-…` — every command produces an ACK `0x05 0x00 <cmd> <subcmd> 0x01`
- **Discovery**: filter by name prefix `IDM-`
- **Image upload pipeline**: `setMode(1)` (DIY) → `[id_lo, id_hi, 0, 0, flag, png_len(4B LE), …PNG bytes]`, chunked into ≤4096-byte app-level chunks, each split further into ≤200-byte BLE writes
- **GIF upload pipeline**: per-chunk header `[size_lo, size_hi, 1, 0, flag, total_len(4B LE), crc32(4B LE), 5, 0, 13]`

## API endpoints

`/api/app/com.idotmatrix/`:

| Method | Path | Description |
|---|---|---|
| `GET` | `/media` | List files in the in-app media store |
| `POST` | `/media/:name` | Upload (raw bytes in body, `Content-Type: application/octet-stream`) |
| `DELETE` | `/media/:name` | Remove a file |

```bash
curl -X POST --data-binary @pumpkin.gif \
  http://<homey-ip>/api/app/com.idotmatrix/media/pumpkin.gif
```

## Sources of 32×32 pixel art

- [`t-var-s/pixel-art-32`](https://github.com/t-var-s/pixel-art-32) — iDotMatrix-oriented collection
- [lospec.com/gallery](https://lospec.com/gallery)
- [pixilart.com](https://pixilart.com)
- [opengameart.org](https://opengameart.org)
- [piskelapp.com/gallery](https://piskelapp.com/gallery)
- [r/PixelArt](https://reddit.com/r/PixelArt), [r/PixelGifs](https://reddit.com/r/PixelGifs)

## Credits

- [`derkalle4/python3-idotmatrix-library`](https://github.com/derkalle4/python3-idotmatrix-library) — original protocol reverse engineering
- [`8none1/idotmatrix`](https://github.com/8none1/idotmatrix) — supplementary protocol notes
- [omggif](https://www.npmjs.com/package/omggif), [jimp](https://www.npmjs.com/package/jimp), [crc](https://www.npmjs.com/package/crc)

### Built with

This app was developed using [Claude Code](https://claude.com/claude-code) and the [`dvflw/homey-app-skill`](https://github.com/dvflw/homey-app-skill) Homey app development skill, which provides Homey-specific scaffolding, validation hooks, and patterns for the agent.

## License

MIT — see [LICENSE](LICENSE).

## Status

Early test release. The display reacts correctly to all opcodes verified via the probe tool, but the broader Flow API has not yet been hardened against every firmware variation. Issues and PRs welcome on [GitHub](https://github.com/fbnlrz/homeyidotmatrix/issues).
