# Bounty Radar

Daily sweep of **real, live, payable** open-source work — Algora bounties, **Algora jobs (full-time & contract)**, **challenges (large-prize competitions)**, Algora-mention discussions, Opire rewards, and GitHub bounty labels — with repo-liveness verification and spam filtering.

## Sources, highest income first

| Source | What it finds | Why it matters |
|---|---|---|
| `algora-jobs` | Full-time/contract roles on Algora org `/jobs` pages | Salaries, not bounties — best $/hour |
| `algora-challenge` | Large-prize competitions ($5k+) | One-shot big wins |
| `algora-mention` | Issues where @algora-io was summoned | Tips/contracts being discussed in active repos |
| `algora` | Escrow-backed bounties | Reliable payout when merged |
| `opire` | Opire rewards (via @opirebot comments) | Escrow-backed alternative platform |
| `github-label` | Project-native bounty labels | Verify escrow before investing time |

Jobs and challenges are ranked above bounties by design (scores 7–9) — they pay multiples of typical bounty amounts.

## Why the filters exist

During a live market scan (Sep 2026) we found that most "open bounties" on GitHub are:

- **Dead listings** — the repo was deleted, so the bounty is unpayable
- **Expired programs** — e.g. tscircuit quit bounties entirely while old listings stayed up
- **Escrow-less spam** — mass-generated "[Bounty: $450]" bait repos with zero money behind them

This radar applies the lessons learned:

| Check | Rule |
|---|---|
| Repo alive? | pushed within last 60 days, not archived |
| Bounty still open? | issue state re-checked live via API |
| Spam? | known fake-bounty repo patterns filtered |
| Competition | claim count + open competing PRs detected |
| Escrow | Algora/Opire listings flagged as escrow-backed; bare GitHub labels marked "verify escrow" |

## Usage

```bash
node radar.mjs                # human-readable digest to stdout
node radar.mjs --json         # machine-readable JSON
node radar.mjs --out today.md # write markdown digest to a file
node radar.mjs --max-age 14   # only bounties aged ≤ 14 days
```

Requires: Node 20+, `gh` CLI authenticated (`gh auth login`).

## Daily automation

Run it from cron / Task Scheduler, e.g. daily at 9am:

```
0 9 * * * cd /path/to/radar && node radar.mjs --out digest-$(date +\%F).md
```

On Windows, use Task Scheduler pointing at `node radar.mjs --out digest.md`, or `schtasks /create /tn "BountyRadar" /tr "node radar.mjs --out digest.md" /sc daily /st 09:00`.

## Interpreting the score (0–15)

- **Jobs = 7, challenges = 8–9** (fixed, by design)
- **Amount**: $1000+ = 4, $250+ = 3, $100+ = 2, $30+ = 1
- **Freshness**: ≤3d = 3, ≤14d = 2, ≤60d = 1
- **Low competition**: 0 claims = 2, ≤2 claims = 1; 0 open competing PRs = 2
- **Active repo**: pushed ≤7d ago = 1

For bounties, only invest time when **escrow is verified** and **open competing PRs is low** — those two factors predicted every real payout in our research. Jobs/challenges have no GitHub issue; verify and apply directly.
