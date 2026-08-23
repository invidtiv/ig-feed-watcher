import { existsSync, unlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

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

export function runImageRetention({ db, screenshotsDir, groups, mode, globalDays, now = new Date() }) {
  const result = { checked: 0, expired: 0, deleted: 0, missing: 0, errors: 0 };
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
  const nowMillis = now.getTime();
  const safeDir = resolve(screenshotsDir);

  for (const row of rows) {
    result.checked++;
    const recordedAt = timestampMillis(row);
    const days = effectiveRetentionDays(mode, globalDays, row.matched_groups, groups);
    if (recordedAt === null || days === null || nowMillis - recordedAt < days * 86_400_000) continue;

    result.expired++;
    // Watcher screenshots are flat files. Resolving from basename prevents a
    // corrupted database path from deleting anything outside screenshotsDir.
    const imagePath = join(safeDir, basename(row.screenshot_path));
    try {
      if (existsSync(imagePath)) {
        unlinkSync(imagePath);
        result.deleted++;
      } else {
        result.missing++;
      }
      clearPath.run(row.shortcode);
    } catch {
      result.errors++;
    }
  }

  return result;
}
