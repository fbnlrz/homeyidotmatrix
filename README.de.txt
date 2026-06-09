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
