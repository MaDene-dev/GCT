/**
 * features/resource-balancer.js — Resource Balancer
 *
 * Volledige herwerking met globale pool-optimalisatie:
 *  - Alle behoeften en surplussen worden eerst globaal verzameld
 *  - Transfers worden gepland als gecombineerde calls per donor→ontvanger paar
 *  - Cap wordt als gedeelde pool behandeld over alle resources heen
 *  - Prioriteitssteden worden volledig gevuld vóór cultuur/nivellering
 *  - Reserveringen worden live bijgewerkt tijdens planning
 */

import { randomSleep, floorTo500, ceilTo500 } from "../lib/delay.js";

const RESOURCES = ["wood", "stone", "iron"];
const num = (v) => (v !== null && v !== undefined ? Number(v) : 0);

// ── Hulpfuncties ────────────────────────────────────────────────────────────

function getRes(t, res)  { return num(t.res?.[res] ?? t[res]); }
function getStorage(t)   { return num(t.storage ?? t.storage_volume) || 1; }

/**
 * Bouw een genormaliseerde state map vanuit rawTowns + movements.
 * Elke entry heeft: id, name, wood, stone, iron, storage, cap
 * eff_* = huidige voorraad + onderweg
 */
function buildState(rawTowns, movements, townNames) {
  // In-transit berekenen
  const inTransit = new Map(rawTowns.map(t => [t.id, { wood: 0, stone: 0, iron: 0 }]));
  for (const mov of movements) {
    const dest = inTransit.get(mov.destination_town_id);
    if (dest) {
      dest.wood  += num(mov.resources?.wood  ?? mov.res?.wood);
      dest.stone += num(mov.resources?.stone ?? mov.res?.stone);
      dest.iron  += num(mov.resources?.iron  ?? mov.res?.iron);
    }
  }

  const state = new Map();
  for (const t of rawTowns) {
    const tr = inTransit.get(t.id) ?? { wood: 0, stone: 0, iron: 0 };
    state.set(t.id, {
      id:        t.id,
      name:      t.name || townNames?.[t.id] || String(t.id),
      wood:      getRes(t, "wood"),
      stone:     getRes(t, "stone"),
      iron:      getRes(t, "iron"),
      eff_wood:  getRes(t, "wood")  + tr.wood,
      eff_stone: getRes(t, "stone") + tr.stone,
      eff_iron:  getRes(t, "iron")  + tr.iron,
      storage:   getStorage(t),
      cap:       num(t.cap),
    });
  }
  return state;
}

/**
 * Globale pool-planner.
 *
 * Gegeven een state map, een lijst van behoeften en een lijst van donors,
 * plant hij transfers zodat:
 *  - Behoeften zo volledig mogelijk worden gedekt
 *  - Cap als gedeelde pool per donor wordt behandeld
 *  - Transfers per donor→ontvanger paar worden gecombineerd
 *
 * @param {Map}    state       - genormaliseerde state
 * @param {Array}  needs       - [{townId, wood, stone, iron, priority}]
 * @param {number} donorMinPct - minimum vullingsgraad die donors moeten behouden
 * @returns {Map}  transferPlan - Map van "donorId→receiverId" → {donorId, receiverId, wood, stone, iron}
 */
function planTransfers(state, needs, donorMinPct) {
  const transferPlan = new Map();

  const addPlan = (donorId, receiverId, res, amount) => {
    if (amount <= 0) return;
    const key = `${donorId}→${receiverId}`;
    if (!transferPlan.has(key)) {
      transferPlan.set(key, { donorId, receiverId, wood: 0, stone: 0, iron: 0 });
    }
    transferPlan.get(key)[res] += amount;
  };

  // Sorteer behoeften: prioriteit eerst, dan grootste tekort
  const sortedNeeds = [...needs].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return (b.wood + b.stone + b.iron) - (a.wood + a.stone + a.iron);
  });

  for (const need of sortedNeeds) {
    const receiver = state.get(need.townId);
    if (!receiver) continue;

    for (const res of RESOURCES) {
      let remaining = need[res] ?? 0;
      if (remaining <= 0) continue;

      // Donors: gesorteerd op meeste surplus, moeten cap > 0 hebben
      const donors = [...state.values()]
        .filter(d => d.id !== need.townId && d.cap > 0)
        .sort((a, b) => {
          const surpA = a[`eff_${res}`] - donorMinPct * a.storage;
          const surpB = b[`eff_${res}`] - donorMinPct * b.storage;
          return surpB - surpA;
        });

      for (const donor of donors) {
        if (remaining <= 0) break;

        // Beschikbaar surplus voor deze resource
        const surplus  = donor[`eff_${res}`] - donorMinPct * donor.storage;
        const avail    = Math.min(floorTo500(surplus), donor.cap);
        if (avail < 500) continue;

        const send = Math.min(avail, remaining);
        if (send <= 0) continue;

        addPlan(donor.id, need.townId, res, send);

        // State live bijwerken
        donor[`eff_${res}`] -= send;
        donor.cap            -= send;
        receiver[`eff_${res}`] += send;
        remaining -= send;
      }

      if (remaining > 0) {
        console.log(`[balancer] ⚠ ${receiver.name}: ${remaining} ${res} tekort — onvoldoende donors`);
      }
    }
  }

  return transferPlan;
}

