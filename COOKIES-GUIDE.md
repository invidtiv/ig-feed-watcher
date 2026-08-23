# How to Get All the Values Your IG Feed Watcher Needs

This guide explains, step by step, how to get **every value the system needs**
and where to put it. Everything is entered in the **web app** (the frontend) —
**there are no files or settings outside the app for you to write or edit.**

The app is already running on this machine — you are looking at it. No setup
is needed: just follow the steps below.

## 1. What values you need

| # | Value | Where it goes | Where you get it | Keep it secret? |
| --- | --- | --- | --- | --- |
| 1 | `sessionid` | This page → **Instagram account** → **Cookies** box | Your browser, DevTools (you must be logged in to Instagram) | 🔴 Yes — full account access |
| 2 | `ds_user_id` | same | same | 🟡 Private-ish |
| 3 | `csrftoken` | same | same | 🟡 Sensitive |
| 4 | `mid`, `ig_did`, `rur` (optional) | same | same | 🟢 Low |
| 5 | `TG_BOT_TOKEN` | This page → **Telegram alerts** | Telegram **@BotFather** | 🔴 Yes |
| 6 | `TELEGRAM_HOME_CHANNEL` | This page → **Telegram alerts** | Telegram channel (via **@RawDataBot**) | 🟢 Low |

Only values **1–3** are required for the watcher to work. Values 4 are
recommended but optional; values 5–6 are only needed for Telegram
notifications. This guide focuses on 1–3, with quick instructions for 5–6 at
the end.

> 🔴 **`sessionid` is your Instagram password.** Anyone who has it can read
> your DMs, post as you, and change your password. Never paste it into chat,
> email, screenshots, or commits.

## 2. Get the Instagram cookies — step by step (the main task)

### Step 2.1 — Open Instagram and confirm you are logged in

1. Open <https://www.instagram.com/>.
2. You should see your **feed with posts**. If you see a login form, log in
   first.

### Step 2.2 — Open Developer Tools

1. Press **F12** on the keyboard (or right-click anywhere → **Inspect**).

### Step 2.3 — Open the cookie table

1. Chrome / Edge: click the **Application** tab in the top bar of DevTools
   (if you do not see it, click the **`>>`** overflow menu and pick it there).
2. In the left sidebar, expand **Cookies** and click
   **`https://www.instagram.com`**.
3. A table of cookies appears. Use the **Filter** box at the top of the table
   to type a cookie name — this avoids hunting through ~20 rows.

### Step 2.4 — Copy `sessionid` (the important one)

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

### Step 2.5 — Copy `ds_user_id`

1. Type `ds_user_id` in the Filter box.
2. Click the row named **ds_user_id**.
3. Click the **Value** cell and press **Ctrl+C** (or double-click, then
   Ctrl+C).
4. Paste it into the same Notepad window.
   It is a plain number, usually 8–12 digits, e.g. `1234567890`.

### Step 2.6 — Copy `csrftoken`

1. Type `csrftoken` in the Filter box.
2. Click the row named **csrftoken**.
3. Click the **Value** cell and press **Ctrl+C** (or double-click, then
   Ctrl+C).
4. Paste it into the Notepad window.
   It is 32 hex-like characters, e.g. `a1b2c3d4e5f60718293a4b5c6d7e8f90`.

### Step 2.7 — Optional: copy `mid`, `ig_did`, `rur`

Only if you want to be extra safe (Instagram sometimes asks for these device
cookies). Repeat the same copy steps for each name. They are less sensitive.

### Step 2.8 — Summary check

You should now have three (or six) lines in Notepad:

| Cookie | What it looks like |
| --- | --- |
| `sessionid` | long token, 30–60 chars |
| `ds_user_id` | a number, 8–12 digits |
| `csrftoken` | 32 hex chars |

## 3. Put the values into the app

> **Everything is done on this page (the frontend).** The app stores the
> values for you when you click save — you never write or edit files yourself.

### 3.1 — Paste the cookies

