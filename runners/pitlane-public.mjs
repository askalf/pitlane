#!/usr/bin/env node
// pitlane-public: the numbers pitlane shows outside the box, served read-only on loopback for the
// tunnel to publish (docs/showcase.md). It reads the files the supervisor writes each tick to
// /run/askalf/pitlane/public (writePublic in pitlane-waits.mjs) and answers with fields listed here
// and nothing else, so a field added to those files stays on the box until it is added here too.
//
//   GET /             a page for people: the same numbers rendered, no script, no outside request
//   GET /stats.json   the last 24 h: jobs, queue wait p50 and p90, targets, runner-caused failures;
//                     the last hour beside them, and the day as 24 hour buckets
//   GET /badge.json   a shields.io endpoint badge
//
// Numbers the supervisor stopped rewriting are served with stale: true, turn the badge grey and put a
// notice on the page, so a stopped supervisor never shows its last good numbers as current. It
// imports no sibling module: a deploy restarts this unit only when this file changes.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const env = process.env;
const log = (msg) => console.log(`pitlane-public: ${msg}`);

/** Older than this, the numbers are a stopped supervisor's: it rewrites them every tick (60 s by default). */
export const STALE_MS = 15 * 60_000;
/** badgeDoc's label in pitlane-waits.mjs, for the badge served when its file is stale or missing. */
const LABEL = 'CI on pitlane';

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=60',
  'access-control-allow-origin': '*',
  'x-content-type-options': 'nosniff',
};

