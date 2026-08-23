#!/usr/bin/env node
/**
 * feed-cli — command-line access to the IG Feed Watcher feed data API.
 *
 * A thin, dependency-free client over the HTTP API (see api/openapi.json for
 * the full data contract). Usable by humans and by agents via the
 * skills/feed-api skill.
 *
 * Usage:
 *   node feed-cli.js feeds [--group ID] [--source ID] [--author X] [--search Y]
 *                          [--reel 0|1] [--limit N] [--offset N] [--out FILE]
 *   node feed-cli.js post <shortcode>
 *   node feed-cli.js groups
 *   node feed-cli.js group <id>
 *   node feed-cli.js group-create --name "Name" [--color #hex]
 *                          [--accounts a,b] [--keywords k1,k2] [--hashtags h1,h2]
 *   node feed-cli.js group-update <id> [--name "New Name"] [--color #hex]
 *                          [--accounts a,b] [--keywords k1,k2] [--hashtags h1,h2]
 *   node feed-cli.js group-delete <id>
 *   node feed-cli.js group-add <id> --type account|keyword|hashtag --value X
 *   node feed-cli.js group-remove <id> --type account|keyword|hashtag --value X
 *   node feed-cli.js sources
 *   node feed-cli.js export [--group ID] [--source ID] [--author X] [--out FILE]
 *   node feed-cli.js contract
 *
 * Environment:
 *   FEED_API_URL — base URL (default http://127.0.0.1:4180)
 */

import { writeFileSync } from 'fs';

const DEFAULT_BASE = process.env.FEED_API_URL || 'http://127.0.0.1:4180';

