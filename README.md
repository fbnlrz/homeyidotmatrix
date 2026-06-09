# Homey iDotMatrix

Homey Pro integration for iDotMatrix BLE pixel displays (16×16 / 32×32 / 64×64), based on the reverse-engineered protocol from [derkalle4/python3-idotmatrix-library](https://github.com/derkalle4/python3-idotmatrix-library).

## Status

Early MVP. Implements:

- BLE discovery + pairing (devices advertising as `IDM-*`)
- Capabilities `onoff` and `dim`
- Flow actions: show text, show image (PNG), show GIF, show clock, countdown, scoreboard, chronograph
- **Probe action** — interrogates the device's BLE services, characteristics, notifications, and supported opcodes, then stores the result in device settings (`Last probe result`)

## Hardware target

- **Homey Pro (2023 / Early 2019)** — BLE-capable. Homey Bridge/Cloud are not supported.
- iDotMatrix display with name prefix `IDM-` (confirmed on `IDM-BC5C5F`, service `0000fa00-…`, write `0000fa02-…`, notify `0000fa03-…`).

## Project layout

```
.
├── app.js                            # App: registers Flow action listeners
├── app.json                          # Manifest (SDK 3, BLE permission, drivers, flow cards)
├── drivers/idotmatrix/
│   ├── driver.js                     # BLE pairing/discovery
│   └── device.js                     # Connect, capabilities, flow handlers
├── lib/
│   ├── IDMProtocol.js                # Opcodes / packet builders (testable, no Homey deps)
│   ├── IDMClient.js                  # BLE wrapper (homey.ble) with reconnect
│   ├── IDMProbe.js                   # Capability-discovery / diagnostics
│   └── font8x16.js                   # Built-in 5x7 ASCII font (uppercase + digits)
└── locales/{en,de}.json
```

## Run locally

```bash
npm install
npx homey app run
```

Then in Homey app: Add device → iDotMatrix → display appears.

## Capability probe

Trigger the *Probe device capabilities* flow action. The result is written to the device's settings page (Diagnostics → Last probe result) as JSON, e.g.:

```json
{
  "device": { "manufacturer": "…", "model": "…", "firmware": "…" },
  "services": [
    { "uuid": "fa00", "characteristics": [
      { "uuid": "fa02", "properties": { "writeWithoutResponse": true } },
      { "uuid": "fa03", "properties": { "notify": true } }
    ]},
    { "uuid": "ae00", "characteristics": ["…"] }
  ],
  "features": {
    "power":      { "supported": true },
    "brightness": { "range": "5-100" },
    "clock":      { "modes": [0,1,2,3,4,5,6,7] }
  },
  "notifications": [{ "ts": 0, "hex": "050001000301" }]
}
```

## Known gaps

- Text rendering uses a small built-in 5×7 ASCII font (uppercase only). For richer fonts pass `opts.font` to `IDMProtocol.buildText` or extend `lib/font8x16.js`.
- The secondary BLE service `0000ae00-…` observed on real hardware is **undocumented**. Probe lists it; no commands are sent there yet.
- Image upload sends PNG bytes as-is. Resize to 32×32 happens device-side; pre-resize via Homey image transforms if you want pixel-accurate output.
- No automated tests yet.

## Protocol references

- `derkalle4/python3-idotmatrix-library` — primary source of opcodes
- `8none1/idotmatrix` — additional protocol notes
- BLE UUIDs: service `0000fa00-0000-1000-8000-00805f9b34fb`, write `0000fa02-…`, notify `0000fa03-…`, name prefix `IDM-`
