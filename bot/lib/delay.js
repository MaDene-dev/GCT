/**
 * lib/delay.js — Sleep, jitter en shuffle utilities
 */

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function randomSleep(minSec = 1, maxSec = 3) {
  const ms = (Math.random() * (maxSec - minSec) + minSec) * 1_000;
  await sleep(Math.round(ms));
}

export async function sleepUntil(timestampMs) {
  const delta = timestampMs - Date.now();
  if (delta > 0) await sleep(delta);
}

/** Fisher-Yates in-place shuffle */
export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Afronden naar beneden op veelvoud van 500 */
export const floorTo500 = (n) => Math.floor(n / 500) * 500;

/** Afronden naar boven op veelvoud van 500 */
export const ceilTo500 = (n) => Math.ceil(n / 500) * 500;
