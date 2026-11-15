import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stateProof, assertPreserved, digest } from './restart-control-state.mjs';

function dashboard(value, admission) {
  if (typeof value?.settings?.publicSubmissionsEnabled !== 'boolean' || admission !== undefined && value.settings.publicSubmissionsEnabled !== admission
      || !Number.isInteger(value?.stats?.queued) || value.stats.queued < 0 || !Number.isInteger(value.stats.running) || value.stats.running < 0
      || !Array.isArray(value.jobs)) throw new Error('Invalid dashboard or changed admission');
  return value;
}
function dashboardProof(value) {
  const copy = structuredClone(value);
  delete copy.settings.publicSubmissionsEnabled;
  // These three derived quota counters legitimately move with the UTC clock.
  delete copy.stats.jobsToday; delete copy.stats.remainingDailyQuota; delete copy.stats.quotaRecoveryUntil;
  return digest(copy);
}
function assertDashboardState(d, state, at) {
  const jobs = Object.values(state.jobs.jobs); const settings = state.jobs.settings;
  if (digest(d.settings) !== digest(settings) || d.stats.queued !== jobs.filter(j => j.status === 'queued').length
      || d.stats.running !== jobs.filter(j => j.status === 'running').length || d.stats.storedJobs !== jobs.length
      || d.stats.active !== d.stats.queued + d.stats.running) throw new Error('Dashboard and durable jobs differ');
  const start = Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth(), new Date(at).getUTCDate());
  const today = state.jobs.quota.events.filter(e => e.at > at - 86400000 && e.at >= start).length;
  const blocked = state.jobs.quota.blockedUntil > at;
  if (d.stats.jobsToday !== today || d.stats.remainingDailyQuota !== (blocked ? 0 : Math.max(0, settings.dailyAccountQuota - today))
      || d.stats.quotaRecoveryUntil !== (blocked ? new Date(state.jobs.quota.blockedUntil).toISOString() : null)) throw new Error('Dashboard quota semantics differ');
}

