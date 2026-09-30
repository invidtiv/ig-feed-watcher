import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MODEL,
  loadAiConfig,
  postsToContext,
  chat,
  buildAskMessages,
  parseSuggestions,
} from '../ai.js';

function withConfig(contents, fn) {
  const root = mkdtempSync(join(tmpdir(), 'ig-ai-'));
  const saved = { key: process.env.OPENROUTER_API_KEY, model: process.env.OPENROUTER_MODEL };
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODEL;
  try {
    writeFileSync(join(root, '.env.config'), contents);
    return fn(root);
  } finally {
    if (saved.key !== undefined) process.env.OPENROUTER_API_KEY = saved.key;
    if (saved.model !== undefined) process.env.OPENROUTER_MODEL = saved.model;
    rmSync(root, { recursive: true, force: true });
  }
}

function fakeFetch(response, status = 200) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: status >= 200 && status < 300, status, json: async () => response };
  };
  fn.calls = calls;
  return fn;
}

test('loadAiConfig reads key and model from .env.config, defaulting the model', () => {
  withConfig('OPENROUTER_API_KEY=sk-or-test\n', root => {
    assert.deepEqual(loadAiConfig(root), { apiKey: 'sk-or-test', model: DEFAULT_MODEL });
  });
  withConfig('OPENROUTER_API_KEY=sk-or-test\nOPENROUTER_MODEL=openai/gpt-5.5\n', root => {
    assert.equal(loadAiConfig(root).model, 'openai/gpt-5.5');
  });
  withConfig('', root => {
    assert.equal(loadAiConfig(root).apiKey, '');
  });
});

test('postsToContext numbers posts and includes author, caption, groups and comments', () => {
  const text = postsToContext(
    [{
      shortcode: 'abc',
      author: 'embrapa',
      caption: 'Nova   cultivar\nde feijão',
      timestamp: '2026-09-01T10:00:00',
      permalink: 'https://www.instagram.com/p/abc/',
      is_reel: 1,
      matched_groups: [{ id: 'g1', name: 'Florest' }],
    }],
    () => [{ author: 'ana', text: 'Ótimo!' }],
  );
  assert.match(text, /^\[1\] @embrapa · 2026-09-01T10:00:00 · reel · https:\/\/www\.instagram\.com\/p\/abc\//);
  assert.match(text, /Caption: Nova cultivar de feijão/);
  assert.match(text, /Groups: Florest/);
  assert.match(text, /Comments: @ana: Ótimo!/);
});

test('postsToContext clips very long captions', () => {
  const text = postsToContext([{ shortcode: 'x', author: 'a', caption: 'y'.repeat(5000) }]);
  assert.ok(text.length < 1000);
});

test('chat sends an authenticated OpenRouter request and returns content + deduped citations', async () => {
  const fetchImpl = fakeFetch({
    model: 'google/gemini-3.8-flash',
    choices: [{
      message: {
        content: 'Answer',
        annotations: [
          { type: 'url_citation', url_citation: { url: 'https://a.example', title: 'A' } },
          { type: 'url_citation', url_citation: { url: 'https://a.example', title: 'A again' } },
          { type: 'other' },
        ],
      },
    }],
  });
  const result = await chat({
    apiKey: 'sk-or-test',
    model: 'google/gemini-3.8-flash',
    messages: [{ role: 'user', content: 'hi' }],
    web: true,
    fetchImpl,
  });
  assert.equal(result.content, 'Answer');
  assert.deepEqual(result.citations, [{ url: 'https://a.example', title: 'A' }]);
  const [call] = fetchImpl.calls;
  assert.equal(call.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(call.init.headers.Authorization, 'Bearer sk-or-test');
  assert.deepEqual(call.body.plugins, [{ id: 'web', max_results: 5 }]);
});

test('chat omits the web plugin unless requested', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: 'ok' } }] });
  await chat({ apiKey: 'k', model: 'm', messages: [], fetchImpl });
  assert.equal(fetchImpl.calls[0].body.plugins, undefined);
});

