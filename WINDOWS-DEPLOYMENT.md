# Deploying IG Feed Watcher on Windows

**Target user:** someone with **no IT experience** (no terminal, no admin
rights where possible, no manual environment setup).

This document contains:

1. **The study** — what the system needs, and exactly what is Linux-only today.
2. **Three deployment solutions** for a Windows machine, from simplest to most
   polished.
3. **A comparison and a recommendation.**
4. **A click-by-click runbook** for the recommended option.
5. **What was already adapted in this repo** to make Windows work.

---

## 1. The study: what this system needs and what is Linux-only

The system is a plain **Node.js 22** application. The core is already very
portable: it uses only cross-platform Node APIs (`path.join`, custom
`.env.config` parser, `node:sqlite`, Express, Puppeteer with the Chromium
bundled by `npm install`). No compiled native modules, no Python at runtime.

The Windows blockers are all **operational**, not code:

| # | Component | Current (Linux) | Why it breaks on Windows | Status |
| --- | --- | --- | --- | --- |
| 1 | **Post hook** (`hooks/on-new-post.sh`) | `watcher.js` runs it with `spawn('bash', …)` | No `bash` on stock Windows | 🔧 Adapted (Node.js hook + `.cmd`/`.bat` support) |
| 2 | **Scheduling** | `crontab` / Hermes cron every 5 min | No cron on Windows | 🔧 Adapted (`--loop` mode + Task Scheduler scripts) |
| 3 | **Startup/service** | `ig-explorer.service` (systemd) | No systemd | 🔧 Adapted (Task Scheduler + `.bat` launchers) |
| 4 | **Docker stack** | `docker-compose.yml` depends on external `nginx-proxy-manager_npm-network` and only runs the explorer | Network won't exist on a fresh Windows box; no full stack | 🔧 Added `docker-compose.full.yml` (self-contained) |
| 5 | **Helper scripts** | `check-chat.sh`, `create-topic.sh`, `setup-topic.js`/`create-topic.js` hardcode `/home/bsdev/ig-feed-watcher` | Absolute Linux paths; bash | ⚠️ Auxiliary/Hermes tooling only — not needed for deployment |
| 6 | **Cookie export** | `export-cookies.py` reads the Linux Chrome profile | Windows Chrome path differs | ✅ Already solved — `COOKIES-GUIDE.md` is written for Windows (manual DevTools export + PowerShell helper) |
| 7 | **Interactive login** | `login.js` needs a display | Windows *has* a display — this is actually easier on Windows | ✅ Works as-is |

**Requirements to run natively on Windows:** Node.js **≥ 22.5** (the app uses
`node:sqlite`; tested on **22.22 LTS**) and an internet connection for the
one-time `npm install` (Puppeteer downloads Chromium, ~170 MB).

---

## 2. The three solutions

### 🅰️ Solution A — Native: "Install once, then double-click" (recommended)

Ship the project as a folder with `.bat` launchers. The non-IT user does a
one-time guided setup, then double-clicks icons.

**How it works**

1. Copy the project folder to the Windows PC (zip, USB, `git clone`).
2. Double-click **`windows/install.bat`** — it checks Node.js (opens the
   download page if missing), runs `npm install`, creates folders and
   `.env.config`.
3. Double-click **`windows/start-explorer.bat`** — opens the web app at
   `http://localhost:4180`, where the user pastes their Instagram cookies
   (the existing **Sources** page — no file editing).
4. Start the watcher **one** of two ways (both provided):
   - **`windows/start-watcher.bat`** — runs `node watcher.js --loop 5`
     (new continuous mode: one window, checks every 5 minutes), **or**
   - **`windows/install-scheduled-task.bat`** — registers a Windows Task
     Scheduler entry so the watcher runs every 5 minutes forever, even after
     reboot, with no window open.

**Why it fits a non-IT user:** no admin rights, no Docker, no virtualization,
no terminal knowledge — every step is "double-click this file". Update =
replace the folder and re-run `install.bat`.

**Trade-offs:** the user must install Node.js once (a normal install wizard,
accept defaults); two "keep this window open" windows if they don't use the
scheduled task.

---

### 🅱️ Solution B — Docker Desktop: one command, fully reproducible

