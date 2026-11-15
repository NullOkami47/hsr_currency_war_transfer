import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (object(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const fail = message => { throw new Error(message); };
const sameFile = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(k => a[k] === b[k]);

// No chmod, repair, missing-file defaults, shell evaluation or state writes.
export async function readRestartFile(path, { owner, maximum = 8 * 1024 * 1024, privateMode = true } = {}) {
  if (await realpath(dirname(path)) !== resolve(dirname(path))) fail('Symlinked state/configuration ancestor');
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum || before.size < 1
      || process.platform !== 'win32' && ((owner !== undefined && before.uid !== owner) || (before.mode & (privateMode ? 0o077 : 0o002)) || !privateMode && before.gid !== 0)) fail('Protected bounded regular file required');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK));
  try {
    if (!sameFile(before, await handle.stat())) fail('State changed during read');
    const buffer = Buffer.alloc(maximum + 1); let offset = 0;
    while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null); if (!bytesRead) break; offset += bytesRead; }
    if (offset !== before.size || offset > maximum || !sameFile(before, await handle.stat()) || !sameFile(before, await lstat(path))) fail('State changed during bounded read');
    try { return new TextDecoder('utf8', { fatal: true }).decode(buffer.subarray(0, offset)); } finally { buffer.fill(0); }
  } finally { await handle.close(); }
}
export async function readRestartState(paths, owner) {
  if (!object(paths) || Object.keys(paths).sort().join() !== 'jobs,security,transfers' || new Set(Object.values(paths).map(p => resolve(p))).size !== 3 || paths.security !== paths.jobs + '.security.json') fail('Exact three-state paths required');
  const result = {};
  for (const key of ['jobs', 'security', 'transfers']) result[key] = JSON.parse(await readRestartFile(paths[key], { owner }));
  return result;
}
export function stateProof(state, at = Date.now(), { allowActive = false } = {}) {
  const { jobs, transfers, security } = state;
  if (!object(jobs) || jobs.version !== 4 || !object(jobs.settings) || typeof jobs.settings.publicSubmissionsEnabled !== 'boolean'
      || !object(jobs.jobs) || !object(jobs.quota) || !Array.isArray(jobs.quota.events) || !Number.isFinite(jobs.quota.blockedUntil)
      || jobs.quota.events.length > 20000 || jobs.quota.events.some(e => !object(e) || !Number.isFinite(e.at) || typeof e.clientKey !== 'string')
      || !object(transfers) || transfers.version !== 1 || !object(transfers.transfers)
      || !object(security) || security.version !== 1 || !object(security.requests) || !object(security.sessions)) fail('Invalid durable jobs/security/mappings/quota state');
  let active = 0;
  for (const job of Object.values(jobs.jobs)) {
    if (!object(job) || !['queued', 'running', 'completed', 'failed'].includes(job.status)) fail('Ambiguous durable job');
    if (['queued', 'running'].includes(job.status)) { active++; if (!allowActive) fail('Active durable job requires drain'); }
  }
  for (const record of Object.values(transfers.transfers)) if (!object(record) || record.verificationPending !== undefined && typeof record.verificationPending !== 'boolean'
      || record.verificationPending === true && !allowActive) fail('Pending transfer verification requires manual reconciliation');
  const settings = { ...jobs.settings }; delete settings.publicSubmissionsEnabled;
  const jobsOther = { ...jobs }; delete jobsOther.settings; delete jobsOther.jobs; delete jobsOther.quota;
  const quotaOther = { ...jobs.quota }; delete quotaOther.events; delete quotaOther.blockedUntil;
  return { version: 1, at, admission: jobs.settings.publicSubmissionsEnabled, active, jobs: digest(jobs.jobs), jobSchema: digest(jobsOther),
    settings: digest(settings), transfers: digest(transfers), security: digest(security), quotaSchema: digest(quotaOther),
    blockedUntil: jobs.quota.blockedUntil, quota: jobs.quota.events.map(e => ({ at: e.at, hash: digest(e) })),
    counts: { jobs: Object.keys(jobs.jobs).length, mappings: Object.keys(transfers.transfers).length, sessions: Object.keys(security.sessions).length } };
}
export function assertPreserved(before, after, at = Date.now(), { admission = false } = {}) {
  if (before.admission !== false) fail('Closed baseline required');
  if (after.admission !== admission) fail('Admission changed; manual reconciliation required');
  for (const key of ['jobs', 'jobSchema', 'settings', 'transfers', 'security', 'quotaSchema', 'blockedUntil']) if (before[key] !== after[key]) fail('Durable state changed; preservation unverified');
  // Ordered multiset comparison preserves duplicate events and client identity.
  let index = 0;
  for (const entry of before.quota) {
    if (after.quota[index]?.hash === entry.hash && after.quota[index]?.at === entry.at) index++;
    else if (entry.at > at - 86400000) fail('Unexpired quota evidence changed');
  }
  if (index !== after.quota.length) fail('Quota evidence changed or added');
}

