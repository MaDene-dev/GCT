console.log("[culture] Module v4 geladen");
/**
 * features/culture.js — Cultuur
 *
 * Bevestigde API-structuur:
 *   culture_overview → data.json.html (= data.html na _handleResponse)
 *   CultureOverview.init({"329":{"party":{"timestamp":...}}, ...}, {durations})
 *   class="confirm type_party  "  (twee spaties) = startbaar
 *   class="confirm type_party disabled " = loopt al / prereq niet voldaan
 *   onclick="return CultureOverview.startCelebration('party', 329);"
 */

import { randomSleep } from "../lib/delay.js";

const COSTS = {
  party:   { wood: 15_000, stone: 18_000, iron: 15_000 },
  theater: { wood: 10_000, stone: 12_000, iron: 10_000 },
  triumph: { wood: 0,      stone: 0,      iron: 0      },
  games:   { wood: 0,      stone: 0,      iron: 0      },
};

const HOUR = 3_600;

export async function runCulture(ctx) {
  const { session, config, townResources } = ctx;

  const cultureCfg = config?.culture?.towns ?? {};
  const cfgKeys    = Object.keys(cultureCfg);
  console.log(`[culture] Config: ${cfgKeys.length} steden — ${cfgKeys.join(", ")}`);

  if (!cfgKeys.length) {
    console.log("[culture] Geen cultuur-config — sla over");
    return { summary: { started: 0, skipped: 0 } };
  }

  // Eén API-call voor alle steden
  const allCultureData = await session.gameGet(
    "town_overviews", session.activeTownId, "culture_overview",
    { town_id: session.activeTownId, nl_init: true }
  );
  const allHtml = allCultureData?.html ?? "";
  console.log(`[culture] HTML: ${allHtml.length}b | init aanwezig: ${allHtml.includes("CultureOverview.init")}`);

  const { running: runningByTown } = parseCultureInit_(allHtml);
  console.log(`[culture] Lopend per stad: ${Object.keys(runningByTown).join(", ") || "geen"}`);

  let started = 0;
  let skipped = 0;
  const now = Math.floor(Date.now() / 1000);

  for (const [townIdStr, types] of Object.entries(cultureCfg)) {
    const townId     = parseInt(townIdStr, 10);
    const townRunning = runningByTown[String(townId)] || {};

    console.log(`[culture] Stad ${townId}: types=${JSON.stringify(types)} | lopend=${JSON.stringify(Object.keys(townRunning))}`);

    for (const type of types) {
      if (type === "games") continue; // games overslaan

      // Loopt er al een viering van dit type?
      const active = townRunning[type];
      if (active) {
        const ts   = active.timestamp || active.finished_at || 0;
        const left = ts - now;
        console.log(`[culture] ${townId} ${type}: loopt nog (${Math.round(left / 60)}min)`);
        continue;
      }

      // Button-check: is de viering startbaar voor deze stad?
      const canStart = canStart_(allHtml, type, townId);
      console.log(`[culture] ${townId} ${type}: canStart=${canStart}`);
      if (!canStart) { skipped++; continue; }

      // Grondstoffen-check (alleen voor party/theater)
      const cost = COSTS[type] ?? { wood: 0, stone: 0, iron: 0 };
      if (cost.wood > 0 || cost.stone > 0 || cost.iron > 0) {
        const res = townResources?.get(townId) ?? {};
        const woodOk  = (res.wood  ?? 0) >= cost.wood;
        const stoneOk = (res.stone ?? 0) >= cost.stone;
        const ironOk  = (res.iron  ?? 0) >= cost.iron;
        if (!woodOk || !stoneOk || !ironOk) {
          console.log(`[culture] ${townId} ${type}: grondstoffen te kort (hout ${woodOk} steen ${stoneOk} zilver ${ironOk})`);
          skipped++; continue;
        }
      }

      // Start de viering
      console.log(`[culture] ${townId} ${type}: starten…`);
      try {
        // celebration_type moet in de JSON body zitten, niet als URL param (bevestigd via F12)
        const result = await session.gamePost(
          "town_overviews", session.activeTownId, "start_celebration",
          { town_id: townId, celebration_type: type, no_bar: 1, nl_init: true }
        );
        if (result?.success) {
          const finishAt = result.finished_at;
          const timeStr  = finishAt
            ? new Date(finishAt * 1000).toLocaleTimeString("nl-BE", { timeZone: "Europe/Brussels" })
            : "";
          console.log(`[culture] ✓ ${townId} ${type} gestart${timeStr ? " → eindigt " + timeStr : ""}`);
          started++;
        } else {
          const errKey = result?.error?.key ?? result?.error ?? result?.message ?? JSON.stringify(result)?.slice(0, 80);
          console.warn(`[culture] ✗ ${townId} ${type}: ${errKey}`);
          skipped++;
        }
      } catch (err) {
        console.warn(`[culture] ✗ ${townId} ${type}: ${err.message}`);
        skipped++;
      }

      await randomSleep(1, 2);
    }
  }

  console.log(`[culture] ✓ ${started} gestart | ${skipped} overgeslagen`);
  return { summary: { started, skipped, towns_configured: cfgKeys.length } };
}

