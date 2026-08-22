#!/usr/bin/env node
/**
 * IG Feed Watcher
 *
 * Headless Puppeteer script that:
 *  1. Loads Instagram with saved session cookies
 *  2. Scrapes the feed for post permalinks
 *  3. Detects new posts since last run
 *  4. For each new post:
 *     a. Extracts metadata (author, caption, timestamp, image URLs)
 *     b. Takes a screenshot
 *     c. Runs the custom hook script with post data as JSON on stdin
 *     d. Sends a Telegram notification (text + screenshot)
 *  5. Updates state file
 *
 * Designed to run as a cron job every 5 minutes.
 */

import puppeteer from 'puppeteer';
import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';
import { homedir } from 'os';
import { DatabaseSync } from 'node:sqlite';
import { listSources, getIngester, registerIngester, sanitizeCookies } from './sources.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

// ─── Config ───────────────────────────────────────────────────────────────────

// Read a KEY=VALUE from the environment first, then from .env.config.
// (The .env.config parser below is intentionally shared with Telegram config.)
function readConfigValue(key) {
  if (process.env[key] !== undefined && process.env[key] !== '') return process.env[key];
  try {
    const file = join(ROOT, '.env.config');
    if (!existsSync(file)) return undefined;
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* ignore unreadable config */ }
  return undefined;
}

// Default hook script: on Windows prefer the Node.js hook (no bash required);
// on Linux/macOS keep the original bash hook. Override with HOOK_SCRIPT in
// .env.config or the environment.
const DEFAULT_HOOK_FILE = process.platform === 'win32' ? 'on-new-post.js' : 'on-new-post.sh';

const CONFIG = {
  cookiesFile: join(ROOT, 'cookies.json'),
  stateFile: join(ROOT, 'state.json'),
  dbFile: join(ROOT, 'posts.db'),
  hookScript: readConfigValue('HOOK_SCRIPT') || join(ROOT, 'hooks', DEFAULT_HOOK_FILE),
  screenshotsDir: join(ROOT, 'screenshots'),
  logsDir: join(ROOT, 'logs'),
  priorityListFile: join(ROOT, 'priority-list.json'),
  groupsFile: join(ROOT, 'groups.json'),
  maxNewPostsPerRun: 10,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  pageTimeout: 60000,
  scrollCount: 3,
  debug: true,
  navWaitUntil: 'domcontentloaded',
  navRetries: 2,
  scrapeComments: true,
  maxCommentsPerPost: 50,
  commentLoadMoreClicks: 3,
  detailScrapeDelayMs: 3000,        // minimum delay between post-detail requests
  detailScrapeForMatchedOnly: true, // only open detail pages for matched posts (or likely-truncated captions)
  rateLimitCooldownMs: 30 * 60 * 1000, // pause detail scraping for 30 min after a 429/error page
};

let lastDetailRequestAt = 0;
let rateLimitHit = false;
let rateLimitUntil = 0;

function isErrorPageText(text) {
  if (!text) return false;
  return /HTTP ERROR 429|This page isn’t working|rate limit|Try Again Later|Restricted|Sorry, this page isn't available|Error/i.test(text);
}

function captionMayBeTruncated(caption) {
  if (!caption) return false;
  return caption.length >= 500 || /…|\.{3,}|more\s*$/i.test(caption);
}

async function throttleDetailRequest() {
  const delay = CONFIG.detailScrapeDelayMs || 0;
  if (delay <= 0) return;
  const now = Date.now();
  const wait = Math.max(0, lastDetailRequestAt + delay - now);
  if (wait > 0) {
    await new Promise(r => setTimeout(r, wait));
  }
  lastDetailRequestAt = Date.now();
}

// ─── Database ─────────────────────────────────────────────────────────────────

let db = null;

function initDB() {
  db = new DatabaseSync(CONFIG.dbFile);
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
    CREATE INDEX IF NOT EXISTS idx_posts_seen_at ON posts(seen_at);

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
  // Migrations: add columns introduced after the initial schema to
  // pre-existing databases. Each is best-effort (throws if already present).
  try { db.exec("ALTER TABLE posts ADD COLUMN matched_groups TEXT DEFAULT '[]'"); } catch {}
  try { db.exec("ALTER TABLE posts ADD COLUMN source_id TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE posts ADD COLUMN source_name TEXT DEFAULT ''"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_posts_source ON posts(source_id)"); } catch {}
  return db;
}

function saveCommentsToDB(shortcode, comments) {
  if (!db || !comments || comments.length === 0) return 0;
  let saved = 0;
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO comments (shortcode, author, text, timestamp, like_count)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const c of comments) {
    try {
      const result = stmt.run(
        shortcode,
        c.author || 'unknown',
        c.text || '',
        c.timestamp || null,
        c.likeCount || 0,
      );
      if (result.changes > 0) saved++;
    } catch (err) {
      log(`DB comment save error for ${shortcode}: ${err.message}`);
    }
  }
  return saved;
}

function savePostToDB(post, matchedGroups, screenshotPath) {
  if (!db) return;
  const matched = matchedGroups || [];
  const allReasons = matched.flatMap(g => g.reasons.map(r => `${g.name}: ${r}`));
  try {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO posts
        (shortcode, permalink, author, caption, timestamp, is_reel,
         is_priority, priority_reasons, image_urls, screenshot_path, scraped_at, matched_groups,
         source_id, source_name)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      post.shortcode,
      post.permalink,
      post.author || 'unknown',
      post.caption || '',
      post.timestamp || null,
      post.isReel ? 1 : 0,
      matched.length > 0 ? 1 : 0,
      JSON.stringify(allReasons),
      JSON.stringify(post.imageUrls || []),
      screenshotPath || null,
      post.scrapedAt || new Date().toISOString(),
      JSON.stringify(matched),
      post.source_id || '',
      post.source_name || '',
    );
  } catch (err) {
    log(`DB save error for ${post.shortcode}: ${err.message}`);
  }
}

function isPostInDB(shortcode) {
  if (!db) return false;
  const row = db.prepare('SELECT shortcode FROM posts WHERE shortcode = ?').get(shortcode);
  return !!row;
}

// ─── Interest Groups ──────────────────────────────────────────────────────────

