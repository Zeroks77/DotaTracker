/**
 * AEGIS TICKER — Server
 * Proxy + Cache vor der Steam Web API (primär) und OpenDota (Fallback/Ergänzung).
 * Schützt die APIs: egal wie viele Besucher die Seite hat, pro Cache-Intervall
 * geht maximal EIN Request an Steam/OpenDota raus.
 */
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const STEAM_KEY = process.env.STEAM_API_KEY || ""; // https://steamcommunity.com/dev/apikey

const STEAM = "https://api.steampowered.com";
const OD = "https://api.opendota.com/api";

/* ---------- Cache (in-memory, TTL + stale-while-error) ---------- */
const cache = new Map();
const inflight = new Map(); // verhindert parallele Doppel-Requests

async function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.time < ttlMs) return hit.data;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const data = await loader();
      cache.set(key, { data, time: Date.now() });
      return data;
    } catch (err) {
      if (hit) {
        console.warn(`[cache] Upstream-Fehler für ${key}, liefere alte Daten:`, err.message);
        return hit.data;
      }
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

async function getJSON(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "aegis-ticker" } });
    if (!r.ok) throw new Error(`HTTP ${r.status} von ${new URL(url).host}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/* ---------- Rate-Limit pro IP (Schutz des eigenen Servers) ---------- */
const hits = new Map();
app.use("/api", (req, res, next) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
  const now = Date.now();
  const rec = hits.get(ip) || { n: 0, start: now };
  if (now - rec.start > 60000) { rec.n = 0; rec.start = now; }
  rec.n++;
  hits.set(ip, rec);
  if (hits.size > 5000) hits.clear(); // Speicher schützen
  if (rec.n > 120) return res.status(429).json({ error: "Zu viele Anfragen, bitte kurz warten." });
  next();
});

/* ---------- Helden: Steam GetHeroes primär ---------- */
function heroImageFromName(npcName) {
  const short = String(npcName).replace("npc_dota_hero_", "");
  return `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/${short}.png`;
}

app.get("/api/heroes", async (req, res) => {
  try {
    const data = await cached("heroes", 24 * 3600e3, async () => {
      if (STEAM_KEY) {
        try {
          const j = await getJSON(`${STEAM}/IEconDOTA2_570/GetHeroes/v1/?key=${STEAM_KEY}&language=de`);
          return j.result.heroes.map(h => ({
            id: h.id,
            localized_name: h.localized_name || h.name,
            img: heroImageFromName(h.name),
          }));
        } catch (e) { console.warn("[heroes] Steam fehlgeschlagen → OpenDota:", e.message); }
      }
      const j = await getJSON(`${OD}/heroes`);
      return j.map(h => ({ id: h.id, localized_name: h.localized_name, img: heroImageFromName(h.name) }));
    });
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* ---------- LIVE: Steam GetLiveLeagueGames primär ---------- */
function normalizeSteamLive(j) {
  const games = j?.result?.games || [];
  return games.map(g => {
    const sb = g.scoreboard || {};
    const mk = (ps, team) => (ps || []).map(p => ({
      account_id: p.account_id, hero_id: p.hero_id, team, net_worth: p.net_worth,
    }));
    let players = [...mk(sb.radiant?.players, 0), ...mk(sb.dire?.players, 1)];
    if (!players.length) {
      players = (g.players || [])
        .filter(p => p.team === 0 || p.team === 1)
        .map(p => ({ account_id: p.account_id, hero_id: p.hero_id, team: p.team, name: p.name }));
    }
    const nameById = {};
    for (const p of g.players || []) if (p.account_id) nameById[p.account_id] = p.name;
    for (const p of players) if (!p.name && nameById[p.account_id]) p.name = nameById[p.account_id];

    const gold = t => players.filter(p => p.team === t).reduce((s, p) => s + (p.net_worth || 0), 0);
    return {
      source: "steam",
      match_id: g.match_id,
      league_id: g.league_id,
      series_type: g.series_type,
      radiant_series_wins: g.radiant_series_wins || 0,
      dire_series_wins: g.dire_series_wins || 0,
      team_name_radiant: g.radiant_team?.team_name || "Radiant",
      team_name_dire: g.dire_team?.team_name || "Dire",
      radiant_score: sb.radiant?.score ?? 0,
      dire_score: sb.dire?.score ?? 0,
      game_time: sb.duration ?? 0,
      radiant_lead: gold(0) - gold(1),
      spectators: g.spectators || 0,
      players,
    };
  });
}

app.get("/api/live", async (req, res) => {
  try {
    const data = await cached("live", 15e3, async () => {
      if (STEAM_KEY) {
        try {
          const j = await getJSON(`${STEAM}/IDOTA2Match_570/GetLiveLeagueGames/v1/?key=${STEAM_KEY}`);
          return { source: "steam", league: normalizeSteamLive(j), pub: [] };
        } catch (e) { console.warn("[live] Steam fehlgeschlagen → OpenDota:", e.message); }
      }
      const j = await getJSON(`${OD}/live`);
      return {
        source: "opendota",
        league: j.filter(g => g.league_id),
        pub: j.filter(g => !g.league_id).slice(0, 6),
      };
    });
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* ---------- Pro-Matches (Liste) — OpenDota (Steam hat keine
     kuratierte Pro-Liste mit Liganamen), 5 Min Cache ---------- */
app.get("/api/proMatches", async (req, res) => {
  try {
    const data = await cached("proMatches", 5 * 60e3, async () => {
      const p1 = await getJSON(`${OD}/proMatches`);
      let all = p1;
      try {
        const minId = Math.min(...p1.map(m => m.match_id));
        const p2 = await getJSON(`${OD}/proMatches?less_than_match_id=${minId}`);
        all = p1.concat(p2);
      } catch {}
      return all;
    });
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* ---------- Match-Details: Steam primär + OpenDota-Anreicherung ---------- */
function normalizeSteamMatch(r) {
  return {
    source: "steam",
    match_id: r.match_id,
    duration: r.duration,
    start_time: r.start_time,
    radiant_win: r.radiant_win,
    radiant_score: r.radiant_score,
    dire_score: r.dire_score,
    radiant_name: r.radiant_name,
    dire_name: r.dire_name,
    league: { leagueid: r.leagueid },
    players: (r.players || []).map(p => ({
      account_id: p.account_id, player_slot: p.player_slot, hero_id: p.hero_id,
      kills: p.kills, deaths: p.deaths, assists: p.assists,
      gold_per_min: p.gold_per_min, xp_per_min: p.xp_per_min,
      last_hits: p.last_hits, net_worth: p.net_worth ?? p.gold,
      hero_damage: p.hero_damage, isRadiant: p.player_slot < 128,
    })),
  };
}

app.get("/api/match/:id", async (req, res) => {
  const id = String(req.params.id).replace(/\D/g, "");
  if (!id) return res.status(400).json({ error: "Ungültige Match-ID" });
  try {
    const data = await cached("match:" + id, 6 * 3600e3, async () => {
      let base = null;
      if (STEAM_KEY) {
        try {
          const j = await getJSON(`${STEAM}/IDOTA2Match_570/GetMatchDetails/v1/?key=${STEAM_KEY}&match_id=${id}`);
          if (j.result && !j.result.error) base = normalizeSteamMatch(j.result);
        } catch (e) { console.warn("[match] Steam fehlgeschlagen:", e.message); }
      }
      try {
        const od = await getJSON(`${OD}/matches/${id}`);
        if (!base) return od;
        base.league = od.league || base.league;
        base.radiant_name = base.radiant_name || od.radiant_name;
        base.dire_name = base.dire_name || od.dire_name;
        base.radiant_gold_adv = od.radiant_gold_adv;
      } catch {}
      if (!base) throw new Error("Match-Daten nicht verfügbar");
      return base;
    });
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* ---------- Pro-Spieler, Ligen, Helden-Statistiken ---------- */
app.get("/api/proPlayers", async (req, res) => {
  try {
    const data = await cached("proPlayers", 12 * 3600e3, async () => {
      const j = await getJSON(`${OD}/proPlayers`, 25000);
      const map = {};
      for (const p of j) map[p.account_id] = p.name;
      return map;
    });
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/leagues", async (req, res) => {
  try { res.json(await cached("leagues", 6 * 3600e3, () => getJSON(`${OD}/leagues`, 25000))); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/heroStats", async (req, res) => {
  try { res.json(await cached("heroStats", 3600e3, () => getJSON(`${OD}/heroStats`, 25000))); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/status", (req, res) => {
  res.json({
    steam: STEAM_KEY ? "Key konfiguriert ✓ — Steam ist Primärquelle" : "Kein Key — OpenDota-Fallback aktiv",
    cacheEntries: cache.size,
  });
});

/* ---------- Statisches Frontend ---------- */
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`AEGIS TICKER läuft auf Port ${PORT}`);
  console.log(STEAM_KEY
    ? "Steam-API-Key gefunden — Steam ist Primärquelle."
    : "Kein STEAM_API_KEY gesetzt — OpenDota-Fallback. Key holen: https://steamcommunity.com/dev/apikey");
});
