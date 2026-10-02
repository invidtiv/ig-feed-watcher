import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, symlinkSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { Script } from 'node:vm';

const repo = resolve(process.env.IG_TEST_ROOT || fileURLToPath(new URL('..', import.meta.url)));

async function startServer(fullAgent) {
  const root = mkdtempSync(join(tmpdir(), 'ig-ai-server-'));
  for (const file of ['server.js', 'sources.js', 'runtime-policy.js', 'retention.js', 'contract-policy.js', 'skill-policy.js', 'ai.js', 'group-match.js', 'package.json']) {
    copyFileSync(join(repo, file), join(root, file));
  }
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'junction');
  writeFileSync(join(root, 'groups.json'), JSON.stringify({ groups: [{ id: 'g1', name: 'Test', color: '#ffffff', accounts: [], keywords: [], hashtags: [] }] }));
  writeFileSync(join(root, '.env.config'), `FULL_AGENT=${fullAgent ? 1 : 0}\n`);
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));
  const env = { ...process.env, PORT: String(port) };
  for (const key of ['OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'FULL_AGENT']) delete env[key];
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(base); break; } catch {}
    if (child.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 50));
  }
  const stop = async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    rmSync(root, { recursive: true, force: true });
  };
  return { root, base, stop, output: () => output };
}

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('AI settings store the key without ever returning it, and AI calls require a key', async () => {
  const server = await startServer(true);
  try {
    const { base, root } = server;
    let settings = await (await fetch(base + '/api/settings/ai')).json();
    assert.equal(settings.keySet, false, server.output());
    assert.equal(settings.model, settings.defaultModel);

    const ask = await fetch(base + '/api/ai/ask', json('POST', { question: 'What is new?' }));
    assert.equal(ask.status, 400);
    assert.match((await ask.json()).error, /API key/);

    const suggest = await fetch(base + '/api/ai/groups/g1/suggest', json('POST', {}));
    assert.equal(suggest.status, 400);
    assert.equal((await fetch(base + '/api/ai/groups/missing/suggest', json('POST', {}))).status, 404);
    assert.equal((await fetch(base + '/api/ai/ask', json('POST', { question: '  ' }))).status, 400);

    const bad = await fetch(base + '/api/settings/ai', json('PUT', { apiKey: 'sk-or-x\nFULL_AGENT=0' }));
    assert.equal(bad.status, 400);

    const saved = await fetch(base + '/api/settings/ai', json('PUT', { apiKey: 'sk-or-secret', model: 'openai/gpt-5.5' }));
    assert.equal(saved.status, 200);
    const text = await (await fetch(base + '/api/settings/ai')).text();
    assert.ok(!text.includes('sk-or-secret'), 'settings response must not leak the key');
    settings = JSON.parse(text);
    assert.equal(settings.keySet, true);
    assert.equal(settings.model, 'openai/gpt-5.5');
    const config = readFileSync(join(root, '.env.config'), 'utf-8');
    assert.match(config, /^OPENROUTER_API_KEY=sk-or-secret$/m);
    assert.match(config, /^FULL_AGENT=1$/m);

    for (const path of ['/', '/settings', '/settings/sources']) {
      const html = await (await fetch(base + path)).text();
      for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new Script(match[1]);
    }
    assert.match(await (await fetch(base + '/')).text(), /id="ai-panel"/);
    assert.match(await (await fetch(base + '/settings/sources')).text(), /id="ai-section"/);
  } finally {
    await server.stop();
  }
});

test('AI endpoints are blocked in read-only mode', async () => {
  const server = await startServer(false);
  try {
    const res = await fetch(server.base + '/api/ai/ask', json('POST', { question: 'hi' }));
    assert.equal(res.status, 405, server.output());
    assert.equal((await fetch(server.base + '/api/settings/ai')).status, 200);
  } finally {
    await server.stop();
  }
});