function loadGroups() {
  // groups.json: { groups: [{id, name, color, accounts[], keywords[], hashtags[]}] }
  if (existsSync(CONFIG.groupsFile)) {
    try {
      const data = JSON.parse(readFileSync(CONFIG.groupsFile, 'utf-8'));
      return Array.isArray(data.groups) ? data.groups : [];
    } catch {
      log('WARNING: Failed to parse groups.json, using empty groups');
      return [];
    }
  }

  // Migration: build a first group from legacy priority-list.json
  if (existsSync(CONFIG.priorityListFile)) {
    try {
      const legacy = JSON.parse(readFileSync(CONFIG.priorityListFile, 'utf-8'));
      const group = {
        id: 'g_' + Date.now().toString(36),
        name: 'Priority',
        color: '#f59e0b',
        accounts: legacy.priorityAccounts || [],
        keywords: legacy.priorityKeywords || [],
        hashtags: legacy.priorityHashtags || [],
      };
      writeFileSync(CONFIG.groupsFile, JSON.stringify({ groups: [group] }, null, 2));
      log('Migrated priority-list.json into groups.json (group "Priority")');
      return [group];
    } catch {
      log('WARNING: Failed to migrate priority-list.json');
    }
  }

  return [];
}

function matchGroups(post, groups) {
  const matched = [];
  const authorLower = (post.author || '').toLowerCase();
  const captionLower = (post.caption || '').toLowerCase();

  for (const group of groups) {
    const reasons = [];

    if ((group.accounts || []).some(acct => authorLower.includes(acct.toLowerCase()))) {
      reasons.push(`account @${post.author}`);
    }

    const matchedKeywords = (group.keywords || []).filter(kw =>
      captionLower.includes(kw.toLowerCase())
    );
    if (matchedKeywords.length > 0) {
      reasons.push(`keyword "${matchedKeywords[0]}"`);
    }

    const matchedHashtags = (group.hashtags || []).filter(tag =>
      captionLower.includes(tag.toLowerCase())
    );
    if (matchedHashtags.length > 0) {
      reasons.push(`hashtag ${matchedHashtags[0]}`);
    }

    if (reasons.length > 0) {
      matched.push({ id: group.id, name: group.name, color: group.color || null, telegramThreadId: group.telegramThreadId || null, reasons });
    }
  }

  return matched;
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

function loadTelegramConfig() {
  // Parse a simple .env-style file into a dict
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
        // Strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        env[match[1]] = val;
      }
    }
    return env;
  }

  // 1. Try local .env.config first (user's own bot + channel)
  const localEnv = parseEnv(join(ROOT, '.env.config'));
  if (localEnv) {
    return {
      botToken: localEnv.TG_BOT_TOKEN || localEnv.TELEGRAM_BOT_TOKEN,
      chatId: localEnv.TELEGRAM_HOME_CHANNEL || localEnv.TG_CHAT_ID,
    };
  }

  // 2. Fall back to ~/.hermes/.env
  const envPath = join(homedir(), '.hermes', '.env');
  const hermesEnv = parseEnv(envPath);
  if (hermesEnv) {
    return {
      botToken: hermesEnv.TELEGRAM_BOT_TOKEN || hermesEnv.TG_BOT_TOKEN,
      chatId: hermesEnv.TELEGRAM_HOME_CHANNEL || hermesEnv.TG_CHAT_ID,
    };
  }

  // 3. Fall back to process env
  return {
    botToken: process.env.TG_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_HOME_CHANNEL || process.env.TG_CHAT_ID,
  };
}

async function sendTelegram(text, screenshotPath = null, threadId = null) {
  const tg = loadTelegramConfig();
  if (!tg.botToken || !tg.chatId) {
    log('ERROR: Telegram bot token or chat ID not configured');
    return;
  }

  try {
    if (screenshotPath && existsSync(screenshotPath)) {
      const { Buffer } = await import('node:buffer');
      const photoBuffer = readFileSync(screenshotPath);

      const boundary = '----FormBoundary' + Math.random().toString(16).slice(2);
      let headerStr =
        `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${tg.chatId}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${text}\r\n`;
      if (threadId) {
        headerStr += `--${boundary}\r\nContent-Disposition: form-data; name="message_thread_id"\r\n\r\n${threadId}\r\n`;
      }
      headerStr += `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="post.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`;
      const header = Buffer.from(headerStr);
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([header, photoBuffer, footer]);

      const resp = await fetch(
        `https://api.telegram.org/bot${tg.botToken}/sendPhoto`,
        {
          method: 'POST',
          headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
          body,
        }
      );
      const result = await resp.json();
      if (!result.ok) {
        log(`Telegram photo send failed: ${result.description}`);
        // Fallback to text
        await sendTelegramText(text, tg, threadId);
      }
    } else {
      await sendTelegramText(text, tg, threadId);
    }
  } catch (err) {
    log(`Telegram send error: ${err.message}`);
  }
}

