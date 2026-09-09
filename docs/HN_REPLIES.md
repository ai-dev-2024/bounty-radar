# HN Launch-Day Reply Templates

Keep replies short, factual, no marketing. Edit the bracketed bits, paste, done.
(Tone rule: one sentence of claim max, then evidence. HN rewards the second sentence more than the first.)

---

## Q1: "How is this different from Algora's own bounty page?"

> Algora only lists Algora — and its org pages keep showing bounties whose repos no longer exist, or programs that quietly ended (tscircuit, one of their biggest bounty orgs, told us "we don't do bounties anymore" while old listings stayed up). The radar cross-checks every listing against the live repo: pushed ≤60 days, not archived, not a fork, issue still open, and a blocklist of known AI-generated bait farms. On one sweep, 91 raw "bounties" reduced to 14 verified ones. It's the difference between a listing and a lead.

## Q2: "Why not just search GitHub for bounty labels?"

> We started there. Raw label search is exactly the problem: it surfaced a €2 "bounty", a spam repo farming `[Bounty: $850]` issues with zero escrow, and half a dozen repos deleted months ago. The verification layer (repo liveness, issue state, fork detection, spam patterns) is the product; the label search is just one input among six sources.

## Q3: "Does the agent thing actually work, or is it a demo?"

> End-to-end on a real repo: the agent queried the feed via the MCP server, picked PHPOffice/PHPWord#2672 after checking it was unclaimed (0 competing PRs), diagnosed a two-layer bug (style class dropped `size`/`color`, writer never emitted `w:sz`/`w:color`), patched it with regression tests, and opened https://github.com/PHPOffice/PHPWord/pull/2937 — 31/32 CI checks green, the one failure was a phpdoc type-order nit their fixer caught, fixed same day. Merged value: $0 (that issue had no bounty attached) — the point was proving the loop, and the honest answer is the loop works but funded, unclaimed bounties are rare right now.

## Likely follow-ups

**"So how do you make money?"**
> The feed and API are free; there's a paid tier for agents that need high-rate polling, diff endpoints and webhooks ($15/mo). Nothing paywalled today — Stage 2 keys exist but the free anonymous limit (100 req/day) covers any human poking at it.

**"Isn't this just a scraper against Algora's ToS?"**
> It reads public pages at a human-ish cadence (one sweep per org per 6h) and republishes factual metadata with attribution, same as every job board that indexes company career pages. If Algora ships an official API, we'd happily become a client of it — our value is the verification layer, not the scraping.

**"The market is dry — 14 listings? Why launch?"**
> Yes, and the site says so on the board — I think the drought itself is worth documenting (the /v1/stats endpoint and past digests track it). The radar's job is to make the next real bounty visible within minutes of it being posted, and the only cost of running it is a free GitHub Action.

**"Why should repo maintainers care?"**
> If you label issues with bounties, agents are increasingly your applicants — but they triage from structured data. The README ask stands: tell us what metadata you'd want in the feed (claimed-by, ETA, required skill) and we'll add it.
