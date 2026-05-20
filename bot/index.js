/**
 * index.js — Grepolis Control Tower Bot
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

const scheduledStart = parseInt(process.env.SCHEDULED_START, 10);
const runId          = process.env.RUN_ID;
const gasCallbackUrl = process.env.GAS_CALLBACK_URL;
const rawCookies     = process.env.GREPO_COOKIES ?? "";

// Credentials — elk een aparte secret, geen JSON-parsing nodig
const account = {
  username:  process.env.GREPO_USERNAME,
  password:  process.env.GREPO_PASSWORD,
  world:     process.env.GREPO_WORLD,
  player_id: parseInt(process.env.GREPO_PLAYER_ID, 10),
};

let features;
try {
  features = JSON.parse(process.env.FEATURES);
} catch (e) {
  console.error("[boot] FEATURES parse fout:", e.message, "| waarde:", process.env.FEATURES);
  process.exit(1);
}

// Validatie
const missing = [];
if (!scheduledStart)      missing.push("SCHEDULED_START");
if (!features?.length)    missing.push("FEATURES");
if (!runId)               missing.push("RUN_ID");
if (!gasCallbackUrl)      missing.push("GAS_CALLBACK_URL");
if (!account.username)    missing.push("GREPO_USERNAME");
if (!account.password)    missing.push("GREPO_PASSWORD");
if (!account.world)       missing.push("GREPO_WORLD");
if (!account.player_id)   missing.push("GREPO_PLAYER_ID");

if (missing.length > 0) {
  console.error("[boot] Ontbrekende env vars:", missing.join(", "));
  process.exit(1);
}

console.log(`[boot] World: ${account.world} | Player: ${account.player_id} | Features: ${features.join(", ")}`);

// ── 2. Wacht tot scheduled_start ─────────────────────────────────────────

const msUntilStart = scheduledStart - Date.now();
if (msUntilStart > 0) {
  console.log(`[boot] Wacht ${Math.round(msUntilStart / 1000)}s…`);
  await sleep(msUntilStart);
}

// ── 3. Vroeg heartbeat ────────────────────────────────────────────────────

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

let overflowTowns = [];
let townResources = null;

for (const name of FEATURE_ORDER) {
  if (!features.includes(name)) continue;

  const featureCtx = {
    ...ctx,
    ...(name === "resourceBalancer" ? { urgentDonors: overflowTowns } : {}),
    ...(name === "culture"          ? { townResources }                : {}),
  };

  try {
    console.log(`\n[runner] ▶ ${name}`);
    const result = await (FEATURE_MAP[name])(featureCtx);

    if (name === "farmAgent" && result?.overflowTowns)     overflowTowns = result.overflowTowns;
    if (name === "resourceBalancer" && result?.townResources) townResources = result.townResources;

    await sendEvent(gasCallbackUrl, runId, `${name}_done`, result?.summary ?? {});
  } catch (err) {
    console.error(`[runner] ✗ ${name}:`, err.message);
    await sendEvent(gasCallbackUrl, runId, `${name}_error`, { error: err.message });
    if (err.message === "SESSION_EXPIRED") {
      await sendEvent(gasCallbackUrl, runId, "run_error", { error: "Sessie verlopen" });
      process.exit(1);
    }
  }
}

// ── 7. Done ───────────────────────────────────────────────────────────────

await sendEvent(gasCallbackUrl, runId, "run_done", {});
console.log("\n[boot] ✓ Run voltooid.");
