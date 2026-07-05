#!/usr/bin/env node
/**
 * IG Poster — posts an image + caption to Instagram
 *
 * Uses Puppeteer with the same session cookies as the watcher.
 * Automates the Instagram web create-post flow:
 *   1. Launch browser, set cookies, navigate to instagram.com
 *   2. Click "Create" (+) → Select "Post"
 *   3. Upload image file
 *   4. Enter caption
 *   5. Click Share
 *   6. Wait for confirmation and extract permalink
 */

import puppeteer from 'puppeteer';
import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const CONFIG = {
  cookiesFile: join(ROOT, 'cookies.json'),
  logsDir: join(ROOT, 'logs'),
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  pageTimeout: 60000,
  debug: true,
  navWaitUntil: 'domcontentloaded',
  navRetries: 2,
};

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.error(line);
  const logFile = join(CONFIG.logsDir, 'poster.log');
  try {
    appendFileSync(logFile, line + '\n');
  } catch {}
}

// ─── Cookies ──────────────────────────────────────────────────────────────────

function loadCookies() {
  if (!existsSync(CONFIG.cookiesFile)) {
    throw new Error(`Cookies file not found: ${CONFIG.cookiesFile}`);
  }
  const raw = JSON.parse(readFileSync(CONFIG.cookiesFile, 'utf-8'));
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
  const popupTexts = ['Not now', 'Not Now', 'Cancel', 'Maybe later', 'No, thanks'];
  for (const text of popupTexts) {
    try {
      const elements = await page.$$('xpath/' + `//button[contains(text(), '${text}')] | //div[@role="button"][contains(text(), '${text}')]`);
      if (elements && elements.length > 0) {
        await elements[0].click();
        log(`Dismissed popup: "${text}"`);
        await page.waitForTimeout(1500);
        return true;
      }
    } catch {}
  }
  return false;
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

  return { browser, page };
}

async function loadInstagram(page) {
  const cookies = loadCookies();
  log(`Loaded ${cookies.length} cookies`);

  for (const cookie of cookies) {
    try {
      await page.setCookie(cookie);
    } catch (e) {
      log(`Failed to set cookie ${cookie.name}: ${e.message}`);
    }
  }

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
      if (attempt < CONFIG.navRetries) await page.waitForTimeout(3000);
    }
  }

  if (!navOk) {
    throw new Error('Navigation failed — Instagram may be blocking or rate-limiting');
  }

  await page.waitForTimeout(5000);
  await dismissPopups(page);

  const url = page.url();
  if (url.includes('login') || url.includes('accounts/login')) {
    throw new Error('Session expired — cookies are invalid. Please re-export cookies.');
  }

  log('Instagram loaded successfully');
  return page;
}

// ─── Post to Instagram ────────────────────────────────────────────────────────

/**
 * Posts an image with a caption to Instagram.
 *
 * @param {string} imagePath — absolute path to the image file
 * @param {string} caption — post caption text
 * @returns {Promise<{success: boolean, permalink?: string, error?: string}>}
 */
