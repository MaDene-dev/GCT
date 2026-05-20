/**
 * features/buildings.js — Gebouwen monitoring
 *
 * Gebruikt building_main?action=index per stad (town_overviews?action=building_overview
 * retourneert een poll-response, geen bruikbare data).
 *
 * building_main geeft per stad: buildings object met current_level + level (na wachtrij).
 * level > current_level = in wachtrij.
 * Alle gebouwnamen zijn Engelse keys.
 */

import { randomSleep } from "../lib/delay.js";

export async function runBuildings(ctx) {
  const { session } = ctx;

  // Haal alle eigen steden op via farm_town_overviews (hebben we al als activeTownId)
  const townsData = await session.gameGet(
    "farm_town_overviews",
    session.activeTownId,
    "index",
    { town_id: session.activeTownId, nl_init: true }
  );

  const towns = townsData?.towns
    ? (Array.isArray(townsData.towns) ? townsData.towns : Object.values(townsData.towns))
    : [];

  if (towns.length === 0) {
    console.warn("[buildings] Geen steden gevonden");
    return { summary: { in_queue: 0 } };
  }

  const queued = [];

  for (const town of towns) {
    const data = await session.gameGet(
      "building_main",
      town.id,
      "index",
      { town_id: town.id, nl_init: true }
    );

    // building_main retourneert JSON met buildings object
    // Structuur: data.buildings = { academy: { level, current_level }, ... }
    // OF data.data.buildings = { ... }
    const buildings = data?.buildings ?? data?.data?.buildings ?? null;

    if (!buildings) {
      console.log(`[buildings] ${town.name}: geen building_data (keys: ${Object.keys(data ?? {}).join(", ")})`);
      await randomSleep(0.5, 1);
      continue;
    }

    for (const [building, info] of Object.entries(buildings)) {
      const currentLevel = info?.current_level ?? info?.level ?? 0;
      const targetLevel  = info?.level ?? 0;
      if (targetLevel > currentLevel) {
        queued.push({
          town_id:  town.id,
          name:     town.name,
          building,
          current:  currentLevel,
          target:   targetLevel,
        });
      }
    }

    await randomSleep(0.5, 1);
  }

  console.log(`[buildings] ${queued.length} gebouwen in wachtrij`);
  if (queued.length > 0) {
    console.log("[buildings] Wachtrij:", queued.map(q => `${q.name}:${q.building}(${q.current}→${q.target})`).join(", "));
  }

  return { summary: { in_queue: queued.length, queue: queued } };
}
