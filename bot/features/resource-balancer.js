/**
 * features/resource-balancer.js — Resource Balancer
 *
 * Pool-gebaseerde optimalisatie:
 *  - Netto surplus/tekort per stad per resource
 *  - Een stad is per resource óf donor óf ontvanger — nooit beide
 *  - Cap is gedeelde pool over alle uitgaande transfers van een donor
 *  - Ontvangers worden volledig gevuld voor de volgende aan de beurt komt (prioriteit)
 *  - Transfers gecombineerd per donor→ontvanger paar in één API call
 */

import { randomSleep, floorTo500, ceilTo500 } from "../lib/delay.js";

const RESOURCES = ["wood", "stone", "iron"];
const num = (v) => (v !== null && v !== undefined ? Number(v) : 0);

// ── Hulpfuncties ────────────────────────────────────────────────────────────

function getRes(t, res) { return num(t.res?.[res] ?? t[res]); }
function getStorage(t)  { return num(t.storage ?? t.storage_volume) || 1; }

/**
 * Bouw genormaliseerde state map vanuit rawTowns + movements.
 * eff_* = huidige voorraad + onderweg
 */
function buildState(rawTowns, movements, townNames) {
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
      eff_wood:  getRes(t, "wood")  + tr.wood,
      eff_stone: getRes(t, "stone") + tr.stone,
      eff_iron:  getRes(t, "iron")  + tr.iron,
      storage:   getStorage(t),
      cap:       num(t.cap),        // gedeelde pool voor alle uitgaande transfers
    });
  }
  return state;
}

