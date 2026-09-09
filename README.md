# 🎯 Bounty Radar

**Live site: https://ai-dev-2024.github.io/bounty-radar/**

A daily-verified feed of real, payable open-source work — bounties, jobs, challenges — built for humans *and* coding agents. Dead repos, expired programs, and escrow-less spam farms are filtered out before they ever reach you.

[![sweep-and-publish](https://github.com/ai-dev-2024/bounty-radar/actions/workflows/sweep-and-publish.yml/badge.svg)](https://github.com/ai-dev-2024/bounty-radar/actions/workflows/sweep-and-publish.yml)
![sources](https://img.shields.io/badge/sources-Algora%20·%20Opire%20·%20GitHub-blue)

## What you get

| Surface | URL | For |
|---|---|---|
| Browse board | [/](https://ai-dev-2024.github.io/bounty-radar/) | humans — verified listings, escrow badges, filters, 60-second walkthrough |
| RSS | [/feed.xml](https://ai-dev-2024.github.io/bounty-radar/feed.xml) | subscribe, new listings push to you |
| JSON feed | [/bounties.json](https://ai-dev-2024.github.io/bounty-radar/bounties.json) | agents — poll it, act on it |
| MCP server | [`mcp-server.mjs`](mcp-server.mjs) | agents — native tools, no HTTP |

## How it works (zero servers)

```
every 6h (GitHub Actions cron, free):
  radar.mjs sweeps 6 sources ──► verifies (repo ≤60d pushed · issue open · not fork · spam-filtered)
                             ──► build-site.mjs writes HTML + RSS + JSON
                             ──► GitHub Pages deploys
                             ──► notify.mjs pings Discord/Telegram on new score-≥6 listings
```

No backend, no database, no hosting bill. GitHub Pages + Actions are the entire infrastructure.

**No, you don't need Cloudflare/Vercel/Fly.io.** This is a static site + cron — GitHub Pages serves it and GitHub Actions computes it, free, forever. You'd only add a host when there's a live API with keys/paywalls (see [docs/API_PLAN.md](docs/API_PLAN.md), Stage 1+).

## Use it from an agent

```json
{ "mcpServers": { "bounty-radar": {
    "command": "node",
    "args": ["/path/to/mcp-server.mjs"] } } }
```

Tools: `search_bounties` (`min_score`, `min_amount`, `escrow_only`, …) · `get_listing` · `whats_new` · `get_stats`.

Or skip MCP entirely: `fetch("https://ai-dev-2024.github.io/bounty-radar/bounties.json")`.

## Proof it works end-to-end

The pipeline picked its own bounty via the MCP server, fixed it, and opened the PR:
**[PHPOffice/PHPWord#2937](https://github.com/PHPOffice/PHPWord/pull/2937)** — discover → verify unclaimed → diagnose two-layer bug → patch + regression tests → CI green, mergeable.

## Alerts (optional, 2-min setup)

Repo → Settings → Secrets → Actions → add `DISCORD_WEBHOOK_URL` (and/or `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`). Done — you get pinged the moment a new 6+ listing appears, exactly once per listing (dedup state committed back).

## Local use

```bash
node radar.mjs                 # digest to stdout
node radar.mjs --json          # machine-readable
node notify.mjs feed.json --dry-run   # preview alerts
node mcp-server.mjs            # serve tools over stdio
```

Node 20+, `gh` authed. Zero npm dependencies.

## Files

| File | Role |
|---|---|
| `radar.mjs` | sweep + verify + score (0–15) |
| `build-site.mjs` | HTML/RSS/JSON generator |
| `mcp-server.mjs` | MCP tools over stdio |
| `notify.mjs` | Discord/Telegram alerts w/ dedup |
| `.github/workflows/sweep-and-publish.yml` | the whole pipeline on cron |
| `docs/API_PLAN.md` | product plan for the API stage |
