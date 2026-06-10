Bedien iDotMatrix BLE-pixeldisplays (16x16, 32x32, 64x64) vanuit
Homey Pro. Toon tekst, klokken, countdowns, scoreborden, afbeeldingen
en geanimeerde GIFs via Flow-kaarten.

Wat deze app doet:

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

Vereisten: Homey Pro. Bluetooth Low Energy is niet beschikbaar op
Homey Bridge / Homey Cloud.

Installatie:

1. Installeer de app
2. In Homey: Apparaat toevoegen -> iDotMatrix Display
3. Zet het display aan en zorg dat het binnen bereik is
4. Kies je display uit de lijst
5. (Optioneel) Vul onder apparaatinstellingen -> Externe media-server
   de URL van een HTTP-directory op je LAN in om de Flow-kaart
   "Toon afbeelding van externe server" te gebruiken
6. (Optioneel) Voer "Apparaat-capabilities testen" uit om een
   volledige JSON-diagnose van je display op te slaan in de
   apparaatinstellingen

Credits:

* Protocol reverse engineering:
  derkalle4/python3-idotmatrix-library en 8none1/idotmatrix
* Beeldverwerking: jimp, omggif, crc
* Gebouwd met Claude Code (https://claude.com/claude-code) samen met
  de dvflw/homey-app-skill development skill
  (https://github.com/dvflw/homey-app-skill)

Broncode, issues, bijdragen:
  https://github.com/fbnlrz/homeyidotmatrix

Licentie: Unlicense (publiek domein - doe ermee wat je wilt, geen
beperkingen, geen naamsvermelding vereist).
