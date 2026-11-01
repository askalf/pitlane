// node --test runners/pitlane-public.test.mjs
// The public numbers server against a temp directory standing in for the supervisor's public files.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CSP, STALE_MS, pageHtml, publicServer, respond, verdict } from './pitlane-public.mjs';

const AT = Date.parse('2026-10-30T23:00:00Z');
const STATS = { at: '2026-10-30T23:00:00.000Z', window: '24h', jobs: 1240, queueWaitMs: { p50: 2049, p90: 16000 }, targets: { p50Ms: 5000, p90Ms: 30000 }, finished: 1300, runnerSuspect: 0 };
const BADGE = { schemaVersion: 1, label: 'CI on pitlane', cacheSeconds: 300, message: 'starts in 2 s (p50)', color: 'brightgreen' };

function publicDir({ stats = STATS, badge = BADGE } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'public-'));
  if (stats) writeFileSync(join(dir, 'stats.json'), typeof stats === 'string' ? stats : JSON.stringify(stats));
  if (badge) writeFileSync(join(dir, 'badge.json'), JSON.stringify(badge));
  return dir;
}

test('fresh numbers: stats with stale false, the supervisor\'s badge', () => {
  const dir = publicDir();
  assert.deepEqual(respond(dir, '/stats.json', AT + 60000), { status: 200, body: { ...STATS, stale: false } });
  assert.deepEqual(respond(dir, '/badge.json', AT + 60000), { status: 200, body: BADGE });
});

test('a field the server does not list is never published, in the JSON or on the page', () => {
  const dir = publicDir({ stats: { ...STATS, repos: { 'leak/repo': { n: 1 } }, queueWaitMs: { p50: 2049, p90: 16000, worst: 'leak/repo' } }, badge: { ...BADGE, link: ['https://leak.example'] } });
  const { body } = respond(dir, '/stats.json', AT);
  assert.deepEqual(body, { ...STATS, stale: false });
  assert.deepEqual(respond(dir, '/badge.json', AT).body, BADGE);
  const { status, html } = respond(dir, '/', AT);
  assert.equal(status, 200);
  assert.ok(!html.includes('leak'));
});

test('numbers past the stale limit are marked stale and the badge turns grey', () => {
  const dir = publicDir();
  const late = AT + STALE_MS + 1;
  assert.equal(respond(dir, '/stats.json', late).body.stale, true);
  assert.deepEqual(respond(dir, '/badge.json', late), { status: 200, body: { schemaVersion: 1, label: 'CI on pitlane', message: 'stats stale', color: 'lightgrey', cacheSeconds: 300 } });
});

test('missing or broken files: a grey badge still answers 200, the stats answer 503', () => {
  for (const dir of [publicDir({ stats: null, badge: null }), publicDir({ stats: '{not json', badge: null }), publicDir({ badge: { schemaVersion: 1 } })]) {
    const badge = respond(dir, '/badge.json', AT);
    assert.equal(badge.status, 200);
    assert.equal(badge.body.message, 'stats stale');
  }
  assert.equal(respond(publicDir({ stats: null }), '/stats.json', AT).status, 503);
});

test('any other path is a 404', () => {
  const dir = publicDir();
  for (const path of ['/summary.txt', '/../waits.jsonl', '/stats.json/', '/badge', '/public/stats.json', '/index.html']) assert.equal(respond(dir, path, AT).status, 404, path);
});

test('the page shows the published numbers as words, the verdict and the time, with no script tag', () => {
  const { status, html } = respond(publicDir(), '/', AT + 60000);
  assert.equal(status, 200);
  for (const text of ['2 s', '16 s', '1,240', '1,300', 'Both targets met', 'target under 5 s', 'target under 30 s', '2026-10-30 23:00 UTC', '1 minute ago', '/stats.json', '/badge.json', 'pitlane.askalf.org%2Fbadge.json', '](https://pitlane.askalf.org/)']) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes(' style='));
  assert.ok(!html.includes('class="notice'));
  assert.ok(html.includes('<meta http-equiv="refresh" content="60">'));
});

