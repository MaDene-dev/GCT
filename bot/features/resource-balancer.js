/**
 * features/resource-balancer.js — Resource Balancer
 *
 * Fixes in deze versie:
 *  L5: Hybride nivelleerdoel — stad met markt is ontvanger als fill% < globalMinPct
 *  L6: Cap-prioriteit — sorteer op hoogste planned-bedrag (meest kritisch) eerst
 *  B8: Retourneert townResources map voor culture
 */

import { randomSleep, floorTo500, ceilTo500 } from "../lib/delay.js";

/**
 * @param {{ session, config, urgentDonors?, forcedReceiver?, townResources? }} ctx
 * @returns {{ summary, townResources: Map<number,{wood,stone,iron}> }}
 */
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

  const rawTowns  = tradeData?.towns     ?? [];
  const movements = tradeData?.movements ?? [];

  if (rawTowns.length === 0) {
    console.warn("[resource-balancer] Geen steden in trade overview");
    return { summary: { transfers: 0 }, townResources: new Map() };
  }

  // ── Effectieve resources (huidig + onderweg) ───────────────────────────

  const inTransit = new Map(rawTowns.map(t => [t.id, { wood: 0, stone: 0, iron: 0 }]));
  for (const mov of movements) {
    const dest = inTransit.get(mov.destination_town_id);
    if (dest) {
      dest.wood  += mov.resources?.wood  ?? 0;
      dest.stone += mov.resources?.stone ?? 0;
      dest.iron  += mov.resources?.iron  ?? 0;
    }
  }

  // Mutable state — bijgehouden na elke geplande transfer
  const state = new Map(rawTowns.map(t => {
    const tr = inTransit.get(t.id) ?? { wood: 0, stone: 0, iron: 0 };
    return [t.id, {
      ...t,
      eff_wood:  num(t.wood)  + tr.wood,
      eff_stone: num(t.stone) + tr.stone,
      eff_iron:  num(t.iron)  + tr.iron,
      cap:       num(t.cap),
    }];
  }));

  // ── Transfer plan: { "donorId→receiverId": {donorId,receiverId,wood,stone,iron} } ──

  const transferPlan = new Map();

  const planTransfer = (donorId, receiverId, res, amount) => {
    if (amount <= 0) return;
    const key = `${donorId}→${receiverId}`;
    if (!transferPlan.has(key)) {
      transferPlan.set(key, { donorId, receiverId, wood: 0, stone: 0, iron: 0 });
    }
    transferPlan.get(key)[res] += amount;
  };

  // Hoeveel kan een donor missen (veelvoud 500, max 500 onder overflowdrempel)
  const donorAvailable = (town, res) => {
    const surplus = town[`eff_${res}`] - overflowPct * num(town.storage_volume);
    return surplus > 0 ? floorTo500(surplus) : 0;
  };

  // Hoeveel heeft een ontvanger nodig (veelvoud 500, max 500 boven doeldrempel)
  const receiverNeed = (town, res, targetPct) => {
    const need = targetPct * num(town.storage_volume) - town[`eff_${res}`];
    return need > 0 ? ceilTo500(need) : 0;
  };

  const urgentIds = new Set((urgentDonors ?? []).map(t => t.id));

  const getDonors = () => [...state.values()]
    .filter(t => t.cap > 0)
    .sort((a, b) => {
      // Urgente donors (overflow na farming) bovenaan
      const aU = urgentIds.has(a.id) ? 1 : 0;
      const bU = urgentIds.has(b.id) ? 1 : 0;
      if (aU !== bU) return bU - aU;
      // Dan op meeste surplus
      const aSurp = Math.max(
        a.eff_wood  / num(a.storage_volume),
        a.eff_stone / num(a.storage_volume),
        a.eff_iron  / num(a.storage_volume),
      );
      const bSurp = Math.max(
        b.eff_wood  / num(b.storage_volume),
        b.eff_stone / num(b.storage_volume),
        b.eff_iron  / num(b.storage_volume),
      );
      return bSurp - aSurp;
    });

  const sendFromDonor = (donorId, receiverId, res, needed) => {
    let remaining = needed;
    for (const donor of getDonors()) {
      if (donor.id === donorId && donorId !== null) {
        // specifieke donor (forcedReceiver pass)
      }
      if (donor.id === receiverId) continue;
      const avail = Math.min(donorAvailable(donor, res), num(donor.cap));
      const send  = Math.min(floorTo500(avail), remaining);
      if (send <= 0) continue;
      planTransfer(donor.id, receiverId, res, send);
      donor[`eff_${res}`] -= send;
      donor.cap           -= send;
      state.get(receiverId)[`eff_${res}`] += send;
      remaining -= send;
      if (remaining <= 0) break;
    }
    return remaining; // resterende tekort
  };

  // ── 3a. forcedReceiver (inline culture pass) ───────────────────────────

  if (forcedReceiver) {
    const { townId, need } = forcedReceiver;
    if (state.has(townId)) {
      for (const res of ["wood", "stone", "iron"]) {
        const needed = ceilTo500(need[res] ?? 0);
        if (needed > 0) sendFromDonor(null, townId, res, needed);
      }
    }
  }

  // ── 3b. Prioriteitssteden aanvullen ────────────────────────────────────

  for (const def of priorityDefs) {
    const receiver = state.get(def.id);
    if (!receiver) continue;
    for (const res of ["wood", "stone", "iron"]) {
      const targetPct = (def.minPct ?? {})[res];
      if (targetPct === null || targetPct === undefined) continue;
      const needed = receiverNeed(receiver, res, targetPct);
      if (needed > 0) sendFromDonor(null, def.id, res, needed);
    }
  }

  // ── 3c. Nivelleren — L5: hybride donor/ontvanger ───────────────────────

  const sortedByRoom = [...state.values()].sort((a, b) => {
    const fillA = Math.max(
      a.eff_wood  / num(a.storage_volume),
      a.eff_stone / num(a.storage_volume),
      a.eff_iron  / num(a.storage_volume),
    );
    const fillB = Math.max(
      b.eff_wood  / num(b.storage_volume),
      b.eff_stone / num(b.storage_volume),
      b.eff_iron  / num(b.storage_volume),
    );
    return fillA - fillB; // laagste fill% eerst (meeste ruimte)
  });

  for (const receiver of sortedByRoom) {
    const storage = num(receiver.storage_volume);
    for (const res of ["wood", "stone", "iron"]) {
      const fillPct = receiver[`eff_${res}`] / storage;
      if (fillPct >= globalMinPct) continue;

      // L5-fix: ook steden met cap > 0 mogen ontvanger zijn als fill% < globalMinPct
      // (vroeger: if (receiver.cap > 0) continue)
      const needed = ceilTo500((globalMinPct - fillPct) * storage);
      if (needed > 0) sendFromDonor(null, receiver.id, res, needed);
    }
  }

  // ── 4. Transfers uitvoeren ─────────────────────────────────────────────

  let transfersDone = 0;

  for (const plan of transferPlan.values()) {
    const { donorId, receiverId, wood, stone, iron } = plan;
    if (wood + stone + iron <= 0) continue;

    const donorRaw = rawTowns.find(t => t.id === donorId);
    const availCap = num(donorRaw?.cap ?? state.get(donorId)?.cap);

    // L6-fix: sorteer resources op planned-bedrag (meest kritisch = hoogste bedrag eerst)
    // zodat bij cap-tekort het meest benodigde altijd wordt verstuurd
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

    if (sends.wood + sends.stone + sends.iron <= 0) {
      console.log(`[resource-balancer] Skip ${donorId}→${receiverId}: cap uitgeput`);
      continue;
    }

    const donorName    = state.get(donorId)?.name    ?? donorId;
    const receiverName = state.get(receiverId)?.name ?? receiverId;
    console.log(`[resource-balancer] ${donorName} → ${receiverName}: w${sends.wood} s${sends.stone} i${sends.iron}`);

    try {
      await session.gamePost(
        "town_overviews",
        donorId,
        "trade_between_own_town",
        { from: donorId, to: receiverId, wood: sends.wood, stone: sends.stone, iron: sends.iron, town_id: donorId }
      );
      transfersDone++;
    } catch (err) {
      console.warn(`[resource-balancer] Trade mislukt: ${err.message}`);
    }

    await randomSleep(2, 4);
  }

  // ── B8: Bouw townResources map voor culture ────────────────────────────

  const townResources = new Map();
  for (const [id, town] of state) {
    townResources.set(id, {
      wood:  town.eff_wood,
      stone: town.eff_stone,
      iron:  town.eff_iron,
    });
  }

  console.log(`[resource-balancer] ✓ ${transfersDone} transfers`);
  return { summary: { transfers: transfersDone }, townResources };
}

const num = (v) => (v !== null && v !== undefined ? Number(v) : 0);
