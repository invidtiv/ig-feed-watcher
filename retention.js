import { existsSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import sharp from 'sharp';

function retentionDays(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function matchedGroupIds(value) {
  try {
    const matches = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(matches)
      ? matches.map(match => match && match.id).filter(id => typeof id === 'string')
      : [];
  } catch {
    return [];
  }
}

export function effectiveRetentionDays(mode, globalDaysValue, matchedGroups, groups) {
  if (mode !== 1 && mode !== 2) return null;
  const globalDays = retentionDays(globalDaysValue);
  if (globalDays === null) return null;
  if (mode === 1) return globalDays;

  const byId = new Map((Array.isArray(groups) ? groups : []).map(group => [group.id, group]));
  const ids = matchedGroupIds(matchedGroups);
  if (ids.length === 0) return globalDays;

  return Math.max(...ids.map(id => retentionDays(byId.get(id)?.retention_days) ?? globalDays));
}

function timestampMillis(row) {
  const value = row.seen_at || row.scraped_at || row.timestamp;
  if (!value) return null;
  const normalized = typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const millis = Date.parse(normalized);
  return Number.isFinite(millis) ? millis : null;
}

// Expired images are first shrunk to 10% of each dimension and kept as
// thumbnails; they are deleted once they reach twice their retention period.
export async function runImageRetention({ db, screenshotsDir, groups, mode, globalDays, now = new Date() }) {
  const result = { checked: 0, expired: 0, downsized: 0, deleted: 0, missing: 0, errors: 0 };
  const parsedGlobalDays = retentionDays(globalDays);
  if ((mode !== 1 && mode !== 2) || parsedGlobalDays === null) return result;

  const configuredGroupDays = mode === 2
    ? (Array.isArray(groups) ? groups : []).map(group => retentionDays(group.retention_days)).filter(days => days !== null)
    : [];
  const shortestPossibleDays = Math.min(parsedGlobalDays, ...configuredGroupDays);
  const earliestCandidate = new Date(now.getTime() - shortestPossibleDays * 86_400_000).toISOString();

  const rows = db.prepare(`
    SELECT shortcode, screenshot_path, matched_groups, seen_at, scraped_at, timestamp
    FROM posts
    WHERE screenshot_path IS NOT NULL AND screenshot_path != ''
      AND julianday(COALESCE(seen_at, scraped_at, timestamp)) <= julianday(?)
  `).all(earliestCandidate);
  const clearPath = db.prepare('UPDATE posts SET screenshot_path = NULL WHERE shortcode = ?');
  const claimDownsize = db.prepare('UPDATE posts SET screenshot_downsized = 1 WHERE shortcode = ? AND COALESCE(screenshot_downsized, 0) = 0');
  const releaseDownsize = db.prepare('UPDATE posts SET screenshot_downsized = 0 WHERE shortcode = ?');
  const nowMillis = now.getTime();
  const safeDir = resolve(screenshotsDir);

  for (const row of rows) {
    result.checked++;
    const recordedAt = timestampMillis(row);
    const days = effectiveRetentionDays(mode, globalDays, row.matched_groups, groups);
    if (recordedAt === null || days === null) continue;
    const age = nowMillis - recordedAt;
    const deleteDue = age >= 2 * days * 86_400_000;
    if (age < days * 86_400_000) continue;
    // The watcher and the explorer both run retention on the same files.
    // Claiming the row before the async resize means an overlapping run
    // skips it instead of shrinking an already-shrunk image again.
    if (!deleteDue && claimDownsize.run(row.shortcode).changes === 0) continue;

    result.expired++;
    // Watcher screenshots are flat files. Resolving from basename prevents a
    // corrupted database path from touching anything outside screenshotsDir.
    const imagePath = join(safeDir, basename(row.screenshot_path));
    const tempPath = `${imagePath}.tmp`;
    try {
      if (!existsSync(imagePath)) {
        result.missing++;
        clearPath.run(row.shortcode);
      } else if (deleteDue) {
        unlinkSync(imagePath);
        result.deleted++;
        clearPath.run(row.shortcode);
      } else {
        const original = readFileSync(imagePath);
        const { width, height } = await sharp(original).metadata();
        const tenth = size => Math.max(1, Math.round(size / 10));
        // Write beside the original and swap it in, so a crash never leaves
        // a half-written image behind.
        writeFileSync(tempPath, await sharp(original).resize(tenth(width), tenth(height), { fit: 'fill' }).toBuffer());
        renameSync(tempPath, imagePath);
        result.downsized++;
      }
    } catch {
      rmSync(tempPath, { force: true });
      // Release the claim so a failed shrink is retried on the next run
      // instead of being reported as a thumbnail while still full size.
      if (!deleteDue) releaseDownsize.run(row.shortcode);
      result.errors++;
    }
  }

  return result;
}