async function sendTelegramText(text, tg, threadId = null) {
  const payload = {
    chat_id: tg.chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
  };
  if (threadId) {
    payload.message_thread_id = threadId;
  }
  const resp = await fetch(
    `https://api.telegram.org/bot${tg.botToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );
  const result = await resp.json();
  if (!result.ok) log(`Telegram text send failed: ${result.description}`);
}

// Telegram topic icon colors
const TG_ICON_COLORS = [0x6FB9F0, 0xFFD67E, 0xFF93B2, 0xFB6F5F, 0xE46F6F, 0xF0B6F6, 0x7FB9E0, 0xA6E22D];
function hexToTgIconColor(hex) {
  if (!hex || !hex.match(/^#[0-9a-fA-F]{6}$/)) return 0x6FB9F0;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  let best = TG_ICON_COLORS[0], bestDist = Infinity;
  for (const c of TG_ICON_COLORS) {
    const cr = (c >> 16) & 0xFF, cg = (c >> 8) & 0xFF, cb = c & 0xFF;
    const dist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (dist < bestDist) { bestDist = dist; best = c; }
  }
  return best;
}

async function createTelegramTopic(name, colorHex) {
  const tg = loadTelegramConfig();
  if (!tg.botToken || !tg.chatId) return null;
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
      log(`Telegram topic created for group "${name}": thread_id=${result.result.message_thread_id}`);
      return result.result.message_thread_id;
    }
    log(`Telegram topic creation failed for "${name}": ${result.description || 'unknown'}`);
    return null;
  } catch (err) {
    log(`Telegram topic creation error: ${err.message}`);
    return null;
  }
}

async function ensureGroupTopics(groups) {
  let changed = false;
  for (const group of groups) {
    if (!group.telegramThreadId) {
      const threadId = await createTelegramTopic(group.name, group.color);
      if (threadId) {
        group.telegramThreadId = threadId;
        changed = true;
      }
    }
  }
  if (changed) {
    writeFileSync(CONFIG.groupsFile, JSON.stringify({ groups }, null, 2));
    log('Updated groups.json with Telegram topic IDs');
  }
}

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.error(line); // stderr — cron captures this
  const logFile = join(CONFIG.logsDir, 'watcher.log');
  try {
    appendFileSync(logFile, line + '\n');
  } catch {}
}

// ─── State ────────────────────────────────────────────────────────────────────

function loadState() {
  if (!existsSync(CONFIG.stateFile)) {
    return { seenPosts: [], lastRun: null, lastPostTime: null, rateLimitUntil: null };
  }
  try {
    return JSON.parse(readFileSync(CONFIG.stateFile, 'utf-8'));
  } catch {
    return { seenPosts: [], lastRun: null, lastPostTime: null, rateLimitUntil: null };
  }
}

function saveState(state) {
  state.lastRun = new Date().toISOString();
  // Cap seenPosts at 500 to prevent unbounded growth
  if (state.seenPosts.length > 500) {
    state.seenPosts = state.seenPosts.slice(-500);
  }
  writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));
}

// ─── Cookies ──────────────────────────────────────────────────────────────────
//
// Cookies are supplied per source (see sources.js). sanitizeCookies() is
// imported from sources.js and normalizes the browser-DevTools / Puppeteer
// cookie shape. The legacy cookies.json path is handled by listSources().

// ─── Popup Dismissal ──────────────────────────────────────────────────────────

async function dismissPopups(page) {
  // Instagram shows various popups: "Turn on notifications", "Save your login info", etc.
  // Each has a "Not now" button. Try multiple strategies to click it.
  const popupTexts = ['Not now', 'Not Now', 'Cancel', 'Maybe later', 'No, thanks'];
  let dismissed = false;

  for (const text of popupTexts) {
    try {
      // Strategy 1: XPath — find button/link containing the text
      const elements = await page.$$('xpath/' + `//button[contains(text(), '${text}')] | //div[@role="button"][contains(text(), '${text}')] | //a[contains(text(), '${text}')]`);
      if (elements && elements.length > 0) {
        await elements[0].click();
        log(`Dismissed popup by clicking "${text}"`);
        dismissed = true;
        await page.waitForTimeout(1500);
        break;
      }
    } catch {}
  }

  // Strategy 2: XPath with contains (case-insensitive via translate)
  if (!dismissed) {
    try {
      const buttons = await page.$$('xpath/' + `//button[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'not now')]`);
      if (buttons && buttons.length > 0) {
        await buttons[0].click();
        log('Dismissed popup via case-insensitive "not now"');
        dismissed = true;
        await page.waitForTimeout(1500);
      }
    } catch {}
  }

  // Strategy 3: Look for any dialog/modal close button
  if (!dismissed) {
    try {
      const closeBtn = await page.$('[aria-label="Close"], [aria-label="Fechar"], button[class*="close"]');
      if (closeBtn) {
        await closeBtn.click();
        log('Dismissed popup via close button');
        dismissed = true;
        await page.waitForTimeout(1000);
      }
    } catch {}
  }

  if (!dismissed && CONFIG.debug) {
    log('DEBUG: No popup found to dismiss');
  }

  return dismissed;
}

// ─── Browser ──────────────────────────────────────────────────────────────────

async function createBrowser() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--window-size=1920,1080',
    ],
    executablePath: puppeteer.executablePath(),
  });

  const page = await browser.newPage();
  await page.setUserAgent(CONFIG.userAgent);
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setDefaultTimeout(CONFIG.pageTimeout);

  // Block unnecessary resources for speed
  await page.setRequestInterception(true);
  page.on('request', req => {
    const type = req.resourceType();
    if (type === 'font' || type === 'media') {
      req.abort();
    } else {
      req.continue();
    }
  });

  return { browser, page };
}

async function loadInstagram(page, cookies) {
  cookies = sanitizeCookies(cookies);
  log(`Loaded ${cookies.length} cookies`);

  // Set cookies before navigating
  for (const cookie of cookies) {
    try {
      await page.setCookie(cookie);
    } catch (e) {
      log(`Failed to set cookie ${cookie.name}: ${e.message}`);
    }
  }

  // Navigate with retries — Instagram can be slow and networkidle2 may never fire
  let navOk = false;
  for (let attempt = 1; attempt <= CONFIG.navRetries; attempt++) {
    try {
      log(`Navigating to instagram.com (attempt ${attempt}/${CONFIG.navRetries})...`);
      await page.goto('https://www.instagram.com/', {
        waitUntil: CONFIG.navWaitUntil,
        timeout: CONFIG.pageTimeout,
      });
      navOk = true;
      break;
    } catch (e) {
      log(`Navigation attempt ${attempt} failed: ${e.message}`);
      if (attempt < CONFIG.navRetries) {
        await page.waitForTimeout(3000);
      }
    }
  }

  if (!navOk) {
    throw new Error('All navigation attempts failed — Instagram may be blocking or rate-limiting');
  }

  // Wait for page to settle
  await page.waitForTimeout(5000);

  // Dismiss popups — "Turn on notifications", "Not now", etc.
  await dismissPopups(page);

  // Check if we're still logged in
  const url = page.url();
  if (url.includes('login') || url.includes('accounts/login')) {
    throw new Error('Session expired — cookies are invalid. Please re-export cookies.');
  }

  // Check for login wall / consent screens
  const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '');
  if (bodyText.includes('Log in') && !bodyText.includes('Stories')) {
    log('WARNING: Page shows login prompt. Session may be invalid.');
  }

  log('Instagram loaded successfully');
  return page;
}

// ─── Feed Scraping ────────────────────────────────────────────────────────────

