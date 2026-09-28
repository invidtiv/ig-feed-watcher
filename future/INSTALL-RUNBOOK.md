# IG Feed Watcher — Installation Runbook

**Audience:** the operator building and delivering the Windows bundle.
**Not** the recipient — hand recipients [`INSTALL-GUIDE.md`](../INSTALL-GUIDE.md).
**Lifetime:** this file lives in `future/`, which `prepare-stage.ps1` excludes
from the installer, so it is never shipped.

---

## 0. Scope

This runbook covers the **self-contained Windows bundle** (packaging model M2):
one `.exe` carrying a portable Node runtime, prebuilt `node_modules`, and
bundled Chromium. The recipient needs no Node install, no admin rights, and no
command line.

If you need the smaller "recipient already has Node" model (M1), that is a
different artifact — see `WINDOWS-DEPLOYMENT.md` Solution A.

---

## 1. Build the artifact

Run from the repo root.

```powershell
# 1. Set the version in windows\installer\ig-feed-watcher.iss  (#define MyAppVersion)
#    and keep these in step with it:
#      package.json           "version"
#      api\openapi.json       info.version
#      INSTALL-GUIDE.md       the Setup-<version>.exe filename in Step 1

# 2. Refresh the stage from the repo (this is what pulls code changes in).
powershell -NoProfile -ExecutionPolicy Bypass -File windows\installer\prepare-stage.ps1

# 3. Compile. ISCC is usually NOT on PATH.
& "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe" windows\installer\ig-feed-watcher.iss

# 4. Checksum. Match the existing convention EXACTLY: lowercase hex, two
#    spaces, filename, CRLF. certutil emits uppercase - do not use it to write
#    the file, only to verify.
$exe = "dist\IG-Feed-Watcher-Setup-<version>.exe"
$hash = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
[System.IO.File]::WriteAllText(
  "$exe.sha256",
  "$hash  IG-Feed-Watcher-Setup-<version>.exe`r`n",
  (New-Object System.Text.ASCIIEncoding))
```

The compile takes roughly **2–3 minutes** (LZMA2 over a ~665 MB stage).
A correct result is about **191 MB**. Expect exit code `0`.

> **Never reuse a version number that already exists in `dist\`.** The build
> overwrites silently, and an older checksum file will then describe a different
> binary. Bump the patch digit instead.

`ISCC` prints one harmless warning about `[UninstallRun]` lacking a
`RunOnceId`. It does not affect the build. It means that if the uninstaller were
ever run twice, the task-removal step could execute twice — which is idempotent,
so it is benign.

---

## 2. Pre-flight verification (do this before sending)

```powershell
$exe = "dist\IG-Feed-Watcher-Setup-<version>.exe"

# a) Exists, right size (~191 MB), and the hash matches its sidecar
Get-Item $exe | Select-Object Length, LastWriteTime
certutil -hashfile $exe SHA256
Get-Content "$exe.sha256"

# b) Version string is embedded and the PREVIOUS version is not.
#    Substitute the two versions you are moving between.
$new = '1.5.1'; $old = '1.5.0'
$b = [System.IO.File]::ReadAllBytes((Resolve-Path $exe))
function Find-Utf16($hay,$needle){ $p=[Text.Encoding]::Unicode.GetBytes($needle)
  for($i=0;$i -le $hay.Length-$p.Length;$i++){ $ok=$true
    for($j=0;$j -lt $p.Length;$j++){ if($hay[$i+$j] -ne $p[$j]){$ok=$false;break} }
    if($ok){return $i} } return -1 }
"new version : $(Find-Utf16 $b $new)"   # must be >= 0
"old version : $(Find-Utf16 $b $old)"   # must be -1

# c) The stage that was compiled matches the repo (proves your code change shipped)
(Get-FileHash watcher.js -Algorithm SHA256).Hash
(Get-FileHash windows\installer\stage\watcher.js -Algorithm SHA256).Hash   # must match

# d) Nothing personal or internal leaked into the stage
Test-Path windows\installer\stage\future            # must be False
Test-Path windows\installer\stage\cookies.json      # must be False
Test-Path windows\installer\stage\sources.json      # must be False
Test-Path windows\installer\stage\.env.config       # must be False
Test-Path windows\installer\stage\posts.db          # must be False
(Get-Content windows\installer\stage\groups.json -Raw) -match 'Photos'   # must be False

