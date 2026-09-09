# Contributing

Thanks! This repo runs a public data pipeline; contributions should keep it boring, small, and dependency-free.

## Ground rules

- **Zero runtime npm dependencies.** Node stdlib only (`worker/` may use what its deploy needs).
- **Node 20+.** No build step, no TypeScript, no transpile.
- Smallest working diff. No scaffolding "for later".

## Good first contributions

- **New bounty sources** — add a `source:` block in `radar.mjs` following the existing pattern (fetch → normalize to `{title, url, org, repo, issue, amountUsd, escrow, source}` → the verifier/scorer handles the rest).
- **Verification heuristics** — spam filters, dead-repo signals, escrow detection. Each one should be a pure function with a comment naming its false-positive risk.
- **Agent tooling** — MCP tools, feed fields maintainers ask for.

## Before opening a PR

```bash
node --check <changed files>
node radar.mjs --json | tail -5     # pipeline still runs
npm run preflight                   # GO verdict expected
```

One PR per idea. Describe the *why* in one paragraph; the diff shows the how.

## Reporting bad data

Open an issue with the listing URL and what's wrong (dead repo? wrong amount? spam?). Screenshots of the source page help. Wrong data is the worst bug this project can have — reports get priority.
