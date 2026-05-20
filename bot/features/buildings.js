/**
 * features/buildings.js — Gebouwen monitoring
 *
 * building_main?action=index retourneert HTML via data._html (na session-fix).
 * De gebouwdata zit in: BuildingMain.buildings = { academy: {current_level, level}, ... }
 * Speciale gebouwen: $.extend(BuildingMain.special_buildings_combined_group, {theater: {...}}, ...)
 */

import { randomSleep } from "../lib/delay.js";

export async function runBuildings(ctx) {
  const { session } = ctx;

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

    // HTML is bewaard als _html door session._handleResponse
    const html = data?._html ?? "";

    if (!html) {
      await randomSleep(0.5, 1);
      continue;
    }

    // Reguliere gebouwen: BuildingMain.buildings = { academy: {current_level: 28, level: 30}, ... }
    const regular = parseBuildingMainObj_(html, "BuildingMain.buildings");

    // Speciale gebouwen: $.extend(BuildingMain.special_buildings_combined_group, {theater: {...}}, ...)
    const specials = parseSpecialBuildings_(html);

    const all = { ...regular, ...specials };

    for (const [building, info] of Object.entries(all)) {
      const currentLevel = info?.current_level ?? 0;
      const targetLevel  = info?.level ?? currentLevel;
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
    console.log("[buildings]", queued.map(q => `${q.name}:${q.building}(${q.current}→${q.target})`).join(", "));
  }

  return { summary: { in_queue: queued.length, queue: queued } };
}

/** Parse "BuildingMain.buildings = { ... }" uit HTML */
function parseBuildingMainObj_(html, varName) {
  const marker = `${varName} = `;
  const idx    = html.indexOf(marker);
  if (idx === -1) return {};
  const start = html.indexOf("{", idx);
  if (start === -1) return {};
  let depth = 0, end = start;
  for (let i = start; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  try { return JSON.parse(html.slice(start, end + 1)); }
  catch (e) { console.warn(`[buildings] Parse fout ${varName}:`, e.message); return {}; }
}

/** Parse speciale gebouwen uit $.extend(...) calls */
function parseSpecialBuildings_(html) {
  const result = {};
  const marker = "BuildingMain.special_buildings_combined_group,";
  let searchFrom = 0;
  while (true) {
    const idx = html.indexOf(marker, searchFrom);
    if (idx === -1) break;
    // Zoek het object-argument
    const objStart = html.indexOf("{", idx);
    if (objStart === -1) break;
    let depth = 0, objEnd = objStart;
    for (let i = objStart; i < html.length; i++) {
      if (html[i] === "{") depth++;
      else if (html[i] === "}") { depth--; if (depth === 0) { objEnd = i; break; } }
    }
    try {
      const obj = JSON.parse(html.slice(objStart, objEnd + 1));
      Object.assign(result, obj);
    } catch { /* skip */ }
    searchFrom = objEnd + 1;
  }
  return result;
}
