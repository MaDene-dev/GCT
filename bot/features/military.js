/**
 * features/military.js — Militair (monitoring only)
 *
 * Troepen per dorp: thuis (count), onderweg (total - count), in productie (orders).
 * outer_units is niet nodig: total - count geeft onderweg.
 * Waarschuwing als een dorp 0 defensieve eenheden thuis heeft.
 */

const DEFENSIVE_UNITS = new Set([
  "hoplite", "archer", "sword", "chariot", "bireme",
  // Waarschijnlijk ook aanwezig:
  "slinger", "horseman",
]);

/**
 * @param {{ session, config }} ctx
 */
export async function runMilitary(ctx) {
  const { session } = ctx;

  const data = await session.gameGet(
    "town_overviews",
    session.activeTownId,
    "recruit_overview",
    { town_id: session.activeTownId, nl_init: true }
  );

  const towns     = data?.data?.towns ?? data?.towns ?? [];
  const undefended = [];
  const overview   = [];

  for (const town of towns) {
    const units = town.units ?? [];
    const unitMap = {};

    for (const u of units) {
      unitMap[u.id] = {
        home:       u.count ?? 0,
        away:       Math.max(0, (u.total ?? 0) - (u.count ?? 0)),
        production: 0,  // zie orders hieronder
      };
    }

    // In productie uit orders
    const orders = [
      ...(town.orders?.barracks ?? []),
      ...(town.orders?.docks    ?? []),
    ];
    for (const order of orders) {
      if (!unitMap[order.unit_type]) {
        unitMap[order.unit_type] = { home: 0, away: 0, production: 0 };
      }
      unitMap[order.unit_type].production += order.amount ?? 0;
    }

    // Defensief thuis
    const defensiveHome = Object.entries(unitMap)
      .filter(([id]) => DEFENSIVE_UNITS.has(id))
      .reduce((sum, [, v]) => sum + v.home, 0);

    if (defensiveHome === 0) {
      undefended.push({ town_id: town.id, name: town.name });
      console.warn(`[military] ⚠ Onverdedigd: ${town.name}`);
    }

    overview.push({ town_id: town.id, name: town.name, units: unitMap });
  }

  console.log(`[military] ${towns.length} dorpen gecheckt, ${undefended.length} onverdedigd`);
  return { summary: { towns: towns.length, undefended, overview } };
}
