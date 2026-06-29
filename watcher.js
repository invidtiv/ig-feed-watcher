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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  cookiesFile: join(ROOT, 'cookies.json'),
  stateFile: join(ROOT, 'state.json'),
  hookScript: join(ROOT, 'hooks', 'on-new-post.sh'),
  screenshotsDir: join(ROOT, 'screenshots'),
  logsDir: join(ROOT, 'logs'),
  maxNewPostsPerRun: 10,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  pageTimeout: 60000,
  scrollCount: 3,
  debug: true,
  navWaitUntil: 'domcontentloaded',
  navRetries: 2,
};

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

async function sendTelegram(text, screenshotPath = null) {
  const tg = loadTelegramConfig();
  if (!tg.botToken || !tg.chatId) {
    log('ERROR: Telegram bot token or chat ID not configured');
    return;
  }

  try {
    if (screenshotPath && existsSync(screenshotPath)) {
      // Send photo with caption
      const FormData = (await import('node:buffer')).default;
      const { Buffer } = await import('node:buffer');
      const photoBuffer = readFileSync(screenshotPath);

      const boundary = '----FormBoundary' + Math.random().toString(16).slice(2);
      const header = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${tg.chatId}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${text}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="post.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`
      );
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
        await sendTelegramText(text, tg);
      }
    } else {
      await sendTelegramText(text, tg);
    }
  } catch (err) {
    log(`Telegram send error: ${err.message}`);
  }
}