async function scrapeFeed(page) {
  log('Scraping feed...');

  // Scroll to load posts
  for (let i = 0; i < CONFIG.scrollCount; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await page.waitForTimeout(2000);
    // Dismiss any popup that appears during scrolling
    await dismissPopups(page);
  }

  // DEBUG: dump article HTML structure for debugging selectors
  if (CONFIG.debug) {
    const debugInfo = await page.evaluate(() => {
      const articles = document.querySelectorAll('article');
      const info = {
        articleCount: articles.length,
        samples: [],
        bodySnippet: document.body?.innerText?.slice(0, 300) || '',
      };
      for (let i = 0; i < Math.min(2, articles.length); i++) {
        const a = articles[i];
        // Get all links with their href and text
        const links = Array.from(a.querySelectorAll('a[href]')).map(l => ({
          href: l.getAttribute('href'),
          text: l.textContent.trim().slice(0, 50),
          class: l.className.slice(0, 80),
        }));
        // Get header structure
        const header = a.querySelector('header');
        const headerHTML = header ? header.innerHTML.slice(0, 500) : 'no header';
        // Check for time elements
        const times = Array.from(a.querySelectorAll('time')).map(t => ({
          datetime: t.getAttribute('datetime'),
          text: t.textContent.trim(),
        }));
        // Check for caption-like elements
        const allDivs = Array.from(a.querySelectorAll('div'));
        const captionCandidates = allDivs.filter(d => d.children.length === 0 && d.textContent.trim().length > 20).map(d => ({
          text: d.textContent.trim().slice(0, 100),
          class: d.className.slice(0, 80),
        })).slice(0, 3);

        info.samples.push({ links, headerHTML, times, captionCandidates });
      }
      return info;
    });
    log(`DEBUG: ${debugInfo.articleCount} articles found`);
    log(`DEBUG: body snippet: ${debugInfo.bodySnippet.replace(/\n/g, ' ').slice(0, 200)}`);
    for (let i = 0; i < debugInfo.samples.length; i++) {
      const s = debugInfo.samples[i];
      log(`DEBUG: article[${i}] links: ${JSON.stringify(s.links.slice(0, 8))}`);
      log(`DEBUG: article[${i}] header: ${s.headerHTML.slice(0, 300)}`);
      log(`DEBUG: article[${i}] times: ${JSON.stringify(s.times)}`);
      log(`DEBUG: article[${i}] caption candidates: ${JSON.stringify(s.captionCandidates)}`);
    }
  }

  // Extract post data from the feed
  // Instagram feed posts are <article> elements containing <a> tags with /p/ links
  const posts = await page.evaluate(() => {
    const results = [];

    // Find all article elements (feed posts)
    const articles = document.querySelectorAll('article');

    for (const article of articles) {
      try {
        // Post permalink — look for <a href="/p/...">
        const postLink = article.querySelector('a[href*="/p/"]');
        if (!postLink) continue;
        const href = postLink.getAttribute('href');
        const permalink = href.startsWith('http') ? href : `https://www.instagram.com${href}`;

        // Extract shortcode from /p/SHORTCODE/
        const shortcodeMatch = permalink.match(/\/(p|reel)\/([^/?]+)/);
        const shortcode = shortcodeMatch ? shortcodeMatch[2] : null;
        if (!shortcode) continue;

        // Author — try multiple selectors
        // 1. header link with href to a profile (not /p/ or /reel/)
        const headerLinks = article.querySelectorAll('header a[href]');
        let author = 'unknown';
        for (const link of headerLinks) {
          const href = link.getAttribute('href') || '';
          // Profile links look like /username/ (not /p/, /reel/, /explore/)
          if (href.match(/^\/(?!p\/|reel\/|explore|accounts|direct|stories)[^/]+\/?$/)) {
            author = link.textContent.trim() || href.replace(/\//g, '');
            if (author) break;
          }
        }
        // 2. Fallback: any link with a profile-like href in the article
        if (author === 'unknown') {
          const allLinks = article.querySelectorAll('a[href]');
          for (const link of allLinks) {
            const href = link.getAttribute('href') || '';
            if (href.match(/^\/(?!p\/|reel\/|explore|accounts|direct|stories)[^/]+\/?$/)) {
              author = href.replace(/\//g, '');
              if (author) break;
            }
          }
        }
        // 3. Fallback: span with class containing 'username'
        if (author === 'unknown') {
          const usernameEl = article.querySelector('span[class*="username"], div[class*="username"] a, a[class*="username"]');
          if (usernameEl) author = usernameEl.textContent.trim();
        }

        // Timestamp
        const timeEl = article.querySelector('time');
        const timestamp = timeEl ? timeEl.getAttribute('datetime') : null;

        // Caption text — Instagram uses various structures
        let caption = '';
        const authorRe = new RegExp('^' + author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'i');
        // Method 1: data-testid="post-caption"
        const captionEl1 = article.querySelector('[data-testid="post-caption"] span, [data-testid="post-caption"]');
        if (captionEl1) caption = captionEl1.textContent.trim();
        // Method 2: Find the "more" button — its parent container holds the (truncated) caption
        if (!caption) {
          const moreBtn = Array.from(article.querySelectorAll('span[role="link"], span[role="button"], button'))
            .find(el => /^\.{0,3}\s*more\s*$/i.test(el.textContent.trim()));
          if (moreBtn) {
            const container = moreBtn.closest('span[dir]') || moreBtn.parentElement?.closest('span, div');
            if (container) {
              caption = container.textContent.trim()
                .replace(/\.{0,3}\s*more\s*$/i, '')
                .replace(authorRe, '')
                .trim();
            }
          }
        }
        // Method 3: Spans with substantial text (including nested children like hashtags/mentions)
        if (!caption) {
          const spans = article.querySelectorAll('span[dir="auto"], span');
          for (const span of spans) {
            const text = span.textContent.trim();
            if (text.length < 15) continue;
            if (span.closest('time') || span.querySelector('time')) continue;
            if (span.closest('header')) continue;
            if (/^\d+(h|m|d|w|s)\s*$/i.test(text)) continue;
            if (/^(Liked? by|others|reply|see translation|edited|verified|\d+ likes?|view all \d+ comments)/i.test(text)) continue;
            if (text === author) continue;
            const cleaned = text.replace(authorRe, '').trim();
            if (cleaned.length > 10) {
              caption = cleaned;
              break;
            }
          }
        }
        const captionText = caption.slice(0, 500);

        // Image URLs — collect all img src within the article
        const imgs = article.querySelectorAll('img[src]');
        const imageUrls = [];
        for (const img of imgs) {
          const src = img.src;
          if (src && src.includes('instagram') && !src.includes('emoji')) {
            imageUrls.push(src);
          }
        }

        // Post type — reel vs photo
        const isReel = permalink.includes('/reel/');

        results.push({
          shortcode,
          permalink,
          author,
          timestamp,
          caption: captionText,
          imageUrls,
          isReel,
          scrapedAt: new Date().toISOString(),
        });
      } catch (e) {
        // Skip this article on any error
      }
    }

    return results;
  });

  // DEBUG: save full page screenshot
  if (CONFIG.debug) {
    const debugScreenshot = join(CONFIG.screenshotsDir, `_debug_${Date.now()}.jpg`);
    await page.screenshot({ path: debugScreenshot, type: 'jpeg', quality: 60, fullPage: false }).catch(() => {});
    log(`DEBUG: full-page screenshot saved: ${debugScreenshot}`);
  }

  log(`Found ${posts.length} posts in feed`);
  return posts;
}

// ─── Post Processing ──────────────────────────────────────────────────────────

async function capturePostScreenshot(browser, page, post) {
  const screenshotPath = join(CONFIG.screenshotsDir, `${post.shortcode}.jpg`);

  // Prefer the actual post image(s) over a screenshot of the feed article.
  // Filter out small profile-picture thumbnails and emojis, then pick the first usable image.
  const imageUrls = (post.imageUrls || []).filter(url => !/s150x150|p150x150|emoji|\.svg/i.test(url));
  const imageUrl = imageUrls[0] || (post.imageUrls || [])[0];

  if (imageUrl && browser) {
    let imagePage = null;
    try {
      imagePage = await browser.newPage();
      await imagePage.setUserAgent(CONFIG.userAgent);
      await imagePage.setViewport({ width: 1920, height: 1080 });
      await imagePage.goto(imageUrl, { waitUntil: CONFIG.navWaitUntil, timeout: CONFIG.pageTimeout });
      await imagePage.waitForTimeout(1500);

      const img = await imagePage.$('img');
      if (img) {
        const box = await img.boundingBox();
        if (box && box.width >= 200 && box.height >= 200) {
          await imagePage.setViewport({
            width: Math.ceil(box.width),
            height: Math.ceil(box.height),
          });
          await imagePage.screenshot({
            path: screenshotPath,
            type: 'jpeg',
            quality: 85,
            clip: { x: 0, y: 0, width: Math.ceil(box.width), height: Math.ceil(box.height) },
          });
          log(`Saved actual post image for ${post.shortcode}: ${Math.round(box.width)}x${Math.round(box.height)}`);
          await imagePage.close();
          return screenshotPath;
        }
      }
    } catch (err) {
      log(`Could not save actual image for ${post.shortcode}: ${err.message}`);
    } finally {
      if (imagePage) {
        try { await imagePage.close(); } catch {}
      }
    }
  }

  // Fallback: screenshot the feed article as before.
  const articleHandle = await page.evaluateHandle((shortcode) => {
    const articles = document.querySelectorAll('article');
    for (const article of articles) {
      const link = article.querySelector(`a[href*="/p/${shortcode}"], a[href*="/reel/${shortcode}"]`);
      if (link) return article;
    }
    return null;
  }, post.shortcode);

  if (articleHandle) {
    try {
      await articleHandle.screenshot({
        path: screenshotPath,
        type: 'jpeg',
        quality: 80,
      }).catch(() => {});
    } catch {}
  }

  if (!existsSync(screenshotPath)) {
    await page.screenshot({
      path: screenshotPath,
      type: 'jpeg',
      quality: 70,
      fullPage: false,
    }).catch(() => {});
  }

  return existsSync(screenshotPath) ? screenshotPath : null;
}

// Resolve how to invoke a hook script on the current platform.
//  - .js     → run with the current Node.js executable (works everywhere)
//  - .cmd/.bat → run via cmd.exe (Windows)
//  - .sh     → run via bash (Linux/macOS, or Git Bash/WSL on Windows)
// Windows notes:
//  • cmd.exe /c strips the outer quotes of its argument, so a path containing
//    spaces must be double-quoted (""path"") AND passed with
//    windowsVerbatimArguments:true, otherwise the bare path is split on the
//    first space (e.g. "C:\My Projects\..." → tries to run "C:\My").
//  • Node's default spawn quoting (windowsVerbatimArguments:false) handles
//    spaced arguments for non-cmd executables (node.exe, bash) automatically.
function hookCommand(hookPath) {
  const ext = hookPath.split('.').pop().toLowerCase();
  if (process.platform === 'win32') {
    if (ext === 'cmd' || ext === 'bat') {
      return {
        file: 'cmd.exe',
        args: ['/d', '/s', '/c', `""${hookPath}""`],
        windowsVerbatimArguments: true,
      };
    }
    if (ext === 'js') return { file: process.execPath, args: [hookPath] };
    return { file: 'bash', args: [hookPath] }; // needs Git Bash or WSL installed
  }
  if (ext === 'js') return { file: process.execPath, args: [hookPath] };
  return { file: 'bash', args: [hookPath] };
}

async function runHookScript(post) {
  if (!existsSync(CONFIG.hookScript)) {
    log(`Hook script not found: ${CONFIG.hookScript} — skipping custom script`);
    return;
  }

  return new Promise((resolve) => {
    const { file, args, windowsVerbatimArguments } = hookCommand(CONFIG.hookScript);
    const child = spawn(file, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsVerbatimArguments,
    });

    const postData = JSON.stringify(post, null, 2);
    child.stdin.write(postData);
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());

    child.on('close', (code) => {
      if (code === 0) {
        log(`Hook script completed successfully. stdout: ${stdout.slice(0, 200)}`);
      } else {
        log(`Hook script exited with code ${code}. stderr: ${stderr.slice(0, 200)}`);
      }
      resolve({ stdout, stderr, code });
    });

    child.on('error', (err) => {
      log(`Hook script error: ${err.message}`);
      resolve({ error: err.message });
    });
  });
}

