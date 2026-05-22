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
