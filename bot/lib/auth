/**
 * lib/auth.js — Puppeteer 3-staps login
 *
 * Stap 1: Portal login op nl-play.grepolis.com
 * Stap 2: World selection form op nl0.grepolis.com/start/index
 * Stap 3: Navigeer naar geïntercepteerde game-redirect URL
 *
 * Concurrent session guard: als "select_new_world" verschijnt → STOP meteen.
 * Cookie-drempel: < 12 = ongeldig (bevestigd via API-ref).
 */

import puppeteer from "puppeteer";

const LOGIN_TIMEOUT = 30_000;

/**
 * @param {{ username, password, world }} account
 * @returns {string} JSON-geserialiseerde cookie-array
 */
export async function loginWithPuppeteer(account) {
  const { username, password, world } = account;

  const browser = await puppeteer.launch({
    headless:  true,
    args:      ["--no-sandbox", "--disable-setuid-sandbox"],
    timeout:   60_000,
  });

  const page = await browser.newPage();

  try {
    let loginRedirectUrl = null;

    // Interceptor instellen VOOR navigatie — anders missen we de redirect
    page.on("request", req => {
      const url = req.url();
      if (url.includes(`${world}.grepolis.com`) && url.includes("game/index?login=1")) {
        loginRedirectUrl = url;
      }
    });

    // ── Stap 1: Portal login ──────────────────────────────────────────────
    console.log("[auth] Stap 1: portal login…");
    await page.goto("https://nl-play.grepolis.com", { waitUntil: "networkidle2", timeout: LOGIN_TIMEOUT });

    await page.type(
      "#page_login_always-visible_input_player-identifier",
      username,
      { delay: rnd(50, 120) }
    );
    await page.type(
      "#page_login_always-visible_input_password",
      password,
      { delay: rnd(50, 120) }
    );

    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button, a.button")]
        .find(el => /inloggen|login/i.test(el.textContent));
      if (!btn) throw new Error("Login-knop niet gevonden");
      btn.click();
    });

    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: LOGIN_TIMEOUT });

    // ── Stap 2: World selection ───────────────────────────────────────────
    console.log("[auth] Stap 2: world selection…");
    await page.goto("https://nl0.grepolis.com/start/index", { waitUntil: "networkidle2", timeout: LOGIN_TIMEOUT });

    // Concurrent session guard — nooit knoppen klikken op deze pagina
    const url2 = page.url();
    if (url2.includes("select_new_world") || url2.includes("choose_direction")) {
      throw new Error("CONCURRENT_SESSION: actieve sessie aanwezig — niets doen");
    }

    // Submit world-form door waarde te injecteren
    await page.evaluate((w) => {
      const form = document.querySelector('form[action*="login_to_game_world"]');
      if (!form) throw new Error("World selection form niet gevonden");
      let inp = form.querySelector('input[name="world"]');
      if (!inp) {
        inp = document.createElement("input");
        inp.type = "hidden";
        inp.name = "world";
        form.appendChild(inp);
      }
      inp.value = w;
      form.submit();
    }, world);

    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: LOGIN_TIMEOUT }).catch(() => {});

    if (page.url().includes("select_new_world")) {
      throw new Error("CONCURRENT_SESSION: select_new_world na form submit");
    }

    // ── Stap 3: Game redirect ─────────────────────────────────────────────
    console.log("[auth] Stap 3: game redirect…");
    if (!loginRedirectUrl) {
      throw new Error("Game-redirect URL niet geïntercepteerd — login mislukt?");
    }
    await page.goto(loginRedirectUrl, { waitUntil: "networkidle2", timeout: LOGIN_TIMEOUT });

    // ── Validatie ─────────────────────────────────────────────────────────
    const html = await page.content();
    if (html.length < 200_000) {
      throw new Error(`Sessie ongeldig: pagina te klein (${html.length}b)`);
    }

    const cookies = await page.cookies(
      `https://${world}.grepolis.com`,
      "https://nl-play.grepolis.com",
      "https://nl0.grepolis.com"
    );

    if (cookies.length < 12) {
      throw new Error(`Sessie ongeldig: te weinig cookies (${cookies.length})`);
    }

    console.log(`[auth] ✓ Login geslaagd — ${cookies.length} cookies`);
    return JSON.stringify(cookies);

  } finally {
    await browser.close();
  }
}

const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