// ─── Comment Scraping ─────────────────────────────────────────────────────────

async function scrapePostDetail(browser, post) {
  log(`Scraping post detail for ${post.shortcode}...`);
  let commentPage = null;

  try {
    commentPage = await browser.newPage();
    await commentPage.setUserAgent(CONFIG.userAgent);
    await commentPage.setViewport({ width: 1920, height: 1080 });
    await commentPage.setDefaultTimeout(CONFIG.pageTimeout);

    await commentPage.goto(post.permalink, {
      waitUntil: CONFIG.navWaitUntil,
      timeout: CONFIG.pageTimeout,
    });
    await commentPage.waitForTimeout(4000);
    await dismissPopups(commentPage);

    // Check for Instagram rate-limit / error pages before trusting the content
    const pageCheck = await commentPage.evaluate(() => {
      const text = document.body ? document.body.innerText : '';
      const title = document.title || '';
      return { text, title };
    });
    if (isErrorPageText(pageCheck.text) || /error|429|rate limit|try again/i.test(pageCheck.title)) {
      log(`Rate-limit/error page detected for ${post.shortcode}`);
      return { caption: '', comments: [], rateLimited: true };
    }

    // Extract full caption from the post page (not truncated like in the feed)
    const fullCaption = await commentPage.evaluate((author) => {
      const authorRe = new RegExp('^' + author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'i');

      // Strategy 1: h1 element often wraps the author, caption is the next sibling or nearby span
      const h1 = document.querySelector('h1');
      if (h1) {
        const parent = h1.closest('div, span, li');
        if (parent) {
          const spans = parent.querySelectorAll('span');
          for (const span of spans) {
            if (span.closest('h1')) continue;
            const text = span.textContent.trim();
            if (text.length > 10 && !/^(Liked? by|reply|see translation|edited|\d+ likes?)/i.test(text)) {
              return text.slice(0, 2000);
            }
          }
          // Fallback: full parent text minus the author
          const parentText = parent.textContent.trim().replace(authorRe, '').trim();
          if (parentText.length > 10) return parentText.slice(0, 2000);
        }
      }

      // Strategy 2: Look for the article's first substantial text block
      const article = document.querySelector('article');
      if (article) {
        // On post pages, the caption is often in a <div> or <span> with dir="auto"
        const dirAutoEls = article.querySelectorAll('[dir="auto"]');
        for (const el of dirAutoEls) {
          if (el.closest('time') || el.querySelector('time')) continue;
          const text = el.textContent.trim().replace(authorRe, '').trim();
          if (text.length > 10 && !/^\d+(h|m|d|w|s)\s*$/i.test(text) &&
              !/^(Liked? by|reply|see translation|edited|\d+ likes?|view all|add a comment)/i.test(text)) {
            return text.slice(0, 2000);
          }
        }

        // Strategy 3: find spans near the author link
        const authorLink = article.querySelector(`a[href="/${author}/"], a[href="/${author}"]`);
        if (authorLink) {
          const container = authorLink.closest('div, li, span');
          if (container) {
            const text = container.textContent.trim().replace(authorRe, '').trim();
            if (text.length > 10) return text.slice(0, 2000);
          }
        }
      }

      // Strategy 4: broadest sweep — any large text block not in header/footer patterns
      const allSpans = document.querySelectorAll('article span, main span');
      for (const span of allSpans) {
        const text = span.textContent.trim();
        if (text.length < 20) continue;
        if (span.closest('time') || span.querySelector('time')) continue;
        if (/^(Liked? by|reply|see translation|edited|verified|\d+ likes?|view all|add a comment|log in)/i.test(text)) continue;
        const cleaned = text.replace(authorRe, '').trim();
        if (cleaned.length > 15) return cleaned.slice(0, 2000);
      }

      return '';
    }, post.author);

    if (fullCaption) {
      log(`Full caption extracted for ${post.shortcode}: ${fullCaption.slice(0, 80)}...`);
    } else {
      log(`No caption found on post page for ${post.shortcode}`);
    }

    // Comment scraping (only if enabled)
    if (!CONFIG.scrapeComments) {
      return { caption: fullCaption || '', comments: [] };
    }

    // Click "Load more comments" / "View more comments" a few times
    for (let i = 0; i < CONFIG.commentLoadMoreClicks; i++) {
      const clicked = await commentPage.evaluate(() => {
        // "+" load-more button (aria-label) or text buttons
        const loadMoreBtn =
          document.querySelector('button svg[aria-label="Load more comments"]')?.closest('button') ||
          Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"]')).find(b =>
            /view (all )?\d* ?(more )?comments|load more comments|view more comments/i.test(b.textContent.trim())
          );
        if (loadMoreBtn) {
          loadMoreBtn.click();
          return true;
        }
        return false;
      });
      if (!clicked) break;
      await commentPage.waitForTimeout(2500);
    }

    // Extract comments from the post page
    const comments = await commentPage.evaluate((maxComments) => {
      const results = [];
      const seen = new Set();

      // Comments live in <ul> lists; each comment contains a profile link + text span + time
      // Strategy: find all elements containing a <time> and a profile link — comment-like blocks
      const candidates = document.querySelectorAll('ul ul div[role="button"], ul li, article ul > div, article ul li');

      for (const el of candidates) {
        if (results.length >= maxComments) break;
        try {
          const timeEl = el.querySelector('time');
          if (!timeEl) continue;

          // Author: profile link (href like /username/)
          let author = null;
          const links = el.querySelectorAll('a[href]');
          for (const link of links) {
            const href = link.getAttribute('href') || '';
            if (href.match(/^\/(?!p\/|reel\/|explore|accounts|direct|stories)[^/]+\/?$/)) {
              author = link.textContent.trim() || href.replace(/\//g, '');
              if (author) break;
            }
          }
          if (!author) continue;

          // Text: longest leaf span that isn't the author name or a UI label
          let text = '';
          const spans = el.querySelectorAll('span');
          for (const span of spans) {
            if (span.children.length > 0 && !span.querySelector('a')) continue;
            const t = span.textContent.trim();
            if (
              t.length > text.length &&
              t !== author &&
              !t.match(/^\d+\s?(h|m|d|w|s)$/i) &&
              !t.match(/^(reply|like|likes|see translation|edited|verified)$/i) &&
              !t.match(/^\d+ likes?$/i)
            ) {
              text = t;
            }
          }
          if (!text) continue;

          // Like count: span like "3 likes"
          let likeCount = 0;
          for (const span of spans) {
            const m = span.textContent.trim().match(/^(\d[\d,.]*)\s+likes?$/i);
            if (m) {
              likeCount = parseInt(m[1].replace(/[,.]/g, ''), 10) || 0;
              break;
            }
          }

          const timestamp = timeEl.getAttribute('datetime') || null;

          const key = `${author}::${text}`;
          if (seen.has(key)) continue;
          seen.add(key);

          results.push({ author, text: text.slice(0, 2000), timestamp, likeCount });
        } catch {}
      }

      return results;
    }, CONFIG.maxCommentsPerPost);

    log(`Scraped ${comments.length} comment(s) for ${post.shortcode}`);
    return { caption: fullCaption || '', comments: CONFIG.scrapeComments ? comments : [], rateLimited: false };
  } catch (err) {
    log(`Post detail scraping failed for ${post.shortcode}: ${err.message}`);
    const rateLimited = /429|rate.?limit|too many requests|blocked/i.test(err.message);
    return { caption: '', comments: [], rateLimited };
  } finally {
    if (commentPage) {
      try { await commentPage.close(); } catch {}
    }
  }
}

