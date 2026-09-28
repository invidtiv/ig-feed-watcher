# IG Feed Watcher

Headless Instagram feed watcher that detects new posts on your feed and:
- 📸 Takes a screenshot of each new post
- 🔔 Sends you a Telegram notification (photo + caption)
- 🔧 Runs a custom hook script with the post data as JSON

Also includes a **Post API** — an HTTP API to post images to Instagram using the same session cookies.

> **🪟 Deploying on Windows?** See
> [`WINDOWS-DEPLOYMENT.md`](WINDOWS-DEPLOYMENT.md) — three solutions for a
> Windows machine operated by someone with no IT experience, plus the
> ready-to-run `windows/` launchers (`install.bat`, `start-*.bat`,
> scheduled-task scripts). The watcher also supports a self-contained
> `--loop` mode (`node watcher.js --loop 5`) that needs no cron.

## Posting API

A lightweight Express server that accepts an image + caption and posts to Instagram via Puppeteer automation.

### Start the API server

```bash
cd /home/bsdev/ig-feed-watcher
node post-server.js
```

The server listens on `localhost:4030` (loopback/Tailnet only — no public exposure).

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
curl -X POST http://localhost:4030/post \
  -F "image=@/path/to/image.jpg" \
  -F "caption=Your caption here 📸"
```

**Mode 2 — JSON with existing file path:**
```bash
curl -X POST http://localhost:4030/post \
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

## Multiple Accounts / Sources

The watcher ingests from one or more **sources**, each a separate Instagram
account with its own session cookies. For every enabled source it launches its
own headless browser and scrapes that account's home feed. Every post is stamped
with `source_id` / `source_name` so you can tell which account it came from.

**Single-account by default.** The **Sources** page is single-account only:
it shows one account's cookies and the Telegram alert settings. Multi-account
ingestion is supported by the backend (set `MULTI_ACCOUNT=1` in `.env.config`
to allow the API and watcher to use more than one account). With the default
`MULTI_ACCOUNT=0`, the watcher runs only the first enabled account even if an
existing `sources.json` contains more; the multi-account web UI is planned for
a future release. The legacy `MULTI_ACCOUNTS` name remains accepted when the
canonical singular variable is absent.

Sources are configured in `sources.json` (see `sources.example.json` for a
template). You can manage them two ways:

1. **Web settings page** — open the Web Explorer, click **🔑 Sources**, paste
   the account's cookie JSON, and save the Telegram bot token + group chat ID.
2. **Edit `sources.json` directly** — copy `sources.example.json` to
   `sources.json` and fill in the cookies per source.

If `sources.json` is absent, the watcher falls back to the legacy single-account
`cookies.json`. The source `type` field is an extension point: new source types
(e.g. RSS, an HTTP feed, another network) register an ingester via
`sources.js` → `registerIngester(type, fn)` and the watcher loop is unchanged.

## Feed Data API & Contract

The Web Explorer (`server.js`, port **4180**) exposes a feed data API plus a
machine-readable OpenAPI contract. This is the programmatic way to read the
database of all feeds, per-group feeds, and individual posts with their images.

The API is GET-only by default. Set `FULL_AGENT=1` to enable mutation methods
(`POST`, `PUT`, `PATCH`, `DELETE`, and others) in both the feed API and the
dedicated Instagram posting API. Rejected methods return `405 Method Not
Allowed`; the guard runs before JSON or multipart upload processing. The served
OpenAPI contract is capability-aware: read-only mode omits every non-GET
operation and mutation-only path, while full-agent mode serves the complete
contract.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/feeds` | All feeds (posts), with filters |
| `GET /api/groups/{id}/feeds` | Feeds for one group |
| `GET /api/feeds/{shortcode}` | One post + image reference |
| `GET /api/feeds/{shortcode}/image` | Raw image bytes for a post |
| `GET /api/export` | Bulk JSON export of post metadata |
| `GET /api/groups` | All groups with full details (accounts, keywords, hashtags, retention, post counts) |
| `GET /api/groups/{id}` | One group's full details |
| `POST /api/groups` | Create a group |
| `PUT /api/groups/{id}` | Update a group (rename, recolor, replace lists) |
| `DELETE /api/groups/{id}` | Delete a group |
| `POST /api/groups/{id}/add` | Add one account/keyword/hashtag to a group |
| `POST /api/groups/{id}/remove` | Remove one account/keyword/hashtag from a group |
| `GET /api/sources` | Sources (cookie values masked) |
| `GET /api/contract` | The OpenAPI data contract |

Filters: `group`, `source`, `author`, `search`, `reel`, `date_from`, `date_to`,
`limit`, `offset`, `sort`, `order`.

```bash
# All feeds
curl -s 'http://localhost:4180/api/feeds?limit=20'

