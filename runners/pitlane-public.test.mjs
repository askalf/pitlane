// node --test runners/pitlane-public.test.mjs
// The public numbers server against a temp directory standing in for the supervisor's public files.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CSP, STALE_MS, pageHtml, per10k, publicServer, respond, statsBody, verdict } from './pitlane-public.mjs';

const AT = Date.parse('2026-10-30T23:00:00Z');
const HOURS = Array.from({ length: 24 }, (_, i) => ({ from: new Date(AT - (24 - i) * 3600000).toISOString(), jobs: i === 3 ? 0 : 50, p50: i === 3 ? null : 2000, p90: i === 3 ? null : i === 23 ? 37000 : 8000 }));
const STATS = { at: '2026-10-30T23:00:00.000Z', window: '24h', jobs: 1240, queueWaitMs: { p50: 2049, p90: 16000 }, targets: { p50Ms: 5000, p90Ms: 30000 }, finished: 1300, runnerSuspect: 0, ran: 1290, runMs: { p50: 18200, p90: 74000 }, feltMs: { p50: 28000, p90: 102000 }, lastHour: { jobs: 50, p50: 2000, p90: 37000 }, hours: HOURS };
const BADGE = { schemaVersion: 1, label: 'CI measured', cacheSeconds: 300, message: 'start 2 s · run 18 s', color: 'brightgreen' };

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
  assert.deepEqual(respond(dir, '/badge.json', late), { status: 200, body: { schemaVersion: 1, label: 'CI measured', message: 'stats stale', color: 'lightgrey', cacheSeconds: 300 } });
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
  // The lab framing, the sections in order, the run and felt numbers, and the README snippet's new alt text.
  for (const text of ["the lab where ci-wizard's method is proven", 'https://github.com/askalf/ci-wizard', '18 s', 'p90 74 s', '28 s', 'p90 102 s', '1,290 jobs that ran', '[![CI measured]']) assert.ok(html.includes(text), text);
  const order = ['<h2>Start</h2>', '<h2>Run</h2>', '<h2>Stable</h2>', '<h2>How it is measured</h2>', '<h2>The method</h2>', '<h2>Put it on a README</h2>'].map((h) => html.indexOf(h));
  assert.ok(order.every((i) => i > 0), 'every section is on the page');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'sections in order');
  assert.ok(!html.includes('CI on pitlane'), 'the old label is gone');
  // The wrap-up tail is not published yet, so the page does not claim to publish it.
  assert.ok(!/publish[^.]*wrap-up/i.test(html), 'no claim that the wrap-up time is published');
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

