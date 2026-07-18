#!/usr/bin/env node
/**
 * republish-photos.js — one-shot backfill
 *
 * Sends all posts in posts.db whose author matches the Photos group's
 * accounts filter to the Photos Telegram topic (thread 1842), and marks
 * them in matched_groups so the web explorer reflects membership.
 *
 * Skips posts that already carry the Photos group (already republished).
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const THREAD_ID = 1842;
const GROUP_ID = 'g_mr7vgtplnbve';
const DELAY_MS = 3200; // ~18 msgs/min, safely under Telegram's 20/min per-chat limit

// ─── Telegram config (same resolution order as watcher.js) ───────────────────
function parseEnv(filePath) {
  if (!existsSync(filePath)) return null;
  const env = {};
  for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) {
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      env[m[1]] = v;
    }
  }
  return env;
}
function loadTelegramConfig() {
  const local = parseEnv(join(ROOT, '.env.config'));
  if (local) return { botToken: local.TG_BOT_TOKEN || local.TELEGRAM_BOT_TOKEN, chatId: local.TELEGRAM_HOME_CHANNEL || local.TG_CHAT_ID };
  const hermes = parseEnv(join(homedir(), '.hermes', '.env'));
  if (hermes) return { botToken: hermes.TELEGRAM_BOT_TOKEN || hermes.TG_BOT_TOKEN, chatId: hermes.TELEGRAM_HOME_CHANNEL || hermes.TG_CHAT_ID };
  return { botToken: process.env.TG_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_HOME_CHANNEL || process.env.TG_CHAT_ID };
}

const tg = loadTelegramConfig();
if (!tg.botToken || !tg.chatId) { console.error('Telegram not configured'); process.exit(1); }

// ─── Load Photos group filter ────────────────────────────────────────────────
const groups = JSON.parse(readFileSync(join(ROOT, 'groups.json'), 'utf-8')).groups;
const photosGroup = groups.find(g => g.id === GROUP_ID);
if (!photosGroup) { console.error('Photos group not found'); process.exit(1); }
const accounts = (photosGroup.accounts || []).map(a => a.toLowerCase());
console.log(`Photos filter: ${accounts.length} accounts`);

// ─── DB ──────────────────────────────────────────────────────────────────────
const db = new DatabaseSync(join(ROOT, 'posts.db'));
const rows = db.prepare('SELECT shortcode, permalink, author, timestamp, is_reel, screenshot_path, matched_groups FROM posts').all();

const matching = rows.filter(r => {
  const author = (r.author || '').toLowerCase();
  if (!accounts.some(acct => author.includes(acct))) return false;
  let mg = [];
  try { mg = JSON.parse(r.matched_groups || '[]'); } catch {}
  return !mg.some(g => g.id === GROUP_ID); // skip already-tagged
});

console.log(`${matching.length} posts match and are not yet tagged Photos`);

// ─── Sender ──────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function send(post) {
  const caption =
    `🚨 <b>Photos</b>\n` +
    `👤 <b>@${post.author}</b>\n` +
    `📸 Post — <a href="${post.permalink}">Open</a>` +
    (post.timestamp ? `\n🕐 ${new Date(post.timestamp).toLocaleString()}` : '');

  const shotPath = post.screenshot_path;
  if (shotPath && existsSync(shotPath)) {
    const photo = new Blob([readFileSync(shotPath)], { type: 'image/jpeg' });
    const form = new FormData();
    form.append('chat_id', tg.chatId);
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    form.append('message_thread_id', String(THREAD_ID));
    form.append('photo', photo, 'post.jpg');
    const resp = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendPhoto`, { method: 'POST', body: form });
    const result = await resp.json();
    if (result.ok) return { ok: true };
    // rate limit -> wait and retry once
    if (result.error_code === 429) {
      const wait = (result.parameters?.retry_after || 5) * 1000;
      console.log(`  429 — waiting ${wait}ms`);
      await sleep(wait);
      const r2 = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendPhoto`, { method: 'POST', body: form });
      const res2 = await r2.json();
      if (res2.ok) return { ok: true };
      return { ok: false, err: res2.description };
    }
    return { ok: false, err: result.description };
  }
  // text fallback
  const resp = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: tg.chatId, text: caption, parse_mode: 'HTML', message_thread_id: THREAD_ID, disable_web_page_preview: false }),
  });
  const result = await resp.json();
  return result.ok ? { ok: true } : { ok: false, err: result.description };
}

// ─── Main loop ───────────────────────────────────────────────────────────────
const updateStmt = db.prepare('UPDATE posts SET matched_groups = ?, is_priority = 1 WHERE shortcode = ?');
let sent = 0, failed = 0;

for (const post of matching) {
  const r = await send(post);
  if (r.ok) {
    sent++;
    // mark in DB
    let mg = [];
    try { mg = JSON.parse(post.matched_groups || '[]'); } catch {}
    if (!mg.some(g => g.id === GROUP_ID)) {
      mg.push({ id: GROUP_ID, name: 'Photos', color: photosGroup.color, reasons: ['account @' + post.author] });
      updateStmt.run(JSON.stringify(mg), post.shortcode);
    }
    console.log(`[${sent + failed}/${matching.length}] ✓ ${post.shortcode} @${post.author}`);
  } else {
    failed++;
    console.log(`[${sent + failed}/${matching.length}] ✗ ${post.shortcode} @${post.author}: ${r.err}`);
  }
  await sleep(DELAY_MS);
}

console.log(`\nDone. sent=${sent} failed=${failed} total=${matching.length}`);
process.exit(failed > 0 ? 1 : 0);