# One group's feeds
curl -s 'http://localhost:4180/api/groups/g_mr7u3k93/feeds'

# One post with its image
curl -s 'http://localhost:4180/api/feeds/C1b2dEf'

# Raw image
curl -s 'http://localhost:4180/api/feeds/C1b2dEf/image' -o post.jpg

# Export all metadata as JSON
curl -s 'http://localhost:4180/api/export' > feeds.json

# The contract
curl -s 'http://localhost:4180/api/contract'

# The capability-specific agent skill (JSON envelope: name, description, path, content)
curl -s 'http://localhost:4180/api/skill'

# The agent skill as raw Markdown — save it to install/update the skill
curl -s 'http://localhost:4180/api/skill.md' -o SKILL.md
```

A dependency-free CLI wraps the same API:

```bash
node feed-cli.js feeds --group g_mr7u3k93
node feed-cli.js post C1b2dEf
node feed-cli.js export --out feeds.json
node feed-cli.js groups
node feed-cli.js group g_mr7u3k93
node feed-cli.js group-create --name "New Group" --accounts alice,bob --keywords "agroecologia" --hashtags "#agroecologia"
node feed-cli.js group-update g_mr7u3k93 --color "#26f50a" --retention-days 30
node feed-cli.js group-add g_mr7u3k93 --type account --value carol
node feed-cli.js group-remove g_mr7u3k93 --type keyword --value "agroecologia"
node feed-cli.js group-delete g_mr7u3k93
node feed-cli.js contract
node feed-cli.js skill                       # print this API's agent skill (JSON envelope)
node feed-cli.js skill --out SKILL.md        # self-install: write the raw SKILL.md
```

Group mutations (create/update/delete/add/remove) persist to `groups.json` and
are picked up by the watcher on its next cycle — no restart needed. The full
group management contract (request/response shapes, error codes) is in
`api/openapi.json` and served live at `/api/contract`.

An agent skill documenting this API lives in `skills/feed-api/SKILL.md` and is
served live at `/api/skill` (JSON envelope) and `/api/skill.md` (raw Markdown),
so an agent can fetch the full skill and install it into its own skill library
without prior knowledge of this repo.

## Automatic Image Retention

Image retention removes expired screenshot files while preserving post and
comment metadata. Configure it in `.env.config`:

```dotenv
# Disabled; images are kept indefinitely
AUTO_RETENTION=0

# One global rule for every image
AUTO_RETENTION=1
IMAGE_RETENTION_DAYS=30

