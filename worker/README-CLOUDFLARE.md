# AEGIS TICKER auf Cloudflare Workers (gratis, schläft nie)

Free-Tier: 100.000 Requests/Tag, weltweit verteilt, kein Einschlafen wie bei
anderen Gratis-Hostern. Der gesamte Server inklusive Frontend steckt in **einer
Datei**: `worker.js`.

## Weg A — Dashboard, ohne Installation (~3 Minuten)

1. Kostenloses Konto auf https://dash.cloudflare.com anlegen (nur E-Mail nötig,
   keine Kreditkarte, keine Domain)
2. Links **Workers & Pages** → **Create** → **Create Worker** → Name z. B.
   `aegis-ticker` → **Deploy** (deployt erst den Hello-World-Platzhalter)
3. **Edit code** klicken → den kompletten Inhalt von `worker.js` einfügen
   (alten Code vorher löschen) → **Deploy**
4. Fertig: Die Seite läuft unter `https://aegis-ticker.<dein-name>.workers.dev`

## Weg B — CLI (wenn Node installiert ist)

```bash
cd worker
npx wrangler login      # öffnet den Browser zum Bestätigen
npx wrangler deploy
```

## Optional: Steam-Key aktivieren

Ohne Key läuft alles über den OpenDota-Fallback (gleiche Steam-Matchdaten).
Mit Key wird die Steam Web API zur Primärquelle:

1. Key holen: https://steamcommunity.com/dev/apikey
2. Im Dashboard: Worker → **Settings → Variables and Secrets** →
   **Add** → Typ **Secret** → Name `STEAM_API_KEY`, Wert = dein Key → Save
   (per CLI: `npx wrangler secret put STEAM_API_KEY`)
3. Ob es greift, zeigt `https://…workers.dev/api/status`

## Schutz der APIs

Zweistufiger Cache (In-Memory + Cloudflare Cache API): egal wie viele Besucher,
pro Cache-Intervall geht maximal ein Request an Steam/OpenDota (Live: 15 s,
Matches: 5 min, Helden: 24 h). Bei API-Ausfall werden die letzten Daten weiter
ausgeliefert. DDoS-Schutz für den Worker selbst übernimmt Cloudflare.
