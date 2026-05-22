/**
 * features/culture.js — Cultuur
 *
 * Fixes in deze versie:
 *  B8: Gebruik townResources uit ctx (van RB) i.p.v. zware API-call
 *  B10: canStart_ regex — type_${type}[\\s"] ipv [^"]*
 */

import { randomSleep } from "../lib/delay.js";
import { runResourceBalancer } from "./resource-balancer.js";

const COSTS = {
  party:   { wood: 15_000, stone: 18_000, iron: 15_000 },
  theater: { wood: 10_000, stone: 12_000, iron: 10_000 },
  triumph: { wood: 0,      stone: 0,      iron: 0      },
};

const HOUR = 3_600;

export async function runCulture(ctx) {
  const { session, config, townResources } = ctx;
  const cultureCfg = config.culture?.towns ?? {};

  if (Object.keys(cultureCfg).length === 0) {
    console.log("[culture] Geen cultuur-config");
    return { summary: { started: 0, skipped: 0 } };
  }

  const buildingData = await fetchBuildingLevels_(session);

  let started = 0;
  let skipped = 0;

  for (const [townIdStr, types] of Object.entries(cultureCfg)) {
    const townId = parseInt(townIdStr, 10);

    const cultureData = await session.gameGet(
      "town_overviews", townId, "culture_overview",
      { town_id: townId, nl_init: true }
    );

    const html = cultureData?.html ?? "";

    let running = [];
    const m = html.match(/CultureOverview\.init\(\s*(\[[\s\S]*?\])/);
    if (m) { try { running = JSON.parse(m[1]); } catch { /* leeg */ } }

    const now = Math.floor(Date.now() / 1000);

    for (const type of types) {
      if (type === "games") continue;

      const active = running.find(c => c.celebration_type === type);
      if (active) {
        const left = active.finished_at - now;
        console.log(`[culture] ${townId} ${type}: loopt nog (${Math.round(left / 60)}min)`);
        if (left < HOUR && COSTS[type]?.wood > 0) {
          await runResourceBalancer({ ...ctx, forcedReceiver: { townId, need: COSTS[type] } });
        }
        continue;
      }

      const levels = buildingData[townId] ?? {};
      if (type === "party"   && (levels.academy  ?? 0) < 30) { skipped++; continue; }
      if (type === "theater" && (levels.theater   ?? 0) < 1)  { skipped++; continue; }

      // B10-fix: regex matcht type exact, geen prefix-vals
      if (!canStart_(html, type)) { skipped++; continue; }

      const cost = COSTS[type];
      if (cost.wood > 0 || cost.stone > 0 || cost.iron > 0) {
        // B8-fix: gebruik townResources van RB als beschikbaar, anders API-call
        const res = townResources?.get(townId)
          ?? await fetchTownResourcesFromOverview_(session, townId);

        const need = {
          wood:  Math.max(0, cost.wood  - (res.wood  ?? 0)),
          stone: Math.max(0, cost.stone - (res.stone ?? 0)),
          iron:  Math.max(0, cost.iron  - (res.iron  ?? 0)),
        };

        if (need.wood + need.stone + need.iron > 0) {
          console.log(`[culture] ${townId} ${type}: grondstoffen te kort — inline balancer pass`);
          const rbResult = await runResourceBalancer({
            ...ctx, forcedReceiver: { townId, need },
          });

          // Hercheck met bijgewerkte resources (uit RB result of opnieuw ophalen)
          const updated = rbResult?.townResources?.get(townId)
            ?? await fetchTownResourcesFromOverview_(session, townId);

          if ((updated.wood ?? 0) < cost.wood ||
              (updated.stone ?? 0) < cost.stone ||
              (updated.iron ?? 0) < cost.iron) {
            console.warn(`[culture] ${townId} ${type}: na balancer nog te weinig — overgeslagen`);
            skipped++;
            continue;
          }
        }
      }

      console.log(`[culture] ${townId} ${type}: starten…`);
      const result = await session.gamePost(
        "town_overviews", townId, "start_celebration",
        { town_id: townId },
        { celebration_type: type }
      );

      if (result?.success) {
        const finishAt = result.finished_at;
        console.log(`[culture] ✓ ${townId} ${type} gestart${finishAt ? ", eindigt "+new Date(finishAt*1000).toLocaleTimeString("nl-BE") : ""}`);
        started++;
      } else {
        const errKey = result?.error?.key ?? result?.error ?? "onbekend";
        console.warn(`[culture] ${townId} ${type}: start mislukt — ${errKey}`);
        skipped++;
      }

      await randomSleep(1, 3);
    }
  }

  return { summary: { started, skipped, towns_configured: Object.keys(cultureCfg).length } };
}

/**
 * Haal cultuurstatus op voor alle steden (voor dashboard-weergave).
 * Retourneert per stad: lopende vieringen + welke types beschikbaar/uitgeschakeld zijn.
 */
export async function fetchCultureOverview(session) {
  const data = await session.gameGet(
    "town_overviews",
    session.activeTownId,
    "culture_overview",
    { town_id: session.activeTownId, nl_init: true }
  );

  // Na _handleResponse: data.json.html → data.html
  const html = data?.html ?? "";
  if (!html) return {};

  // Parse lopende vieringen
  let running = [];
  const m = html.match(/CultureOverview\.init\(\s*(\[[\s\S]*?\])/);
  if (m) { try { running = JSON.parse(m[1]); } catch { /* leeg */ } }

  const now = Math.floor(Date.now() / 1000);
  const result = {};

  // Per stad: welke buttons zijn enabled vs disabled
  const TYPES = ["party", "theater", "triumph"];

  // Doorzoek HTML op stad-secties (elke stad heeft een eigen sectie met buttons)
  // Patroon: de buttons bevatten data-town_id of zijn gegroepeerd per stad
  // Simpelste aanpak: per type per stad button-klasse checken
  for (const type of TYPES) {
    // Zoek alle buttons van dit type
    const btnRegex = new RegExp(`class="confirm type_${type}([^"]*)"[^>]*data-(?:town[_-]id|town_id)="(\d+)"`, "g");
    let match;
    while ((match = btnRegex.exec(html)) !== null) {
      const classes = match[1];
      const townId  = parseInt(match[2], 10);
      if (!result[townId]) result[townId] = { running: [], available: [], disabled: [] };
      if (classes.includes("disabled")) {
        result[townId].disabled.push(type);
      } else {
        result[townId].available.push(type);
      }
    }
  }

  // Lopende vieringen toevoegen
  for (const v of running) {
    const tid = v.town_id;
    if (!result[tid]) result[tid] = { running: [], available: [], disabled: [] };
    result[tid].running.push({ type: v.celebration_type, finished_at: v.finished_at });
  }

  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchBuildingLevels_(session) {
  const data = await session.gameGet(
    "town_overviews", session.activeTownId, "building_overview",
    { town_id: session.activeTownId, nl_init: true }
  );
  const html = data?.html ?? "";
  const m = html.match(/var building_data\s*=\s*(\{[\s\S]+?\});\s*[\s\S]*?BuildingOverview/);
  if (!m) return {};
  try {
    const raw = JSON.parse(m[1]);
    const result = {};
    for (const [tid, buildings] of Object.entries(raw)) {
      result[parseInt(tid, 10)] = {};
      for (const [key, val] of Object.entries(buildings)) {
        result[parseInt(tid, 10)][key] = val?.current_level ?? 0;
      }
    }
    return result;
  } catch { return {}; }
}

/** Fallback: gebruik farm_town_overviews als townResources niet beschikbaar is */
async function fetchTownResourcesFromOverview_(session, townId) {
  const data = await session.gameGet(
    "farm_town_overviews", session.activeTownId, "index",
    { town_id: session.activeTownId, nl_init: true }
  );
  const town = (data?.towns ?? []).find(t => t.id === townId);
  return { wood: town?.wood ?? 0, stone: town?.stone ?? 0, iron: town?.iron ?? 0 };
}

/** Controleer of een vieringstype gestart kan worden via button-klasse in HTML */
function canStart_(html, type) {
  // Grepolis zet "disabled" als: viering loopt al, gebouwvereiste niet voldaan, of grondstoffen te kort
  // class="confirm type_party  " (extra spatie, geen disabled) = startbaar
  // class="confirm type_party disabled " = niet startbaar
  const hasButton  = new RegExp('class="confirm type_' + type + '\\s').test(html);
  const isDisabled = new RegExp('class="confirm type_' + type + '[^"]*disabled').test(html);
  return hasButton && !isDisabled;
}
