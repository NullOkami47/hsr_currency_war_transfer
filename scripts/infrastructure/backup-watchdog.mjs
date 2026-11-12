const HOUR = 3600000, OVERDUE = 26 * HOUR;
const SHA = /^[a-f0-9]{64}$/;
const PHASES = new Set(['prepared', 'closing_admission', 'draining', 'stopping', 'stopped',
  'snapshotting', 'starting', 'restoring_admission', 'complete']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function time(value, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= now && new Date(parsed).toISOString() === value ? parsed : null;
}

function schedule(now) {
  const last = new Date(now);
  last.setUTCHours(19, 0, 0, 0); // Hong Kong has fixed UTC+08:00: daily 03:00 HKT.
  if (last.getTime() > now) last.setUTCDate(last.getUTCDate() - 1);
  return { timezone: 'Asia/Hong_Kong', hour: 3, lastScheduledAt: last.toISOString(),
    nextScheduledAt: new Date(last.getTime() + 24 * HOUR).toISOString() };
}

/** Evaluate already collected, sanitised observations. No network, files, email, or mutations. */
export function evaluateBackupWatchdog(input = {}) {
  const alerts = [];
  const add = (code, severity = 'unknown', destination) => {
    if (!alerts.some(a => a.code === code && a.destination === destination)) {
      alerts.push(destination ? { code, severity, destination } : { code, severity });
    }
  };
  const date = object(input) && input.now === undefined ? new Date() : input?.now;
  const now = date instanceof Date ? date.getTime() : NaN;
  const result = { version: 1, state: 'unknown', evaluatedAt: Number.isFinite(now) && now >= 0 ? new Date(now).toISOString() : null,
    schedule: null, restoreVerified: false, alerts };
  if (!object(input) || !Number.isFinite(now) || now < 0) {
    add('invalid_clock'); return result;
  }
  result.schedule = schedule(now);

  function pair(value, scope) {
    if (!object(value)) { add(scope ? 'destination_missing' : 'snapshot_missing', 'unknown', scope); return null; }
    const created = time(value.createdAt, now);
    if (created === null || typeof value.sha256 !== 'string' || !SHA.test(value.sha256)
        || (scope && value.transportVerified !== true)) {
      add(scope ? 'destination_invalid' : 'snapshot_invalid', 'unknown', scope); return null;
    }
    if (now - created > OVERDUE) add(scope ? 'destination_overdue' : 'snapshot_overdue', 'critical', scope);
    return { created, sha256: value.sha256 };
  }

  function status(value, destination) {
    if (!object(value)) { add('status_missing', 'unknown', destination); return null; }
    if (value.restoreVerified === true) add('restore_claim_untrusted', 'unknown', destination);
    const attempt = time(value.lastAttemptAt, now);
    const success = value.lastSuccessAt === null ? null : time(value.lastSuccessAt, now);
    const failure = value.lastFailureAt === null ? null : time(value.lastFailureAt, now);
    if (value.result === 'failure') add('backup_failed', 'critical', destination);
    if (value.result === 'running') add(attempt !== null && now - attempt > 2 * HOUR ? 'backup_interrupted' : 'backup_running',
      attempt !== null && now - attempt > 2 * HOUR ? 'critical' : 'warning', destination);
    if (value.workerHealth !== 'confirmed') add('worker_health_unknown', 'unknown', destination);
    if (value.version !== 1 || !['running', 'success', 'failure'].includes(value.result)
        || !['coordinator', 'delivery', 'complete'].includes(value.stage)
        || !['confirmed', 'unknown'].includes(value.workerHealth)
        || typeof value.transportVerified !== 'boolean' || value.restoreVerified !== false
        || attempt === null || (value.lastSuccessAt !== null && success === null)
        || (value.lastFailureAt !== null && failure === null)
        || (value.result === 'success' && (success === null || success < attempt || failure > success
          || value.stage !== 'complete' || value.workerHealth !== 'confirmed' || value.transportVerified !== true))
        || (value.result === 'failure' && (failure === null || failure < attempt || success > failure || value.transportVerified !== false))
        || (value.result === 'running' && (success > attempt || failure > attempt || value.transportVerified !== false))) {
      add('status_invalid', 'unknown', destination); return null;
    }
    if (now - attempt > OVERDUE) add('schedule_missed', 'critical', destination);
    if (success === null) add('success_missing', 'critical', destination);
    else if (now - success > OVERDUE) add('success_overdue', 'critical', destination);
    return { attempt, success, failure, result: value.result };
  }

  const snapshot = pair(input.snapshot);
  const localStatus = status(input.status);
  const destinations = input.destinations;
  if (!object(destinations)) add('destinations_missing');
  else if (Object.keys(destinations).some(k => !['gcs', 'azure'].includes(k))) add('destinations_unknown');
  // Fixed destination labels prevent arbitrary input, paths, or account names from entering alerts.
  for (const destination of ['gcs', 'azure']) {
    const value = object(destinations) ? destinations[destination] : null;
    if (!object(value)) { add('destination_missing', 'unknown', destination); continue; }
    const latest = pair(value.latest, destination);
    const state = status(value.status, destination);
    const marker = value.successMarker;
    const completed = time(marker?.completedAt, now), created = time(marker?.createdAt, now);
    if (!object(marker) || marker.transportVerified !== true || completed === null || created === null
        || completed < created || !latest || latest.created !== created || latest.sha256 !== marker.sha256
        || !state || state.success !== completed) {
      add('success_marker_invalid', 'unknown', destination);
    }
    if (latest && snapshot && (latest.created < snapshot.created
        || (latest.created === snapshot.created && latest.sha256 !== snapshot.sha256))) {
      add('destination_behind_snapshot', 'warning', destination);
    }
    if (latest && snapshot && latest.created > snapshot.created) add('snapshot_destination_mismatch', 'unknown', destination);
  }

  const journal = input.journal;
  if (!object(journal)) add('journal_missing');
  else if (journal.version !== 1 || typeof journal.runId !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(journal.runId)
      || typeof journal.service !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}\.service$/.test(journal.service)
      || typeof journal.originalAdmission !== 'boolean' || !PHASES.has(journal.phase) || time(journal.updatedAt, now) === null) add('journal_invalid');
  else if (journal.phase !== 'complete') add('journal_interrupted', 'critical');
  else {
    const updated = time(journal.updatedAt, now);
    if (now - updated > OVERDUE || (localStatus && updated < localStatus.attempt)) add('journal_stale');
    if (snapshot && updated < snapshot.created) add('journal_snapshot_mismatch');
    if (localStatus?.result === 'success' && updated > localStatus.success) add('journal_status_mismatch');
  }

  const spool = input.spool;
  if (!object(spool) || !['bytes', 'capacityBytes', 'files', 'capacityFiles'].every(k => Number.isSafeInteger(spool[k]) && spool[k] >= 0)
      || spool.capacityBytes === 0 || spool.capacityFiles === 0 || time(spool.observedAt, now) === null) add('spool_invalid');
  else {
    if (now - time(spool.observedAt, now) > OVERDUE) add('spool_observation_stale');
    if (spool.bytes >= spool.capacityBytes || spool.files >= spool.capacityFiles) add('spool_full', 'critical');
    else if (spool.bytes / spool.capacityBytes >= 0.9 || spool.files / spool.capacityFiles >= 0.9) add('spool_near_capacity', 'warning');
  }
  result.state = alerts.some(a => a.severity === 'critical') ? 'alert'
    : alerts.some(a => a.severity === 'unknown') ? 'unknown' : alerts.length ? 'alert' : 'healthy';
  return result;
}
