console.log("[culture] Module v5 geladen");
/**
 * features/culture.js — Cultuur v5
 *
 * Fase 1: pre-stock 60 min voor viering afloopt + meteen als viering kan starten
 * Fase 2: topup per stad (makkelijkste eerst = meeste grondstoffen aanwezig)
 * Fase 3: starten — één voor één
 */

import { randomSleep } from "../lib/delay.js";
import { runCultureTopup } from "./resource-balancer.js";

const COSTS = {
  party:   { wood: 15_000, stone: 18_000, iron: 15_000 },
  theater: { wood: 10_000, stone: 12_000, iron: 10_000 },
  triumph: { wood: 0,      stone: 0,      iron: 0      },
  games:   { wood: 0,      stone: 0,      iron: 0      },
};

const PRE_STOCK_MIN = 60;   // Minuten voor afloop: al aanvullen

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
  console.log(`[culture] HTML: ${allHtml.length}b | init: ${allHtml.includes("CultureOverview.init")}`);

  const { running: runningByTown } = parseCultureInit_(allHtml);
  const now = Math.floor(Date.now() / 1000);

  // ── Fase 1: bepaal resource-behoeften ────────────────────────────────────
  // a) Towns waar viering nu startbaar is + resources ontbreken
  // b) Towns waar viering < PRE_STOCK_MIN afloopt → pre-stock alvast
  const topupTargets = []; // {townId, name, wood, stone, iron, reason}
  const resourceStatus = {}; // "townId_type" → status string

  for (const [townIdStr, types] of Object.entries(cultureCfg)) {
    const townId      = parseInt(townIdStr, 10);
    const townRunning = runningByTown[String(townId)] || {};

    for (const type of types) {
      if (type === "games") continue;
      const cost = COSTS[type] ?? {};
      if (!cost.wood && !cost.stone && !cost.iron) continue;

      const running   = townRunning[type];
      const res       = townResources?.get(townId) ?? {};
      const resKey    = `${townId}_${type}`;
      const needW     = Math.max(0, (cost.wood  || 0) - (res.wood  ?? 0));
      const needS     = Math.max(0, (cost.stone || 0) - (res.stone ?? 0));
      const needI     = Math.max(0, (cost.iron  || 0) - (res.iron  ?? 0));
      const shortage  = needW + needS + needI;
      const hasEnough = shortage === 0;

      if (running) {
        const left = (running.timestamp || 0) - now;
        if (left < PRE_STOCK_MIN * 60 && left > 0 && !hasEnough) {
          console.log(`[culture] Pre-stock: ${townId} ${type} eindigt over ${Math.round(left/60)}min — aanvullen`);
          addOrMergeTarget_(topupTargets, townId, getName_(ctx, townId), needW, needS, needI, "pre-stock");
          resourceStatus[resKey] = "pre_stock";
        } else if (hasEnough) {
          resourceStatus[resKey] = "genoeg";
        }
      } else {
        // Niet lopend — kan direct starten?
        if (canStart_(allHtml, type, townId)) {
          if (!hasEnough) {
            addOrMergeTarget_(topupTargets, townId, getName_(ctx, townId), needW, needS, needI, "direct");
            resourceStatus[resKey] = "topup_nodig";
          } else {
            resourceStatus[resKey] = "genoeg";
          }
        } else if (shortage > 0) {
          // canStart=false maar resources te kort → misschien IS het geblokkeerd door grondstoffen
          // Pre-stock alvast; als het toch academie/cooldown is, is de transfer niet verspild
          // (resources blijven in de stad voor volgende keer)
          console.log(`[culture] ${townId} ${type}: canStart=false + tekort 🪵${needW} 🪨${needS} 🪙${needI} → pre-stock`);
          addOrMergeTarget_(topupTargets, townId, getName_(ctx, townId), needW, needS, needI, "blocked pre-stock");
          resourceStatus[resKey] = "pre_stock";
        } else {
          resourceStatus[resKey] = "niet_beschikbaar";
        }
      }
    }
  }

  // Fase 2: topup — alle targets in één gecombineerde call
  const allTopupTransfers = [];

  if (topupTargets.length > 0) {
    console.log(`[culture] Topup voor ${topupTargets.length} steden`);
    for (const target of topupTargets) {
      console.log(`[culture] Topup ${target.name}: 🪵${target.wood} 🪨${target.stone} 🪙${target.iron} (${target.reason})`);
    }

    // Één call voor alle targets — pool-planner verwerkt ze samen
    const topupResult = await runCultureTopup(ctx, topupTargets);
    const resultState = topupResult.state || new Map();
    allTopupTransfers.push(...(topupResult.transferList || []));

    // Update resourceStatus vanuit gecombineerde state
    for (const target of topupTargets) {
      const townState = resultState.get ? resultState.get(target.townId) : null;
      for (const type of (cultureCfg[String(target.townId)] || [])) {
        if (type === "games") continue;
        const cost = COSTS[type] ?? {};
        if (!cost.wood && !cost.stone && !cost.iron) continue;
        const resKey = `${target.townId}_${type}`;
        const tw = townState?.eff_wood  ?? townState?.wood  ?? 0;
        const ts = townState?.eff_stone ?? townState?.stone ?? 0;
        const ti = townState?.eff_iron  ?? townState?.iron  ?? 0;
        if (tw >= (cost.wood||0) && ts >= (cost.stone||0) && ti >= (cost.iron||0)) {
          resourceStatus[resKey] = "onderweg";
        } else {
          resourceStatus[resKey] = "te_kort";
        }
      }
    }
  }

  // ── Fase 3: vieringen starten — één voor één ─────────────────────────────
  let started = 0;
  let skipped = 0;

  // Sorteer steden: eerst steden met meeste grondstoffen aanwezig (makkelijkste first)
  const sortedTownIds = Object.keys(cultureCfg).sort((a, b) => {
    const resA = townResources?.get(parseInt(a)) ?? {};
    const resB = townResources?.get(parseInt(b)) ?? {};
    const totA = (resA.wood||0) + (resA.stone||0) + (resA.iron||0);
    const totB = (resB.wood||0) + (resB.stone||0) + (resB.iron||0);
    return totB - totA; // descending
  });

  for (const townIdStr of sortedTownIds) {
    const townId      = parseInt(townIdStr, 10);
    const types       = cultureCfg[townIdStr];
    const townRunning = runningByTown[String(townId)] || {};

    console.log(`[culture] ${getName_(ctx, townId)} (${townId}): types=${JSON.stringify(types)} | lopend=${JSON.stringify(Object.keys(townRunning))}`);

    for (const type of types) {
      if (type === "games") continue;

      const active = townRunning[type];
      if (active) {
        const left = (active.timestamp || 0) - now;
        console.log(`[culture] ${getName_(ctx, townId)} ${type}: loopt nog (${Math.round(left / 60)}min)`);
        continue;
      }

      const canStart = canStart_(allHtml, type, townId);
      console.log(`[culture] ${getName_(ctx, townId)} ${type}: canStart=${canStart}`);
      if (!canStart) { skipped++; continue; }

      const cost = COSTS[type] ?? {};
      if (cost.wood > 0 || cost.stone > 0 || cost.iron > 0) {
        const res     = townResources?.get(townId) ?? {};
        const woodOk  = (res.wood  ?? 0) >= cost.wood;
        const stoneOk = (res.stone ?? 0) >= cost.stone;
        const ironOk  = (res.iron  ?? 0) >= cost.iron;
        if (!woodOk || !stoneOk || !ironOk) {
          const resKey = `${townId}_${type}`;
          console.log(`[culture] ${getName_(ctx, townId)} ${type}: nog te kort na topup`);
          resourceStatus[resKey] = "te_kort";
          skipped++; continue;
        }
      }

      console.log(`[culture] ${getName_(ctx, townId)} ${type}: starten…`);
      try {
        const result = await session.gamePost(
          "town_overviews", session.activeTownId, "start_celebration",
          { town_id: townId, celebration_type: type, no_bar: 1, nl_init: true }
        );
        if (result?.success) {
          const fa = result.finished_at;
          const end = fa ? new Date(fa*1000).toLocaleTimeString("nl-BE",{timeZone:"Europe/Brussels"}) : "";
          console.log(`[culture] ✓ ${townId} ${type} gestart${end?" → eindigt "+end:""}`);
          started++;
          resourceStatus[`${townId}_${type}`] = "gestart";
        } else {
          const errKey = result?.error?.key ?? result?.error ?? result?.message ?? JSON.stringify(result)?.slice(0,80);
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
  if (allTopupTransfers.length > 0) {
    console.log(`[culture] Topup samenvatting: ${allTopupTransfers.length} transfers voor cultuur`);
  }

  return {
    summary: {
      started, skipped,
      towns_configured: cfgKeys.length,
      resourceStatus,
      topupCount:        topupTargets.length,
      topupTransferList: allTopupTransfers, // voor KPI + audit log
    }
  };
}

/**
 * fetchCultureOverview — voor dashboard + cultureel level
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

    // Parse cultureel level + CP + gevechtspunten
    const lvlMatch  = html.match(/place_culture_level[^>]*>[^:]*:\s*(\d+)/);
    const cpMatch   = html.match(/place_culture_count[^>]*>[\s\S]*?(\d+)\/(\d+)/);
    const gp1Match  = html.match(/points_count[^>]*>[\s\S]*?(\d[\d.,]*)\s*\/\s*(\d[\d.,]*)/);

    const culturalLevel = lvlMatch  ? parseInt(lvlMatch[1], 10) : null;
    const cpCurrent     = cpMatch   ? parseInt(cpMatch[1].replace(/\D/g,""), 10) : null;
    const cpMax         = cpMatch   ? parseInt(cpMatch[2].replace(/\D/g,""), 10) : null;
    const gpCurrent     = gp1Match  ? parseInt(gp1Match[1].replace(/[.,\s]/g,""), 10) : null;
    const gpNeeded      = gp1Match  ? parseInt(gp1Match[2].replace(/[.,\s]/g,""), 10) : null;

    // Debug logging zodat we de HTML-structuur kunnen valideren
    const snip = (keyword) => {
      const i = html.indexOf(keyword);
      if (i < 0) return "NOT FOUND";
      return html.slice(i, i + 80).split("").filter(c => c >= " ").join("");
    };
    console.log("[culture-kpi] level match:", culturalLevel, "| HTML:", snip("place_culture_level"));
    console.log("[culture-kpi] CP    match:", cpCurrent + "/" + cpMax, "| HTML:", snip("place_culture_count"));
    console.log("[culture-kpi] GP    match:", gpCurrent + "/" + gpNeeded, "| HTML:", snip("points_count"));

    const result = {};
    const TYPES = ["party", "theater", "triumph", "games"];

    TYPES.forEach(type => {
      const pattern = `startCelebration('${type}',`;
      let idx = html.indexOf(pattern);
      while (idx !== -1) {
        const tm = html.slice(idx, idx+50).match(/startCelebration\('[\w]+',\s*(\d+)/);
        if (tm) {
          const tid = parseInt(tm[1], 10);
          if (!result[tid]) result[tid] = { running: [], available: [], disabled: [] };
          const snippet  = html.slice(Math.max(0, idx-200), idx);
          const isDis    = snippet.includes(`class="confirm type_${type} disabled`);
          if (isDis) result[tid].disabled.push(type);
          else result[tid].available.push(type);
        }
        idx = html.indexOf(pattern, idx+1);
      }
    });

    for (const [tidStr, types] of Object.entries(runningByTown)) {
      const tid = parseInt(tidStr, 10);
      if (!result[tid]) result[tid] = { running: [], available: [], disabled: [] };
      for (const [type, info] of Object.entries(types)) {
        result[tid].running.push({ type, finished_at: info.timestamp || info.finished_at });
      }
    }

    return { towns: result, culturalLevel, cpCurrent, cpMax, gpCurrent, gpNeeded };
  } catch (e) {
    console.warn("[culture] fetchCultureOverview fout:", e.message);
    return {};
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const getName_ = (ctx, townId) => ctx?.townNames?.[townId] || ctx?.townNames?.[String(townId)] || String(townId);

function addOrMergeTarget_(targets, townId, name, wood, stone, iron, reason) {
  const ex = targets.find(t => t.townId === townId);
  if (ex) {
    ex.wood  = Math.max(ex.wood,  wood);
    ex.stone = Math.max(ex.stone, stone);
    ex.iron  = Math.max(ex.iron,  iron);
  } else {
    targets.push({ townId, name, wood, stone, iron, reason });
  }
}

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
    if (pos2 !== -1) { const obj2 = extractBalanced_(html, pos2); if (obj2) { try { durations = JSON.parse(obj2.str); } catch {} } }
  }
  return { running, durations };
}

function canStart_(html, type, townId) {
  const searchStr = `startCelebration('${type}', ${townId})`;
  const idx = html.indexOf(searchStr);
  if (idx === -1) return false;
  const snippet  = html.slice(Math.max(0, idx-250), idx);
  const disabled = snippet.includes(`class="confirm type_${type} disabled`) ||
                   snippet.includes(`class='confirm type_${type} disabled`);
  if (disabled) return false;
  return snippet.includes(`class="confirm type_${type}`) ||
         snippet.includes(`class='confirm type_${type}`);
}

function extractBalanced_(str, start) {
  if (str[start] !== "{") return null;
  let depth = 0, end = start;
  for (let i = start; i < str.length; i++) {
    if (str[i] === "{") depth++;
    else if (str[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  return { str: str.slice(start, end+1), end };
    }
        
