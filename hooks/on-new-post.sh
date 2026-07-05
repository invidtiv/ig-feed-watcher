#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# IG Feed Watcher — Custom Hook Script
#
# Called every time a NEW post appears on your Instagram feed.
# Post data is piped in as JSON on stdin.
#
# JSON structure:
# {
#   "shortcode": "C1b2dEf",
#   "permalink": "https://www.instagram.com/p/C1b2dEf/",
#   "author": "username",
#   "timestamp": "2026-06-29T12:00:00.000Z",
#   "caption": "post caption text...",
#   "imageUrls": ["https://..."],
#   "isReel": false,
#   "scrapedAt": "2026-06-29T12:05:00.000Z",
#   "priority": true,
#   "priorityReasons": ["account @mda_sc"],
#   "comments": [{"author": "user1", "text": "nice!", "timestamp": "...", "likeCount": 3}]
# }
#
# Priority posts are from accounts or containing keywords/hashtags
# defined in priority-list.json.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# Read post JSON from stdin
POST_JSON=$(cat)

# Parse fields with jq if available, fallback to python3
if command -v jq &>/dev/null; then
  SHORTCODE=$(echo "$POST_JSON" | jq -r '.shortcode')
  PERMALINK=$(echo "$POST_JSON" | jq -r '.permalink')
  AUTHOR=$(echo "$POST_JSON" | jq -r '.author')
  CAPTION=$(echo "$POST_JSON" | jq -r '.caption // empty')
  IS_REEL=$(echo "$POST_JSON" | jq -r '.isReel')
  IS_PRIORITY=$(echo "$POST_JSON" | jq -r '.priority // false')
  PRIORITY_REASONS=$(echo "$POST_JSON" | jq -r '.priorityReasons // [] | join(", ")')
else
  SHORTCODE=$(echo "$POST_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['shortcode'])")
  PERMALINK=$(echo "$POST_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['permalink'])")
  AUTHOR=$(echo "$POST_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['author'])")
  CAPTION=$(echo "$POST_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin).get('caption',''))")
  IS_REEL=$(echo "$POST_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['isReel'])")
  IS_PRIORITY=$(echo "$POST_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin).get('priority',False))")
  PRIORITY_REASONS=$(echo "$POST_JSON" | python3 -c "import sys,json;print(', '.join(json.load(sys.stdin).get('priorityReasons',[])))")
fi

# ─── Logging ──────────────────────────────────────────────────────────────────

LOG_FILE="/home/bsdev/ig-feed-watcher/logs/posts.log"
PRIORITY_LOG_FILE="/home/bsdev/ig-feed-watcher/logs/priority-posts.jsonl"

if [ "$IS_PRIORITY" = "true" ]; then
  echo "[$(date -Iseconds)] ⭐ PRIORITY: @$AUTHOR posted $SHORTCODE (matched: $PRIORITY_REASONS)" >> "$LOG_FILE"
  # Save priority posts to a separate file for analysis
  echo "$POST_JSON" >> "$PRIORITY_LOG_FILE"
  echo "⭐ Priority hook: @$AUTHOR posted $SHORTCODE (matched: $PRIORITY_REASONS)"
else
  echo "[$(date -Iseconds)] @$AUTHOR posted $SHORTCODE" >> "$LOG_FILE"
  echo "Hook received: @$AUTHOR posted $SHORTCODE"
fi

echo "  URL: $PERMALINK"
echo "  Reel: $IS_REEL"
if [ -n "$CAPTION" ]; then
  echo "  Caption: ${CAPTION:0:120}..."
fi

# ─── PRIORITY POST CUSTOM LOGIC ───────────────────────────────────────────────
# Add special handling for priority posts here

if [ "$IS_PRIORITY" = "true" ]; then
  # Example: Save priority post images to a dedicated folder
  # FIRST_IMAGE=$(echo "$POST_JSON" | jq -r '.imageUrls[0] // empty')
  # if [ -n "$FIRST_IMAGE" ]; then
  #   mkdir -p /home/bsdev/ig-feed-watcher/screenshots/priority/
  #   curl -sL "$FIRST_IMAGE" -o "/home/bsdev/ig-feed-watcher/screenshots/priority/${SHORTCODE}.jpg"
  # fi

  # Example: Send to a different webhook/API
  # curl -X POST https://your-webhook.example.com/priority-post \
  #   -H "Content-Type: application/json" \
  #   -d "$POST_JSON"

  :
fi

# ─── GENERAL CUSTOM LOGIC ─────────────────────────────────────────────────────
# Runs for ALL posts (priority and normal)

# Example: Save all post data to a log file
# echo "$POST_JSON" >> /home/bsdev/ig-feed-watcher/logs/posts.jsonl

echo "Hook completed for ${SHORTCODE}"
