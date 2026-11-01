// The canary's last job: did a probe that passed run on a pool row (docs/pools.md), and did the Redline
// probe pass on a Redline row? A pool row takes every askalf repository's jobs in turn, so it is where
// one repository's job sits beside another's; a Redline row runs any same-repo PR's job on the `redline`
// label and holds redline.env's group. An enforce run that never probed from one of each has not
// checked those rows, so it must not be green.
// Exits 0 when both did (or in report mode, after printing the rows), 1 otherwise.
import { pathToFileURL } from 'node:url';

const POOL_ROW = /^pool-e\d+$/;
const REDLINE_ROW = /^[a-z0-9-]+-redline-e\d+$/;

/** From a run's job list: the row each probe ran on and how it ended, and whether a passing probe was on a pool row and on a Redline row. Pure, exported for tests. */
export function coverage(jobs) {
  const probes = (jobs ?? []).filter((j) => /^probe( \(.*\)|-redline)?$/.test(j.name ?? ''));
  const passed = (j, row) => j.conclusion === 'success' && row.test(j.runner_name ?? '');
  return {
    probes: probes.map((j) => ({ name: j.name, runner: j.runner_name || null, conclusion: j.conclusion ?? null })),
    pool: probes.some((j) => j.name !== 'probe-redline' && passed(j, POOL_ROW)),
    redline: probes.some((j) => j.name === 'probe-redline' && passed(j, REDLINE_ROW)),
    settled: probes.length > 0 && probes.every((j) => j.status === 'completed' && j.conclusion),
  };
}

async function main() {
  const { GH_TOKEN, REPO, RUN_ID, MODE = 'enforce' } = process.env;
  let result = coverage([]);
  // The probes are done when this job starts; their conclusions can reach the API a few seconds later.
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/actions/runs/${RUN_ID}/jobs?per_page=100`, {
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'pitlane-canary' },
    });
    if (res.ok) result = coverage((await res.json()).jobs);
    if (result.settled) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  for (const p of result.probes) console.log(`${p.name}: ${p.runner ?? '(no runner)'}, ${p.conclusion ?? 'not finished'}`);
  const missing = [
    ...(result.pool ? [] : ['no passing probe ran on a pool row, so the rows that take every repository\'s jobs were not checked']),
    ...(result.redline ? [] : ['the Redline probe did not pass on a Redline row, so the rows that read redline.env were not checked']),
  ];
  if (missing.length === 0) { console.log('a passing probe ran on a pool row and on a Redline row'); return 0; }
  if (MODE === 'report') { for (const m of missing) console.log(`note: ${m}; report mode does not fail on it`); return 0; }
  for (const m of missing) console.log(`INCONCLUSIVE: ${m}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main());