# e) Test suite still green
node --test        # if the harness sandbox blocks spawn, run each file: node test\<file>.test.js
```

---

## 3. What the recipient does

Send **two** files together — the `.exe` **and** its `.sha256`, or the checksum
is unverifiable:

1. `IG-Feed-Watcher-Setup-<version>.exe`
2. `IG-Feed-Watcher-Setup-<version>.exe.sha256`
3. `INSTALL-GUIDE.md` (one page, non-technical)

Recipient flow, for your reference:

| Step | Action | Result |
| --- | --- | --- |
| 1 | Double-click the `.exe` | SmartScreen warning → **More info → Run anyway** (unsigned) |
| 2 | Click through the wizard | Installs to `%LOCALAPPDATA%\IG Feed Watcher` — **no admin prompt** |
| 3 | Optionally tick **"Check Instagram automatically every 5 minutes"** | Registers the scheduled task |
| 4 | **Finish** | Browser opens `http://localhost:4180` |
| 5 | Add cookies via **🔑 Sources** | Account card shows a green `sessionid ✓` |
| 6 | (Optional) Telegram | :warning: **see §5 — this step is broken as shipped** |

The install is **per-user**. Two Windows users on one PC get independent installs
and independent data.

---

## 4. Acceptance test (run on a clean machine before delivery)

A "clean machine" means one that has **never** had this app installed, and
ideally no Node on PATH — that is the whole point of the M2 bundle.

