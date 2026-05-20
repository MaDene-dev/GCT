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
  const m = html.match(/var building_data\s*=\s*(\{[\s\S]+?\});\s*[\s\S]*?BuildingOverview/);

  if (!m) {
    console.warn("[buildings] building_data niet gevonden");
    return { summary: { in_queue: 0 } };
  }

  let buildingData;
  try {
    buildingData = JSON.parse(m[1]);
  } catch (e) {
    console.warn("[buildings] parse fout:", e.message);
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
