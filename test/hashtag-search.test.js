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

test('searching for a #hashtag matches that exact hashtag only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ig-hashtag-'));
  for (const file of ['server.js', 'sources.js', 'runtime-policy.js', 'retention.js', 'contract-policy.js', 'skill-policy.js', 'ai.js', 'package.json']) {
    copyFileSync(join(repo, file), join(root, file));
  }
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'junction');
  writeFileSync(join(root, 'groups.json'), JSON.stringify({ groups: [] }));
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const insert = db.prepare('INSERT INTO posts (shortcode, author, caption) VALUES (?, ?, ?)');
    insert.run('tag', 'a', 'Crédito liberado! #Pronaf #agricultura');
    insert.run('word', 'b', 'Linhas do pronaf para 2026');
    insert.run('longer', 'c', 'Novidades #pronafbioeconomia');
    insert.run('accent', 'd', 'Nosso #Território, nossa voz.');
    db.close();

    const search = async q => (await (await fetch(base + '/api/posts?search=' + encodeURIComponent(q))).json())
      .posts.map(p => p.shortcode).sort();
    assert.deepEqual(await search('#pronaf'), ['tag'], output);
    assert.deepEqual(await search('#PRONAF'), ['tag']);
    assert.deepEqual(await search('#territorio'), ['accent']);
    assert.deepEqual(await search('pronaf'), ['longer', 'tag', 'word'], 'plain words keep fuzzy matching');
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    rmSync(root, { recursive: true, force: true });
  }
});
