# IG Feed Watcher

Headless Instagram feed watcher that detects new posts on your feed and:
- 📸 Takes a screenshot of each new post
- 🔔 Sends you a Telegram notification (photo + caption)
- 🔧 Runs a custom hook script with the post data as JSON

Also includes a **Post API** — an HTTP API to post images to Instagram using the same session cookies.

## Posting API

A lightweight Express server that accepts an image + caption and posts to Instagram via Puppeteer automation.

### Start the API server

```bash
cd /home/bsdev/ig-feed-watcher
node post-server.js
```

The server listens on `127.0.0.1:4030` (Tailnet/internal only — no public exposure).

### Endpoints

#### `GET /health`
Health check. Returns service status and whether cookies are configured.

```json
{"status":"ok","service":"ig-feed-watcher-post-api","uptime":5.0,"cookiesConfigured":true}
```

#### `GET /status`
Session/cookie status. Returns cookie count and whether `sessionid` is present.

```json
{"status":"ok","cookiesFile":"...","cookieCount":3,"hasSessionId":true,"message":"Session cookies present (validity not checked)"}
```

#### `POST /post`
Posts an image to Instagram. Two modes:

**Mode 1 — Multipart file upload:**
```bash
curl -X POST http://127.0.0.1:4030/post \
  -F "image=@/path/to/image.jpg" \
  -F "caption=Your caption here 📸"
```

**Mode 2 — JSON with existing file path:**
```bash
curl -X POST http://127.0.0.1:4030/post \
  -H "Content-Type: application/json" \
  -d '{"imagePath": "/path/to/image.jpg", "caption": "Your caption"}'
```

**Response (success):**
```json
{"success":true,"permalink":"https://www.instagram.com/p/XXXXX/","postedAt":"2026-06-30T21:45:27.911Z"}
```

**Response (failure):**
```json
{"success":false,"error":"Error message..."}
```

### How posting works

The poster (`poster.js`) automates the Instagram web create-post flow:
1. Launches headless Chromium with session cookies
2. Clicks "New post" → "Post" in the nav dropdown
3. Uploads the image file
4. Clicks "Next" through crop → filter pages
5. Enters the caption in the caption textfield
6. Clicks "Share"
7. Waits for confirmation and extracts the permalink

### CLI posting

You can also post directly without the API server:

```bash
node poster.js /path/to/image.jpg "Your caption here"
```

### Configuration

The API server reads cookies from the same `cookies.json` used by the watcher.
Port can be changed via `IG_POST_API_PORT` env var.

## Feed Watcher Setup

### 1. Install dependencies
```bash
cd /home/bsdev/ig-feed-watcher
npm install
```

### 2. Export your Instagram cookies

You need to provide your Instagram session cookies. Three options:

#### Option A — Manual export from browser DevTools (easiest for headless server)

1. Open `instagram.com` in your desktop browser (logged in)
2. Press F12 → go to **Application** tab
3. Under **Cookies** → `https://www.instagram.com`
4. Copy each cookie into `cookies.json` (see format below)

The **critical cookies** you need:
- `sessionid` — your login session token
- `ds_user_id` — your Instagram user ID
- `csrftoken` — CSRF token
- `mid`, `ig_did`, `rur` — device/region cookies

#### Option B — Use the export script (if Chrome profile is on this server)
```bash
python3 export-cookies.py
```

#### Option C — Use the login helper (requires a display/X11)
```bash
node login.js
```

### 3. cookies.json format
```json
[
  {
    "name": "sessionid",
    "value": "YOUR_SESSION_ID",
    "domain": ".instagram.com",
    "path": "/",
    "secure": true,
    "httpOnly": true,
    "sameSite": "Lax"
  }
]
```

### 4. Test the watcher
```bash
node watcher.js
```

### 5. Set up the cron job
```bash
crontab -e
# Add this line to check every 5 minutes:
*/5 * * * * cd /home/bsdev/ig-feed-watcher && /home/bsdev/.nvm/versions/node/v22.22.0/bin/node watcher.js >> logs/cron.log 2>&1
```

Or use Hermes cron:
```bash
hermes cron create --schedule "*/5 * * * *" --command "cd /home/bsdev/ig-feed-watcher && node watcher.js"
```

## Custom Hook Script

Edit `hooks/on-new-post.sh` to define what happens when a new post is detected.

The script receives the post data as JSON on stdin:

```json
{
  "shortcode": "C1b2dEf",
  "permalink": "https://www.instagram.com/p/C1b2dEf/",
  "author": "username",
  "timestamp": "2026-06-29T12:00:00.000Z",
  "caption": "post caption text...",
  "imageUrls": ["https://..."],
  "isReel": false,
  "scrapedAt": "2026-06-29T12:05:00.000Z"
}
```

Example hooks (already in the script, commented out):
- Save post data to a log file
- Call a webhook
- Download the image
- Run AI analysis on the caption

## Files

```
ig-feed-watcher/
├── watcher.js          — main watcher script (Puppeteer + headless Chrome)
├── poster.js           — Instagram posting automation (Puppeteer)
├── post-server.js      — HTTP API server (Express + Multer)
├── login.js            — interactive login helper (needs display)
├── export-cookies.py   — extract cookies from local Chrome profile
├── cookies.json        — your Instagram session cookies (you create this)
├── state.json          — tracks seen posts (auto-created)
├── hooks/
│   └── on-new-post.sh  — custom hook script (edit this!)
├── screenshots/        — post screenshots
├── uploads/            — uploaded images (for posting API)
├── logs/               — watcher + poster logs
├── .env.config         — configuration
└── package.json
```

## Important notes

- **Session expiry**: Instagram sessions can expire. If you get login errors, re-export your cookies.
- **Rate limiting**: Every 5 minutes is aggressive. If Instagram rate-limits you, reduce to every 15 minutes.
- **Detection**: This uses a real Chromium with realistic user-agent. Instagram may still detect automation. Use at your own risk.
- **Cookie refresh**: You may need to re-export cookies every few weeks as Instagram rotates sessions.
