import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateBackupWatchdog } from '../scripts/infrastructure/backup-watchdog.mjs';

const NOW = '2026-11-12T20:00:00.000Z'; // 04:00 HKT, after the 03:00 daily slot.
const CREATED = '2026-11-12T19:01:00.000Z';
const SHA = 'a'.repeat(64);

function fixture() {
  const status = { version: 1, result: 'success', lastAttemptAt: '2026-11-12T19:00:00.000Z',
    lastSuccessAt: '2026-11-12T19:02:00.000Z', lastFailureAt: null, stage: 'complete',
    workerHealth: 'confirmed', transportVerified: true, restoreVerified: false };
  const destination = { latest: { createdAt: CREATED, sha256: SHA, transportVerified: true },
    successMarker: { createdAt: CREATED, sha256: SHA, completedAt: status.lastSuccessAt, transportVerified: true },
    status: structuredClone(status) };
  return { now: new Date(NOW), snapshot: { createdAt: CREATED, sha256: SHA }, status,
    destinations: { gcs: structuredClone(destination), azure: structuredClone(destination) },
    journal: { version: 1, runId: '00000000-0000-4000-8000-000000000001', service: 'hsr-transfer-worker.service',
      originalAdmission: true, phase: 'complete', updatedAt: '2026-11-12T19:01:30.000Z' },
    spool: { bytes: 100, capacityBytes: 10000, files: 2, capacityFiles: 100, observedAt: NOW } };
}
const codes = result => result.alerts.map(a => a.code);

test('healthy dual transport evidence returns no alerts and computes the HKT schedule in UTC', () => {
  const result = evaluateBackupWatchdog(fixture());
  assert.equal(result.state, 'healthy'); assert.deepEqual(result.alerts, []);
  assert.equal(result.schedule.lastScheduledAt, '2026-11-12T19:00:00.000Z');
  assert.equal(result.schedule.nextScheduledAt, '2026-11-13T19:00:00.000Z');
  assert.equal(result.restoreVerified, false);
});

test('the daily schedule rolls at exactly 19:00 UTC, including month boundaries', () => {
  for (const [at, previous, next] of [
    ['2026-12-01T18:59:59.999Z', '2026-11-30T19:00:00.000Z', '2026-12-01T19:00:00.000Z'],
    ['2026-12-01T19:00:00.000Z', '2026-12-01T19:00:00.000Z', '2026-12-02T19:00:00.000Z'],
  ]) {
    const f = fixture(); f.now = new Date(at);
    assert.deepEqual(evaluateBackupWatchdog(f).schedule, { timezone: 'Asia/Hong_Kong', hour: 3,
      lastScheduledAt: previous, nextScheduledAt: next });
  }
});

test('snapshot and each destination become overdue strictly after 26 hours', () => {
  const f = fixture();
  f.now = new Date('2026-11-13T21:01:00.000Z');
  assert.ok(!codes(evaluateBackupWatchdog(f)).includes('snapshot_overdue'));
  f.now = new Date('2026-11-13T21:01:00.001Z');
  const result = evaluateBackupWatchdog(f);
  assert.ok(codes(result).includes('snapshot_overdue'));
  assert.deepEqual(result.alerts.filter(a => a.code === 'destination_overdue').map(a => a.destination).sort(), ['azure', 'gcs']);
  assert.ok(codes(result).includes('schedule_missed'));
});

test('one healthy destination cannot conceal a missing or failed second destination', () => {
  const f = fixture(); f.destinations.gcs = null;
  const missing = evaluateBackupWatchdog(f);
  assert.notEqual(missing.state, 'healthy');
  assert.ok(missing.alerts.some(a => a.code === 'destination_missing' && a.destination === 'gcs'));
  const other = fixture(); other.destinations.azure.status.result = 'failure';
  other.destinations.azure.status.stage = 'delivery';
  other.destinations.azure.status.lastFailureAt = '2026-11-12T19:03:00.000Z';
  other.destinations.azure.status.transportVerified = false;
  const result = evaluateBackupWatchdog(other);
  assert.ok(result.alerts.some(a => a.code === 'backup_failed' && a.destination === 'azure'));
});

test('success marker is required and bound to the same pair and completed status', () => {
  for (const mutate of [
    d => { d.successMarker = null; }, d => { d.successMarker.sha256 = 'b'.repeat(64); },
    d => { d.successMarker.createdAt = '2026-11-11T19:01:00.000Z'; },
    d => { d.successMarker.completedAt = '2026-11-12T19:03:00.000Z'; },
    d => { d.successMarker.transportVerified = false; }, d => { d.latest.transportVerified = false; },
  ]) {
    const f = fixture(); mutate(f.destinations.gcs);
    const result = evaluateBackupWatchdog(f);
    assert.notEqual(result.state, 'healthy');
    assert.ok(result.alerts.some(a => a.destination === 'gcs'));
  }
});

test('a destination behind the latest local snapshot raises an independent alert', () => {
  const f = fixture();
  f.snapshot.createdAt = '2026-11-12T19:30:00.000Z'; f.snapshot.sha256 = 'b'.repeat(64);
  const result = evaluateBackupWatchdog(f);
  assert.equal(result.alerts.filter(a => a.code === 'destination_behind_snapshot').length, 2);
});

