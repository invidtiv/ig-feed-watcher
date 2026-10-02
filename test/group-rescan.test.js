import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

const repo = resolve(process.env.IG_TEST_ROOT || fileURLToPath(new URL('..', import.meta.url)));

test('re-scan previews and tags past posts that match a group, and criteria can be tested', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ig-rescan-'));
  for (const file of ['server.js', 'sources.js', 'runtime-policy.js', 'retention.js', 'contract-policy.js', 'skill-policy.js', 'ai.js', 'group-match.js', 'package.json']) {
    copyFileSync(join(repo, file), join(root, file));
  }
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'junction');
  writeFileSync(join(root, 'groups.json'), JSON.stringify({ groups: [
    { id: 'g1', name: 'Florest', color: '#26f50a', accounts: ['@embrapa'], keywords: ['agroecologia'], hashtags: [] },
    { id: 'g2', name: 'Other', color: '#000000', accounts: [], keywords: [], hashtags: [] },
  ] }));
  writeFileSync(join(root, '.env.config'), 'FULL_AGENT=1\n');
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));
  const env = { ...process.env, PORT: String(port) };
  delete env.FULL_AGENT;
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      try { await fetch(base); break; } catch {}
      if (child.exitCode !== null) break;
      await new Promise(r => setTimeout(r, 50));
    }
    const db = new DatabaseSync(join(root, 'posts.db'));
    const insert = db.prepare('INSERT INTO posts (shortcode, author, caption, timestamp, matched_groups) VALUES (?, ?, ?, ?, ?)');
    insert.run('by-account', 'embrapa', 'Nova cultivar', '2026-09-01T00:00:00', '[]');
    insert.run('by-keyword', 'someone', 'Curso de AGROECOLOGIA', '2026-09-02T00:00:00',
      JSON.stringify([{ id: 'g2', name: 'Other', color: '#000000', reasons: ['manual'] }]));
    insert.run('already', 'embrapa', 'agroecologia', '2026-09-03T00:00:00',
      JSON.stringify([{ id: 'g1', name: 'Florest', color: '#26f50a', reasons: ['manual'] }]));
    insert.run('unrelated', 'other', 'receita de bolo', '2026-09-04T00:00:00', '[]');

    const preview = await (await fetch(base + '/api/groups/g1/rescan')).json();
    assert.equal(preview.matched, 3, output);
    assert.equal(preview.already_in_group, 1);
    assert.equal(preview.new_matches, 2);
    assert.deepEqual(preview.sample.map(p => p.shortcode), ['by-keyword', 'by-account'], 'new matches only, newest first');
    assert.deepEqual(preview.sample[1].reasons, ['account @embrapa']);

    const tested = await (await fetch(base + '/api/groups/g1/test?type=keyword&value=' + encodeURIComponent('bolo'))).json();
    assert.equal(tested.matched, 1);
    assert.equal(tested.new_matches, 1);
    assert.deepEqual(tested.sample.map(p => [p.shortcode, p.in_group]), [['unrelated', false]]);
    const testedAccount = await (await fetch(base + '/api/groups/g1/test?type=account&value=%40embrapa')).json();
    assert.deepEqual(testedAccount.sample.map(p => [p.shortcode, p.in_group]), [['already', true], ['by-account', false]]);
    assert.equal((await fetch(base + '/api/groups/g1/test?type=bogus&value=x')).status, 400);
    assert.equal((await fetch(base + '/api/groups/g1/test?type=keyword&value=')).status, 400);
    assert.equal((await fetch(base + '/api/groups/missing/rescan')).status, 404);

    const applied = await (await fetch(base + '/api/groups/g1/rescan', { method: 'POST' })).json();
    assert.deepEqual(applied, { ok: true, tagged: 2 });
    const groupsOf = shortcode => JSON.parse(db.prepare('SELECT matched_groups FROM posts WHERE shortcode = ?').get(shortcode).matched_groups);
    assert.deepEqual(groupsOf('by-keyword').map(g => [g.id, g.reasons]), [['g2', ['manual']], ['g1', ['keyword "agroecologia"']]]);
    assert.deepEqual(groupsOf('already'), [{ id: 'g1', name: 'Florest', color: '#26f50a', reasons: ['manual'] }], 'existing membership untouched');
    assert.deepEqual(groupsOf('unrelated'), []);
    assert.equal(db.prepare('SELECT is_priority FROM posts WHERE shortcode = ?').get('by-account').is_priority, 1);

    const again = await (await fetch(base + '/api/groups/g1/rescan')).json();
    assert.equal(again.new_matches, 0);
    db.close();
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    rmSync(root, { recursive: true, force: true });
  }
});