async function processNewPost(browser, page, post, groups) {
  log(`Processing new post: ${post.shortcode} by @${post.author}`);

  // 1. Save the actual post image (falls back to a screenshot of the feed article)
  const screenshotPath = await capturePostScreenshot(browser, page, post);
  if (screenshotPath) log(`Screenshot saved: ${screenshotPath}`);

  // 2. Match groups with the feed caption first
  let matched = matchGroups(post, groups || []);
  let isMatched = matched.length > 0;

  // Only open detail pages for matched posts (or posts with a likely-truncated caption)
  // to avoid Instagram rate-limiting us when we open many post pages in a single run.
  const shouldDetail = !rateLimitHit &&
    (isMatched || captionMayBeTruncated(post.caption) || !CONFIG.detailScrapeForMatchedOnly);

  let detail = { caption: '', comments: [], rateLimited: false };
  if (shouldDetail) {
    await throttleDetailRequest();
    detail = await scrapePostDetail(browser, post);
    if (detail.rateLimited) {
      rateLimitHit = true;
      rateLimitUntil = Date.now() + CONFIG.rateLimitCooldownMs;
      log(`Rate limit detected; detail scraping paused for ${CONFIG.rateLimitCooldownMs / 60000} minutes`);
    }
    if (detail.caption && !isErrorPageText(detail.caption) && detail.caption.length > (post.caption || '').length) {
      post.caption = detail.caption;
      // Re-check groups with the full caption in case a keyword appears later in the text
      const rematched = matchGroups(post, groups || []);
      if (rematched.length > 0) {
        matched = rematched;
        isMatched = true;
      }
    }
  }

  const comments = detail.comments;
  if (isMatched) {
    log(`Groups matched: ${matched.map(g => g.name).join(', ')}`);
  }

  // 4. Save to database (with full caption)
  savePostToDB(post, matched, screenshotPath);

  if (comments.length > 0) {
    const saved = saveCommentsToDB(post.shortcode, comments);
    log(`Saved ${saved} comment(s) to DB for ${post.shortcode}`);
  }

  // 5. Run custom hook script (include group matches + comments in post data)
  const hookPostData = {
    ...post,
    priority: isMatched,
    priorityReasons: matched.flatMap(g => g.reasons.map(r => `${g.name}: ${r}`)),
    groups: matched,
    comments,
  };
  await runHookScript(hookPostData);

  // 6. Telegram notification — send to each matched group's own topic
  // Keep the message clean: screenshot + metadata only, no caption preview
  // (captions/comments are still stored in the DB and shown in the web explorer).
  const typeLabel = post.isReel ? '🎬 Reel' : '📸 Post';
  const timeLabel = post.timestamp
    ? `\n🕐 ${new Date(post.timestamp).toLocaleString()}`
    : '';
  const commentsLabel = comments.length > 0
    ? `\n💬 ${comments.length} comment(s) captured`
    : '';

  if (isMatched) {
    // Send to each matched group's Telegram topic
    for (const g of matched) {
      const groupLabel = `\n🎯 ${g.name}: ${g.reasons.join(', ')}`;
      const msg =
        `🚨 <b>${g.name}</b>\n` +
        `👤 <b>@${post.author}</b>\n` +
        `${typeLabel} — <a href="${post.permalink}">Open</a>` +
        `${groupLabel}${commentsLabel}${timeLabel}`;
      await sendTelegram(msg, screenshotPath, g.telegramThreadId || null);
    }
  } else {
    // No groups matched — send to main chat (no thread)
    const msg =
      `🚨 <b>New IG Feed Post</b>\n` +
      `👤 <b>@${post.author}</b>\n` +
      `${typeLabel} — <a href="${post.permalink}">Open</a>` +
      `${commentsLabel}${timeLabel}`;
    await sendTelegram(msg, screenshotPath, null);
  }
}

