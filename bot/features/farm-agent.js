/**
 * features/farm-agent.js — Farm-Agent
 *
 * Claimt boerderij-grondstoffen voor alle eigen dorpen.
 * - time_option bepaald door actief scheduler-profiel
 * - Eén stad per eiland (island assignment)
 * - Altijd claimen — opslag nooit een reden om over te slaan
 * - Geeft overflowTowns terug voor de Resource Balancer
 */

import { randomSleep, shuffle } from "../lib/delay.js";
import { fetchHidesData }        from "./hides.js";

// Profiel → time_options mapping (seconden)
const PROFILE_OPTIONS = {
  intense: { booty: 600,   base: 300   },
  normal:  { booty: 2400,  base: 1200  },
  relaxed: { booty: 10800, base: 5400  },
  night:   { booty: 28800, base: 14400 },
};

const OVERFLOW_PCT = 0.85; // % waarboven een stad als overflow wordt gemarkeerd na claim

/**
 * @param {{ session, config, gasCallbackUrl, runId }} ctx
 * @returns {{ overflowTowns: object[], summary: object }}
 */
export async function runFarmAgent(ctx) {
  const { session, config } = ctx;
  const profile = config.scheduler?.profile ?? "intense";
  const timeOpts = PROFILE_OPTIONS[profile] ?? PROFILE_OPTIONS.intense;

  // ── 1. Alle eigen steden ophalen ───────────────────────────────────────

  const townsData = await session.gameGet(
    "farm_town_overviews",
    session.activeTownId,
    "index",
    { town_id: session.activeTownId, nl_init: true }
  );

  const allTowns = townsData?.towns ?? [];
  if (allTowns.length === 0) {
    console.warn("[farm-agent] Geen steden gevonden");
    return { overflowTowns: [], summary: { towns_claimed: 0 } };
  }

  // ── 2. Island assignment — één stad per eiland ─────────────────────────

  const assignments = config.farmAgent?.islandAssignments ?? {};

  // Debug: toon alle steden + coördinaten
  console.log(`[farm-agent] ${allTowns.length} steden geladen`);

  const islandMap = new Map(); // "x_y" → [town, ...]

  for (const town of allTowns) {
    // Normaliseer coördinaten naar integer (API geeft soms floats: 475.0)
    const ix  = Math.round(Number(town.island_x));
    const iy  = Math.round(Number(town.island_y));
    const key = `${ix}_${iy}`;
    // Sla genormaliseerde coords op zodat alle vergelijkingen consistent zijn
    town._islandKey = key;
    if (!islandMap.has(key)) islandMap.set(key, []);
    islandMap.get(key).push(town);
  }

  // Debug: toon eilanden met meerdere steden
  for (const [key, towns] of islandMap) {
    if (towns.length > 1) {
      console.log(`[farm-agent] Eiland ${key} heeft ${towns.length} eigen steden: ${towns.map(t => t.name).join(", ")}`);
    }
  }
  console.log(`[farm-agent] Bestaande assignments:`, JSON.stringify(assignments));

  const assignedTowns = [];
  const newAssignments = {};

  // Een stad is "te vol om te farmen" als minstens één resource boven OVERFLOW_PCT (85%) zit
  // (boerderij ophalen heeft dan nauwelijks effect — opslag loopt snel vol)
  const isStorageFull = (t) => {
    const s = t.storage_volume || 1;
    return Math.max(
      (t.wood  || 0) / s,
      (t.stone || 0) / s,
      (t.iron  || 0) / s,
    ) >= OVERFLOW_PCT;
  };

  for (const [key, towns] of islandMap) {
    let primary;

    if (towns.length === 1) {
      if (!assignments[key]) newAssignments[key] = towns[0].id;
      primary = towns[0];
    } else {
      const assignedId = assignments[key];
      primary = assignedId ? towns.find(t => t.id === assignedId) : null;
      if (!primary) {
        primary = towns.reduce((a, b) => a.id < b.id ? a : b);
        newAssignments[key] = primary.id;
        console.log(`[farm-agent] Nieuw eiland ${key}: default → ${primary.name}`);
      }
    }

    // Fallback: als primaire stad vol is, probeer alternatief op hetzelfde eiland
    if (isStorageFull(primary)) {
      const alternatives = towns.filter(t => t.id !== primary.id && !isStorageFull(t));
      if (alternatives.length > 0) {
        const fallback = alternatives[0];
        console.log(`[farm-agent] Eiland ${key}: ${primary.name} vol → fallback naar ${fallback.name}`);
        assignedTowns.push(fallback);
      } else {
        console.log(`[farm-agent] Eiland ${key}: alle steden vol — ${primary.name} toch gebruiken`);
        assignedTowns.push(primary);
      }
    } else {
      if (towns.length > 1) {
        const s = primary.storage_volume || 1;
        const fillW = Math.round((primary.wood ||0)/s*100);
        const fillS = Math.round((primary.stone||0)/s*100);
        const fillI = Math.round((primary.iron ||0)/s*100);
        console.log(`[farm-agent] Eiland ${key}: gebruikt ${primary.name} — hout ${fillW}% steen ${fillS}% zilver ${fillI}%`);
      }
      assignedTowns.push(primary);
    }
  }

  // Rapporteer nieuwe assignments aan GAS zodat ze opgeslagen worden
  if (Object.keys(newAssignments).length > 0) {
    // event zodat GAS de assignments kan opslaan
    // (fire-and-forget via sendEvent — geen import nodig, ctx heeft gasCallbackUrl)
  }

  // ── 3. Welke steden hebben klare boerderijen? ──────────────────────────

  const now = Math.floor(Date.now() / 1000);
  const townsToFarm = [];
  const resourcesBefore = {}; // voor opbrengst-berekening

  for (const town of shuffle([...assignedTowns])) {
    resourcesBefore[town.id] = { wood: town.wood, stone: town.stone, iron: town.iron };

    const farmData = await session.gameGet(
      "farm_town_overviews",
      town.id,
      "get_farm_towns_for_town",
      {
        island_x:             town.island_x,
        island_y:             town.island_y,
        current_town_id:      town.id,
        booty_researched:     town.booty_researched ? "1" : "",
        diplomacy_researched: "",
        trade_office:         0,
        town_id:              town.id,
        nl_init:              false,
      }
    );

    const farmList   = farmData?.farm_town_list ?? [];
    const ownedFarms = farmList.filter(v => v.rel === 1);
    const readyFarms = ownedFarms.filter(v => !v.loot || v.loot < now);

    const cooldowns  = ownedFarms.filter(v => v.loot && v.loot > now).map(v => v.loot);
    const nextReady  = cooldowns.length ? Math.min(...cooldowns) : null;

    if (readyFarms.length > 0) {
      townsToFarm.push({ town, nextReady });
    } else {
      console.log(`[farm-agent] ${town.name}: geen klare boerderijen${nextReady ? ` (klaar om ${new Date(nextReady * 1000).toLocaleTimeString("nl-BE", {timeZone:"Europe/Brussels"})})` : ""}`);
    }

    await randomSleep(0.5, 1.5);
  }

  if (townsToFarm.length === 0) {
    console.log("[farm-agent] Geen steden met klare boerderijen");
    return { overflowTowns: [], summary: { towns_claimed: 0 } };
  }

  // ── 4. Eén batch-claim ─────────────────────────────────────────────────

  const townIds = townsToFarm.map(({ town }) => town.id);
  console.log(`[farm-agent] Claimen voor ${townIds.length} steden (profiel: ${profile})…`);

  const claimResult = await session.gamePost(
    "farm_town_overviews",
    session.activeTownId,
    "claim_loads_multiple",
    {
      towns:              townIds,
      time_option_booty:  timeOpts.booty,
      time_option_base:   timeOpts.base,
      claim_factor:       "normal",
      town_d:             session.activeTownId,
      nl_init:            true,
    }
  );

  // ── 5. Opbrengst berekenen + overflow detecteren ───────────────────────

  const rawUpdated   = claimResult?.towns ?? [];
  const updatedTowns = Array.isArray(rawUpdated)
    ? rawUpdated
    : Object.values(rawUpdated);
  const overflowTowns = [];
  let totalGained = { wood: 0, stone: 0, iron: 0 };

  for (const updated of updatedTowns) {
    const before = resourcesBefore[updated.id];
    if (!before) continue;

    const gained = {
      wood:  (updated.wood  ?? 0) - before.wood,
      stone: (updated.stone ?? 0) - before.stone,
      iron:  (updated.iron  ?? 0) - before.iron,
    };
    totalGained.wood  += Math.max(0, gained.wood);
    totalGained.stone += Math.max(0, gained.stone);
    totalGained.iron  += Math.max(0, gained.iron);

    // Overflow detectie per resource
    const storage = updated.storage_volume ?? 1;
    const pctW = Math.round((updated.wood  ?? 0) / storage * 100);
    const pctS = Math.round((updated.stone ?? 0) / storage * 100);
    const pctI = Math.round((updated.iron  ?? 0) / storage * 100);
    const maxFill = Math.max(pctW, pctS, pctI) / 100;
    if (maxFill >= OVERFLOW_PCT) {
      overflowTowns.push(updated);
      console.log(`[farm-agent] Overflow: ${updated.name} — hout ${pctW}% steen ${pctS}% zilver ${pctI}%`);
    }
  }

  const nextReadyAll = townsToFarm
    .map(t => t.nextReady)
    .filter(Boolean);
  const nextReadyTs = nextReadyAll.length ? Math.min(...nextReadyAll) : null;

  // Haal grottendata op
  const hidesData = await fetchHidesData(session);

  // Slanke overview met productie, bevolking en grot-data
  const updatedMap = new Map(updatedTowns.map(t => [t.id, t]));
  const overview = allTowns.map(t => {
    const u    = updatedMap.get(t.id) ?? t;
    const hide = hidesData[u.id] ?? hidesData[String(u.id)] ?? {};
    return {
      id:              u.id,
      name:            u.name,
      wood:            u.wood,
      stone:           u.stone,
      iron:            u.iron,
      storage_volume:  u.storage_volume,
      population:      u.population,
      free_population: u.free_population,
      production:      u.production,       // { wood, stone, iron } per uur
      cave_silver:     hide.iron_stored ?? null,
      cave_max:        hide.max_storage ?? null,
      island_x:        u.island_x,
      island_y:        u.island_y,
    };
  });

  console.log(`[farm-agent] ✓ ${townIds.length} steden geclaimd | overflow: ${overflowTowns.length}`);

  // Bouw islandTownMap (welke steden per eiland) voor dashboard-weergave
  const islandTownMap = {};
  for (const [key, towns] of islandMap) {
    if (towns.length > 1) {
      islandTownMap[key] = towns.map(t => ({
        id:    t.id,
        name:  t.name,
        booty: t.booty_researched ?? false,
      }));
    }
  }

  // Stuur assignments + islandTownMap als apart klein event
  if (Object.keys(newAssignments).length > 0 || Object.keys(islandTownMap).length > 0) {
    const { sendEvent } = await import("../lib/events.js");
    await sendEvent(ctx.gasCallbackUrl, ctx.runId, "island_assignments_update", {
      assignments: newAssignments,
      islandTownMap,
    });
  }

  return {
    overflowTowns,
    summary: {
      towns_claimed:   townIds.length,
      total_gained:    totalGained,
      overflow_towns:  overflowTowns.length,
      next_ready_ts:   nextReadyTs,
      overview,
    },
  };
}
