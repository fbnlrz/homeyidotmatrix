==========================================
  iDotMatrix for Homey Pro
==========================================

Control iDotMatrix BLE pixel displays (16x16, 32x32, 64x64) from
Homey Pro. Show text, clocks, countdowns, scoreboards, images, and
animated GIFs through Flow cards.

------------------------------------------
  EN — What this app does
------------------------------------------

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

Requirements: Homey Pro (2023 or Early 2019). Bluetooth Low Energy
is not available on Homey Bridge / Homey Cloud.

------------------------------------------
  DE - Was diese App macht
------------------------------------------

* Verbindet sich per Bluetooth Low Energy mit jedem iDotMatrix-
  Display, das als "IDM-*" gefunden wird
* Capabilities: Ein/Aus, Helligkeit (5-100%)
* Flow-Aktionen:
   - Text anzeigen (9 Animations-Modi, Farbe, Geschwindigkeit)
   - Uhr anzeigen (8 Stile, Farbe, Datum, 12/24h)
   - Countdown (Start, Pause, Neustart, Deaktivieren)
   - Scoreboard (zwei 3-stellige Zaehler)
   - Stoppuhr
   - Bild von URL anzeigen (PNG, JPG, BMP, animiertes GIF)
   - Bild von einem externen HTTP-Server im LAN anzeigen
     (nginx autoindex, Apache, Python http.server, oder index.json)
   - Bild aus lokalem Media-Store anzeigen
   - Gerät-Capabilities abfragen (Diagnose)
* Animierte GIFs werden automatisch auf die Display-Aufloesung
  skaliert, dabei bleibt jedes Frame erhalten (Nearest-Neighbor -
  optimal fuer Pixel-Art).

Voraussetzungen: Homey Pro (2023 oder Early 2019). Bluetooth Low
Energy ist auf Homey Bridge / Homey Cloud nicht verfuegbar.

------------------------------------------
  NL - Wat deze app doet
------------------------------------------

* Maakt verbinding via Bluetooth Low Energy met elk iDotMatrix-
  display dat zich aankondigt als "IDM-*"
* Capabilities: Aan/Uit, Helderheid (5-100%)
* Flow-acties:
   - Tekst tonen (9 animatie-modi, kleur, snelheid)
   - Klok tonen (8 stijlen, kleur, datum, 12/24u)
   - Countdown (start, pauze, herstart, uitschakelen)
   - Scorebord (twee 3-cijferige tellers)
   - Chronograaf (stopwatch)
   - Afbeelding van URL tonen (PNG, JPG, BMP, geanimeerde GIF)
   - Afbeelding van een externe HTTP-server op je LAN tonen
     (nginx autoindex, Apache, Python http.server, of index.json)
   - Afbeelding uit lokale media-store tonen
   - Apparaat-capabilities testen (diagnose)
* Geanimeerde GIFs worden automatisch geschaald naar de display-
  resolutie met behoud van alle frames (nearest-neighbor -
  ideaal voor pixel-art).

Vereisten: Homey Pro (2023 of Early 2019). Bluetooth Low Energy
is niet beschikbaar op Homey Bridge / Homey Cloud.

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
  Credits / Built with
------------------------------------------

* Protocol reverse engineering:
   - derkalle4/python3-idotmatrix-library
   - 8none1/idotmatrix
* Image processing: jimp, omggif, crc
* This app was built using Claude Code
  (https://claude.com/claude-code) together with the
  dvflw/homey-app-skill development skill
  (https://github.com/dvflw/homey-app-skill).

Source code, issues, contributions:
  https://github.com/fbnlrz/homeyidotmatrix

License: Unlicense (public domain — do whatever you want, no
restrictions, no attribution required).