// ─── Source ingestion ─────────────────────────────────────────────────────────

// Ingest one Instagram source: launch a dedicated headless browser, log in with
// that source's cookies, scrape its home feed, and process new posts. The source
// id/name are stamped on every post so the database records which account a post
// came from. This is the built-in "instagram" ingester; other source types
// register their own via sources.js → registerIngester(type, fn).
async function ingestInstagramSource(source, ctx) {
  const { state, seenSet, groups } = ctx;
  log(`── Source "${source.name}" (${source.id}) — launching browser ──`);

  const cookies = sanitizeCookies(source.cookies);
  if (cookies.length === 0) {
    log(`Skipping source "${source.name}": no cookies configured`);
    return { ok: false, reason: 'no cookies', newPosts: 0 };
  }

  const { browser, page } = await createBrowser();
  try {
    await loadInstagram(page, cookies);

    const posts = await scrapeFeed(page);
    // Stamp the source on every scraped post.
    for (const p of posts) {
      p.source_id = source.id;
      p.source_name = source.name;
    }

    const newPosts = posts.filter(p => !seenSet.has(p.shortcode));
    log(`Source "${source.name}": found ${newPosts.length} new post(s) of ${posts.length} scraped`);

    // Sort: group-matched posts first
    const sortedNew = newPosts.sort((a, b) => {
      const aMatched = matchGroups(a, groups).length > 0 ? 0 : 1;
      const bMatched = matchGroups(b, groups).length > 0 ? 0 : 1;
      return aMatched - bMatched;
    });

    // Cap new posts per run
    const postsToProcess = sortedNew.slice(0, CONFIG.maxNewPostsPerRun);
    if (newPosts.length > CONFIG.maxNewPostsPerRun) {
      log(`Capped at ${CONFIG.maxNewPostsPerRun} (had ${newPosts.length} new)`);
    }

    const matchedCount = postsToProcess.filter(p => matchGroups(p, groups).length > 0).length;
    if (matchedCount > 0) {
      log(`⚡ ${matchedCount} group-matched post(s) in this batch`);
    }

    // Process each new post (matched first)
    for (const post of postsToProcess) {
      try {
        await processNewPost(browser, page, post, groups);
        seenSet.add(post.shortcode);
        state.seenPosts.push({ shortcode: post.shortcode, permalink: post.permalink, seenAt: new Date().toISOString() });
      } catch (err) {
        log(`Error processing post ${post.shortcode}: ${err.message}`);
      }
    }

    // Add all found posts to seen set + DB (even if not processed) to prevent backlog
    for (const post of posts) {
      if (!seenSet.has(post.shortcode)) {
        seenSet.add(post.shortcode);
        state.seenPosts.push({ shortcode: post.shortcode, permalink: post.permalink, seenAt: new Date().toISOString() });
        savePostToDB(post, matchGroups(post, groups), null);
      }
    }

    if (posts.length > 0 && posts[0].timestamp) {
      state.lastPostTime = posts[0].timestamp;
    }

    log(`Source "${source.name}": ${postsToProcess.length} new post(s) processed`);
    return { ok: true, newPosts: postsToProcess.length };
  } finally {
    try { await browser.close(); } catch {}
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runOnce() {
  log('═══════════════════════════════════════════');
  log('IG Feed Watcher — starting run');
  log('═══════════════════════════════════════════');

  // Ensure dirs exist
  for (const dir of [CONFIG.screenshotsDir, CONFIG.logsDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  // Initialize database
  initDB();
  log(`Database initialized: ${CONFIG.dbFile}`);

  // Load state (legacy flat file — still used for fast seen-check)
  const state = loadState();
  if (state.rateLimitUntil) {
    rateLimitUntil = state.rateLimitUntil;
    if (Date.now() < rateLimitUntil) {
      rateLimitHit = true;
      log(`Rate limit cooldown active until ${new Date(rateLimitUntil).toISOString()}; detail scraping skipped for this run`);
    }
  }
  const seenSet = new Set(state.seenPosts.map(p => p.shortcode || p));
  // Also load shortcodes from DB into the seen set
  if (db) {
    const dbRows = db.prepare('SELECT shortcode FROM posts').all();
    for (const row of dbRows) {
      seenSet.add(row.shortcode);
    }
    log(`State loaded: ${seenSet.size} posts previously seen (${dbRows.length} from DB, ${state.seenPosts.length} from state)`);
  } else {
    log(`State loaded: ${seenSet.size} posts previously seen`);
  }

  // Load interest groups
  const groups = loadGroups();
  log(`Groups loaded: ${groups.length} group(s) — ${groups.map(g => g.name).join(', ') || 'none'}`);

  // Ensure each group has a Telegram forum topic
  await ensureGroupTopics(groups);

  // Register the built-in Instagram ingester. Additional source types register
  // themselves through sources.js → registerIngester(type, fn).
  registerIngester('instagram', ingestInstagramSource);

  // Load sources and run each enabled one through its ingester.
  const sources = listSources();
  const enabled = sources.filter(s => s.enabled !== false);
  log(`Sources loaded: ${sources.length} total, ${enabled.length} enabled — ${enabled.map(s => `${s.name}[${s.type}]`).join(', ') || 'none'}`);

  if (enabled.length === 0) {
    log('No enabled sources — nothing to do. Configure sources via the /settings page.');
  }

  for (const source of enabled) {
    const type = source.type || 'instagram';
    const ingester = getIngester(type);
    if (!ingester) {
      log(`Skipping source "${source.name}": no ingester registered for type "${type}"`);
      continue;
    }
    try {
      await ingester(source, { state, seenSet, groups });
    } catch (err) {
      log(`Source "${source.name}" failed: ${err.message}`);
      if (CONFIG.debug && err.stack) log(`Stack: ${err.stack}`);
      await sendTelegram(`⚠️ <b>IG Watcher Error</b> (${source.name})\n${err.message.slice(0, 200)}`);
    }
  }

  state.rateLimitUntil = rateLimitUntil;
  saveState(state);
  log(`Run complete. Total seen: ${state.seenPosts.length}`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────
//
// Run modes:
//   node watcher.js              → one pass, then exit (cron / Task Scheduler)
//   node watcher.js --loop [n]   → stay alive, run a pass every n minutes
//                                  (default 5). Self-contained scheduling for
//                                  Windows and other machines without cron.
function parseLoopInterval(argv = process.argv) {
  const idx = argv.indexOf('--loop');
  if (idx === -1) return 0;
  const n = parseInt(argv[idx + 1], 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

const LOOP_MINUTES = parseLoopInterval();

async function main() {
  if (LOOP_MINUTES > 0) {
    const intervalMs = LOOP_MINUTES * 60 * 1000;
    log(`Continuous loop mode: checking every ${LOOP_MINUTES} minute(s). Keep this window open.`);
    const tick = async () => {
      try {
        await runOnce();
      } catch (err) {
        log(`Loop run failed: ${err.message}`);
        if (CONFIG.debug && err.stack) log(`Stack: ${err.stack}`);
      }
      setTimeout(tick, intervalMs);
    };
    await tick();
  } else {
    await runOnce();
  }
}

main().catch(err => {
  log(`Unhandled error: ${err.message}`);
  process.exit(1);
});
