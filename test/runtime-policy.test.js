import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createFullAgentGuard,
  multiAccountEnabled,
  selectRunnableSources,
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
