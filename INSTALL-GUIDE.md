# IG Feed Watcher — How to Install (1 page)

> For: the 3 people receiving IG Feed Watcher. No technical knowledge needed.
> Time: about 5 minutes. You will need: your Instagram login (to get cookies)
> and optionally a Telegram account.

---

## Step 1 — Install the app (2 minutes)

1. Double-click **`IG-Feed-Watcher-Setup-1.1.0.exe`**.
2. Windows may show **"Windows protected your PC"** → click
   **More info → Run anyway** (the app is not code-signed yet).
3. Click through the wizard (**Next → Install**). Leave the checkboxes as you
   like:
   - ☐ **Check Instagram automatically every 5 minutes** — tick this if you
     want alerts without keeping a window open (recommended).
   - ☑ **Create a desktop icon** — already ticked; leave it on so you get a
     shortcut on your desktop.
4. Click **Finish**. The web app opens in your browser at
   **http://localhost:4180**.

The app is installed in *your user folder* — no administrator password needed.

## Step 2 — Add your Instagram account (2 minutes)

Follow **`COOKIES-GUIDE.md`** (inside the installed folder, or ask the sender
for a copy). In short:

1. In Chrome/Edge: log in to **instagram.com**.
2. Press **F12** → **Application** → **Cookies** → **instagram.com**.
3. Copy the **sessionid**, **ds_user_id** and **csrftoken** values.
4. Open the web app (**http://localhost:4180**), go to **🔑 Sources**, paste
   the values, save.

## Step 3 — Optional: Telegram alerts (2 minutes)

Follow `COOKIES-GUIDE.md`:

1. In Telegram, message **@BotFather** → `/newbot` → pick a name → copy the
   **token**.
2. In the app's **Sources** page (or `.env.config` in the app folder), paste
   the token and your **channel/chat ID**.
3. Save. Your first new post will trigger a photo + caption alert.

---

## Day-to-day

| I want to…                        | Do this |
| ---                               | --- |
| See the feed / change cookies     | Double-click the **IG Feed Watcher** icon (desktop or Start menu) → opens http://localhost:4180 |
| Check automatically every 5 min   | Tick the box during install (recommended). Windows runs it in the background — even after restart. |
| Check manually right now          | Start menu → **IG Feed Watcher** folder → **Watcher** (or double-click `start-watcher.bat`). |
| Stop automatic checking           | Start menu → **IG Feed Watcher** folder → **Uninstall automatic watcher**. |

## Troubleshooting

- **"Windows protected your PC"** → More info → Run anyway (Step 1).
- **App won't open / antivirus blocks it** → add an exception for the app
  folder (`%LOCALAPPDATA%\IG Feed Watcher`). Your antivirus may quarantine
  the bundled Chrome browser on first run.
- **No alerts** → check Step 2 (cookies) and Step 3 (Telegram). Errors are
  logged in the app folder: `logs\watcher.log`.
- **Wrong time** → alerts use your PC clock; keep it correct.

## Uninstalling

Settings/Apps → **IG Feed Watcher** → Uninstall. Shortcuts, the background
task and the app are removed. (Your saved cookies/config in
`%LOCALAPPDATA%\IG Feed Watcher` are kept, delete that folder to fully wipe.)

---
*One file, one wizard, done. Questions? Contact the sender.*
