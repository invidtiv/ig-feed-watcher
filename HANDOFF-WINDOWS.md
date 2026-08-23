# HANDOFF — Continue IG Feed Watcher Windows Deployment on a Windows Machine

> **Who this is for:** the agent (or human) continuing this work **on a Windows
> machine**. This document is fully self-contained — it does not assume access
> to the original session. Read it top to bottom, then execute **Phase 1 → 4**
> in order.

---

## 1. Mission

Finish and ship a **Windows deployment of the IG Feed Watcher** for
**distribution to 3 people with no IT experience**. The end deliverable is a
**single Windows installer `.exe`** (Solution C in
[`WINDOWS-DEPLOYMENT.md`](WINDOWS-DEPLOYMENT.md)) that a non-technical person
can run and be done in ~5 minutes — plus a validated runtime underneath it.

**Interim path:** until the installer exists, the `windows/` folder already
provides a working "install once, double-click" deployment (Solution A) that
must be **validated on Windows first** (Phase 1). The installer is Phase 3.

---

## 2. Why this MUST continue on Windows (not Linux)

The previous session ran on Linux. Everything below is **untested** and can
only be verified here:

| Item | Status |
| --- | --- |
| `windows/*.bat` (8 files) — never executed anywhere | ❌ untested |
| `windows/*.ps1` scheduled-task scripts | ❌ untested |
| `watcher.js` win32 branch of the hook runner (`cmd.exe`, `.cmd`/`.bat` hooks) | ❌ untested |
| `watcher.js --loop` continuous mode on Windows | ❌ untested |
| `node:sqlite` (built-in DB) on Windows Node 22.22 | ❌ untested |
| Puppeteer Chromium download + launch on Windows | ❌ untested |
| Task Scheduler registration (no-admin) | ❌ untested |
| Folder paths **with spaces** (e.g. `C:\Users\X\My Stuff\...`) | ❌ untested |
| Building the installer (Inno Setup) — Windows-only tooling | ❌ untested |
| Clean-machine acceptance test (fresh user, no dev tools) | ❌ untested |

The Linux side is **already working and must not be broken**: `watcher.js`,
`server.js`, `post-server.js`, `hooks/on-new-post.sh`, `docker-compose.yml` /
`Dockerfile` (explorer-only deployment) stay as they are.

---

## 3. Project context (for an agent that can't see the previous session)

**What the app does:** a headless Instagram feed watcher. Every N minutes it
logs into Instagram with stored session cookies, reads the home feed, detects
new posts, saves a screenshot, sends a **Telegram notification** (photo +
caption), and runs a **hook script** with the post JSON on stdin (default hook
logs to `logs/posts.log`, priority posts to `logs/priority-posts.jsonl`).

**Three components (all Node.js 22, no native modules):**

| Component | File | Port | Purpose |
| --- | --- | --- | --- |
| Watcher | `watcher.js` | — | polling + screenshot + Telegram + hook |
| Web Explorer | `server.js` | **4180** | web UI (feeds, groups, **Sources** page for pasting cookies) + data API |
| Posting API | `post-server.js` | **4030** | optional: post images to IG via Puppeteer |

**Key facts:**

- Config is a plain `.env.config` file (custom parser, KEY=VALUE lines, `#`
  comments). Telegram token/channel live there.
- Sources (one per Instagram account) live in `sources.json`; if absent, the
  legacy `cookies.json` is used. **Each recipient pastes their own cookies via
  the web UI → 🔑 Sources page** — no file editing needed.
- `COOKIES-GUIDE.md` is already a **Windows step-by-step** (DevTools cookie
  export + PowerShell helper + Telegram bot setup via @BotFather). Recipients
  follow it.
- DB is `posts.db` via `node:sqlite` (**requires Node ≥ 22.5**; tested on
  22.22 LTS).

**What the previous session already changed (all committed/added):**

- `watcher.js` — cross-platform hook runner; `HOOK_SCRIPT` env/config honored
  (default: `hooks/on-new-post.js` on Windows, `on-new-post.sh` elsewhere);
  new `--loop [minutes]` continuous mode.
- `hooks/on-new-post.js` — Node.js hook equivalent of the `.sh` one.
- `windows/` — `install.bat`, `start-explorer.bat`, `start-watcher.bat`,
  `start-all.bat`, `install-scheduled-task.{bat,ps1}`,
  `uninstall-scheduled-task.{bat,ps1}`.