Run the whole stack in containers with **Docker Desktop for Windows** (WSL2
backend).

**How it works**

1. Install **Docker Desktop** from docker.com (GUI wizard; it installs WSL2).
2. In the project folder: `docker compose -f docker-compose.full.yml up -d`
   (a one-liner; provided as a ready-to-run `.bat`).
3. Everything runs automatically with `restart: unless-stopped`: watcher
   (loop mode), web explorer on `4180`, posting API on `4030`.

**Why it's attractive:** zero per-machine Node/Puppeteer setup, identical
environment everywhere, auto-restart, easy updates (`docker compose pull &&
up -d`). The compose file was adapted to be **self-contained** — it no longer
needs the Linux-only `nginx-proxy-manager` network.

**Trade-offs:** Docker Desktop install needs **admin rights**, WSL2, and CPU
virtualization enabled in the BIOS — the most common failure point for
non-IT users; first build downloads the image + Chromium (large); Docker
Desktop itself is another app to keep updated.

---

### 🅲 Solution C — A real Windows installer: one `.exe`, "like any other program"

Build the deployment into a standard **setup executable** that installs
everything and creates Start Menu / desktop shortcuts and an uninstaller —
the most familiar Windows experience.

**How it works**

1. A build machine produces **`IG-Feed-Watcher-Setup.exe`** (e.g. **Inno
   Setup** or **NSIS**, both free).
2. The installer: bundles a **portable Node.js runtime** + the app + Chromium
   (so no separate Node install), writes `.env.config`, registers the Task
   Scheduler entry, creates **"IG Feed Watcher"** desktop/Start Menu icons,
   and installs an **uninstaller**.
3. The user just runs the `.exe`, clicks Next/Finish, and double-clicks the
   desktop icon. Updates = run the new `.exe` again.

**Why it's the most polished option:** zero downloads beyond one file, no
Node.js knowledge, standard Windows look-and-feel, clean uninstall. Also the
easiest to distribute (a single file by email/USB).

**Trade-offs:** requires setting up a small **build pipeline** (NSIS can be
run on Linux CI; Inno Setup needs Windows/Wine) and maintaining it when the
app changes; the Chromium bundle makes the installer large (~200 MB); more
up-front engineering than A.

---

## 3. Comparison

| Criterion | 🅰 Native `.bat` folder | 🅱 Docker Desktop | 🅲 Installer `.exe` |
| --- | --- | --- | --- |
| User needs IT skills? | No | Some (Docker Desktop, BIOS) | No |
| Admin rights needed? | No | **Yes** (installer + WSL2) | No (per-user install) |
| Steps for the user | Install Node once + 3 double-clicks | Install Docker + 1 command | Download + run one `.exe` |
| Auto-start on reboot | Yes (scheduled task) | Yes (restart policy) | Yes (scheduled task) |
| Works fully offline after setup | Yes | Partially (containers local) | Yes |
| Fits Windows 10/11 Home | Yes | Home needs manual WSL2 steps | Yes |
| Effort to build/maintain | Low | Low | Medium (build pipeline) |
| Best for | **Start today, simplest** | Reproducible/ops-heavy setups | **End-user polish, distribution** |

---

## 4. Recommendation

**Start with Solution A.** It needs nothing beyond Node.js (which the non-IT
user installs with a normal wizard, accepting defaults), requires no admin
rights, and every step is "double-click a file". The continuous `--loop` mode
and the scheduled-task scripts mean no Linux knowledge is required at all.

**Move to Solution C** if you will distribute this to several people or want
the "install like any normal program" experience — the engineering cost is a
small build pipeline.

**Use Solution B only** if the target machine already runs Docker Desktop, or
if you value environment reproducibility over simplicity. For a strictly
non-IT user it has the highest chance of a failed first install (BIOS
virtualization, WSL2, admin prompts).

---

## 4b. Distributing to several people (3 recipients)

When shipping to multiple non-IT people, **Solution C (installer `.exe`) is the
end goal**: one file, standard wizard, shortcuts, scheduled task, uninstaller.
A draft Inno Setup script lives in `windows/installer/ig-feed-watcher.iss`.