test('failure and interrupted journals alert even while all backups are fresh', () => {
  for (const phase of ['prepared', 'closing_admission', 'draining', 'stopping', 'stopped', 'snapshotting', 'starting', 'restoring_admission']) {
    const f = fixture(); f.journal.phase = phase;
    const result = evaluateBackupWatchdog(f);
    assert.ok(codes(result).includes('journal_interrupted')); assert.equal(result.state, 'alert');
  }
  const f = fixture(); f.status.result = 'failure'; f.status.lastFailureAt = NOW;
  f.status.stage = 'coordinator'; f.status.workerHealth = 'unknown'; f.status.transportVerified = false;
  const result = evaluateBackupWatchdog(f);
  assert.ok(codes(result).includes('backup_failed')); assert.ok(codes(result).includes('worker_health_unknown'));
});

test('an old complete journal cannot prove recovery for a newer attempt or snapshot', () => {
  for (const [updatedAt, code] of [
    ['2026-10-01T19:01:30.000Z', 'journal_stale'],
    ['2026-11-12T19:00:30.000Z', 'journal_snapshot_mismatch'],
    ['2026-11-12T19:03:00.000Z', 'journal_status_mismatch'],
  ]) {
    const f = fixture(); f.journal.updatedAt = updatedAt;
    const result = evaluateBackupWatchdog(f);
    assert.notEqual(result.state, 'healthy'); assert.ok(codes(result).includes(code));
  }
});

test('running state is visible, and a run older than two hours is interrupted', () => {
  const f = fixture(); f.status.result = 'running'; f.status.transportVerified = false; f.status.stage = 'delivery';
  assert.ok(codes(evaluateBackupWatchdog(f)).includes('backup_running'));
  f.now = new Date('2026-11-12T21:00:00.001Z');
  assert.ok(codes(evaluateBackupWatchdog(f)).includes('backup_interrupted'));
});

test('byte and file capacity independently report warning at 90 percent and critical at 100 percent', () => {
  for (const patch of [{ bytes: 9000 }, { files: 90 }]) {
    const f = fixture(); Object.assign(f.spool, patch);
    assert.ok(codes(evaluateBackupWatchdog(f)).includes('spool_near_capacity'));
  }
  for (const patch of [{ bytes: 10000 }, { files: 101 }]) {
    const f = fixture(); Object.assign(f.spool, patch);
    const result = evaluateBackupWatchdog(f);
    assert.ok(result.alerts.some(a => a.code === 'spool_full' && a.severity === 'critical'));
  }
});

test('missing, future, invalid calendar values and unknown states never report healthy', () => {
  for (const mutate of [
    f => { f.snapshot = null; }, f => { f.journal = null; }, f => { f.status = null; }, f => { f.spool = null; },
    f => { f.snapshot.createdAt = '2026-02-30T19:00:00.000Z'; },
    f => { f.snapshot.createdAt = '2099-01-01T00:00:00.000Z'; },
    f => { f.journal.phase = 'unexpected'; }, f => { f.journal.originalAdmission = 'true'; },
    f => { f.status.result = 'something'; }, f => { f.status.lastFailureAt = 'yesterday'; },
    f => { f.destinations.azure.latest.createdAt = '2099-01-01T00:00:00.000Z'; },
    f => { f.spool.bytes = NaN; }, f => { f.spool.capacityFiles = 0; },
    f => { f.spool.observedAt = '2099-01-01T00:00:00.000Z'; },
    f => { f.now = new Date('invalid'); },
  ]) {
    const f = fixture(); mutate(f);
    const result = evaluateBackupWatchdog(f);
    assert.notEqual(result.state, 'healthy'); assert.ok(result.alerts.length > 0);
  }
  assert.notEqual(evaluateBackupWatchdog().state, 'healthy');
});

test('stale spool observations and inconsistent success states are unknown', () => {
  const f = fixture(); f.spool.observedAt = '2026-11-10T19:00:00.000Z';
  assert.ok(codes(evaluateBackupWatchdog(f)).includes('spool_observation_stale'));
  for (const patch of [{ transportVerified: false }, { workerHealth: 'unknown' },
    { stage: 'delivery' }, { lastSuccessAt: null }, { lastSuccessAt: '2026-11-12T18:00:00.000Z' }]) {
    const g = fixture(); Object.assign(g.status, patch);
    assert.notEqual(evaluateBackupWatchdog(g).state, 'healthy');
  }
});

test('alerts never echo credentials, object paths, error details, or unrecognised destination labels', () => {
  const f = fixture();
  const secret = 'SYNTHETIC-SECRET-DO-NOT-OUTPUT';
  f.error = secret; f.status.error = secret; f.snapshot.file = '/private/' + secret;
  f.destinations[secret] = { token: secret }; f.journal.service = secret; f.status.result = secret;
  const result = evaluateBackupWatchdog(f);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(result.alerts.every(a => /^[a-z_]+$/.test(a.code)));
  assert.equal(result.restoreVerified, false);
});

test('daily transport status cannot claim externally verified restore or bless an unknown destination', () => {
  const f = fixture(); f.status.restoreVerified = true; f.destinations.gcs.status.restoreVerified = true;
  const result = evaluateBackupWatchdog(f);
  assert.equal(result.restoreVerified, false); assert.notEqual(result.state, 'healthy');
  assert.ok(codes(result).includes('restore_claim_untrusted'));
});
