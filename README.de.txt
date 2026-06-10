Steuere iDotMatrix BLE-Pixel-Displays (16x16, 32x32, 64x64) mit
Homey Pro. Zeige Texte, Uhren, Countdowns, Scoreboards, Bilder und
animierte GIFs ueber Flow-Karten an.

Was diese App macht:

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
   - Geraet-Capabilities abfragen (Diagnose)
* Animierte GIFs werden automatisch auf die Display-Aufloesung
  skaliert, dabei bleibt jedes Frame erhalten (Nearest-Neighbor -
  optimal fuer Pixel-Art).

Voraussetzungen: Homey Pro. Bluetooth Low Energy ist auf Homey
Bridge / Homey Cloud nicht verfuegbar.

Einrichtung:

1. App installieren
2. In Homey: Geraet hinzufuegen -> iDotMatrix Display
3. Display einschalten und in Reichweite bringen
4. Display aus der Liste auswaehlen
5. (Optional) Unter Geraeteeinstellungen -> Externer Media-Server
   die URL eines HTTP-Verzeichnisses im LAN eintragen, um die
   Flow-Karte "Bild vom externen Server anzeigen" zu nutzen
6. (Optional) "Geraet-Capabilities abfragen" ausloesen, um eine
   vollstaendige JSON-Diagnose des Displays in den
   Geraeteeinstellungen zu speichern

Credits:

* Protokoll-Reverse-Engineering:
  derkalle4/python3-idotmatrix-library und 8none1/idotmatrix
* Bildverarbeitung: jimp, omggif, crc
* Entwickelt mit Claude Code (https://claude.com/claude-code) und
  dem dvflw/homey-app-skill Development-Skill
  (https://github.com/dvflw/homey-app-skill)

Quellcode, Issues, Beitraege:
  https://github.com/fbnlrz/homeyidotmatrix

Lizenz: Unlicense (Public Domain - mach damit was du willst, keine
Einschraenkungen, keine Namensnennung erforderlich).
=======
==========================================
  iDotMatrix für Homey Pro
==========================================

Steuere iDotMatrix BLE Pixel-Displays (16x16, 32x32, 64x64) von
deinem Homey Pro aus. Zeige Texte, Uhren, Countdowns, 
Scoreboards, Bilder und animierte GIFs über Flow-Karten an.

------------------------------------------
  Einrichtung
------------------------------------------

1. Installiere die App
2. In Homey: Gerät hinzufügen -> iDotMatrix Display
3. Schalte das Display ein und stelle sicher, dass es in Reichweite ist
4. Wähle dein Display aus der Suchliste aus
5. (Optional) Unter Geräteeinstellungen -> Remote-Media-Server, 
   gib die URL eines HTTP-Verzeichnisses in deinem LAN ein.
6. (Optional) Nutze "Gerät-Capabilities abfragen" für eine Diagnose.

------------------------------------------
  Funktionen
------------------------------------------

* Verbindet sich per Bluetooth Low Energy mit Geräten ("IDM-*")
* Capabilities: Ein/Aus, Helligkeit (5-100%)
* Flow-Aktionen: Text, Uhr, Countdown, Scoreboard, Stoppuhr 
  und verschiedene Bild-Optionen.
* Animierte GIFs werden automatisch auf die Display-Auflösung 
  skaliert (Nearest-Neighbor für perfekte Pixel-Art).

------------------------------------------
  Credits / Lizenz
------------------------------------------

* Basierend auf: jimp, omggif, crc.
* Protokoll-Reverse-Engineering: derkalle4/python3-idotmatrix-library, 8none1/idotmatrix.
* Lizenz: Unlicense (Public Domain).
* Quellcode: https://github.com/fbnlrz/homeyidotmatrix

