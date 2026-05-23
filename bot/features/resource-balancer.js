/**
 * features/resource-balancer.js — Resource Balancer
 *
 * CRITICAL FIX: trade_overview retourneert resources GENEST in t.res.{wood,stone,iron}
 * en storage als t.storage (NIET t.storage_volume en NIET flat t.wood).
 */

import { randomSleep, floorTo500, ceilTo500 } from "../lib/delay.js";

export async function runResourceBalancer(ctx) {
  const { session, config, urgentDonors = [], forcedReceiver = null } = ctx;
  const cfg = config.resourceBalancer ?? {};
  const overflowPct  = cfg.overflowThresholdPct ?? 0.90;
  const globalMinPct = cfg.globalMinPct         ?? 0.30;
  const priorityDefs = cfg.priorityTowns        ?? [];

  // ── Trade overview ─────────────────────────────────────────────────────

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

  // Debug cap + resource structuur (eerste run)
  const s0 = rawTowns[0];
  console.log(`[resource-balancer] Structuur check: cap=${s0?.cap} storage=${s0?.storage} res.wood=${s0?.res?.wood} wood=${s0?.wood}`);
  const townsWithCap = rawTowns.filter(t => num(t.cap) > 0).length;
  console.log(`[resource-balancer] Steden met cap>0: ${townsWithCap}/${rawTowns.length}`);

  // ── Helpers voor geneste resources ────────────────────────────────────
  // trade_overview: t.res.wood / t.storage
  // farm_town_overviews: t.wood / t.storage_volume
  const getRes = (t, res) => num(t.res?.[res] ?? t[res]);
  const getStorage = (t) => num(t.storage ?? t.storage_volume);

  // ── In-transit berekenen ───────────────────────────────────────────────

  const inTransit = new Map(rawTowns.map(t => [t.id, { wood: 0, stone: 0, iron: 0 }]));
  for (const mov of movements) {
    const dest = inTransit.get(mov.destination_town_id);
    if (dest) {
      dest.wood  += num(mov.resources?.wood  ?? mov.res?.wood);
      dest.stone += num(mov.resources?.stone ?? mov.res?.stone);
      dest.iron  += num(mov.resources?.iron  ?? mov.res?.iron);
    }
  }

  // ── State opbouwen ─────────────────────────────────────────────────────

  const state = new Map(rawTowns.map(t => {
    const tr = inTransit.get(t.id) ?? { wood: 0, stone: 0, iron: 0 };
    return [t.id, {
      ...t,
      eff_wood:  getRes(t, "wood")  + tr.wood,
      eff_stone: getRes(t, "stone") + tr.stone,
      eff_iron:  getRes(t, "iron")  + tr.iron,
      _storage:  getStorage(t),
      cap:       num(t.cap),
    }];
  }));

  // ── Transfer plan ──────────────────────────────────────────────────────

  const transferPlan = new Map();

  const planTransfer = (donorId, receiverId, res, amount) => {
    if (amount <= 0) return;
    const key = `${donorId}→${receiverId}`;
    if (!transferPlan.has(key)) {
      transferPlan.set(key, { donorId, receiverId, wood: 0, stone: 0, iron: 0 });
    }
    transferPlan.get(key)[res] += amount;
  };

  const donorAvailable = (town, res) => {
    const surplus = town[`eff_${res}`] - overflowPct * town._storage;
    return surplus > 0 ? floorTo500(surplus) : 0;
  };

  const urgentIds = new Set((urgentDonors ?? []).map(t => t.id));

  const getDonors = () => [...state.values()]
    .filter(t => t.cap > 0)
    .sort((a, b) => {
      const aU = urgentIds.has(a.id) ? 1 : 0;
      const bU = urgentIds.has(b.id) ? 1 : 0;
      if (aU !== bU) return bU - aU;
      return Math.max(a.eff_wood, a.eff_stone, a.eff_iron) / a._storage -
             Math.max(b.eff_wood, b.eff_stone, b.eff_iron) / b._storage > 0 ? -1 : 1;
    });

  const sendFromDonor = (forcedDonorId, receiverId, res, needed) => {
    let remaining = needed;
    for (const donor of getDonors()) {
      if (donor.id === receiverId) continue;
      if (forcedDonorId && donor.id !== forcedDonorId) continue;
      const avail = Math.min(donorAvailable(donor, res), num(donor.cap));
      const send  = Math.min(floorTo500(avail), remaining);
      if (send <= 0) continue;
      planTransfer(donor.id, receiverId, res, send);
      donor[`eff_${res}`] -= send;
      donor.cap            -= send;
      state.get(receiverId)[`eff_${res}`] += send;
      remaining -= send;
      if (remaining <= 0) break;
    }
  };

  // ── 3a. forcedReceiver ─────────────────────────────────────────────────

  if (forcedReceiver) {
    const { townId, need } = forcedReceiver;
    if (state.has(townId)) {
      for (const res of ["wood", "stone", "iron"]) {
        const needed = ceilTo500(need[res] ?? 0);
        if (needed > 0) sendFromDonor(null, townId, res, needed);
      }
    }
  }

  // ── 3b. Prioriteitssteden ──────────────────────────────────────────────

  for (const def of priorityDefs) {
    const receiver = state.get(def.id);
    if (!receiver) continue;
    for (const res of ["wood", "stone", "iron"]) {
      const targetPct = (def.minPct ?? {})[res];
      if (targetPct === null || targetPct === undefined) continue;
      const needed = ceilTo500(targetPct * receiver._storage - receiver[`eff_${res}`]);
      if (needed > 0) sendFromDonor(null, def.id, res, needed);
    }
  }

  // ── 3c. Nivelleren ─────────────────────────────────────────────────────

  const hasUrgent = urgentDonors && urgentDonors.length > 0;

  const sortedByRoom = [...state.values()].sort((a, b) => {
    const fillA = Math.max(a.eff_wood, a.eff_stone, a.eff_iron) / a._storage;
    const fillB = Math.max(b.eff_wood, b.eff_stone, b.eff_iron) / b._storage;
    return fillA - fillB;
  });

  for (const receiver of sortedByRoom) {
    for (const res of ["wood", "stone", "iron"]) {
      const fillPct = receiver[`eff_${res}`] / receiver._storage;
      let targetPct;
      if (hasUrgent) {
        if (fillPct >= overflowPct - 0.05) continue;
        targetPct = overflowPct - 0.05;
      } else {
        if (fillPct >= globalMinPct) continue;
        targetPct = globalMinPct;
      }
      const needed = ceilTo500((targetPct - fillPct) * receiver._storage);
      if (needed > 0) sendFromDonor(null, receiver.id, res, needed);
    }
  }

  // ── 4. Transfers uitvoeren ─────────────────────────────────────────────

  let transfersDone = 0;
  const executedTransfers = [];

  // ── Pre-uitvoering: gegroepeerde samenvatting per donor ───────────────
  const byDonor = new Map();
  for (const plan of transferPlan.values()) {
    if (plan.wood + plan.stone + plan.iron <= 0) continue;
    const dName = state.get(plan.donorId)?.name ?? String(plan.donorId);
    const rName = state.get(plan.receiverId)?.name ?? String(plan.receiverId);
    if (!byDonor.has(plan.donorId)) byDonor.set(plan.donorId, { name: dName, sends: [] });
    byDonor.get(plan.donorId).sends.push({ to: rName, toId: plan.receiverId, wood: plan.wood, stone: plan.stone, iron: plan.iron });
  }

  for (const [, donor] of byDonor) {
    const sendLines = donor.sends.map(s => {
      const res = [
        s.wood  > 0 ? `🪵 ${s.wood.toLocaleString("nl-BE")}`  : "",
        s.stone > 0 ? `🪨 ${s.stone.toLocaleString("nl-BE")}` : "",
        s.iron  > 0 ? `🪙 ${s.iron.toLocaleString("nl-BE")}`  : "",
      ].filter(Boolean).join(" ");
      return `→ ${s.to} (${res})`;
    }).join("  |  ");
    console.log(`[resource-balancer] ${donor.name} stuurt: ${sendLines}`);
  }
  if (!byDonor.size) console.log("[resource-balancer] Geen transfers nodig");

  // ── Uitvoering ────────────────────────────────────────────────────────
  for (const plan of transferPlan.values()) {
    const { donorId, receiverId, wood, stone, iron } = plan;
    if (wood + stone + iron <= 0) continue;

    const donorRaw = rawTowns.find(t => t.id === donorId);
    const availCap = num(donorRaw?.cap ?? state.get(donorId)?.cap);

    const planned = [
      { res: "wood",  amount: wood  },
      { res: "stone", amount: stone },
      { res: "iron",  amount: iron  },
    ].sort((a, b) => b.amount - a.amount);

    let remainingCap = availCap;
    const sends = { wood: 0, stone: 0, iron: 0 };
    for (const { res, amount } of planned) {
      const send = Math.min(amount, remainingCap);
      sends[res] = send;
      remainingCap -= send;
      if (remainingCap <= 0) break;
    }

    if (sends.wood + sends.stone + sends.iron <= 0) continue;

    const donorName    = state.get(donorId)?.name    ?? String(donorId);
    const receiverName = state.get(receiverId)?.name ?? String(receiverId);
    const isUrgent     = urgentIds.has(donorId);
    const isPriority   = priorityDefs.some(d => d.id === receiverId);
    const reason       = isPriority ? "prioriteitsstad" : isUrgent ? "overflow-relief" : "nivellering";

    try {
      const tradeRes = await session.gamePost(
        "town_overviews", donorId, "trade_between_own_town",
        { from: donorId, to: receiverId, wood: sends.wood, stone: sends.stone, iron: sends.iron, town_id: donorId }
      );
      if (!tradeRes?.success) {
        const errKey = tradeRes?.error?.key ?? tradeRes?.error ?? tradeRes?.message ?? JSON.stringify(tradeRes)?.slice(0, 100);
        console.warn(`[resource-balancer] ✗ ${donorName} → ${receiverName}: ${errKey}`);
      } else {
        transfersDone++;
        executedTransfers.push({
          from: donorName, fromId: donorId,
          to:   receiverName, toId: receiverId,
          wood: sends.wood, stone: sends.stone, iron: sends.iron,
          reason,
        });
      }
    } catch (err) {
      console.warn(`[resource-balancer] ✗ ${donorName} → ${receiverName}: ${err.message}`);
    }

    await randomSleep(2, 4);
  }

  // ── B9 alert ───────────────────────────────────────────────────────────

  if (transfersDone === 0 && urgentDonors && urgentDonors.length > 0) {
    for (const res of ["wood", "stone", "iron"]) {
      const resNL  = res === "wood" ? "hout" : res === "stone" ? "steen" : "zilver";
      const donors = [...state.values()].filter(t => t.cap > 0 && donorAvailable(t, res) > 0);
      const recvs  = [...state.values()].filter(t =>
        t[`eff_${res}`] / t._storage < (overflowPct - 0.05)
      );
      console.log(`[resource-balancer] ${resNL}: ${donors.length} donors, ${recvs.length} ontvangers`);
    }
    console.warn(`[resource-balancer] ⚠ ${urgentDonors.length} overflow maar 0 transfers`);
  }

  // ── townResources map voor culture ─────────────────────────────────────

  const townResources = new Map();
  for (const [id, town] of state) {
    townResources.set(id, { wood: town.eff_wood, stone: town.eff_stone, iron: town.eff_iron });
  }

  console.log(`[resource-balancer] ✓ ${transfersDone} transfers`);
  return {
    summary: {
      transfers:     transfersDone,
      transferList:  executedTransfers,
      all_full:      transfersDone === 0 && urgentDonors && urgentDonors.length > 0,
    },
    townResources,
  };
}