test('the verdict follows the badge thresholds', () => {
  const body = (p50, p90, extra = {}) => ({ ...STATS, queueWaitMs: { p50, p90 }, stale: false, ...extra });
  assert.deepEqual(verdict(body(2049, 16000)), { cls: 'ok', text: 'Both targets met' });
  assert.deepEqual(verdict(body(2049, 40000)), { cls: 'ok', text: 'Median target met' });
  assert.deepEqual(verdict(body(9000, 40000)), { cls: 'warn', text: 'Behind target' });
  assert.deepEqual(verdict(body(20000, 40000)), { cls: 'bad', text: 'Well behind target' });
  assert.deepEqual(verdict(body(2049, 16000, { jobs: 0 })), { cls: 'off', text: 'No jobs in 24 h' });
  assert.deepEqual(verdict(body(2049, 16000, { stale: true })), { cls: 'off', text: 'Numbers stale' });
  assert.deepEqual(verdict(null), { cls: 'off', text: 'No numbers yet' });
});

test('stale numbers put a notice on the page; no numbers yet is a page too, not a 503', () => {
  const stale = respond(publicDir(), '/', AT + STALE_MS + 1).html;
  assert.ok(stale.includes('class="notice"') && stale.includes('Numbers stale') && stale.includes('treat these as history'));
  const none = respond(publicDir({ stats: null }), '/', AT);
  assert.equal(none.status, 200);
  assert.ok(none.html.includes('No numbers yet') && none.html.includes('class="notice off"'));
  const broken = respond(publicDir({ stats: '{not json' }), '/', AT);
  assert.equal(broken.status, 200);
  assert.ok(broken.html.includes('No numbers yet'));
});

test('text from the files is escaped on the page', () => {
  const html = respond(publicDir({ stats: { ...STATS, window: '<b>24h</b>"x\'' } }), '/', AT).html;
  assert.ok(!html.includes('<b>24h</b>'));
  assert.ok(html.includes('&lt;b&gt;24h&lt;/b&gt;&quot;x&#39;'));
  assert.ok(pageHtml({ ...STATS, at: '<img src=x>', stale: true }, AT).includes('unknown time'));
});

test('the policy allows exactly the style block the page carries and nothing else', () => {
  const html = respond(publicDir(), '/', AT).html;
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  assert.equal(styles.length, 1);
  const hash = createHash('sha256').update(styles[0]).digest('base64');
  assert.equal(CSP, `default-src 'none'; style-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  // Every meter width is a class the style block defines, never an inline style.
  for (const cls of html.matchAll(/class="(w\d+)"/g)) assert.ok(styles[0].includes(`.${cls[1]}{`), cls[1]);
});

test('over HTTP: loopback only, JSON headers, query ignored, HEAD has no body, other methods 405', async () => {
  const dir = publicDir();
  const server = await publicServer({ dir, port: 0, now: () => AT });
  try {
    const { address, port } = server.address();
    assert.equal(address, '127.0.0.1');
    const base = `http://127.0.0.1:${port}`;
    const res = await fetch(`${base}/badge.json?cache=1`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(await res.json(), BADGE);
    const head = await fetch(`${base}/stats.json`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const post = await fetch(`${base}/stats.json`, { method: 'POST', body: '{}' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    server.close();
  }
});

test('over HTTP: the page is HTML under the strict policy, with no CORS and no framing', async () => {
  const server = await publicServer({ dir: publicDir(), port: 0, now: () => AT });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/?utm=1`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(res.headers.get('content-security-policy'), CSP);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    const html = await res.text();
    assert.ok(html.startsWith('<!doctype html>') && html.includes('Both targets met'));
    assert.equal(Number(res.headers.get('content-length')), Buffer.byteLength(html));
    const head = await fetch(`${base}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await head.text(), '');
  } finally {
    server.close();
  }
});
