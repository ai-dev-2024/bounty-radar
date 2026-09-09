/**
 * Bounty Radar API — Stage 1 (Cloudflare Worker)
 *
 * Serves the verified feed published every 6h by the radar's GitHub Action.
 * Stage 1 = queryable, filterable, cache-friendly. No keys, no DB (YAGNI until Stage 2).
 *
 *   GET /v1/listings?source=&type=&min_amount=&max_age_days=&min_score=&escrow_only=1&q=&sort=score|amount|freshness&limit=
 *   GET /v1/listings/{id}     id: "org/repo#123" or "source:org:title" (URL-encoded)
 *   GET /v1/sources           per-source counts + sweep freshness
 *   GET /v1/stats             market pulse
 *   GET /openapi.json
 *
 * Env (wrangler.toml [vars]): FEED_URL, CACHE_TTL_MS
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "If-None-Match",
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

// --- feed cache (per-isolate; workers stay warm, TTL covers the rest) -------
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
    try {
      if (pathname === "/v1/listings") return await listings(request, env);
      if (pathname.startsWith("/v1/listings/")) return await listings(request, env, pathname.slice("/v1/listings/".length));
      if (pathname === "/v1/sources") return await sources(env);
      if (pathname === "/v1/stats") return await stats(env);
      if (pathname === "/openapi.json") return json(OPENAPI, { request });
      if (pathname === "/") return json({ name: "bounty-radar-api", version: "1.0.0", docs: "/openapi.json",
        endpoints: ["/v1/listings", "/v1/listings/{id}", "/v1/sources", "/v1/stats"] }, { request });
      return json({ error: "not found" }, { status: 404, request });
    } catch (e) {
      return json({ error: e.message }, { status: 502, request });
    }
  },
};