/**
 * Voer een transferplan uit via de API.
 * Combineert wood+stone+iron per donor→ontvanger paar in één call.
 */
async function executeTransferPlan(transferPlan, state, session, label) {
  let done = 0;
  const executed = [];

  for (const plan of transferPlan.values()) {
    const { donorId, receiverId, wood, stone, iron } = plan;
    if (wood + stone + iron <= 0) continue;

    const donorName    = state.get(donorId)?.name    ?? String(donorId);
    const receiverName = state.get(receiverId)?.name ?? String(receiverId);

    const resStr = [
      wood  > 0 ? `🪵${wood.toLocaleString("nl-BE")}`  : "",
      stone > 0 ? `🪨${stone.toLocaleString("nl-BE")}` : "",
      iron  > 0 ? `🪙${iron.toLocaleString("nl-BE")}`  : "",
    ].filter(Boolean).join(" ");

    try {
      const tr = await session.gamePost(
        "town_overviews", donorId, "trade_between_own_town",
        { from: donorId, to: receiverId, wood, stone, iron, town_id: donorId, no_bar: 1, nl_init: true }
      );

      if (tr?.success) {
        console.log(`[${label}] ✓ ${donorName} → ${receiverName}: ${resStr}`);
        done++;
        executed.push({ from: donorName, fromId: donorId, to: receiverName, toId: receiverId, wood, stone, iron });
      } else {
        const errKey = tr?.error?.key ?? tr?.error ?? tr?.message ?? JSON.stringify(tr)?.slice(0, 100);
        console.warn(`[${label}] ✗ ${donorName} → ${receiverName}: ${errKey}`);
      }
    } catch (err) {
      console.warn(`[${label}] ✗ ${donorName} → ${receiverName}: ${err.message}`);
    }

    await randomSleep(2, 4);
  }

  return { done, executed };
}

// ── Hoofdfunctie ────────────────────────────────────────────────────────────