- `windows/installer/ig-feed-watcher.iss` — **draft Inno Setup script**
  (Solution C starting point; adapt paths, then compile on Windows).
- `windows/install-scheduled-task.ps1` already prefers a **bundled
  `node.exe`** next to the app and falls back to Node on PATH — so it works
  both when the user installs Node and when the installer ships portable Node.
- `docker-compose.full.yml` + `Dockerfile.full` — self-contained full stack
  (Docker route, validated syntactically with `docker compose config`).
- `WINDOWS-DEPLOYMENT.md` — study + 3 solutions + comparison + non-IT runbook.
- `.dockerignore`, `.env.example`, `README.md` — minor adjustments.

**The 3 solutions (see `WINDOWS-DEPLOYMENT.md` for the full comparison):**

- **A — Native folder + `.bat` launchers** (zero admin, simplest) → *use to
  validate first.*
- **B — Docker Desktop + compose** (most reproducible, but needs admin + WSL2
  + BIOS virtualization — worst fit for non-IT distribution).
- **C — Single installer `.exe` (Inno Setup)** → *the end goal for 3
  recipients: one file, standard wizard, shortcuts, scheduled task,
  uninstaller.*

**Decision for 3 recipients: build Solution C; validate on top of A.**
If the installer is delayed, A is a perfectly usable interim (folder + a
one-page "how to install" note).

---

## 4. FIRST: verify repo state + secrets hygiene (5 min)

1. `git status` — working tree should match: modified `watcher.js`,
   `README.md`, `.env.example`, `.dockerignore`; new files `WINDOWS-DEPLOYMENT.md`,
   `HANDOFF-WINDOWS.md`, `hooks/on-new-post.js`, `docker-compose.full.yml`,
   `Dockerfile.full`, `windows/` (and `windows/installer/`).
2. Confirm **nothing sensitive is tracked**: real `cookies.json`, `sources.json`,
   `.env.config`, `posts.db`, `state.json`, `screenshots/`, `logs/` must be
   gitignored and never committed/pushed (they contain **real Instagram
   session cookies and a live Telegram bot token**).
3. Make a working copy for testing: copy the project to a path **with spaces**
   (e.g. `C:\Users\<you>\My Projects\ig-feed-watcher`) and a path **without
   spaces** — test both.
4. **Never** run tests against the real `sources.json`/`cookies.json` unless
   you intend to hit Instagram with that account. For validation use a
   disabled-sources config (see Phase 1, test 4).

---

## 5. Phase 1 — Validate the runtime on Windows (Solution A path)

**Setup**

1. Install **Node.js 22.22 LTS** (nodejs.org → Windows Installer → Next →
   Next… accept defaults). Verify in a NEW terminal: `node --version` → v22.x.
2. In the project folder run: `npm install` — first run downloads Chromium
   (~170 MB). If it fails behind a proxy/AV, retry, or set
   `PUPPETEER_DOWNLOAD_BASE_URL` to a mirror.
3. Run `windows\install.bat` — expect "Setup complete! ✅".

**Test matrix — every row must pass; record anything that doesn't:**

| # | Test | How | Expected |
| --- | --- | --- | --- |
| 1 | Node hook | `node hooks\on-new-post.js` with sample JSON piped in | logs line + "Hook completed" |
| 2 | `.cmd` hook path | Spawn test: `node -e "const{spawn}=require('child_process');const c=spawn('cmd.exe',['/d','/s','/c','C:\\<path with spaces>\\test.cmd'],{stdio:['pipe','pipe','pipe']});c.stdin.write('hi');c.stdin.end();c.stdout.on('data',d=>console.log('OUT',d.toString()));c.on('close',()=>console.log('closed'))"` (create `test.cmd` first: `@echo off & set /p X= & echo got %X%`) | "OUT got hi", exit 0 — proves the `cmd.exe` branch of the hook runner |
| 3 | Loop mode (safe) | Back up `sources.json`; replace with `{"sources":[]}`; run `node watcher.js --loop 1` | logs "No enabled sources", a run completes, next tick logs after 1 min; Ctrl+C stops. **Restore sources.json after.** |
| 4 | Explorer | `node server.js`, open `http://localhost:4180` | web UI loads; Sources page renders |
| 5 | Launchers | `start-explorer.bat`, `start-watcher.bat`, `start-all.bat` (each from Explorer double-click AND from a console) | windows open, apps start |
| 6 | Scheduled task | `install-scheduled-task.bat` → check Task Scheduler → `uninstall-scheduled-task.bat` | task "IG Feed Watcher" created/removed; task runs once manually |
| 7 | End-to-end (optional, real account) | real cookies in `sources.json`, `node watcher.js` once | new post → screenshot + Telegram + hook log |

