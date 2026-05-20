/**
 * index.js — Grepolis Control Tower Bot
 *
 * Lifecycle:
 *  1. Parse env
 *  2. Wacht tot scheduled_start
 *  3. Stuur 'bot_starting' heartbeat (L7 — vóór login)
 *  4. Haal config op van GAS
 *  5. Herstel / valideer sessie; bij Puppeteer-login: cookies terugschrijven (K3)
 *  6. Voer features uit (farm → RB → culture → buildings → military)
 *  7. Stuur run_done, exit clean
 */

import { loadConfig }         from "./lib/config.js";
import { createSession }      from "./lib/session.js";
import { loginWithPuppeteer } from "./lib/auth.js";
import { sendEvent }          from "./lib/events.js";
import { updateCookieSecret } from "./lib/secrets.js";
import { sleep }              from "./lib/delay.js";

import { runFarmAgent }        from "./features/farm-agent.js";
import { runResourceBalancer } from "./features/resource-balancer.js";
import { runCulture }          from "./features/culture.js";
import { runBuildings }        from "./features/buildings.js";
import { runMilitary }         from "./features/military.js";

// ── 1. Parse env ──────────────────────────────────────────────────────────

let scheduledStart, features, runId, gasCallbackUrl, account, rawCookies;

try {
  scheduledStart  = parseInt(process.env.SCHEDULED_START, 10);
  features        = JSON.parse(process.env.FEATURES);
  runId           = process.env.RUN_ID;
  gasCallbackUrl  = process.env.GAS_CALLBACK_URL;
  account         = JSON.parse(process.env.GREPO_ACCOUNT);
  rawCookies      = process.env.GREPO_COOKIES ?? "";

  if (!scheduledStart || !features || !runId || !gasCallbackUrl || !account?.world) {
    throw new Error("Verplichte environment variables ontbreken");
  }
} catch (err) {
  console.error("[boot] Env parse fout:", err.message);
  process.exit(1);
}

// ── 2. Wacht tot scheduled_start ─────────────────────────────────────────

const msUntilStart = scheduledStart - Date.now();
if (msUntilStart > 0) {
  console.log(`[boot] Wacht ${Math.round(msUntilStart / 1000)}s tot scheduled_start…`);
  await sleep(msUntilStart);
}

// ── 3. Vroeg heartbeat — L7: vóór login, GAS weet dat de bot leeft ───────

await sendEvent(gasCallbackUrl, runId, "bot_starting", { features });

// ── 4. Config ophalen van GAS ─────────────────────────────────────────────

const config = await loadConfig(gasCallbackUrl);

// ── 5. Sessie ─────────────────────────────────────────────────────────────

let session;

try {
  session = createSession(account.world, rawCookies);
  const valid = await session.validate();

  if (!valid) {
    console.log("[auth] Cookies verlopen — Puppeteer login starten…");
    const freshCookies = await loginWithPuppeteer(account);

    // K3: verse cookies terugschrijven naar GitHub Secret (fire-and-forget)
    await updateCookieSecret(freshCookies);

    session = createSession(account.world, freshCookies);
    const validAfterLogin = await session.validate();
    if (!validAfterLogin) throw new Error("Sessie ongeldig ook na Puppeteer-login");

    await sendEvent(gasCallbackUrl, runId, "login_success", {});
  }
} catch (err) {
  await sendEvent(gasCallbackUrl, runId, "login_failed", { error: err.message });
  process.exit(1);
}

await sendEvent(gasCallbackUrl, runId, "run_started", { features });

// ── 6. Feature runner ─────────────────────────────────────────────────────

const FEATURE_ORDER = ["farmAgent", "resourceBalancer", "culture", "buildings", "military"];

const FEATURE_MAP = {
  farmAgent:        runFarmAgent,
  resourceBalancer: runResourceBalancer,
  culture:          runCulture,
  buildings:        runBuildings,
  military:         runMilitary,
};

const ctx = { session, config, account, gasCallbackUrl, runId };

let overflowTowns  = [];
let townResources  = null; // B8: gedeeld tussen RB en culture

for (const name of FEATURE_ORDER) {
  if (!features.includes(name)) continue;

  const runner = FEATURE_MAP[name];

  // Verrijk ctx per feature met beschikbare data
  const featureCtx = {
    ...ctx,
    ...(name === "resourceBalancer" ? { urgentDonors: overflowTowns } : {}),
    ...(name === "culture"          ? { townResources }                : {}),
  };

  try {
    console.log(`\n[runner] ▶ ${name}`);
    const result = await runner(featureCtx);

    if (name === "farmAgent" && result?.overflowTowns) {
      overflowTowns = result.overflowTowns;
    }
    // B8: RB retourneert townResources map voor culture
    if (name === "resourceBalancer" && result?.townResources) {
      townResources = result.townResources;
    }

    await sendEvent(gasCallbackUrl, runId, `${name}_done`, result?.summary ?? {});
  } catch (err) {
    console.error(`[runner] ✗ ${name}:`, err.message);
    await sendEvent(gasCallbackUrl, runId, `${name}_error`, { error: err.message });

    if (err.message === "SESSION_EXPIRED") {
      await sendEvent(gasCallbackUrl, runId, "run_error", { error: "Sessie verlopen tijdens run" });
      process.exit(1);
    }
  }
}

// ── 7. Done ───────────────────────────────────────────────────────────────

await sendEvent(gasCallbackUrl, runId, "run_done", {});
console.log("\n[boot] ✓ Run voltooid.");
