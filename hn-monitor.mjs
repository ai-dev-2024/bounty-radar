#!/usr/bin/env node
/**
 * Show HN thread + GitHub PR monitor — one alert digest for both.
 *
 * HN: polls the item via the Algolia HN API, alerts on every new comment.
 * GitHub: polls all open PRs authored by GH_OWNER/GH_AUTHOR (default ai-dev-2024)
 * via the gh CLI, alerts on new review comments, issue comments (not by us/bots),
 * and review-state changes (approved/changes-requested).
 *
 * Usage:
 *   HN_ITEM_ID=12345 node hn-monitor.mjs            # poll once (HN only if no GH_* vars)
 *   HN_ITEM_ID=... node hn-monitor.mjs --loop       # poll every POLL_SECONDS (default 120)
 *   node hn-monitor.mjs --dry-run                   # print, don't send
 *   node hn-monitor.mjs --state path.json
 *
 * Env: HN_ITEM_ID, DISCORD_WEBHOOK_URL, TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (optional)
 *      GH_AUTHOR (default ai-dev-2024) — open PRs of this login are watched
 *
 * State file remembers seen comment ids → each item alerts exactly once.
 * First run seeds state silently (no backfill spam).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(`--${f}`);
const flagVal = (f) => { const i = args.indexOf(`--${f}`); return i !== -1 ? args[i + 1] : undefined; };

const ITEM_ID = process.env.HN_ITEM_ID ?? flagVal("item");
const GH_AUTHOR = process.env.GH_AUTHOR ?? "ai-dev-2024";
const STATE_PATH = flagVal("state") ?? "state/hn-monitor.json";
const DRY = hasFlag("dry-run");
const LOOP = hasFlag("loop");
const POLL_SECONDS = Number(flagVal("poll-seconds") ?? 120);

if (!ITEM_ID && !process.env.GH_TOKEN && !process.env.GITHUB_TOKEN && !hasFlag("github")) {
  console.error("[monitor] nothing to watch: set HN_ITEM_ID (HN thread) and/or GH_TOKEN (PRs)");
  process.exit(2);
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// --- state ------------------------------------------------------------------

let seen = { comments: [], lastPoints: 0 };
if (existsSync(STATE_PATH)) {
  try { seen = JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { /* fresh */ }
}

// --- HN API ------------------------------------------------------------------

async function getItem(id) {
  const res = await fetch(`https://hn.algolia.com/api/v1/items/${id}`, { headers: { "User-Agent": "bounty-radar-hn-monitor" } });
  if (!res.ok) throw new Error(`HN API ${res.status}`);
  return res.json();
}

function collectComments(node, out = []) {
  for (const c of node.children ?? []) {
    if (!c.deleted && c.author && c.text) out.push(c);
    collectComments(c, out);
  }
  return out;
}

// --- alerts -------------------------------------------------------------------

async function discord(content) {
  const res = await fetch(process.env.DISCORD_WEBHOOK_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "HN Monitor", content }),
  });
  if (!res.ok) throw new Error(`discord ${res.status}`);
}

async function telegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`telegram ${res.status}`);
}

// --- GitHub PRs (via gh CLI; uses the runner's/workstation's auth) -----------

const BOT_LOGINS = /^(github-actions|copilot-pull-request-reviewer|vercel|renovate|dependabot)/i;

