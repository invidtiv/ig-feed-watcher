#!/bin/bash
cd /home/bsdev/ig-feed-watcher
BOT_TOKEN=*** -E "^TG_BOT_TOKEN=*** .env.config | cut -d= -f2)

curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/createForumTopic" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": -1004396992372, "name": "Selected", "icon_color": 7322096}'
echo ""
