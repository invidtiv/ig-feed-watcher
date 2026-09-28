import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { Script } from 'node:vm';
const repo = resolve(process.env.IG_TEST_ROOT || fileURLToPath(new URL('..', import.meta.url)));
for (const mode of [undefined, '0', '1', '2', 'invalid']) {
  test(`retention UI with AUTO_RETENTION=${mode ?? 'unset'}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'ig-retention-ui-'));
    for (const file of ['server.js', 'sources.js', 'runtime-policy.js', 'retention.js', 'contract-policy.js', 'skill-policy.js', 'package.json']) copyFileSync(join(repo, file), join(root, file));
    symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'junction');
    writeFileSync(join(root, 'groups.json'), JSON.stringify({groups:[{id:'test',name:'Test',color:'#ffffff',accounts:[],keywords:[],hashtags:[]}]}));
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const env = {...process.env, PORT:String(port), IMAGE_RETENTION_DAYS:'30'};
    delete env.AUTO_RETENTION;
    if (mode !== undefined) env.AUTO_RETENTION = mode;
    const child = spawn(process.execPath, ['server.js'], {cwd:root, env, stdio:['ignore','pipe','pipe']});
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    try {
      const base = `http://127.0.0.1:${port}`;
      let ready = false;
      for (let i=0; i<100; i++) {
        try { await fetch(base); ready=true; break; } catch {}
        if (child.exitCode !== null) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(ready, output);
      const sources = await (await fetch(base+'/settings/sources')).text();
      const groups = await (await fetch(base+'/settings')).text();
      const enabled = mode === '1' || mode === '2';
      const markup = html => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
      assert.equal(markup(sources).includes('id="retention-section"'), enabled, 'Sources retention section must require explicit opt-in');
      assert.equal(markup(groups).includes('id="new-group-retention"'), mode === '2', 'Group retention field must exist only in group mode');
      for (const html of [sources, groups]) for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new Script(match[1]);
      const policy = await (await fetch(base+'/api/settings/retention')).json();
      assert.equal(policy.auto_retention, enabled ? Number(mode) : 0);
    } finally {
      if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
      rmSync(root, {recursive:true,force:true});
    }
  });
}
