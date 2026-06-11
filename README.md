# AEGIS TICKER — Dota 2 Liveticker

**Live:** https://zeroks77.github.io/dotatracker/

Liveticker für die Dota-2-Pro-Szene: Live-Spiele mit Scoreboard im Ingame-HUD-Stil,
Ergebnisse nach Liga & Qualifier, Pro-Spieler-Erkennung, Match-Statistiken
(KDA/GPM/XPM/Gold-Graph), Pro-Meta — mit synthetischen Sounds (Web Audio) und Animationen.

## Varianten in diesem Repo

| Variante | Pfad | Hosting |
|---|---|---|
| **Statisch** (diese Live-Seite) | `index.html` | GitHub Pages — spricht OpenDota direkt an |
| **Cloudflare Worker** (Endausbau) | `worker/` | workers.dev — Steam Web API primär + Cache-Schutz, siehe `worker/README-CLOUDFLARE.md` |
| Express-Server | `server/` | beliebiger Node-Host |

Die Worker-Variante schont die APIs (max. 1 Upstream-Request pro Cache-Intervall,
egal wie viele Besucher) und nutzt mit `STEAM_API_KEY` die Steam Web API als Primärquelle.

Datenquellen: Steam Web API / OpenDota (Valve-Matchdaten). Hero-Grafiken: Steam-CDN.