const PHASES = ['prepared', 'closing', 'draining', 'drained', 'aborting', 'stopping', 'stopped', 'starting', 'started', 'restoring', 'complete'];
async function directoryCheck(directory) {
  const st = await lstat(directory);
  if (!st.isDirectory() || st.isSymbolicLink() || await realpath(directory) !== resolve(directory)
      || process.platform !== 'win32' && (st.uid !== process.getuid() || st.mode & 0o077)) fail('Private maintenance directory required');
}
async function optionalRecord(directory, name) {
  await directoryCheck(directory);
  try { return JSON.parse(await readRestartFile(join(directory, name), { owner: process.getuid?.(), maximum: 64 * 1024 * 1024 })); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function createRestartJournal({ directory, service }) {
  let current;
  const validate = record => {
    if (!record || record.version !== 1 || record.service !== service || !PHASES.includes(record.phase)
        || typeof record.originalAdmission !== 'boolean' || !/^[a-zA-Z0-9-]{1,100}$/.test(record.runId) || !Number.isSafeInteger(record.startAttempts) || record.startAttempts < 0
        || !object(record.initial) || !Array.isArray(record.evidence) || typeof record.contract !== 'string') fail('Invalid maintenance journal; manual reconciliation required');
    if (record.originalAdmission !== record.initial.admission) fail('Original admission must match initial state');
    if (record.baseline !== undefined && (!object(record.baseline) || record.baseline.admission !== false)) fail('Closed baseline required');
    if (record.phase === 'restoring') {
      if (!object(record.verified) || record.verified.admission !== false || record.verified.active !== 0
          || !object(record.baseline) || !Number.isFinite(record.verified.at) || !record.startedProcess?.identity || record.startAttempts < 1) fail('Invalid verified restoring checkpoint');
      assertPreserved(record.baseline, record.verified, record.verified.at);
    }
    return record;
  };
  async function persist(next, exclusive = false) {
    await directoryCheck(directory);
    const serialised = JSON.stringify(next) + '\n';
    if (Buffer.byteLength(serialised) > 64 * 1024 * 1024) fail('Maintenance journal capacity requires manual archival');
    const target = join(directory, 'journal.json');
    if (!exclusive && digest(await optionalRecord(directory, 'journal.json')) !== digest(current)) fail('Maintenance journal changed');
    if (exclusive && await optionalRecord(directory, 'journal.json') !== null) fail('Existing journal must be archived explicitly');
    const temp = join(directory, `.restart-${randomUUID()}.tmp`); let file;
    try {
      file = await open(temp, 'wx', 0o600); await file.writeFile(serialised); await file.sync(); await file.close(); file = undefined;
      await rename(temp, target);
      if (process.platform !== 'win32') { const dir = await open(directory, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
      current = next;
    } finally { if (file) await file.close(); await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  return {
    async read() { const record = await optionalRecord(directory, 'journal.json'); current = record === null ? null : validate(record); return current && structuredClone(current); },
    async checkBackup(backupDirectory) {
      const record = await optionalRecord(backupDirectory, 'journal.json');
      if (!record || record.version !== 1 || record.service !== service || record.phase !== 'complete' || typeof record.originalAdmission !== 'boolean'
          || typeof record.runId !== 'string' || typeof record.updatedAt !== 'string') fail('Backup journal must be valid and complete under shared lock');
    },
    async begin(value) {
      if (!value?.initial || typeof value.initial.admission !== 'boolean'
          || value.originalAdmission !== undefined && value.originalAdmission !== value.initial.admission) fail('Original admission must match initial state');
      const previous = await this.read();
      if (previous && previous.phase !== 'complete') fail('Unfinished maintenance journal requires explicit recover');
      if (previous) {
        // Keep completed evidence immutable before starting another maintenance cycle.
        const archive = join(directory, `restart-${previous.runId}.complete.json`);
        const handle = await open(archive, 'wx', 0o600); try { await handle.writeFile(JSON.stringify(previous) + '\n'); await handle.sync(); } finally { await handle.close(); }
      }
      await persist({ version: 1, runId: randomUUID(), service, phase: 'prepared', originalAdmission: value.initial.admission,
        startAttempts: 0, ...value, evidence: [{ phase: 'prepared', at: Date.now(), proof: value.initial }] }, !previous);
      return structuredClone(current);
    },
    async phase(phase, patch = {}) {
      if (!current || !PHASES.includes(phase)) fail('Invalid restart checkpoint');
      if (patch.baseline && patch.baseline.admission !== false) fail('Closed baseline required');
      const next = { ...current, ...patch, phase, updatedAt: new Date().toISOString(), evidence: [...current.evidence, { phase, at: Date.now(), ...patch }] };
      validate(next); await persist(next); return structuredClone(next);
    },
  };
}