# Per-group rules, with the global value as fallback
AUTO_RETENTION=2
IMAGE_RETENTION_DAYS=30
```

In mode `2`, the **Groups** page shows each group's configured retention or its
inherited global value. Set a positive whole-number `retention_days` there,
through `POST /api/groups`, or through `PUT /api/groups/{id}`. Set the global
`IMAGE_RETENTION_DAYS` value from **Sources & Cookies → Image retention**. A group with
no override uses `IMAGE_RETENTION_DAYS`. An ungrouped image also uses the global
value. When an image belongs to multiple groups, the longest applicable value
wins. The watcher checks once per ingestion run; the explorer also checks on
startup and every 24 hours. If the global day value is absent or invalid,
cleanup is skipped safely.

## Capability Reference (undocumented behaviour)

Everything in this section is implemented in the code but is either absent from
the shipped `README.md` or is present only in this `future/` copy. It is the
reference for what the system actually does.

### Capability switches

These four variables are read by `runtime-policy.js` from the process
environment first, then from `.env.config`. All four default to **off**.

| Variable | Default | Effect when enabled |
| --- | --- | --- |
| `FULL_AGENT=1` | off | Unlocks every non-GET API method. While off, a guard mounted before body parsing rejects every non-GET `/api` request with `405 Method Not Allowed` and `Allow: GET` |
| `MULTI_ACCOUNT=1` | off | Allows more than one ingestion source. While off, the watcher runs only the first enabled source and `POST /api/sources` returns `403` once a source exists. `MULTI_ACCOUNTS` is still accepted as a legacy alias |
| `AUTO_RETENTION=1\|2` | `0` | Enables image retention (see below) |
| `IMAGE_RETENTION_DAYS=N` | unset | The retention day count. If this is set in the process environment, `PUT /api/settings/retention` returns `409` because the environment owns the value |

> **`FULL_AGENT` also gates the posting API.** `post-server.js` mounts the same
> guard, so with the default configuration `POST /post` returns `405`. This is
> the single most surprising default in the system: the posting API described
> above does not accept posts until `FULL_AGENT=1` is set.

The guard's policy is read **once at startup**, so changing `FULL_AGENT`
requires a restart of the server. The retention endpoints re-read policy on
every request and therefore apply immediately.

### Complete API surface

`api/openapi.json` and `GET /api/contract` document only a subset of the routes
the server actually serves. The full surface:

**Documented in the contract**

`GET /api/feeds`, `GET /api/groups/{id}/feeds`, `GET /api/feeds/{shortcode}`,
`GET /api/feeds/{shortcode}/image`, `GET /api/export`,
`GET /api/sources`, `POST /api/sources`, `PUT /api/sources/{id}`,
`PUT /api/sources/{id}/cookies`, `DELETE /api/sources/{id}`,
`GET|POST /api/groups`, `GET|PUT|DELETE /api/groups/{id}`,
`POST /api/groups/{id}/add`, `POST /api/groups/{id}/remove`,
`GET|PUT /api/settings/retention`, `GET /api/contract`, `GET /api/skill`.

**Served but in neither the contract nor `README.md`**

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/stats` | Dashboard: totals, in-groups, reels, captions, screenshots, authors, last 24h, last 7d, top-15 authors, a 30-day histogram, comment totals, and per-group post counts |
| `GET` | `/api/authors` | Per-author post, priority, and reel counts plus `last_seen` |
| `GET` | `/api/posts` | Backward-compatible alias of `/api/feeds` |
| `GET` | `/api/posts/{shortcode}` | Post detail **including its comments** |
| `GET` | `/api/posts/{shortcode}/image` | Raw image bytes (alias) |
| `GET` | `/api/posts/{shortcode}/comments` | Comments for one post |
| `GET` | `/api/comments` | Comment browser. Filters: `author`, `search`, `shortcode`, `limit`, `offset` |
| `POST` | `/api/posts/{shortcode}/groups` | Manually tag or untag a post into a group. Body `{group_id, member}`. Rewrites `matched_groups` and recomputes `is_priority`. **Non-GET, so it requires `FULL_AGENT=1`** |
| `GET` | `/api/settings/telegram` | Reads Telegram config. Never returns the bot token — only `botTokenSet` |
| `PUT` | `/api/settings/telegram` | Writes `TG_BOT_TOKEN` / `TELEGRAM_HOME_CHANNEL` into `.env.config` |
| `GET` | `/api/openapi.json` | Alias of `/api/contract` |
| `GET` | `/` | The Explorer page |
| `GET` | `/settings` | The Groups settings page |
| `GET` | `/settings/sources` | The Sources & Cookies page |
| `GET` | `/screenshots/{file}` | Static screenshot bytes, served by filename |

Note that the Explorer's own HTML calls the legacy `/api/posts*` family, not the
documented `/api/feeds*` family. The `/api/skill` endpoint serves raw Markdown
either at `/api/skill.md`, with `?format=md`, or when the request sends
`Accept: text/markdown`.

**Extra query parameters not in the contract**

- `priority=1` — restrict to posts that matched at least one group
- `?download=1` on `GET /api/export` — adds
  `Content-Disposition: attachment; filename="feeds-export.json"`