| # | Check | How | Pass condition |
| --- | --- | --- | --- |
| 1 | Installs without admin | Run as a standard user | No UAC prompt; folder exists under `%LOCALAPPDATA%` |
| 2 | Explorer starts | Double-click the desktop/Start icon | `http://localhost:4180` loads the feed UI |
| 3 | Sources page renders | Click **🔑 Sources** | Page loads, no JS errors in console |
| 4 | Cookies save | Paste cookie JSON → **Add account** | Green `sessionid ✓` chip appears |
| 5 | Scheduled task | `Get-ScheduledTask -TaskName 'IG Feed Watcher'` | Task present, state `Ready` |
| 6 | Watcher runs | `Start-ScheduledTask -TaskName 'IG Feed Watcher'`, then read `%LOCALAPPDATA%\IG Feed Watcher\logs\watcher.log` | A run completes; **not** "No enabled sources" |
| 7 | End-to-end | With real cookies, wait for a new post | Screenshot in `screenshots\`, hook line in `logs\posts.log` |
| 8 | Uninstall is clean | Settings → Apps → uninstall | Program files, shortcuts, and the task are all gone |

Record the outcome of every row, especially failures. Row 6 is the one that
catches the most common misconfiguration.

---

## 5. Known blocker: Telegram alerts cannot be configured from the UI

**This contradicts `INSTALL-GUIDE.md` Step 3 and `COOKIES-GUIDE.md` §3.2, both of
which tell the recipient to save Telegram settings with a button in the web UI.
On a default install that button does not work.**

Why: the Explorer API is read-only unless `FULL_AGENT=1` is set. `PUT
/api/settings/telegram` is a mutation, so it returns:

```
405  {"error":"Read-only API: set FULL_AGENT=1 to allow non-GET requests."}
```

The recipient sees that text as an error toast — mentioning a variable that
appears in none of the shipped documentation. Cookies are unaffected, because
`sources.json` is written through a route that works in read-only mode; only the
Telegram settings are blocked.

**Workaround A — edit the config file (recommended).** No security downside.

1. Open `%LOCALAPPDATA%\IG Feed Watcher\.env.config` in Notepad.
2. Replace the placeholders:
   ```dotenv
   TG_BOT_TOKEN=123456:ABC-your-real-token
   TELEGRAM_HOME_CHANNEL=-1001234567890
   ```
   The file is created from `.env.example` at install time, so it already
   contains `YOUR_BOT_TOKEN_HERE` / `YOUR_CHANNEL_ID_HERE`. Those placeholder
   values count as *unset* — leaving them in place yields **no alerts and no
   error**, which is why this failure is easy to miss.
3. Save. The watcher re-reads `.env.config` on every message, so **no restart is
   needed**.

**Workaround B — enable `FULL_AGENT=1`.** Add `FULL_AGENT=1` to `.env.config`
and restart the Explorer. Understand the trade-off before doing this: with no
authentication anywhere on the Explorer and a `0.0.0.0` bind, it also unlocks
every group/source mutation route to anything that can reach port 4180. Prefer
A unless the recipient needs agent-driven writes.

**Also set expectations for the posting API.** `post-server.js` mounts the same
guard, so the Instagram **posting** API documented in `README.md` returns `405`
on `POST /post` until `FULL_AGENT=1`. If the recipient is meant to publish
through it, that flag must be set deliberately — it is not on by default.

---

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| No alerts at all, no error in the log | `.env.config` still holds the `YOUR_..._HERE` placeholders — they are treated as unset | Set real values (§5) |
| `Read-only API: set FULL_AGENT=1` toast | Expected on a default install | Use §5 Workaround A |
| "Windows protected your PC" | Installer is not code-signed | More info → Run anyway; tell the recipient this is expected |
| Antivirus quarantines the app | Bundled `chrome.exe` looks suspicious to heuristics | Add an exclusion for `%LOCALAPPDATA%\IG Feed Watcher` |
| `logs\watcher.log` says "No enabled sources" | No cookies saved, or every source is marked `enabled: false` | Re-do the **🔑 Sources** step |
| `Session expired` / login required | Cookies rotated or were copied wrong | Re-export cookies (they expire every few weeks) |
| Task exists but never runs | The app folder was **moved** after install, or the task was registered from an older install path | Re-run `windows\install-scheduled-task.bat` from the new folder |
| Task runs, nothing happens | Task points at a previous version's `node.exe` | Re-run the installer, or re-register the task (see below) |
| Port 4180 already in use | A second copy of the Explorer is running | Stop the other instance; only one Explorer per machine |
| Explorer unreachable from another PC | By design on some builds — check the bind before promising LAN access | Confirm `app.listen` host in `server.js` |

**The scheduled task survives reinstalls and records an absolute path.** If the
app is reinstalled to a different location, or the folder is moved or renamed,
the old task keeps firing against a stale `node.exe` and can look like "the
watcher silently stopped". Always re-register after moving:

```powershell
& "$env:LOCALAPPDATA\IG Feed Watcher\windows\uninstall-scheduled-task.bat"
& "$env:LOCALAPPDATA\IG Feed Watcher\windows\install-scheduled-task.bat"
# or, from any shell:
Get-ScheduledTask -TaskName 'IG Feed Watcher' | Select-Object TaskName, State
```

---

## 7. Upgrade an existing install

1. Build and pre-flight the new version (§1, §2).
2. Send the new `.exe` + `.sha256`.
3. Recipient runs it. **It installs over the top** into the same
   `%LOCALAPPDATA%\IG Feed Watcher` folder.
4. **Their data is preserved** — `sources.json`, `.env.config`, `posts.db`,
   `state.json`, `screenshots\`, `logs\` are not shipped in the bundle and are
   not overwritten by it. Verify after upgrading anyway.
5. Re-register the scheduled task if the install path changed (§6).

Warn the recipient not to uninstall before upgrading — uninstalling removes the
program but deliberately **keeps** `%LOCALAPPDATA%\IG Feed Watcher` (including
their cookies), whereas a manual folder delete would lose them.

---

## 8. Rollback

Releases are additive in `dist\`. To roll a recipient back:

1. Uninstall the new version (Settings → Apps → **IG Feed Watcher**).
2. Send the previous `.exe` + `.sha256` from `dist\`.
3. Have them re-run it. Their `sources.json` and `.env.config` survive in
   `%LOCALAPPDATA%\IG Feed Watcher` **if they did not delete the folder**.

Note that `dist\` is gitignored (`.gitignore`), so the release binaries exist on
this machine only. Back them up off-machine if they matter.

---

## 9. Uninstall / rollback of the automation only

To stop automatic checking but keep the app usable manually:

```powershell
& "$env:LOCALAPPDATA\IG Feed Watcher\windows\uninstall-scheduled-task.bat"
```

Or Start menu → **IG Feed Watcher** → **Uninstall automatic watcher**.
To resume, run `install-scheduled-task.bat`.

Full removal: Settings → Apps → **IG Feed Watcher**. Then delete
`%LOCALAPPDATA%\IG Feed Watcher` to also remove cookies, config, database, and
screenshots. The task is removed automatically by the uninstaller's
`[UninstallRun]` step.

---

## 10. Facts to have on hand

| Item | Value |
| --- | --- |
| Install directory | `%LOCALAPPDATA%\IG Feed Watcher` |
| Explorer URL | `http://localhost:4180` |
| Posting API URL | `http://localhost:4030` (blocked without `FULL_AGENT=1`) |
| Scheduled task name | `IG Feed Watcher` |
| Task interval | every 5 minutes, indefinitely |
| Task settings | start when available, restart ×3 at 1-min intervals, 1-hour limit |
| Watcher log | `logs\watcher.log` |
| Hook log | `logs\posts.log` and `logs\priority-posts.jsonl` |
| Post database | `posts.db` |
| Screenshots | `screenshots\` |
| Config | `.env.config` |
| Cookies / sources | `sources.json` (or legacy `cookies.json`) |
| Expected installer size | ~191 MB |
| Expected compile time | 2–3 minutes |
| Admin rights required | none (per-user install) |
| Runtime requirement | none for the recipient (Node is bundled; the bundle needs Node ≥ 22.5 because it uses `node:sqlite`) |

### Released artifacts (most recent first)

| Version | SHA-256 | Size |
| --- | --- | --- |
| 1.5.1 | `d5493f56c0c91b74304887924e63c9a20e79c2c4c04be5b67fd335520adde123` | 191.0 MB |
| 1.5.0 | `bf3fe18ac16d9b8456648680c63383c0bf3486e0275b17c756d0c86020949fd0` | 191.0 MB |

Add a row here whenever you cut a release, so a recipient can always be told
which hash to expect. `dist\` is gitignored, so this table is the only durable
record of past artifacts.

---

## 11. Open defects affecting delivery

These are known and unfixed as of 1.5.1. Decide before sending whether they
matter to the recipient.

1. **Telegram cannot be configured from the UI** (§5). Highest impact — the
   shipped guides instruct a step that fails.
2. **`create-topic.sh` is corrupt** and ships in the bundle. Line 3 is mangled
   (`BOT_TOKEN=*** -E "^TG_BOT_TOKEN=*** .env.config | cut -d= -f2)`); the
   `$(grep` prefix and a closing quote are missing. It cannot execute. The
   related helpers (`create-topic.js`, `setup-topic.js`, `check-chat.sh`) all
   hard-code an absolute `/home/bsdev/ig-feed-watcher` path and a fixed chat id,
   so none of them work on a recipient machine either. Only `setup-topic.js`
   matters operationally, and it grants the bot ten admin rights — do not run it
   on a recipient's account without understanding that.