test('chat refuses to call OpenRouter without a key', async () => {
  const fetchImpl = fakeFetch({});
  await assert.rejects(
    chat({ apiKey: '', model: 'm', messages: [], fetchImpl }),
    err => err.status === 400 && /API key/.test(err.message),
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('chat surfaces OpenRouter errors as 502', async () => {
  const fetchImpl = fakeFetch({ error: { message: 'Insufficient credits' } }, 402);
  await assert.rejects(
    chat({ apiKey: 'k', model: 'm', messages: [], fetchImpl }),
    err => err.status === 502 && /Insufficient credits/.test(err.message),
  );
});

test('buildAskMessages keeps only recent valid history and ends with the question', () => {
  const history = [
    { role: 'system', content: 'ignore me' },
    ...Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'turn ' + i })),
  ];
  const messages = buildAskMessages({ question: 'What is new?', context: '[1] @a', postCount: 1, total: 1, history });
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /\[1\] @a/);
  assert.equal(messages.filter(m => m.role === 'system').length, 1);
  assert.equal(messages.length, 1 + 6 + 1);
  assert.deepEqual(messages.at(-1), { role: 'user', content: 'What is new?' });
});

test('parseSuggestions normalizes, drops existing and invalid items, and maps removals to stored values', () => {
  const group = {
    accounts: ['embrapa', '@ecouniversidade'],
    keywords: ['Agricultura Familiar'],
    hashtags: ['#MovimentoFuturoLocal'],
  };
  const content = 'Here you go:\n```json\n' + JSON.stringify({
    summary: 'Focus on agroecology.',
    add: {
      accounts: [
        { value: '@MST_Oficial', reason: 'Land reform movement' },
        { value: 'embrapa', reason: 'already there' },
        { value: 'EcoUniversidade', reason: 'already there with @' },
        { value: 'not a username!', reason: 'invalid' },
        { value: 'mst_oficial', reason: 'duplicate' },
      ],
      keywords: [{ value: '  agricultura   familiar ', reason: 'dup' }, { value: 'agrofloresta', reason: 'new' }],
      hashtags: [{ value: 'agrofloresta', reason: 'no #' }, { value: '#movimentofuturolocal', reason: 'dup' }],
    },
    remove: {
      accounts: [{ value: 'ECOUNIVERSIDADE', reason: 'off-topic' }, { value: 'unknown', reason: 'not in group' }],
      keywords: [],
      hashtags: [{ value: 'movimentofuturolocal', reason: 'campaign ended' }],
    },
  }) + '\n```';

  const s = parseSuggestions(content, group);
  assert.equal(s.summary, 'Focus on agroecology.');
  assert.deepEqual(s.add.accounts, [{ value: 'mst_oficial', reason: 'Land reform movement' }]);
  assert.deepEqual(s.add.keywords, [{ value: 'agrofloresta', reason: 'new' }]);
  assert.deepEqual(s.add.hashtags, [{ value: '#agrofloresta', reason: 'no #' }]);
  assert.deepEqual(s.remove.accounts, [{ value: '@ecouniversidade', reason: 'off-topic' }]);
  assert.deepEqual(s.remove.keywords, []);
  assert.deepEqual(s.remove.hashtags, [{ value: '#MovimentoFuturoLocal', reason: 'campaign ended' }]);
});

test('parseSuggestions accepts plain strings and rejects unreadable output', () => {
  const s = parseSuggestions('{"add":{"keywords":["agrofloresta"]}}', { keywords: [] });
  assert.deepEqual(s.add.keywords, [{ value: 'agrofloresta', reason: '' }]);
  assert.deepEqual(s.add.accounts, []);
  assert.throws(() => parseSuggestions('no json here', {}), err => err.status === 502);
});
