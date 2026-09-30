import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';

import { effectiveRetentionDays, runImageRetention } from '../retention.js';

test('mode 2 gives a multi-group image the longest group retention', () => {
  const groups = [
    { id: 'short', retention_days: 7 },
    { id: 'long', retention_days: 30 },
  ];
  const matched = JSON.stringify([{ id: 'short' }, { id: 'long' }]);

  assert.equal(effectiveRetentionDays(2, 14, matched, groups), 30);
  assert.equal(effectiveRetentionDays(2, 14, JSON.stringify([{ id: 'short' }]), groups), 7);
  assert.equal(effectiveRetentionDays(2, 14, '[]', groups), 14);
  assert.equal(effectiveRetentionDays(1, 14, matched, groups), 14);
  assert.equal(effectiveRetentionDays(0, 14, matched, groups), null);
});

test('mode 2 falls back to global retention when a matched group has no override', () => {
  const groups = [{ id: 'default' }, { id: 'short', retention_days: 7 }];
  const matched = JSON.stringify([{ id: 'default' }, { id: 'short' }]);
  assert.equal(effectiveRetentionDays(2, 14, matched, groups), 14);
});

test('retention deletes images at twice their retention and clears their database paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ig-retention-'));
  const screenshotsDir = join(root, 'screenshots');
  mkdirSync(screenshotsDir);
  const expiredPath = join(screenshotsDir, 'expired.jpg');
  const freshPath = join(screenshotsDir, 'fresh.jpg');
  writeFileSync(expiredPath, 'expired');
  writeFileSync(freshPath, 'fresh');

  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE posts (
    shortcode TEXT PRIMARY KEY,
    screenshot_path TEXT,
    screenshot_downsized INTEGER DEFAULT 0,
    matched_groups TEXT,
    seen_at TEXT,
    scraped_at TEXT,
    timestamp TEXT
  )`);
  const insert = db.prepare('INSERT INTO posts VALUES (?, ?, 0, ?, ?, NULL, NULL)');
  insert.run('expired', expiredPath, '[]', '2026-01-01 00:00:00');
  insert.run('fresh', freshPath, '[]', '2026-01-25 00:00:00');

  const result = await runImageRetention({
    db,
    screenshotsDir,
    groups: [],
    mode: 1,
    globalDays: 14,
    now: new Date('2026-02-01T00:00:00Z'),
  });

  assert.deepEqual(result, { checked: 1, expired: 1, downsized: 0, deleted: 1, missing: 0, errors: 0 });
  assert.equal(existsSync(expiredPath), false);
  assert.equal(existsSync(freshPath), true);
  assert.equal(db.prepare('SELECT screenshot_path FROM posts WHERE shortcode = ?').get('expired').screenshot_path, null);
  assert.equal(db.prepare('SELECT screenshot_path FROM posts WHERE shortcode = ?').get('fresh').screenshot_path, freshPath);
});

test('retention shrinks an expired image to 10% of each dimension once, then deletes it later', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ig-retention-'));
  const screenshotsDir = join(root, 'screenshots');
  mkdirSync(screenshotsDir);
  const imagePath = join(screenshotsDir, 'expired.jpg');
  await sharp({ create: { width: 1080, height: 1350, channels: 3, background: '#808080' } }).jpeg().toFile(imagePath);

  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE posts (
    shortcode TEXT PRIMARY KEY,
    screenshot_path TEXT,
    screenshot_downsized INTEGER DEFAULT 0,
    matched_groups TEXT,
    seen_at TEXT,
    scraped_at TEXT,
    timestamp TEXT
  )`);
  db.prepare('INSERT INTO posts VALUES (?, ?, 0, ?, ?, NULL, NULL)').run('expired', imagePath, '[]', '2026-01-10 00:00:00');
  const run = now => runImageRetention({ db, screenshotsDir, groups: [], mode: 1, globalDays: 14, now: new Date(now) });
  const row = () => db.prepare('SELECT screenshot_path, screenshot_downsized FROM posts WHERE shortcode = ?').get('expired');

  assert.deepEqual(await run('2026-02-01T00:00:00Z'), { checked: 1, expired: 1, downsized: 1, deleted: 0, missing: 0, errors: 0 });
  const { width, height } = await sharp(readFileSync(imagePath)).metadata();
  assert.deepEqual({ width, height }, { width: 108, height: 135 });
  assert.deepEqual({ ...row() }, { screenshot_path: imagePath, screenshot_downsized: 1 });

  assert.deepEqual(await run('2026-02-02T00:00:00Z'), { checked: 1, expired: 0, downsized: 0, deleted: 0, missing: 0, errors: 0 });
  assert.equal((await sharp(readFileSync(imagePath)).metadata()).width, 108);

  assert.deepEqual(await run('2026-02-07T00:00:00Z'), { checked: 1, expired: 1, downsized: 0, deleted: 1, missing: 0, errors: 0 });
  assert.equal(existsSync(imagePath), false);
  assert.equal(row().screenshot_path, null);
});

test('overlapping retention runs shrink an image only once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ig-retention-'));
  const screenshotsDir = join(root, 'screenshots');
  mkdirSync(screenshotsDir);
  const imagePath = join(screenshotsDir, 'expired.jpg');
  await sharp({ create: { width: 1080, height: 1080, channels: 3, background: '#808080' } }).jpeg().toFile(imagePath);

  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE posts (
    shortcode TEXT PRIMARY KEY,
    screenshot_path TEXT,
    screenshot_downsized INTEGER DEFAULT 0,
    matched_groups TEXT,
    seen_at TEXT,
    scraped_at TEXT,
    timestamp TEXT
  )`);
  db.prepare('INSERT INTO posts VALUES (?, ?, 0, ?, ?, NULL, NULL)').run('expired', imagePath, '[]', '2026-01-10 00:00:00');
  const run = () => runImageRetention({ db, screenshotsDir, groups: [], mode: 1, globalDays: 14, now: new Date('2026-02-01T00:00:00Z') });

  const results = await Promise.all([run(), run()]);
  assert.equal(results[0].downsized + results[1].downsized, 1);
  assert.equal((await sharp(readFileSync(imagePath)).metadata()).width, 108);
  assert.deepEqual(readdirSync(screenshotsDir), ['expired.jpg']);
});

test('a failed shrink is not marked as a thumbnail and is retried on the next run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ig-retention-'));
  const screenshotsDir = join(root, 'screenshots');
  mkdirSync(screenshotsDir);
  const imagePath = join(screenshotsDir, 'broken.jpg');
  writeFileSync(imagePath, 'not an image');

  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE posts (
    shortcode TEXT PRIMARY KEY,
    screenshot_path TEXT,
    screenshot_downsized INTEGER DEFAULT 0,
    matched_groups TEXT,
    seen_at TEXT,
    scraped_at TEXT,
    timestamp TEXT
  )`);
  db.prepare('INSERT INTO posts VALUES (?, ?, 0, ?, ?, NULL, NULL)').run('broken', imagePath, '[]', '2026-01-10 00:00:00');
  const run = () => runImageRetention({ db, screenshotsDir, groups: [], mode: 1, globalDays: 14, now: new Date('2026-02-01T00:00:00Z') });

  assert.equal((await run()).errors, 1);
  assert.equal(db.prepare('SELECT screenshot_downsized FROM posts WHERE shortcode = ?').get('broken').screenshot_downsized, 0);

  await sharp({ create: { width: 1080, height: 1080, channels: 3, background: '#808080' } }).jpeg().toFile(imagePath);
  assert.equal((await run()).downsized, 1);
  assert.equal((await sharp(readFileSync(imagePath)).metadata()).width, 108);
});