async function sendTelegramText(text, tg) {
  const resp = await fetch(
    `https://api.telegram.org/bot${tg.botToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: tg.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      }),
    }
  );
  const result = await resp.json();
  if (!result.ok) log(`Telegram text send failed: ${result.description}`);
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
    return { seenPosts: [], lastRun: null, lastPostTime: null };
  }
  try {
    return JSON.parse(readFileSync(CONFIG.stateFile, 'utf-8'));
  } catch {
    return { seenPosts: [], lastRun: null, lastPostTime: null };
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

function loadCookies() {
  if (!existsSync(CONFIG.cookiesFile)) {
    throw new Error(`Cookies file not found: ${CONFIG.cookiesFile}`);
  }
  const raw = JSON.parse(readFileSync(CONFIG.cookiesFile, 'utf-8'));

  // Accept both browser DevTools format and Puppeteer format
  // DevTools format: [{name, value, domain, path, expires, httpOnly, secure, sameSite}]
  // Puppeteer format: [{name, value, domain, path, expires, httpOnly, secure, sameSite}]
  // They're basically the same; just ensure domain is right for instagram

  return raw.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain || '.instagram.com',
    path: c.path || '/',
    expires: c.expires || c.expirationDate || -1,
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? true,
    sameSite: c.sameSite || 'Lax',
  }));
}

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

async function loadInstagram(page) {
  const cookies = loadCookies();
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
        // Try: 1. data-testid, 2. div with long text after image, 3. any long text span
        let caption = '';
        // Method 1: data-testid="post-caption"
        const captionEl1 = article.querySelector('[data-testid="post-caption"] span, [data-testid="post-caption"]');
        if (captionEl1) caption = captionEl1.textContent.trim();
        // Method 2: Look for div/span with >30 chars text that isn't a link
        if (!caption) {
          const textEls = article.querySelectorAll('span, div');
          for (const el of textEls) {
            if (el.children.length === 0) {
              const text = el.textContent.trim();
              // Skip timestamps, usernames, short UI text
              if (text.length > 30 && !el.closest('a') && !el.querySelector('time') && !text.match(/^\d+(h|m|d|w)/)) {
                caption = text;
                break;
              }
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

async function capturePostScreenshot(page, post) {
  const screenshotPath = join(CONFIG.screenshotsDir, `${post.shortcode}.jpg`);

  // Find the article with this post's link and screenshot it
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

  // Fallback: full page screenshot
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

async function runHookScript(post) {
  if (!existsSync(CONFIG.hookScript)) {
    log(`Hook script not found: ${CONFIG.hookScript} — skipping custom script`);
    return;
  }

  return new Promise((resolve) => {
    const child = spawn('bash', [CONFIG.hookScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
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

async function processNewPost(page, post) {
  log(`Processing new post: ${post.shortcode} by @${post.author}`);

  // 1. Screenshot
  const screenshotPath = await capturePostScreenshot(page, post);
  if (screenshotPath) log(`Screenshot saved: ${screenshotPath}`);

  // 2. Run custom hook script
  await runHookScript(post);

  // 3. Telegram notification
  const typeLabel = post.isReel ? '🎬 Reel' : '📸 Post';
  const captionPreview = post.caption
    ? `\n💬 "${post.caption.slice(0, 150)}${post.caption.length > 150 ? '...' : ''}"`
    : '';
  const timeLabel = post.timestamp
    ? `\n🕐 ${new Date(post.timestamp).toLocaleString()}`
    : '';

  const message =
    `🚨 <b>New IG Feed Post</b>\n` +
    `👤 <b>@${post.author}</b>\n` +
    `${typeLabel} — <a href="${post.permalink}">Open</a>` +
    `${captionPreview}${timeLabel}`;

  await sendTelegram(message, screenshotPath);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log('═══════════════════════════════════════════');
  log('IG Feed Watcher — starting run');
  log('═══════════════════════════════════════════');

  // Ensure dirs exist
  for (const dir of [CONFIG.screenshotsDir, CONFIG.logsDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  // Load state
  const state = loadState();
  const seenSet = new Set(state.seenPosts.map(p => p.shortcode || p));
  log(`State loaded: ${seenSet.size} posts previously seen`);

  let browser;
  try {
    // Launch browser and load Instagram
    const { browser: b, page } = await createBrowser();
    browser = b;

    await loadInstagram(page);

    // Scrape feed
    const posts = await scrapeFeed(page);

    // Filter new posts
    const newPosts = posts.filter(p => !seenSet.has(p.shortcode));
    log(`Found ${newPosts.length} new post(s)`);

    // Cap new posts per run
    const postsToProcess = newPosts.slice(0, CONFIG.maxNewPostsPerRun);
    if (newPosts.length > CONFIG.maxNewPostsPerRun) {
      log(`Capped at ${CONFIG.maxNewPostsPerRun} (had ${newPosts.length} new)`);
    }

    // Process each new post
    for (const post of postsToProcess) {
      try {
        await processNewPost(page, post);
        // Mark as seen
        seenSet.add(post.shortcode);
        state.seenPosts.push({ shortcode: post.shortcode, permalink: post.permalink, seenAt: new Date().toISOString() });
      } catch (err) {
        log(`Error processing post ${post.shortcode}: ${err.message}`);
      }
    }

    // Add all found posts to seen set (even if not processed) to prevent backlog
    for (const post of posts) {
      if (!seenSet.has(post.shortcode)) {
        seenSet.add(post.shortcode);
        state.seenPosts.push({ shortcode: post.shortcode, permalink: post.permalink, seenAt: new Date().toISOString() });
      }
    }

    // Update last post time
    if (posts.length > 0 && posts[0].timestamp) {
      state.lastPostTime = posts[0].timestamp;
    }

    saveState(state);
    log(`Run complete. ${postsToProcess.length} new post(s) processed. Total seen: ${state.seenPosts.length}`);

  } catch (err) {
    log(`FATAL: ${err.message}`);
    if (CONFIG.debug && err.stack) log(`Stack: ${err.stack}`);

    // Send error alert to Telegram
    await sendTelegram(`⚠️ <b>IG Watcher Error</b>\n${err.message.slice(0, 200)}`);
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

main().catch(err => {
  log(`Unhandled error: ${err.message}`);
  process.exit(1);
});
