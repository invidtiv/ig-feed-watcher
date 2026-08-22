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
  groups                 List interest groups with post counts.
  sources                List ingestion sources (cookie values masked).
  export [filters]       Export post metadata as JSON.
  contract               Print the OpenAPI data contract.

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

const COMMANDS = new Set(['feeds', 'post', 'groups', 'sources', 'export', 'contract', 'help']);

async function api(path, query) {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
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
