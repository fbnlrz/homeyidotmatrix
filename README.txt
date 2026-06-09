==========================================
  iDotMatrix for Homey Pro
==========================================

Control iDotMatrix BLE pixel displays (16x16, 32x32, 64x64) from
Homey Pro. Show text, clocks, countdowns, scoreboards, images, and
animated GIFs through Flow cards.

------------------------------------------
  Setup
------------------------------------------

1. Install the app
2. In Homey: Add device -> iDotMatrix Display
3. Power the display on, make sure it is in range
4. Pick your display from the discovery list
5. (Optional) Under device settings -> Remote media server,
   enter the URL of an HTTP directory on your LAN to enable
   the "Show image from remote server" Flow card
6. (Optional) Trigger "Probe device capabilities" to record
   a full JSON diagnostic of your display in device settings

------------------------------------------
  Features
------------------------------------------

* Pairs over Bluetooth Low Energy with any iDotMatrix display
  advertising as "IDM-*"
* Capabilities: On/Off, Brightness (5-100%)
* Flow actions include: Text, Clock, Countdown, Scoreboard,
  Chronograph, and various image rendering options.
* Animated GIFs are automatically resized while preserving 
  pixel art quality.

------------------------------------------
  Credits / License
------------------------------------------

* Built with: jimp, omggif, crc.
* Protocol reverse engineering: derkalle4/python3-idotmatrix-library, 8none1/idotmatrix.
* License: Unlicense (public domain).
* Source code: https://github.com/fbnlrz/homeyidotmatrix
