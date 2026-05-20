/**
 * lib/events.js — Fire-and-forget event poster naar GAS
 *
 * Een mislukte POST stopt de bot NOOIT.
 *
 * Event shape:
 * { run_id, type, ts, payload }
 */

export async function sendEvent(gasUrl, runId, type, payload = {}) {
  const body = JSON.stringify({ run_id: runId, type, ts: Date.now(), payload });
  try {
    const res = await fetch(gasUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) console.warn(`[events] POST "${type}" → HTTP ${res.status}`);
    else         console.log(`[events] ✓ ${type}`);
  } catch (err) {
    console.warn(`[events] ✗ "${type}": ${err.message}`);
  }
}