**Capability-projected documentation.** The served contract and the served agent
skill are not static files. In read-only mode the server strips every non-GET
operation and mutation-only path from the OpenAPI document, prunes the
now-unreferenced schemas, and removes the capability metadata; the skill is
served with its `<!-- FULL_AGENT_ONLY_START -->` blocks removed. Both are served
in full once `FULL_AGENT=1`.

### Search behaviour

The `author` and `search` filters are **not** exact SQL matches. They run through
a hand-rolled fuzzy matcher registered as a SQLite user-defined function: text is
accent-folded (NFD, diacritics stripped), lower-cased, and compared by
Levenshtein distance — tolerance 1 for terms up to 3 characters, otherwise 2 —
with additional prefix and substring passes. A search for `agroecologa`
therefore still matches `agroecologia`.

### Group matching

Matching is evaluated per group, and each rule family is OR-ed, so a group
matches if **any** of its accounts, keywords, or hashtags hit.

- **Accounts** match by case-insensitive **substring** against the author, not
  equality — an account entry of `ana` also matches the author `mariana`.
- **Keywords** and **hashtags** are case-insensitive substring matches against
  the caption, with no word boundaries or accent folding, so `#agro` also
  matches `#agroecologia`.
- Only the post's author and caption participate. Image URLs, alt text, and
  comment text are never matched against.
- The first matching keyword and the first matching hashtag are recorded as the
  group's reasons.

The feed caption is stored up to **`captionMaxChars` (2200)** characters, which
is Instagram's own caption limit. When a feed caption is missing, looks cut off,
or hits that cap, the watcher opens the post's detail page, extracts the full
caption, and **re-runs group matching** with it — so a keyword that appears only
past the feed's render cutoff still matches. Longer captions therefore improve
matching rather than degrade it.

### Priority

`is_priority` is set to `1` whenever at least one group matched; it is not a
separate mechanism. `priority_reasons` holds the flattened `"Group: reason"`
list. The legacy `priority-list.json` file is only used when `groups.json` does
not exist, in which case it is migrated into a group named **Priority**
(`#f59e0b`) and `groups.json` is written.

### Comments

Comment scraping is on by default and is not mentioned in the shipped
`README.md`. For posts that are opened as detail pages, the watcher:

- opens the permalink in a **separate page**,
- clicks "load more comments" up to `commentLoadMoreClicks` (3) times,
- extracts each comment's author, text, like count, and timestamp,
- deduplicates on `author::text`, caps the text at 2000 characters, and caps
  the total at `maxCommentsPerPost` (50),
- persists them to the `comments` table, whose
  `UNIQUE(shortcode, author, text)` key means an **edited comment text inserts a
  new row and a changed like count is never updated**.

Comments are stored and shown in the Explorer but are deliberately **excluded
from the Telegram message**.

### Detail-page throttling and rate-limit cooldown

To avoid triggering Instagram's rate limiting, detail pages are opened only when
needed — for group-matched posts or likely-truncated captions — and never more
often than `detailScrapeDelayMs` (3000 ms) apart. On detecting an error or 429
page the watcher sets a cooldown of `rateLimitCooldownMs` (30 minutes) and
**persists it into `state.json`** so later scheduled runs also pause.

The page-text check used to detect this is broad: it matches `error`,
`Restricted`, `rate limit`, and several Instagram error strings anywhere in the
page body. A post whose own caption contains one of those words can therefore be
misread as a rate-limited page.

### Telegram forum topics

When Telegram is configured, the watcher creates a **separate forum topic per
interest group** and routes notifications into the matching topic.

- A group's hex colour is quantised to the nearest of eight supported Telegram
  icon colours.
- `ensureGroupTopics` runs every cycle and creates a topic for any group that
  does not yet have a `telegramThreadId`, then writes it back to `groups.json`.
  `POST /api/groups` does the same at creation time.
- A matched post is sent **once per matched group** into that group's topic. A
  post that matches no group goes to the main chat with no thread.
- Photos are sent as `sendPhoto` with a caption; if that fails the watcher falls
  back to a plain text message.