function readJson(dir, name) {
  try { return JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { return null; }
}

const num = (v) => (Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v.length <= 64 ? v : null);

/** At most 24 hour buckets, each its start time and three numbers; anything else in a bucket is dropped. */
export function hoursBody(hours) {
  if (!Array.isArray(hours)) return [];
  return hours.slice(-24).map((h) => ({ from: str(h?.from), jobs: num(h?.jobs), p50: num(h?.p50), p90: num(h?.p90) }));
}

/** The published fields of stats.json; any other field it carries is dropped. */
export function statsBody(stats, stale) {
  return {
    at: str(stats.at), window: str(stats.window), jobs: num(stats.jobs),
    queueWaitMs: { p50: num(stats.queueWaitMs?.p50), p90: num(stats.queueWaitMs?.p90) },
    targets: { p50Ms: num(stats.targets?.p50Ms), p90Ms: num(stats.targets?.p90Ms) },
    finished: num(stats.finished), runnerSuspect: num(stats.runnerSuspect),
    lastHour: { jobs: num(stats.lastHour?.jobs), p50: num(stats.lastHour?.p50), p90: num(stats.lastHour?.p90) },
    hours: hoursBody(stats.hours), stale,
  };
}

/** The published fields of badge.json, or the grey stale badge when it is stale, missing or malformed. */
export function badgeBody(badge, stale) {
  const message = str(badge?.message), color = str(badge?.color);
  if (stale || !message || !color) return { schemaVersion: 1, label: LABEL, message: 'stats stale', color: 'lightgrey', cacheSeconds: 300 };
  return { schemaVersion: 1, label: str(badge.label) ?? LABEL, message, color, cacheSeconds: 300 };
}

// ---- the page ----------------------------------------------------------------------------------

/** fmtWait in pitlane-waits.mjs, repeated here because this file imports no sibling (see the header). */
function fmtWait(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s === 0) return 'under 1 s';
  return s < 120 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Meter widths come from classes, not style attributes, so the policy below can deny every inline style. */
const WIDTH_STEP = 5;
const widthClass = (value, target) => {
  if (!Number.isFinite(value) || !Number.isFinite(target) || target <= 0) return 'w0';
  return `w${Math.min(100, Math.round((value / target) * 100 / WIDTH_STEP) * WIDTH_STEP)}`;
};

/** Bar heights are classes too: an hour's p90 against three times the target, in tenths; h0 is the stub of an empty hour. */
const HEIGHT_STEPS = 10;
const heightClass = (p90, target, jobs) => {
  if (!jobs || !Number.isFinite(p90) || !Number.isFinite(target) || target <= 0) return 'h0';
  return `h${Math.max(1, Math.min(HEIGHT_STEPS, Math.ceil((p90 / (3 * target)) * HEIGHT_STEPS)))}`;
};

const CSS = `
:root{--bg:#f6f7f9;--card:#ffffff;--ink:#14171c;--mute:#5d6572;--line:#e1e5ea;--ok:#1a8f4a;--ok-bg:#e4f5ea;--warn:#a86a00;--warn-bg:#fff2d6;--bad:#b3261e;--bad-bg:#fde7e5;--off:#6b7280;--off-bg:#eceef1;--track:#e9ecf0;--accent:#2457d6}
@media (prefers-color-scheme:dark){:root{--bg:#0e1116;--card:#171b22;--ink:#e8ebf0;--mute:#9aa3b0;--line:#262c36;--ok:#4cc27a;--ok-bg:#12301e;--warn:#e0a63a;--warn-bg:#352a10;--bad:#f07a73;--bad-bg:#3a1a18;--off:#9aa3b0;--off-bg:#232833;--track:#232833;--accent:#7ea2ff}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:960px;margin:0 auto;padding:40px 16px 56px}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 16px;margin-bottom:6px}
h1{margin:0;font-size:28px;letter-spacing:-.01em}h1 small{font-weight:500;color:var(--mute);font-size:16px;letter-spacing:0;margin-left:10px}
.lead{margin:0 0 24px;color:var(--mute);max-width:64ch}
.pill{display:inline-block;padding:3px 12px;border-radius:999px;font-weight:600;font-size:14px;border:1px solid transparent}
.pill.ok{color:var(--ok);background:var(--ok-bg)}.pill.warn{color:var(--warn);background:var(--warn-bg)}.pill.bad{color:var(--bad);background:var(--bad-bg)}.pill.off{color:var(--off);background:var(--off-bg)}
.notice{margin:0 0 20px;padding:12px 16px;border-radius:10px;background:var(--warn-bg);color:var(--warn);border:1px solid var(--warn)}
.notice.off{background:var(--off-bg);color:var(--off);border-color:var(--line)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px}
.card h2{margin:0 0 6px;font-size:13px;font-weight:600;color:var(--mute);text-transform:uppercase;letter-spacing:.06em}
.num{font-size:40px;font-weight:700;line-height:1.1;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.sub{margin:6px 0 0;color:var(--mute);font-size:14px}
.meter{height:6px;border-radius:3px;background:var(--track);margin-top:14px;overflow:hidden}
.meter span{display:block;height:100%;border-radius:3px;background:var(--ok)}.meter.over span{background:var(--bad)}
${Array.from({ length: 100 / WIDTH_STEP + 1 }, (_, i) => `.w${i * WIDTH_STEP}{width:${i * WIDTH_STEP}%}`).join('')}
.hours{display:flex;align-items:flex-end;gap:3px;height:72px;margin:12px 0 4px;border-bottom:1px solid var(--line)}
.bar{flex:1;min-width:4px;border-radius:2px 2px 0 0;background:var(--ok)}.bar.warn{background:var(--warn)}.bar.over{background:var(--bad)}.bar.none{background:var(--track)}
${Array.from({ length: HEIGHT_STEPS + 1 }, (_, i) => `.h${i}{height:${i === 0 ? 4 : i * 10}%}`).join('')}
section{margin:28px 0 0}section h2{font-size:18px;margin:0 0 8px}section p{margin:0 0 10px;color:var(--mute);max-width:72ch}
pre{margin:0;padding:12px 14px;border-radius:10px;background:var(--card);border:1px solid var(--line);overflow-x:auto;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-all}
a{color:var(--accent)}footer{margin-top:36px;padding-top:16px;border-top:1px solid var(--line);color:var(--mute);font-size:14px}
footer p{margin:0 0 6px}code{font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
`;
const CSS_HASH = `'sha256-${createHash('sha256').update(CSS).digest('base64')}'`;
/** The page runs no script and fetches nothing: its one style block is allowed by hash and every other source is denied. */
export const CSP = `default-src 'none'; style-src ${CSS_HASH}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'public, max-age=60',
  'content-security-policy': CSP,
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

/** The one-line verdict and its colour, from the same thresholds as badgeDoc in pitlane-waits.mjs. */
export function verdict(body) {
  if (!body) return { cls: 'off', text: 'No numbers yet' };
  if (body.stale) return { cls: 'off', text: 'Numbers stale' };
  const { p50, p90 } = body.queueWaitMs, { p50Ms, p90Ms } = body.targets;
  if (!body.jobs || !Number.isFinite(p50)) return { cls: 'off', text: 'No jobs in 24 h' };
  if (Number.isFinite(p50Ms) && Number.isFinite(p90Ms) && p50 < p50Ms && p90 < p90Ms) return { cls: 'ok', text: 'Both targets met' };
  if (Number.isFinite(p50Ms) && p50 < p50Ms) return { cls: 'ok', text: 'Median target met' };
  if (Number.isFinite(p50Ms) && p50 < 3 * p50Ms) return { cls: 'warn', text: 'Behind target' };
  return { cls: 'bad', text: 'Well behind target' };
}

const when = (iso, now) => {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return { stamp: 'unknown time', age: '' };
  const d = new Date(t).toISOString(), m = Math.max(0, Math.round((now - t) / 60_000));
  const stamp = `${d.slice(0, 10)} ${d.slice(11, 16)} UTC`;
  return { stamp, age: m === 0 ? 'just now' : m === 1 ? '1 minute ago' : m < 120 ? `${m} minutes ago` : `${Math.floor(m / 60)} hours ago` };
};

/** One bar per hour bucket, oldest first; the title carries the hour's numbers, the classes its height and tone. */
function hourBars(hours, targetMs) {
  if (!hours?.length) return '';
  const bars = hours.map((h) => {
    const t = Date.parse(h.from ?? '');
    const label = Number.isFinite(t) ? `${new Date(t).toISOString().slice(11, 16)}Z` : 'unknown hour';
    const n = Number.isFinite(h.jobs) ? h.jobs : 0;
    const tone = !n || !Number.isFinite(h.p90) ? 'none' : !Number.isFinite(targetMs) || h.p90 < targetMs ? 'ok' : h.p90 < 3 * targetMs ? 'warn' : 'over';
    const title = n ? `${label}: ${grouped(n)} ${n === 1 ? 'job' : 'jobs'}, p50 ${fmtWait(h.p50)}, p90 ${fmtWait(h.p90)}` : `${label}: no jobs`;
    return `<span class="bar ${tone} ${heightClass(h.p90, targetMs, n)}" title="${esc(title)}"></span>`;
  }).join('');
  return `<section><h2>The day by hour</h2>
<p>One bar per hour of the window, oldest on the left. A bar's height is that hour's p90 against three times the target, and its colour says whether the hour beat the target, came within three times it, or did not. A day's p90 is often one hour's burst; this shows which.</p>
<div class="hours">${bars}</div>
</section>`;
}

function waitCard(title, ms, targetMs) {
  const over = Number.isFinite(ms) && Number.isFinite(targetMs) && ms >= targetMs;
  const target = Number.isFinite(targetMs) ? `target under ${esc(fmtWait(targetMs))}` : 'no target set';
  return `<div class="card"><h2>${title}</h2><div class="num">${Number.isFinite(ms) ? esc(fmtWait(ms)) : '&ndash;'}</div><p class="sub">${target}</p><div class="meter${over ? ' over' : ''}"><span class="${widthClass(ms, targetMs)}"></span></div></div>`;
}

/** The whole page for the published fields (statsBody's output, or null before the first tick). */
export function pageHtml(body, now = Date.now()) {
  const v = verdict(body);
  const { stamp, age } = when(body?.at, now);
  const windowText = body?.window ? esc(body.window) : '24h';
  const notice = !body ? '<p class="notice off">The supervisor has not written its first numbers yet. They appear within a minute of the first tick.</p>'
    : body.stale ? `<p class="notice">These numbers were written ${esc(stamp)} (${esc(age)}) and have not been rewritten since. The supervisor rewrites them every minute, so treat these as history, not the present.</p>`
      : '';
  const count = (n) => (Number.isFinite(n) ? grouped(n) : '&ndash;');
  const cards = [
    waitCard('Queue wait, median', body?.queueWaitMs.p50, body?.targets.p50Ms),
    waitCard('Queue wait, p90', body?.queueWaitMs.p90, body?.targets.p90Ms),
    `<div class="card"><h2>Jobs in the window</h2><div class="num">${count(body?.jobs)}</div><p class="sub">${count(body?.finished)} finished, ${count(body?.runnerSuspect)} failed with the runner suspected</p></div>`,
    `<div class="card"><h2>Last hour</h2><div class="num">${Number.isFinite(body?.lastHour?.p50) ? esc(fmtWait(body.lastHour.p50)) : '&ndash;'}</div><p class="sub">median; p90 ${Number.isFinite(body?.lastHour?.p90) ? esc(fmtWait(body.lastHour.p90)) : '&ndash;'}, ${count(body?.lastHour?.jobs)} jobs</p></div>`,
  ].join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<meta name="description" content="Live queue-wait numbers for pitlane, self-hosted GitHub Actions runners measured on every job from queued to running.">
<title>CI on pitlane</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header><h1>pitlane<small>CI on self-hosted runners</small></h1><span class="pill ${v.cls}">${esc(v.text)}</span></header>
<p class="lead">Every GitHub Actions job that lands on a pitlane runner is measured from the moment it queues to the moment it runs. These are the last ${windowText} across every repository the runners serve, rewritten every minute.</p>
${notice}
<div class="grid">${cards}</div>
${hourBars(body?.hours, body?.targets.p90Ms)}
<section><h2>What the numbers mean</h2>
<p>The queue wait is the time between GitHub creating a job and a runner starting it: the whole of the wait a developer sees before their logs begin. The median is the typical job; p90 is the slow tail, the wait nine jobs in ten beat. The targets are the ones the runners are tuned to, and the badge turns from green to grey the moment the supervisor stops writing. The verdict and the badge read the whole day; the last hour and the bars say whether the day's tail is still here.</p>
<p>A job the runner itself is suspected of failing counts as runner-suspected; the rest of the failures belong to the code under test.</p>
</section>
<section><h2>Put it on a README</h2>
<p>The badge is fetched live and never committed. It links back to this page.</p>
<pre><code>[![CI on pitlane](https://img.shields.io/endpoint?url=https%3A%2F%2Fpitlane.askalf.org%2Fbadge.json)](https://pitlane.askalf.org/)</code></pre>
</section>
<footer>
<p>Updated ${esc(stamp)}${age ? ` (${esc(age)})` : ''}. Machine-readable: <a href="/stats.json">/stats.json</a> and <a href="/badge.json">/badge.json</a>.</p>
<p>Published here: the totals above and nothing else. No answer names a repository, a runner or a single job. Built by <a href="https://github.com/askalf" rel="noopener">askalf</a>.</p>
</footer>
</main>
</body>
</html>
`;
}