**Fix anything that fails and commit.** Common Windows issues: CRLF endings in
`.bat` (keep CRLF for `.bat`, LF fine for `.ps1`/`.js`), `node` not on PATH in
already-open terminals, execution policy (scripts already pass
`-ExecutionPolicy Bypass`), Defender flagging `chrome.exe` (add an exclusion).

---

## 6. Phase 2 — Prepare the clean distribution source (privacy is critical)

Build a **clean folder** that is safe to distribute and per-recipient
personalizable. From a fresh copy of the repo, **delete** (or never copy):

- ❌ `cookies.json`, `sources.json`, `.env.config` (real secrets!)
- ❌ `posts.db`, `state.json`, `logs/`, `screenshots/`, `uploads/` (personal data)
- ❌ `.git/`, `node_modules/` (see note), `presentation/` (optional)

Include: app code (`*.js`, `hooks/`, `api/`, `skills/`), `package.json` +
`package-lock.json`, `.env.example`, `sources.example.json`,
`COOKIES-GUIDE.md`, `README.md`, `windows/`, `WINDOWS-DEPLOYMENT.md`.

> **Automate this with `windows\installer\prepare-stage.ps1`** — it copies the
> clean file set into `windows\installer\stage\` using exactly the rules above
> (never touches the stage's pre-built `node.exe`, `node_modules\`, or
> `.puppeteer-cache\`) **and strips the personal "Photos" group from
> `stage\groups.json`** so recipients never get that test group seeded. The
> repo's own `groups.json` (live local data) is left untouched. Run it before
> every installer build.

**Two packaging models — decide with the user if unsure:**

- **M1 — require Node install (smaller, simpler installer):** recipient runs
  `install.bat` which installs Node if missing. Used by Solution A as-is.
- **M2 — bundle portable Node + Chromium (bigger, zero-dependency):**
  download the official `node-v22.x-win-x64.zip`, and pre-run `npm install` so
  `node_modules` (incl. Puppeteer's Chromium) ships pre-built. This is what
  the **installer (Solution C)** should use → one `.exe` ≈ 250 MB.

**Per-recipient personalization (each person does their own):**
Instagram cookies (Sources page) and Telegram bot/channel (`COOKIES-GUIDE.md`).
⚠️ **Open product question to confirm with the user:** should all 3 recipients
receive alerts in a **shared Telegram channel**, or each create their **own
bot/channel**? The installer must not hardcode the current owner's token —
always create `.env.config` from `.env.example` with placeholders.

---

## 7. Phase 3 — Build the installer (Solution C, the end goal)

Tool: **Inno Setup 6** (free, jrsoftware.org). A **draft script** is provided
at `windows/installer/ig-feed-watcher.iss` — adapt the staging layout and
`[Files]` sources to your build folder, then compile (right-click → Compile,
or `ISCC.exe ig-feed-watcher.iss`).

**Before every build, run `windows\installer\prepare-stage.ps1`** — it
refreshes `stage\` with the latest app files and removes the personal
"Photos" group from `stage\groups.json` (the wizard task "Create a desktop
icon" is checked by default in the `.iss`).

**Bundled Node:** the installer ships portable `node.exe` beside the app (NOT
on PATH). The `.iss` calls `{app}\node.exe server.js` for shortcuts, and
`windows\install-scheduled-task.ps1` already resolves the bundled
`node.exe`. The `.bat` launchers stay PATH-based — they belong to the
Solution A folder workflow (M1), not the installer.

**The installer must:**

1. Install into `{autopf}\IG Feed Watcher` (or `{localappdata}` for
   no-admin — **check the no-admin requirement with the user; `{localappdata}`
   avoids UAC entirely and is the safer default for non-IT users**).
2. Ship (M2): portable `node.exe` + app + prebuilt `node_modules` + `.bat`
   launchers + `COOKIES-GUIDE.md`.
3. On install, if `.env.config` missing → create from `.env.example`.
4. Register the scheduled task **via checkbox** (`[Tasks]`) using the existing
   `windows/install-scheduled-task.ps1` (`[Run]` step, `runhidden`,
   `-ExecutionPolicy Bypass`), or `schtasks /Create /SC MINUTE /MO 5`.
5. Create **Start Menu + desktop shortcuts** to `start-explorer.bat`.
6. Provide an **uninstaller** (Inno does this automatically) that also removes
   the scheduled task.
7. **Do not** ship `sources.json`/`cookies.json` — recipient pastes cookies in
   the web UI on first run.

**SmartScreen:** an unsigned `.exe` shows "Windows protected your PC" →
recipients click **More info → Run anyway**. Best practice: buy a cheap
code-signing cert, or accept the warning and document it in the one-pager.

**Build & version:** output to `dist\IG-Feed-Watcher-Setup-<version>.exe`;
bump the version per release; keep a SHA-256 hash alongside.

---

## 8. Phase 4 — Acceptance test on a CLEAN machine (the non-IT simulation)

On a **clean Windows VM or a spare machine / fresh user account** with **no
Node.js and no dev tools**:

1. Copy ONLY the installer (M2) → double-click → wizard → Finish.
2. Verify: desktop + Start Menu shortcuts work; `http://localhost:4180` loads;
   Sources page accepts pasted cookies; scheduled task exists and fires.
