/**
 * features/military.js — Militair monitoring
 *
 * recruit_overview response pad: data.data.towns (na _handleResponse unwrap van .json)
 * unit.id = string identifier, unit.count = thuis, unit.total = thuis+onderweg
 */

const DEFENSIVE_UNITS = new Set([
  "hoplite", "archer", "sword", "chariot", "bireme", "slinger",
]);

export async function runMilitary(ctx) {
  const { session } = ctx;

  const data = await session.gameGet(
    "town_overviews",
    session.activeTownId,
    "recruit_overview",
    { town_id: session.activeTownId, nl_init: true }
  );

  // Response pad: data.data.towns (json.data.towns na _handleResponse)
  const towns = data?.data?.towns ?? data?.towns ?? [];
  const undefended = [];
  const overview   = [];

  let _unitDebugLogged    = false;
  let _orderDebugLogged   = false;

  for (const town of towns) {
    const units    = town.units ?? [];
    const unitMap  = {};

    for (const u of units) {
      // Debug: log velden van eerste unit om tijdsvelden te ontdekken
      if (!_unitDebugLogged) {
        console.log(`[military] Unit velden:`, JSON.stringify(u));
        _unitDebugLogged = true;
      }
      unitMap[u.id] = {
        home:       u.count ?? 0,
        away:       Math.max(0, (u.total ?? 0) - (u.count ?? 0)),
        production: 0,
      };
    }

    // Productie uit orders
    for (const order of [...(town.orders?.barracks ?? []), ...(town.orders?.docks ?? [])]) {
      // Debug: log velden van eerste order om tijdsvelden te ontdekken
      if (!_orderDebugLogged) {
        console.log(`[military] Order velden:`, JSON.stringify(order));
        _orderDebugLogged = true;
      }
      if (!unitMap[order.unit_type]) {
        unitMap[order.unit_type] = { home: 0, away: 0, production: 0 };
      }
      unitMap[order.unit_type].production += order.amount ?? 0;
    }

    // Defensieve eenheden thuis
    const defensiveHome = Object.entries(unitMap)
      .filter(([id]) => DEFENSIVE_UNITS.has(id))
      .reduce((sum, [, v]) => sum + v.home, 0);

    if (defensiveHome === 0) {
      undefended.push({ town_id: town.id, name: town.name });
      console.warn(`[military] ⚠ Onverdedigd: ${town.name}`);
    }

    overview.push({
      id:    town.id,
      name:  town.name,
      units: unitMap,
      free_population: town.free_population ?? 0,
    });
  }

  console.log(`[military] ${towns.length} dorpen gecheckt, ${undefended.length} onverdedigd`);
  return { summary: { towns: towns.length, undefended, overview } };
}