- Per-source ingestion failures raise a separate `⚠️ IG Watcher Error` alert
  containing up to 200 characters of the error message.

Message text is interpolated into HTML without escaping, so a group name or
author containing `&` or `<` can break Telegram's entity parsing.

### Custom hook scripts

The hook receives the post JSON on stdin, pretty-printed with two-space indent,
and is chosen by **file extension**:

| Extension | How it is run |
| --- | --- |
| `.cmd` / `.bat` | `cmd.exe /d /s /c ""path""` with `windowsVerbatimArguments` |
| `.js` | The current Node executable |
| anything else (`.sh`, no extension) | `bash <script>` — on Windows this needs Git Bash or WSL |

The default is `hooks/on-new-post.js` on Windows and `hooks/on-new-post.sh`
elsewhere. Override with `HOOK_SCRIPT`, which is resolved relative to the
process working directory, not the repository root.

The script runs with **no timeout and is never killed** — a hanging hook blocks
the whole run, and in `--loop` mode the next cycle is not scheduled until the
hook returns. The hook's exit code, stdout, and stderr are logged but do not
affect the run.

The bundled Node hook appends a line to `logs/posts.log` for every post and
additionally appends the complete post JSON to `logs/priority-posts.jsonl` when
the post matched a group.

### Run modes and logging

```
node watcher.js              # one pass, then exit (cron / Task Scheduler)
node watcher.js --loop [n]   # run a pass every n minutes (default 5)
```

`--loop` is self-contained scheduling and needs no cron. The next cycle is
scheduled **after** the current run finishes, so the real period is the interval
plus the run duration. An unparseable or missing interval silently becomes 5
minutes.

Logging goes to stderr (so cron captures it) and is appended to
`logs/watcher.log` with **no rotation or size cap**.

### Deduplication and state

`state.json` holds `seenPosts`, `lastRun`, `lastPostTime`, and `rateLimitUntil`.
Each run unions the stored shortcodes with **every** shortcode in `posts.db`, so
the database is the durable record and `seenPosts` is only a rolling cache — it
is capped at the last 500 entries.

At most `maxNewPostsPerRun` (10) new posts are processed in full per run, sorted
so that group-matched posts come first. Remaining posts are still recorded, but
without a screenshot and without comment or full-caption scraping, and because
they are added to the seen set they are **never** revisited on a later run.

### Screenshots

A "screenshot" is not a download of the source image. The watcher navigates to
the post's image URL in a browser and captures the rendered `<img>` at its
natural size, producing a re-encoded JPEG named `<shortcode>.jpg` in
`screenshots/`. It falls back, in order, to a screenshot of the feed `<article>`
element, then to a plain viewport screenshot. Profile thumbnails and emoji are
filtered out, and an image smaller than 200x200 is rejected.

The Explorer's image-retention timer only prunes `screenshots/`. Debug images
written by the poster into `logs/` are never pruned by anything.

### Browser resolution

`browser-path.js` resolves the Chromium executable by searching the bundled
`.puppeteer-cache` directory recursively and case-insensitively for `chrome.exe`,
falling back to Puppeteer's own `executablePath()`. This exists because the
Windows scheduled task cannot easily set `PUPPETEER_CACHE_DIR`. `poster.js` uses
it; `login.js` does not.

### Anti-detection

The automation surface is deliberately small: a Chrome user agent string on each
page, a 1920x1080 viewport, `--disable-blink-features=AutomationControlled`, and
fonts and media aborted on the main feed page. There is **no** proxy support, no
persistent browser profile, no `navigator.webdriver` patch, and no randomised
delays — all waits are fixed.

### Posting API behaviour

- `POST /post` accepts either a multipart `image` file or a JSON
  `{imagePath, caption}` body.
- The JSON form reads **any** path on the local filesystem that exists; it is
  not confined to `uploads/`. The loopback bind is the only mitigation.
- Uploads are capped at 20 MB and filtered to jpg, jpeg, png, webp, and gif. A
  missing extension becomes `.jpg`. Rejected uploads surface as a generic `500`
  rather than `400`/`413`.
