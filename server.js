#!/usr/bin/env node
/**
 * IG Feed Watcher — Web Explorer
 *
 * Express server that provides a web UI to browse and filter
 * the posts stored in posts.db
 *
 * Features:
 *  - Feed grid view with post cards (screenshot + metadata)
 *  - Filter by group, author, date range, reel vs photo
 *  - Search captions
 *  - Author statistics
 *  - Post detail modal
 *  - Live stats dashboard
 */

import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import {
  listSources,
  getSource,
  upsertSource,
  deleteSource,
  setSourceCookies,
  sourceToPublic,
  listIngesterTypes,
} from './sources.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DB_PATH = join(ROOT, 'posts.db');
const SCREENSHOTS_DIR = join(ROOT, 'screenshots');
const PORT = process.env.PORT || 4180;

// Parse a simple .env-style file into a dict (KEY=VALUE lines, # comments).
function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) {
      let val = match[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[match[1]] = val;
    }
  }
  return env;
}

// Resolve a config value: process env first, then the local .env.config file.
// Returns undefined when the key is absent (or empty).
function readEnvValue(key) {
  if (process.env[key] !== undefined && process.env[key] !== '') return process.env[key];
  const local = parseEnvFile(join(ROOT, '.env.config'));
  if (local && local[key] !== undefined && local[key] !== '') return local[key];
  return undefined;
}

// Multi-account capability. When MULTI_ACCOUNTS=1 is set in .env.config (or
// the environment) the API allows connecting more than one Instagram account
// (POST /api/sources). The web UI is single-account only for now — the
// multi-account UI ships in a future release — but the backend capability must
// stay fully functional for API/CLI use.
const MULTI_ACCOUNTS = readEnvValue('MULTI_ACCOUNTS') === '1';

// ─── Database ─────────────────────────────────────────────────────────────────

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    shortcode     TEXT PRIMARY KEY,
    permalink     TEXT,
    author        TEXT,
    caption       TEXT,
    timestamp     TEXT,
    is_reel       INTEGER DEFAULT 0,
    is_priority   INTEGER DEFAULT 0,
    priority_reasons TEXT,
    image_urls    TEXT,
    screenshot_path TEXT,
    scraped_at    TEXT,
    seen_at       TEXT DEFAULT (datetime('now')),
    matched_groups TEXT DEFAULT '[]',
    source_id     TEXT DEFAULT '',
    source_name   TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author);
  CREATE INDEX IF NOT EXISTS idx_posts_priority ON posts(is_priority);
  CREATE INDEX IF NOT EXISTS idx_posts_timestamp ON posts(timestamp);
  CREATE TABLE IF NOT EXISTS comments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    shortcode     TEXT NOT NULL,
    author        TEXT,
    text          TEXT,
    timestamp     TEXT,
    like_count    INTEGER DEFAULT 0,
    scraped_at    TEXT DEFAULT (datetime('now')),
    UNIQUE(shortcode, author, text)
  );
  CREATE INDEX IF NOT EXISTS idx_comments_shortcode ON comments(shortcode);
  CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author);
