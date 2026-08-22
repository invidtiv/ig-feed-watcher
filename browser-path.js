// ─────────────────────────────────────────────────────────────────────────────
// Shared browser-path helper (used by watcher.js and poster.js)
//
// Portable/installer model (M2): the installer ships Chromium inside the app
// folder at <app>\.puppeteer-cache (set via PUPPETEER_CACHE_DIR at build time).
// This helper prefers that bundled copy so the app works with zero downloads
// and without relying on environment variables (which the Windows scheduled
// task cannot easily set via New-ScheduledTaskAction).
//
// Solution A / Docker / dev: no .puppeteer-cache next to the app → falls back
// to Puppeteer's standard resolution (PUPPETEER_CACHE_DIR env var, or the
// default user cache), which is exactly the previous behavior.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const ROOT = dirname(fileURLToPath(import.meta.url));

// Recursively find a file by name under dir (e.g. chrome.exe).
function findFile(dir, name) {
  if (!existsSync(dir)) return null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(p, name);
      if (found) return found;
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return p;
    }
  }
  return null;
}

// Returns the absolute path to a Chromium executable to launch with Puppeteer.
export function resolveChromeExecutable() {
  const bundled = findFile(join(ROOT, '.puppeteer-cache'), 'chrome.exe');
  if (bundled) return bundled;
  return puppeteer.executablePath();
}