function usage() {
  process.stderr.write(`feed-cli — IG Feed Watcher data API client

Commands:
  feeds [filters]        List feeds (all, or filtered). Default command.
  post <shortcode>       Fetch one post with its image reference.
  groups                 List interest groups with full details.
  group <id>             Fetch one group's details.
  group-create           Create a group (--name required).
  group-update <id>      Update a group (rename/recolor/replace lists).
  group-delete <id>      Delete a group.
  group-add <id>         Add one account/keyword/hashtag (--type --value).
  group-remove <id>      Remove one account/keyword/hashtag (--type --value).
  sources                List ingestion sources (cookie values masked).
  export [filters]       Export post metadata as JSON.
  contract               Print the OpenAPI data contract.

Group options:
  --name "Name"          Group name (required for group-create).
  --color #hex           Group color (default #6366f1 on create).
  --accounts a,b         Replace the full 👤 accounts list (CSV).
  --keywords k1,k2       Replace the full 🔑 keywords list (CSV).
  --hashtags h1,h2       Replace the full # hashtags list (CSV).
  --type TYPE            Item list for add/remove: account|keyword|hashtag.
  --value X              Item value for add/remove.

Filters (feeds/export): --group ID --source ID --author X --search Y
                        --reel 0|1 --date_from ISO --date_to ISO
                        --limit N --offset N --sort COL --order ASC|DESC
Common:                 --base URL --out FILE --compact
Env:                    FEED_API_URL (default http://127.0.0.1:4180)
`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { command: 'feeds', positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      let key = a.slice(2);
      let val = 'true';
      const eq = key.indexOf('=');
      if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { val = argv[++i]; }
      out.flags[key] = val;
    } else if (out.positional.length === 0 && !out.commandSet) {
      out.command = a;
      out.commandSet = true;
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

const COMMANDS = new Set([
  'feeds', 'post', 'groups', 'group', 'group-create', 'group-update',
  'group-delete', 'group-add', 'group-remove', 'sources', 'export', 'contract', 'help',
]);

async function api(path, query, opts = {}) {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const method = opts.method || 'GET';
  const res = await fetch(url, {
    method,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

// Split a comma-separated flag into a trimmed non-empty list (or undefined).
function csv(s) {
  if (s === undefined || s === null || s === '') return undefined;
  return String(s).split(',').map(x => x.trim()).filter(Boolean);
}

function emit(data, flags) {
  const text = flags.compact ? JSON.stringify(data) : JSON.stringify(data, null, 2);
  if (flags.out) {
    writeFileSync(flags.out, text + '\n');
    process.stderr.write(`Wrote ${flags.out}\n`);
  } else {
    process.stdout.write(text + '\n');
  }
}

let BASE = DEFAULT_BASE;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') usage();
  const { command, positional, flags } = parseArgs(args);
  if (!COMMANDS.has(command)) usage();
  if (flags.base) BASE = flags.base.replace(/\/$/, '');

  switch (command) {
    case 'feeds': {
      const q = pickFilters(flags);
      emit(await api('/api/feeds', q), flags);
      break;
    }
    case 'post': {
      const sc = positional[0];
      if (!sc) { process.stderr.write('post requires a shortcode\n'); usage(); }
      emit(await api(`/api/feeds/${encodeURIComponent(sc)}`), flags);
      break;
    }
    case 'groups': {
      emit(await api('/api/groups'), flags);
      break;
    }
    case 'group': {
      const id = positional[0];
      if (!id) { process.stderr.write('group requires an id\n'); usage(); }
      emit(await api(`/api/groups/${encodeURIComponent(id)}`), flags);
      break;
    }
    case 'group-create': {
      if (!flags.name) { process.stderr.write('group-create requires --name\n'); usage(); }
      emit(await api('/api/groups', null, {
        method: 'POST',
        body: {
          name: flags.name,
          color: flags.color,
          accounts: csv(flags.accounts),
          keywords: csv(flags.keywords),
          hashtags: csv(flags.hashtags),
        },
      }), flags);
      break;
    }
    case 'group-update': {
      const id = positional[0];
      if (!id) { process.stderr.write('group-update requires an id\n'); usage(); }
      emit(await api(`/api/groups/${encodeURIComponent(id)}`, null, {
        method: 'PUT',
        body: {
          name: flags.name,
          color: flags.color,
          accounts: flags.accounts !== undefined ? csv(flags.accounts) : undefined,
          keywords: flags.keywords !== undefined ? csv(flags.keywords) : undefined,
          hashtags: flags.hashtags !== undefined ? csv(flags.hashtags) : undefined,
        },
      }), flags);
      break;
    }
    case 'group-delete': {
      const id = positional[0];
      if (!id) { process.stderr.write('group-delete requires an id\n'); usage(); }
      emit(await api(`/api/groups/${encodeURIComponent(id)}`, null, { method: 'DELETE' }), flags);
      break;
    }
    case 'group-add':
    case 'group-remove': {
      const id = positional[0];
      const action = command === 'group-add' ? 'add' : 'remove';
      if (!id || !flags.type || !flags.value) {
        process.stderr.write(`${command} requires <id> --type account|keyword|hashtag --value X\n`);
        usage();
      }
      emit(await api(`/api/groups/${encodeURIComponent(id)}/${action}`, null, {
        method: 'POST',
        body: { type: flags.type, value: flags.value },
      }), flags);
      break;
    }
    case 'sources': {
      emit(await api('/api/sources'), flags);
      break;
    }
    case 'export': {
      const q = pickFilters(flags);
      emit(await api('/api/export', { ...q, limit: flags.limit, download: flags.download }), flags);
      break;
    }
    case 'contract': {
      emit(await api('/api/contract'), flags);
      break;
    }
    default:
      usage();
  }
}

function pickFilters(flags) {
  return {
    group: flags.group,
    source: flags.source,
    author: flags.author,
    search: flags.search,
    reel: flags.reel,
    date_from: flags.date_from,
    date_to: flags.date_to,
    limit: flags.limit,
    offset: flags.offset,
    sort: flags.sort,
    order: flags.order,
  };
}

main().catch(err => {
  process.stderr.write(`feed-cli error: ${err.message}\n`);
  process.exit(1);
});
