---
name: feed-api
description: Query and manage the IG Feed Watcher feed database. Use when you need to read feeds (all posts or a single group's posts), fetch an individual post with its image, list sources/groups, export post metadata as JSON, or manage interest groups — create, update, delete, and add/remove accounts, keywords, and hashtags per group. Triggered by requests like "list the feeds", "show posts in the Florest group", "get post <shortcode> with its image", "create a group", "add this account to a group", or "export feed metadata as JSON".
---

# Feed Data API

Access the IG Feed Watcher feed database through its HTTP API. Two ways to use it:

1. **HTTP API** — any `fetch`/`curl` against the running Web Explorer server.
2. **`feed-cli.js`** — a dependency-free CLI wrapper (recommended for agents).

You can also fetch the skill version for the server's current API capabilities
and install it into your own skill library — see
[Install / update this skill](#install--update-this-skill).

## Prerequisites

- The Web Explorer server must be running — double-click the **IG Feed
  Watcher** icon (desktop or Start menu), or run `windows\start-explorer.bat`
  in the app folder (`%LOCALAPPDATA%\IG Feed Watcher`). It serves on port
  **4180**.
- Set `FEED_API_URL` if the server is not at `http://127.0.0.1:4180`.
<!-- FULL_AGENT_ONLY_START -->
- Mutation methods require `FULL_AGENT=1` on the server. Without it, the API
  intentionally allows GET requests only and returns 405 for other methods.
<!-- FULL_AGENT_ONLY_END -->

## Quick start

```bash
cd "$env:LOCALAPPDATA\IG Feed Watcher"  # PowerShell — the installed app folder

# All feeds (first 50)
node feed-cli.js feeds

# Feeds from one group
node feed-cli.js feeds --group g_mr7u3k93

# Feeds from one group via the API directly
curl -s 'http://127.0.0.1:4180/api/groups/g_mr7u3k93/feeds'

# A single post with its image reference
node feed-cli.js post C1b2dEf
curl -s 'http://127.0.0.1:4180/api/feeds/C1b2dEf'

# Raw image bytes for a post
curl -s 'http://127.0.0.1:4180/api/feeds/C1b2dEf/image' -o post.jpg

# Export all metadata as JSON (to a file)
node feed-cli.js export --out feeds.json

# The current data contract (OpenAPI)
node feed-cli.js contract
curl -s 'http://127.0.0.1:4180/api/contract'

# This skill, as a JSON envelope (name, description, path, served content)
node feed-cli.js skill
curl -s 'http://127.0.0.1:4180/api/skill'

# This skill, as raw Markdown (frontmatter included)
curl -s 'http://127.0.0.1:4180/api/skill.md'
curl -s 'http://127.0.0.1:4180/api/skill?format=md'
```

> **Windows install:** the app lives in `%LOCALAPPDATA%\IG Feed Watcher` and
> bundles its own Node runtime (`node.exe` in that folder is **not** on
> PATH). If `node` is not found, call the bundled runtime directly instead,
> e.g. `& "$env:LOCALAPPDATA\IG Feed Watcher\node.exe" feed-cli.js feeds`.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/feeds` | All feeds (posts), with filters |
| `GET /api/groups/{id}/feeds` | Feeds matched to one group |
| `GET /api/feeds/{shortcode}` | One post, metadata + `image` reference |
| `GET /api/feeds/{shortcode}/image` | Raw image bytes for a post |
| `GET /api/export` | Bulk JSON export of post metadata |
| `GET /api/groups` | All groups with full details (accounts, keywords, hashtags, retention, post counts) |
| `GET /api/groups/{id}` | One group's full details |
| `GET /api/sources` | Ingestion sources (cookie values masked) |
| `GET /api/settings/retention` | Current automatic/global image-retention settings |
| `GET /api/contract` | The OpenAPI data contract |
| `GET /api/skill` | This skill, as a JSON envelope or raw Markdown (`?format=md`, `/api/skill.md`) |

<!-- FULL_AGENT_ONLY_START -->
Mutation endpoints available in full-agent mode:

| Endpoint | Purpose |
| --- | --- |
| `POST /api/groups` | Create a group |
| `PUT /api/groups/{id}` | Update a group (rename, recolor, replace lists) |
| `DELETE /api/groups/{id}` | Delete a group |
| `POST /api/groups/{id}/add` | Add one account/keyword/hashtag to a group |
| `POST /api/groups/{id}/remove` | Remove one account/keyword/hashtag from a group |
| `PUT /api/settings/retention` | Set global `image_retention_days` (`FULL_AGENT=1`) |
<!-- FULL_AGENT_ONLY_END -->

Common filters (query params): `group`, `source`, `author`, `search`, `reel=0|1`,
`date_from`, `date_to`, `limit` (max 500), `offset`, `sort`, `order`.

## The Post data contract

A post (`/api/feeds`, `/api/groups/{id}/feeds`) looks like:

```json
{
  "shortcode": "C1b2dEf",
  "permalink": "https://www.instagram.com/p/C1b2dEf/",
  "author": "someuser",
  "caption": "…",
  "timestamp": "2026-06-29T12:00:00.000Z",
  "is_reel": 0,
  "is_priority": 1,
  "priority_reasons": ["Florest: keyword …"],
  "image_urls": ["https://…"],
  "screenshot_url": "/screenshots/C1b2dEf.jpg",
  "matched_groups": [{ "id": "g_mr7u3k93", "name": "Florest", "color": "#26f50a", "reasons": ["…"] }],
  "source_id": "ig-primary",
  "source_name": "Primary Instagram",
  "comment_count": 3
}
```

The detail endpoint (`/api/feeds/{shortcode}`) adds `image` (an object with `url`,
`filename`, `contentType`) and `comments` (an array).

## Groups

`GET /api/groups` returns every group with `id`, `name`, `color`, `accounts`,
`keywords`, `hashtags`, `retention_days`, `telegramThreadId`, and `post_count`. Use a group's
`id` with `/api/groups/{id}/feeds` or the `--group`/`group` filter.

```json
{
  "groups": [
    {
      "id": "g_mr7u3k93",
      "name": "Florest",
      "color": "#26f50a",
      "accounts": ["mda_sc", "mda_brasil", "mdagovbr"],
      "keywords": ["Agricultura Familiar", "reforma agrária", "INCRA"],
      "hashtags": ["#agriculturafamiliar", "#reformaagraria"],
      "retention_days": 30,
      "telegramThreadId": 1800,
      "post_count": 42
    }
  ]
}
```

<!-- FULL_AGENT_ONLY_START -->
### Group management (create / update / delete / add / remove)

Agents can fully manage groups through the API. `POST`/`PUT`/`DELETE` on
`/api/groups*` mirror the settings page at `/settings`.

| Operation | `feed-cli.js` | HTTP |
| --- | --- | --- |
| List all groups | `node feed-cli.js groups` | `GET /api/groups` |
| One group's details | `node feed-cli.js group g_mr7u3k93` | `GET /api/groups/{id}` |
| Create a group | `node feed-cli.js group-create --name "Name" --color #26f50a` | `POST /api/groups` |
| Rename/recolor | `node feed-cli.js group-update g_mr7u3k93 --name "New"` | `PUT /api/groups/{id}` |
| Delete a group | `node feed-cli.js group-delete g_mr7u3k93` | `DELETE /api/groups/{id}` |
| Add one item | `node feed-cli.js group-add g_mr7u3k93 --type account --value username` | `POST /api/groups/{id}/add` |
| Remove one item | `node feed-cli.js group-remove g_mr7u3k93 --type keyword --value "reforma agrária"` | `POST /api/groups/{id}/remove` |

Details and rules:

- **Create** — `POST /api/groups` with `{ "name": "...", "color": "#hex",
  "accounts": [...], "keywords": [...], "hashtags": [...],
  "retention_days": 30 }`. Only `name` is
  required (must be unique). A Telegram forum topic is created automatically
  when Telegram is configured.
- **Update** — `PUT /api/groups/{id}` accepts any subset of `name`, `color`,
  `accounts`, `keywords`, `hashtags`, `retention_days`. Set `retention_days`
  to null to use the global value. **Providing `accounts`/`keywords`/
  `hashtags` REPLACES the whole list** — omit a field to leave it unchanged.
- **Add/remove single items** — `POST /api/groups/{id}/add` and
  `POST /api/groups/{id}/remove` take `{ "type": "account" | "keyword" |
  "hashtag", "value": "..." }`. Adds ignore duplicates; removes are exact
  matches and are a no-op when absent.
- **List values** — `accounts` (👤), `keywords` (🔑), `hashtags` (#) are the
  three per-group lists that drive post matching. Read them from any
  `GET /api/groups` (or `GET /api/groups/{id}`) response.
- All mutation responses are `{ "ok": true, "group": { ... } }` (delete returns
  `{ "ok": true }`); errors are `{ "error": "..." }` with 400/404/500.
<!-- FULL_AGENT_ONLY_END -->

## Sources

`GET /api/sources` lists ingestion sources (`id`, `name`, `type`, `enabled`,
`cookieNames`, `hasSessionId`, `cookieCount`). Cookie **values are never
returned** — only names and whether `sessionid` is present. Use
`source_id` on a post to see which account ingested it.

## Install / update this skill

If this skill is not yet in your skill library (or may be out of date), fetch
the content for the server's current API capabilities and install it yourself:

- **Raw Markdown (recommended for installs):** `GET /api/skill.md` (or
  `GET /api/skill?format=md`) returns the currently served skill, frontmatter
  included.
  Save it verbatim as `skills/feed-api/SKILL.md` in your skill directory.
- **JSON envelope:** `GET /api/skill` returns `{ "name": "feed-api",
  "description": "...", "path": "skills/feed-api/SKILL.md", "content": "..." }`.
  Write the `content` field to `skills/feed-api/SKILL.md`.
- **CLI:** `node feed-cli.js skill --out skills/feed-api/SKILL.md` writes the
  file for you; `node feed-cli.js skill` prints the JSON envelope.

The content you receive matches the server's current API capabilities. Install
it verbatim, including the YAML frontmatter, and replace any older copy.

## Notes

- `author`/`search` filters use fuzzy matching, not exact SQL.
- The image endpoint serves JPEG/PNG/WebP bytes directly.
<!-- FULL_AGENT_ONLY_START -->
- `POST`/`PUT`/`DELETE` on `/api/sources*` manage sources and cookie values
  (see the settings page at `/settings/sources`).
- Group mutations persist to `groups.json` and are picked up by the watcher on
  its next cycle — no restart needed.
<!-- FULL_AGENT_ONLY_END -->
- In `AUTO_RETENTION=2`, group responses include `retention_days`,
  `effective_retention_days`, and `retention_inherited`.
<!-- FULL_AGENT_ONLY_START -->
- Set the global fallback with `PUT /api/settings/retention` and
  `{ "image_retention_days": 30 }`.
<!-- FULL_AGENT_ONLY_END -->
- Read the full contract with `GET /api/contract` before coding against it.