- `poster.js` hard-codes `debug: true` and reads no configuration file. It
  writes six classes of debug screenshot into `logs/`
  (`_post_debug`, `-crop`, `-filter`, `-caption`, `-share`, `-result`).
- The returned `permalink` is taken from the first `a[href*="/p/"]` on the page,
  which is frequently an unrelated feed post rather than the post just
  published.
- An unconfirmed share still returns `success: true`, so the API can report a
  post that did not actually happen.
- The returned `postedAt` is the local time of the API process, and cookies are
  normalised to accept DevTools' `expirationDate` field as well as `expires`.

### `feed-cli.js` flags

`feed-cli.js` accepts more flags than the shipped README lists:

| Flag | Applies to | Notes |
| --- | --- | --- |
| `--retention-days N` | `group-create`, `group-update` | Sets a per-group override in `AUTO_RETENTION=2` |
| `--date_from`, `--date_to`, `--sort`, `--order`, `--offset` | `feeds` | Additional filters and paging |
| `--base URL` | all | Overrides the API base URL (trailing slash stripped) |
| `--out FILE` | `export`, `skill` | `skill --out` writes the raw `SKILL.md` |
| `--compact` | all | Compact JSON output |
| `--download` | `export` | Sends `download=1` |

`FEED_API_URL` overrides the default base of `http://127.0.0.1:4180`. With no
arguments the CLI defaults to `feeds`. The CSV flags (`--accounts`, `--keywords`,
`--hashtags`) replace a whole list and **cannot** set a list to empty. The
`export` command advertises `--offset`, `--sort`, and `--order` in its usage text
but does not forward them.

### Deployment notes

- **Node >= 22.5 is required.** `server.js`, `watcher.js`, and
  `republish-photos.js` all import `node:sqlite` (`DatabaseSync`). The Windows
  installer ships a bundled `node.exe`; `install.bat` itself performs no version
  check.
- A hook for a **spaced path** needs the `windowsVerbatimArguments` quoting path.
- `windows/install-scheduled-task.ps1` embeds an **absolute** path to the Node
  executable, so moving the application folder silently breaks the task.
- The plain `Dockerfile` builds an explorer-only image (Express only, no
  Chromium) and deliberately ignores the lockfile;
  `Dockerfile.full` installs the Chromium dependency set and defaults to
  `watcher.js --loop 5`.
- `docker-compose.full.yml` mounts `.env.config` **read-write** for the explorer
  and **read-only** for the post-api service, although both read Telegram
  settings from it and the explorer writes it.
- Neither compose file creates `.env.config`; Docker will create a **directory**
  at that path on a fresh checkout if it does not exist.

### Utility scripts (not documented elsewhere)

| File | Purpose |
| --- | --- |
| `republish-photos.js` | One-shot backfill: re-sends every `posts.db` post whose author matches the Photos group's accounts to a hard-coded Telegram thread (1842), paced at 3.2 s, retrying once on 429, and tagging `matched_groups` **and setting `is_priority = 1`** |
| `setup-topic.js` | Calls `getMe`, then `promoteChatMember` to grant the bot **ten** administrative rights including `can_manage_topics` and `can_restrict_members`, then creates a forum topic |
| `create-topic.js` | Creates a single forum topic with a hard-coded chat id |
| `create-topic.sh` | Bash/curl twin of the above. **Line 3 is corrupted and this script cannot run** |
| `check-chat.sh` | Diagnostic: `getChat`, then attempts to set forum mode via `setChatPermissions` |
| `create-env-config.ps1` | Idempotently copies `.env.example` to `.env.config` during installer setup |
| `export-cookies.py` | Reads a Chrome cookie database and decrypts it. **Linux-only** — the profile paths and the `peanuts`/`saltsalt` key derivation are Linux-specific, so the Windows claim in the deployment docs is inaccurate |

All four Telegram topic helpers hard-code a chat id and an absolute
`/home/bsdev/ig-feed-watcher` working directory.

### Undocumented configuration surface