// ---- answers -----------------------------------------------------------------------------------

/** The status and body (JSON) or html (the page) for a GET of path; dir holds the supervisor's files. */
export function respond(dir, path, now = Date.now(), staleMs = STALE_MS) {
  if (path !== '/' && path !== '/stats.json' && path !== '/badge.json') return { status: 404, body: { error: 'not found' } };
  const stats = readJson(dir, 'stats.json');
  const valid = Boolean(stats) && typeof stats === 'object';
  const at = Date.parse(stats?.at ?? '');
  const stale = !(Number.isFinite(at) && now - at <= staleMs);
  // shields.io shows any answer other than a 200 with a badge as an error badge, so this one always answers.
  if (path === '/badge.json') return { status: 200, body: badgeBody(stale ? null : readJson(dir, 'badge.json'), stale) };
  // The page is built from statsBody's output, so the field allowlist above governs it as well.
  if (path === '/') return { status: 200, html: pageHtml(valid ? statsBody(stats, stale) : null, now) };
  if (!valid) return { status: 503, body: { error: 'no numbers yet' } };
  return { status: 200, body: statsBody(stats, stale) };
}

/** Listen on host:port (loopback by default) and answer from dir. Resolves to the listening server. */
export function publicServer({ dir, port, host = '127.0.0.1', now = () => Date.now(), staleMs = STALE_MS }) {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...HEADERS, allow: 'GET, HEAD' });
      res.end('{"error":"method not allowed"}\n');
      return;
    }
    const { status, body, html } = respond(dir, (req.url ?? '/').split('?')[0], now(), staleMs);
    const text = html ?? `${JSON.stringify(body)}\n`;
    res.writeHead(status, { ...(html ? PAGE_HEADERS : HEADERS), 'content-length': Buffer.byteLength(text) });
    res.end(req.method === 'HEAD' ? undefined : text);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = env.PITLANE_PUBLIC_DIR || '/run/askalf/pitlane/public';
  const port = Number(env.PITLANE_PUBLIC_PORT) || 7312;
  publicServer({ dir, port }).then(
    () => log(`serving ${dir} on 127.0.0.1:${port}`),
    (err) => { log(`cannot listen on 127.0.0.1:${port}: ${err?.message ?? err}`); process.exit(1); },
  );
}
