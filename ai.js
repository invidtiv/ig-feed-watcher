// OpenRouter-backed AI helpers for the explorer: answer questions about stored
// posts (optionally with live web search) and suggest group improvements.
import { readConfigValue } from './runtime-policy.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_HISTORY_MESSAGES = 6;
const MAX_SUGGESTIONS_PER_LIST = 15;
const GROUP_FIELDS = ['accounts', 'keywords', 'hashtags'];

export const DEFAULT_MODEL = 'google/gemini-3.8-flash';

export class AiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function loadAiConfig(root) {
  return {
    apiKey: readConfigValue(root, 'OPENROUTER_API_KEY') || '',
    model: readConfigValue(root, 'OPENROUTER_MODEL') || DEFAULT_MODEL,
  };
}

function clip(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// Render posts as a compact numbered text block the model can cite as [n].
export function postsToContext(posts, commentsFor = () => []) {
  return posts.map((p, i) => {
    const meta = [`@${p.author || 'unknown'}`, p.timestamp || p.seen_at || ''];
    if (p.is_reel) meta.push('reel');
    if (p.permalink) meta.push(p.permalink);
    const lines = [`[${i + 1}] ${meta.filter(Boolean).join(' · ')}`, `Caption: ${clip(p.caption, 600) || '(none)'}`];
    const groups = (p.matched_groups || []).map(g => g.name).filter(Boolean);
    if (groups.length) lines.push(`Groups: ${groups.join(', ')}`);
    const comments = commentsFor(p.shortcode);
    if (comments.length) {
      lines.push('Comments: ' + comments.map(c => `@${c.author}: ${clip(c.text, 150)}`).join(' | '));
    }
    return lines.join('\n');
  }).join('\n\n');
}

export async function chat({ apiKey, model, messages, web = false, fetchImpl = fetch }) {
  if (!apiKey) {
    throw new AiError(400, 'OpenRouter API key is not set — add it on the Sources settings page.');
  }
  const body = { model, messages };
  if (web) body.plugins = [{ id: 'web', max_results: 5 }];

  const res = await fetchImpl(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'IG Feed Watcher',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new AiError(502, `OpenRouter error: ${data.error?.message || `HTTP ${res.status}`}`);
  }

  const message = data.choices?.[0]?.message || {};
  const citations = [];
  for (const a of message.annotations || []) {
    const url = a.type === 'url_citation' ? a.url_citation?.url : null;
    if (url && !citations.some(c => c.url === url)) {
      citations.push({ url, title: a.url_citation.title || url });
    }
  }
  return { content: message.content || '', citations, model: data.model || model };
}

export function buildAskMessages({ question, context, postCount, total, history = [], web = false }) {
  const system = [
    'You are an analyst for an Instagram feed monitoring tool.',
    `Answer the user's question using the posts below${web ? ' and web search results' : ''}.`,
    'Cite posts by their [n] number and @author.',
    web
      ? 'If the posts do not answer the question, use the web and say which parts come from the web.'
      : 'If the posts do not answer the question, say so plainly.',
    'Answer in the language of the question. Reply in plain text (no Markdown); use "- " for lists.',
    '',
    `Posts (${postCount} most recent of ${total} matching the current filters):`,
    '',
    context || '(no posts match the current filters)',
  ].join('\n');

  const turns = (Array.isArray(history) ? history : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORY_MESSAGES)
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));

  return [{ role: 'system', content: system }, ...turns, { role: 'user', content: question }];
}

export function buildSuggestMessages({ group, context, postCount, web = false }) {
  const system = [
    'You help curate an interest group in an Instagram feed monitoring tool.',
    'A post matches the group when its author is in "accounts", or its caption contains one of the',
    '"keywords" (case/accent-insensitive substring) or "hashtags".',
    'Suggest improvements so the group catches more relevant posts and fewer irrelevant ones:',
    '- add: Instagram accounts worth following, keywords and hashtags that are missing.',
    '- remove: only current items that are clearly off-topic, redundant or too generic.',
    'Rules: accounts are Instagram usernames without "@" — only suggest accounts you are confident exist',
    `${web ? '(verify them with web search)' : ''}; keywords in the language(s) the group already uses;`,
    `at most ${MAX_SUGGESTIONS_PER_LIST} items per list; each reason is one short sentence.`,
    'Respond with JSON only, exactly this shape:',
    '{"summary":"...","add":{"accounts":[{"value":"...","reason":"..."}],"keywords":[...],"hashtags":[...]},',
    '"remove":{"accounts":[...],"keywords":[...],"hashtags":[...]}}',
  ].join('\n');

  const user = [
    `Group: ${group.name}`,
    `Accounts: ${JSON.stringify(group.accounts || [])}`,
    `Keywords: ${JSON.stringify(group.keywords || [])}`,
    `Hashtags: ${JSON.stringify(group.hashtags || [])}`,
    '',
    `Recent posts matched by this group (${postCount}):`,
    '',
    context || '(none yet)',
  ].join('\n');

  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// Comparison key: case-insensitive, ignoring a leading @ or #.
function itemKey(value) {
  return String(value).trim().replace(/^[@#]+/, '').toLowerCase();
}

const NORMALIZE = {
  accounts: v => {
    const u = v.trim().replace(/^@+/, '').toLowerCase();
    return /^[a-z0-9._]{1,30}$/.test(u) ? u : null;
  },
  keywords: v => v.trim().replace(/\s+/g, ' ') || null,
  hashtags: v => {
    const t = v.trim().replace(/^#+/, '').replace(/\s+/g, '');
    return t ? '#' + t : null;
  },
};

function asItems(list) {
  return (Array.isArray(list) ? list : [])
    .map(x => (typeof x === 'string' ? { value: x, reason: '' } : x))
    .filter(x => x && typeof x.value === 'string')
    .map(x => ({ value: x.value, reason: clip(x.reason, 200) }));
}

// Turn the model's JSON into { summary, add, remove } lists that can be applied
// to the group as-is: additions are normalized and exclude existing items;
// removals refer to the exact stored values.
export function parseSuggestions(content, group) {
  let raw;
  try {
    const match = String(content).match(/\{[\s\S]*\}/);
    raw = JSON.parse(match ? match[0] : content);
  } catch {
    throw new AiError(502, 'The AI returned a response that is not valid JSON — try again.');
  }

  const result = { summary: clip(raw.summary, 500), add: {}, remove: {} };
  for (const field of GROUP_FIELDS) {
    const current = group[field] || [];
    const seen = new Set(current.map(itemKey));
    result.add[field] = [];
    for (const item of asItems(raw.add?.[field])) {
      const value = NORMALIZE[field](item.value);
      if (!value || seen.has(itemKey(value))) continue;
      seen.add(itemKey(value));
      result.add[field].push({ value, reason: item.reason });
    }
    result.add[field] = result.add[field].slice(0, MAX_SUGGESTIONS_PER_LIST);

    result.remove[field] = [];
    for (const item of asItems(raw.remove?.[field])) {
      const stored = current.find(v => itemKey(v) === itemKey(item.value));
      if (stored && !result.remove[field].some(r => r.value === stored)) {
        result.remove[field].push({ value: stored, reason: item.reason });
      }
    }
  }
  return result;
}
