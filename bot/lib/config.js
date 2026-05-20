/**
 * lib/config.js — Config ophalen van GAS (optie B)
 *
 * Bij elke run doet de bot een GET naar de GAS webapp met een geheim token.
 * GAS retourneert de volledige config (balancer-drempels, island assignments, etc.).
 * Als de GET mislukt: valt terug op config.json in de repo.
 *
 * CONFIG_SECRET zit in zowel GitHub Secrets als GAS Script Properties.
 */

import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * @param {string} gasUrl   GAS webapp URL
 * @returns {object}        Config-object
 */
export async function loadConfig(gasUrl) {
  // Probeer eerst van GAS ophalen
  const secret = process.env.GCT_CONFIG_SECRET;
  if (gasUrl && secret) {
    try {
      const url = `${gasUrl}?action=get_config&secret=${encodeURIComponent(secret)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const data = await res.json();
        if (data && !data.error) {
          console.log("[config] ✓ Config opgehaald van GAS");
          return sanitize_(data);
        }
      }
      console.warn("[config] GAS config-fetch mislukt:", res.status);
    } catch (e) {
      console.warn("[config] GAS config-fetch error:", e.message);
    }
  }

  // Fallback: config.json uit de repo
  console.log("[config] Fallback: config.json");
  const raw = await readFile(join(__dirname, "..", "config.json"), "utf8");
  return sanitize_(JSON.parse(raw));
}

function sanitize_(config) {
  // Verwijder credentials als die er ooit per ongeluk in zitten
  delete config.username;
  delete config.password;
  delete config.player_id;
  return config;
}
