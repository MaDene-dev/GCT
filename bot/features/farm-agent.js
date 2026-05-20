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
  const islandMap   = new Map(); // "x_y" → [town, ...]

  for (const town of allTowns) {
    const key = `${town.island_x}_${town.island_y}`;
    if (!islandMap.has(key)) islandMap.set(key, []);
    islandMap.get(key).push(town);
  }

  const assignedTowns = []; // de steden die daadwerkelijk farmen
  const newAssignments = {}; // te rapporteren aan GAS voor auto-opslaan

  for (const [key, towns] of islandMap) {
    if (towns.length === 1) {
      assignedTowns.push(towns[0]);
    } else {
      // Meerdere steden op dit eiland
      const assignedId = assignments[key];
      const assigned = assignedId
        ? towns.find(t => t.id === assignedId)
        : null;

      if (assigned) {
        assignedTowns.push(assigned);
      } else {
        // Geen assignment → laagste ID als default
        const defaultTown = towns.reduce((a, b) => a.id < b.id ? a : b);
        assignedTowns.push(defaultTown);
        newAssignments[key] = defaultTown.id;
        console.log(`[farm-agent] Nieuw eiland ${key}: default → ${defaultTown.name} (id:${defaultTown.id})`);
      }
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
      console.log(`[farm-agent] ${town.name}: geen klare boerderijen${nextReady ? ` (klaar om ${new Date(nextReady * 1000).toLocaleTimeString("nl-BE")})` : ""}`);
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

    // Overflow detectie (per resource)
    const storage = updated.storage_volume ?? 1;
    const maxFill = Math.max(
      (updated.wood  ?? 0) / storage,
      (updated.stone ?? 0) / storage,
      (updated.iron  ?? 0) / storage,
    );
    if (maxFill >= OVERFLOW_PCT) {
      overflowTowns.push(updated);
      console.log(`[farm-agent] Overflow: ${updated.name} (${Math.round(maxFill * 100)}% vol)`);
    }
  }

  const nextReadyAll = townsToFarm
    .map(t => t.nextReady)
    .filter(Boolean);
  const nextReadyTs = nextReadyAll.length ? Math.min(...nextReadyAll) : null;

  // Slanke overview — alleen velden die dashboard nodig heeft
  const updatedMap = new Map(updatedTowns.map(t => [t.id, t]));
  const overview = allTowns.map(t => {
    const u = updatedMap.get(t.id) ?? t;
    return {
      id:             u.id,
      name:           u.name,
      wood:           u.wood,
      stone:          u.stone,
      iron:           u.iron,
      storage_volume: u.storage_volume,
      population:     u.population,
      free_population: u.free_population,
      island_x:       u.island_x,
      island_y:       u.island_y,
    };
  });

  console.log(`[farm-agent] ✓ ${townIds.length} steden geclaimd | overflow: ${overflowTowns.length}`);

  // Stuur new_assignments als apart klein event zodat ze altijd aankomen
  if (Object.keys(newAssignments).length > 0) {
    const { sendEvent } = await import("../lib/events.js");
    await sendEvent(ctx.gasCallbackUrl, ctx.runId, "island_assignments_update", newAssignments);
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