test('the last hour and the hour buckets are published as numbers only, at most 24, and drawn as bars from classes', () => {
  const hours = [{ from: 'x', jobs: 1, p50: 1, p90: 1, repo: 'leak/repo' }, ...HOURS];
  const dir = publicDir({ stats: { ...STATS, lastHour: { jobs: 50, p50: 2000, p90: 37000, worst: 'leak/repo' }, hours } });
  const body = respond(dir, '/stats.json', AT).body;
  assert.equal(body.hours.length, 24);
  assert.deepEqual(body.hours[23], HOURS[23]);
  assert.deepEqual(body.lastHour, { jobs: 50, p50: 2000, p90: 37000 });
  assert.ok(!JSON.stringify(body).includes('leak'));
  const html = respond(dir, '/', AT).html;
  assert.equal((html.match(/<span class="bar /g) || []).length, 24);
  assert.ok(html.includes('Last hour') && html.includes('p90 37 s'));
  assert.ok(html.includes('title="22:00Z: 50 jobs, p50 2 s, p90 37 s"'), 'the newest hour, over the target');
  assert.ok(html.includes('class="bar warn h5"'), 'thirty-seven seconds: over the target, inside three times it, five tenths of the bar');
  assert.ok(html.includes('class="bar none h0" title="02:00Z: no jobs"'), 'an empty hour is a stub');
  assert.ok(!html.includes(' style='));
  // The bars are hidden from screen readers, and the same numbers are a table only they read.
  assert.ok(html.includes('<div class="hours" aria-hidden="true">'));
  const table = /<table class="sr">([\s\S]*?)<\/table>/.exec(html);
  assert.ok(table, 'a text alternative for the bars');
  assert.equal((table[1].match(/<tr><th scope="row">/g) || []).length, 24);
  assert.ok(table[1].includes('<tr><th scope="row">22:00Z</th><td>50</td><td>2 s</td><td>37 s</td></tr>'));
  assert.ok(table[1].includes('<tr><th scope="row">02:00Z</th><td>0</td><td></td><td></td></tr>'), 'an empty hour has no wait');
  const none = respond(publicDir({ stats: { ...STATS, hours: 'no', lastHour: null } }), '/', AT);
  assert.deepEqual(respond(publicDir({ stats: { ...STATS, hours: 'no', lastHour: null } }), '/stats.json', AT).body.hours, []);
  assert.ok(!none.html.includes('The day by hour') && none.html.includes('Last hour'));
});

test('the head names the page for link previews and search, and the footer links the code and the method', () => {
  const html = respond(publicDir(), '/', AT).html;
  assert.ok(html.includes('<link rel="canonical" href="https://pitlane.askalf.org/">'));
  assert.ok(html.includes('<meta property="og:url" content="https://pitlane.askalf.org/">'));
  assert.ok(html.includes('<meta property="og:title" content="pitlane: CI measured">'));
  assert.ok(/<meta property="og:description" content="[^"]+">/.test(html));
  assert.ok(html.includes('<link rel="icon" href="data:image/svg+xml,'));
  assert.ok(html.includes('href="https://github.com/askalf/pitlane/blob/main/docs/method.md"'));
  assert.ok(html.includes('href="https://github.com/askalf/pitlane"'));
});

/** WCAG 2 contrast ratio of two #rrggbb colours. */
function contrast(a, b) {
  const lum = (h) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('every pill and notice text meets 4.5:1 on its background, in both palettes', () => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(respond(publicDir(), '/', AT).html)[1];
  const palettes = [/:root\{([^}]*)\}/.exec(css)[1], /prefers-color-scheme:dark\)\{:root\{([^}]*)\}/.exec(css)[1]];
  for (const palette of palettes) {
    const tok = Object.fromEntries([...palette.matchAll(/--([\w-]+):(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]));
    for (const [ink, bg] of [['ok-ink', 'ok-bg'], ['warn-ink', 'warn-bg'], ['bad', 'bad-bg'], ['off-ink', 'off-bg']]) {
      assert.ok(contrast(tok[ink], tok[bg]) >= 4.5, `${ink} on ${bg}: ${contrast(tok[ink], tok[bg]).toFixed(2)}`);
    }
  }
  for (const [cls, ink] of [['ok', 'ok-ink'], ['warn', 'warn-ink'], ['off', 'off-ink']]) {
    assert.ok(css.includes(`.pill.${cls}{color:var(--${ink})`), `the ${cls} pill uses its ink`);
  }
  assert.ok(css.includes('.notice{') && /\.notice\{[^}]*color:var\(--warn-ink\)/.test(css));
});

test('the policy allows exactly the style block the page carries and nothing else', () => {
  const html = respond(publicDir(), '/', AT).html;
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  assert.equal(styles.length, 1);
  const hash = createHash('sha256').update(styles[0]).digest('base64');
  assert.equal(CSP, `default-src 'none'; style-src 'sha256-${hash}'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  // The one image the policy allows is the inline favicon: no image source on the page is a URL.
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) if (/^data:/.test(m[1])) assert.ok(m[1].startsWith('data:image/svg+xml,'), m[1]);
  // Every meter width is a class the style block defines, never an inline style.
  for (const cls of html.matchAll(/class="(w\d+)"/g)) assert.ok(styles[0].includes(`.${cls[1]}{`), cls[1]);
  // So is every bar height and tone.
  for (const cls of html.matchAll(/class="bar (\w+) (h\d+)"/g)) assert.ok(styles[0].includes(`.bar.${cls[1]}{`) || cls[1] === 'ok', cls[1]), assert.ok(styles[0].includes(`.${cls[2]}{`), cls[2]);
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

test('a stats file from before run time existed still serves every old key, with null run and felt numbers and dashes on the page', () => {
  const { ran, runMs, feltMs, ...old } = STATS;
  const body = statsBody(old, false);
  for (const k of ['at', 'window', 'jobs', 'queueWaitMs', 'targets', 'finished', 'runnerSuspect', 'lastHour', 'hours']) assert.ok(k in body, k);
  assert.deepEqual([body.ran, body.runMs, body.feltMs], [null, { p50: null, p90: null }, { p50: null, p90: null }]);
  const html = pageHtml(body, AT + 60000);
  assert.ok(html.includes('<h2>Run</h2>'));
  assert.match(html, /Run, median<\/h2><div class="num">&ndash;/);
});

test('per10k: runner-suspected failures per 10,000 finished jobs, to one decimal, and nothing without finished jobs', () => {
  assert.equal(per10k(6, 37261), '1.6');
  assert.equal(per10k(0, 1300), '0');
  assert.equal(per10k(13, 1300), '100');
  assert.equal(per10k(1, 3), '3333.3');
  assert.equal(per10k(2, 0), '');
  assert.equal(per10k(null, 100), '');
  const html = pageHtml({ ...statsBody(STATS, false), runnerSuspect: 2, finished: 1300 }, AT + 60000);
  assert.ok(html.includes('15.4 per 10,000 of 1,300 finished jobs'));
});
