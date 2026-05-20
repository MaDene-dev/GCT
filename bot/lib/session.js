/**
 * lib/session.js — HTTP-sessie via native fetch
 *
 * Beheert:
 *  - Cookie jar (handmatig per domein)
 *  - CSRF-token (enkel uit game-pagina HTML — NIET uit t_token)
 *  - activeTownId (uit toid-cookie)
 *  - gameGet / gamePost met optionele extra URL-params
 *  - Sessie-expiry detectie
 */

export function createSession(world, rawCookies) {
  return new Session(world, rawCookies);
}

class Session {
  constructor(world, rawCookies) {
    this.world        = world;
    this.baseUrl      = `https://${world}.grepolis.com`;
    this.csrf         = null;
    this.activeTownId = null;
    /** @type {Map<string, Map<string, string>>} */
    this.cookieJar    = new Map();

    if (rawCookies && rawCookies.trim()) {
      try {
        this._importCookies(JSON.parse(rawCookies.trim()));
        // Probeer activeTownId direct uit geïmporteerde cookies
        this.activeTownId = this._extractToid();
      } catch (e) {
        console.warn("[session] Cookie-import mislukt:", e.message);
      }
    }
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /**
   * Valideer sessie: haal game-pagina op, check grootte + cookies + CSRF.
   * Stelt ook activeTownId in vanuit de toid-cookie.
   */
  async validate() {
    const url = `${this.baseUrl}/game/${this.world}`;
    const res  = await this._fetch(url, { method: "GET", headers: this._headers() });
    const html = await res.text();

    const cookieCount = this._cookieCount();
    // Debug: toon eerste 300 chars van response zodat we zien wat we terugkrijgen
    if (html.length < 200000) {
      console.warn(`[session] Ongeldig — html=${html.length}b cookies=${cookieCount}`);
      console.warn(`[session] URL: ${url}`);
      console.warn(`[session] Response snippet: ${html.slice(0, 300).replace(/\s+/g, " ")}`);
      return false;
    }
    if (cookieCount < 12) {
      console.warn(`[session] Ongeldig — html=${html.length}b cookies=${cookieCount}`);
      return false;
    }

    this.csrf = this._extractCsrf(html);
    if (!this.csrf) {
      console.warn("[session] CSRF niet gevonden in HTML");
      return false;
    }

    // toid kan ook als cookie meekomen in de validate-response
    if (!this.activeTownId) {
      this.activeTownId = this._extractToid();
    }

    if (!this.activeTownId) {
      console.warn("[session] toid-cookie niet gevonden — activeTownId onbekend");
      return false;
    }

    console.log(`[session] ✓ csrf=${this.csrf.slice(0,8)}… toid=${this.activeTownId} cookies=${cookieCount}`);
    return true;
  }

  /**
   * GET wrapper.
   * @param {string} endpoint
   * @param {number} townId
   * @param {string} action
   * @param {object} jsonPayload
   */
  async gameGet(endpoint, townId, action, jsonPayload = null) {
    const params = new URLSearchParams({
      town_id: townId,
      action,
      h:       this.csrf,
      _:       Date.now(),
    });
    if (jsonPayload) params.set("json", JSON.stringify(jsonPayload));

    const res = await this._fetch(`${this.baseUrl}/game/${endpoint}?${params}`, {
      method:  "GET",
      headers: this._headers(),
    });
    return this._handleResponse(res);
  }

  /**
   * POST wrapper.
   * @param {string} endpoint
   * @param {number} townId
   * @param {string} action
   * @param {object} jsonPayload  — gaat als form-encoded body
   * @param {object} extraParams  — worden als extra query-params aan de URL toegevoegd
   *                               (bv. { celebration_type: "party" })
   */
  async gamePost(endpoint, townId, action, jsonPayload = null, extraParams = {}) {
    const params = new URLSearchParams({
      town_id: townId,
      action,
      h:       this.csrf,
      ...extraParams,
    });

    const body = new URLSearchParams();
    if (jsonPayload) body.set("json", JSON.stringify(jsonPayload));

    const res = await this._fetch(`${this.baseUrl}/game/${endpoint}?${params}`, {
      method:  "POST",
      headers: {
        ...this._headers(),
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body: body.toString(),
    });
    return this._handleResponse(res);
  }

  exportCookies() {
    const out = [];
    for (const [domain, jar] of this.cookieJar) {
      for (const [name, value] of jar) {
        out.push({ name, value, domain, path: "/" });
      }
    }
    return JSON.stringify(out);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  async _fetch(url, options) {
    const domain      = new URL(url).hostname;
    const cookieHdr   = this._buildCookieHeader(domain);
    const headers     = { ...options.headers };
    if (cookieHdr) headers["Cookie"] = cookieHdr;

    const res = await fetch(url, { ...options, headers, redirect: "follow" });

    // Verwerk Set-Cookie headers
    const setCookies = res.headers.getSetCookie?.() ?? [];
    for (const raw of setCookies) this._parseSetCookie(raw, domain);

    // Hercheck toid na elke response
    if (!this.activeTownId) this.activeTownId = this._extractToid();

    return res;
  }

  async _handleResponse(res) {
    const text = await res.text();
    if (this._isExpired(text)) throw new Error("SESSION_EXPIRED");

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // HTML-response (bv. building_overview, culture_overview)
      return { html: text };
    }

    // CSRF-token ALLEEN verversen vanuit de game-HTML, nooit vanuit t_token.
    // t_token in trade_overview is een town-ID, geen CSRF-token.
    // Sommige responses sturen een verse csrfToken mee:
    const freshCsrf = data?.json?.csrfToken ?? data?.csrfToken;
    if (freshCsrf && typeof freshCsrf === "string" && freshCsrf.length > 8) {
      this.csrf = freshCsrf;
    }

    return data?.json ?? data;
  }

  _isExpired(text) {
    if (text.length < 5_000 && text.trimStart().startsWith("<!")) return true;
    try {
      if (JSON.parse(text)?.error === "not_logged_in") return true;
    } catch { /* geen JSON */ }
    return false;
  }

  _extractCsrf(html) {
    const m = html.match(/"csrfToken"\s*:\s*"([^"]{8,})"/);
    if (m) return m[1];
    const m2 = html.match(/"csrf_token"\s*:\s*"([^"]{8,})"/);
    return m2?.[1] ?? null;
  }

