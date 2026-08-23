import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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

test('retention removes only expired image files and clears their database paths', () => {
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
    matched_groups TEXT,
    seen_at TEXT,
    scraped_at TEXT,
    timestamp TEXT
  )`);
  const insert = db.prepare('INSERT INTO posts VALUES (?, ?, ?, ?, NULL, NULL)');
  insert.run('expired', expiredPath, '[]', '2026-01-01 00:00:00');
  insert.run('fresh', freshPath, '[]', '2026-01-25 00:00:00');

  const result = runImageRetention({
    db,
    screenshotsDir,
    groups: [],
    mode: 1,
    globalDays: 14,
    now: new Date('2026-02-01T00:00:00Z'),
  });

  assert.deepEqual(result, { checked: 1, expired: 1, deleted: 1, missing: 0, errors: 0 });
  assert.equal(existsSync(expiredPath), false);
  assert.equal(existsSync(freshPath), true);
  assert.equal(db.prepare('SELECT screenshot_path FROM posts WHERE shortcode = ?').get('expired').screenshot_path, null);
  assert.equal(db.prepare('SELECT screenshot_path FROM posts WHERE shortcode = ?').get('fresh').screenshot_path, freshPath);
});
