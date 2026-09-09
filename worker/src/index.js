/**
 * Bounty Radar API — Stage 2 (Cloudflare Worker)
 *
 * Stage 1: queryable feed (listings/sources/stats) — stays free, rate-limited by IP.
 * Stage 2: API keys in KV. /v1/keys/migrate upgrades an anonymous IP-quota to a key.
 * Stripe: handled with Payment Links + webhook forwarding (see README) — no SDK,
 * one webhook endpoint that flips the KV record to paid on checkout.session.completed.
 *
 *   GET  /v1/listings...           free 100/day per IP (or per key, higher cap)
 *   POST /v1/keys                  create key {email?} → {key, daily_limit}  (rate-limited by IP)
 *   GET  /v1/keys/me               key status: plan, usage, limit
 *   POST /v1/webhooks/stripe       checkout.session.completed → mark paid (signature checked via secret)
 *
 * Env (wrangler.toml): FEED_URL, CACHE_TTL_MS, FREE_DAILY_LIMIT, KV KEYS,
 *                      STRIPE_SECRET (optional, secret), CHECKOUT_URL_AGENT, CHECKOUT_URL_TEAM
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, If-None-Match",
};

const PLANS = {
  free: { limit: null },                 // falls back to FREE_DAILY_LIMIT (IP) or 1000 (key)
  agent: { limit: 5000 },                // $15/mo
  team: { limit: 25000 },                // $79/mo
};

// ponytail: duplicate of mcp-server.mjs filter logic (~40 lines, stable); extract
// to a shared module only if both start drifting.
const inferType = (b) =>
  ({ "algora-jobs": "job", "algora-challenge": "challenge", "algora-mention": "discussion" }[b.source] ?? "bounty");

const listingId = (b) => b.id ?? (b.issue != null ? `${b.org}/${b.repo}#${b.issue}` : `${b.source}:${b.org}:${b.title}`);

const ESCROW_OK = (e) =>
  e === "algora-escrow" || e === "opire-stripe" ||
  (e ?? "").startsWith("algora challenge") || (e ?? "").startsWith("direct employment");

function summarize(b) {
  return {
    id: listingId(b),
    title: b.title,
    url: b.url,
    amount_usd: b.amountUsd ?? null,
    score: b.score ?? null,
    source: b.source,
    type: inferType(b),
    escrow: b.escrow ?? null,
    age_days: b.ageDays ?? null,
    open_competing_prs: b.openCompetingPrs ?? null,
    claim_count: b.claimCount ?? null,
    desc: b.desc ?? undefined,
  };
}

function applyFilters(items, p) {
  let out = [...items];
  if (p.min_score != null) out = out.filter((b) => (b.score ?? 0) >= p.min_score);
  if (p.min_amount != null) out = out.filter((b) => (b.amountUsd ?? 0) >= p.min_amount);
  if (p.max_age_days != null) out = out.filter((b) => b.ageDays == null || b.ageDays <= p.max_age_days);
  if (p.source) {
    const wanted = p.source.split(",").map((s) => s.trim());
    out = out.filter((b) => wanted.includes(b.source));
  }
  if (p.type) {
    const wanted = p.type.split(",").map((s) => s.trim());
    out = out.filter((b) => wanted.includes(inferType(b)));
  }
  if (p.escrow_only) out = out.filter((b) => ESCROW_OK(b.escrow));
  if (p.q) {
    const needle = p.q.toLowerCase();
    out = out.filter((b) =>
      [b.title, b.org, b.repo, b.desc].some((s) => (s ?? "").toLowerCase().includes(needle)));
  }
  const cmp = {
    amount: (a, b) => (b.amountUsd ?? -1) - (a.amountUsd ?? -1),
    freshness: (a, b) => (a.ageDays ?? 1e9) - (b.ageDays ?? 1e9),
  }[p.sort] ?? ((a, b) => (b.score ?? 0) - (a.score ?? 0));
  out.sort(cmp);
  return out;
}

// --- auth + quota (KV; lazy: key record IS the usage counter) -----------------

const today = () => new Date().toISOString().slice(0, 10);

function bearer(request) {
  const h = request.headers.get("Authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

async function getKeyRecord(env, key) {
  if (!key) return null;
  return JSON.parse((await env.KEYS.get(`key:${key}`)) ?? "null");
}

async function checkQuota(env, request, key) {
  // Anonymous: cap per IP per day (KV counter). Keyed: cap per key per day.
  const isKeyed = Boolean(key);
  const id = isKeyed ? key : `ip:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`;
  const rec = isKeyed ? await getKeyRecord(env, key) : null;
  if (isKeyed && (!rec || rec.status === "disabled")) return { ok: false, status: 401, error: "invalid or disabled API key" };
  const limit = isKeyed
    ? (PLANS[rec.plan]?.limit ?? Number(env.FREE_DAILY_LIMIT) * 10)
    : Number(env.FREE_DAILY_LIMIT);
  const day = today();
  let usage = { day, count: 0 };
  if (isKeyed && rec.usage?.day === day) usage = rec.usage;
  else if (!isKeyed) usage = JSON.parse((await env.KEYS.get(`usage:${id}:${day}`)) ?? '{"count":0}');
  if (usage.count >= limit) {
    return { ok: false, status: 429, error: `daily limit ${limit} reached${isKeyed ? "" : " — create a free key for 10x"}`, limit, usage: usage.count };
  }
  usage.count++;
  if (isKeyed) {
    rec.usage = usage;
    await env.KEYS.put(`key:${key}`, JSON.stringify(rec));
  } else {
    await env.KEYS.put(`usage:${id}:${day}`, JSON.stringify(usage), { expirationTtl: 172800 });
  }
  return { ok: true, limit, used: usage.count, plan: isKeyed ? rec.plan : "anonymous" };
}

async function handleCreateKey(env, request) {
  // basic abuse guard: max 5 keys per IP per day
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const created = JSON.parse((await env.KEYS.get(`keycreate:${ip}:${today()}`)) ?? "0");
  if (created >= 5) return json({ error: "too many keys created today" }, { status: 429, request });
  await env.KEYS.put(`keycreate:${ip}:${today()}`, String(created + 1), { expirationTtl: 172800 });

  const key = "brk_" + crypto.randomUUID().replace(/-/g, "");
  const rec = { key, plan: "free", status: "active", created: new Date().toISOString(), usage: { day: today(), count: 0 }, email: null };
  await env.KEYS.put(`key:${key}`, JSON.stringify(rec));
  return json(
    { data: { key, plan: "free", daily_limit: Number(env.FREE_DAILY_LIMIT) * 10, upgrade_urls: { agent: env.CHECKOUT_URL_AGENT ?? null, team: env.CHECKOUT_URL_TEAM ?? null } } },
    { status: 201, request },
  );
}

async function handleKeyMe(env, request, key) {
  const rec = await getKeyRecord(env, key);
  if (!rec || rec.status === "disabled") return json({ error: "invalid or disabled API key" }, { status: 401, request });
  const limit = PLANS[rec.plan]?.limit ?? Number(env.FREE_DAILY_LIMIT) * 10;
  return json(
    { data: { plan: rec.plan, status: rec.status, usage_today: rec.usage?.day === today() ? rec.usage.count : 0, daily_limit: limit, checkout_urls: { agent: env.CHECKOUT_URL_AGENT ?? null, team: env.CHECKOUT_URL_TEAM ?? null } } },
    { request },
  );
}

// Stripe webhook: verify signature (v1 scheme), flip plan on checkout.session.completed.
async function handleStripeWebhook(env, request) {
  if (!env.STRIPE_SECRET) return json({ error: "stripe not configured" }, { status: 501, request });
  const sig = request.headers.get("Stripe-Signature") ?? "";
  const body = await request.text();
  const parts = Object.fromEntries(sig.split(",").map((p) => p.split("=")));
  const expected = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.STRIPE_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    .then((k) => crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${parts.t}.${body}`)))
    .then((sigBuf) => [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join(""));
  if (expected !== parts.v1) return json({ error: "invalid signature" }, { status: 400, request });

  const event = JSON.parse(body);
  if (event.type !== "checkout.session.completed") return json({ received: true }, { request });
  const session = event.data.object;
  const key = session.client_reference_id ?? session.metadata?.key;
  const plan = session.metadata?.plan ?? "agent";
  const rec = await getKeyRecord(env, key);
  if (!rec) return json({ error: `unknown key: ${key}` }, { status: 404, request });
  rec.plan = plan;
  rec.paid_until = new Date(Date.now() + 31 * 86400000).toISOString(); // ponytail: 31d grant, real sub sync if churn matters
  await env.KEYS.put(`key:${key}`, JSON.stringify(rec));
  return json({ received: true, key, plan }, { request });
}
let cache = { data: null, at: 0, inflight: null };

async function getFeed(env) {
  const ttl = Number(env.CACHE_TTL_MS ?? 600000);
  if (cache.data && Date.now() - cache.at < ttl) return { ...cache.data, cached: true };
  cache.inflight ??= (async () => {
    const res = await fetch(env.FEED_URL, { headers: { "User-Agent": "bounty-radar-api/1.0" } });
    if (!res.ok) throw new Error(`feed fetch ${res.status}`);
    return JSON.parse(await res.text());
  })();
  try {
    const data = await cache.inflight;
    cache = { data, at: Date.now(), inflight: null };
    return { ...data, cached: false };
  } catch (e) {
    cache.inflight = null;
    throw e;
  }
}

function json(obj, { status = 200, etag = null, request = null } = {}) {
  const body = JSON.stringify(obj, null, 2);
  const headers = { "Content-Type": "application/json", ...CORS };
  if (etag) {
    headers.ETag = etag;
    if (request?.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
  }
  return new Response(body, { status, headers });
}

// --- handlers ---------------------------------------------------------------

async function listings(request, env, id = null) {
  const feed = await getFeed(env);
  if (id !== null) {
    const decoded = decodeURIComponent(id);
    const b = (feed.bounties ?? []).find((x) => listingId(x) === decoded);
    if (!b) return json({ error: `listing not found: ${decoded}` }, { status: 404, request });
    return json({ data: { ...summarize(b), org: b.org, repo: b.repo, issue: b.issue }, meta: meta(feed) }, { request });
  }
  const p = Object.fromEntries(new URL(request.url).searchParams);
  const num = (v) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const items = applyFilters(feed.bounties ?? [], {
    min_score: num(p.min_score), min_amount: num(p.min_amount), max_age_days: num(p.max_age_days),
    source: p.source, type: p.type, escrow_only: p.escrow_only === "1" || p.escrow_only === "true",
    q: p.q, sort: p.sort,
  });
  const limit = Math.min(num(p.limit) ?? 50, 100);
  return json(
    { data: items.slice(0, limit).map(summarize), meta: { ...meta(feed), total_matched: items.length, returned: Math.min(items.length, limit) } },
    { request, etag: `"l-${feed.generatedAt}-${p.sort ?? ""}-${JSON.stringify(p)}"` && `"l-${feed.generatedAt}"` },
  );
}

function meta(feed) {
  return { generated_at: feed.generatedAt, cached: feed.cached };
}

async function sources(env) {
  const feed = await getFeed(env);
  const bySource = {};
  for (const b of feed.bounties ?? []) bySource[b.source] = (bySource[b.source] ?? 0) + 1;
  return json({ data: { by_source: bySource, sweep_freshness: feed.generatedAt }, meta: meta(feed) }, {});
}

async function stats(env) {
  const feed = await getFeed(env);
  const items = feed.bounties ?? [];
  const scores = items.map((b) => b.score ?? 0).sort((a, b) => a - b);
  return json({
    data: {
      live_listings: items.length,
      total_known_usd: items.reduce((s, b) => s + (b.amountUsd ?? 0), 0),
      median_score: scores.length ? scores[Math.floor(scores.length / 2)] : null,
      by_type: items.reduce((m, b) => { const t = inferType(b); m[t] = (m[t] ?? 0) + 1; return m; }, {}),
    },
    meta: meta(feed),
  }, {});
}

const OPENAPI = {
  openapi: "3.0.3",
  info: { title: "Bounty Radar API", version: "1.0.0",
    description: "Verified, machine-readable feed of payable open-source work. Stage 1: free, no auth." },
  servers: [{ url: "/" }],
  paths: {
    "/v1/listings": { get: { summary: "Search verified listings",
      parameters: [
        { name: "min_score", in: "query", schema: { type: "number" } },
        { name: "min_amount", in: "query", schema: { type: "number" } },
        { name: "max_age_days", in: "query", schema: { type: "number" } },
        { name: "source", in: "query", schema: { type: "string" }, description: "csv: algora,opire,github-label,algora-jobs,algora-challenge,algora-mention" },
        { name: "type", in: "query", schema: { type: "string" }, description: "csv: bounty,job,challenge,discussion" },
        { name: "escrow_only", in: "query", schema: { type: "boolean" } },
        { name: "q", in: "query", schema: { type: "string" } },
        { name: "sort", in: "query", schema: { type: "string", enum: ["score", "amount", "freshness"] } },
        { name: "limit", in: "query", schema: { type: "number", maximum: 100 } },
      ],
      responses: { "200": { description: "Listings + meta" }, "304": { description: "Not modified (send If-None-Match)" } } } },
    "/v1/listings/{id}": { get: { summary: "One listing",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: { "200": { description: "Listing" }, "404": { description: "Not found" } } } },
    "/v1/sources": { get: { summary: "Per-source counts + freshness", responses: { "200": { description: "OK" } } } },
    "/v1/stats": { get: { summary: "Market pulse", responses: { "200": { description: "OK" } } } },
  },
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const { pathname } = new URL(request.url);
    const key = bearer(request);
    try {
      // Un-metered endpoints (marketing + spec): no quota.
      if (request.method === "POST" && pathname === "/v1/keys") return await handleCreateKey(env, request);
      if (pathname === "/openapi.json") return json(OPENAPI, { request });
      if (pathname === "/") return json({ name: "bounty-radar-api", version: "2.0.0", docs: "/openapi.json",
        endpoints: ["/v1/listings", "/v1/listings/{id}", "/v1/sources", "/v1/stats", "/v1/keys (POST)", "/v1/keys/me"],
        auth: "Authorization: Bearer brk_… (optional; anonymous = 100 req/day per IP, free key = 1000/day)" }, { request });

      // Everything below consumes quota.
      const quota = await checkQuota(env, request, key);
      if (!quota.ok) return json({ error: quota.error, limit: quota.limit, usage: quota.usage, create_key: "/v1/keys" }, { status: quota.status, request });
      const quotaMeta = { plan: quota.plan, rate_limit: { limit: quota.limit, used: quota.used } };

      let res;
      if (key && pathname === "/v1/keys/me") res = await handleKeyMe(env, request, key);
      else if (pathname === "/v1/listings") res = await listings(request, env);
      else if (pathname.startsWith("/v1/listings/")) res = await listings(request, env, pathname.slice("/v1/listings/".length));
      else if (pathname === "/v1/sources") res = await sources(env);
      else if (pathname === "/v1/stats") res = await stats(env);
      else if (pathname === "/v1/webhooks/stripe" && request.method === "POST") return await handleStripeWebhook(env, request);
      else res = json({ error: "not found" }, { status: 404, request });

      if (res instanceof Response) return res;
      // stamp quota meta onto json() results that went through helpers
      return res;
    } catch (e) {
      return json({ error: e.message }, { status: 502, request });
    }
  },
};
