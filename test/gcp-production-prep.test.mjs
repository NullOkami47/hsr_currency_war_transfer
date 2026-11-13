import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, lstat, rm, writeFile, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { BrowserSessionPublisher } from '../src/publisher.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = join(root, 'scripts/infrastructure/gcp-production-prep.mjs');
const examplePath = join(root, 'scripts/infrastructure/gcp-production/preparation.example.json');
const config = () => ({
  version: 1, mode: 'offline-preparation', hostname: 'worker.example.invalid',
  stateDirectory: '/var/lib/hsr-transfer-worker-production',
  profileDirectory: '/var/lib/hsr-transfer-worker-staging/login/gcp-readonly-profile-login-20261112',
  futureStaticIpv4: null, staticIpv4ApprovalReference: null,
});
// Generator outputs stay on this D-drive checkout. The POSIX-only FIFO test
// needs a native filesystem (the local WSL ext4 VHDX is also on D:).
async function temporary(t) {
  const parent = join(root, 'var');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'gcp-production-prep-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function implementation() {
  const module = await import('../scripts/infrastructure/gcp-production-prep.mjs');
  assert.equal(typeof module.validatePreparationConfig, 'function');
  return module;
}

test('offline preparation implementation exists without an activation entry point', async () => {
  const source = await readFile(script, 'utf8');
  assert.doesNotMatch(source, /from ['"]node:(?:child_process|https?|net|dns|tls)['"]|\bfetch\s*\(/);
  const api = await implementation();
  assert.deepEqual(Object.keys(api).sort(), [
    'buildPreparationBundle', 'parsePreparationArguments', 'validatePreparationConfig', 'writePreparationBundle',
  ]);
});

test('example is secret-free and validated; plan remains blocked and preserves exact guards', async () => {
  const api = await implementation();
  const example = JSON.parse(await readFile(examplePath, 'utf8'));
  assert.deepEqual(example, config());
  assert.doesNotThrow(() => api.validatePreparationConfig(example));
  const { files, plan } = await api.buildPreparationBundle(example);
  assert.equal(plan.phase, 'OFFLINE_PREPARED_ACTIVATION_BLOCKED');
  assert.equal(plan.source.commit, 'ca657a47809e1b78aa278a13d71600ce5fd8614a');
  assert.equal(plan.target.instanceId, '4111188809525812699');
  assert.equal(plan.target.diskId, '9008789074271067611');
  assert.equal(plan.target.machineType, 'e2-micro');
  assert.deepEqual(plan.providerStop, { maxRunSeconds: 3600, terminationAction: 'STOP', automaticRestart: false });
  for (const key of ['activated', 'cloudCommandsExecuted', 'httpsVerified', 'backupEnabled', 'restoreVerified', 'productionEnvironmentChanged']) {
    assert.equal(plan[key], false, key);
  }
  assert.equal(plan.currentStateOwner, 'azure');
  assert.equal(plan.blockers.length, 9);
  assert.ok(!plan.blockers.includes('GCP_TO_AZURE_SECONDARY_NOT_IMPLEMENTED'));
  assert.ok(!plan.blockers.includes('GCP_NATIVE_BACKUP_ADAPTER_NOT_IMPLEMENTED'));
  assert.ok(!plan.blockers.includes('OWNER_SCOPED_MONITOR_NOT_IMPLEMENTED'));
  assert.ok(!plan.blockers.includes('PROFILE_OWNER_PREFLIGHT_NOT_IMPLEMENTED'));
  assert.ok(!plan.blockers.includes('PRODUCTION_CHROMIUM_SANDBOX_NOT_EXPLICIT'));
  assert.ok(plan.blockers.includes('FUTURE_EXPLICIT_GO_REQUIRED'));
  assert.ok(plan.blockers.includes('STATIC_IPV4_APPROVAL_AND_READBACK_REQUIRED'));
  assert.ok(plan.blockers.includes('LINUX_SANDBOX_AND_RESOURCE_ACCEPTANCE_REQUIRED'));
  assert.match(files['worker.env.template'], /CURRENCY_WAR_WORKER_TOKEN=\n/);
  assert.match(files['worker.env.template'], /CURRENCY_WAR_CHROMIUM_SANDBOX=1/);
  assert.match(files['worker.env.template'], /CURRENCY_WAR_PUBLIC_SUBMISSIONS=0/);
  assert.match(files['worker.env.template'], /CURRENCY_WAR_PROFILE_DIR=\/var\/lib\/hsr-transfer-worker-staging\/login\/gcp-readonly-profile-login-20261112/);
  assert.doesNotMatch(JSON.stringify(files), /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/);
});

test('invalid hostname and configuration injection are rejected before rendering', async () => {
  const api = await implementation();
  for (const hostname of ['', 'localhost', '127.0.0.1', 'https://worker.example.com', 'worker.example.com:443',
    '*.example.com', 'worker.example.com/path', 'user@worker.example.com', 'bad_name.example.com',
    'bad..example.com', '-bad.example.com', 'Bad.example.com', 'bad.example.com.', 'worker.example.com\n{',
    '{$HOST}', `${'a'.repeat(64)}.example.com`, 'wörker.example.com']) {
    assert.throws(() => api.validatePreparationConfig({ ...config(), hostname }), { code: 'PREP_CONFIG' }, hostname);
  }
});

test('state/profile path secrets, traversal, staging state and alternate sources are rejected', async () => {
  const api = await implementation();
  for (const stateDirectory of ['/etc/secret', '/var/lib/hsr-transfer-worker', '/var/lib/hsr-transfer-worker-staging/state',
    'D:/secrets', '/var/lib/hsr-transfer-worker-production/../secrets', '/var/lib/hsr-transfer-worker-production\nTOKEN=secret']) {
    assert.throws(() => api.validatePreparationConfig({ ...config(), stateDirectory }), { code: 'PREP_CONFIG' });
  }
  for (const profileDirectory of ['/home/user/.config/google-chrome', '/var/lib/hsr-transfer-worker-production/browser-profile',
    `${config().profileDirectory}/../other`, 'C:/cookies']) {
    assert.throws(() => api.validatePreparationConfig({ ...config(), profileDirectory }), { code: 'PREP_CONFIG' });
  }
  for (const patch of [{ token: 'SECRET_CANARY' }, { privateKey: 'SECRET_CANARY' }, { env: { password: 'SECRET_CANARY' } },
    { statePaths: { secrets: 'SECRET_CANARY' } }, { credentials: 'SECRET_CANARY' }, { mode: 'production' }]) {
    assert.throws(() => api.validatePreparationConfig({ ...config(), ...patch }), error =>
      error.code === 'PREP_CONFIG' && !error.message.includes('SECRET_CANARY'));
  }
});

test('production autorun and STOP-removal configuration and CLI flags are rejected', async () => {
  const api = await implementation();
  for (const patch of [{ activate: true }, { autorun: true }, { productionAutorun: false }, { enable: false },
    { removeStop: true }, { maxRunSeconds: 0 }, { execute: true }, { apply: true }, { currentStateOwner: 'gcp' }]) {
    assert.throws(() => api.validatePreparationConfig({ ...config(), ...patch }), { code: 'PREP_CONFIG' });
  }
  for (const args of [['activate', 'config.json'], ['generate', 'config.json', 'out', '--enable'],
    ['validate', 'config.json', '--remove-stop'], ['generate', '--apply', 'out'], ['start'], ['generate']]) {
    assert.throws(() => api.parsePreparationArguments(args), { code: 'PREP_ARGUMENTS' });
  }
  assert.deepEqual(api.parsePreparationArguments(['validate', 'config.json']), { command: 'validate', configPath: 'config.json' });
});

test('future static address is a proposal, never an approval or provider mutation', async () => {
  const api = await implementation();
  for (const futureStaticIpv4 of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '0.0.0.0', '1.2.3.999', '01.2.3.4', '224.1.2.3']) {
    assert.throws(() => api.validatePreparationConfig({ ...config(), futureStaticIpv4, staticIpv4ApprovalReference: 'review-1' }));
  }
  assert.throws(() => api.validatePreparationConfig({ ...config(), futureStaticIpv4: '34.1.2.3' }));
  const { plan } = await api.buildPreparationBundle({ ...config(), hostname: 'worker.example.com',
    futureStaticIpv4: '34.1.2.3', staticIpv4ApprovalReference: 'future-review-1' });
  assert.equal(plan.network.futureStaticIpv4, '34.1.2.3');
  assert.equal(plan.network.sameExistingNicOnly, true);
  assert.equal(plan.network.verified, false);
  assert.ok(plan.blockers.includes('STATIC_IPV4_APPROVAL_AND_READBACK_REQUIRED'));
});

test('rendered services fail closed with safe OnFailure, no install hooks or restart loops', async () => {
  const { files } = await (await implementation()).buildPreparationBundle(config());
  for (const name of ['hsr-worker-production.service.template', 'hsr-gcp-state-backup.service.template',
    'hsr-gcp-backup-notify.service.template', 'hsr-gcp-state-backup.timer.template']) {
    const contents = files[name];
    assert.match(contents, /ConditionPathExists=\/etc\/hsr-gcp-production\/EXPLICIT_GO/);
    assert.doesNotMatch(contents, /\[Install\]|WantedBy=|Restart=on-failure|SuccessExitStatus=/);
    assert.doesNotMatch(contents, /(?:systemctl|gcloud|az |vercel )(?:enable|start|deploy|set|update|delete)/);
  }
  const worker = files['hsr-worker-production.service.template'];
  assert.match(worker, /ExecStart=.*\/opt\/node-v24\.22\.3-linux-x64\/bin\/node /);
  assert.doesNotMatch(worker, /\/usr\/bin\/node/);
  assert.match(worker, /User=hsr-worker/);
  assert.match(worker, /NoNewPrivileges=true/);
  assert.match(worker, /ProtectSystem=strict/);
  assert.match(worker, /RuntimeMaxSec=3600/);
  assert.match(worker, /ExecStartPre=\/opt\/node-v24\.22\.3-linux-x64\/bin\/node \/opt\/hsr-transfer-worker-staging\/scripts\/infrastructure\/gcp-production-profile-preflight\.mjs \/etc\/hsr-gcp-production\/worker-preflight\.json/);
  assert.doesNotMatch(worker, /--no-sandbox|chmod|chown|rm -|\/usr\/bin\/false/);
  const backup = files['hsr-gcp-state-backup.service.template'];
  assert.match(backup, /OnFailure=hsr-gcp-backup-notify.service/);
  assert.match(backup, /ExecStart=\/usr\/bin\/flock --nonblock --conflict-exit-code 75 \/run\/hsr-worker-backup\.flock \/usr\/bin\/env HSR_BACKUP_FLOCK_HELD=1 \/opt\/node-v24\.22\.3-linux-x64\/bin\/node \/opt\/hsr-transfer-worker-staging\/scripts\/infrastructure\/gcp-native-backup\.mjs \/etc\/hsr-gcp-production\/backup\.json/);
  assert.doesNotMatch(backup, /\/usr\/bin\/false/);
  const notify = files['hsr-gcp-backup-notify.service.template'];
  assert.doesNotMatch(notify, /^OnFailure=/m);
  assert.match(notify, /ExecStart=\/opt\/node-v24\.22\.3-linux-x64\/bin\/node \/opt\/hsr-transfer-worker-staging\/scripts\/infrastructure\/gcp-backup-failure-notify\.mjs \/etc\/hsr-gcp-production\/backup\.json/);
  assert.doesNotMatch(notify, /\/usr\/bin\/false/);
  assert.match(notify, /TimeoutStartSec=45s/);
  assert.match(files['hsr-gcp-state-backup.timer.template'], /OnCalendar=\*-\*-\* 19:00:00 UTC/);
  assert.match(files['hsr-gcp-state-backup.timer.template'], /Persistent=true/);
});

test('HTTPS is stable-host Caddy auth to loopback only; secrets remain blank', async () => {
  const { files } = await (await implementation()).buildPreparationBundle(config());
  assert.match(files['Caddyfile.template'], /worker.example.invalid/);
  assert.match(files['Caddyfile.template'], /reverse_proxy 127.0.0.1:8787/);
  assert.match(files['Caddyfile.template'], /Authorization "Bearer \{\$HSR_GCP_WORKER_TOKEN\}"/);
  assert.match(files['Caddyfile.template'], /respond "Unauthorised" 401/);
  assert.doesNotMatch(files['Caddyfile.template'], /tls internal|tls_insecure_skip_verify|8788|0\.0\.0\.0/);
  assert.match(files['caddy.env.template'], /HSR_GCP_WORKER_TOKEN=\n/);
  assert.match(files['worker.env.template'], /CURRENCY_WAR_WORKER_HOST=127.0.0.1/);
});

test('backup and monitor contracts pin existing baseline and expose owner/authentication gaps', async () => {
  const { files } = await (await implementation()).buildPreparationBundle(config());
  const backup = JSON.parse(files['backup-contract.json']);
  assert.equal(backup.runtime.nodeBinary, '/opt/node-v24.22.3-linux-x64/bin/node');
  assert.equal(backup.runtime.usesAptNode, false);
  assert.equal(backup.implemented, true);
  assert.equal(backup.activationReady, false);
  assert.equal(backup.gcs.adapterNotImplemented, false);
  assert.equal(backup.entrypoint, 'scripts/infrastructure/gcp-native-backup.mjs');
  assert.equal(backup.failureNotifier, 'scripts/infrastructure/gcp-backup-failure-notify.mjs');
  assert.deepEqual(Object.keys(backup.snapshotConfig.paths).sort(), ['jobs', 'security', 'transfers']);
  assert.equal(backup.snapshotConfig.paths.security, backup.snapshotConfig.paths.jobs + '.security.json');
  assert.equal(backup.snapshotConfig.service, 'hsr-worker-production.service');
  assert.equal(backup.authentication.azureManagedIdentityUsableOnGcp, false);
  assert.equal(backup.authentication.futureVmServiceAccount.approved, false);
  assert.deepEqual(backup.authentication.futureVmServiceAccount.permissions, ['storage.objects.create', 'storage.objects.get']);
  assert.equal(backup.preserveAzureBlobBackups, true);
  assert.equal(backup.azureSecondary.decision, 'RETIRED_BY_OPTION_1B');
  assert.equal(backup.azureSecondary.requiredBeforeClaimingComplete, false);
  assert.equal(backup.retention.apply, false);
  assert.equal(backup.retention.baseline.sha256, 'ba6f02b0cc6c289352bdb215b47b09aa2cc0698af286a2a5674fdab868a4c803');
  assert.equal(backup.retention.baseline.recipient, '1b7198fa8f2009311bff67b8df7376f08809d07dc4ffb456076baf67467a56d8');
  assert.equal(backup.retention.baseline.bytes, null);
  assert.equal(backup.retention.baseline.restoreVerifiedAt, null);
  assert.equal(backup.retention.baseline.temporaryHoldMustRemain, true);
  const monitor = JSON.parse(files['monitor-readiness.json']);
  assert.equal(monitor.currentOwner.source, 'azure');
  assert.equal(monitor.currentOwner.liveVerified, false);
  assert.equal(monitor.ownerScopedReadiness, true);
  assert.equal(monitor.schedule.independentOfPc, true);
  assert.equal(monitor.schedule.independentOfWorkerVm, true);
  assert.equal(monitor.schedule.missedBackupHours, 26);
  assert.equal(monitor.schedule.heartbeatAbsenceHours, 2);
  assert.equal(monitor.notificationOwner.source, 'existing Cloud Monitoring owner notification channel; protected main runbook');
  assert.equal(monitor.notificationOwner.address, null);
});

test('bundle is deterministic and reports content hashes, never reads state or profile', async () => {
  const api = await implementation();
  const a = await api.buildPreparationBundle(config()), b = await api.buildPreparationBundle(config());
  assert.deepEqual(a, b);
  for (const contents of Object.values(a.files)) assert.doesNotMatch(contents, /\r/, 'Canonical LF output even on a CRLF checkout');
  assert.deepEqual(JSON.parse(a.files['preparation-plan.json']), a.plan);
  const manifest = JSON.parse(a.files['manifest.json']);
  assert.equal(manifest.activationReady, false);
  assert.equal(manifest.files.length, Object.keys(a.files).length - 1);
  for (const record of manifest.files) {
    assert.equal(record.sha256, createHash('sha256').update(a.files[record.name]).digest('hex'));
    assert.equal(record.bytes, Buffer.byteLength(a.files[record.name]));
  }
});

test('production publisher enforces chromiumSandbox:true while Linux runtime acceptance stays a blocker', async () => {
  let launchOptions;
  const publisher = new BrowserSessionPublisher({ profileDir: config().profileDirectory, logger: {},
    launchPersistentContext: async (_path, options) => {
      launchOptions = options;
      return { pages: () => [{ goto: async () => {} }], close: async () => {} };
    } });
  await publisher.start();
  await publisher.close();
  assert.equal(launchOptions.chromiumSandbox, true);
  const { plan, files } = await (await implementation()).buildPreparationBundle(config());
  assert.ok(!plan.blockers.includes('PRODUCTION_CHROMIUM_SANDBOX_NOT_EXPLICIT'));
  assert.ok(plan.blockers.includes('LINUX_SANDBOX_AND_RESOURCE_ACCEPTANCE_REQUIRED'));
  assert.equal(plan.worker.chromiumSandboxExplicit, true);
  assert.equal(plan.worker.chromiumSandboxVerified, false);
  const { validatePreflightConfig } = await import('../scripts/infrastructure/gcp-production-profile-preflight.mjs');
  const { validateGcpNativeBackupConfig } = await import('../scripts/infrastructure/gcp-native-backup.mjs');
  validatePreflightConfig(JSON.parse(files['worker-preflight.json']));
  validateGcpNativeBackupConfig(JSON.parse(files['backup.json']));
});

test('writer creates local files exclusively and refuses overwrite or unsafe paths', async t => {
  const directory = await temporary(t), api = await implementation();
  const outputDirectory = join(directory, 'bundle');
  const result = await api.writePreparationBundle({ config: config(), outputDirectory });
  assert.equal(result.activated, false);
  assert.ok((await readdir(outputDirectory)).includes('manifest.json'));
  const previous = await readFile(join(outputDirectory, 'manifest.json'), 'utf8');
  await assert.rejects(api.writePreparationBundle({ config: config(), outputDirectory }), { code: 'PREP_OUTPUT' });
  assert.equal(await readFile(join(outputDirectory, 'manifest.json'), 'utf8'), previous);
  for (const unsafe of ['C:/gcp-prep', '/', '.', '../outside', join(directory, '..', 'escape') + '/..']) {
    await assert.rejects(api.writePreparationBundle({ config: config(), outputDirectory: unsafe }), { code: 'PREP_OUTPUT' });
  }
  if (process.platform !== 'win32') assert.equal((await lstat(outputDirectory)).mode & 0o777, 0o700);
});

test('writer rejects symlinked parents without writing through them', async t => {
  const directory = await temporary(t), api = await implementation();
  const target = join(directory, 'real'), link = join(directory, 'link');
  await mkdir(target);
  try { await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host does not permit synthetic symlinks'); return; } throw error; }
  await assert.rejects(api.writePreparationBundle({ config: config(), outputDirectory: join(link, 'bundle') }), { code: 'PREP_OUTPUT' });
  assert.deepEqual(await readdir(target), []);
});

test('CLI validates and generates offline, and secret-bearing config fails without leaks', async t => {
  const directory = await temporary(t);
  const invoke = args => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', timeout: 10000 });
  const validation = invoke(['validate', examplePath]);
  assert.equal(validation.status, 0, validation.stderr);
  assert.equal(JSON.parse(validation.stdout).activated, false);
  assert.equal(JSON.parse(validation.stdout).decision, 'NO_GO');
  const generated = invoke(['generate', examplePath, join(directory, 'bundle')]);
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(JSON.parse(generated.stdout).cloudCommandsExecuted, false);
  assert.equal(JSON.parse(generated.stdout).activationReady, false);
  const badConfig = join(directory, 'secret-config.json');
  await writeFile(badConfig, JSON.stringify({ ...config(), privateKey: 'SECRET_CANARY_NEVER_PRINT' }));
  const rejected = invoke(['generate', badConfig, join(directory, 'rejected')]);
  assert.equal(rejected.status, 1);
  assert.doesNotMatch(rejected.stderr + rejected.stdout, /SECRET_CANARY_NEVER_PRINT/);
  assert.equal(invoke(['activate', examplePath]).status, 1);
  assert.deepEqual((await readdir(directory)).sort(), ['bundle', 'secret-config.json']);
});

test('CLI refuses a POSIX FIFO without waiting for a writer', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hsr-prep-fifo-'));
  try {
    const fifo = join(directory, 'config.fifo');
    const made = spawnSync('mkfifo', ['-m', '600', fifo], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const result = spawnSync(process.execPath, [script, 'validate', fifo], { encoding: 'utf8', timeout: 2000 });
    assert.equal(result.error, undefined, 'Unsafe input must reject before the external timeout');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PREP_CONFIG/);
    assert.doesNotMatch(result.stderr, /config\.fifo/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
