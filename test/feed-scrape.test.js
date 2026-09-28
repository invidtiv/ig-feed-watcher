import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = process.env.IG_TEST_ROOT || fileURLToPath(new URL('..', import.meta.url));
const source = readFileSync(resolve(root, 'watcher.js'), 'utf8').replace(/\r\n/g, '\n');
const body = source.match(/async function scrapeFeed\(page\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(body, 'Find the production scrapeFeed function without starting the watcher');

function article(shortcode, caption) {
  const link = { getAttribute: () => `/p/${shortcode}/` };
  const author = { getAttribute: () => '/fixture_author/', textContent: 'fixture_author' };
  return {
    querySelector(selector) {
      if (selector === 'a[href*="/p/"]') return link;
      if (selector.includes('post-caption')) return { textContent: caption };
      if (selector === 'time') return { getAttribute: () => '2026-09-22T10:00:00Z' };
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'header a[href]') return [author];
      if (selector === 'img[src]') return [{src:'https://instagram.example/fixture.jpg'}];
      return [];
    },
  };
}

for (const limit of [2200, 17]) {
  test(`feed extraction crosses the browser boundary with caption limit ${limit}`, async () => {
    const caption = 'A valid feed caption '.repeat(150);
    const scrapeFeed = runInNewContext(`(${body})`, {
      CONFIG: {scrollCount:0, debug:false, captionMaxChars:limit},
      log() {},
    });
    const page = {
      async evaluate(fn, ...args) {
        // Like Puppeteer, serialize the callback into a separate JavaScript
        // realm. Node globals, especially CONFIG, must not leak into it.
        return runInNewContext(`(${fn.toString()})(...args)`, {
          args: structuredClone(args),
          document: {querySelectorAll: () => [article('fixture123', caption)]},
        });
      },
    };
    const posts = await scrapeFeed(page);
    assert.equal(posts.length, 1, 'A valid article must not be silently discarded');
    assert.equal(posts[0].shortcode, 'fixture123');
    assert.equal(posts[0].author, 'fixture_author');
    assert.equal(posts[0].caption, caption.trim().slice(0, limit));
    assert.equal(posts[0].timestamp, '2026-09-22T10:00:00Z');
    assert.equal(posts[0].imageUrls[0], 'https://instagram.example/fixture.jpg');
  });
}