**Continue this work on a Windows machine** — the `.bat`/`.ps1` files, the
Windows code paths in `watcher.js`, Task Scheduler, Chromium, and the
installer build can only be validated there. The full, self-contained
handoff for that session is [`HANDOFF-WINDOWS.md`](HANDOFF-WINDOWS.md)
(validation plan, secrets checklist, installer build, clean-machine
acceptance test, gotchas, definition of done).

---

## 5. Click-by-click runbook (Solution A)

> For the person who will operate the Windows machine. No technical
> knowledge needed — follow the order.

1. **Get the files** — copy the `ig-feed-watcher` folder onto the PC
   (e.g. unzip it on the Desktop).
2. **Install Node.js** *(one time only)* — double-click
   `windows\install.bat`. If it says Node.js is missing, it opens the
   download page; click the big green **Windows Installer** button, run the
   download, click **Next** through the wizard (accept defaults), then run
   `install.bat` again. Wait for it to finish ("Setup complete! ✅").
3. **Add your Instagram account** — double-click
   `windows\start-explorer.bat`. Your browser opens the app at
   `http://localhost:4180`. Click **🔑 Sources** and paste your cookies
   (follow `COOKIES-GUIDE.md` — it was written for Windows). Leave this
   window open.
4. **Start watching** — do **one** of these:
   - *Keep it simple:* double-click `windows\start-watcher.bat` and leave the
     black window open (it checks Instagram every 5 minutes), **or**
   - *Set and forget:* double-click `windows\install-scheduled-task.bat` once.
     Windows then runs the watcher every 5 minutes by itself, even after
     restarting the PC.
5. **Done.** New posts appear in Telegram (photo + caption) and in the web
   app. To see the app later, double-click `start-explorer.bat` again.

**If something looks wrong:** close all black windows, double-click
`windows\start-all.bat`, and check the browser app. To stop the automatic
watcher, double-click `windows\uninstall-scheduled-task.bat`.

---

## 6. What was adapted in this repo

| File | Change |
| --- | --- |
| `watcher.js` | Cross-platform hook runner (`.js`/`.cmd`/`.bat`/`.sh` by extension, `cmd.exe` on Windows); hook path now honors `HOOK_SCRIPT` env and defaults to `hooks/on-new-post.js` on Windows; new **`--loop [minutes]`** continuous mode (self-contained scheduling, no cron needed) |
| `hooks/on-new-post.js` | New — Node.js equivalent of the bash hook (same logging/priority behaviour, project-relative paths) |
| `windows/install.bat` | One-time non-IT setup (Node check → `npm install` → folders → `.env.config`) |
| `windows/start-explorer.bat` / `start-watcher.bat` / `start-all.bat` | Double-click launchers (watcher uses `--loop`) |
| `windows/install-scheduled-task.ps1` / `.bat`, `uninstall-scheduled-task.ps1` / `.bat` | Registers/removes the 5-minute Task Scheduler entry (no admin needed) |
| `docker-compose.full.yml` | New — self-contained full stack (watcher + explorer + posting API), no external Linux network; the Docker route (Solution B) |
| `Dockerfile.full` | New — full image with Chromium system deps + `npm ci` (the old `Dockerfile` stays as-is for the explorer-only deployment) |
| `.dockerignore` | No longer excludes `watcher.js`, `post-server.js`, `poster.js`, `hooks` (needed by the full image; secrets/data stay excluded) |

**Notes**

- The **Linux deployment is untouched**: `docker-compose.yml`, `Dockerfile`,
  systemd unit, and the bash hook remain the default there. Windows simply
  uses `hooks/on-new-post.js` and the `windows/` launchers.
- `HOOK_SCRIPT` is now honored from `.env.config` / the environment. The
  template has it commented out so the platform default applies; if you set it
  on Windows, point it at a `.js` or `.cmd` hook (not `.sh`).
- On Windows, `--no-sandbox` Puppeteer flags are harmless (Chromium ignores
  them); `puppeteer.executablePath()` resolves to the Chromium that
  `npm install` downloaded.
- The Hermes-only helpers (`create-topic.js`, `check-chat.sh`, …) hardcode
  the original server's paths; they are not part of the Windows deployment.
