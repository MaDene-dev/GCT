/**
 * features/hides.js — Grot-data ophalen (zilver opgeslagen)
 *
 * Endpoint: town_overviews?action=hides_overview
 * Response: plain HTML via data._html (via session._handleResponse)
 *
 * Veldnaam: iron_stored (ondanks dat het zilver is!)
 * max_storage: 0 = geen grot, -1 = onbeperkt
 *
 * Parse via: sendMessage('initializeResourcesCounter', ...) in HTML
 * Het tweede JSON-argument bevat de grottendata per stad.
 */

export async function fetchHidesData(session) {
  const data = await session.gameGet(
    "town_overviews",
    session.activeTownId,
    "hides_overview",
    { town_id: session.activeTownId, nl_init: true }
  );

  // hides_overview geeft plain HTML terug (niet json.html maar plain.html)
  // Na session-fix: data._html of data.html
  const html = data?._html ?? data?.html ?? "";

  if (!html) {
    console.warn("[hides] Geen HTML ontvangen");
    return {};
  }

  // Parse sendMessage('initializeResourcesCounter', arg1, arg2)
  // Het tweede argument is het JSON-object met grottendata per stad
  const marker = "initializeResourcesCounter";
  const idx    = html.indexOf(marker);
  if (idx === -1) {
    console.warn("[hides] initializeResourcesCounter niet gevonden");
    return {};
  }

  // Zoek het tweede JSON-argument (het eerste is gewoon een string/null)
  const argsStart = html.indexOf("(", idx);
  if (argsStart === -1) return {};

  // Sla het eerste argument over, zoek het tweede {
  let depth = 0, objStart = -1;
  for (let i = argsStart + 1; i < html.length; i++) {
    if (html[i] === "{") {
      if (objStart === -1) {
        // Is dit het eerste of tweede argument?
        const before = html.slice(argsStart + 1, i).trim();
        if (before.includes(",")) {
          objStart = i; depth = 1;
        }
        // else: eerste argument, overslaan
      } else {
        depth++;
      }
    } else if (html[i] === "}" && objStart !== -1) {
      depth--;
      if (depth === 0) {
        try {
          const raw = JSON.parse(html.slice(objStart, i + 1));
          // raw = { "329": { iron_stored: 14500, max_storage: 60000 }, ... }
          return raw;
        } catch (e) {
          console.warn("[hides] Parse fout:", e.message);
          return {};
        }
      }
    }
  }

  return {};
}
