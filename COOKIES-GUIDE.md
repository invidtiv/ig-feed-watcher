# How to Get All the Values Your IG Feed Watcher Needs (Windows)

This guide explains, step by step, how a human operator gets **every value the
system needs** and where each value goes. It is written for a **Windows**
machine running the IG Feed Watcher (`watcher.js`) and the Posting API
(`post-server.js`).

The browser steps work identically on any operating system — only the "save
the values" parts are Windows-specific.

## 1. What values you need

| # | Value | Where it goes | Where you get it | Keep it secret? |
| --- | --- | --- | --- | --- |
| 1 | `sessionid` | `sources.json` → source `ig-primary` → `cookies` | Your browser, DevTools (you must be logged in to Instagram) | 🔴 Yes — full account access |
| 2 | `ds_user_id` | same | same | 🟡 Private-ish |
| 3 | `csrftoken` | same | same | 🟡 Sensitive |
| 4 | `mid`, `ig_did`, `rur` (optional) | same | same | 🟢 Low |
| 5 | `TG_BOT_TOKEN` | `.env.config` | Telegram **@BotFather** | 🔴 Yes |
| 6 | `TELEGRAM_HOME_CHANNEL` | `.env.config` | Telegram channel (via **@RawDataBot**) | 🟢 Low |

Only values **1–3** are required for the watcher to work. Values 4 are
recommended but optional; values 5–6 are only needed for Telegram
notifications. This guide focuses on 1–3, with quick instructions for 5–6 at
the end.

> 🔴 **`sessionid` is your Instagram password.** Anyone who has it can read
> your DMs, post as you, and change your password. Never paste it into chat,
> email, screenshots, or commits.

## 2. Before you start (Windows)

1. **Install Node.js (LTS)** from <https://nodejs.org> if it is not installed.
   Open a PowerShell window and confirm with:
   ```powershell
   node --version
   ```
2. Copy the project folder to the Windows machine (or clone the repo) and run
   once, in that folder:
   ```powershell
   cd C:\path\to\ig-feed-watcher
   npm install
   ```
3. Make sure you can see file extensions in Explorer:
   File Explorer → **View** tab → tick **File name extensions**.
   (Otherwise a file you name `sources.json` may really be `sources.json.txt`.)
4. Log in to Instagram in **Chrome or Edge** on this Windows machine, and
   **stay logged in**. The cookies you copy belong to that login.

## 3. Get the Instagram cookies — step by step (the main task)

### Step 3.1 — Open Instagram and confirm you are logged in

1. Open <https://www.instagram.com/>.
2. You should see your **feed with posts**. If you see a login form, log in
   first.

### Step 3.2 — Open Developer Tools

1. Press **F12** on the keyboard (or right-click anywhere → **Inspect**).

### Step 3.3 — Open the cookie table

1. Chrome / Edge: click the **Application** tab in the top bar of DevTools
   (if you do not see it, click the **`>>`** overflow menu and pick it there).
2. In the left sidebar, expand **Cookies** and click
   **`https://www.instagram.com`**.
3. A table of cookies appears. Use the **Filter** box at the top of the table
   to type a cookie name — this avoids hunting through ~20 rows.

### Step 3.4 — Copy `sessionid` (the important one)

1. Type `sessionid` in the Filter box.
2. Click the row named **sessionid**.
3. Click the **Value** cell, then press **Ctrl+C** (double-click the value
   first to select it all — it is long, ~30+ characters).
4. Paste it somewhere safe for the next 10 minutes — for example into a new
   Notepad window (keep that window private; close it after you finish). Do
   **not** paste it into chat or email.

> The value looks like a long mix of letters and digits, e.g.
> `7e9f...a1c3` (about 30–60 characters). If it looks like a short word or is
> empty, you clicked the wrong row — re-check.

### Step 3.5 — Copy `ds_user_id`

1. Type `ds_user_id` in the Filter box.
2. Click the row named **ds_user_id**.
3. Click the **Value** cell and press **Ctrl+C** (or double-click, then
   Ctrl+C).
4. Paste it into the same Notepad window.
   It is a plain number, usually 8–12 digits, e.g. `1234567890`.

### Step 3.6 — Copy `csrftoken`

