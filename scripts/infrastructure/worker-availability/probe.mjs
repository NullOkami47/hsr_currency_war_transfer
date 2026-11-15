import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';

export const SERVICE = 'hsr-worker-production.service';
const PROPERTIES = 'Id,LoadState,ActiveState,SubState,MainPID,Result,ExecMainStartTimestampMonotonic,NRestarts,ControlGroup';
const CONTROL_GROUP = '/system.slice/hsr-worker-production.service';
const WINDOW_US = 600000000n;
const sensorFailure = () => new Error('Availability sensor failed');

async function readProcFile(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(16385);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (!bytesRead || bytesRead > 16384) throw sensorFailure();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
  } finally { await file.close(); }
}

function processIdentity(text, pid) {
  if (typeof text !== 'string' || text.length > 16384 || !text.startsWith(`${pid} (`)) throw sensorFailure();
  const fields = text.slice(text.lastIndexOf(') ') + 2).trim().split(/\s+/);
  if (fields.length < 20 || !['R', 'S', 'D', 'I'].includes(fields[0]) || !/^[1-9]\d*$/.test(fields[19])) throw sensorFailure();
  return fields[19];
}

export async function readSystemd({ execute = promisify(execFile), readProc = readProcFile } = {}) {
  try {
    const result = await execute('/usr/bin/systemctl', ['--system', 'show', '--no-pager', '--no-ask-password',
      `--property=${PROPERTIES}`, SERVICE], {
      shell: false, timeout: 1500, maxBuffer: 4096, killSignal: 'SIGKILL', encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', SYSTEMD_PAGERSECURE: '1' },
    });
    if (typeof result.stdout !== 'string' || result.stdout.length > 4096 || result.stderr) throw sensorFailure();
    const fields = parseUnit(result.stdout, process.hrtime.bigint() / 1000n);
    if (!fields.healthy) throw sensorFailure();
    const pid = fields.pid;
    const before = processIdentity(await readProc(`/proc/${pid}/stat`), pid);
    const [status, cgroup] = await Promise.all([readProc(`/proc/${pid}/status`), readProc(`/proc/${pid}/cgroup`)]);
    if (typeof status !== 'string' || status.length > 16384 || typeof cgroup !== 'string' || cgroup.length > 16384
        || !new RegExp(`^Pid:\\s+${pid}$`, 'm').test(status) || !/^State:\s+[RSDI]\s/m.test(status)
        || !cgroup.trimEnd().split('\n').some(line => line === `0::${CONTROL_GROUP}`
          || /^\d+:name=systemd:/.test(line) && line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1) === CONTROL_GROUP)
        || processIdentity(await readProc(`/proc/${pid}/stat`), pid) !== before) throw sensorFailure();
    return result.stdout;
  } catch { throw sensorFailure(); }
}

// Existing /health is nonprivileged. Native HTTP ignores proxy environment,
// follows no redirects, and sends no credential to the fixed loopback path.
export function readWorkerHealth({ port = 8787, timeoutMs = 2000 } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2000) return Promise.resolve(false);
  return new Promise(resolve => {
    let finished = false;
    const finish = value => { if (!finished) { finished = true; resolve(value); } };
    const req = http.request({ hostname: '127.0.0.1', port, path: '/health', method: 'GET', agent: false,
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs), maxHeaderSize: 4096 }, res => {
      if (res.statusCode !== 200 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(res.headers['content-type'] ?? '')
          || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
        finish(false); res.destroy(); return;
      }
      let size = 0;
      const chunks = [];
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 4096) { finish(false); res.destroy(); req.destroy(); }
        else chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
          const value = JSON.parse(text);
          finish(value !== null && !Array.isArray(value) && typeof value === 'object'
            && Object.keys(value).length === 1 && value.status === 'ok'
            && /^\s*\{\s*"status"\s*:\s*"ok"\s*\}\s*$/.test(text));
        } catch { finish(false); }
      });
      res.on('error', () => finish(false));
      res.on('aborted', () => finish(false));
    });
    req.on('error', () => finish(false));
    req.end();
  });
}

function parseUnit(text, now) {
  if (typeof text !== 'string' || text.length > 4096) throw sensorFailure();
  const fields = Object.create(null);
  for (const line of text.trimEnd().split('\n')) {
    const match = /^([A-Za-z]+)=(.*)$/.exec(line);
    if (!match || !PROPERTIES.split(',').includes(match[1]) || Object.hasOwn(fields, match[1])) throw sensorFailure();
    fields[match[1]] = match[2];
  }
  if (Object.keys(fields).length !== 9 || fields.Id !== SERVICE || fields.LoadState !== 'loaded'
      || fields.ControlGroup !== CONTROL_GROUP
      || !/^\d{1,16}$/.test(fields.ExecMainStartTimestampMonotonic) || !/^\d{1,10}$/.test(fields.NRestarts)
      || !/^\d{1,10}$/.test(fields.MainPID)) throw sensorFailure();
  const start = BigInt(fields.ExecMainStartTimestampMonotonic);
  if (start <= 0n || start > now) throw sensorFailure();
  return { start, pid: fields.MainPID, restarts: Number(fields.NRestarts), healthy: fields.ActiveState === 'active'
    && fields.SubState === 'running' && Number(fields.MainPID) > 0 && fields.Result === 'success' };
}

export function createProbe({ readUnit = readSystemd, readHealth,
  nowUs = () => process.hrtime.bigint() / 1000n } = {}) {
  if (typeof readHealth !== 'function') throw sensorFailure();
  let pending, cached = false, expires = -1n, previous, starts = [], lastNow = -1n;
  return {
    check() {
      const now = nowUs();
      if (typeof now !== 'bigint' || now < lastNow) return Promise.resolve(false);
      lastNow = now;
      if (pending) return pending;
      if (now < expires) return Promise.resolve(cached);
      pending = (async () => {
        const [unit, health] = await Promise.allSettled([readUnit(), readHealth()]);
        try {
          if (unit.status !== 'fulfilled') throw sensorFailure();
          const current = parseUnit(unit.value, now);
          starts = starts.filter(start => now - start < WINDOW_US);
          if (!previous || current.start !== previous.start) {
            if (now - current.start < WINDOW_US) starts.push(current.start);
          }
          if (previous && current.restarts > previous.restarts) {
            // NRestarts also catches automatic starts between polls. Unknown
            // intermediate times are conservatively retained for ten minutes.
            const alreadyCounted = current.start !== previous.start ? 1 : 0;
            for (let i = alreadyCounted; i < Math.min(3, current.restarts - previous.restarts); i++) starts.push(now);
          }
          previous = current;
          starts = starts.slice(-3);
          return current.healthy && starts.length < 3 && health.status === 'fulfilled' && health.value === true;
        } catch { return false; }
      })().catch(() => false).then(value => {
        cached = value;
        // Cache age begins when sampling starts, not after a slow response.
        expires = now + 5000000n;
        return value;
      }).finally(() => { pending = undefined; });
      return pending;
    },
  };
}
