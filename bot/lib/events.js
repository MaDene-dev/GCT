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
  // Kritieke events (run_done, run_error) krijgen 3 pogingen — guard moet gewist worden
  const isCritical = type === "run_done" || type === "run_error" || type === "login_failed";
  const maxAttempts = isCritical ? 3 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(gasUrl, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        console.warn(`[events] POST "${type}" → HTTP ${res.status} (poging ${attempt})`);
        if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 3000));
      } else {
        console.log(`[events] ✓ ${type}`);
        return;
      }
    } catch (err) {
      console.warn(`[events] ✗ "${type}" poging ${attempt}: ${err.message}`);
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 3000));
    }
  }
}