async function pollGithub(seen) {
  const { stdout } = await execFileAsync("gh", [
    "search", "prs", `--author=${GH_AUTHOR}`, "--state=open", "--limit=30",
    "--json", "repository,number,title,url,updatedAt",
  ], { timeout: 30000 });
  const prs = JSON.parse(stdout);
  const alerts = [];
  const seenPrs = seen.github ?? {};

  for (const pr of prs) {
    const repo = pr.repository.nameWithOwner;
    const key = `${repo}#${pr.number}`;
    const prev = seenPrs[key] ?? { commentIds: [], reviewStates: {} };
    const prevIds = new Set(prev.commentIds);

    // issue + review comments in one pass each
    const [issueC, reviewC] = await Promise.all([
      execFileAsync("gh", ["api", `repos/${repo}/issues/${pr.number}/comments`, "--jq",
        `[.[] | {id: .id, by: .user.login, body: .body}] | tostring`], { timeout: 30000 }).then(r => JSON.parse(r.stdout)).catch(() => []),
      execFileAsync("gh", ["api", `repos/${repo}/pulls/${pr.number}/comments`, "--jq",
        `[.[] | {id: .id, by: .user.login, body: .body}] | tostring`], { timeout: 30000 }).then(r => JSON.parse(r.stdout)).catch(() => []),
    ]);
    const reviewSummaries = await execFileAsync("gh", ["api", `repos/${repo}/pulls/${pr.number}/reviews`, "--jq",
      `[.[] | select(.body != "" or .state == "APPROVED" or .state == "CHANGES_REQUESTED") | {id: .id, by: .user.login, state: .state, body: .body}] | tostring`],
      { timeout: 30000 }).then(r => JSON.parse(r.stdout)).catch(() => []);

    const all = [...issueC, ...reviewC].filter(c => !BOT_LOGINS.test(c.by) && c.by !== GH_AUTHOR);
    for (const c of all) {
      if (prevIds.has(String(c.id))) continue;
      alerts.push({ key, url: pr.url, by: c.by, text: (c.body ?? "").replace(/\s+/g, " ").slice(0, 300), kind: "comment" });
    }
    for (const r of reviewSummaries) {
      const state = r.state === "APPROVED" ? "✅ approved" : r.state === "CHANGES_REQUESTED" ? "🟡 changes requested" : null;
      if (!state) continue;
      const rprev = prev.reviewStates?.[r.id];
      if (rprev === r.state) continue;
      const snippet = (r.body ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 250);
      alerts.push({ key, url: pr.url, by: r.by, text: `${state}${snippet ? " — " + snippet : ""}`, kind: "review" });
    }

    seenPrs[key] = {
      commentIds: [...issueC, ...reviewC].map(c => String(c.id)),
      reviewStates: Object.fromEntries(reviewSummaries.map(r => [r.id, r.state])),
      title: pr.title,
    };
  }
  seen.github = seenPrs;
  return { alerts, prCount: prs.length };
}

// --- one poll -----------------------------------------------------------------

async function poll() {
  const digest = [];

  // --- HN part (only if an item id is set) ---
  if (ITEM_ID) {
    const item = await getItem(ITEM_ID);
    const comments = collectComments(item);
    const known = new Set(seen.comments);
    const fresh = comments.filter((c) => !known.has(c.id));
    const isFirst = seen.comments.length === 0 && seen.lastPoints === 0;
    const pts = item.points ?? 0;
    const ptsDelta = isFirst ? 0 : pts - (seen.lastPoints ?? pts);

    console.log(`[hn] ${item.title ?? "(item)"} — ${pts} pts (+${ptsDelta}), ${comments.length} comments, ${fresh.length} new`);

    if (!isFirst) {
      for (const c of fresh.slice(0, 10)) {
        const snippet = c.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
        digest.push(`**HN** · ${esc(c.author)} · <https://news.ycombinator.com/item?id=${c.id}>\n> ${esc(snippet)}`);
      }
      if (fresh.length === 0 && ptsDelta > 0) {
        digest.push(`**HN** · "${esc(item.title)}" hit **${pts} pts** (+${ptsDelta})`);
      }
    }
    seen.comments = comments.map((c) => c.id);
    seen.lastPoints = pts;
  }

  // --- GitHub PR part ---
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || hasFlag("github")) {
    try {
      const { alerts, prCount } = await pollGithub(seen);
      console.log(`[gh] ${prCount} open PRs watched, ${alerts.length} new event(s)`);
      for (const a of alerts.slice(0, 10)) {
        digest.push(`**GH** ${a.key} · ${esc(a.by)} · <${a.url}>\n> ${esc(a.text)}`);
      }
    } catch (e) {
      console.error("[gh] skipped:", e.message);
    }
  }

  if (digest.length) {
    const msg = `🔔 **Monitor digest** — ${digest.length} new event(s)\n\n${digest.join("\n\n")}`.slice(0, 3900);
    if (DRY) console.log("[monitor] dry-run would send:\n" + msg);
    else {
      if (process.env.DISCORD_WEBHOOK_URL) await discord(msg);
      if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) await telegram(msg.replace(/\*\*/g, "*"));
    }
  } else {
    console.log("[monitor] nothing new.");
  }

  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(seen), "utf8");
}

try {
  if (LOOP) {
    console.log(`[hn] watching item ${ITEM_ID} every ${POLL_SECONDS}s`);
    await poll();
    setInterval(() => poll().catch((e) => console.error("[hn]", e.message)), POLL_SECONDS * 1000);
  } else {
    await poll();
  }
} catch (e) {
  console.error("[hn] failed:", e.message);
  process.exit(1);
}
