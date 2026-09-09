#!/usr/bin/env node
/**
 * Alert notifier for Bounty Radar.
 * Fires a Discord and/or Telegram message the moment a NEW listing with
 * score >= threshold appears in the radar feed. Tracks what was already
 * announced in state/alerts.json so repeated runs don't spam.
 *
 * Usage:
 *   node notify.mjs feed.json                     # announce new 6+ listings
 *   node notify.mjs feed.json --threshold 8       # custom score threshold
 *   node notify.mjs feed.json --dry-run           # show what would fire, send nothing
 *   node notify.mjs feed.json --state state.json  # custom state file
 *
 * Env vars:
 *   DISCORD_WEBHOOK_URL   — Discord channel webhook (post message)
 *   TELEGRAM_BOT_TOKEN    — bot token from @BotFather
 *   TELEGRAM_CHAT_ID      — chat/channel id to message
 * At least one must be set (unless --dry-run).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const feedPath = args.find((a) => !a.startsWith("--")) ?? "feed.json";

function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}
const hasFlag = (name) => args.includes(`--${name}`);

const THRESHOLD = Number(flag("threshold") ?? 6);
const STATE_PATH = flag("state") ?? join(dirname(feedPath), "state", "alerts-state.json");
const DRY_RUN = hasFlag("dry-run");

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------------------------------------------------------------------------
// Load feed + state
// ---------------------------------------------------------------------------

const feed = JSON.parse(readFileSync(feedPath, "utf8"));
const bounties = feed.bounties ?? [];

let seen = {};
if (existsSync(STATE_PATH)) {
  try {
    seen = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    seen = {};
  }
}

const listingKey = (b) => (b.issue != null ? `${b.org}/${b.repo}#${b.issue}` : `${b.source}:${b.org}:${b.title}`);

const fresh = bounties.filter((b) => (b.score ?? 0) >= THRESHOLD && !seen[listingKey(b)]);

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

const SOURCE_LABEL = {
  "algora-jobs": "Algora Jobs",
  "algora-challenge": "Algora Challenge",
  "algora-mention": "Algora Thread",
  algora: "Algora Bounty",
  opire: "Opire",
  "github-label": "GitHub Bounty",
};

function listingLine(b) {
  const id = b.issue != null ? `${b.org}/${b.repo}#${b.issue}` : `${b.org}`;
  const money = b.amountUsd != null ? `$${b.amountUsd.toLocaleString("en-US")}` : "?";
  return `**${money}** · ★${b.score} · ${SOURCE_LABEL[b.source] ?? b.source}\n[${esc(b.title)}](${b.url})`;
}

function toDiscord(listings) {
  const embeds = listings.slice(0, 10).map((b) => ({
    title: `${b.amountUsd != null ? `$${b.amountUsd.toLocaleString("en-US")}` : "New"} · ${b.title}`.slice(0, 250),
    url: b.url,
    description:
      `${SOURCE_LABEL[b.source] ?? b.source} · score **${b.score}/15**\n` +
      (b.escrow ? `_${b.escrow}_\n` : ""),
    color: 0x3fb950,
  }));
  return {
    username: "Bounty Radar",
    content: `🚨 **${listings.length} new high-opportunity listing(s)** (score ≥ ${THRESHOLD})`,
    embeds,
  };
}

function toTelegram(listings) {
  const lines = listings.slice(0, 10).map((b) => listingLine(b));
  const header = `🚨 ${listings.length} new high-opportunity listing(s) (score ≥ ${THRESHOLD})\n\n`;
  let text = header + lines.join("\n\n");
  if (text.length > 4000) text = text.slice(0, 3950) + "\n…";
  return text;
}

// ---------------------------------------------------------------------------
// Senders
// ---------------------------------------------------------------------------

async function sendDiscord(payload) {
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Discord webhook ${res.status}: ${await res.text()}`);
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown", disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (fresh.length === 0) {
    console.log(`[notify] nothing new at or above score ${THRESHOLD}.`);
    return;
  }

  console.log(`[notify] ${fresh.length} new listing(s) at score >= ${THRESHOLD}:`);
  for (const b of fresh) console.log(`  - ★${b.score} ${(b.amountUsd != null ? `$${b.amountUsd}` : "")} ${b.title.slice(0, 70)}`);

  const targets = [];
  if (DISCORD_WEBHOOK_URL) targets.push("discord");
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) targets.push("telegram");

  if (DRY_RUN) {
    console.log(`[notify] dry-run: would send to [${targets.join(", ") || "nowhere — no env vars set"}]`);
    return;
  }

  if (targets.length === 0) {
    console.error("[notify] no DISCORD_WEBHOOK_URL or TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID set — cannot send.");
    process.exit(2);
  }

  if (targets.includes("discord")) await sendDiscord(toDiscord(fresh));
  if (targets.includes("telegram")) await sendTelegram(toTelegram(fresh));

  // Mark as announced only after successful send.
  for (const b of fresh) seen[listingKey(b)] = { at: new Date().toISOString(), score: b.score };
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(seen, null, 2), "utf8");
  console.log(`[notify] sent via ${targets.join(" + ")}; state updated: ${STATE_PATH}`);
}

main().catch((err) => {
  console.error("[notify] failed:", err.message);
  process.exit(1);
});
