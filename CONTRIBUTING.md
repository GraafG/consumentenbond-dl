# Bijdragen aan consumentenbond-dl

Bedankt voor je interesse om bij te dragen!

## Hoe bij te dragen

1. Fork de repository
2. Maak een feature branch (`git checkout -b feature/mijn-verbetering`)
3. Commit je wijzigingen (`git commit -m 'Voeg X toe'`)
4. Push naar je branch (`git push origin feature/mijn-verbetering`)
5. Open een Pull Request

## Richtlijnen

- **Geen credentials** — Commit nooit wachtwoorden, tokens, of `.env` bestanden
- **Test je wijzigingen** — Zorg dat het script werkt met je eigen account voordat je een PR opent
- **Houd het simpel** — Dit is een klein project, houd wijzigingen overzichtelijk
- **Nederlands of Engels** — Beide talen zijn prima voor issues, PRs en comments

## Ideeën voor bijdragen

- Ondersteuning voor andere publicaties (Digitaalgids, Geldgids, Gezondgids, Reisgids)
- Headless modus (zonder zichtbaar browservenster)
- Automatisch nieuwe edities ophalen (bijv. via cron/scheduled task)
- Betere foutafhandeling bij trage verbindingen

## Ontwikkelen

```bash
# Installeer dependencies
npm install

# Zorg dat img2pdf beschikbaar is
pip install img2pdf

# Kopieer en vul je configuratie in
cp .env.example .env

# Draai het script
npm run download
```
