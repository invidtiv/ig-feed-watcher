import test from 'node:test';
import assert from 'node:assert/strict';

import { contractForCapabilities } from '../contract-policy.js';

const sourceContract = {
  openapi: '3.0.3',
  info: { title: 'Test API', description: 'Complete contract.' },
  tags: [
    { name: 'feeds', description: 'Feed records.' },
    { name: 'groups', description: 'Interest groups with full group management.' },
  ],
  paths: {
    '/feeds': {
      get: {
        summary: 'List feeds',
        responses: {
          200: {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/FeedList' } },
            },
          },
        },
      },
      post: { summary: 'Create feed' },
    },
    '/groups/{id}': {
      parameters: [{ name: 'id', in: 'path' }],
      get: { summary: 'Get group' },
      put: { summary: 'Update group' },
      delete: { summary: 'Delete group' },
    },
    '/settings': {
      get: {
        summary: 'Get settings',
        responses: {
          200: {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RetentionSettings' },
              },
            },
          },
        },
      },
    },
    '/post': {
      post: { summary: 'Publish' },
    },
  },
  components: {
    schemas: {
      FeedList: {
        type: 'array',
        items: { $ref: '#/components/schemas/Feed' },
      },
      Feed: { type: 'object' },
      RetentionSettings: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          auto_retention: { type: 'integer' },
          editable: { type: 'boolean' },
          mutations_enabled: { type: 'boolean' },
        },
      },
      MutationInput: { type: 'object' },
    },
  },
};

test('read-only contract exposes GET operations only and drops mutation-only paths', () => {
  const contract = contractForCapabilities(sourceContract, { fullAgent: false });

  assert.equal(contract['x-api-mode'], 'read-only');
  assert.deepEqual(Object.keys(contract.paths), ['/feeds', '/groups/{id}', '/settings']);
  assert.deepEqual(Object.keys(contract.paths['/feeds']), ['get']);
  assert.deepEqual(Object.keys(contract.paths['/groups/{id}']), ['parameters', 'get']);
  assert.equal(
    contract.info.description,
    'This served API contract is read-only and lists GET operations only.',
  );
  assert.equal(contract.tags[1].description, 'Interest groups and their feeds.');
  assert.deepEqual(Object.keys(contract.components.schemas), [
    'FeedList',
    'Feed',
    'RetentionSettings',
  ]);
  assert.deepEqual(
    Object.keys(contract.components.schemas.RetentionSettings.properties),
    ['auto_retention'],
  );
  assert.equal(contract.components.schemas.MutationInput, undefined);
  assert.ok(sourceContract.paths['/feeds'].post, 'source document must not be mutated');
});

test('full-agent contract exposes the complete operation set', () => {
  const contract = contractForCapabilities(sourceContract, { fullAgent: true });

  assert.equal(contract['x-api-mode'], 'full-agent');
  assert.ok(contract.paths['/feeds'].post);
  assert.ok(contract.paths['/groups/{id}'].put);
  assert.ok(contract.paths['/groups/{id}'].delete);
  assert.ok(contract.paths['/post'].post);
  assert.ok(contract.components.schemas.MutationInput);
  assert.equal(
    contract.components.schemas.RetentionSettings.properties.mutations_enabled.type,
    'boolean',
  );
});
