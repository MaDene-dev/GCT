/**
 * features/buildings.js — Gebouwen monitoring
 *
 * building_main?action=index HTML bevat:
 *   BuildingMain.buildings = { academy: {current_level:28, level:30, next_level:31}, ... }
 *   $.extend(BuildingMain.special_buildings_combined_group, {theater:{...}}, {thermal:{...}})
 *
 * level > current_level = in wachtrij
 * current_level kan ontbreken als er geen wachtrij is → fallback naar level
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

    // Probeer alle bekende paden voor HTML:
    // 1. data.html = data.json.html (na _handleResponse unwrap) — primair
    // 2. data._outer_html = originele data.html (als json leeg was)
    // 3. data._plain_html = data.plain.html
    const html = data?.html ?? data?._outer_html ?? data?._plain_html ?? "";

    if (!html) {
      const keys = Object.keys(data ?? {}).join(", ");
      console.warn(`[buildings] Geen HTML voor ${town.name}. Keys: ${keys}`);
      // Toon waarden van eerste paar keys voor debug
      for (const [k, v] of Object.entries(data ?? {}).slice(0, 4)) {
        const preview = typeof v === "string" ? v.slice(0, 80) : JSON.stringify(v)?.slice(0, 80);
        console.log(`[buildings]   ${k}: ${preview}`);
      }
      await randomSleep(0.5, 1);
      continue;
    }
    if (town === towns[0]) {
      console.log(`[buildings] HTML pad gevonden voor ${town.name} (${html.length}b)`);
      const hasBuilding = html.includes("BuildingMain.buildings");
      console.log(`[buildings]   BuildingMain.buildings aanwezig: ${hasBuilding}`);
      if (!hasBuilding) {
        console.log(`[buildings]   HTML snippet: ${html.slice(0, 200).replace(/\s+/g, " ")}`);
      }
    }

    // Reguliere gebouwen
    const regular  = parseBuildingMainObj_(html, "BuildingMain.buildings");
    // Speciale gebouwen (theater, thermal, library, ...)
    const specials = parseSpecialBuildings_(html);
    const all      = { ...regular, ...specials };

    if (town === towns[0] && !Object.keys(all).length) {
      // Debug: toon eerste 400 chars HTML als parsing mislukt
      console.warn(`[buildings] Parse mislukt voor ${town.name}. HTML(400): ${html.slice(0, 400).replace(/\s+/g, " ")}`);
    }

    for (const [building, info] of Object.entries(all)) {
      // current_level kan ontbreken zonder wachtrij → fallback naar level
      const currentLevel = info?.current_level ?? info?.level ?? 0;
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

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Parse "BuildingMain.buildings = { ... }" uit HTML.
 * Zoekt op variabelenaam → eerste = → eerste { → balanced braces.
 */
function parseBuildingMainObj_(html, varName) {
  const nameIdx = html.indexOf(varName);
  if (nameIdx === -1) return {};
  // Zoek '=' na de variabelenaam
  const eqIdx = html.indexOf("=", nameIdx + varName.length);
  if (eqIdx === -1) return {};
  // Zoek het eerste '{' na '='
  const startIdx = html.indexOf("{", eqIdx);
  if (startIdx === -1) return {};

  let depth = 0, endIdx = startIdx;
  for (let i = startIdx; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) { endIdx = i; break; } }
  }

  try {
    return JSON.parse(html.slice(startIdx, endIdx + 1));
  } catch (e) {
    console.warn(`[buildings] Parse fout ${varName}:`, e.message);
    return {};
  }
}

/**
 * Parse speciale gebouwen uit $.extend(BuildingMain.special_buildings_combined_group, {...}, {...})
 * Meerdere aparte JSON-objecten als argumenten.
 */
function parseSpecialBuildings_(html) {
  const result = {};
  const marker  = "BuildingMain.special_buildings_combined_group";
  let searchFrom = 0;

  while (true) {
    const markerIdx = html.indexOf(marker, searchFrom);
    if (markerIdx === -1) break;

    // Zoek de omsluitende $.extend( ... ) call
    const parenOpen  = html.lastIndexOf("(", markerIdx);
    const parenClose = html.indexOf(")", markerIdx);
    if (parenOpen === -1 || parenClose === -1) { searchFrom = markerIdx + 1; break; }

    // Doorzoek het gedeelte tussen ( en ) op JSON-objecten
    let i = parenOpen;
    while (i < parenClose) {
      const objStart = html.indexOf("{", i);
      if (objStart === -1 || objStart > parenClose) break;

      let depth = 0, objEnd = objStart;
      for (let j = objStart; j <= parenClose; j++) {
        if (html[j] === "{") depth++;
        else if (html[j] === "}") { depth--; if (depth === 0) { objEnd = j; break; } }
      }

      try {
        const obj = JSON.parse(html.slice(objStart, objEnd + 1));
        Object.assign(result, obj);
      } catch { /* ongeldige JSON-block overslaan */ }

      i = objEnd + 1;
    }

    searchFrom = markerIdx + marker.length;
  }

  return result;
}
