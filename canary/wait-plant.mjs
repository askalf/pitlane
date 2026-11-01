// Waits for the canary's plant job to be sitting in its Plant step on a DIFFERENT runner, so the
// probe's findings mean something. Exits 0 when ready, 1 when the plant never got there in time or
// shares this probe's runner (either way the run proves nothing, so it must not be green).
import { pathToFileURL } from 'node:url';

/** From a run's job list: is the plant mid-step on another runner? Pure, exported for tests. */
export function plantState(jobs, ownRunner) {
  const plant = (jobs ?? []).find((j) => j.name === 'plant');
  if (!plant) return { state: 'missing' };
  const step = (plant.steps ?? []).find((s) => s.name === 'Plant');
  if (step?.status === 'in_progress') {
    if (!plant.runner_name) return { state: 'waiting' };
    return plant.runner_name === ownRunner ? { state: 'same-runner', runner: plant.runner_name } : { state: 'ready', runner: plant.runner_name };
  }
  if (plant.status === 'completed') return { state: 'finished' };
  return { state: 'waiting' };
}

async function main() {
  const { GH_TOKEN, REPO, RUN_ID, RUNNER_NAME } = process.env;
  const deadline = Date.now() + 150000;
  let last = 'missing';
  while (Date.now() < deadline) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/actions/runs/${RUN_ID}/jobs`, {
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'pitlane-canary' },
    });
    if (res.ok) {
      const { state, runner } = plantState((await res.json()).jobs, RUNNER_NAME);
      last = state;
      if (state === 'ready') { console.log(`plant is in its Plant step on ${runner}; this probe is on ${RUNNER_NAME}`); return 0; }
      if (state === 'same-runner' || state === 'finished') break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`INCONCLUSIVE: the plant job was never mid-step on another runner (last state: ${last})`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main());
