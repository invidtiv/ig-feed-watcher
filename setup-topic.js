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
  // First get bot info to get user_id
  const meResp = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
  const me = await meResp.json();
  const botId = me.result.id;
  console.log(`Bot ID: ${botId}, username: ${me.result.username}`);

  // Promote bot to admin with topic management rights
  const promoteResp = await fetch(`https://api.telegram.org/bot${botToken}/promoteChatMember`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: newChatId,
      user_id: botId,
      can_manage_chat: true,
      can_change_info: true,
      can_delete_messages: true,
      can_invite_users: true,
      can_restrict_members: true,
      can_pin_messages: true,
      can_manage_topics: true,
      can_post_stories: true,
      can_edit_stories: true,
      can_delete_stories: true,
    }),
  });
  const promoteResult = await promoteResp.json();
  console.log('Promote result:', JSON.stringify(promoteResult, null, 2));

  if (promoteResult.ok) {
    // Now create the topic
    const topicResp = await fetch(`https://api.telegram.org/bot${botToken}/createForumTopic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: newChatId,
        name: 'Selected',
        icon_color: 7322096,
      }),
    });
    const topicResult = await topicResp.json();
    console.log('Topic created:', JSON.stringify(topicResult, null, 2));
  }
}

main().catch(e => console.error(e.message));
