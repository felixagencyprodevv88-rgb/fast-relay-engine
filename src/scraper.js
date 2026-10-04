// FAST-ONLY RELAY ENGINE
// No browser, no Docker dependencies - runs on any plain Node.js host for free.
// This handles the easy majority of stores. Anything it can't resolve on its own
// is clearly flagged with status "escalate" so the caller (Lovable) knows to send
// that specific URL to the full engine (Railway) instead - nothing is ever silently dropped.

const pLimit = require("p-limit");

const ONLY_GMAIL = String(process.env.ONLY_GMAIL || "false").toLowerCase() === "true";
const MAX_PAGES = Number(process.env.MAX_PAGES || 10);
const FAST_TIMEOUT_MS = Number(process.env.FAST_TIMEOUT_MS || 6000);
const FAST_DEADLINE_MS = Number(process.env.FAST_DEADLINE_MS || 25000);
const FAST_CONCURRENCY = Number(process.env.FAST_CONCURRENCY || 20);
const FAST_BATCH_SIZE = Number(process.env.FAST_BATCH_SIZE || 4);
const HARD_PAGE_TIMEOUT_MS = Number(process.env.HARD_PAGE_TIMEOUT_MS || 30000);

const fastLimit = pLimit(FAST_CONCURRENCY);

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const BROWSER_HEADERS = {
  "User-Agent": USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,es;q=0.8",
};

const FALLBACK_PATHS = [
  "/pages/contact", "/pages/contact-us", "/pages/contacto", "/pages/contactanos",
  "/policies/contact-information", "/pages/about-us", "/pages/about",
  "/pages/sobre-nosotros", "/pages/nosotros", "/policies/privacy-policy",
  "/policies/refund-policy", "/policies/terms-of-service", "/policies/shipping-policy",
  "/pages/faq", "/pages/preguntas-frecuentes", "/contact", "/contacto", "/about",
];

const LINK_HINT =
  /contact|contacto|contactanos|contáctanos|about|nosotros|sobre|support|soporte|ayuda|help|faq|preguntas|polic|politica|política|privacy|privacidad|terms|terminos|términos|refund|reembolso|devolucion|devolución|shipping|envio|envío|impressum|kontakt|legal|whatsapp/i;

function discoverLinks(html, origin) {
  const found = new Map();
  const re = /<a\b[^>]*?href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && found.size < 40) {
    const href = m[1].trim();
    if (/^(mailto:|tel:|javascript:|whatsapp:)/i.test(href)) continue;
    let u;
    try { u = new URL(href, origin + "/"); } catch { continue; }
    if (u.origin !== origin) continue;
    if (/\/(products|collections|blogs|cart|account|search)(\/|$)/i.test(u.pathname)) continue;
    if (/\.(png|jpe?g|gif|webp|svg|css|js|pdf|xml)$/i.test(u.pathname)) continue;
    const text = m[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    if (LINK_HINT.test(u.pathname) || LINK_HINT.test(text)) {
      found.set(u.origin + u.pathname.replace(/\/+$/, ""), true);
    }
  }
  return [...found.keys()];
}

const JUNK_DOMAINS =
  /(^|\.)(sentry\.io|wixpress\.com|example\.com|example\.org|domain\.com|yourdomain\.com|email\.com|shopify\.com|myshopify\.com|shopifycdn\.com|cloudflare\.com|w3\.org|schema\.org|test\.com)$/i;
const JUNK_LOCAL = /^(your|youremail|name|email|user|username|example|test|someone|you|nombre|correo|tucorreo)$/i;
const ASSET_TLD = /^(png|jpe?g|gif|webp|svg|avif|ico|css|js|mjs|json|woff2?|ttf|eot|map|mp4|pdf)$/i;
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9\-]+(?:\.[a-zA-Z0-9\-]+)*\.[a-zA-Z]{2,}/g;

function decodeCf(hex) {
  try {
    const key = parseInt(hex.slice(0, 2), 16);
    let out = "";
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return out;
  } catch { return ""; }
}

