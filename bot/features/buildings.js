/**
 * features/buildings.js — Gebouwen (monitoring only)
 *
 * Leest bouwwachtrijen via building_main per stad.
 * building_main geeft current_level (nu gebouwd) én level (na wachtrij).
 * level > current_level = in wachtrij.
 * Alle gebouwnamen zijn Engelse keys.
 */

/**
 * @param {{ session, config }} ctx
 */
export async function runBuildings(ctx) {
  const { session } = ctx;

  // building_overview geeft HTML voor alle steden in één call
  const data = await session.gameGet(
    "town_overviews",
    session.activeTownId,
    "building_overview",
    { town_id: session.activeTownId, nl_init: true }
  );

  const html = data?.html ?? "";

  // Zoek var building_data = { ... } via brace-counter (robuuster dan regex voor geneste objecten)
  let buildingData = null;
  const varIdx = html.indexOf("var building_data = ");
  if (varIdx !== -1) {
    const startIdx = html.indexOf("{", varIdx);
    if (startIdx !== -1) {
      let depth = 0, endIdx = startIdx;
      for (let i = startIdx; i < html.length; i++) {
        if (html[i] === "{") depth++;
        else if (html[i] === "}") { depth--; if (depth === 0) { endIdx = i; break; } }
      }
      try {
        buildingData = JSON.parse(html.slice(startIdx, endIdx + 1));
      } catch (e) {
        console.warn("[buildings] parse fout:", e.message);
      }
    }
  }

  if (!buildingData) {
    console.warn("[buildings] building_data niet gevonden in HTML");
    return { summary: { in_queue: 0 } };
  }

  const queued = [];

  for (const [townId, buildings] of Object.entries(buildingData)) {
    for (const [building, info] of Object.entries(buildings)) {
      // level > current_level = in wachtrij
      const currentLevel = info?.current_level ?? 0;
      const targetLevel  = info?.level         ?? 0;
      if (targetLevel > currentLevel) {
        queued.push({
          town_id:  parseInt(townId, 10),
          building,
          current:  currentLevel,
          target:   targetLevel,
        });
      }
    }
  }

  console.log(`[buildings] ${queued.length} gebouwen in wachtrij`);
  return { summary: { in_queue: queued.length, queue: queued } };
}
