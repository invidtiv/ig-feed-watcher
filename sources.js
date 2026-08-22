/**
 * Sources — multi-account / multi-source configuration and ingest registry.
 *
 * A "source" is one place the watcher ingests posts from. Today that is an
 * Instagram account (type: "instagram"), each with its own session cookies so
 * the watcher can launch a separate headless browser per account. The `type`
 * field plus the ingester registry below is the seam that future-proofs
 * ingestion from other sources (RSS feeds, an HTTP JSON feed, another social
 * network, ...) without touching the watcher's core loop.
 *
 * File layout
 * -----------
 *   sources.json            — the live config (gitignored: it holds secrets)
 *   sources.example.json    — tracked template
 *   cookies.json            — legacy single-account cookies (still supported)
 *
 * sources.json shape
 * ------------------
 * {
 *   "sources": [
 *     {
 *       "id": "ig-primary",
 *       "name": "Primary Instagram",
 *       "type": "instagram",          // registered ingester type
 *       "enabled": true,
 *       "cookies": [ { "name", "value", "domain", "path", "secure", "httpOnly", "sameSite" } ]
 *     }
 *   ]
 * }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

export const SOURCES_FILE = process.env.SOURCES_FILE || join(ROOT, 'sources.json');
export const LEGACY_COOKIES_FILE = process.env.COOKIES_FILE || join(ROOT, 'cookies.json');

// ─── Ingester registry (the future-proofing seam) ─────────────────────────────
//
// Each source type maps to an async ingest function with the signature:
//     async function ingest(source, ctx) -> { ok, newPosts?, reason? }
//   where ctx carries watcher runtime state:
//     { state, seenSet, groups, log }
// New source types register here at startup; the watcher loop is agnostic.
const INGESTERS = new Map();

export function registerIngester(type, fn) {
  if (typeof type !== 'string' || typeof fn !== 'function') {
    throw new Error('registerIngester(type, fn) requires a type string and an async function');
  }
  INGESTERS.set(type, fn);
}

export function getIngester(type) {
  return INGESTERS.get(type) || null;
}

export function listIngesterTypes() {
  return Array.from(INGESTERS.keys());
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// Normalize a cookies array into the Puppeteer/DevTools cookie shape and drop
// anything without a name+value. Returns a fresh array (no live references).
export function sanitizeCookies(cookies) {
  if (!Array.isArray(cookies)) return [];
  return cookies
    .filter(c => c && typeof c === 'object' && typeof c.name === 'string' && c.name)
    .map(c => ({
      name: c.name,
      value: typeof c.value === 'string' ? c.value : String(c.value ?? ''),
      domain: c.domain || '.instagram.com',
      path: c.path || '/',
      expires: c.expires ?? c.expirationDate ?? -1,
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? true,
      sameSite: c.sameSite || 'Lax',
    }));
}

// A source suitable for public/API display — cookie VALUES are never exposed,
// only names and whether the critical sessionid is present.
export function sourceToPublic(source) {
  const cookies = sanitizeCookies(source.cookies);
  const names = cookies.map(c => c.name);
  return {
    id: source.id,
    name: source.name,
    type: source.type || 'instagram',
    enabled: source.enabled !== false,
    cookieNames: names,
    hasSessionId: names.includes('sessionid'),
    cookieCount: cookies.length,
    createdAt: source.createdAt || null,
    updatedAt: source.updatedAt || null,
  };
}

// ─── Persistence ───────────────────────────────────────────────────────────────

export function listSources() {
  if (existsSync(SOURCES_FILE)) {
    try {
      const data = JSON.parse(readFileSync(SOURCES_FILE, 'utf-8'));
      const sources = Array.isArray(data.sources) ? data.sources : [];
      // Normalize cookies on the way out so callers always get the same shape.
      return sources.map(s => ({ ...s, type: s.type || 'instagram', enabled: s.enabled !== false, cookies: sanitizeCookies(s.cookies) }));
    } catch (err) {
      console.error(`[sources] Failed to parse ${SOURCES_FILE}: ${err.message}`);
    }
  }

  // Legacy fallback: a single source backed by cookies.json.
  if (existsSync(LEGACY_COOKIES_FILE)) {
    try {
      const cookies = sanitizeCookies(JSON.parse(readFileSync(LEGACY_COOKIES_FILE, 'utf-8')));
      return [{
        id: 'ig-legacy',
        name: 'Primary (cookies.json)',
        type: 'instagram',
        enabled: true,
        cookies,
        createdAt: null,
        updatedAt: null,
      }];
    } catch (err) {
      console.error(`[sources] Failed to parse legacy ${LEGACY_COOKIES_FILE}: ${err.message}`);
    }
  }

  return [];
}

export function getSource(id) {
  return listSources().find(s => s.id === id) || null;
}

export function saveSources(sources) {
  const clean = (Array.isArray(sources) ? sources : [])
    .filter(s => s && s.id && s.name)
    .map(s => ({ ...s, type: s.type || 'instagram', enabled: s.enabled !== false, cookies: sanitizeCookies(s.cookies) }));
  const payload = { sources: clean, updatedAt: new Date().toISOString() };
  mkdirSync(dirname(SOURCES_FILE), { recursive: true });
  writeFileSync(SOURCES_FILE, JSON.stringify(payload, null, 2));
  return clean;
}

// Create or update a source by id (or generate one). Returns the saved source.
export function upsertSource(source) {
  const sources = listSources();
  const id = source.id || newId('src');
  const existing = sources.find(s => s.id === id);
  const now = new Date().toISOString();
  const record = {
    ...(existing || {}),
    ...source,
    id,
    type: source.type || existing?.type || 'instagram',
    enabled: source.enabled !== undefined ? source.enabled !== false : (existing ? existing.enabled !== false : true),
    cookies: source.cookies !== undefined ? sanitizeCookies(source.cookies) : sanitizeCookies(existing?.cookies),
    updatedAt: now,
    createdAt: existing?.createdAt || now,
  };

  if (existing) {
    saveSources(sources.map(s => (s.id === id ? record : s)));
  } else {
    saveSources([...sources, record]);
  }
  return record;
}

export function deleteSource(id) {
  const sources = listSources();
  if (!sources.some(s => s.id === id)) return false;
  saveSources(sources.filter(s => s.id !== id));
  return true;
}

// Replace just the cookies for a source (the settings page "insert cookie
// values" flow). Returns the updated source or null if it does not exist.
export function setSourceCookies(id, cookies) {
  const sources = listSources();
  const source = sources.find(s => s.id === id);
  if (!source) return null;
  const updated = { ...source, cookies: sanitizeCookies(cookies), updatedAt: new Date().toISOString() };
  saveSources(sources.map(s => (s.id === id ? updated : s)));
  return updated;
}
