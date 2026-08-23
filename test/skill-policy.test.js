import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { skillForCapabilities } from '../skill-policy.js';

const sourceSkill = readFileSync(
  new URL('../skills/feed-api/SKILL.md', import.meta.url),
  'utf8',
);

test('read-only skill documents GET capabilities only', () => {
  const skill = skillForCapabilities(sourceSkill, { fullAgent: false });

  assert.match(skill, /description: Query the IG Feed Watcher feed database/);
  assert.match(skill, /`GET \/api\/feeds`/);
  assert.match(skill, /`GET \/api\/groups\/{id}`/);
  assert.doesNotMatch(skill, /\b(?:POST|PUT|PATCH|DELETE)\s+\/api\//);
  assert.doesNotMatch(skill, /FULL_AGENT/);
  assert.doesNotMatch(skill, /Group management/);
  assert.doesNotMatch(skill, /group-create|group-update|group-delete/);
  assert.doesNotMatch(skill, /FULL_AGENT_ONLY_(?:START|END)/);
});

test('full-agent skill is the complete canonical source', () => {
  assert.equal(
    skillForCapabilities(sourceSkill, { fullAgent: true }),
    sourceSkill,
  );
});