1. Type `csrftoken` in the Filter box.
2. Click the row named **csrftoken**.
3. Click the **Value** cell and press **Ctrl+C** (or double-click, then
   Ctrl+C).
4. Paste it into the Notepad window.
   It is 32 hex-like characters, e.g. `a1b2c3d4e5f60718293a4b5c6d7e8f90`.

### Step 3.7 — Optional: copy `mid`, `ig_did`, `rur`

Only if you want to be extra safe (Instagram sometimes asks for these device
cookies). Repeat the same copy steps for each name. They are less sensitive.

### Step 3.8 — Summary check

You should now have three (or six) lines in Notepad:

| Cookie | What it looks like |
| --- | --- |
| `sessionid` | long token, 30–60 chars |
| `ds_user_id` | a number, 8–12 digits |
| `csrftoken` | 32 hex chars |

## 4. Put the values into the system (Windows)

The system reads cookies from `sources.json` (the active config, a single
source named `ig-primary`) and, only if `sources.json` is missing, from the
legacy `cookies.json`. **Use
Option A** below — it is the safest on Windows because it writes the file in
the exact encoding Node needs (UTF-8 **without** BOM).

### Option A — PowerShell helper (recommended)

1. Open **PowerShell** (Start → type "PowerShell" → Enter).
2. Change to the project folder:
   ```powershell
   cd C:\path\to\ig-feed-watcher
   ```
3. Paste the whole block below and press Enter. It will ask you for each
   value one at a time (`sessionid` is **not** echoed while you type) and
   writes `sources.json` for you:
   ```powershell
   $sid = Read-Host "Paste sessionid (characters are hidden)" -AsSecureString
   $uid = Read-Host "Paste ds_user_id (a number)"
   $csrf = Read-Host "Paste csrftoken"
   $sidText = [System.Net.NetworkCredential]::new('', $sid).Password
   $cookieNames = @('sessionid','ds_user_id','csrftoken')
   $newCookies = @(
     @{ name='sessionid';  value=$sidText; domain='.instagram.com'; path='/'; secure=$true;  httpOnly=$true;  sameSite='Lax' },
     @{ name='ds_user_id'; value=$uid;     domain='.instagram.com'; path='/'; secure=$true;  httpOnly=$false; sameSite='Lax' },
     @{ name='csrftoken';  value=$csrf;    domain='.instagram.com'; path='/'; secure=$true;  httpOnly=$true;  sameSite='Lax' }
   )
   if (Test-Path "$PWD\sources.json") {
     Copy-Item "$PWD\sources.json" "$PWD\sources.json.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
     Write-Host "Backup created."
   }
   $sources = if (Test-Path "$PWD\sources.json") {
     Get-Content "$PWD\sources.json" -Raw | ConvertFrom-Json
   } else { [pscustomobject]@{ sources = @() } }
   $src = $sources.sources | Where-Object { $_.id -eq 'ig-primary' }
   if ($null -eq $src) {
     $src = [pscustomobject]@{ id='ig-primary'; name='Primary Instagram'; type='instagram'; enabled=$true; cookies=$null }
     $sources.sources += $src
   }
   $src.cookies = @($newCookies + @($src.cookies | Where-Object { $_.name -notin $cookieNames }))
   $json = $sources | ConvertTo-Json -Depth 6
   [System.IO.File]::WriteAllText("$PWD\sources.json", $json, (New-Object System.Text.UTF8Encoding($false)))
   Write-Host "sources.json written to $PWD\sources.json"
   ```
   - Your `sessionid` never appears in the PowerShell command history (it is
     typed as a hidden prompt, not as part of a command).
   - Any existing `sources.json` is backed up first, and any other cookies you
     already had (e.g. `mid`, `ig_did`, `rur`) are kept.

### Option B — by hand, with Notepad

1. In the project folder, right-click empty space → **New** → **Text
   Document**.
2. Rename it to exactly **`sources.json`**. If Windows asks "If you change a
   file name extension...", click **Yes**.