const num = (v) => (v !== null && v !== undefined ? Number(v) : 0);
/**
 * runCultureTopup — gerichte balancer-pass voor cultuurvieringen
 *
 * Vult specifieke ontvangers aan met exact de gevraagde hoeveelheid.
 * Cultuursteden krijgen absolute prioriteit boven normale nivellering.
 *
 * @param {object} ctx - Feature context (session, config)
 * @param {Array}  targets - [{townId, name, wood, stone, iron}] — benodigd tekort per stad
 * @returns {Map} updatedResources - bijgewerkte town resources na de topup
 */
export async function runCultureTopup(ctx, targets) {
  const { session, config } = ctx;
  if (!targets || !targets.length) return new Map();

  console.log(`[culture-topup] Aanvullen voor ${targets.length} vieringen: ${targets.map(t => t.name||t.townId).join(", ")}`);

  // Herlaad trade_overview voor frisse staat (vorige balancer heeft al gehandeld)
  const tradeData = await session.gameGet(
    "town_overviews", session.activeTownId, "trade_overview",
    { town_id: session.activeTownId, nl_init: true }
  );
  const rawTowns = tradeData?.towns
    ? (Array.isArray(tradeData.towns) ? tradeData.towns : Object.values(tradeData.towns))
    : [];

  if (!rawTowns.length) { console.warn("[culture-topup] Geen steden in trade_overview"); return new Map(); }

  const getRes     = (t, r) => t?.res?.[r] ?? t?.[r] ?? 0;
  const getStorage = (t)    => t?.storage ?? t?.storage_volume ?? 1;
  const num        = (v)    => (typeof v === "number" ? v : parseFloat(v) || 0);

  // Bouw state Map
  const state = new Map(rawTowns.map(t => [t.id, {
    id:       t.id,
    name:     t.name,
    wood:     getRes(t, "wood"),
    stone:    getRes(t, "stone"),
    iron:     getRes(t, "iron"),
    storage:  getStorage(t),
    cap:      num(t.cap),
  }]));

  // ── Prioriteitssteden: controleer onvervulde tekorten ─────────────────────
  // Als een prioriteitsstad na de hoofdbalancer nog tekort heeft (bv. door markt-level 5),
  // reserveren we dat tekort bij de potentiële donors — cultuur krijgt de rest.
  const priorityDefs  = config?.resourceBalancer?.priorityTowns ?? [];
  const globalMinPct  = config?.resourceBalancer?.globalMinPct  ?? 0.30;
  const RESOURCES     = ["wood", "stone", "iron"];

  // Bereken per donor hoeveel hij nog verschuldigd is aan prioriteitssteden
  const donorReserved = new Map(); // donorId → {wood, stone, iron}

  for (const def of priorityDefs) {
    const prioTown = state.get(def.id);
    if (!prioTown) continue;
    const minPct = def.minPct || {};

    for (const res of RESOURCES) {
      const target  = (minPct[res] ?? globalMinPct) * prioTown.storage;
      const deficit = Math.max(0, target - prioTown[res]);
      if (deficit <= 0) continue;

      // Vind de meest geschikte donor (meeste surplus, heeft cap) en reserveer
      const potentialDonors = [...state.values()]
        .filter(d => d.id !== def.id && d.cap > 0 && d[res] > d.storage * globalMinPct)
        .sort((a, b) => b[res] - a[res]);

      let remaining = deficit;
      for (const donor of potentialDonors) {
        if (remaining <= 0) break;
        const reserve = donorReserved.get(donor.id) || { wood: 0, stone: 0, iron: 0 };
        const canReserve = Math.min(remaining, donor[res] - donor.storage * globalMinPct - (reserve[res] || 0));
        if (canReserve > 0) {
          reserve[res] = (reserve[res] || 0) + canReserve;
          donorReserved.set(donor.id, reserve);
          remaining -= canReserve;
        }
      }

      if (remaining > 0) {
        console.log(`[culture-topup] Prioriteitsstad ${def.id} heeft nog ${Math.round(remaining)} ${res} tekort — wordt gereserveerd`);
      }
    }
  }

  if (donorReserved.size > 0) {
    console.log(`[culture-topup] Reserveringen voor prioriteitssteden bij ${donorReserved.size} donors`);
  }

  let transfersDone = 0;
  const transferList = []; // voor audit log + KPI card

  for (const target of targets) {
    const receiver = state.get(target.townId);
    if (!receiver) { console.warn(`[culture-topup] Stad ${target.townId} niet gevonden`); continue; }

    const needs = {
      wood:  Math.max(0, (target.wood  || 0)),
      stone: Math.max(0, (target.stone || 0)),
      iron:  Math.max(0, (target.iron  || 0)),
    };

    if (needs.wood + needs.stone + needs.iron === 0) continue;

    console.log(`[culture-topup] ${receiver.name} heeft nodig: 🪵${needs.wood} 🪨${needs.stone} 🪙${needs.iron}`);

    // Vind donors per resource: steden met surplus, gesorteerd op meeste surplus
    for (const res of RESOURCES) {
      let remaining = needs[res];
      if (remaining <= 0) continue;

      const donors = [...state.values()]
        .filter(d => d.id !== target.townId && d.cap > 0 && d[res] > d.storage * globalMinPct)
        .sort((a, b) => b[res] - a[res]);

      for (const donor of donors) {
        if (remaining <= 0) break;

        // Beschikbaar surplus = totaal surplus - reserveringen voor prioriteitssteden
        const reserved = (donorReserved.get(donor.id) || {})[res] || 0;
        const rawSurplus = donor[res] - donor.storage * globalMinPct - reserved;
        const surplus = Math.floor(rawSurplus / 500) * 500;
        if (surplus <= 0) continue;

        const send = Math.min(surplus, remaining, donor.cap);
        if (send < 500) continue;

        const payload = { wood: 0, stone: 0, iron: 0 };
        payload[res] = send;

        try {
          const tr = await session.gamePost(
            "town_overviews", session.activeTownId, "trade_between_own_town",
            { from: donor.id, to: target.townId, ...payload, town_id: donor.id,
              no_bar: 1, nl_init: true }
          );
          if (tr?.success) {
            const resIcon = res === "wood" ? "🪵" : res === "stone" ? "🪨" : "🪙";
            console.log(`[culture-topup] ✓ ${donor.name} → ${receiver.name} ${resIcon}${send.toLocaleString("nl-BE")}`);
            donor[res]  -= send;
            donor.cap   -= send;
            receiver[res] += send;
            remaining   -= send;
            transfersDone++;
            transferList.push({
              from: donor.name, fromId: donor.id,
              to:   receiver.name, toId: target.townId,
              wood:  res === "wood"  ? send : 0,
              stone: res === "stone" ? send : 0,
              iron:  res === "iron"  ? send : 0,
              reason: "cultuur topup",
            });
          } else {
            const err = tr?.error?.key ?? tr?.error ?? tr?.message ?? "onbekend";
            console.warn(`[culture-topup] ✗ ${donor.name} → ${receiver.name}: ${err}`);
          }
        } catch (e) {
          console.warn(`[culture-topup] ✗ ${e.message}`);
        }

        await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
      }
    }
  }

  console.log(`[culture-topup] ✓ ${transfersDone} transfers uitgevoerd`);

  // Retourneer bijgewerkte state + transferList (voor KPI/audit in dashboard)
  return { state, transferList };
}
