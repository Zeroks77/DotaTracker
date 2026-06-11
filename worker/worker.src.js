/**
 * AEGIS TICKER — Cloudflare Worker
 * Komplett-Server in einer Datei: API-Proxy mit zweistufigem Cache
 * (In-Memory + Cloudflare Cache API) vor der Steam Web API (primär)
 * und OpenDota (Fallback/Ergänzung). Frontend ist unten eingebettet.
 *
 * Optional: STEAM_API_KEY als Secret setzen (Settings → Variables),
 * dann ist Steam die Primärquelle. Ohne Key läuft alles über OpenDota.
 */

const STEAM = "https://api.steampowered.com";
const OD = "https://api.opendota.com/api";

/* ---------- Cache: L1 In-Memory (pro Isolate) + L2 Cache API ---------- */
const mem = new Map();

async function cached(key, ttlSec, loader) {
  const now = Date.now();
  const m = mem.get(key);
  if (m && now - m.time < ttlSec * 1000) return m.data;

  const cacheUrl = "https://aegis.cache/" + key;
  const cacheStore = caches.default;

  // L2: frischer Cache-Eintrag?
  const hit = await cacheStore.match(cacheUrl);
  if (hit) {
    const age = now - Number(hit.headers.get("x-time") || 0);
    if (age < ttlSec * 1000) {
      const data = await hit.json();
      mem.set(key, { data, time: now - age });
      return data;
    }
  }

  try {
    const data = await loader();
    mem.set(key, { data, time: now });
    const body = JSON.stringify(data);
    const headers = { "content-type": "application/json", "x-time": String(now), "cache-control": "max-age=86400" };
    await cacheStore.put(cacheUrl, new Response(body, { headers }));
    await cacheStore.put(cacheUrl + "/backup", new Response(body, { headers })); // stale-while-error-Kopie
    return data;
  } catch (err) {
    // stale-while-error: alte Daten weiter ausliefern
    const backup = (await cacheStore.match(cacheUrl)) || (await cacheStore.match(cacheUrl + "/backup"));
    if (backup) return backup.json();
    if (m) return m.data;
    throw err;
  }
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

/* ---------- Normalisierung Steam → gemeinsames Format ---------- */
const heroImageFromName = n =>
  `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/${String(n).replace("npc_dota_hero_", "")}.png`;

function normalizeSteamLive(j) {
  const games = j?.result?.games || [];
  return games.map(g => {
    const sb = g.scoreboard || {};
    const mk = (ps, team) => (ps || []).map(p => ({ account_id: p.account_id, hero_id: p.hero_id, team, net_worth: p.net_worth }));
    let players = [...mk(sb.radiant?.players, 0), ...mk(sb.dire?.players, 1)];
    if (!players.length) {
      players = (g.players || []).filter(p => p.team === 0 || p.team === 1)
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

/* ---------- API-Handler ---------- */
const handlers = {
  async heroes(env) {
    return cached("heroes", 24 * 3600, async () => {
      if (env.STEAM_API_KEY) {
        try {
          const j = await getJSON(`${STEAM}/IEconDOTA2_570/GetHeroes/v1/?key=${env.STEAM_API_KEY}&language=de`);
          return j.result.heroes.map(h => ({ id: h.id, localized_name: h.localized_name || h.name, img: heroImageFromName(h.name) }));
        } catch (e) { console.log("[heroes] Steam → OpenDota:", e.message); }
      }
      const j = await getJSON(`${OD}/heroes`);
      return j.map(h => ({ id: h.id, localized_name: h.localized_name, img: heroImageFromName(h.name) }));
    });
  },

  async live(env) {
    return cached("live", 15, async () => {
      if (env.STEAM_API_KEY) {
        try {
          const j = await getJSON(`${STEAM}/IDOTA2Match_570/GetLiveLeagueGames/v1/?key=${env.STEAM_API_KEY}`);
          return { source: "steam", league: normalizeSteamLive(j), pub: [] };
        } catch (e) { console.log("[live] Steam → OpenDota:", e.message); }
      }
      const j = await getJSON(`${OD}/live`);
      return {
        source: "opendota",
        league: j.filter(g => g.league_id),
        pub: j.filter(g => !g.league_id).slice(0, 6),
      };
    });
  },

  async proMatches() {
    return cached("proMatches", 5 * 60, async () => {
      const p1 = await getJSON(`${OD}/proMatches`);
      let all = p1;
      try {
        const minId = Math.min(...p1.map(m => m.match_id));
        const p2 = await getJSON(`${OD}/proMatches?less_than_match_id=${minId}`);
        all = p1.concat(p2);
      } catch {}
      return all;
    });
  },

  async match(env, id) {
    return cached("match-" + id, 6 * 3600, async () => {
      let base = null;
      if (env.STEAM_API_KEY) {
        try {
          const j = await getJSON(`${STEAM}/IDOTA2Match_570/GetMatchDetails/v1/?key=${env.STEAM_API_KEY}&match_id=${id}`);
          if (j.result && !j.result.error) base = normalizeSteamMatch(j.result);
        } catch (e) { console.log("[match] Steam:", e.message); }
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
  },

  async proPlayers() {
    return cached("proPlayers", 12 * 3600, async () => {
      const j = await getJSON(`${OD}/proPlayers`, 25000);
      const map = {};
      for (const p of j) map[p.account_id] = p.name;
      return map;
    });
  },

  async leagues() {
    return cached("leagues", 6 * 3600, () => getJSON(`${OD}/leagues`, 25000));
  },

  async heroStats() {
    return cached("heroStats", 3600, () => getJSON(`${OD}/heroStats`, 25000));
  },
};

/* ---------- Worker-Einstieg ---------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

    try {
      if (p === "/api/status") {
        return json({
          steam: env.STEAM_API_KEY ? "Key konfiguriert ✓ — Steam ist Primärquelle" : "Kein Key — OpenDota-Fallback aktiv",
          plattform: "Cloudflare Workers",
        });
      }
      if (p === "/api/heroes") return json(await handlers.heroes(env));
      if (p === "/api/live") return json(await handlers.live(env));
      if (p === "/api/proMatches") return json(await handlers.proMatches());
      if (p === "/api/proPlayers") return json(await handlers.proPlayers());
      if (p === "/api/leagues") return json(await handlers.leagues());
      if (p === "/api/heroStats") return json(await handlers.heroStats());
      const matchM = p.match(/^\/api\/match\/(\d+)$/);
      if (matchM) return json(await handlers.match(env, matchM[1]));
      if (p.startsWith("/api/")) return json({ error: "Unbekannter Endpunkt" }, 404);
    } catch (e) {
      return json({ error: e.message }, 502);
    }

    // Alles andere: Frontend ausliefern
    return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "max-age=3600" } });
  },
};

/* ---------- Eingebettetes Frontend (wird vom Build-Skript ersetzt) ---------- */
const HTML = __HTML_PLACEHOLDER__;