// Failures deliberately do not restart, restore admission, repair files or retry
// mutations. A fresh, explicitly authorised recovery must prove its checkpoint.
export async function coordinatedRestart({ operations: ops, authorised = false, recover = false, inspect = false, maxPolls = 120, shouldAbort = () => false }) {
  if (!inspect && !authorised) throw new Error('Explicit controlled restart authorisation required');
  if (!Number.isInteger(maxPolls) || maxPolls < 1 || maxPolls > 600 || inspect && recover) throw new Error('Invalid bounded restart arguments');
  let held = false, record, closedConfirmed = false, stopAttempted = false;
  const check = () => { if (shouldAbort()) throw new Error('Maintenance interrupted; explicit recovery required'); };
  const sameContract = async record => { if (await ops.contract() !== record.contract) throw new Error('Service/preflight contract changed'); };
  async function restoreBeforeStop(outcome) {
    check(); await sameContract(record); await ops.assertRunning(record.originalProcess); await ops.health();
    const d = dashboard(await ops.dashboard(), false); const current = stateProof(await ops.state(), ops.now(), { allowActive: true });
    const settings = { ...d.settings }; delete settings.publicSubmissionsEnabled;
    if (digest(settings) !== record.initial.settings || current.settings !== record.initial.settings || current.admission !== false) throw new Error('Policy changed during abort');
    check(); record = await ops.journal.phase('aborting');
    await ops.setAdmission(record.originalAdmission);
    const restored = dashboard(await ops.dashboard(), record.originalAdmission);
    const policy = { ...restored.settings }; delete policy.publicSubmissionsEnabled;
    const final = stateProof(await ops.state(), ops.now(), { allowActive: true });
    if (digest(policy) !== record.initial.settings || final.settings !== record.initial.settings || final.admission !== record.originalAdmission) throw new Error('Policy changed during abort restore');
    await ops.assertRunning(record.originalProcess); await sameContract(record);
    record = await ops.journal.phase('complete', { outcome, final });
    return { runId: record.runId, phase: record.phase, originalAdmission: record.originalAdmission, startAttempts: record.startAttempts, outcome };
  }
  async function closedProof(record) {
    const state = await ops.state(); const proof = stateProof(state, ops.now());
    assertPreserved(record.baseline, proof, ops.now()); return proof;
  }
  try {
    await ops.acquire(); held = true;
    const contract = await ops.contract(); const old = await ops.journal.read();
    if (inspect) {
      const observation = await ops.observe(); const proof = stateProof(await ops.state(), ops.now(), { allowActive: true });
      return { inspected: true, service: observation, state: proof, phase: old?.phase ?? null, mutations: false };
    }
    await ops.checkBackup(); check();
    if (recover) {
      if (!old || old.phase === 'complete') throw new Error('No unfinished maintenance checkpoint to recover');
      record = old; await sameContract(record);
      if (['prepared', 'closing', 'draining', 'aborting'].includes(record.phase)) return await restoreBeforeStop('recovered_before_stop');
      if (!['drained', 'stopping', 'stopped', 'starting', 'started', 'restoring'].includes(record.phase)) throw new Error('Incomplete drain or uncertain admission; manual reconciliation required');
      if (record.phase === 'drained') await ops.assertRunning(record.originalProcess);
      else if (['stopping', 'stopped', 'starting'].includes(record.phase)) await ops.assertStopped(record.originalProcess, { allowFailedStart: record.phase === 'starting' });
      else await ops.assertRunning(record.startedProcess);
      await closedProof(record);
      if (record.phase === 'starting') record = await ops.journal.phase('stopped', { explicitFailedStartRecovery: true });
    } else {
      if (old && old.phase !== 'complete') throw new Error('Unfinished journal requires explicit recover');
      const originalProcess = await ops.assertRunning();
      const initialState = await ops.state(); const initial = stateProof(initialState, ops.now(), { allowActive: true });
      const before = dashboard(await ops.dashboard()); assertDashboardState(before, initialState, ops.now());
      record = await ops.journal.begin({ contract, originalProcess, initial }); check();
      record = await ops.journal.phase('closing'); check();
      await ops.setAdmission(false); record = await ops.journal.phase('draining');
      let drained = false;
      for (let i = 0; i < maxPolls; i++) {
        check(); const d = dashboard(await ops.dashboard(), false); closedConfirmed = true;
        if (d.stats.queued === 0 && d.stats.running === 0) {
          const state = await ops.state(); const baseline = stateProof(state, ops.now()); assertDashboardState(d, state, ops.now());
          if (baseline.settings !== initial.settings || baseline.security !== initial.security) throw new Error('Policy/security changed during drain');
          record = await ops.journal.phase('drained', { baseline, dashboard: dashboardProof(d) }); drained = true; break;
        }
        if (i + 1 < maxPolls) await ops.sleep();
      }
      if (!drained) throw new Error('Bounded drain exhausted; no stop attempted');
    }
    if (record.phase === 'drained') {
      check(); await sameContract(record); await ops.assertRunning(record.originalProcess); await closedProof(record);
      const d = dashboard(await ops.dashboard(), false); if (dashboardProof(d) !== record.dashboard) throw new Error('Dashboard changed before stop');
      record = await ops.journal.phase('stopping'); check(); stopAttempted = true; await ops.stop();
    }
    if (record.phase === 'stopping' || record.phase === 'stopped') {
      check(); await ops.assertStopped(record.originalProcess, { allowFailedStart: record.explicitFailedStartRecovery === true }); const stopped = await closedProof(record); await sameContract(record);
      record = await ops.journal.phase('stopped', { stopped });
      await ops.preflight(); check(); await sameContract(record); await ops.assertStopped(record.originalProcess, { allowFailedStart: record.explicitFailedStartRecovery === true }); await closedProof(record);
      if (record.startAttempts !== 0 && !recover) throw new Error('Start already attempted; explicit recovery required');
      record = await ops.journal.phase('starting', { startAttempts: record.startAttempts + 1 }); check();
      await ops.start();
      const startedProcess = await ops.assertRunning();
      if (startedProcess.identity === record.originalProcess.identity) throw new Error('Original publisher still live');
      record = await ops.journal.phase('started', { startedProcess });
    }
    if (record.phase === 'started' || record.phase === 'restoring') {
      check(); await sameContract(record); await ops.assertRunning(record.startedProcess);
      await ops.health(); check(); const state = await ops.state(); const proof = stateProof(state, ops.now());
      assertPreserved(record.baseline, proof, ops.now());
      const d = dashboard(await ops.dashboard(), false); assertDashboardState(d, state, ops.now());
      if (dashboardProof(d) !== record.dashboard) throw new Error('Authenticated dashboard changed after start');
      record = await ops.journal.phase('restoring', { verified: proof }); check();
      await ops.setAdmission(record.originalAdmission);
      const restored = dashboard(await ops.dashboard(), record.originalAdmission); const finalState = await ops.state();
      assertDashboardState(restored, finalState, ops.now()); const final = stateProof(finalState, ops.now());
      assertPreserved(record.baseline, final, ops.now(), { admission: record.originalAdmission });
      await ops.assertRunning(record.startedProcess); await sameContract(record);
      record = await ops.journal.phase('complete', { final });
    }
    return { runId: record.runId, phase: record.phase, originalAdmission: record.originalAdmission, startAttempts: record.startAttempts };
  } catch (error) {
    // Routine busy drains must not strand admission. Never use this path after
    // a stop intent, controller interruption, uncertain HTTP mutation or recovery.
    if (!recover && record && closedConfirmed && !stopAttempted && ['draining', 'drained'].includes(record.phase) && !shouldAbort()) {
      try {
        await restoreBeforeStop('aborted_before_stop');
      } catch { /* Uncertain health, admission or policy remains for explicit reconciliation. */ }
    }
    throw error;
  } finally { if (held) await ops.release(); }
}

export function parseRestartArguments(args) {
  if (args.length === 0 || args.length === 1 && args[0] === '--inspect') return { inspect: true };
  if (args.length === 1 && args[0] === '--authorise-controlled-restart') return { authorised: true };
  if (args.length === 2 && new Set(args).size === 2 && args.includes('--recover') && args.includes('--authorise-controlled-restart')) return { recover: true, authorised: true };
  throw new Error('Use --inspect OR [--recover] --authorise-controlled-restart');
}
async function main() {
  const args = parseRestartArguments(process.argv.slice(2));
  const { createLinuxRestartOperations } = await import('./restart-linux.mjs');
  const operations = await createLinuxRestartOperations();
  let interrupted = false;
  process.on('SIGINT', () => { interrupted = true; }); process.on('SIGTERM', () => { interrupted = true; });
  console.log(JSON.stringify(await coordinatedRestart({ operations, ...args, shouldAbort: () => interrupted })));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  console.error('Controlled restart refused or failed; inspect private maintenance journal and reconcile manually. No automatic retry or recovery claimed.'); process.exitCode = 1;
});