export async function runResourceBalancer(ctx) {
  const { session, config, urgentDonors = [], forcedReceiver = null } = ctx;
  const cfg          = config.resourceBalancer ?? {};
  const overflowPct  = cfg.overflowThresholdPct ?? 0.90;
  const globalMinPct = cfg.globalMinPct         ?? 0.30;
  const priorityDefs = cfg.priorityTowns        ?? [];

  // ── Trade overview ophalen ──────────────────────────────────────────────
  const tradeData = await session.gameGet(
    "town_overviews",
    session.activeTownId,
    "trade_overview",
    { town_id: session.activeTownId, nl_init: true }
  );

  const rawTowns  = tradeData?.towns
    ? (Array.isArray(tradeData.towns) ? tradeData.towns : Object.values(tradeData.towns))
    : [];
  const movements = tradeData?.movements ?? [];

  if (rawTowns.length === 0) {
    console.warn("[resource-balancer] Geen steden in trade overview");
    return { summary: { transfers: 0 }, townResources: new Map() };
  }

  const s0 = rawTowns[0];
  console.log(`[resource-balancer] Structuur check: cap=${s0?.cap} storage=${s0?.storage} res.wood=${s0?.res?.wood}`);

  const state = buildState(rawTowns, movements, ctx.townNames);
  const urgentIds = new Set((urgentDonors ?? []).map(t => t.id));

  // ── Behoeften verzamelen ────────────────────────────────────────────────

  const needs = [];

  // 1. forcedReceiver
  if (forcedReceiver) {
    const { townId, need } = forcedReceiver;
    if (state.has(townId)) {
      needs.push({
        townId,
        wood:     ceilTo500(need.wood  ?? 0),
        stone:    ceilTo500(need.stone ?? 0),
        iron:     ceilTo500(need.iron  ?? 0),
        priority: 3,
      });
    }
  }

  // 2. Prioriteitssteden
  for (const def of priorityDefs) {
    const town = state.get(def.id);
    if (!town) continue;
    const minPct = def.minPct ?? {};
    const need = { townId: def.id, priority: 2, wood: 0, stone: 0, iron: 0 };
    for (const res of RESOURCES) {
      const target  = (minPct[res] ?? globalMinPct) * town.storage;
      const deficit = ceilTo500(target - town[`eff_${res}`]);
      if (deficit > 0) need[res] = deficit;
    }
    if (need.wood + need.stone + need.iron > 0) needs.push(need);
  }

  // 3. Nivellering
  const hasUrgent = urgentDonors && urgentDonors.length > 0;
  const targetPct = hasUrgent ? overflowPct - 0.05 : globalMinPct;

  for (const town of state.values()) {
    // Steden die zelf donor zijn (overflow) worden niet als ontvanger meegenomen
    if (urgentIds.has(town.id)) continue;

    const need = { townId: town.id, priority: 1, wood: 0, stone: 0, iron: 0 };
    for (const res of RESOURCES) {
      const fillPct = town[`eff_${res}`] / town.storage;
      if (fillPct < targetPct) {
        need[res] = ceilTo500((targetPct - fillPct) * town.storage);
      }
    }
    if (need.wood + need.stone + need.iron > 0) needs.push(need);
  }

  if (needs.length === 0) {
    console.log("[resource-balancer] Geen behoeften — alles voldoende gevuld");
    const townResources = new Map();
    for (const [id, t] of state) {
      townResources.set(id, { wood: t.eff_wood, stone: t.eff_stone, iron: t.eff_iron });
    }
    return { summary: { transfers: 0, transferList: [], all_full: hasUrgent }, townResources };
  }

  console.log(`[resource-balancer] ${needs.length} behoeften verzameld (prio3=${needs.filter(n=>n.priority===3).length} prio2=${needs.filter(n=>n.priority===2).length} prio1=${needs.filter(n=>n.priority===1).length})`);

  // ── Transferplan opstellen via globale pool ─────────────────────────────
  const transferPlan = planTransfers(state, needs, globalMinPct);

  // Samenvatting voor logs
  if (transferPlan.size > 0) {
    for (const plan of transferPlan.values()) {
      const dName = state.get(plan.donorId)?.name    ?? String(plan.donorId);
      const rName = state.get(plan.receiverId)?.name ?? String(plan.receiverId);
      const resStr = [
        plan.wood  > 0 ? `🪵${plan.wood.toLocaleString("nl-BE")}`  : "",
        plan.stone > 0 ? `🪨${plan.stone.toLocaleString("nl-BE")}` : "",
        plan.iron  > 0 ? `🪙${plan.iron.toLocaleString("nl-BE")}`  : "",
      ].filter(Boolean).join(" ");
      console.log(`[resource-balancer] Plan: ${dName} → ${rName}: ${resStr}`);
    }
  } else {
    console.log("[resource-balancer] Geen transfers nodig");
  }

  // ── Uitvoeren ───────────────────────────────────────────────────────────
  const { done, executed } = await executeTransferPlan(transferPlan, state, session, "resource-balancer");

  // ── B9 alert ────────────────────────────────────────────────────────────
  if (done === 0 && hasUrgent) {
    console.warn(`[resource-balancer] ⚠ ${urgentDonors.length} overflow maar 0 transfers`);
  }

  // ── townResources voor culture ──────────────────────────────────────────
  const townResources = new Map();
  for (const [id, t] of state) {
    townResources.set(id, { wood: t.eff_wood, stone: t.eff_stone, iron: t.eff_iron });
  }

  console.log(`[resource-balancer] ✓ ${done} transfers (${transferPlan.size} paren gepland)`);
  return {
    summary: {
      transfers:    done,
      transferList: executed,
      all_full:     done === 0 && hasUrgent,
    },
    townResources,
  };
}

// ── Culture Topup ────────────────────────────────────────────────────────────

// Module-level cooldown state (reset bij process-restart)
const _topupSentAt      = new Map();
const TOPUP_COOLDOWN_MS = 25 * 60 * 1000;

/**
 * runCultureTopup — aanvulling voor cultuurvieringen via pool-logica.
 *
 * Gebruikt dezelfde pool-planner als de hoofdbalancer.
 * Resources worden gecombineerd per donor→ontvanger paar.
 */
