Control iDotMatrix BLE pixel displays (16x16, 32x32, 64x64) from
Homey Pro. Show text, clocks, countdowns, scoreboards, images, and
animated GIFs through Flow cards.

What this app does:

* Pairs over Bluetooth Low Energy with any iDotMatrix display
  advertising as "IDM-*"
* Capabilities: On/Off, Brightness (5-100%)
* Flow actions:
   - Show text (9 animation modes, color, speed)
   - Show clock (8 styles, color, date, 12/24h)
   - Countdown (start, pause, restart, disable)
   - Scoreboard (two 3-digit counters)
   - Chronograph (stopwatch)
   - Show image from URL (PNG, JPG, BMP, animated GIF)
   - Show image from a remote HTTP server on your LAN
     (nginx autoindex, Apache, Python http.server, or index.json)
   - Show image from the app's local media store
   - Probe device capabilities (diagnostics)
* Animated GIFs are automatically resized to the display
  resolution while preserving each frame (nearest-neighbor —
  perfect for pixel art).

Requirements: Homey Pro. Bluetooth Low Energy is not available on
Homey Bridge / Homey Cloud.

Setup:

1. Install the app
2. In Homey: Add device -> iDotMatrix Display
3. Power the display on, make sure it is in range
4. Pick your display from the discovery list
5. (Optional) Under device settings -> Remote media server,
   enter the URL of an HTTP directory on your LAN to enable
   the "Show image from remote server" Flow card
6. (Optional) Trigger "Probe device capabilities" to record
   a full JSON diagnostic of your display in device settings

Credits:

* Protocol reverse engineering:
  derkalle4/python3-idotmatrix-library and 8none1/idotmatrix
* Image processing: jimp, omggif, crc
* Built using Claude Code (https://claude.com/claude-code) together
  with the dvflw/homey-app-skill development skill
  (https://github.com/dvflw/homey-app-skill)

Source code, issues, contributions:
  https://github.com/fbnlrz/homeyidotmatrix

License: Unlicense (public domain — do whatever you want, no
restrictions, no attribution required).
