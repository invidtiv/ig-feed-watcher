#!/usr/bin/env node
/**
 * IG Login Helper
 *
 * Opens a NON-headless browser for you to log into Instagram.
 * After login, exports your session cookies to cookies.json.
 *
 * Run this once to set up your session:
 *   node login.js
 *
 * Then the headless watcher uses cookies.json for all subsequent runs.
 *
 * NOTE: This requires a display. On a headless server, you have two options:
 *   1. Export cookies from your desktop browser's DevTools manually
 *      (Application → Cookies → instagram.com → copy all)
 *   2. Run this script via X11 forwarding or VNC
 *
 * For headless servers, use export-cookies-from-browser.md for instructions.
 */

import puppeteer from 'puppeteer';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('Launching browser for Instagram login...');
  console.log('Please log in to your Instagram account.');
  console.log('After logging in, press Enter in this terminal to export cookies.');

  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,900'],
    executablePath: puppeteer.executablePath(),
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36');

  await page.goto('https://www.instagram.com/accounts/login/', {
    waitUntil: 'networkidle2',
  });

  console.log('\nBrowser opened. Log in to Instagram.');
  console.log('Once you see your feed, come back here and press Enter.\n');

  // Wait for user to press Enter
  await new Promise(resolve => {
    process.stdin.resume();
    process.stdin.once('data', resolve);
  });

  // Export cookies
  const client = await page.target().createCDPSession();
  const { cookies } = await client.send('Network.getAllCookies');

  const cookiesFile = join(__dirname, 'cookies.json');
  writeFileSync(cookiesFile, JSON.stringify(cookies, null, 2));
  console.log(`\nExported ${cookies.length} cookies to ${cookiesFile}`);
  console.log('You can now run the watcher: node watcher.js');

  await browser.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
