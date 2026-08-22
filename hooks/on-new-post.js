#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// IG Feed Watcher — Custom Hook Script (Node.js version)
//
// This is the cross-platform equivalent of on-new-post.sh. It is used
// automatically on Windows (where bash is not available), and can be used on
// any platform by setting HOOK_SCRIPT=./hooks/on-new-post.js in .env.config.
//
// Called every time a NEW post appears on your Instagram feed.
// Post data is piped in as JSON on stdin.
//
// JSON structure:
// {
//   "shortcode": "C1b2dEf",
//   "permalink": "https://www.instagram.com/p/C1b2dEf/",
//   "author": "username",
//   "timestamp": "2026-06-29T12:00:00.000Z",
//   "caption": "post caption text...",
//   "imageUrls": ["https://..."],
//   "isReel": false,
//   "scrapedAt": "2026-06-29T12:05:00.000Z",
//   "priority": true,
//   "priorityReasons": ["account @mda_sc"],
//   "comments": [{"author": "user1", "text": "nice!", "timestamp": "...", "likeCount": 3}]
// }
//
// Priority posts are from accounts or containing keywords/hashtags
// defined in priority-list.json.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ROOT = the ig-feed-watcher directory (parent of hooks/)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Read post JSON from stdin
let post;
try {
  post = JSON.parse(readFileSync(0, 'utf-8'));
} catch (err) {
  console.error(`Hook error: could not read post JSON from stdin: ${err.message}`);
  process.exit(1);
}

const {
  shortcode = '',
  permalink = '',
  author = '',
  caption = '',
  isReel = false,
  priority = false,
  priorityReasons = [],
} = post;

const LOG_FILE = join(ROOT, 'logs', 'posts.log');
const PRIORITY_LOG_FILE = join(ROOT, 'logs', 'priority-posts.jsonl');

function appendLog(file, line) {
  try {
    if (!existsSync(file)) mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, line + '\n', 'utf-8');
  } catch (err) {
    console.error(`Hook warning: could not write ${file}: ${err.message}`);
  }
}

const stamp = new Date().toISOString();

// ─── Logging ──────────────────────────────────────────────────────────────────

if (priority) {
  appendLog(LOG_FILE, `[${stamp}] ⭐ PRIORITY: @${author} posted ${shortcode} (matched: ${priorityReasons.join(', ')})`);
  // Save priority posts to a separate file for analysis
  appendLog(PRIORITY_LOG_FILE, JSON.stringify(post));
  console.log(`⭐ Priority hook: @${author} posted ${shortcode} (matched: ${priorityReasons.join(', ')})`);
} else {
  appendLog(LOG_FILE, `[${stamp}] @${author} posted ${shortcode}`);
  console.log(`Hook received: @${author} posted ${shortcode}`);
}

console.log(`  URL: ${permalink}`);
console.log(`  Reel: ${isReel}`);
if (caption) {
  console.log(`  Caption: ${caption.slice(0, 120)}...`);
}

// ─── PRIORITY POST CUSTOM LOGIC ───────────────────────────────────────────────
// Add special handling for priority posts here (e.g. download images, call a
// webhook, send to another API). `post` holds the full JSON.

if (priority) {
  // Example: save priority post images to a dedicated folder
  // const { mkdirSync } = await import('fs');
  // const { post: fetch } = await import('undici'); // or global fetch (Node 18+)
  // if (post.imageUrls && post.imageUrls[0]) {
  //   const dir = join(ROOT, 'screenshots', 'priority');
  //   mkdirSync(dir, { recursive: true });
  //   const res = await fetch(post.imageUrls[0]);
  //   const buf = Buffer.from(await res.arrayBuffer());
  //   writeFileSync(join(dir, `${shortcode}.jpg`), buf);
  // }
}

// ─── GENERAL CUSTOM LOGIC ─────────────────────────────────────────────────────
// Runs for ALL posts (priority and normal)

// Example: save all post data to a JSONL log file
// appendLog(join(ROOT, 'logs', 'posts.jsonl'), JSON.stringify(post));

console.log(`Hook completed for ${shortcode}`);