function preprocess(html) {
  return html
    .replace(/&#0*64;|&#x0*40;|&commat;/gi, "@")
    .replace(/\\u0040/gi, "@")
    .replace(/%40/g, "@")
    .replace(/&#0*46;|&#x0*2e;|&period;/gi, ".");
}

function extractEmails(rawHtml, storeHost) {
  const html = preprocess(rawHtml);
  const extra = [];
  let m;
  const cf = /data-cfemail\s*=\s*["']([0-9a-f]{4,})["']|email-protection#([0-9a-f]{4,})/gi;
  while ((m = cf.exec(html))) extra.push(decodeCf(m[1] || m[2]));
  const mailto = /mailto:([^"'?\s<>]+)/gi;
  while ((m = mailto.exec(html))) { try { extra.push(decodeURIComponent(m[1])); } catch { extra.push(m[1]); } }

  const haystack = extra.join(" ") + " " + html;
  const seen = new Set();
  const list = [];
  for (const raw of haystack.match(EMAIL_RE) || []) {
    const e = raw.toLowerCase();
    if (seen.has(e)) continue;
    seen.add(e);
    const [local, domain] = e.split("@");
    if (!local || !domain || local.length > 64) continue;
    if (JUNK_LOCAL.test(local) || JUNK_DOMAINS.test(domain)) continue;
    if (ASSET_TLD.test(domain.split(".").pop())) continue;
    if (ONLY_GMAIL && domain !== "gmail.com") continue;
    list.push(e);
  }
  const host = (storeHost || "").replace(/^www\./, "");
  const rank = (e) => {
    const d = e.split("@")[1];
    if (d === "gmail.com") return 0;
    if (host && (d === host || host.endsWith("." + d) || d.endsWith("." + host))) return 1;
    return 2;
  };
  return list.map((e, i) => ({ e, i })).sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i).map((x) => x.e);
}

function looksThin(html) {
  if (!html) return false;
  const anchors = (html.match(/<a\b/gi) || []).length;
  const textLen = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, "").replace(/\s+/g, "").length;
  return anchors < 8 || textLen < 800;
}

async function fastGetPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FAST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow", signal: controller.signal });
    let html = "";
    if (res.status < 400) html = (await res.text()).slice(0, 2_000_000);
    return { status: res.status, html, finalUrl: res.url };
  } finally {
    clearTimeout(timer);
  }
}

const withHardTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("hard_timeout")), ms))]);

async function crawlDomain(baseUrl, deadlineAt, batchSize) {
  const start = new URL(baseUrl);
  let origin = start.origin;
  const result = { emails: [], pagesChecked: 0, loadedAny: false, sawHttpError: false, passwordPage: false, homeHtml: null };

  const checkOne = async (url) => {
    let res = null;
    try { res = await withHardTimeout(fastGetPage(url), HARD_PAGE_TIMEOUT_MS); } catch { res = null; }
    result.pagesChecked++;
    if (!res || !res.status || res.status >= 400) {
      if (res && res.status >= 400) result.sawHttpError = true;
      return null;
    }
    result.loadedAny = true;
    return res;
  };

  const home = await checkOne(origin + "/");
  if (!home) return result;
  result.homeHtml = home.html;
  if (home.finalUrl) {
    try {
      const f = new URL(home.finalUrl);
      origin = f.origin;
      if (/^\/password\/?$/i.test(f.pathname)) result.passwordPage = true;
    } catch {}
  }
  if (result.passwordPage) return result;

  let emails = extractEmails(home.html, new URL(origin).hostname);
  if (emails.length) { result.emails = emails; return result; }

  const queued = new Set([origin + "/"]);
  const rest = [];
  const enqueue = (u) => { const k = u.replace(/\/+$/, ""); if (!queued.has(k)) { queued.add(k); rest.push(u); } };
  discoverLinks(home.html, origin).slice(0, 8).forEach(enqueue);
  FALLBACK_PATHS.forEach((p) => enqueue(origin + p));

  let consecutiveFailedBatches = 0;
  for (let i = 0; i < rest.length && result.pagesChecked < MAX_PAGES && Date.now() < deadlineAt; i += batchSize) {
    const batch = rest.slice(i, i + Math.min(batchSize, MAX_PAGES - result.pagesChecked));
    const pages = await Promise.all(batch.map(checkOne));
    if (!pages.some((p) => p)) {
      consecutiveFailedBatches++;
      if (!result.loadedAny && consecutiveFailedBatches >= 2) break;
      continue;
    }
    consecutiveFailedBatches = 0;
    for (const p of pages) {
      if (!p) continue;
      const found = extractEmails(p.html, new URL(origin).hostname);
      if (found.length) { result.emails = found; return result; }
    }
  }
  return result;
}

const pick = (emails) => ({ email: emails[0], all_matches: emails, email_type: emails[0].endsWith("@gmail.com") ? "gmail" : "domain" });

// Returns a FINAL result (success/failed) when the fast tier alone is enough to be sure,
// or { status: "escalate" } telling the caller this one genuinely needs the full browser engine.
async function scanUrl(rawUrl) {
  try {
    const r = await fastLimit(() => crawlDomain(rawUrl, Date.now() + FAST_DEADLINE_MS, FAST_BATCH_SIZE));
    if (r.emails.length) return { status: "success", ...pick(r.emails), pages_checked: r.pagesChecked, tier: "fast-relay" };
    if (!r.loadedAny) return { status: "escalate", reason: "could_not_load" };
    if (r.passwordPage) return { status: "failed", fail_reason: "password_protected", pages_checked: r.pagesChecked, tier: "fast-relay" };
    if (looksThin(r.homeHtml)) return { status: "escalate", reason: "javascript_heavy" };
    return { status: "failed", fail_reason: "no_email_found", pages_checked: r.pagesChecked, tier: "fast-relay" };
  } catch {
    return { status: "escalate", reason: "relay_error" };
  }
}

module.exports = { scanUrl, __test: { extractEmails, discoverLinks, decodeCf, crawlDomain, looksThin } };
