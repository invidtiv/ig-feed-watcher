#!/usr/bin/env node
import { readFileSync } from 'fs';
import { join } from 'path';

const configText = readFileSync(join('/home/bsdev/ig-feed-watcher', '.env.config'), 'utf-8');
const lines = configText.split('\n');
const env = {};
for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx > 0) {
    env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
  }
}

const botToken = env.TG_BOT_TOKEN;
const newChatId = -1004396992372;

async function main() {
  // Create the "Selected" forum topic
  const resp = await fetch(`https://api.telegram.org/bot${botToken}/createForumTopic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: newChatId,
      name: 'Selected',
      icon_color: 7322096,
    }),
  });
  const result = await resp.json();
  console.log(JSON.stringify(result, null, 2));
}

main().catch(e => console.error(e.message));