export async function runCultureTopup(ctx, targets) {
  const { session, config } = ctx;
  if (!targets || !targets.length) return { state: new Map(), transferList: [] };

  const globalMinPct = config?.resourceBalancer?.globalMinPct ?? 0.30;

  // Cooldown check
  const now      = Date.now();
  const filtered = targets.filter(t => {
    const lastSent = _topupSentAt.get(t.townId);
    if (lastSent && (now - lastSent) < TOPUP_COOLDOWN_MS) {
      console.log(`[culture-topup] ${t.name || t.townId}: cooldown actief (${Math.round((now - lastSent) / 60000)}min geleden)`);
      return false;
    }
    return true;
  });

  if (!filtered.length) {
    console.log("[culture-topup] Alles in cooldown — overgeslagen");
    return { state: new Map(), transferList: [] };
  }

  console.log(`[culture-topup] Aanvullen voor ${filtered.length} vieringen: ${filtered.map(t => t.name || t.townId).join(", ")}`);

  // Verse trade overview
  const tradeData = await session.gameGet(
    "town_overviews", session.activeTownId, "trade_overview",
    { town_id: session.activeTownId, nl_init: true }
  );
  const rawTowns  = tradeData?.towns
    ? (Array.isArray(tradeData.towns) ? tradeData.towns : Object.values(tradeData.towns))
    : [];
  const movements = tradeData?.movements ?? [];

  if (!rawTowns.length) {
    console.warn("[culture-topup] Geen steden in trade_overview");
    return { state: new Map(), transferList: [] };
  }

  const state = buildState(rawTowns, movements, ctx.townNames);

  // In-transit per bestemming voor deduplicatie
  const inTransit = new Map();
  for (const mov of movements) {
    const toLink = mov.to?.link ?? "";
    const match  = toLink.match(/href="#([A-Za-z0-9+/=]+)"/);
    if (!match) continue;
    try {
      const d      = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
      const destId = d.id;
      if (!inTransit.has(destId)) inTransit.set(destId, { wood: 0, stone: 0, iron: 0 });
      const tr = inTransit.get(destId);
      tr.wood  += mov.res?.wood  || 0;
      tr.stone += mov.res?.stone || 0;
      tr.iron  += mov.res?.iron  || 0;
    } catch {}
  }

  // Log onderweg zijnde grondstoffen
  for (const [tid, res] of inTransit) {
    const nm    = state.get(Number(tid))?.name || ctx.townNames?.[tid] || tid;
    const parts = [
      res.wood  ? `🪵${res.wood.toLocaleString("nl-BE")}`  : "",
      res.stone ? `🪨${res.stone.toLocaleString("nl-BE")}` : "",
      res.iron  ? `🪙${res.iron.toLocaleString("nl-BE")}`  : "",
    ].filter(Boolean);
    if (parts.length) console.log(`[culture-topup] Onderweg naar ${nm}: ${parts.join(" ")}`);
  }

  // Behoeften opstellen — trek onderweg af
  const needs = [];
  for (const target of filtered) {
    const transit = inTransit.get(target.townId) ?? { wood: 0, stone: 0, iron: 0 };
    const need    = {
      townId:   target.townId,
      priority: 1,
      wood:     ceilTo500(Math.max(0, (target.wood  || 0) - transit.wood)),
      stone:    ceilTo500(Math.max(0, (target.stone || 0) - transit.stone)),
      iron:     ceilTo500(Math.max(0, (target.iron  || 0) - transit.iron)),
    };
    if (need.wood + need.stone + need.iron === 0) {
      console.log(`[culture-topup] ${state.get(target.townId)?.name || target.townId}: voldoende onderweg`);
      continue;
    }
    const tName = state.get(target.townId)?.name || target.townId;
    console.log(`[culture-topup] ${tName} heeft nodig: 🪵${need.wood} 🪨${need.stone} 🪙${need.iron}`);
    needs.push(need);
  }

  if (!needs.length) {
    console.log("[culture-topup] Alle behoeften al onderweg");
    return { state, transferList: [] };
  }

  // Transferplan via pool-planner
  const transferPlan = planTransfers(state, needs, globalMinPct);

  // Uitvoeren
  const { done, executed } = await executeTransferPlan(transferPlan, state, session, "culture-topup");

  // Cooldown markeren
  for (const target of filtered) {
    if (executed.some(t => t.toId === target.townId)) {
      _topupSentAt.set(target.townId, Date.now());
    }
  }

  console.log(`[culture-topup] ✓ ${done} transfers (${transferPlan.size} paren gepland)`);
  return { state, transferList: executed };
}
