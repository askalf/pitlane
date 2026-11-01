// The supervisor's heals, planned as a pure function of this tick's findings and what it did
// before (docs/supervisor.md, phase 2). Two classes: `down`, healed the way the host's runner
// watchdog heals it: `systemctl reset-failed` and `start`, once per row per
// hour; and `stale-registration`, healed the way the mint step clears one name at start: the
// offline registration is deleted on GitHub, once per row and registration per hour. The first
// sighting is the heal, not a finding; the finding is a row that is still down, or still listed,
// on a later tick inside that hour; past the hour it is healed again rather than reported forever.
// A third, `unclaimed-queue`: a row online and idle beside a queued job it has not claimed is
// restarted (`systemctl restart`), so its mint step registers it afresh, once per row per hour.
// A fourth, `crash-loop`: a row whose exit status names the fault, or that failed holdFailures times
// in 5 min, is held: its mark written, the unit stopped and reset-failed, so systemd's Restart=always
// and the dispatcher's starts both stop. The hold lapses after holdMs: the mark goes and the row may
// start again; one still broken loops and is held again. Fewer failures are reported and left running.
// A fifth, `dispatcher-stopped`: gha-ondemand is restarted when systemd holds it failed or its
// heartbeat is stale, once per dispatcherRenagMs; never after a pause by hand.
// The crash-loop and dispatcher-stopped findings always stand: the heal is told, not hidden.
// In observe mode nothing is planned and every finding stands.
//
// A heal never touches a busy row (a Runner.Worker in its cgroup), a parked row or a held row;
// `down` already excludes the last two, and an inactive unit has no worker. A registration is
// deleted only when it is offline, its row's unit is not active, and GitHub does not count it busy:
// a busy entry is a job GitHub still holds against that name, and deleting it fails that job.

export const HEAL = {
  renagMs: 60 * 60000,
  maxPerTick: 5,
  // A held row's mark is removed this long after it was written.
  holdMs: 60 * 60000,
  // Failed exits in 5 min that hold a row (a crash loop runs to dozens). Three to nine is
  // reported and left running; an exit status of 226, 203 or 217 holds at once.
  holdFailures: 10,
  dispatcherRenagMs: 30 * 60000,
};

export const DISPATCHER_UNIT = 'gha-ondemand.service';

const hhmm = (ms) => `${new Date(ms).toISOString().slice(11, 16)}Z`;

/**
 * planHeals({ findings, rows, started, deregistered, recycled, restarted, now, mode }, h) ->
 *   { heals: [{ class, row, unit, why, repo?, id? }], findings: the findings that still stand, cleared: [unit], release: [unit] }
 * `started` is the supervisor's record of unit -> epoch ms of its last start, and is updated here:
 * a row that is serving again drops out of it (and is named in `cleared`). `deregistered` is the
 * record of row -> { at, id } of the registration last deleted (for a pool row's leftover in another
 * repository, keyed row@repository); it is dropped once that id is no longer a registration the row
 * is listed with, so a fresh registration of the same name starts clean. `recycled` is unit -> epoch
 * ms of its last unclaimed-queue restart, dropped after renagMs. `restarted` is the same for the
 * dispatcher's restarts, dropped after dispatcherRenagMs. `release` names the held units whose hold
 * has lapsed (heldAt older than holdMs), whose marks the caller removes; heal mode only.
 *
 * A finding that names its own `repo` and `id` (a pool row's registration: pitlane-supervisor-detect,
 * staleRegistration) is deleted there. A leftover of an earlier claim (`id` other than the row's
 * `regId`) is held by no job, so it goes whatever the row is doing now; the row's own registration
 * waits, as every row's does, for the unit to be inactive and the row not parked by the dispatcher
 * while a job could still reach it.
 */
