#!/usr/bin/env node
/**
 * Show HN thread monitor — polls the item via the Algolia HN API, alerts
 * (Discord) on every new comment so replies go out within minutes.
 *
 * Usage:
 *   HN_ITEM_ID=12345 node hn-monitor.mjs            # poll once
 *   HN_ITEM_ID=... node hn-monitor.mjs --loop       # poll every POLL_SECONDS (default 120)
 *   HN_ITEM_ID=... node hn-monitor.mjs --dry-run    # print, don't send
 *   HN_ITEM_ID=... node hn-monitor.mjs --state path.json
 *
 * Env: HN_ITEM_ID, DISCORD_WEBHOOK_URL, TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (optional)
 *
 * State file remembers seen comment ids → each comment alerts exactly once.
 * First run seeds state silently (no backfill spam).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(`--${f}`);
const flagVal = (f) => { const i = args.indexOf(`--${f}`); return i !== -1 ? args[i + 1] : undefined; };

const ITEM_ID = process.env.HN_ITEM_ID ?? flagVal("item");
const STATE_PATH = flagVal("state") ?? "state/hn-monitor.json";
const DRY = hasFlag("dry-run");
const LOOP = hasFlag("loop");
const POLL_SECONDS = Number(flagVal("poll-seconds") ?? 120);

if (!ITEM_ID) { console.error("[hn] HN_ITEM_ID required"); process.exit(2); }

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

// --- one poll -----------------------------------------------------------------

async function poll() {
  const item = await getItem(ITEM_ID);
  const comments = collectComments(item);
  const known = new Set(seen.comments);
  const fresh = comments.filter((c) => !known.has(c.id));

  // first run: seed, don't spam
  const isFirst = seen.comments.length === 0 && seen.lastPoints === 0;
  const toAlert = isFirst ? [] : fresh;

  const pts = item.points ?? 0;
  const ptsDelta = isFirst ? 0 : pts - (seen.lastPoints ?? pts);

  console.log(`[hn] ${item.title ?? "(item)"} — ${pts} pts (${ptsDelta >= 0 ? "+" : ""}${ptsDelta}), ${comments.length} comments, ${fresh.length} new`);

  const lines = [];
  for (const c of toAlert.slice(0, 10)) {
    const snippet = c.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
    lines.push(`**${esc(c.author)}** · <https://news.ycombinator.com/item?id=${c.id}>\n> ${esc(snippet)}`);
  }
  if (lines.length) {
    const msg = `🔴 **HN: ${fresh.length} new comment(s)** on "${esc(item.title)}" (${pts} pts)\n\n${lines.join("\n\n")}`.slice(0, 3900);
    if (DRY) console.log("[hn] dry-run would send:\n" + msg);
    else {
      if (process.env.DISCORD_WEBHOOK_URL) await discord(msg);
      if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) await telegram(msg.replace(/\*\*/g, "*"));
    }
  } else if (!isFirst && ptsDelta > 0) {
    if (!DRY && process.env.DISCORD_WEBHOOK_URL) await discord(`🔺 HN: "${esc(item.title)}" hit **${pts} pts** (+${ptsDelta})`);
  }

  seen.comments = comments.map((c) => c.id);
  seen.lastPoints = pts;
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