/**
 * fetchCultureOverview — voor dashboard (fire-and-forget vanuit index.js)
 * Retourneert per stad: lopende vieringen + beschikbare/uitgeschakelde types
 */
export async function fetchCultureOverview(session) {
  try {
    const data = await session.gameGet(
      "town_overviews", session.activeTownId, "culture_overview",
      { town_id: session.activeTownId, nl_init: true }
    );
    const html = data?.html ?? "";
    if (!html) return {};

    const { running: runningByTown } = parseCultureInit_(html);
    const result = {};
    const now = Math.floor(Date.now() / 1000);

    const TYPES = ["party", "theater", "triumph", "games"];
    TYPES.forEach(type => {
      const pattern = "startCelebration('" + type + "',";
      let idx = html.indexOf(pattern);
      while (idx !== -1) {
        const townMatch = html.slice(idx, idx + 50).match(/startCelebration\('[\w]+',\s*(\d+)/);
        if (townMatch) {
          const tid = parseInt(townMatch[1], 10);
          if (!result[tid]) result[tid] = { running: [], available: [], disabled: [] };
          const snippet = html.slice(Math.max(0, idx - 200), idx);
          const isDisabled = snippet.includes('class="confirm type_' + type + ' disabled') ||
                             snippet.includes("class='confirm type_" + type + " disabled");
          if (isDisabled) result[tid].disabled.push(type);
          else result[tid].available.push(type);
        }
        idx = html.indexOf(pattern, idx + 1);
      }
    });

    // Voeg lopende vieringen toe
    for (const [tidStr, types] of Object.entries(runningByTown)) {
      const tid = parseInt(tidStr, 10);
      if (!result[tid]) result[tid] = { running: [], available: [], disabled: [] };
      for (const [type, info] of Object.entries(types)) {
        result[tid].running.push({ type, finished_at: info.timestamp || info.finished_at });
      }
    }

    return result;
  } catch (e) {
    console.warn("[culture] fetchCultureOverview fout:", e.message);
    return {};
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Parse CultureOverview.init({"329":{"party":{"timestamp":...}}, ...}, {durations})
 * Retourneert running per stad als object.
 */
function parseCultureInit_(html) {
  const idx = html.indexOf("CultureOverview.init(");
  if (idx === -1) return { running: {}, durations: {} };

  const firstBrace = html.indexOf("{", idx);
  if (firstBrace === -1) return { running: {}, durations: {} };

  const obj1 = extractBalanced_(html, firstBrace);
  let running = {};
  if (obj1) { try { running = JSON.parse(obj1.str); } catch {} }

  let durations = {};
  if (obj1) {
    const pos2 = html.indexOf("{", obj1.end + 1);
    if (pos2 !== -1) {
      const obj2 = extractBalanced_(html, pos2);
      if (obj2) { try { durations = JSON.parse(obj2.str); } catch {} }
    }
  }

  return { running, durations };
}

/**
 * Check of een vieringstype startbaar is voor een specifieke stad.
 * Zoekt het onclick-patroon startCelebration('type', townId) en
 * controleert de klasse in de 250 chars vóór die positie.
 */
function canStart_(html, type, townId) {
  const searchStr = "startCelebration('" + type + "', " + townId + ")";
  const idx = html.indexOf(searchStr);
  if (idx === -1) return false;

  const snippet = html.slice(Math.max(0, idx - 250), idx);
  const disabled = snippet.includes('class="confirm type_' + type + ' disabled') ||
                   snippet.includes("class='confirm type_" + type + " disabled");
  if (disabled) return false;

  const hasBtn = snippet.includes('class="confirm type_' + type) ||
                 snippet.includes("class='confirm type_" + type);
  return hasBtn;
}

function extractBalanced_(str, start) {
  if (str[start] !== "{") return null;
  let depth = 0, end = start;
  for (let i = start; i < str.length; i++) {
    if (str[i] === "{") depth++;
    else if (str[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  return { str: str.slice(start, end + 1), end };
}