`);
// Migrations: add columns introduced after the initial schema to pre-existing
// databases. Each is best-effort (throws if the column already exists).
try { db.exec("ALTER TABLE posts ADD COLUMN matched_groups TEXT DEFAULT '[]'"); } catch {}
try { db.exec("ALTER TABLE posts ADD COLUMN source_id TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE posts ADD COLUMN source_name TEXT DEFAULT ''"); } catch {}
// This index depends on source_id, so it must run after the ALTER migrations.
try { db.exec("CREATE INDEX IF NOT EXISTS idx_posts_source ON posts(source_id)"); } catch {}

// ─── Fuzzy Match ─────────────────────────────────────────────────────────────

function normalize(str) {
  return (str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[b.length][a.length];
}

function fuzzyMatch(text, pattern) {
  if (!pattern) return 1;
  if (!text) return 0;
  const normText = normalize(text);
  const searchWords = normalize(pattern).split(/\s+/).filter(w => w);
  if (searchWords.length === 0) return 1;

  const textWords = normText.split(/[^a-z0-9]+/).filter(w => w);

  for (const sw of searchWords) {
    if (normText.includes(sw)) continue;
    if (textWords.some(tw => tw.startsWith(sw))) continue;
    const maxDist = sw.length <= 3 ? 1 : 2;
    if (textWords.some(tw => levenshtein(tw.slice(0, sw.length + maxDist), sw) <= maxDist)) continue;
    return 0;
  }
  return 1;
}

db.function('fuzzy_match', { deterministic: true }, fuzzyMatch);

// ─── Groups Store ─────────────────────────────────────────────────────────────

const GROUPS_FILE = join(ROOT, 'groups.json');
const LEGACY_PRIORITY_FILE = join(ROOT, 'priority-list.json');

function loadGroups() {
  if (existsSync(GROUPS_FILE)) {
    try {
      const data = JSON.parse(readFileSync(GROUPS_FILE, 'utf-8'));
      return Array.isArray(data.groups) ? data.groups : [];
    } catch { return []; }
  }
  // Migrate legacy priority-list.json into a first group
  if (existsSync(LEGACY_PRIORITY_FILE)) {
    try {
      const legacy = JSON.parse(readFileSync(LEGACY_PRIORITY_FILE, 'utf-8'));
      const group = {
        id: 'g_' + Date.now().toString(36),
        name: 'Priority',
        color: '#f59e0b',
        accounts: legacy.priorityAccounts || [],
        keywords: legacy.priorityKeywords || [],
        hashtags: legacy.priorityHashtags || [],
      };
      saveGroups([group]);
      return [group];
    } catch { return []; }
  }
  return [];
}

function saveGroups(groups) {
  writeFileSync(GROUPS_FILE, JSON.stringify({ groups }, null, 2));
}

function sanitizeList(arr) {
  return Array.isArray(arr) ? arr.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : [];
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

function loadTelegramConfig() {
  function parseEnv(filePath) {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, 'utf-8');
    const env = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (match) {
        let val = match[2];
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        env[match[1]] = val;
      }
    }
    return env;
  }

  const localEnv = parseEnv(join(ROOT, '.env.config'));
  if (localEnv) {
    return {
      botToken: localEnv.TG_BOT_TOKEN || localEnv.TELEGRAM_BOT_TOKEN,
      chatId: localEnv.TELEGRAM_HOME_CHANNEL || localEnv.TG_CHAT_ID,
    };
  }

  const envPath = join(homedir(), '.hermes', '.env');
  const hermesEnv = parseEnv(envPath);
  if (hermesEnv) {
    return {
      botToken: hermesEnv.TELEGRAM_BOT_TOKEN || hermesEnv.TG_BOT_TOKEN,
      chatId: hermesEnv.TELEGRAM_HOME_CHANNEL || hermesEnv.TG_CHAT_ID,
    };
  }

  return {
    botToken: process.env.TG_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_HOME_CHANNEL || process.env.TG_CHAT_ID,
  };
}

// Write/update a KEY=VALUE entry in the local .env.config file, preserving
// comments and unrelated keys. Used by the Telegram settings UI. Empty values
// are kept as-is (the caller decides whether to omit the key).
function writeEnvValue(key, value) {
  const file = join(ROOT, '.env.config');
  let lines = [];
  if (existsSync(file)) lines = readFileSync(file, 'utf-8').split(/\r?\n/);
  const out = [];
  let replaced = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && m[1] === key) {
      out.push(`${key}=${value}`);
      replaced = true;
    } else {
      out.push(line);
    }
  }
  if (!replaced) out.push(`${key}=${value}`);
  writeFileSync(file, out.join('\n'), 'utf-8');
}

// Map a hex color to the closest Telegram topic icon color
const TG_ICON_COLORS = [
  0x6FB9F0, 0xFFD67E, 0xFF93B2, 0xFB6F5F, 0xE46F6F, 0xF0B6F6, 0x7FB9E0, 0xA6E22D
];
function hexToTgIconColor(hex) {
  if (!hex || !hex.match(/^#[0-9a-fA-F]{6}$/)) return 0x6FB9F0;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  let best = TG_ICON_COLORS[0];
  let bestDist = Infinity;
  for (const c of TG_ICON_COLORS) {
    const cr = (c >> 16) & 0xFF, cg = (c >> 8) & 0xFF, cb = c & 0xFF;
    const dist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (dist < bestDist) { bestDist = dist; best = c; }
  }
  return best;
}

async function createTelegramTopic(name, colorHex) {
  const tg = loadTelegramConfig();
  if (!tg.botToken || !tg.chatId) {
    console.log('Telegram not configured — skipping topic creation for group "' + name + '"');
    return null;
  }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${tg.botToken}/createForumTopic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: tg.chatId,
        name: name.slice(0, 128),
        icon_color: hexToTgIconColor(colorHex),
      }),
    });
    const result = await resp.json();
    if (result.ok && result.result && result.result.message_thread_id) {
      console.log(`Telegram topic created for group "${name}": thread_id=${result.result.message_thread_id}`);
      return result.result.message_thread_id;
    }
    console.log(`Telegram topic creation failed: ${result.description || 'unknown error'}`);
    return null;
  } catch (err) {
    console.log(`Telegram topic creation error: ${err.message}`);
    return null;
  }
}

// ─── Post serialization (the data contract) ───────────────────────────────────

function safeJsonArray(value) {
  try { const v = JSON.parse(value || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

// Normalize a raw `posts` row into the public Post shape. This is the single
// source of truth for how a post is represented on the wire (see api/openapi.json).
function decoratePost(row, commentCountStmt) {
  return {
    ...row,
    priority_reasons: safeJsonArray(row.priority_reasons),
    image_urls: safeJsonArray(row.image_urls),
    matched_groups: safeJsonArray(row.matched_groups),
    screenshot_url: row.screenshot_path
      ? `/screenshots/${basename(row.screenshot_path)}`
      : null,
    comment_count: commentCountStmt ? commentCountStmt.get(row.shortcode).count : 0,
    source_id: row.source_id || '',
    source_name: row.source_name || '',
  };
}

// Resolve a post's screenshot to an absolute path on disk (or null).
function resolveScreenshotPath(row) {
  if (!row || !row.screenshot_path) return null;
  for (const c of [row.screenshot_path, join(SCREENSHOTS_DIR, basename(row.screenshot_path))]) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

function imageContentType(filePath) {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/jpeg';
}

// Query the posts table with the shared filter set and return
// { posts, total, limit, offset }. Used by /api/posts, /api/feeds,
// /api/groups/:id/feeds, and /api/export so they all share one contract.
function queryPosts(query, opts = {}) {
  const {
    priority, author, search, reel, group, source,
    date_from, date_to,
    sort = 'seen_at', order = 'DESC',
    limit = 50, offset = 0,
  } = query;

  let sql = 'SELECT * FROM posts WHERE 1=1';
  const params = {};

  if (priority === '1') { sql += ' AND is_priority = 1'; }
  if (group) { sql += ' AND matched_groups LIKE @group'; params.group = `%"id":"${group}"%`; }
  if (source) { sql += ' AND source_id = @source'; params.source = source; }
  if (author) { sql += ' AND fuzzy_match(author, @author) = 1'; params.author = author; }
  if (search) { sql += ' AND fuzzy_match(caption, @search) = 1'; params.search = search; }
  if (reel === '1') { sql += ' AND is_reel = 1'; }
  if (reel === '0') { sql += ' AND is_reel = 0'; }
  if (date_from) { sql += ' AND timestamp >= @date_from'; params.date_from = date_from; }
  if (date_to) { sql += ' AND timestamp <= @date_to'; params.date_to = date_to; }

  const validSorts = ['seen_at', 'timestamp', 'author', 'shortcode', 'is_priority'];
  const sortCol = validSorts.includes(sort) ? sort : 'seen_at';
  const sortDir = String(order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  sql += ` ORDER BY ${sortCol} ${sortDir}`;

  const maxLimit = opts.maxLimit || 500;
  const numLimit = Math.min(parseInt(limit) || 50, maxLimit);
  const numOffset = Math.max(parseInt(offset) || 0, 0);
  sql += ` LIMIT ${numLimit} OFFSET ${numOffset}`;

  const rows = db.prepare(sql).all(params);
  const countStmt = db.prepare(sql.replace(/SELECT \* FROM/, 'SELECT COUNT(*) as count FROM').split(' ORDER BY')[0]);
  const total = countStmt.get(params).count;

  const commentCountStmt = db.prepare('SELECT COUNT(*) as count FROM comments WHERE shortcode = ?');
  const posts = rows.map(row => decoratePost(row, commentCountStmt));

  return { posts, total, limit: numLimit, offset: numOffset };
}

// ─── Express App ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use('/screenshots', express.static(SCREENSHOTS_DIR));

// ─── API Routes ───────────────────────────────────────────────────────────────

// Stats endpoint
app.get('/api/stats', (req, res) => {
  try {
    const total = db.prepare('SELECT COUNT(*) as count FROM posts').get().count;
    const priority = db.prepare('SELECT COUNT(*) as count FROM posts WHERE is_priority = 1').get().count;
    const reels = db.prepare('SELECT COUNT(*) as count FROM posts WHERE is_reel = 1').get().count;
    const withCaption = db.prepare("SELECT COUNT(*) as count FROM posts WHERE caption != ''").get().count;
    const withScreenshot = db.prepare('SELECT COUNT(*) as count FROM posts WHERE screenshot_path IS NOT NULL').get().count;
    const authors = db.prepare('SELECT COUNT(DISTINCT author) as count FROM posts').get().count;
    const last24h = db.prepare("SELECT COUNT(*) as count FROM posts WHERE seen_at > datetime('now', '-1 day')").get().count;
    const last7d = db.prepare("SELECT COUNT(*) as count FROM posts WHERE seen_at > datetime('now', '-7 days')").get().count;
    const totalComments = db.prepare('SELECT COUNT(*) as count FROM comments').get().count;
    const postsWithComments = db.prepare('SELECT COUNT(DISTINCT shortcode) as count FROM comments').get().count;

    // Top authors
    const topAuthors = db.prepare(`
      SELECT author, COUNT(*) as count, SUM(is_priority) as priority_count
      FROM posts GROUP BY author ORDER BY count DESC LIMIT 15
    `).all();

    // Posts over time (by day)
    const postsByDay = db.prepare(`
      SELECT DATE(seen_at) as date, COUNT(*) as count, SUM(is_priority) as priority_count
      FROM posts GROUP BY DATE(seen_at) ORDER BY date DESC LIMIT 30
    `).all();

    const groups = loadGroups().map(g => ({
      ...g,
      post_count: db.prepare('SELECT COUNT(*) as count FROM posts WHERE matched_groups LIKE ?')
        .get(`%"id":"${g.id}"%`).count,
    }));

    res.json({
      total, priority, reels, withCaption, withScreenshot, authors,
      last24h, last7d, topAuthors, postsByDay,
      totalComments, postsWithComments,
      groups,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Posts listing with filters (backward-compatible alias of /api/feeds)
app.get('/api/posts', (req, res) => {
  try {
    res.json(queryPosts(req.query));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Authors list
app.get('/api/authors', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT author,
             COUNT(*) as post_count,
             SUM(is_priority) as priority_count,
             SUM(is_reel) as reel_count,
             MAX(seen_at) as last_seen
      FROM posts
      GROUP BY author
      ORDER BY post_count DESC
    `).all();
    res.json({ authors: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single post detail (includes comments + image reference)
app.get('/api/posts/:shortcode', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM posts WHERE shortcode = ?').get(req.params.shortcode);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const comments = db.prepare(
      'SELECT author, text, timestamp, like_count, scraped_at FROM comments WHERE shortcode = ? ORDER BY like_count DESC, timestamp ASC'
    ).all(req.params.shortcode);
    const imagePath = resolveScreenshotPath(row);
    res.json({
      ...decoratePost(row, null),
      image: imagePath
        ? { url: `/api/posts/${row.shortcode}/image`, filename: basename(imagePath), contentType: imageContentType(imagePath) }
        : null,
      comments,
      comment_count: comments.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Raw image bytes for a post (the "individual post with the image" contract)
app.get('/api/posts/:shortcode/image', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM posts WHERE shortcode = ?').get(req.params.shortcode);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const imagePath = resolveScreenshotPath(row);
    if (!imagePath) return res.status(404).json({ error: 'No image available for this post' });
    res.setHeader('Content-Type', imageContentType(imagePath));
    res.setHeader('Content-Disposition', `inline; filename="${basename(imagePath)}"`);
    res.send(readFileSync(imagePath));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Comments for a post
app.get('/api/posts/:shortcode/comments', (req, res) => {
  try {
    const comments = db.prepare(
      'SELECT * FROM comments WHERE shortcode = ? ORDER BY like_count DESC, timestamp ASC'
    ).all(req.params.shortcode);
    res.json({ shortcode: req.params.shortcode, comments, total: comments.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search/browse all comments
app.get('/api/comments', (req, res) => {
  try {
    const { author, search, shortcode, limit = 100, offset = 0 } = req.query;
    let sql = 'SELECT * FROM comments WHERE 1=1';
    const params = [];
    if (author) { sql += ' AND author LIKE ?'; params.push(`%${author}%`); }
    if (search) { sql += ' AND text LIKE ?'; params.push(`%${search}%`); }
    if (shortcode) { sql += ' AND shortcode = ?'; params.push(shortcode); }
    sql += ' ORDER BY scraped_at DESC';
    const numLimit = Math.min(parseInt(limit) || 100, 500);
    const numOffset = parseInt(offset) || 0;
    sql += ` LIMIT ${numLimit} OFFSET ${numOffset}`;
    const comments = db.prepare(sql).all(...params);
    res.json({ comments, limit: numLimit, offset: numOffset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually add/remove a post to/from a group
app.post('/api/posts/:shortcode/groups', (req, res) => {
  try {
    const { group_id, member } = req.body; // member: true = add, false = remove
    const row = db.prepare('SELECT * FROM posts WHERE shortcode = ?').get(req.params.shortcode);
    if (!row) return res.status(404).json({ error: 'Post not found' });

    const groups = loadGroups();
    const group = groups.find(g => g.id === group_id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    let matched = [];
    try { matched = JSON.parse(row.matched_groups || '[]'); } catch {}

    if (member) {
      if (!matched.some(m => m.id === group_id)) {
        matched.push({ id: group.id, name: group.name, color: group.color || null, reasons: ['manual'] });
      }
    } else {
      matched = matched.filter(m => m.id !== group_id);
    }

    db.prepare('UPDATE posts SET matched_groups = ?, is_priority = ? WHERE shortcode = ?')
      .run(JSON.stringify(matched), matched.length > 0 ? 1 : 0, req.params.shortcode);

    res.json({ ok: true, shortcode: req.params.shortcode, matched_groups: matched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Groups API ───────────────────────────────────────────────────────────────

// List all groups (with post counts)
app.get('/api/groups', (req, res) => {
  try {
    const groups = loadGroups().map(g => ({
      ...g,
      post_count: db.prepare('SELECT COUNT(*) as count FROM posts WHERE matched_groups LIKE ?')
        .get(`%"id":"${g.id}"%`).count,
    }));
    res.json({ groups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get a single group with its post count
app.get('/api/groups/:id', (req, res) => {
  try {
    const group = loadGroups().find(g => g.id === req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    res.json({
      ...group,
      post_count: db.prepare('SELECT COUNT(*) as count FROM posts WHERE matched_groups LIKE ?')
        .get(`%"id":"${group.id}"%`).count,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a group
app.post('/api/groups', async (req, res) => {
  try {
    const { name, color, accounts, keywords, hashtags } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Group name is required' });
    }
    const groups = loadGroups();
    if (groups.some(g => g.name.toLowerCase() === name.trim().toLowerCase())) {
      return res.status(400).json({ error: 'A group with this name already exists' });
    }
    const groupColor = (typeof color === 'string' && color.match(/^#[0-9a-fA-F]{6}$/)) ? color : '#6366f1';
    const group = {
      id: 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: name.trim(),
      color: groupColor,
      accounts: sanitizeList(accounts),
      keywords: sanitizeList(keywords),
      hashtags: sanitizeList(hashtags),
    };

    // Create Telegram forum topic for this group
    const threadId = await createTelegramTopic(group.name, groupColor);
    if (threadId) {
      group.telegramThreadId = threadId;
    }

    groups.push(group);
    saveGroups(groups);
    res.json({ ok: true, group });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a group (rename, recolor, replace lists)
app.put('/api/groups/:id', (req, res) => {
  try {
    const groups = loadGroups();
    const group = groups.find(g => g.id === req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const { name, color, accounts, keywords, hashtags } = req.body;
    if (name && typeof name === 'string' && name.trim()) group.name = name.trim();
    if (typeof color === 'string' && color.match(/^#[0-9a-fA-F]{6}$/)) group.color = color;
    if (accounts !== undefined) group.accounts = sanitizeList(accounts);
    if (keywords !== undefined) group.keywords = sanitizeList(keywords);
    if (hashtags !== undefined) group.hashtags = sanitizeList(hashtags);

    saveGroups(groups);
    res.json({ ok: true, group });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a group
app.delete('/api/groups/:id', (req, res) => {
  try {
    let groups = loadGroups();
    if (!groups.some(g => g.id === req.params.id)) {
      return res.status(404).json({ error: 'Group not found' });
    }
    groups = groups.filter(g => g.id !== req.params.id);
    saveGroups(groups);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a single item (account/keyword/hashtag) to a group
app.post('/api/groups/:id/add', (req, res) => {
  try {
    const { type, value } = req.body; // type: 'account' | 'keyword' | 'hashtag'
    const groups = loadGroups();
    const group = groups.find(g => g.id === req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const field = type === 'account' ? 'accounts' : type === 'keyword' ? 'keywords' : 'hashtags';
    const v = (value || '').trim();
    if (!v) return res.status(400).json({ error: 'Value is required' });
    if (!group[field]) group[field] = [];
    if (!group[field].includes(v)) group[field].push(v);

    saveGroups(groups);
    res.json({ ok: true, group });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove a single item from a group
app.post('/api/groups/:id/remove', (req, res) => {
  try {
    const { type, value } = req.body;
    const groups = loadGroups();
    const group = groups.find(g => g.id === req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const field = type === 'account' ? 'accounts' : type === 'keyword' ? 'keywords' : 'hashtags';
    group[field] = (group[field] || []).filter(item => item !== value);

    saveGroups(groups);
    res.json({ ok: true, group });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Sources API ──────────────────────────────────────────────────────────────

app.get('/api/sources', (req, res) => {
  try {
    const sources = listSources();
    res.json({ sources: sources.map(sourceToPublic), ingesterTypes: listIngesterTypes() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/sources', (req, res) => {
  try {
    const { id, name, type, enabled, cookies } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Source name is required' });
    }
    // Single-account mode (MULTI_ACCOUNTS not set to 1): only one source may
    // exist. The API gate stays functional; the web UI is single-account only.
    if (!MULTI_ACCOUNTS && listSources().length > 0) {
      return res.status(403).json({ error: 'Only one account can be connected in this version.' });
    }
    const source = upsertSource({ id, name: name.trim(), type, enabled, cookies });
    res.json({ ok: true, source: sourceToPublic(source) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/sources/:id', (req, res) => {
  try {
    const existing = getSource(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Source not found' });
    const { name, type, enabled, cookies } = req.body || {};
    const patch = { id: req.params.id };
    if (name !== undefined) patch.name = name;
    if (type !== undefined) patch.type = type;
    if (enabled !== undefined) patch.enabled = enabled;
    if (cookies !== undefined) patch.cookies = cookies;
    const source = upsertSource(patch);
    res.json({ ok: true, source: sourceToPublic(source) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Insert/replace cookie values for a source (the settings-page flow)
app.put('/api/sources/:id/cookies', (req, res) => {
  try {
    const { cookies } = req.body || {};
    if (!Array.isArray(cookies)) return res.status(400).json({ error: '"cookies" must be an array' });
    const source = setSourceCookies(req.params.id, cookies);
    if (!source) return res.status(404).json({ error: 'Source not found' });
    res.json({ ok: true, source: sourceToPublic(source) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/sources/:id', (req, res) => {
  try {
    if (!deleteSource(req.params.id)) return res.status(404).json({ error: 'Source not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Telegram settings API ─────────────────────────────────────────────────────
// The watcher reads TG_BOT_TOKEN / TELEGRAM_HOME_CHANNEL from .env.config on
// every message, so saving here takes effect without a restart.

// Template placeholders (from .env.example) count as "not configured".
const TG_PLACEHOLDERS = new Set(['YOUR_BOT_TOKEN_HERE', 'YOUR_CHANNEL_ID_HERE', 'REPLACE_ME']);
function tgValueSet(v) {
  return !!(v && v.trim() && !TG_PLACEHOLDERS.has(v.trim()));
}

app.get('/api/settings/telegram', (req, res) => {
  try {
    const tg = loadTelegramConfig();
    // Never return the full bot token to the browser — only whether it is set.
    const chatId = tgValueSet(tg.chatId) ? tg.chatId.trim() : '';
    res.json({ botTokenSet: tgValueSet(tg.botToken), chatId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/settings/telegram', (req, res) => {
  try {
    const { botToken, chatId } = req.body || {};
    if (botToken !== undefined && typeof botToken === 'string' && botToken.trim()) {
      writeEnvValue('TG_BOT_TOKEN', botToken.trim());
    }
    if (chatId !== undefined && typeof chatId === 'string' && chatId.trim()) {
      writeEnvValue('TELEGRAM_HOME_CHANNEL', chatId.trim());
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Feeds API (the data contract) ────────────────────────────────────────────

// All feeds, with optional filters (source, group, author, search, reel, dates)
app.get('/api/feeds', (req, res) => {
  try {
    res.json(queryPosts(req.query));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Feeds for a single group
app.get('/api/groups/:id/feeds', (req, res) => {
  try {
    const groups = loadGroups();
    if (!groups.some(g => g.id === req.params.id)) {
      return res.status(404).json({ error: 'Group not found' });
    }
    res.json(queryPosts({ ...req.query, group: req.params.id }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Single feed/post with image reference
app.get('/api/feeds/:shortcode', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM posts WHERE shortcode = ?').get(req.params.shortcode);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const imagePath = resolveScreenshotPath(row);
    res.json({
      ...decoratePost(row, null),
      image: imagePath
        ? { url: `/api/feeds/${row.shortcode}/image`, filename: basename(imagePath), contentType: imageContentType(imagePath) }
        : null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Raw image bytes for a feed post
app.get('/api/feeds/:shortcode/image', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM posts WHERE shortcode = ?').get(req.params.shortcode);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const imagePath = resolveScreenshotPath(row);
    if (!imagePath) return res.status(404).json({ error: 'No image available for this post' });
    res.setHeader('Content-Type', imageContentType(imagePath));
    res.setHeader('Content-Disposition', `inline; filename="${basename(imagePath)}"`);
    res.send(readFileSync(imagePath));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Export ───────────────────────────────────────────────────────────────────

app.get('/api/export', (req, res) => {
  try {
    const result = queryPosts(
      { ...req.query, limit: req.query.limit || 1000000, offset: req.query.offset || 0 },
      { maxLimit: 1000000 },
    );
    const payload = {
      exportedAt: new Date().toISOString(),
      total: result.total,
      count: result.posts.length,
      posts: result.posts,
    };
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', 'attachment; filename="feeds-export.json"');
    }
    res.json(payload);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Data contract (OpenAPI) ──────────────────────────────────────────────────

const CONTRACT_FILE = join(ROOT, 'api', 'openapi.json');
app.get('/api/openapi.json', (req, res) => serveContract(res));
app.get('/api/contract', (req, res) => serveContract(res));

function serveContract(res) {
  try {
    if (existsSync(CONTRACT_FILE)) {
      res.setHeader('Content-Type', 'application/json');
      return res.send(readFileSync(CONTRACT_FILE, 'utf-8'));
    }
    res.status(404).json({ error: 'OpenAPI contract not found (expected at api/openapi.json)' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─── Frontend ─────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(HTML_PAGE);
});

app.get('/settings', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(SETTINGS_PAGE);
});

app.get('/settings/sources', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(SOURCES_PAGE);
});

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>IG Feed Watcher — Explorer</title>
<style>
  :root {
    --bg: #0a0a0f;
    --card: #16161e;
    --border: #2a2a35;
    --text: #e4e4e7;
    --text-dim: #8a8a96;
    --accent: #6366f1;
    --accent-hover: #818cf8;
    --priority: #f59e0b;
    --green: #10b981;
    --red: #ef4444;
    --radius: 12px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: var(--bg); color: var(--text);
    min-height: 100vh; padding: 20px;
  }
  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; }
  .header h1 { font-size: 24px; font-weight: 700; }
  .header h1 span { color: var(--accent); }

  /* Stats bar */
  .stats-bar { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 24px; }
  .stat-card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 20px; min-width: 120px; }
  .stat-card .label { font-size: 11px; text-transform: uppercase; color: var(--text-dim); letter-spacing: 0.5px; }
  .stat-card .value { font-size: 28px; font-weight: 700; margin-top: 4px; }
  .stat-card.priority .value { color: var(--priority); }
  .stat-card.green .value { color: var(--green); }

  /* Filters */
  .filters { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; margin-bottom: 24px; display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  .filters input, .filters select { background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 8px 12px; border-radius: 8px; font-size: 14px; }
  .filters input:focus, .filters select:focus { outline: none; border-color: var(--accent); }
  .filters label { font-size: 12px; color: var(--text-dim); display: flex; flex-direction: column; gap: 4px; }
  .filter-btn { background: var(--accent); color: white; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 14px; }
  .filter-btn:hover { background: var(--accent-hover); }
  .group-filter select { min-width: 140px; }

  /* Grid */
  .posts-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
  .post-card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; cursor: pointer; transition: transform 0.2s, border-color 0.2s; }
  .post-card:hover { transform: translateY(-2px); border-color: var(--accent); }
  .post-card.has-groups { border-color: var(--accent); }
  .post-card img { width: 100%; height: 280px; object-fit: cover; background: #111; }
  .post-card .no-img { width: 100%; height: 280px; display: flex; align-items: center; justify-content: center; background: #111; color: var(--text-dim); font-size: 14px; }
  .post-card .info { padding: 12px 16px; }
  .post-card .author { font-weight: 600; color: var(--accent); font-size: 14px; }
  .post-card .author .verified { color: var(--green); }
  .post-card .caption { font-size: 13px; color: var(--text-dim); margin-top: 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .post-card .meta { display: flex; gap: 8px; margin-top: 8px; font-size: 11px; color: var(--text-dim); flex-wrap: wrap; }
  .badge { padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; }
  .badge.reel { background: #e11d4820; color: #fb7185; }
  .badge.group { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 4px; }
  .badge.comments { background: #6366f120; color: var(--accent-hover); }

  /* Comments in modal */
  .comments-section { margin-top: 16px; border-top: 1px solid var(--border); padding-top: 12px; }
  .comments-section h4 { font-size: 13px; text-transform: uppercase; color: var(--text-dim); margin-bottom: 10px; letter-spacing: 0.5px; }
  .comment-item { padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
  .comment-item:last-child { border-bottom: none; }
  .comment-item .c-author { font-weight: 600; color: var(--accent); }
  .comment-item .c-text { margin-top: 2px; line-height: 1.4; }
  .comment-item .c-meta { margin-top: 4px; font-size: 11px; color: var(--text-dim); display: flex; gap: 10px; }

  /* Group assignment in modal */
  .group-assign { margin-top: 12px; }
  .group-assign h4 { font-size: 13px; text-transform: uppercase; color: var(--text-dim); margin-bottom: 8px; letter-spacing: 0.5px; }
  .group-assign-item { display: flex; align-items: center; gap: 8px; padding: 6px 0; cursor: pointer; font-size: 14px; }
  .group-assign-item input { width: 18px; height: 18px; accent-color: var(--accent); }
  .group-assign-item .group-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .group-assign-item .group-reasons { font-size: 11px; color: var(--text-dim); margin-left: auto; }

  /* Modal */
  .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 100; display: none; }
  .modal-overlay.active { display: flex; }
  .modal { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); max-width: 600px; max-height: 90vh; overflow-y: auto; width: 90%; }
  .modal img { width: 100%; border-radius: var(--radius) var(--radius) 0 0; }
  .modal .body { padding: 20px; }
  .modal .close { position: absolute; top: 16px; right: 16px; background: rgba(0,0,0,0.6); border: none; color: white; width: 36px; height: 36px; border-radius: 50%; cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center; }
  .modal .close:hover { background: rgba(0,0,0,0.8); }

  /* Authors panel */
  .authors-panel { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; margin-bottom: 24px; }
  .authors-panel h3 { font-size: 14px; margin-bottom: 12px; color: var(--text-dim); text-transform: uppercase; }
  .author-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border); cursor: pointer; font-size: 14px; }
  .author-row:hover { color: var(--accent); }
  .author-row .count { color: var(--text-dim); }
  .author-row.has-groups .name { color: var(--accent); }

  .loading { text-align: center; padding: 40px; color: var(--text-dim); }
  .empty { text-align: center; padding: 40px; color: var(--text-dim); }
  .pagination { display: flex; justify-content: center; gap: 12px; margin-top: 24px; }
  .pagination button { background: var(--card); border: 1px solid var(--border); color: var(--text); padding: 8px 16px; border-radius: 8px; cursor: pointer; }
  .pagination button:hover { border-color: var(--accent); }
  .pagination button:disabled { opacity: 0.4; cursor: default; }
  .toggle-row { display: flex; gap: 16px; margin-bottom: 16px; }
  .toggle-row button { background: var(--card); border: 1px solid var(--border); color: var(--text); padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 14px; }
  .toggle-row button.active { background: var(--accent); border-color: var(--accent); }
  .timestamp { font-family: monospace; font-size: 11px; }
</style>
</head>
<body>

<div class="header">
  <h1>📷 IG Feed <span>Watcher</span></h1>
  <div class="toggle-row">
    <button id="view-grid" class="active" onclick="switchView('grid')">Grid</button>
    <button id="view-stats" onclick="switchView('stats')">Stats</button>
    <a href="/settings" style="background:var(--card);border:1px solid var(--border);color:var(--text);padding:8px 16px;border-radius:8px;font-size:14px;text-decoration:none;display:inline-flex;align-items:center">🏷️ Groups</a>
    <a href="/settings/sources" style="background:var(--card);border:1px solid var(--border);color:var(--text);padding:8px 16px;border-radius:8px;font-size:14px;text-decoration:none;display:inline-flex;align-items:center">🔑 Sources</a>
  </div>
</div>

<!-- Stats view -->
<div id="stats-view" style="display:none">
  <div class="stats-bar" id="stats-bar"></div>
  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
    <div class="authors-panel">
      <h3>Top Authors</h3>
      <div id="top-authors"></div>
    </div>
    <div class="authors-panel">
      <h3>Posts by Day</h3>
      <div id="posts-by-day"></div>
    </div>
  </div>
</div>

<!-- Grid view -->
<div id="grid-view">
  <div class="filters">
    <label>Author
      <input type="text" id="filter-author" placeholder="username" onkeyup="debounceReload()">
    </label>
    <label>Search caption
      <input type="text" id="filter-search" placeholder="keywords..." onkeyup="debounceReload()">
    </label>
    <label>Type
      <select id="filter-reel" onchange="reloadPosts()">
        <option value="">All</option>
        <option value="1">Reels</option>
        <option value="0">Photos</option>
      </select>
    </label>
    <label>Date from
      <input type="date" id="filter-from" onchange="reloadPosts()">
    </label>
    <label>Date to
      <input type="date" id="filter-to" onchange="reloadPosts()">
    </label>
    <label class="group-filter">Group
      <select id="filter-group" onchange="reloadPosts()">
        <option value="">All groups</option>
      </select>
    </label>
    <button class="filter-btn" onclick="reloadPosts()">Apply</button>
    <button class="filter-btn" style="background:var(--card);border:1px solid var(--border)" onclick="clearFilters()">Clear</button>
  </div>

  <div class="posts-grid" id="posts-grid"></div>
  <div class="pagination" id="pagination"></div>
</div>

<!-- Modal -->
<div class="modal-overlay" id="modal" onclick="closeModal(event)">
  <div class="modal" onclick="event.stopPropagation()">
    <button class="close" onclick="closeModal()">✕</button>
    <div id="modal-content"></div>
  </div>
</div>

<script>
let currentOffset = 0;
let currentTotal = 0;
let groupsCache = [];
const LIMIT = 50;

async function loadGroupsCache() {
  const res = await fetch('/api/groups');
  const data = await res.json();
  groupsCache = data.groups || [];
  const sel = document.getElementById('filter-group');
  sel.innerHTML = '<option value="">All groups</option>' +
    groupsCache.map(g => '<option value="' + g.id + '">' + escapeHtml(g.name) + ' (' + g.post_count + ')</option>').join('');
}

function groupBadge(mg) {
  const color = mg.color || '#6366f1';
  return '<span class="badge group" style="background:' + color + '20;color:' + color + '">' + escapeHtml(mg.name) + '</span>';
}

function groupBadges(matchedGroups) {
  if (!matchedGroups || matchedGroups.length === 0) return '';
  return matchedGroups.map(groupBadge).join(' ');
}

async function loadStats() {
  const res = await fetch('/api/stats');
  const data = await res.json();

  const bar = document.getElementById('stats-bar');
  bar.innerHTML = [
    statCard('Total Posts', data.total),
    statCard('In Groups', data.priority, 'priority'),
    statCard('Reels', data.reels),
    statCard('Authors', data.authors, 'green'),
    statCard('Last 24h', data.last24h),
    statCard('Last 7d', data.last7d),
    statCard('With Caption', data.withCaption),
    statCard('Screenshots', data.withScreenshot),
    statCard('Comments', data.totalComments || 0, 'green'),
    statCard('Posts w/ Comments', data.postsWithComments || 0),
  ].join('');

  // Groups breakdown
  if (data.groups && data.groups.length > 0) {
    bar.innerHTML += '<div style="width:100%;margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">' +
      data.groups.map(g => {
        const color = g.color || '#6366f1';
        return '<span class="badge group" style="background:' + color + '20;color:' + color + ';font-size:12px;padding:4px 12px;cursor:pointer" onclick="filterByGroup(&#39;' + g.id + '&#39;)">' +
          escapeHtml(g.name) + ': ' + g.post_count + '</span>';
      }).join('') +
    '</div>';
  }

  const authors = document.getElementById('top-authors');
  authors.innerHTML = data.topAuthors.map(a =>
    '<div class="author-row' + (a.priority_count > 0 ? ' has-groups' : '') + '" onclick="filterByAuthor(&#39;'+a.author+'&#39;)">' +
      '<span class="name">@' + a.author + (a.priority_count > 0 ? ' 🏷️' : '') + '</span>' +
      '<span class="count">' + a.count + ' posts</span>' +
    '</div>'
  ).join('');

  const byDay = document.getElementById('posts-by-day');
  byDay.innerHTML = data.postsByDay.map(d =>
    '<div class="author-row"><span>' + d.date + '</span><span class="count">' + d.count + (d.priority_count > 0 ? ' (🏷️'+d.priority_count+')' : '') + '</span></div>'
  ).join('') || '<div class="empty">No data yet</div>';
}

function statCard(label, value, cls = '') {
  return '<div class="stat-card ' + cls + '"><div class="label">' + label + '</div><div class="value">' + value + '</div></div>';
}

function filterByAuthor(author) {
  document.getElementById('filter-author').value = author;
  switchView('grid');
  reloadPosts();
}

function filterByGroup(groupId) {
  document.getElementById('filter-group').value = groupId;
  switchView('grid');
  reloadPosts();
}

let debounceTimer;
function debounceReload() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(reloadPosts, 300);
}

function getFilters() {
  const params = new URLSearchParams();
  const author = document.getElementById('filter-author').value;
  const search = document.getElementById('filter-search').value;
  const reel = document.getElementById('filter-reel').value;
  const from = document.getElementById('filter-from').value;
  const to = document.getElementById('filter-to').value;
  const group = document.getElementById('filter-group').value;

  if (author) params.set('author', author);
  if (search) params.set('search', search);
  if (reel) params.set('reel', reel);
  if (from) params.set('date_from', from + 'T00:00:00');
  if (to) params.set('date_to', to + 'T23:59:59');
  if (group) params.set('group', group);
  params.set('limit', LIMIT);
  params.set('offset', currentOffset);
  return params;
}

async function reloadPosts() {
  const grid = document.getElementById('posts-grid');
  grid.innerHTML = '<div class="loading">Loading...</div>';

  const params = getFilters();
  const res = await fetch('/api/posts?' + params);
  const data = await res.json();

  currentTotal = data.total;

  if (data.posts.length === 0) {
    grid.innerHTML = '<div class="empty">No posts found</div>';
    document.getElementById('pagination').innerHTML = '';
    return;
  }

  grid.innerHTML = data.posts.map(p => {
    const img = p.screenshot_url
      ? '<img src="' + p.screenshot_url + '" loading="lazy" onclick="openModal(&#39;'+p.shortcode+'&#39;)">'
      : '<div class="no-img" onclick="openModal(&#39;'+p.shortcode+'&#39;)">No screenshot</div>';
    const badges = [
      p.is_reel ? '<span class="badge reel">Reel</span>' : '',
      groupBadges(p.matched_groups),
      p.comment_count > 0 ? '<span class="badge comments">💬 ' + p.comment_count + '</span>' : '',
    ].filter(b => b).join(' ');
    const caption = p.caption ? '<div class="caption">' + escapeHtml(p.caption.slice(0, 120)) + '</div>' : '';
    const time = p.timestamp ? '<span class="timestamp">' + new Date(p.timestamp).toLocaleDateString() + '</span>' : '';
    return '<div class="post-card' + (p.matched_groups && p.matched_groups.length > 0 ? ' has-groups' : '') + '" onclick="openModal(&#39;'+p.shortcode+'&#39;)">' +
      img +
      '<div class="info">' +
        '<div class="author">@' + escapeHtml(p.author) + '</div>' +
        caption +
        '<div class="meta">' + badges + time + '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  // Pagination
  const pag = document.getElementById('pagination');
  const hasPrev = currentOffset > 0;
  const hasNext = currentOffset + LIMIT < currentTotal;
  pag.innerHTML = (hasPrev ? '<button onclick="prevPage()">← Previous</button>' : '<button disabled>← Previous</button>') +
    '<span style="align-self:center;color:var(--text-dim);font-size:14px">' + (currentOffset+1) + '–' + Math.min(currentOffset+LIMIT, currentTotal) + ' of ' + currentTotal + '</span>' +
    (hasNext ? '<button onclick="nextPage()">Next →</button>' : '<button disabled>Next →</button>');
}

function prevPage() { currentOffset = Math.max(0, currentOffset - LIMIT); reloadPosts(); }
function nextPage() { currentOffset += LIMIT; reloadPosts(); }

function clearFilters() {
  document.getElementById('filter-author').value = '';
  document.getElementById('filter-search').value = '';
  document.getElementById('filter-reel').value = '';
  document.getElementById('filter-from').value = '';
  document.getElementById('filter-to').value = '';
  document.getElementById('filter-group').value = '';
  currentOffset = 0;
  reloadPosts();
}

async function openModal(shortcode) {
  const modal = document.getElementById('modal');
  const content = document.getElementById('modal-content');
  content.innerHTML = '<div class="loading">Loading...</div>';
  modal.classList.add('active');

  const res = await fetch('/api/posts/' + shortcode);
  const p = await res.json();

  const img = p.screenshot_url ? '<img src="' + p.screenshot_url + '">' : '';
  const badges = [
    p.is_reel ? '<span class="badge reel">Reel</span>' : '',
    groupBadges(p.matched_groups),
    p.comment_count > 0 ? '<span class="badge comments">💬 ' + p.comment_count + '</span>' : '',
  ].filter(b => b).join(' ');

  // Group assignment UI
  const matchedMap = {};
  (p.matched_groups || []).forEach(mg => { matchedMap[mg.id] = mg; });
  let groupAssignHtml = '<div class="group-assign"><h4>🏷️ Interest Groups</h4>';
  if (groupsCache.length === 0) {
    groupAssignHtml += '<div style="color:var(--text-dim);font-size:13px">No groups defined. <a href="/settings" style="color:var(--accent)">Create groups in settings →</a></div>';
  } else {
    groupAssignHtml += groupsCache.map(g => {
      const isMember = !!matchedMap[g.id];
      const reasons = isMember && matchedMap[g.id].reasons ? matchedMap[g.id].reasons.join(', ') : '';
      const color = g.color || '#6366f1';
      return '<label class="group-assign-item">' +
        '<input type="checkbox" ' + (isMember ? 'checked' : '') + ' onchange="toggleGroupAssignment(\\'' + p.shortcode + '\\',\\'' + g.id + '\\',this.checked)">' +
        '<span class="group-dot" style="background:' + color + '"></span>' +
        '<span>' + escapeHtml(g.name) + '</span>' +
        (reasons ? '<span class="group-reasons">(' + escapeHtml(reasons) + ')</span>' : '') +
      '</label>';
    }).join('');
  }
  groupAssignHtml += '</div>';

  let images = '';
  if (p.image_urls.length > 0) {
    images = '<div style="margin-top:12px;font-size:12px;color:var(--text-dim)">' + p.image_urls.length + ' image(s) in post</div>';
  }

  let commentsHtml = '';
  if (p.comments && p.comments.length > 0) {
    commentsHtml =
      '<div class="comments-section">' +
        '<h4>💬 Comments (' + p.comments.length + ')</h4>' +
        p.comments.map(c =>
          '<div class="comment-item">' +
            '<span class="c-author">@' + escapeHtml(c.author || 'unknown') + '</span>' +
            '<div class="c-text">' + escapeHtml(c.text || '') + '</div>' +
            '<div class="c-meta">' +
              (c.like_count > 0 ? '<span>❤️ ' + c.like_count + '</span>' : '') +
              (c.timestamp ? '<span>' + new Date(c.timestamp).toLocaleString() + '</span>' : '') +
            '</div>' +
          '</div>'
        ).join('') +
      '</div>';
  } else {
    commentsHtml = '<div class="comments-section"><h4>💬 Comments</h4><div style="color:var(--text-dim);font-size:13px">No comments captured for this post</div></div>';
  }

  content.innerHTML =
    img +
    '<div class="body">' +
      '<div style="display:flex;justify-content:space-between;align-items:start">' +
        '<div><div class="author" style="font-size:18px">@' + escapeHtml(p.author) + '</div>' + badges + '</div>' +
        '<a href="' + p.permalink + '" target="_blank" style="color:var(--accent);text-decoration:none;font-size:14px">Open on IG ↗</a>' +
      '</div>' +
      groupAssignHtml +
      (p.caption ? '<div style="margin-top:12px;font-size:14px;line-height:1.5">' + escapeHtml(p.caption) + '</div>' : '<div style="margin-top:12px;color:var(--text-dim)">No caption</div>') +
      '<div style="margin-top:16px;font-size:12px;color:var(--text-dim)">' +
        '<div>📅 Posted: ' + (p.timestamp ? new Date(p.timestamp).toLocaleString() : 'Unknown') + '</div>' +
        '<div>👁️ Seen: ' + (p.seen_at ? new Date(p.seen_at + 'Z').toLocaleString() : 'Unknown') + '</div>' +
        '<div>🔗 Shortcode: ' + p.shortcode + '</div>' +
      '</div>' +
      images +
      commentsHtml +
    '</div>';
}

async function toggleGroupAssignment(shortcode, groupId, member) {
  const res = await fetch('/api/posts/' + shortcode + '/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ group_id: groupId, member }),
  });
  const result = await res.json();
  if (result.ok) {
    openModal(shortcode);
    reloadPosts();
  } else {
    alert('Error: ' + (result.error || 'failed to update group assignment'));
  }
}

function closeModal(e) {
  if (e && e.target !== document.getElementById('modal')) return;
  document.getElementById('modal').classList.remove('active');
}

function switchView(view) {
  if (view === 'stats') {
    document.getElementById('stats-view').style.display = 'block';
    document.getElementById('grid-view').style.display = 'none';
    document.getElementById('view-stats').classList.add('active');
    document.getElementById('view-grid').classList.remove('active');
    loadStats();
  } else {
    document.getElementById('stats-view').style.display = 'none';
    document.getElementById('grid-view').style.display = 'block';
    document.getElementById('view-stats').classList.remove('active');
    document.getElementById('view-grid').classList.add('active');
  }
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Init
loadGroupsCache().then(reloadPosts);
</script>
</body>
</html>`;

// ─── Settings Page ────────────────────────────────────────────────────────────

const SETTINGS_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>IG Feed Watcher — Groups</title>
<style>
  :root {
    --bg: #0a0a0f; --card: #16161e; --border: #2a2a35;
    --text: #e4e4e7; --text-dim: #8a8a96; --accent: #6366f1;
    --accent-hover: #818cf8; --priority: #f59e0b; --green: #10b981;
    --red: #ef4444; --radius: 12px;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:var(--bg); color:var(--text); min-height:100vh; padding:20px; }
  .header { display:flex; justify-content:space-between; align-items:center; margin-bottom:24px; flex-wrap:wrap; gap:12px; }
  .header h1 { font-size:24px; font-weight:700; }
  .header h1 span { color:var(--accent); }
  .back-link { color:var(--text-dim); text-decoration:none; font-size:14px; }
  .back-link:hover { color:var(--accent); }

  .section { background:var(--card); border:1px solid var(--border); border-radius:var(--radius); padding:20px; margin-bottom:20px; }
  .section h2 { font-size:16px; margin-bottom:4px; }
  .section .desc { font-size:13px; color:var(--text-dim); margin-bottom:16px; }

  .add-row { display:flex; gap:8px; margin-bottom:12px; }
  .add-row input { flex:1; background:var(--bg); border:1px solid var(--border); color:var(--text); padding:8px 12px; border-radius:8px; font-size:14px; }
  .add-row input:focus { outline:none; border-color:var(--accent); }
  .add-btn { background:var(--accent); color:white; border:none; padding:8px 16px; border-radius:8px; cursor:pointer; font-size:14px; white-space:nowrap; }
  .add-btn:hover { background:var(--accent-hover); }

  .tag-list { display:flex; flex-wrap:wrap; gap:8px; }
  .tag { display:inline-flex; align-items:center; gap:6px; background:var(--bg); border:1px solid var(--border); padding:6px 12px; border-radius:20px; font-size:13px; }
  .tag .remove { cursor:pointer; color:var(--red); font-weight:bold; margin-left:4px; }
  .tag .remove:hover { color:#f87171; }

  .empty-tags { color:var(--text-dim); font-size:13px; font-style:italic; }

  .toast { position:fixed; bottom:80px; right:20px; background:var(--green); color:white; padding:12px 20px; border-radius:8px; font-size:14px; opacity:0; transition:opacity 0.3s; pointer-events:none; }
  .toast.show { opacity:1; }
  .toast.error { background:var(--red); }

  .search-box { margin-bottom:12px; }
  .search-box input { width:100%; background:var(--bg); border:1px solid var(--border); color:var(--text); padding:8px 12px; border-radius:8px; font-size:14px; }
  .search-box input:focus { outline:none; border-color:var(--accent); }

  /* Group cards */
  .group-card { background:var(--card); border:1px solid var(--border); border-left:4px solid var(--accent); border-radius:var(--radius); padding:20px; margin-bottom:16px; }
  .group-card .group-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:8px; }
  .group-card .group-title { display:flex; align-items:center; gap:10px; font-size:18px; font-weight:600; }
  .group-card .group-dot { width:14px; height:14px; border-radius:50%; display:inline-block; }
  .group-card .group-stats { font-size:12px; color:var(--text-dim); }
  .group-card .group-actions { display:flex; gap:8px; }
  .group-card .group-actions button { background:var(--bg); border:1px solid var(--border); color:var(--text); padding:6px 12px; border-radius:8px; cursor:pointer; font-size:13px; }
  .group-card .group-actions button:hover { border-color:var(--accent); }
  .group-card .group-actions button.delete-btn:hover { border-color:var(--red); color:var(--red); }
  .group-card .group-body { display:none; margin-top:16px; border-top:1px solid var(--border); padding-top:16px; }
  .group-card.expanded .group-body { display:block; }
  .group-card .group-subsection { margin-bottom:16px; }
  .group-card .group-subsection h3 { font-size:13px; text-transform:uppercase; color:var(--text-dim); margin-bottom:8px; letter-spacing:0.5px; }
  .group-card .group-subsection .add-row { margin-bottom:8px; }

  .new-group-form { display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end; }
  .new-group-form label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--text-dim); }
  .new-group-form input { background:var(--bg); border:1px solid var(--border); color:var(--text); padding:8px 12px; border-radius:8px; font-size:14px; }
  .new-group-form input:focus { outline:none; border-color:var(--accent); }
  .new-group-form .name-input { min-width:200px; }
  .color-input { width:60px; height:38px; border:1px solid var(--border); border-radius:8px; background:var(--bg); cursor:pointer; }
</style>
</head>
<body>

<div class="header">
  <h1>🏷️ Interest <span>Groups</span></h1>
  <div style="display:flex;gap:16px;align-items:center">
    <a href="/settings/sources" class="back-link">🔑 Sources &amp; Cookies</a>
    <a href="/" class="back-link">← Back to Explorer</a>
  </div>
</div>

<div class="section">
  <h2>Create New Group</h2>
  <div class="desc">Define a group with a name and color. Then add accounts, keywords, and hashtags to match posts.</div>
  <div class="new-group-form">
    <label>Name
      <input type="text" id="new-group-name" class="name-input" placeholder="e.g. Agriculture Policy" onkeydown="if(event.key==='Enter')createGroup()">
    </label>
    <label>Color
      <input type="color" id="new-group-color" class="color-input" value="#6366f1">
    </label>
    <button class="add-btn" onclick="createGroup()">+ Create Group</button>
  </div>
</div>

<div id="groups-list"></div>

<div class="toast" id="toast"></div>

<script>
let groups = [];

async function loadGroups() {
  const res = await fetch('/api/groups');
  const data = await res.json();
  groups = data.groups || [];
  renderGroups();
}

function renderGroups() {
  const el = document.getElementById('groups-list');
  if (groups.length === 0) {
    el.innerHTML = '<div class="section"><div class="empty-tags">No groups yet. Create one above.</div></div>';
    return;
  }
  el.innerHTML = groups.map(g => groupCardHtml(g)).join('');
}

function groupCardHtml(g) {
  const color = g.color || '#6366f1';
  return '<div class="group-card" id="card-' + g.id + '" style="border-left-color:' + color + '">' +
    '<div class="group-header">' +
      '<div class="group-title">' +
        '<span class="group-dot" style="background:' + color + '"></span>' +
        '<span>' + escapeHtml(g.name) + '</span>' +
        '<span class="group-stats">' + g.post_count + ' posts</span>' +
      '</div>' +
      '<div class="group-actions">' +
        '<button onclick="toggleExpand(\\'' + g.id + '\\')">Edit</button>' +
        '<button class="delete-btn" onclick="deleteGroup(\\'' + g.id + '\\')">Delete</button>' +
      '</div>' +
    '</div>' +
    '<div class="group-body">' +
      '<div class="group-subsection">' +
        '<h3>👤 Accounts</h3>' +
        '<div class="add-row">' +
          '<input type="text" id="add-account-' + g.id + '" placeholder="username" onkeydown="if(event.key===\\'Enter\\')addItem(\\'' + g.id + '\\',\\'account\\')">' +
          '<button class="add-btn" onclick="addItem(\\'' + g.id + '\\',\\'account\\')">+ Add</button>' +
        '</div>' +
        '<div class="tag-list" id="tags-accounts-' + g.id + '"></div>' +
      '</div>' +
      '<div class="group-subsection">' +
        '<h3>🔑 Keywords</h3>' +
        '<div class="add-row">' +
          '<input type="text" id="add-keyword-' + g.id + '" placeholder="keyword or phrase" onkeydown="if(event.key===\\'Enter\\')addItem(\\'' + g.id + '\\',\\'keyword\\')">' +
          '<button class="add-btn" onclick="addItem(\\'' + g.id + '\\',\\'keyword\\')">+ Add</button>' +
        '</div>' +
        '<div class="tag-list" id="tags-keywords-' + g.id + '"></div>' +
      '</div>' +
      '<div class="group-subsection">' +
        '<h3># Hashtags</h3>' +
        '<div class="add-row">' +
          '<input type="text" id="add-hashtag-' + g.id + '" placeholder="#hashtag" onkeydown="if(event.key===\\'Enter\\')addItem(\\'' + g.id + '\\',\\'hashtag\\')">' +
          '<button class="add-btn" onclick="addItem(\\'' + g.id + '\\',\\'hashtag\\')">+ Add</button>' +
        '</div>' +
        '<div class="tag-list" id="tags-hashtags-' + g.id + '"></div>' +
      '</div>' +
      '<div class="group-subsection">' +
        '<h3>Rename / Recolor</h3>' +
        '<div class="new-group-form">' +
          '<label>Name<input type="text" id="edit-name-' + g.id + '" value="' + escapeHtml(g.name) + '"></label>' +
          '<label>Color<input type="color" id="edit-color-' + g.id + '" class="color-input" value="' + color + '"></label>' +
          '<button class="add-btn" onclick="updateGroup(\\'' + g.id + '\\')">Save Changes</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function toggleExpand(groupId) {
  const card = document.getElementById('card-' + groupId);
  if (card.classList.contains('expanded')) {
    card.classList.remove('expanded');
  } else {
    card.classList.add('expanded');
    renderGroupTags(groupId);
  }
}

function renderGroupTags(groupId) {
  const g = groups.find(x => x.id === groupId);
  if (!g) return;
  renderTagList('tags-accounts-' + groupId, g.accounts || [], groupId, 'account', '@');
  renderTagList('tags-keywords-' + groupId, g.keywords || [], groupId, 'keyword', '"');
  renderTagList('tags-hashtags-' + groupId, g.hashtags || [], groupId, 'hashtag', '');
}

function renderTagList(elId, items, groupId, type, prefix) {
  const el = document.getElementById(elId);
  if (!items || items.length === 0) {
    el.innerHTML = '<div class="empty-tags">None yet. Add one above.</div>';
    return;
  }
  el.innerHTML = items.map(item => {
    const display = prefix === '"' ? '"' + escapeHtml(item) + '"' : prefix + escapeHtml(item);
    return '<span class="tag">' + display +
      '<span class="remove" onclick="removeItem(\\'' + groupId + '\\',\\'' + type + '\\',\\'' + escapeHtml(item).replace(/'/g, '\\'') + '\\')">✕</span></span>';
  }).join('');
}

async function createGroup() {
  const name = document.getElementById('new-group-name').value.trim();
  const color = document.getElementById('new-group-color').value;
  if (!name) { showToast('Name is required', true); return; }

  const res = await fetch('/api/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, color, accounts: [], keywords: [], hashtags: [] }),
  });
  const result = await res.json();
  if (result.ok) {
    document.getElementById('new-group-name').value = '';
    showToast('Group "' + name + '" created');
    loadGroups();
  } else {
    showToast('Error: ' + (result.error || 'failed'), true);
  }
}

async function updateGroup(groupId) {
  const name = document.getElementById('edit-name-' + groupId).value.trim();
  const color = document.getElementById('edit-color-' + groupId).value;
  if (!name) { showToast('Name is required', true); return; }

  const res = await fetch('/api/groups/' + groupId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, color }),
  });
  const result = await res.json();
  if (result.ok) {
    showToast('Group updated');
    loadGroups();
  } else {
    showToast('Error: ' + (result.error || 'failed'), true);
  }
}

async function deleteGroup(groupId) {
  const g = groups.find(x => x.id === groupId);
  if (!g) return;
  if (!confirm('Delete group "' + g.name + '"? Posts will remain but lose group association.')) return;

  const res = await fetch('/api/groups/' + groupId, { method: 'DELETE' });
  const result = await res.json();
  if (result.ok) {
    showToast('Group deleted');
    loadGroups();
  } else {
    showToast('Error: ' + (result.error || 'failed'), true);
  }
}

async function addItem(groupId, type) {
  const input = document.getElementById('add-' + type + '-' + groupId);
  const value = input.value.trim();
  if (!value) return;

  const res = await fetch('/api/groups/' + groupId + '/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, value }),
  });
  const result = await res.json();
  if (result.ok) {
    input.value = '';
    const idx = groups.findIndex(x => x.id === groupId);
    if (idx >= 0) groups[idx] = result.group;
    renderGroupTags(groupId);
    showToast('Added "' + value + '"');
  } else {
    showToast('Error: ' + (result.error || 'failed'), true);
  }
}

async function removeItem(groupId, type, value) {
  const res = await fetch('/api/groups/' + groupId + '/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, value }),
  });
  const result = await res.json();
  if (result.ok) {
    const idx = groups.findIndex(x => x.id === groupId);
    if (idx >= 0) groups[idx] = result.group;
    renderGroupTags(groupId);
    showToast('Removed "' + value + '"');
  } else {
    showToast('Error: ' + (result.error || 'failed'), true);
  }
}

function showToast(msg, isError) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => { toast.className = 'toast'; }, 2000);
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Init
loadGroups();
</script>
</body>
</html>`;

// ─── Sources Settings Page ────────────────────────────────────────────────────

// Read the docs shown on the Sources page (cookie guide + the agent skill for
// the feed API). Fall back to a friendly note if the files are missing.
function readDocOrNote(filePath, note) {
  try {
    if (!existsSync(filePath)) return note;
    return readFileSync(filePath, 'utf-8');
  } catch {
    return note;
  }
}
const COOKIES_GUIDE_MD = readDocOrNote(join(ROOT, 'COOKIES-GUIDE.md'), '_COOKIES-GUIDE.md is missing._');
const FEED_API_SKILL_MD = readDocOrNote(join(ROOT, 'skills', 'feed-api', 'SKILL.md'), '_The feed-api agent skill is missing._');

// Minimal server-side Markdown → HTML renderer for the two docs embedded in the
// Sources page. Covers the subset used by COOKIES-GUIDE.md and SKILL.md:
// headings, paragraphs, fenced code blocks, inline code, bold, links, lists,
// blockquotes, tables and horizontal rules. Input is always escaped first.
function escapeHtmlText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function mdInline(s) {
  let out = escapeHtmlText(s);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return out;
}

function renderMarkdown(md) {
  let source = String(md);
  // Strip YAML frontmatter (--- ... ---) — it is metadata for skill systems,
  // not display content.
  if (/^---\s*$/.test(source.split(/\r?\n/)[0].trim())) {
    const rest = source.replace(/^---[^\n]*\n/, '');
    const end = rest.search(/\n---\s*(\r?\n|$)/);
    if (end !== -1) source = rest.slice(end + 4);
  }
  const lines = source.split(/\r?\n/);
  let html = '';
  let inCode = false;
  let codeBuf = [];
  let listOpen = null; // 'ul' | 'ol' | null
  let tableBuf = null; // { header: [...], rows: [[...]] }
  let paraBuf = [];    // consecutive plain lines forming one paragraph

  const closeList = () => {
    if (listOpen) { html += `</${listOpen}>`; listOpen = null; }
  };
  const closeTable = () => {
    if (tableBuf) {
      html += '<table><thead><tr>' + tableBuf.header.map(c => `<th>${mdInline(c)}</th>`).join('') + '</tr></thead><tbody>';
      html += tableBuf.rows.map(r => '<tr>' + r.map(c => `<td>${mdInline(c)}</td>`).join('') + '</tr>').join('');
      html += '</tbody></table>';
      tableBuf = null;
    }
  };
  // Flush a buffered paragraph (joined with spaces so inline bold/code can
  // span soft line wraps in the source).
  const flushPara = () => {
    if (paraBuf.length) {
      html += `<p>${mdInline(paraBuf.join(' '))}</p>`;
      paraBuf = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trim();

    // Fenced code blocks
    if (/^```/.test(line)) {
      flushPara();
      if (inCode) {
        html += '<pre><code>' + codeBuf.join('\n') + '</code></pre>';
        inCode = false;
        codeBuf = [];
      } else {
        closeList(); closeTable();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(escapeHtmlText(raw)); continue; }

    if (!line) { flushPara(); closeList(); closeTable(); continue; }

    // Headings
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara(); closeList(); closeTable();
      const lvl = Math.min(h[1].length, 6);
      html += `<h${lvl}>${mdInline(h[2])}</h${lvl}>`;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,})$/.test(line)) {
      flushPara(); closeList(); closeTable();
      html += '<hr>';
      continue;
    }

    // Tables
    if (line.startsWith('|')) {
      flushPara();
      const cells = line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      // Skip the separator row (| --- | --- |)
      if (/^[-: ]+$/.test(cells.join('')) && tableBuf) continue;
      if (!tableBuf) {
        closeList();
        tableBuf = { header: cells, rows: [] };
      } else {
        tableBuf.rows.push(cells);
      }
      continue;
    }
    if (tableBuf) closeTable();

    // Lists
    const li = line.match(/^([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      flushPara();
      const tag = /^\d/.test(li[1]) ? 'ol' : 'ul';
      if (listOpen !== tag) { closeList(); listOpen = tag; html += `<${tag}>`; }
      html += `<li>${mdInline(li[2])}</li>`;
      continue;
    }
    closeList();

    // Blockquote
    if (line.startsWith('>')) {
      flushPara();
      html += '<blockquote>' + mdInline(line.replace(/^>\s?/, '')) + '</blockquote>';
      continue;
    }

    // Paragraph line — buffer so multi-line paragraphs format as one unit
    paraBuf.push(line);
  }
  flushPara(); closeList(); closeTable();
  if (inCode) html += '<pre><code>' + codeBuf.join('\n') + '</code></pre>';
  return html;
}

const SOURCES_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>IG Feed Watcher — Sources &amp; Cookies</title>
<style>
  :root {
    --bg: #0a0a0f; --card: #16161e; --border: #2a2a35;
    --text: #e4e4e7; --text-dim: #8a8a96; --accent: #6366f1;
    --accent-hover: #818cf8; --green: #10b981; --red: #ef4444;
    --radius: 12px;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:var(--bg); color:var(--text); min-height:100vh; padding:20px; }
  .header { display:flex; justify-content:space-between; align-items:center; margin-bottom:24px; flex-wrap:wrap; gap:12px; }
  .header h1 { font-size:24px; font-weight:700; }
  .header h1 span { color:var(--accent); }
  .back-link { color:var(--text-dim); text-decoration:none; font-size:14px; }
  .back-link:hover { color:var(--accent); }
  .section { background:var(--card); border:1px solid var(--border); border-radius:var(--radius); padding:20px; margin-bottom:20px; }
  .section h2 { font-size:16px; margin-bottom:4px; }
  .section .desc { font-size:13px; color:var(--text-dim); margin-bottom:16px; line-height:1.5; }
  code { background:#0d0d13; padding:2px 6px; border-radius:4px; font-size:12px; color:#c4b5fd; }
  .new-source-form { display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end; }
  .new-source-form label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--text-dim); }
  .new-source-form input, .new-source-form select { background:var(--bg); border:1px solid var(--border); color:var(--text); padding:8px 12px; border-radius:8px; font-size:14px; }
  .new-source-form input:focus, .new-source-form select:focus { outline:none; border-color:var(--accent); }
  .add-btn { background:var(--accent); color:white; border:none; padding:8px 16px; border-radius:8px; cursor:pointer; font-size:14px; white-space:nowrap; }
  .add-btn:hover { background:var(--accent-hover); }

  .source-card { background:var(--card); border:1px solid var(--border); border-left:4px solid var(--accent); border-radius:var(--radius); padding:20px; margin-bottom:16px; }
  .source-card.disabled { border-left-color:#555; opacity:0.8; }
  .source-header { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
  .source-title { display:flex; align-items:center; gap:10px; font-size:18px; font-weight:600; }
  .type-badge { font-size:11px; background:#0d0d13; border:1px solid var(--border); padding:2px 8px; border-radius:20px; color:var(--text-dim); text-transform:uppercase; letter-spacing:0.5px; }
  .status-dot { width:10px; height:10px; border-radius:50%; display:inline-block; }
  .source-actions { display:flex; gap:8px; }
  .source-actions button { background:var(--bg); border:1px solid var(--border); color:var(--text); padding:6px 12px; border-radius:8px; cursor:pointer; font-size:13px; }
  .source-actions button:hover { border-color:var(--accent); }
  .source-actions button.delete-btn:hover { border-color:var(--red); color:var(--red); }
  .field-row { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:12px; align-items:flex-end; }
  .field-row label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--text-dim); }
  .field-row input, .field-row select { background:var(--bg); border:1px solid var(--border); color:var(--text); padding:8px 12px; border-radius:8px; font-size:14px; }
  .cookies-box h3 { font-size:13px; text-transform:uppercase; color:var(--text-dim); margin-bottom:8px; letter-spacing:0.5px; }
  .cookie-chip { display:inline-block; background:var(--bg); border:1px solid var(--border); padding:4px 10px; border-radius:20px; font-size:12px; margin:0 6px 6px 0; }
  .cookie-chip.ok { border-color:#10b98155; color:var(--green); }
  textarea.cookies-json { width:100%; min-height:140px; background:#0d0d13; border:1px solid var(--border); color:var(--text); padding:10px; border-radius:8px; font-family:monospace; font-size:12px; resize:vertical; }
  textarea.cookies-json:focus { outline:none; border-color:var(--accent); }
  .hint { font-size:12px; color:var(--text-dim); margin-top:6px; line-height:1.5; }
  .toast { position:fixed; bottom:20px; right:20px; background:var(--green); color:white; padding:12px 20px; border-radius:8px; font-size:14px; opacity:0; transition:opacity 0.3s; pointer-events:none; }
  .toast.show { opacity:1; }
  .toast.error { background:var(--red); }
  .api-links { display:flex; flex-wrap:wrap; gap:8px; }
  .api-links a { background:var(--bg); border:1px solid var(--border); color:var(--text); padding:6px 12px; border-radius:8px; text-decoration:none; font-size:13px; }
  .api-links a:hover { border-color:var(--accent); }
  .empty { color:var(--text-dim); font-size:13px; font-style:italic; }

  /* Rendered Markdown docs (COOKIES-GUIDE.md + agent skill) */
  .md-doc { font-size:13px; line-height:1.6; color:var(--text); }
  .md-doc h1 { font-size:19px; margin:14px 0 8px; color:var(--accent); }
  .md-doc h2 { font-size:16px; margin:14px 0 6px; color:var(--accent); }
  .md-doc h3 { font-size:14px; margin:12px 0 4px; }
  .md-doc h4 { font-size:13px; margin:10px 0 4px; }
  .md-doc p { margin:6px 0; }
  .md-doc ul, .md-doc ol { margin:6px 0 6px 20px; }
  .md-doc li { margin:2px 0; }
  .md-doc code { background:#0d0d13; padding:2px 5px; border-radius:4px; font-size:12px; color:#c4b5fd; }
  .md-doc pre { background:#0d0d13; border:1px solid var(--border); border-radius:8px; padding:10px; overflow-x:auto; margin:8px 0; }
  .md-doc pre code { background:none; padding:0; }
  .md-doc table { border-collapse:collapse; width:100%; margin:8px 0; font-size:12px; }
  .md-doc th, .md-doc td { border:1px solid var(--border); padding:6px 10px; text-align:left; }
  .md-doc th { background:#0d0d13; color:var(--accent); }
  .md-doc blockquote { border-left:3px solid var(--accent); margin:8px 0; padding:4px 12px; color:var(--text-dim); }
  .md-doc hr { border:none; border-top:1px solid var(--border); margin:14px 0; }
  .md-doc a { color:var(--accent-hover); }
  .steps { margin:14px 0 4px; }
  .steps ol { margin:6px 0 0 20px; }
  .steps li { margin:6px 0; font-size:13px; line-height:1.5; }
  .steps code { background:#0d0d13; padding:2px 5px; border-radius:4px; font-size:12px; color:#c4b5fd; }
</style>
</head>
<body>

<div class="header">
  <h1>🔑 Sources <span>&amp; Cookies</span></h1>
  <div style="display:flex;gap:16px;align-items:center">
    <a href="/settings" class="back-link">🏷️ Groups</a>
    <a href="/" class="back-link">← Back to Explorer</a>
  </div>
</div>

<div class="section" id="account-section">
  <h2>Instagram account</h2>
  <div class="desc" id="account-desc">
    Paste your Instagram cookies below to connect the account the watcher reads
    the feed from. The cookies update the account immediately.
  </div>
  <div class="field-row">
    <label>Account name
      <input type="text" id="acct-name" placeholder="e.g. My Instagram">
    </label>
  </div>
  <div class="cookies-box">
    <h3>Cookies (JSON array)</h3>
    <textarea class="cookies-json" id="acct-cookies" placeholder='Paste cookies as a JSON array here, e.g. [{"name":"sessionid","value":"...","domain":".instagram.com"}]. Critical cookies: sessionid, ds_user_id, csrftoken.'></textarea>
    <div class="hint">Saving replaces ALL cookies for the account.</div>
  </div>
  <button class="add-btn" onclick="saveAccount()" id="acct-save-btn">💾 Add account</button>

  <div class="steps">
    <h3>Step-by-step: get your cookies</h3>
    <ol>
      <li>Open <b>Chrome or Edge</b> and go to <b>instagram.com</b>. Make sure you are <b>logged in</b> (you see your feed, not a login form).</li>
      <li>Press <b>F12</b> (or right-click → <b>Inspect</b>) to open Developer Tools.</li>
      <li>Click the <b>Application</b> tab (if hidden, use the <b>&gt;&gt;</b> menu).</li>
      <li>In the left sidebar expand <b>Cookies</b> and click <b>https://www.instagram.com</b>.</li>
      <li>Use the <b>Filter</b> box to find each cookie below, click its row, then copy its <b>Value</b> (double-click the value first to select it all, then Ctrl+C):</li>
      <li><code>sessionid</code> — long token, 30–60 characters (the important one)</li>
      <li><code>ds_user_id</code> — a number, 8–12 digits</li>
      <li><code>csrftoken</code> — 32 hex characters</li>
      <li>Build the JSON array and paste it into the <b>Cookies</b> box above, e.g.:
        <pre><code>[{"name":"sessionid","value":"...","domain":".instagram.com"},
 {"name":"ds_user_id","value":"...","domain":".instagram.com"},
 {"name":"csrftoken","value":"...","domain":".instagram.com"}]</code></pre>
      </li>
      <li>Click <b id="acct-step-btn">💾 Add account</b>. You should see the account name and a green <code>sessionid ✓</code> chip below.</li>
    </ol>
    <div class="hint">⚠️ <code>sessionid</code> is your Instagram password — anyone who has it can read your DMs and post as you. Never paste it into chat, email or screenshots.</div>
  </div>
</div>

<div id="sources-list"></div>

<div class="section" id="telegram-section">
  <h2>Telegram alerts</h2>
  <div class="desc">
    The watcher sends a photo + caption to your Telegram group when a new post
    appears. Create a bot with <b>@BotFather</b>, add it to your group, then
    paste the bot token and the group chat ID below (step-by-step in
    COOKIES-GUIDE.md). Leave a field blank to keep its current value.
  </div>
  <div class="field-row">
    <label>Bot token
      <input type="password" id="tg-token" autocomplete="off" placeholder="e.g. 123456:ABC-DEF...">
    </label>
    <label>Group chat ID
      <input type="text" id="tg-chat" placeholder="e.g. -1001234567890">
    </label>
    <button class="add-btn" onclick="saveTelegram()">💾 Save Telegram settings</button>
  </div>
  <div class="hint" id="tg-current"></div>
</div>

<div class="section">
  <h2>Data API &amp; Contract</h2>
  <div class="desc">Programmatic access to the feed database. The full OpenAPI contract is served at <code>/api/contract</code>.</div>
  <div class="api-links">
    <a href="/api/feeds" target="_blank">/api/feeds</a>
    <a href="/api/groups" target="_blank">/api/groups</a>
    <a href="/api/export" target="_blank">/api/export</a>
    <a href="/api/contract" target="_blank">/api/contract (OpenAPI)</a>
  </div>
</div>

<div class="section">
  <h2>📖 COOKIES-GUIDE.md</h2>
  <div class="md-doc">
${renderMarkdown(COOKIES_GUIDE_MD)}
  </div>
</div>

<div class="section">
  <h2>🤖 Agent skill — feed data API</h2>
  <div class="desc">For external agents: how to reach and query the feed database through the HTTP API and the <code>feed-cli.js</code> wrapper. The full OpenAPI contract is at <code>/api/contract</code>.</div>
  <div class="md-doc">
${renderMarkdown(FEED_API_SKILL_MD)}
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
let sources = [];

async function loadSources() {
  const res = await fetch('/api/sources');
  const data = await res.json();
  sources = data.sources || [];
  renderSources();
}

function renderSources() {
  const el = document.getElementById('sources-list');
  const btn = document.getElementById('acct-save-btn');
  const desc = document.getElementById('account-desc');
  const stepBtn = document.getElementById('acct-step-btn');
  if (sources.length === 0) {
    el.innerHTML = '';
    btn.textContent = '💾 Add account';
    if (stepBtn) stepBtn.textContent = '💾 Add account';
    desc.textContent = 'Paste your Instagram cookies below to connect the account the watcher reads the feed from. The cookies update the account immediately.';
    return;
  }
  btn.textContent = '💾 Save account';
  if (stepBtn) stepBtn.textContent = '💾 Save account';
  desc.textContent = 'This is the account the watcher reads the feed from. Paste cookies below to replace the ones currently stored for "' + escapeHtml(sources[0].name) + '" — or edit the account card below.';
  document.getElementById('acct-name').value = sources[0].name;
  el.innerHTML = sources.map(cardHtml).join('');
  // Populate dynamic fields via DOM (avoids escaping issues).
  for (const s of sources) {
    document.getElementById('src-name-' + s.id).value = s.name;
    document.getElementById('src-enabled-' + s.id).checked = !!s.enabled;
    const chips = document.getElementById('src-cookies-' + s.id);
    chips.innerHTML = (s.cookieNames || []).map(function (n) {
      const ok = (n === 'sessionid') ? ' ok' : '';
      return '<span class="cookie-chip' + ok + '">' + escapeHtml(n) + '</span>';
    }).join('') || '<span class="empty">No cookies configured</span>';
  }
}

// Create the first account (no sources yet) or replace the cookies of the
// existing single account. The API still supports multi-account creation for
// future use; this UI manages the one connected account.
async function saveAccount() {
  const name = document.getElementById('acct-name').value.trim();
  const raw = document.getElementById('acct-cookies').value.trim();
  if (!raw) { showToast('Paste cookies JSON first', true); return; }
  let cookies;
  try {
    cookies = JSON.parse(raw);
  } catch (e) {
    showToast('Invalid JSON: ' + e.message, true);
    return;
  }
  if (!Array.isArray(cookies) && cookies && Array.isArray(cookies.cookies)) {
    cookies = cookies.cookies;
  }
  if (!Array.isArray(cookies)) { showToast('Cookies must be a JSON array', true); return; }

  if (sources.length === 0) {
    const res = await fetch('/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name || 'Primary Instagram', type: 'instagram', enabled: true, cookies }),
    });
    const result = await res.json();
    if (result.ok) {
      document.getElementById('acct-cookies').value = '';
      showToast('Account connected');
      loadSources();
    } else {
      showToast('Error: ' + (result.error || 'failed'), true);
    }
    return;
  }

  // Update the existing (first) account: cookies always, name if changed.
  const s = sources[0];
  const tasks = [];
  if (name && name !== s.name) {
    tasks.push(fetch('/api/sources/' + s.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }));
  }
  tasks.push(fetch('/api/sources/' + s.id + '/cookies', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookies }),
  }));
  const results = await Promise.all(tasks);
  if (results.every(r => r.ok)) {
    document.getElementById('acct-cookies').value = '';
    showToast('Account updated');
    loadSources();
  } else {
    showToast('Error: ' + (results.find(r => !r.ok) ? 'failed to update account' : 'unknown'), true);
  }
}

function cardHtml(s) {
  const cls = s.enabled ? '' : ' disabled';
  const dot = s.enabled ? '#10b981' : '#555';
  const sess = s.hasSessionId ? 'sessionid ✓' : 'no sessionid';
  return '<div class="source-card' + cls + '" id="card-' + s.id + '">' +
    '<div class="source-header">' +
      '<div class="source-title">' +
        '<span class="status-dot" style="background:' + dot + '"></span>' +
        '<span>' + escapeHtml(s.name) + '</span>' +
        '<span class="type-badge">' + escapeHtml(s.type) + '</span>' +
      '</div>' +
      '<div class="source-actions">' +
        '<button onclick="saveCookies(\\'' + s.id + '\\')">💾 Save Cookies</button>' +
        '<button class="delete-btn" onclick="deleteSource(\\'' + s.id + '\\')">Delete</button>' +
      '</div>' +
    '</div>' +
    '<div class="field-row">' +
      '<label>Name<input type="text" id="src-name-' + s.id + '"></label>' +
      '<label>Enabled<input type="checkbox" id="src-enabled-' + s.id + '" style="width:20px;height:20px;accent-color:var(--accent)"></label>' +
      '<button class="add-btn" onclick="updateSource(\\'' + s.id + '\\')">Save Settings</button>' +
    '</div>' +
    '<div class="cookies-box">' +
      '<h3>Cookies — ' + s.cookieCount + ' set (' + sess + ')</h3>' +
      '<div id="src-cookies-' + s.id + '" style="margin-bottom:8px"></div>' +
      '<textarea class="cookies-json" id="src-cookie-json-' + s.id + '" placeholder=\\'Paste cookies as a JSON array here, e.g. [{"name":"sessionid","value":"...","domain":".instagram.com"}]. Saving replaces ALL cookies for this source.\\'></textarea>' +
      '<div class="hint">Export from your browser DevTools (Application → Cookies → instagram.com) — step-by-step in the guide below. Critical cookies: <code>sessionid</code>, <code>ds_user_id</code>, <code>csrftoken</code>.</div>' +
    '</div>' +
  '</div>';
}

async function updateSource(id) {
  const name = document.getElementById('src-name-' + id).value.trim();
  const enabled = document.getElementById('src-enabled-' + id).checked;
  if (!name) { showToast('Name is required', true); return; }
  const res = await fetch('/api/sources/' + id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, enabled }),
  });
  const result = await res.json();
  if (result.ok) { showToast('Source updated'); loadSources(); }
  else { showToast('Error: ' + (result.error || 'failed'), true); }
}

async function saveCookies(id) {
  const raw = document.getElementById('src-cookie-json-' + id).value.trim();
  if (!raw) { showToast('Paste cookies JSON first', true); return; }
  let cookies;
  try {
    cookies = JSON.parse(raw);
  } catch (e) {
    showToast('Invalid JSON: ' + e.message, true);
    return;
  }
  if (!Array.isArray(cookies) && cookies && Array.isArray(cookies.cookies)) {
    cookies = cookies.cookies;
  }
  if (!Array.isArray(cookies)) { showToast('Cookies must be a JSON array', true); return; }

  const res = await fetch('/api/sources/' + id + '/cookies', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookies }),
  });
  const result = await res.json();
  if (result.ok) {
    document.getElementById('src-cookie-json-' + id).value = '';
    showToast('Cookies saved (' + result.source.cookieCount + ' cookie(s))');
    loadSources();
  } else {
    showToast('Error: ' + (result.error || 'failed'), true);
  }
}

async function deleteSource(id) {
  const s = sources.find(function (x) { return x.id === id; });
  if (!s) return;
  if (!confirm('Delete source "' + s.name + '"? Its posts remain in the database.')) return;
  const res = await fetch('/api/sources/' + id, { method: 'DELETE' });
  const result = await res.json();
  if (result.ok) { showToast('Source deleted'); loadSources(); }
  else { showToast('Error: ' + (result.error || 'failed'), true); }
}

async function loadTelegramSettings() {
  const res = await fetch('/api/settings/telegram');
  const data = await res.json();
  const el = document.getElementById('tg-current');
  if (data.botTokenSet) {
    el.textContent = 'Bot token is set. Group chat ID: ' + (data.chatId || '(not set)');
  } else if (data.chatId) {
    el.textContent = 'Group chat ID is set. Bot token missing — add it above to enable alerts.';
  } else {
    el.textContent = 'Bot token and group chat ID not set yet — the watcher will not send Telegram alerts until you save them here.';
  }
}

async function saveTelegram() {
  const botToken = document.getElementById('tg-token').value.trim();
  const chatId = document.getElementById('tg-chat').value.trim();
  if (!botToken && !chatId) { showToast('Enter a bot token and/or a group chat ID', true); return; }
  const res = await fetch('/api/settings/telegram', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ botToken, chatId }),
  });
  const result = await res.json();
  if (result.ok) {
    document.getElementById('tg-token').value = '';
    document.getElementById('tg-chat').value = '';
    showToast('Telegram settings saved');
    loadTelegramSettings();
  } else {
    showToast('Error: ' + (result.error || 'failed'), true);
  }
}

function showToast(msg, isError) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(function () { toast.className = 'toast'; }, 2500);
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Init
loadSources();
loadTelegramSettings();
</script>
</body>
</html>`;

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log('IG Feed Explorer running on port ' + PORT);
  console.log('Database: ' + DB_PATH);
  console.log('Screenshots: ' + SCREENSHOTS_DIR);
});
