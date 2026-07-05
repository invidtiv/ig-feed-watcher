#!/bin/bash
cd /home/bsdev/ig-feed-watcher
BOT_TOKEN=$(grep -E "^TG_BOT_TOKEN=" .env.config | cut -d= -f2)
NEW_CHAT_ID=-1004396992372

echo "=== Getting chat info ==="
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getChat?chat_id=${NEW_CHAT_ID}" | python3 -c "
import sys, json
r = json.load(sys.stdin)
print(json.dumps(r, indent=2))
"

echo ""
echo "=== Trying to enable forum (setChatPermissions) ==="
# Try setting is_forum via setChatPermissions - this might not work via API
# The is_forum setting usually needs to be enabled via Telegram client UI
curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setChatPermissions" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": -1004396992372, "permissions": {"can_send_messages": true, "can_send_media_messages": true, "can_send_other_messages": true, "can_add_web_page_previews": true, "can_manage_topics": true}, "use_independent_chat_permissions": true}' | \
  python3 -c "import sys, json; r=json.load(sys.stdin); print(json.dumps(r, indent=2))"