export function planHeals({ findings, rows, started, deregistered = {}, recycled = {}, restarted = {}, now, mode }, h = HEAL) {
  const cleared = [];
  const release = [];
  const byName = new Map(rows.map((r) => [r.name, r]));
  for (const unit of Object.keys(started)) {
    const row = rows.find((r) => r.unit === unit);
    if (!row || row.active === 'active' || row.active === 'activating') { delete started[unit]; cleared.push(unit); }
  }
  for (const key of Object.keys(deregistered)) {
    const row = byName.get(key.split('@')[0]);
    const ids = row ? [row.regId ?? null, ...(row.staleRegs ?? []).map((x) => x.id)] : [];
    if (!ids.includes(deregistered[key].id)) delete deregistered[key];
  }
  // A restarted row is active again at once, so the record is kept for the hour, not until it serves.
  for (const unit of Object.keys(recycled)) if (now - recycled[unit] >= h.renagMs) delete recycled[unit];
  for (const unit of Object.keys(restarted)) if (now - restarted[unit] >= h.dispatcherRenagMs) delete restarted[unit];
  if (mode !== 'heal') return { heals: [], findings, cleared, release };
  const heals = [];
  const stand = [];
  for (const f of findings) {
    if (f.class === 'down') {
      const row = byName.get(f.row);
      if (!row || row.workerMs !== null || row.parked || row.held) { stand.push(f); continue; }
      const at = started[row.unit];
      if (at !== undefined && now - at < h.renagMs) {
        stand.push({ ...f, msg: `${f.msg}; started again ${Math.round((now - at) / 60000)}m ago and still not serving` });
        continue;
      }
      if (heals.length >= h.maxPerTick) { stand.push(f); continue; }
      heals.push({ class: 'down', row: row.name, unit: row.unit, why: f.msg });
    } else if (f.class === 'stale-registration') {
      const row = byName.get(f.row);
      if (!row) { stand.push(f); continue; }
      const leftover = f.id !== undefined && f.id !== null && f.id !== row.regId;
      const id = leftover ? f.id : row.regId;
      const repo = f.repo ?? row.repo;
      if ((id ?? null) === null || !repo) { stand.push(f); continue; }
      if (!leftover && (row.regBusy || row.workerMs !== null || (row.parked && !row.pool) || row.held || row.active === 'active' || row.active === 'activating')) { stand.push(f); continue; }
      const key = leftover ? `${row.name}@${repo}` : row.name;
      const last = deregistered[key];
      if (last !== undefined && now - last.at < h.renagMs) {
        stand.push({ ...f, msg: `${f.msg}; its registration was deleted ${Math.round((now - last.at) / 60000)}m ago and is still listed` });
        continue;
      }
      if (heals.length >= h.maxPerTick) { stand.push(f); continue; }
      heals.push({ class: 'stale-registration', row: row.name, unit: row.unit, repo, id, ...(leftover ? { key } : {}), why: f.msg });
    } else if (f.class === 'unclaimed-queue') {
      const row = byName.get(f.row);
      if (!row || row.pool || row.regBusy || row.workerMs !== null || row.parked || row.held || row.active !== 'active') { stand.push(f); continue; }
      const at = recycled[row.unit];
      if (at !== undefined) {
        stand.push({ ...f, msg: `${f.msg}; restarted ${Math.round((now - at) / 60000)}m ago and still not claiming` });
        continue;
      }
      if (heals.length >= h.maxPerTick) { stand.push(f); continue; }
      heals.push({ class: 'unclaimed-queue', row: row.name, unit: row.unit, why: f.msg });
    } else if (f.class === 'crash-loop') {
      const row = byName.get(f.row);
      if (!row) { stand.push(f); continue; }
      if (row.held) {
        // A mark with no readable time is never released here: a person wrote it, a person removes it.
        const lapse = Number.isFinite(row.heldAt) ? row.heldAt + h.holdMs : null;
        if (lapse !== null && now >= lapse) { release.push(row.unit); stand.push({ ...f, msg: `${f.msg}; the hold lapsed and is lifted` }); }
        else stand.push(lapse === null ? f : { ...f, msg: `${f.msg}; the hold lapses at ${hhmm(lapse)}` });
        continue;
      }
      stand.push(f);
      const named = f.status !== null && f.status !== undefined;
      if (!named && !((f.failures ?? 0) >= h.holdFailures)) continue;
      if (row.workerMs !== null || heals.length >= h.maxPerTick) continue;
      heals.push({ class: 'crash-loop', row: row.name, unit: row.unit, why: f.msg });
    } else if (f.class === 'dispatcher-stopped') {
      stand.push(f);
      if (f.cause !== 'failed' && f.cause !== 'stale-beat') continue;
      const at = restarted[DISPATCHER_UNIT];
      if (at !== undefined) { stand[stand.length - 1] = { ...f, msg: `${f.msg}; restarted at ${hhmm(at)} and not back` }; continue; }
      // One unit, once per dispatcherRenagMs: not counted against maxPerTick.
      heals.push({ class: 'dispatcher-stopped', row: null, unit: DISPATCHER_UNIT, why: f.msg });
    } else {
      stand.push(f);
    }
  }
  return { heals, findings: stand, cleared, release };
}