1. On this page, in the **Instagram account** section, paste the three values
   as a JSON array into the **Cookies** box:
   ```json
   [
     { "name": "sessionid", "value": "PASTE_SESSIONID_HERE", "domain": ".instagram.com" },
     { "name": "ds_user_id", "value": "PASTE_DS_USER_ID_HERE", "domain": ".instagram.com" },
     { "name": "csrftoken", "value": "PASTE_CSRF_TOKEN_HERE", "domain": ".instagram.com" }
   ]
   ```
   Include any optional cookies (`mid`, `ig_did`, `rur`) in the same array —
   saving **replaces** the whole cookie list for the account.
2. (Optional) Set an **Account name** — it defaults to `Primary Instagram`.
3. Click **💾 Add account**. The account card appears with a green
   `sessionid ✓` chip.
4. To change the cookies later: paste the new JSON array into the **Cookies**
   box of the account card and click **💾 Save Cookies** (or use the top
   **Instagram account** box and **💾 Save account**).

### 3.2 — Telegram (optional)

In the **Telegram alerts** section, paste the bot token and group chat ID and
click **💾 Save Telegram settings**. Leave a field blank to keep its current
value.

## 4. Verify it works

1. Look at this page (the **🔑 Sources** page): the account card shows a green
   `sessionid ✓` chip — that means your cookies were saved. (If it shows
   `no sessionid`, the values did not save — go back to Section 3.)
2. Start the watcher: run `start-watcher.bat` in the app folder
   (`%LOCALAPPDATA%\IG Feed Watcher`), or rely on the automatic check if you
   ticked **"Check Instagram automatically every 5 minutes"** during install.
   A small window opens and stays open — that is normal; close it to stop.
   The watcher launches a browser with your session and starts scraping your
   feed. A `login required` / 401 error means the cookies are wrong or
   expired — go back to Section 2.
3. The watcher writes a log you can check later:
   `%LOCALAPPDATA%\IG Feed Watcher\logs\watcher.log`.

## 5. Refresh when the values expire

Instagram rotates sessions — expect to repeat Section 2 every few weeks.
Symptoms:

- the watcher logs `login required`, `challenge`, or 401 responses;
- the feed comes back empty or redirects to the login page;
- posting fails with a login / challenge error.

Fix: re-run **Steps 2.4–2.6** and paste the new values on this page
(Section 3). Only the three values need replacing; keep any `mid`, `ig_did`,
`rur` cookies in the same array.

## 6. Telegram values (only if you want notifications)

1. **Bot token** — in Telegram, message **@BotFather** → send `/newbot` →
   choose a name and username → copy the **token** it returns (looks like
   `1234567890:AA...`). Enter it on this page in **Telegram alerts** → **Bot
   token** (keep the token secret).
2. **Channel ID** — create a Telegram channel, add your bot to it as
   **administrator**, then add **@RawDataBot** to the channel and send one
   message. It replies with the channel's numeric ID (usually starts with
   `-100`). Enter it on this page in **Telegram alerts** → **Group chat ID**.
   You can then remove RawDataBot.

## 7. Security rules

- `sessionid` (and the bot token) are full credentials — never paste them
  into chat, email, issues, commits, or screenshots.
- The app saves the values in its folder when you click save
  (`%LOCALAPPDATA%\IG Feed Watcher`) — you never edit those files by hand. If
  you ever shared a value, rotate your Instagram password and your bot token.
- Cookies belong to the login and browser they came from. If you log out of
  Instagram on that browser, the exported values stop working.
- The watcher automates a real browser with your real session. Instagram can
  detect automation — use at your own risk and keep the polling interval
  gentle (5–15 minutes).

## 8. Checklist

| Value | Got it? | Saved where |
| --- | --- | --- |
| `sessionid` | ☐ | This page → **Instagram account** → **Cookies** |
| `ds_user_id` | ☐ | same |
| `csrftoken` | ☐ | same |
| `mid`, `ig_did`, `rur` (optional) | ☐ | same |
| `TG_BOT_TOKEN` (optional) | ☐ | This page → **Telegram alerts** |
| `TELEGRAM_HOME_CHANNEL` (optional) | ☐ | This page → **Telegram alerts** |
