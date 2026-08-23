import test from 'node:test';
import assert from 'node:assert/strict';

import { contractForCapabilities } from '../contract-policy.js';

const sourceContract = {
  openapi: '3.0.3',
  info: { title: 'Test API', description: 'Complete contract.' },
  paths: {
    '/feeds': {
      get: { summary: 'List feeds' },
      post: { summary: 'Create feed' },
    },
    '/groups/{id}': {
      parameters: [{ name: 'id', in: 'path' }],
      get: { summary: 'Get group' },
      put: { summary: 'Update group' },
      delete: { summary: 'Delete group' },
    },
    '/post': {
      post: { summary: 'Publish' },
    },
  },
  components: { schemas: { MutationInput: { type: 'object' } } },
};

test('read-only contract exposes GET operations only and drops mutation-only paths', () => {
  const contract = contractForCapabilities(sourceContract, { fullAgent: false });

  assert.equal(contract['x-api-mode'], 'read-only');
  assert.deepEqual(Object.keys(contract.paths), ['/feeds', '/groups/{id}']);
  assert.deepEqual(Object.keys(contract.paths['/feeds']), ['get']);
  assert.deepEqual(Object.keys(contract.paths['/groups/{id}']), ['parameters', 'get']);
  assert.match(contract.info.description, /served view is read-only/i);
  assert.ok(sourceContract.paths['/feeds'].post, 'source document must not be mutated');
});

test('full-agent contract exposes the complete operation set', () => {
  const contract = contractForCapabilities(sourceContract, { fullAgent: true });

  assert.equal(contract['x-api-mode'], 'full-agent');
  assert.ok(contract.paths['/feeds'].post);
  assert.ok(contract.paths['/groups/{id}'].put);
  assert.ok(contract.paths['/groups/{id}'].delete);
  assert.ok(contract.paths['/post'].post);
});