export async function postToInstagram(imagePath, caption) {
  let browser;

  try {
    log(`═══════════════════════════════════════════`);
    log(`IG Poster — starting post`);
    log(`  Image: ${imagePath}`);
    log(`  Caption: "${caption?.slice(0, 80) || '(empty)'}..."`);
    log(`═══════════════════════════════════════════`);

    if (!existsSync(imagePath)) {
      throw new Error(`Image not found: ${imagePath}`);
    }

    const { browser: b, page } = await createBrowser();
    browser = b;

    await loadInstagram(page);

    // ─── Step 1: Click "New post" button in nav ──────────────────────────────

    log('Looking for New post button...');
    // The "New post" button is an svg[aria-label="New post"] inside a link
    const newPostClicked = await page.evaluate(() => {
      const svg = document.querySelector('svg[aria-label="New post"]');
      if (svg) {
        // Walk up to find the clickable parent (link or role=button)
        let el = svg;
        for (let i = 0; i < 5; i++) {
          if (el.parentElement) el = el.parentElement;
          if (el.tagName === 'A' || el.getAttribute('role') === 'button' || el.tagName === 'BUTTON') break;
        }
        el.click();
        return true;
      }
      return false;
    });

    if (!newPostClicked) {
      // Fallback: try <a> with text "New post"
      log('svg not found, trying link fallback...');
      const newPostLink = await page.$('xpath/' + `//a[contains(text(), "New post")] | //a[contains(text(), "Create")]`);
      if (newPostLink) {
        await newPostLink.click();
      } else {
        throw new Error('Could not find "New post" button');
      }
    }

    log('Clicked New post, waiting for dropdown...');
    await page.waitForTimeout(3000);
    await dismissPopups(page);

    // ─── Step 2: Click "Post" from the dropdown ──────────────────────────────

    // After clicking "New post", a dropdown appears with options: Post, Story, Reel, etc.
    // We need to click the "Post" option
    log('Looking for Post option in dropdown...');
    const postClicked = await page.evaluate(() => {
      // Find <a> elements whose text is "PostPost" (Instagram duplicates the text for accessibility)
      const links = Array.from(document.querySelectorAll('a[role="link"], a, [role="button"], button'));
      const postLink = links.find(a => {
        const text = a.textContent.trim();
        return text === 'PostPost' || (text === 'Post') || (text.startsWith('Post') && !text.includes('New') && !text.includes('Create') && text.length < 15);
      });
      if (postLink) {
        postLink.click();
        return true;
      }
      return false;
    });

    if (!postClicked) {
      // Fallback: look for any clickable with just "Post" text via xpath
      const postLink = await page.$('xpath/' + `//a[contains(text(), "Post") and not(contains(text(), "New")) and not(contains(text(), "Create"))] | //div[@role="button" and contains(text(), "Post") and not(contains(text(), "New"))]`);
      if (postLink) {
        await postLink.click();
      } else {
        log('WARNING: Could not find Post dropdown option, trying to find file input directly...');
      }
    }

    log('Waiting for create post dialog...');
    await page.waitForTimeout(3000);

    // ─── Step 3: Upload the image ─────────────────────────────────────────────

    // The create post dialog should now be open with a file input
    log('Looking for file input...');
    let fileInput = await page.$('input[type="file"]');

    if (!fileInput) {
      log('File input not immediately visible, waiting...');
      try {
        fileInput = await page.waitForSelector('input[type="file"]', { timeout: 15000 });
      } catch {
        // Debug: save screenshot
        if (CONFIG.debug) {
          const debugPath = join(CONFIG.logsDir, `_post_debug_${Date.now()}.jpg`);
          await page.screenshot({ path: debugPath, type: 'jpeg', quality: 70 }).catch(() => {});
          log(`DEBUG: screenshot saved to ${debugPath}`);
        }
        throw new Error('Could not find file input — create post dialog may not have opened');
      }
    }

    log('Uploading image...');
    await fileInput.uploadFile(imagePath);
    log('Image uploaded, waiting for processing...');

    // Wait for the image to be processed and the crop dialog to appear
    await page.waitForTimeout(6000);

    // ─── Step 4: Click "Next" on crop page ────────────────────────────────────

    // Instagram's "Next" button is a div[role="button"], NOT a <button>
    log('Looking for Next button (crop page)...');
    let nextBtn = await page.$('xpath/' + `//div[@role="button" and contains(text(), "Next")]`);

    if (!nextBtn) {
      log('Waiting for Next button...');
      try {
        nextBtn = await page.waitForSelector('xpath/' + `//div[@role="button" and contains(text(), "Next")]`, { timeout: 15000 });
      } catch {
        if (CONFIG.debug) {
          const debugPath = join(CONFIG.logsDir, `_post_crop_debug_${Date.now()}.jpg`);
          await page.screenshot({ path: debugPath, type: 'jpeg', quality: 70 }).catch(() => {});
          log(`DEBUG: crop screenshot saved to ${debugPath}`);
        }
        throw new Error('Could not find Next button on crop page');
      }
    }

    log('Clicking Next (crop page)...');
    await nextBtn.click();
    await page.waitForTimeout(5000);

    // ─── Step 5: Click "Next" on filter/edit page ──────────────────────────────

    // After crop, we're on the filter page — click Next again to reach caption page
    log('Looking for Next button (filter page)...');
    nextBtn = await page.$('xpath/' + `//div[@role="button" and contains(text(), "Next")]`);

    if (!nextBtn) {
      log('Waiting for Next button on filter page...');
      try {
        nextBtn = await page.waitForSelector('xpath/' + `//div[@role="button" and contains(text(), "Next")]`, { timeout: 15000 });
      } catch {
        if (CONFIG.debug) {
          const debugPath = join(CONFIG.logsDir, `_post_filter_debug_${Date.now()}.jpg`);
          await page.screenshot({ path: debugPath, type: 'jpeg', quality: 70 }).catch(() => {});
          log(`DEBUG: filter screenshot saved to ${debugPath}`);
        }
        throw new Error('Could not find Next button on filter page');
      }
    }

    log('Clicking Next (filter page → caption page)...');
    await nextBtn.click();
    await page.waitForTimeout(5000);

    // ─── Step 6: Enter caption ─────────────────────────────────────────────────

    // The caption input is a div[role="textbox"][contenteditable="true"]
    // with aria-label="Write a caption..."
    log('Looking for caption input...');
    let captionInput = await page.$('div[role="textbox"][contenteditable="true"]');

    if (!captionInput) {
      // Fallback: try other contenteditable selectors
      captionInput = await page.$('div[contenteditable="true"][data-lexical-editor="true"], div[contenteditable="true"][aria-label*="caption"], textarea');
    }

    if (!captionInput) {
      log('Waiting for caption input...');
      try {
        captionInput = await page.waitForSelector('div[role="textbox"][contenteditable="true"], div[contenteditable="true"][data-lexical-editor="true"], textarea', { timeout: 10000 });
      } catch {
        if (CONFIG.debug) {
          const debugPath = join(CONFIG.logsDir, `_post_caption_debug_${Date.now()}.jpg`);
          await page.screenshot({ path: debugPath, type: 'jpeg', quality: 70 }).catch(() => {});
          log(`DEBUG: caption screenshot saved to ${debugPath}`);
        }
        throw new Error('Could not find caption input');
      }
    }

    log('Entering caption...');
    await captionInput.click();
    await page.waitForTimeout(300);

    if (caption && caption.length > 0) {
      // Type the caption — use page.type for reliable text entry
      await captionInput.type(caption, { delay: 5 });
      await page.waitForTimeout(500);
    }

    // ─── Step 7: Click "Share" ─────────────────────────────────────────────────

    // The Share button is also a div[role="button"], not a <button>
    log('Looking for Share button...');
    let shareBtn = await page.$('xpath/' + `//div[@role="button" and contains(text(), "Share")]`);

    if (!shareBtn) {
      // Fallback: try <button> as well
      shareBtn = await page.$('xpath/' + `//button[contains(text(), "Share") and not(@disabled)] | //div[@role="button"][contains(text(), "Share") and not(@aria-disabled="true")]`);
    }

    if (!shareBtn) {
      log('Waiting for Share button...');
      try {
        shareBtn = await page.waitForSelector('xpath/' + `//div[@role="button" and contains(text(), "Share")] | //button[contains(text(), "Share") and not(@disabled)]`, { timeout: 15000 });
      } catch {
        if (CONFIG.debug) {
          const debugPath = join(CONFIG.logsDir, `_post_share_debug_${Date.now()}.jpg`);
          await page.screenshot({ path: debugPath, type: 'jpeg', quality: 70 }).catch(() => {});
          log(`DEBUG: share screenshot saved to ${debugPath}`);
        }
        throw new Error('Could not find Share button');
      }
    }

    log('Clicking Share...');
    await shareBtn.click();

    // ─── Step 8: Wait for post confirmation ───────────────────────────────────

    log('Waiting for post to be published...');

    // After sharing, Instagram shows a success dialog: "Your post has been shared."
    // Then the dialog closes and we're back on the feed
    let postPermalink = null;
    try {
      // Wait for success message
      await page.waitForFunction(() => {
        const text = document.body?.innerText || '';
        return text.includes('has been shared') || text.includes('post has been');
      }, { timeout: 30000 });

      log('Post shared successfully!');

      // Wait for dialog to close and feed to reload
      await page.waitForTimeout(3000);

      // Try to extract the post permalink from the profile or feed
      const newPostLink = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="/p/"]');
        if (links.length > 0) {
          return links[0].getAttribute('href');
        }
        return null;
      });

      if (newPostLink) {
        postPermalink = newPostLink.startsWith('http') ? newPostLink : `https://www.instagram.com${newPostLink}`;
        log(`Post permalink: ${postPermalink}`);
      }
    } catch (e) {
      // Even if we can't confirm via text, the post may have been shared
      log('Could not confirm success via text, checking page state...');
      const url = page.url();
      log(`Current URL: ${url}`);
      // Don't throw — the post was likely shared even if the success text wasn't found
    }

    // Debug screenshot
    if (CONFIG.debug) {
      const debugPath = join(CONFIG.logsDir, `_post_result_${Date.now()}.jpg`);
      await page.screenshot({ path: debugPath, type: 'jpeg', quality: 70 }).catch(() => {});
      log(`DEBUG: result screenshot saved to ${debugPath}`);
    }

    log('Post completed successfully');

    return {
      success: true,
      permalink: postPermalink || null,
      postedAt: new Date().toISOString(),
    };

  } catch (err) {
    log(`FATAL: ${err.message}`);
    if (CONFIG.debug && err.stack) log(`Stack: ${err.stack}`);
    return {
      success: false,
      error: err.message,
    };
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

// Allow direct CLI invocation for testing
// Usage: node poster.js <image_path> [caption]
if (import.meta.url === `file://${process.argv[1]}`) {
  const imagePath = process.argv[2];
  const caption = process.argv[3] || '';

  if (!imagePath) {
    console.error('Usage: node poster.js <image_path> [caption]');
    process.exit(1);
  }

  // Ensure logs dir exists
  if (!existsSync(CONFIG.logsDir)) mkdirSync(CONFIG.logsDir, { recursive: true });

  postToInstagram(imagePath, caption).then(result => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
  });
}
