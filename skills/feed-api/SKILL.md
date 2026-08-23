---
name: feed-api
description: Query and export the IG Feed Watcher feed database. Use when you need to read feeds (all posts or a single group's posts), fetch an individual post with its image, list sources/groups, or export post metadata as JSON. Triggered by requests like "list the feeds", "show posts in the Florest group", "get post <shortcode> with its image", or "export feed metadata as JSON".
---

# Feed Data API

Access the IG Feed Watcher feed database through its HTTP API. Two ways to use it:

1. **HTTP API** — any `fetch`/`curl` against the running Web Explorer server.
2. **`feed-cli.js`** — a dependency-free CLI wrapper (recommended for agents).

## Prerequisites

- The Web Explorer server must be running — double-click the **IG Feed
  Watcher** icon (desktop or Start menu), or run `windows\start-explorer.bat`
  in the app folder (`%LOCALAPPDATA%\IG Feed Watcher`). It serves on port
  **4180**.
- Set `FEED_API_URL` if the server is not at `http://127.0.0.1:4180`.

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

# The full data contract (OpenAPI)
node feed-cli.js contract
curl -s 'http://127.0.0.1:4180/api/contract'
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
| `GET /api/groups` | Interest groups with post counts |
| `GET /api/sources` | Ingestion sources (cookie values masked) |
| `GET /api/contract` | The OpenAPI data contract |

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

`GET /api/groups` returns each group with `id`, `name`, `color`, `accounts`,
`keywords`, `hashtags`, and `post_count`. Use a group's `id` with
`/api/groups/{id}/feeds` or the `--group`/`group` filter.

## Sources

`GET /api/sources` lists ingestion sources (`id`, `name`, `type`, `enabled`,
`cookieNames`, `hasSessionId`, `cookieCount`). Cookie **values are never
returned** — only names and whether `sessionid` is present. Use
`source_id` on a post to see which account ingested it.

## Notes

- `author`/`search` filters use fuzzy matching, not exact SQL.
- The image endpoint serves JPEG/PNG/WebP bytes directly.
- `POST`/`PUT`/`DELETE` on `/api/sources*` manage sources and cookie values
  (see the settings page at `/settings/sources`).
- Read the full contract with `GET /api/contract` before coding against it.
