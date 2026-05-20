/**
 * lib/secrets.js — Verse cookies terugschrijven naar GitHub Secret
 *
 * Gebruikt de `gh` CLI (pre-installed op GitHub Actions runners) om
 * GREPO_COOKIES bij te werken na een Puppeteer-login.
 *
 * Vereist:
 *  - GCT_SECRET_WRITER_TOKEN: PAT met `secrets:write` scope (aparte secret,
 *    want GITHUB_TOKEN kan zelf geen secrets bijwerken)
 *  - GITHUB_REPOSITORY: automatisch beschikbaar in GitHub Actions ("owner/repo")
 *
 * Buiten GitHub Actions: no-op met waarschuwing.
 */

import { execFileSync } from "child_process";

/**
 * Schrijf verse cookie-JSON terug naar het GREPO_COOKIES GitHub Secret.
 * Fire-and-forget: gooit nooit, logt alleen een waarschuwing bij mislukking.
 * @param {string} cookieJson  JSON-string van de verse cookies
 */
export async function updateCookieSecret(cookieJson) {
  const writerToken = process.env.GCT_SECRET_WRITER_TOKEN;
  const repoStr     = process.env.GITHUB_REPOSITORY; // "owner/repo"

  if (!writerToken) {
    console.warn("[secrets] GCT_SECRET_WRITER_TOKEN niet ingesteld — cookies niet teruggeschreven");
    return;
  }

  if (!repoStr || !repoStr.includes("/")) {
    console.warn("[secrets] GITHUB_REPOSITORY niet beschikbaar — cookies niet teruggeschreven");
    return;
  }

  try {
    execFileSync(
      "gh",
      ["secret", "set", "GREPO_COOKIES", "--repo", repoStr],
      {
        input:   cookieJson,
        env:     { ...process.env, GH_TOKEN: writerToken },
        timeout: 15_000,
        stdio:   ["pipe", "pipe", "pipe"],
      }
    );
    console.log("[secrets] ✓ GREPO_COOKIES bijgewerkt in GitHub Secrets");
  } catch (err) {
    // Fire-and-forget: run niet afbreken als dit mislukt
    console.warn("[secrets] ✗ Secret update mislukt:", err.message);
  }
}
