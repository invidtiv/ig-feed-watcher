import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createFullAgentGuard,
  loadRuntimePolicy,
  multiAccountEnabled,
  selectRunnableSources,
  writeConfigValue,
} from '../runtime-policy.js';

test('single-account mode runs only the first enabled source', () => {
  const sources = [
    { id: 'disabled', enabled: false },
    { id: 'first', enabled: true },
    { id: 'second', enabled: true },
  ];

  assert.deepEqual(selectRunnableSources(sources, false).map(source => source.id), ['first']);
  assert.deepEqual(selectRunnableSources(sources, true).map(source => source.id), ['first', 'second']);
});

test('MULTI_ACCOUNT is canonical and the legacy plural remains compatible', () => {
  assert.equal(multiAccountEnabled('1', '0'), true);
  assert.equal(multiAccountEnabled('0', '1'), false);
  assert.equal(multiAccountEnabled(undefined, '1'), true);
  assert.equal(multiAccountEnabled(undefined, undefined), false);
});

test('FULL_AGENT guard rejects every non-GET request in read-only mode', () => {
  const guard = createFullAgentGuard(false);
  let nextCalled = false;
  let statusCode = null;
  let payload = null;
  const res = {
    set(name, value) { assert.equal(name, 'Allow'); assert.equal(value, 'GET'); },
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return this; },
  };

  guard({ method: 'POST' }, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(statusCode, 405);
  assert.deepEqual(payload, { error: 'Read-only API: set FULL_AGENT=1 to allow non-GET requests.' });
});

test('FULL_AGENT guard allows GET in read-only mode and mutations in full mode', () => {
  for (const [fullAgent, method] of [[false, 'GET'], [true, 'POST'], [true, 'DELETE']]) {
    let nextCalled = false;
    createFullAgentGuard(fullAgent)({ method }, {}, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  }
});

test('global retention updates preserve unrelated configuration and reload immediately', () => {
  const root = mkdtempSync(join(tmpdir(), 'ig-policy-'));
  const configPath = join(root, '.env.config');
  writeFileSync(configPath, 'AUTO_RETENTION=2\nUNRELATED=keep\nIMAGE_RETENTION_DAYS=30\n');
  const previous = process.env.IMAGE_RETENTION_DAYS;
  delete process.env.IMAGE_RETENTION_DAYS;

  try {
    writeConfigValue(root, 'IMAGE_RETENTION_DAYS', '45');
    assert.equal(loadRuntimePolicy(root).imageRetentionDays, 45);
    assert.match(readFileSync(configPath, 'utf-8'), /UNRELATED=keep/);
    assert.match(readFileSync(configPath, 'utf-8'), /IMAGE_RETENTION_DAYS=45/);
  } finally {
    if (previous === undefined) delete process.env.IMAGE_RETENTION_DAYS;
    else process.env.IMAGE_RETENTION_DAYS = previous;
  }
});