3. Verify a real new post → screenshot + Telegram alert + `logs\posts.log`
   entry (task or loop mode).
4. **Restart the PC** → watcher still runs (scheduled task) / explorer
   restarts.
5. Uninstall → shortcuts gone, task gone.
6. Record the total time a non-technical person would need (target: ≤ 5 min).

---

## 9. Distribution to the 3 people

- Deliver **one `.exe` per person** + a **1-page "How to install" sheet**
  (plain language, screenshots) — generate a simple PDF/HTML. Note: email
  attachments cap around 25 MB → use a cloud link or USB for a ~250 MB file.
- Each recipient: install → open app → paste cookies → (optional) Telegram
  setup per `COOKIES-GUIDE.md`. Support channel = whatever the user decides.

---

## 10. Gotchas & known issues (read before starting)

- **`.bat` files need CRLF** line endings (some `cmd.exe` constructs misbehave
  with LF-only). `.ps1`/`.js` are fine with LF.
- **`node:sqlite` needs Node ≥ 22.5** — do not let the installer accept older.
- **Path with spaces** — the `.bat` files use `%~dp0` with quotes; Phase 1
  test 5 covers this. `start-all.bat` uses the `start "title" cmd /k ""path""`
  quoting idiom — verify it.
- **PowerShell execution policy** — launchers already use
  `-ExecutionPolicy Bypass`.
- **Task Scheduler** runs under the logged-on user; `StartWhenAvailable` is
  already set so missed runs (PC off) execute on next wake.
- **Double scheduling** — recipient should use EITHER the scheduled task OR
  `start-watcher.bat` (loop mode), not both (state dedupes posts, but avoid
  double Chromium instances).
- **Defender/AV** may quarantine Puppeteer's `chrome.exe` on first run — add
  an exclusion in the one-pager.
- **Chromium download** may be slow/blocked; mirror via
  `PUPPETEER_DOWNLOAD_BASE_URL` if needed.
- **Timezone/clock** — timestamps come from the PC clock; keep it correct.
- The previous session's `server.js` binds `4180` on all interfaces — fine on
  a home LAN, but note the posting API (`4030`) has **no auth**; do not expose
  it publicly.

---

## 11. Definition of done (checklist)

- [ ] Phase 1 test matrix fully passes on Windows (both spaced and non-spaced paths)
- [ ] Any fixes committed; Linux deployment still intact (`git log` shows no
      regressions to `docker-compose.yml`/`Dockerfile`/`.sh` hook behavior)
- [ ] Clean distribution folder verified: zero secrets, zero personal data
- [ ] Installer builds reproducibly; versioned output + SHA-256
- [ ] Clean-machine acceptance test passed (Phase 4), including PC restart
- [ ] 1-page install sheet written for recipients
- [ ] Open questions answered: Telegram channel model (shared vs per-person),
      no-admin install location (`{localappdata}` vs Program Files)

---

## 12. Report back

Report: which tests failed and how they were fixed; the final installer path +
SHA-256; clean-machine test results; the recipient one-pager; and the open
questions above. If the installer is blocked, ship Solution A (folder +
one-pager) as interim and say so.
