# consumentenbond-dl

Download je Consumentenbond publicaties als PDF zodat je ze offline kunt lezen — op je e-reader, tablet, of in het vliegtuig.

Vereist een actief Consumentenbond lidmaatschap met toegang tot de [online leeshoek](https://www.consumentenbond.nl/boeken-en-bladen/online-lezen).

## Hoe werkt het?

De Consumentenbond gebruikt PSPDFKit om publicaties te tonen in een online reader die geen directe PDF-downloads toestaat. Deze tool gebruikt Puppeteer om:

1. In te loggen op je Consumentenbond account
2. De lijst met beschikbare publicaties op te halen
3. Elke pagina te renderen als afbeelding via de PSPDFKit API
4. De pagina's samen te voegen tot een PDF met `img2pdf`

De PDFs worden opgeslagen per jaar met genummerde edities, zodat ze overal goed sorteren:

```
output/
  2025/
    Consumentengids 01.pdf
    Consumentengids 02.pdf
    ...
    Consumentengids 07-08.pdf
    ...
    Consumentengids 12.pdf
  2026/
    Consumentengids 01.pdf
```

## Vereisten

- **Node.js** v18 of hoger — [nodejs.org](https://nodejs.org/)
- **Een Chromium-gebaseerde browser** (een van de volgende):
  - Google Chrome
  - Microsoft Edge
  - Brave
  - Chromium
- **Python 3** met `img2pdf`:
  ```
  pip install img2pdf
  ```

### Browserpad vinden

Je hebt het volledige pad naar je browser nodig:

| OS | Browser | Pad |
|---|---|---|
| Windows | Chrome | `C:\Program Files\Google\Chrome\Application\chrome.exe` |
| Windows | Edge | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` |
| macOS | Chrome | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` |
| macOS | Edge | `/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge` |
| Linux | Chrome | `/usr/bin/google-chrome` |
| Linux | Chromium | `/usr/bin/chromium-browser` |

### img2pdf pad vinden

Als `img2pdf` op je PATH staat kun je `IMG2PDF_PATH` leeg laten. Anders:

```bash
# Linux / macOS
which img2pdf

# Windows (PowerShell)
Get-Command img2pdf | Select-Object -ExpandProperty Source

# Windows (cmd)
where img2pdf
```

## Installatie

1. Clone de repository en installeer dependencies:
   ```
   git clone https://github.com/GraafG/consumentenbond-dl.git
   cd consumentenbond-dl
   npm install
   ```

2. Kopieer het voorbeeld-configuratiebestand:
   ```
   cp .env.example .env
   ```

3. Vul je Consumentenbond e-mail, wachtwoord en browserpad in in `.env`.

## Gebruik

```
npm run download
```

De tool zal:
- Een browservenster openen en automatisch inloggen
- Alle beschikbare publicaties downloaden (~40-60 MB per stuk, ~2.5 GB totaal)
- PDFs opslaan in de `./output` map, gesorteerd per jaar
- Eerder gedownloade publicaties overslaan

Voer het script opnieuw uit om nieuwe edities op te halen.

## Configuratie

Alle instellingen staan in het `.env` bestand:

| Variabele | Omschrijving | Standaard |
|---|---|---|
| `CB_EMAIL` | Je Consumentenbond e-mailadres | (verplicht) |
| `CB_PASSWORD` | Je Consumentenbond wachtwoord | (verplicht) |
| `BROWSER_PATH` | Volledig pad naar een Chromium browser | (verplicht) |
| `IMG2PDF_PATH` | Pad naar `img2pdf` | `img2pdf` (via PATH) |
| `OUTPUT_DIR` | Map voor gedownloade PDFs | `./output` |
| `PAGE_WIDTH` | Renderbreedte in pixels | `1200` |

## Problemen oplossen

- **Inloggen mislukt** — Controleer je e-mail en wachtwoord in `.env`. Test of je kunt inloggen op [consumentenbond.nl](https://www.consumentenbond.nl/).
- **"Missing BROWSER_PATH"** — Vul het volledige pad naar je browser in. Zie de tabel hierboven.
- **"Combine error"** — Zorg dat `img2pdf` geinstalleerd is (`pip install img2pdf`) en bereikbaar via PATH of `IMG2PDF_PATH`.
- **Browservenster verschijnt niet** — Het script draait in zichtbare modus. Zorg dat geen andere automatisering hetzelfde browserprofiel gebruikt.

## Offline lezen

De gedownloade PDFs kun je overzetten naar je e-reader (bijv. Kobo, Kindle, reMarkable) of tablet voor offline gebruik. De bestanden zijn geoptimaliseerd voor leesbaarheid met een renderbreedte van 1200px. Verhoog `PAGE_WIDTH` in `.env` voor hogere kwaliteit (grotere bestanden).

## Bijdragen

Bijdragen zijn welkom! Zie [CONTRIBUTING.md](CONTRIBUTING.md) voor richtlijnen.

Bugs melden of features voorstellen kan via [GitHub Issues](../../issues).

Beveiligingsproblemen? Zie [SECURITY.md](SECURITY.md).

## Disclaimer

Deze tool is bedoeld voor persoonlijk gebruik door betalende Consumentenbond leden om hun eigen publicaties offline te lezen. Deel geen gedownloade bestanden — respecteer het auteursrecht van de Consumentenbond.

## Licentie

MIT
