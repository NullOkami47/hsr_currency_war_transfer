import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { notifyGcpBackupFailure } from '../scripts/infrastructure/gcp-backup-failure-notify.mjs';
import {
  GCP_ARCHIVE_PREFIX,
  GCP_EVENT_PREFIX,
  GCS_BUCKET,
  PINNED_CONFIG_PATH,
  PINNED_SERVICE,
  createGcpNativeBackupClient,
  parseGcpBackupArguments,
  resendGcpBackupPair,
  runGcpScheduledBackup,
  validateGcpNativeBackupConfig,
} from '../scripts/infrastructure/gcp-native-backup.mjs';
import { createStateBackup } from '../scripts/infrastructure/worker-state-backup.mjs';

const key = generateKeyPairSync('rsa', { modulusLength: 3072 }).publicKey.export({ type: 'spki', format: 'pem' });
const hash = value => createHash('sha256').update(value).digest('hex');

const baseConfig = spool => ({
  service: PINNED_SERVICE,
  endpoint: 'http://127.0.0.1:8787/',
  environmentFile: '/etc/hsr-gcp-production/worker.env',
  paths: {
    transfers: '/var/lib/hsr-transfer-worker-production/transfers.json',
    jobs: '/var/lib/hsr-transfer-worker-production/jobs.json',
    security: '/var/lib/hsr-transfer-worker-production/jobs.json.security.json',
  },
  publicKeyPath: '/etc/hsr-gcp-production/recipient-public.pem',
  backupDirectory: spool,
  gcs: {
    enabled: true,
    bucket: GCS_BUCKET,
    archivePrefix: GCP_ARCHIVE_PREFIX,
    eventPrefix: GCP_EVENT_PREFIX,
  },
  azureSecondary: { enabled: false },
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hsr-gcp-native-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { transfers: join(root, 'transfers.json'), jobs: join(root, 'jobs.json') };
  paths.security = paths.jobs + '.security.json';
  await writeFile(paths.transfers, JSON.stringify({ version: 1, transfers: {} }));
  await writeFile(paths.jobs, JSON.stringify({ version: 4, settings: {}, jobs: {}, quota: { events: [], blockedUntil: 0 } }));
  await writeFile(paths.security, JSON.stringify({ version: 1, requests: {}, sessions: {} }));
  const backup = await createStateBackup({
    paths,
    publicKey: key,
    assertQuiescent: async () => {},
    now: () => new Date('2026-11-13T18:00:00.000Z'),
  });
  const spool = join(root, 'spool');
  await mkdir(spool, { mode: 0o700 });
  const stem = join(spool, 'hsr-state-2026-11-13T18-00-00-000Z');
  await writeFile(stem + '.enc.json', backup.encrypted, { mode: 0o600 });
  await writeFile(stem + '.receipt.json', JSON.stringify(backup.receipt) + '\n', { mode: 0o600 });
  return {
    root,
    config: baseConfig(spool),
    snapshot: { ...backup.receipt, file: stem + '.enc.json', receiptFile: stem + '.receipt.json' },
  };
}

function store({ intercept } = {}) {
  const objects = new Map();
  const requests = [];
  const request = async (url, options = {}) => {
    requests.push({ url, ...options });
    const override = await intercept?.(url, options, requests.length);
    if (override) return override;
    const u = new URL(url);
    if (u.hostname === 'metadata.google.internal') {
      assert.equal(u.pathname, '/computeMetadata/v1/instance/service-accounts/default/token');
      assert.equal(options.headers['Metadata-Flavor'], 'Google');
      return {
        status: 200,
        body: Buffer.from(JSON.stringify({ access_token: 'synthetic-gce-token', token_type: 'Bearer', expires_in: 3599 })),
      };
    }
    assert.notEqual(u.hostname, '169.254.169.254');
    assert.notEqual(u.hostname, 'sts.googleapis.com');
    assert.equal(u.hostname, 'storage.googleapis.com');
    assert.equal(options.headers.authorization, 'Bearer synthetic-gce-token');
    if (options.method === 'POST') {
      assert.equal(u.pathname, `/upload/storage/v1/b/${GCS_BUCKET}/o`);
      assert.equal(u.searchParams.get('uploadType'), 'media');
      assert.equal(u.searchParams.get('ifGenerationMatch'), '0');
      const name = u.searchParams.get('name');
      if (objects.has(name)) return { status: 412, body: Buffer.alloc(0) };
      objects.set(name, Buffer.from(options.body));
      return { status: 200, body: Buffer.from('{}') };
    }
    assert.equal(options.method, 'GET');
    assert.equal(u.searchParams.get('alt'), 'media');
    const name = decodeURIComponent(u.pathname.slice(`/storage/v1/b/${GCS_BUCKET}/o/`.length));
    return { status: objects.has(name) ? 200 : 404, body: objects.get(name) ?? Buffer.alloc(0) };
  };
  return { objects, requests, request };
}

test('validateGcpNativeBackupConfig accepts pinned GCP config and rejects secrets or foreign destinations', () => {
  const validated = validateGcpNativeBackupConfig(baseConfig('/var/lib/hsr-worker-backups-gcp-production'));
  assert.equal(validated.gcs.archivePrefix, GCP_ARCHIVE_PREFIX);
  assert.equal(validated.azureSecondary.enabled, false);

  for (const patch of [
    { service: 'hsr-transfer-worker.service' },
    { endpoint: 'http://0.0.0.0:8787/' },
    { environmentFile: '/etc/hsr-transfer-worker.env' },
    { publicKeyPath: '/etc/hsr-backup/private.pem' },
    { backupDirectory: 'relative/spool' },
    { gcs: { enabled: false } },
    { gcs: { enabled: true, bucket: 'foreign-bucket' } },
    { gcs: { enabled: true, archivePrefix: 'hsr-state/' } },
    { gcs: { enabled: true, eventPrefix: 'monitor/events/' } },
    { gcs: { enabled: true, keyFile: '/secret.json' } },
    { azureSecondary: { enabled: false, sasToken: 'SECRET' } },
    { privateKey: 'SECRET' },
  ]) {
    assert.throws(
      () => validateGcpNativeBackupConfig({ ...baseConfig('/var/lib/hsr-worker-backups-gcp-production'), ...patch }),
      { code: 'GCP_BACKUP_CONFIG' },
    );
  }
  assert.deepEqual(parseGcpBackupArguments([PINNED_CONFIG_PATH]), { configPath: PINNED_CONFIG_PATH, mode: 'scheduled' });
  assert.throws(() => parseGcpBackupArguments(['/etc/hsr-backup/backup.json']), { code: 'GCP_BACKUP_ARGUMENTS' });
});

test('client authenticates via GCE metadata without Azure IMDS/STS and performs immutable upload + readback under gcp-production/', async t => {
  const f = await fixture(t);
  const s = store();
  const client = createGcpNativeBackupClient({ config: f.config, request: s.request });
  const result = await client.deliver(f.snapshot);

  assert.equal(result.transportVerified, true);
  assert.equal(result.restoreVerified, false);
  assert.equal(result.objectPrefix, GCP_ARCHIVE_PREFIX);
  assert.equal(s.requests.filter(r => new URL(r.url).hostname === 'metadata.google.internal').length, 1);
  assert.equal(s.requests.some(r => ['169.254.169.254', 'sts.googleapis.com'].includes(new URL(r.url).hostname)), false);
  assert.equal(s.objects.size, 2);
  const archiveName = GCP_ARCHIVE_PREFIX + f.snapshot.file.split(/[\\/]/).at(-1);
  assert.deepEqual(s.objects.get(archiveName), await readFile(f.snapshot.file));

  // Idempotent 412 readback without overwrite or delete.
  assert.equal((await client.deliver(f.snapshot)).transportVerified, true);
  assert.equal(s.requests.some(r => ['PUT', 'DELETE', 'PATCH'].includes(r.method)), false);
});

test('collision and corrupted readback fail closed without overwrite or delete', async t => {
  const f = await fixture(t);
  const archiveName = GCP_ARCHIVE_PREFIX + f.snapshot.file.split(/[\\/]/).at(-1);
  const sCollision = store();
  sCollision.objects.set(archiveName, Buffer.from('foreign-archive'));
  await assert.rejects(
    createGcpNativeBackupClient({ config: f.config, request: sCollision.request }).deliver(f.snapshot),
    { code: 'GCP_BACKUP_CHECKSUM' },
  );
  assert.equal(sCollision.objects.get(archiveName).toString(), 'foreign-archive');

  const sCorrupt = store({
    intercept: (url, o) => {
      const name = decodeURIComponent(new URL(url).pathname.split('/o/')[1] ?? '');
      if (o.method === 'GET' && name.endsWith('.receipt.json') && sCorrupt.objects.has(name)) {
        return { status: 200, body: Buffer.from('corrupted') };
      }
    },
  });
  await assert.rejects(
    createGcpNativeBackupClient({ config: f.config, request: sCorrupt.request }).deliver(f.snapshot),
    { code: 'GCP_BACKUP_CHECKSUM' },
  );
});

test('tampered local pair rejects before requesting GCE metadata token', async t => {
  const f = await fixture(t);
  const s = store();
  await writeFile(f.snapshot.file, '{"privateKey":"plaintext"}');
  await assert.rejects(createGcpNativeBackupClient({ config: f.config, request: s.request }).deliver(f.snapshot));
  assert.equal(s.requests.length, 0);
});

test('recordStatus writes source:gcp event under gcp-production/monitor/events/ and strips secrets', async t => {
  const f = await fixture(t);
  const s = store();
  const client = createGcpNativeBackupClient({ config: f.config, request: s.request });
  const recorded = await client.recordStatus({
    result: 'failure',
    stage: 'delivery',
    mode: 'scheduled',
    perDest: { azure: { status: 'skipped', secret: 'SECRET_AZ' }, gcs: { status: 'failure' } },
    snapshot: {
      runStatus: 'SECRET_STATUS',
      workerHealth: 'confirmed',
      admission: false,
      journal: { phase: 'stopping', originalAdmission: true, secret: 'SECRET_J' },
      privateKey: 'SECRET_PK',
    },
    error: new Error('SECRET_ERR'),
  });
  assert.equal(recorded.status, 'success');
  assert.match(recorded.object, /^gcp-production\/monitor\/events\/\d{4}-.*[a-f0-9-]{36}\.json$/);
  const payload = JSON.parse(s.objects.get(recorded.object).toString('utf8'));
  assert.equal(payload.source, 'gcp');
  assert.equal(payload.result, 'failure');
  assert.equal(payload.perDest.azure.status, 'skipped');
  assert.equal(payload.perDest.gcs.status, 'failure');
  assert.doesNotMatch(s.objects.get(recorded.object).toString('utf8'), /SECRET_/);
});

test('runGcpScheduledBackup and resendGcpBackupPair deliver to GCS, skip unconfigured Azure secondary, and record event', async t => {
  const f = await fixture(t);
  const s = store();
  let recoveredCalls = 0;
  const scheduled = await runGcpScheduledBackup({
    config: f.config,
    request: s.request,
    readMonitor: async () => ({ admission: false, journal: { phase: 'complete', originalAdmission: false } }),
    onRecovered: async () => { recoveredCalls += 1; },
    runCoordinator: async () => ({ offVmDeliveryVerified: false, localSnapshot: f.snapshot }),
  });
  assert.equal(recoveredCalls, 1);
  assert.equal(scheduled.perDest.gcs.status, 'success');
  assert.equal(scheduled.perDest.azure.status, 'skipped');
  assert.match(scheduled.statusEvent.object, /^gcp-production\/monitor\/events\//);

  const resent = await resendGcpBackupPair({
    config: f.config,
    file: f.snapshot.file,
    receiptFile: f.snapshot.receiptFile,
    request: s.request,
    readMonitor: async () => ({}),
  });
  assert.equal(resent.mode, 'resend');
  assert.equal(resent.perDest.gcs.transportVerified, true);
  assert.equal(s.objects.size, 4); // archive, receipt, scheduled event, resend event
});

test('runGcpScheduledBackup fails closed and exports failure status when GCS upload fails or secondary is enabled without adapter', async t => {
  const f = await fixture(t);
  await assert.rejects(
    runGcpScheduledBackup({
      config: { ...f.config, azureSecondary: { enabled: true } },
      runCoordinator: async () => { throw new Error('must not pause worker'); },
    }),
    { code: 'GCP_BACKUP_SECONDARY_UNAVAILABLE' },
  );

  const s = store({
    intercept: (url, o) => {
      if (o.method === 'POST' && new URL(url).searchParams.get('name')?.startsWith(GCP_ARCHIVE_PREFIX)) {
        return { status: 503, body: Buffer.from('unavailable') };
      }
    },
  });
  await assert.rejects(
    runGcpScheduledBackup({
      config: f.config,
      request: s.request,
      readMonitor: async () => ({ journal: { phase: 'complete', originalAdmission: true } }),
      runCoordinator: async () => ({ offVmDeliveryVerified: false, localSnapshot: f.snapshot }),
    }),
    error => error.code === 'BACKUP_RUN_FAILED'
      && error.perDest.gcs.status === 'failure'
      && error.perDest.azure.status === 'skipped'
      && error.statusEvent.status === 'success',
  );
  assert.equal([...s.objects.keys()].some(name => name.startsWith(GCP_EVENT_PREFIX)), true);
});

test('notifyGcpBackupFailure reads local journal safely and never marks skipped destinations as verified', async () => {
  let captured;
  await notifyGcpBackupFailure({
    config: { service: PINNED_SERVICE },
    readMonitor: async input => {
      assert.equal(input.recovered, false);
      assert.equal(input.service, PINNED_SERVICE);
      return { journal: { phase: 'stopping', originalAdmission: true } };
    },
    recordStatus: async event => {
      captured = event;
      return { status: 'success' };
    },
  });
  assert.equal(captured.result, 'failure');
  assert.equal(captured.perDest.azure.status, 'skipped');
  assert.equal(captured.perDest.gcs.status, 'skipped');
  assert.equal(captured.perDest.azure.transportVerified, false);
  assert.equal(captured.perDest.gcs.transportVerified, false);
  assert.equal(captured.snapshot.journal.phase, 'stopping');
});