  _extractToid() {
    for (const jar of this.cookieJar.values()) {
      if (jar.has("toid")) {
        const val = parseInt(jar.get("toid"), 10);
        if (!isNaN(val) && val > 0) return val;
      }
    }
    return null;
  }

  _headers() {
    return {
      "User-Agent":       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept-Language":  "nl-BE,nl;q=0.9,en;q=0.7",
      "Referer":          `${this.baseUrl}/game/${this.world}`,
      "X-Requested-With": "XMLHttpRequest",
      "Accept":           "application/json, */*",
    };
  }

  _importCookies(arr) {
    for (const { name, value, domain } of arr) {
      const key = domain.replace(/^\./, "");
      if (!this.cookieJar.has(key)) this.cookieJar.set(key, new Map());
      this.cookieJar.get(key).set(name, value);
    }
  }

  _parseSetCookie(raw, fallbackDomain) {
    const parts = raw.split(";").map(s => s.trim());
    // Gebruik indexOf zodat cookie-values met '=' correct geparsed worden
    const eqIdx = parts[0].indexOf("=");
    if (eqIdx < 0) return;
    const name  = parts[0].slice(0, eqIdx).trim();
    const value = parts[0].slice(eqIdx + 1).trim();
    let domain  = fallbackDomain;

    for (const part of parts.slice(1)) {
      if (part.toLowerCase().startsWith("domain=")) {
        domain = part.slice(7).trim().replace(/^\./, "");
      }
    }

    if (!this.cookieJar.has(domain)) this.cookieJar.set(domain, new Map());
    this.cookieJar.get(domain).set(name, value);
  }

  _buildCookieHeader(requestDomain) {
    const cookies = [];
    for (const [domain, jar] of this.cookieJar) {
      if (requestDomain === domain || requestDomain.endsWith(`.${domain}`)) {
        for (const [name, value] of jar) {
          cookies.push(`${name}=${value}`);
        }
      }
    }
    return cookies.join("; ");
  }

  _cookieCount() {
    let n = 0;
    for (const jar of this.cookieJar.values()) n += jar.size;
    return n;
  }
}