/**
 * Globale pool-planner met correcte donor/ontvanger scheiding.
 *
 * Per resource:
 *   - Donor    = eff_res > donorMinPct * storage  → heeft surplus
 *   - Ontvanger = eff_res < targetPct * storage   → heeft tekort
 *   - Een stad kan per resource donor of ontvanger zijn, maar nooit beide
 *
 * Cap = gedeelde pool over alle resources van een donor.
 * Ontvangers worden op volgorde van prioriteit volledig gevuld.
 *
 * @param {Map}    state        - genormaliseerde state (wordt live bijgewerkt)
 * @param {Array}  needs        - [{townId, wood, stone, iron, priority}]
 * @param {number} donorMinPct  - minimum vullingsgraad donors moeten behouden
 * @returns {Map}  transferPlan
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

  // Sorteer behoeften: hoogste prioriteit eerst, dan grootste totaal tekort
  const sortedNeeds = [...needs].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return (b.wood + b.stone + b.iron) - (a.wood + a.stone + a.iron);
  });

  for (const need of sortedNeeds) {
    const receiver = state.get(need.townId);
    if (!receiver) continue;

    // Vul ontvanger volledig op voor alle resources voor we naar volgende gaan
    for (const res of RESOURCES) {
      let remaining = need[res] ?? 0;
      if (remaining <= 0) continue;

      // Opslaglimiet respecteren
      const roomInStorage = receiver.storage - receiver[`eff_${res}`];
      remaining = Math.min(remaining, roomInStorage);
      if (remaining <= 0) continue;

      // Donors voor deze resource: alleen steden met surplus
      // Een ontvanger voor deze resource mag NIET als donor fungeren
      const donors = [...state.values()]
        .filter(d =>
          d.id !== need.townId &&
          d.cap > 0 &&
          d[`eff_${res}`] > donorMinPct * d.storage  // heeft surplus
        )
        .sort((a, b) => {
          // Meeste surplus eerst
          const surpA = a[`eff_${res}`] - donorMinPct * a.storage;
          const surpB = b[`eff_${res}`] - donorMinPct * b.storage;
          return surpB - surpA;
        });

      for (const donor of donors) {
        if (remaining <= 0) break;

        const surplus = donor[`eff_${res}`] - donorMinPct * donor.storage;
        const avail   = Math.min(floorTo500(surplus), donor.cap);
        if (avail < 500) continue;

        const send = Math.min(avail, remaining);
        if (send <= 0) continue;

        addPlan(donor.id, need.townId, res, send);

        // State live bijwerken
        donor[`eff_${res}`] -= send;
        donor.cap            -= send;  // cap is gedeeld over alle resources
        receiver[`eff_${res}`] = Math.min(
          receiver[`eff_${res}`] + send,
          receiver.storage
        );
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
 * Voer transferplan uit — gecombineerde API call per donor→ontvanger paar.
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
        { from: donorId, to: receiverId, wood, stone, iron,
          town_id: donorId, no_bar: 1, nl_init: true }
      );

      if (tr?.success) {
        console.log(`[${label}] ✓ ${donorName} → ${receiverName}: ${resStr}`);
        done++;
        executed.push({
          from: donorName, fromId: donorId,
          to:   receiverName, toId: receiverId,
          wood, stone, iron,
        });
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

  // ── Trade overview ──────────────────────────────────────────────────────
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

  // Debug: log eerste movement object om tijdsvelden te ontdekken
  if (movements.length > 0) {
    console.log("[resource-balancer] Movement structuur:", JSON.stringify(movements[0]));
  }

  if (rawTowns.length === 0) {
    console.warn("[resource-balancer] Geen steden in trade overview");
    return { summary: { transfers: 0 }, townResources: new Map() };
  }

  const s0 = rawTowns[0];
  console.log(`[resource-balancer] Structuur check: cap=${s0?.cap} storage=${s0?.storage} res.wood=${s0?.res?.wood}`);

  const state     = buildState(rawTowns, movements, ctx.townNames);
  const urgentIds = new Set((urgentDonors ?? []).map(t => t.id));

  // ── Behoeften verzamelen ────────────────────────────────────────────────
  const needs = [];

  // 1. forcedReceiver (hoogste prio)
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
    const need   = { townId: def.id, priority: 2, wood: 0, stone: 0, iron: 0 };
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

  console.log(`[resource-balancer] ${needs.length} behoeften (prio3=${needs.filter(n=>n.priority===3).length} prio2=${needs.filter(n=>n.priority===2).length} prio1=${needs.filter(n=>n.priority===1).length})`);

  // ── Transferplan ────────────────────────────────────────────────────────
  const transferPlan = planTransfers(state, needs, globalMinPct);

  // Samenvatting
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

const _topupSentAt      = new Map();
const TOPUP_COOLDOWN_MS = 25 * 60 * 1000;

export async function runCultureTopup(ctx, targets) {
  const { session, config } = ctx;
  if (!targets || !targets.length) return { state: new Map(), transferList: [] };

  const globalMinPct = config?.resourceBalancer?.globalMinPct ?? 0.30;

  // Cooldown check
  const now      = Date.now();
  const filtered = targets.filter(t => {
    const lastSent = _topupSentAt.get(t.townId);
    if (lastSent && (now - lastSent) < TOPUP_COOLDOWN_MS) {
      console.log(`[culture-topup] ${t.name || t.townId}: cooldown (${Math.round((now - lastSent) / 60000)}min geleden)`);
      return false;
    }
    return true;
  });

  if (!filtered.length) {
    console.log("[culture-topup] Alles in cooldown");
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

  // Log onderweg
  for (const [tid, res] of inTransit) {
    const nm    = state.get(Number(tid))?.name || ctx.townNames?.[tid] || tid;
    const parts = [
      res.wood  ? `🪵${res.wood.toLocaleString("nl-BE")}`  : "",
      res.stone ? `🪨${res.stone.toLocaleString("nl-BE")}` : "",
      res.iron  ? `🪙${res.iron.toLocaleString("nl-BE")}`  : "",
    ].filter(Boolean);
    if (parts.length) console.log(`[culture-topup] Onderweg naar ${nm}: ${parts.join(" ")}`);
  }

  // Behoeften — trek onderweg af en respecteer opslaglimiet
  const needs = [];
  for (const target of filtered) {
    const transit  = inTransit.get(target.townId) ?? { wood: 0, stone: 0, iron: 0 };
    const town     = state.get(target.townId);
    const need     = {
      townId:   target.townId,
      priority: 1,
      wood:     ceilTo500(Math.max(0, (target.wood  || 0) - transit.wood)),
      stone:    ceilTo500(Math.max(0, (target.stone || 0) - transit.stone)),
      iron:     ceilTo500(Math.max(0, (target.iron  || 0) - transit.iron)),
    };

    // Nooit meer plannen dan er ruimte is in opslag
    if (town) {
      for (const res of RESOURCES) {
        const room = Math.max(0, town.storage - town[`eff_${res}`]);
        need[res]  = Math.min(need[res], room);
      }
    }

    if (need.wood + need.stone + need.iron === 0) {
      console.log(`[culture-topup] ${town?.name || target.townId}: voldoende onderweg`);
      continue;
    }

    const tName = town?.name || target.townId;
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
      
