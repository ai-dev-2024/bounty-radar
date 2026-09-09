var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "If-None-Match"
};
var inferType = /* @__PURE__ */ __name((b) => ({ "algora-jobs": "job", "algora-challenge": "challenge", "algora-mention": "discussion" })[b.source] ?? "bounty", "inferType");
var listingId = /* @__PURE__ */ __name((b) => b.id ?? (b.issue != null ? `${b.org}/${b.repo}#${b.issue}` : `${b.source}:${b.org}:${b.title}`), "listingId");
var ESCROW_OK = /* @__PURE__ */ __name((e) => e === "algora-escrow" || e === "opire-stripe" || (e ?? "").startsWith("algora challenge") || (e ?? "").startsWith("direct employment"), "ESCROW_OK");
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
    desc: b.desc ?? void 0
  };
}
__name(summarize, "summarize");
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
    out = out.filter((b) => [b.title, b.org, b.repo, b.desc].some((s) => (s ?? "").toLowerCase().includes(needle)));
  }
  const cmp = {
    amount: /* @__PURE__ */ __name((a, b) => (b.amountUsd ?? -1) - (a.amountUsd ?? -1), "amount"),
    freshness: /* @__PURE__ */ __name((a, b) => (a.ageDays ?? 1e9) - (b.ageDays ?? 1e9), "freshness")
  }[p.sort] ?? ((a, b) => (b.score ?? 0) - (a.score ?? 0));
  out.sort(cmp);
  return out;
}
__name(applyFilters, "applyFilters");
var cache = { data: null, at: 0, inflight: null };
async function getFeed(env) {
  const ttl = Number(env.CACHE_TTL_MS ?? 6e5);
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
__name(getFeed, "getFeed");
function json(obj, { status = 200, etag = null, request = null } = {}) {
  const body = JSON.stringify(obj, null, 2);
  const headers = { "Content-Type": "application/json", ...CORS };
  if (etag) {
    headers.ETag = etag;
    if (request?.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
  }
  return new Response(body, { status, headers });
}
__name(json, "json");
async function listings(request, env, id = null) {
  const feed = await getFeed(env);
  if (id !== null) {
    const decoded = decodeURIComponent(id);
    const b = (feed.bounties ?? []).find((x) => listingId(x) === decoded);
    if (!b) return json({ error: `listing not found: ${decoded}` }, { status: 404, request });
    return json({ data: { ...summarize(b), org: b.org, repo: b.repo, issue: b.issue }, meta: meta(feed) }, { request });
  }
  const p = Object.fromEntries(new URL(request.url).searchParams);
  const num = /* @__PURE__ */ __name((v) => v !== void 0 && v !== "" && Number.isFinite(Number(v)) ? Number(v) : void 0, "num");
  const items = applyFilters(feed.bounties ?? [], {
    min_score: num(p.min_score),
    min_amount: num(p.min_amount),
    max_age_days: num(p.max_age_days),
    source: p.source,
    type: p.type,
    escrow_only: p.escrow_only === "1" || p.escrow_only === "true",
    q: p.q,
    sort: p.sort
  });
  const limit = Math.min(num(p.limit) ?? 50, 100);
  return json(
    { data: items.slice(0, limit).map(summarize), meta: { ...meta(feed), total_matched: items.length, returned: Math.min(items.length, limit) } },
    { request, etag: `"l-${feed.generatedAt}-${p.sort ?? ""}-${JSON.stringify(p)}"` && `"l-${feed.generatedAt}"` }
  );
}
__name(listings, "listings");
function meta(feed) {
  return { generated_at: feed.generatedAt, cached: feed.cached };
}
__name(meta, "meta");
async function sources(env) {
  const feed = await getFeed(env);
  const bySource = {};
  for (const b of feed.bounties ?? []) bySource[b.source] = (bySource[b.source] ?? 0) + 1;
  return json({ data: { by_source: bySource, sweep_freshness: feed.generatedAt }, meta: meta(feed) }, {});
}
__name(sources, "sources");
async function stats(env) {
  const feed = await getFeed(env);
  const items = feed.bounties ?? [];
  const scores = items.map((b) => b.score ?? 0).sort((a, b) => a - b);
  return json({
    data: {
      live_listings: items.length,
      total_known_usd: items.reduce((s, b) => s + (b.amountUsd ?? 0), 0),
      median_score: scores.length ? scores[Math.floor(scores.length / 2)] : null,
      by_type: items.reduce((m, b) => {
        const t = inferType(b);
        m[t] = (m[t] ?? 0) + 1;
        return m;
      }, {})
    },
    meta: meta(feed)
  }, {});
}
__name(stats, "stats");
var OPENAPI = {
  openapi: "3.0.3",
  info: {
    title: "Bounty Radar API",
    version: "1.0.0",
    description: "Verified, machine-readable feed of payable open-source work. Stage 1: free, no auth."
  },
  servers: [{ url: "/" }],
  paths: {
    "/v1/listings": { get: {
      summary: "Search verified listings",
      parameters: [
        { name: "min_score", in: "query", schema: { type: "number" } },
        { name: "min_amount", in: "query", schema: { type: "number" } },
        { name: "max_age_days", in: "query", schema: { type: "number" } },
        { name: "source", in: "query", schema: { type: "string" }, description: "csv: algora,opire,github-label,algora-jobs,algora-challenge,algora-mention" },
        { name: "type", in: "query", schema: { type: "string" }, description: "csv: bounty,job,challenge,discussion" },
        { name: "escrow_only", in: "query", schema: { type: "boolean" } },
        { name: "q", in: "query", schema: { type: "string" } },
        { name: "sort", in: "query", schema: { type: "string", enum: ["score", "amount", "freshness"] } },
        { name: "limit", in: "query", schema: { type: "number", maximum: 100 } }
      ],
      responses: { "200": { description: "Listings + meta" }, "304": { description: "Not modified (send If-None-Match)" } }
    } },
    "/v1/listings/{id}": { get: {
      summary: "One listing",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: { "200": { description: "Listing" }, "404": { description: "Not found" } }
    } },
    "/v1/sources": { get: { summary: "Per-source counts + freshness", responses: { "200": { description: "OK" } } } },
    "/v1/stats": { get: { summary: "Market pulse", responses: { "200": { description: "OK" } } } }
  }
};
var src_default = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/v1/listings") return await listings(request, env);
      if (pathname.startsWith("/v1/listings/")) return await listings(request, env, pathname.slice("/v1/listings/".length));
      if (pathname === "/v1/sources") return await sources(env);
      if (pathname === "/v1/stats") return await stats(env);
      if (pathname === "/openapi.json") return json(OPENAPI, { request });
      if (pathname === "/") return json({
        name: "bounty-radar-api",
        version: "1.0.0",
        docs: "/openapi.json",
        endpoints: ["/v1/listings", "/v1/listings/{id}", "/v1/sources", "/v1/stats"]
      }, { request });
      return json({ error: "not found" }, { status: 404, request });
    } catch (e) {
      return json({ error: e.message }, { status: 502, request });
    }
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-jHPdLZ/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-jHPdLZ/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