`.env.example` lists several keys that **no runtime file reads**:
`POLL_INTERVAL`, `MAX_NEW_POSTS_PER_RUN`, `STATE_FILE`, `SCREENSHOTS_DIR`,
`LOGS_DIR`, `USER_AGENT`, `PAGE_TIMEOUT`, `SCROLL_COUNT`, and `DEBUG`. Their
effective values are hard-coded in `watcher.js`'s `CONFIG` object, and the
advertised `PAGE_TIMEOUT=30000` does not match the effective `60000`. Setting
these keys has no effect.

Only these configuration keys are honoured:

| Key | Read by | Notes |
| --- | --- | --- |
| `HOOK_SCRIPT` | `watcher.js` | The only key the watcher reads from `.env.config` |
| `SOURCES_FILE`, `COOKIES_FILE` | `sources.js` | Read from the process environment **only**, not from `.env.config` |
| `MULTI_ACCOUNT`, `MULTI_ACCOUNTS`, `FULL_AGENT`, `AUTO_RETENTION`, `IMAGE_RETENTION_DAYS` | `runtime-policy.js` | Process environment first, then `.env.config` |
| `TG_BOT_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_HOME_CHANNEL`, `TG_CHAT_ID` | `watcher.js`, `server.js`, `republish-photos.js` | Placeholder values such as `YOUR_BOT_TOKEN_HERE` count as unset |

Telegram configuration is resolved in the order `.env.config` →
`~/.hermes/.env` → process environment, but because the first branch returns
whenever `.env.config` **exists**, the two fallbacks are unreachable on any
installation that has that file. `sources.json` entries also accept an
`enabled` flag, which is read by the watcher but documented nowhere.

### Tests

`npm test` runs four pure unit test files covering the policy helpers only:
`contract-policy.js` (the OpenAPI capability projection), `retention.js`
(retention maths and file/database cleanup), `runtime-policy.js` (source
selection, `MULTI_ACCOUNT`, the guard, config writing), and `skill-policy.js`
(the read-only skill projection, asserted against the real `SKILL.md`).

No test imports `server.js`, `watcher.js`, `poster.js`, `post-server.js`, or
`feed-cli.js`. There is no HTTP route test, no CLI argument test, and no
`AUTO_RETENTION` boundary test.

## Feed Watcher Setup

### 1. Install dependencies
```bash
cd /home/bsdev/ig-feed-watcher
npm install
```

### 2. Export your Instagram cookies

You need to provide your Instagram session cookies.

**Recommended:** follow the step-by-step guide
[`COOKIES-GUIDE.md`](COOKIES-GUIDE.md) (written for Windows) — it walks you
through getting every value the system needs from your browser, storing them
in `sources.json`, and verifying them, including a copy-paste PowerShell
helper. Three manual options:

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
├── sources.js          — multi-source config + ingester registry
├── sources.json        — your sources (one per account, with cookies)
├── feed-cli.js         — CLI for the feed data API
├── api/openapi.json    — OpenAPI data contract
├── skills/feed-api/    — agent skill for the feed data API
├── poster.js           — Instagram posting automation (Puppeteer)
├── post-server.js      — HTTP API server (Express + Multer)
├── login.js            — interactive login helper (needs display)
├── export-cookies.py   — extract cookies from local Chrome profile
├── cookies.json        — your Instagram session cookies (you create this)
├── COOKIES-GUIDE.md    — step-by-step guide: how to get every value the system needs (Windows)
├── state.json          — tracks seen posts (auto-created)
├── hooks/
│   └── on-new-post.sh  — custom hook script (edit this!)
├── screenshots/        — post screenshots
├── uploads/            — uploaded images (for posting API)
├── logs/               — watcher + poster logs
├── windows/            — Windows deployment (install.bat, start-*.bat, scheduled task)
├── WINDOWS-DEPLOYMENT.md — 3 ways to deploy on Windows, step-by-step
├── .env.config         — configuration
└── package.json
```

## Important notes

- **Session expiry**: Instagram sessions can expire. If you get login errors, re-export your cookies.
- **Rate limiting**: Every 5 minutes is aggressive. If Instagram rate-limits you, reduce to every 15 minutes.
- **Detection**: This uses a real Chromium with realistic user-agent. Instagram may still detect automation. Use at your own risk.
- **Cookie refresh**: You may need to re-export cookies every few weeks as Instagram rotates sessions.