3. Right-click it → **Open with** → **Notepad**.
4. Paste the block below and replace the three `PASTE_...` values with what
   you copied:
   ```json
   {
     "sources": [
       {
         "id": "ig-primary",
         "name": "Primary Instagram",
         "type": "instagram",
         "enabled": true,
         "cookies": [
           {
             "name": "sessionid",
             "value": "PASTE_SESSIONID_HERE",
             "domain": ".instagram.com",
             "path": "/",
             "secure": true,
             "httpOnly": true,
             "sameSite": "Lax"
           },
           {
             "name": "ds_user_id",
             "value": "PASTE_DS_USER_ID_HERE",
             "domain": ".instagram.com",
             "path": "/",
             "secure": true,
             "httpOnly": false,
             "sameSite": "Lax"
           },
           {
             "name": "csrftoken",
             "value": "PASTE_CSRF_TOKEN_HERE",
             "domain": ".instagram.com",
             "path": "/",
             "secure": true,
             "httpOnly": true,
             "sameSite": "Lax"
           }
         ]
       }
     ]
   }
   ```
5. Save (**Ctrl+S**). In the Notepad **Save As** dialog, if you see an
   **Encoding** dropdown, make sure it says **UTF-8** (not UTF-8 with BOM).
6. Double-check in Explorer that the file is really `sources.json` and not
   `sources.json.txt` (see Step 2.3).

### Option C — legacy single-account file (`cookies.json`)

Only needed if you deliberately do **not** use `sources.json`. Create
`cookies.json` in the project folder with the same three cookie objects as
above, but as a plain array (no `sources` wrapper):

```json
[
  {
    "name": "sessionid",
    "value": "PASTE_SESSIONID_HERE",
    "domain": ".instagram.com",
    "path": "/",
    "secure": true,
    "httpOnly": true,
    "sameSite": "Lax"
  }
]
```

(Add `ds_user_id` and `csrftoken` objects the same way.)

## 5. Verify it works

1. In PowerShell, from the project folder:
   ```powershell
   node watcher.js
   ```
   You should see the watcher launch a browser with your session and start
   scraping your feed. A `login required` / 401 error means the cookies are
   wrong or expired — go back to Section 3.
2. Optional status check for the Posting API (in a second PowerShell window):
   ```powershell
   node post-server.js
   curl.exe -s http://localhost:4030/status
   ```
   The response should say `"hasSessionId":true`.
3. To see which cookies the system thinks are configured (values masked):
   ```powershell
   curl.exe -s http://localhost:4180/api/sources
   ```

## 6. Refresh when the values expire

Instagram rotates sessions — expect to repeat Section 3 every few weeks.
Symptoms:

- the watcher logs `login required`, `challenge`, or 401 responses;
- the feed comes back empty or redirects to the login page;
- posting fails with a login / challenge error.

Fix: re-run **Step 3.4–3.6** and **Option A** (or edit the three values by
hand). Only the three values need replacing; other cookies are kept.

## 7. Telegram values (only if you want notifications)

1. **Bot token** — in Telegram, message **@BotFather** → send `/newbot` →
   choose a name and username → copy the **token** it returns (looks like
   `1234567890:AA...`). Put it in `.env.config` as
   `TG_BOT_TOKEN=...` (keep the token secret).
2. **Channel ID** — create a Telegram channel, add your bot to it as
   **administrator**, then add **@RawDataBot** to the channel and send one
   message. It replies with the channel's numeric ID (usually starts with
   `-100`). Put it in `.env.config` as
   `TELEGRAM_HOME_CHANNEL=-100...`. You can then remove RawDataBot.

## 8. Security rules

- `sessionid` (and the bot token) are full credentials — never paste them
  into chat, email, issues, commits, or screenshots.
- `sources.json`, `cookies.json`, and `.env.config` are listed in
  `.gitignore`; if one of them was ever committed, rotate your Instagram
  password and your bot token, and remove the file from git history.
- Cookies belong to the login and browser they came from. If you log out of
  Instagram on that browser, the exported values stop working.
- The watcher automates a real browser with your real session. Instagram can
  detect automation — use at your own risk and keep the polling interval
  gentle (5–15 minutes).

## 9. Checklist

| Value | Got it? | Saved in |
| --- | --- | --- |
| `sessionid` | ☐ | `sources.json` → `ig-primary` → `cookies` |
| `ds_user_id` | ☐ | same |
| `csrftoken` | ☐ | same |
| `mid`, `ig_did`, `rur` (optional) | ☐ | same |
| `TG_BOT_TOKEN` (optional) | ☐ | `.env.config` |
| `TELEGRAM_HOME_CHANNEL` (optional) | ☐ | `.env.config` |