3. **Version drift is partly fixed but not fully.** `package.json` and
   `api/openapi.json` were aligned to 1.5.1, but the shipped
   `api/openapi.json` and `skills/feed-api/SKILL.md` still describe an API that
   omits the undocumented routes (see `README.md` in this folder).
4. **`.env.example` lists nine keys no code reads** (`POLL_INTERVAL`,
   `MAX_NEW_POSTS_PER_RUN`, `STATE_FILE`, `SCREENSHOTS_DIR`, `LOGS_DIR`,
   `USER_AGENT`, `PAGE_TIMEOUT`, `SCROLL_COUNT`, `DEBUG`). A recipient who edits
   them sees no effect. Documented in `future/README.md`.
5. **`install.bat` and the launchers do not check the Node version** (≥ 22.5
   required for `node:sqlite`). Harmless in the M2 bundle, which ships its own
   `node.exe`, but it breaks the M1 model.

---

## 12. One-page checklist

**Before sending**
- [ ] Version bumped in `.iss`, `package.json`, `api/openapi.json`, `INSTALL-GUIDE.md`
- [ ] `prepare-stage.ps1` run
- [ ] ISCC compile succeeded, exit 0
- [ ] `.sha256` written lowercase + CRLF, 99 bytes
- [ ] `certutil` hash matches the sidecar
- [ ] New version string embedded; old version absent
- [ ] Stage `watcher.js` hash == repo `watcher.js` hash
- [ ] No `future/`, cookies, sources, `.env.config`, or `posts.db` in the stage
- [ ] Tests green
- [ ] Acceptance test run on a clean machine (§4), all rows recorded

**When sending**
- [ ] `.exe` **and** `.sha256` sent together
- [ ] `INSTALL-GUIDE.md` attached
- [ ] Recipient warned about the SmartScreen prompt
- [ ] Recipient told the Telegram UI step is broken and given the `.env.config`
      workaround (§5)
