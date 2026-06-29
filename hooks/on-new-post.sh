#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# IG Feed Watcher — Custom Hook Script
#
# This script is called every time a NEW post appears on your Instagram feed.
# The post data is piped in as JSON on stdin.
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
#   "scrapedAt": "2026-06-29T12:05:00.000Z"
# }
#
# Customize this script to do whatever you want with the post data:
#   - Call a webhook
#   - Save to a database
#   - Run an AI analysis
#   - Trigger a download
#   - Send to another service
#
# The Telegram notification is handled separately by watcher.js.
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
else
  SHORTCODE=$(echo "$POST_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['shortcode'])")
  PERMALINK=$(echo "$POST_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['permalink'])")
  AUTHOR=$(echo "$POST_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['author'])")
  CAPTION=$(echo "$POST_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin).get('caption',''))")
  IS_REEL=$(echo "$POST_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['isReel'])")
fi

echo "Hook received: @$AUTHOR posted ${SHORTCODE}"
echo "  URL: $PERMALINK"
echo "  Reel: $IS_REEL"
if [ -n "$CAPTION" ]; then
  echo "  Caption: ${CAPTION:0:100}..."
fi

# ─── YOUR CUSTOM LOGIC HERE ──────────────────────────────────────────────────

# Example 1: Save post data to a log file
# echo "$POST_JSON" >> /home/bsdev/ig-feed-watcher/logs/posts.jsonl

# Example 2: Call a webhook
# curl -X POST https://your-webhook.example.com/ig-post \
#   -H "Content-Type: application/json" \
#   -d "$POST_JSON"

# Example 3: Download the image
# FIRST_IMAGE=$(echo "$POST_JSON" | jq -r '.imageUrls[0] // empty')
# if [ -n "$FIRST_IMAGE" ]; then
#   curl -sL "$FIRST_IMAGE" -o "/home/bsdev/ig-feed-watcher/screenshots/${SHORTCODE}.jpg"
# fi

# Example 4: Run an AI analysis on the caption
# echo "$CAPTION" | some-ai-tool --analyze

# ─────────────────────────────────────────────────────────────────────────────

echo "Hook completed for ${SHORTCODE}"
