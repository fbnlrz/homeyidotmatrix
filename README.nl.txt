==========================================
  iDotMatrix voor Homey Pro
==========================================

Bedien iDotMatrix BLE pixel displays (16x16, 32x32, 64x64) vanaf
Homey Pro. Toon tekst, klokken, countdowntimers, scoreborden,
afbeeldingen en geanimeerde GIFs via Flow-kaarten.

------------------------------------------
  Installatie
------------------------------------------

1. Installeer de app
2. In Homey: Apparaat toevoegen -> iDotMatrix Display
3. Zet het display aan en zorg dat het binnen bereik is
4. Kies je display uit de ontdekkingslijst
5. (Optioneel) Bij apparaatinstellingen -> Remote media server,
   voer de URL in van een HTTP-directory op je LAN.
6. (Optioneel) Gebruik "Apparaat-capabilities testen" voor een 
   volledige JSON-diagnose.

------------------------------------------
  Functionaliteit
------------------------------------------

* Maakt verbinding via Bluetooth Low Energy met iDotMatrix-
  displays ("IDM-*")
* Capabilities: Aan/Uit, Helderheid (5-100%)
* Flow-acties: Tekst, Klok, Countdown, Scorebord, Stopwatch
  en diverse opties voor afbeeldingen.
* Geanimeerde GIFs worden automatisch geschaald met behoud
  van de pixel-art kwaliteit (nearest-neighbor).

------------------------------------------
  Credits / Licentie
------------------------------------------

* Gebouwd met: jimp, omggif, crc.
* Protocol reverse engineering: derkalle4/python3-idotmatrix-library, 8none1/idotmatrix.
* Licentie: Unlicense (public domain).
* Broncode: https://github.com/fbnlrz/homeyidotmatrix
