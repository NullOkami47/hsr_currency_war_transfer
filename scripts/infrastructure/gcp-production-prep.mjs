import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Intentionally no network, subprocess, credential, state/profile read or activation API.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TEMPLATES = new URL('./gcp-production/', import.meta.url);
const SOURCE = 'ca657a47809e1b78aa278a13d71600ce5fd8614a';
const STATE = '/var/lib/hsr-transfer-worker-production';
const PROFILE = '/var/lib/hsr-transfer-worker-staging/login/gcp-readonly-profile-login-20261112';
const CONFIG_KEYS = ['version', 'mode', 'hostname', 'stateDirectory', 'profileDirectory',
  'futureStaticIpv4', 'staticIpv4ApprovalReference'];
const TEMPLATE_FILES = ['Caddyfile.template', 'caddy.env.template', 'worker.env.template',
  'hsr-worker-production.service.template', 'hsr-gcp-state-backup.service.template',
  'hsr-gcp-state-backup.timer.template', 'hsr-gcp-backup-notify.service.template',
  'backup-contract.json.template', 'monitor-readiness.json.template'];
const BLOCKERS = ['FUTURE_EXPLICIT_GO_REQUIRED', 'LIVE_IDENTITY_NETWORK_COST_READBACK_REQUIRED',
  'STATIC_IPV4_APPROVAL_AND_READBACK_REQUIRED', 'DNS_TLS_AUTH_LOOPBACK_ACCEPTANCE_REQUIRED',
  'AUTHORITATIVE_THREE_FILE_RESTORE_AND_SINGLE_WRITER_REQUIRED', 'PROFILE_OWNER_PREFLIGHT_NOT_IMPLEMENTED',
  'PRODUCTION_CHROMIUM_SANDBOX_NOT_EXPLICIT', 'LINUX_SANDBOX_AND_RESOURCE_ACCEPTANCE_REQUIRED',
  'GCP_NATIVE_BACKUP_ADAPTER_NOT_IMPLEMENTED',
  'GCP_SERVICE_ACCOUNT_AND_MINIMAL_IAM_APPROVAL_REQUIRED', 'OWNER_SCOPED_MONITOR_NOT_IMPLEMENTED',
  'GCP_TO_AZURE_SECONDARY_NOT_IMPLEMENTED', 'OFF_AZURE_CIPHER_RESTORE_AND_ALERT_ACCEPTANCE_REQUIRED',
  'PROTECTED_RETENTION_PIN_AND_OWNER_CHANNEL_READBACK_REQUIRED'];
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const json = value => JSON.stringify(value, null, 2) + '\n';
const sha256 = value => createHash('sha256').update(value).digest('hex');

function publicIpv4(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) return false;
  const [a, b, c, d] = value.split('.').map(Number);
  if ([a, b, c, d].some(n => n > 255)) return false;
  // Do not turn local, link-local, multicast, benchmark or documentation addresses into proposals.
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || b === 0 || (b === 2 && c === 0)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}

export function validatePreparationConfig(config) {
  const invalid = () => fail('PREP_CONFIG', 'Only the exact secret-free offline preparation schema is accepted.');
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(config))
    || Object.keys(config).sort().join() !== [...CONFIG_KEYS].sort().join()) invalid();
  if (config.version !== 1 || config.mode !== 'offline-preparation' || config.stateDirectory !== STATE
    || config.profileDirectory !== PROFILE) invalid();
  const host = config.hostname;
  if (typeof host !== 'string' || host.length > 253 || !host.includes('.')
    || host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || !/^[a-z][a-z0-9-]*$/.test(host.split('.').at(-1))) invalid();
  if (config.futureStaticIpv4 === null) {
    if (config.staticIpv4ApprovalReference !== null) invalid();
  } else if (!publicIpv4(config.futureStaticIpv4) || typeof config.staticIpv4ApprovalReference !== 'string'
    || !/^[a-z][a-z0-9._-]{0,95}$/.test(config.staticIpv4ApprovalReference)) invalid();
  // This validates syntax, NOT ownership, approval, DNS, static reservation or deployment readiness.
  return Object.freeze({ ...config });
}

export async function buildPreparationBundle(input) {
  const config = validatePreparationConfig(input), files = {};
  const replacements = { HOSTNAME: config.hostname, STATE_DIRECTORY: STATE, PROFILE_DIRECTORY: PROFILE };
  for (const name of TEMPLATE_FILES) {
    // Git on Windows may materialise CRLF: emitted Linux templates/hashes stay canonical LF.
    const template = (await readFile(new URL(name, TEMPLATES), 'utf8')).replace(/\r\n/g, '\n');
    const rendered = template.replace(/@@([A-Z_]+)@@/g, (_, key) => {
      if (!Object.hasOwn(replacements, key)) fail('PREP_TEMPLATE', 'Unrecognised preparation template field.');
      return replacements[key];
    });
    if (rendered.includes('@@')) fail('PREP_TEMPLATE', 'Unresolved preparation template field.');
    const output = name.endsWith('.json.template') ? name.slice(0, -9) : name;
    if (output.endsWith('.json')) JSON.parse(rendered);
    files[output] = rendered;
  }
  const plan = {
    version: 1, phase: 'OFFLINE_PREPARED_ACTIVATION_BLOCKED', decision: 'NO_GO',
    source: { repository: 'NullOkami47/hsr_currency_war_transfer', commit: SOURCE,
      evidence: ['docs/infrastructure/resilience-live-deployment.md', 'scripts/infrastructure/gcp-single-transfer.mjs',
        'scripts/infrastructure/gcs-backup.mjs', 'scripts/infrastructure/cloud-backup-monitor/server.mjs'],
      evidenceScope: 'repository snapshot only; not a current cloud readback' },
    target: { project: 'hsr-currency-war-worker', zone: 'us-central1-a', instance: 'hsr-worker-standby',
      instanceId: '4111188809525812699', diskId: '9008789074271067611', machineType: 'e2-micro',
      diskType: 'pd-standard', diskSizeGb: 20, autoDelete: false, liveVerified: false },
    providerStop: { maxRunSeconds: 3600, terminationAction: 'STOP', automaticRestart: false },
    network: { futureStaticIpv4: config.futureStaticIpv4, approvalReference: config.staticIpv4ApprovalReference,
      hostname: config.hostname, sameExistingNicOnly: true, existingNetworkReadback: null,
      existingSubnetworkReadback: null, verified: false, proxy: 'existing Caddy -> 127.0.0.1:8787',
      newLoadBalancer: false, newNat: false, newNetwork: false },
    worker: { service: 'hsr-worker-production.service', user: 'hsr-worker', stateDirectory: STATE,
      nodeBinary: '/opt/node-v24.22.3-linux-x64/bin/node',
      runtimeProvenance: 'main user-provided live review 2026-11-13; not independently read by this offline sidecar',
      profileDirectory: PROFILE, profileMigration: false, cookieMigration: false,
      profileReceipt: PROFILE + '/.readonly-vm.json', publicSubmissionsEnabled: false,
      automaticRestart: false, runtimeMaxSeconds: 3600, chromiumSandboxVerified: false,
      templatePreflight: 'always fails until separately implemented and reviewed' },
    currentStateOwner: 'azure', currentOwnerLiveVerified: false,
    activated: false, cloudCommandsExecuted: false, httpsVerified: false, backupEnabled: false,
    restoreVerified: false, productionEnvironmentChanged: false,
    azureShutdown: false, providerStopRemoved: false, privateRepositoryModified: false,
    blockers: [...BLOCKERS],
    sequence: ['review exact source/owner and protected pins offline',
      'implement/test native backup and owner-scoped monitor in a separately approved scope',
      'future explicit GO: verify immutable VM/disk/NIC/cost before any provider change',
      'approve static IPv4 and stable DNS on existing NIC/Caddy; validate authenticated HTTPS',
      'restore latest authoritative three-file state with source stopped and one writer; never migrate cookies',
      'prove native encrypted backup, external restore and failure/missed alerts with Azure/PC unavailable',
      'main private runbook gates Production routing and any later STOP change; this generator cannot do either'],
  };
  files['preparation-plan.json'] = json(plan);
  files['manifest.json'] = json({ version: 1, sourceCommit: SOURCE, activationReady: false,
    files: Object.keys(files).sort().map(name => ({ name, bytes: Buffer.byteLength(files[name]), sha256: sha256(files[name]) })) });
  return { files, plan };
}

async function safeAncestors(path) {
  let current = resolve(path);
  while (true) {
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('PREP_OUTPUT', 'A non-symlink existing local directory is required.');
    const actual = await realpath(current);
    if (process.platform === 'win32' ? actual.toLowerCase() !== current.toLowerCase() : actual !== current) {
      fail('PREP_OUTPUT', 'Redirected preparation directories are forbidden.');
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export async function writePreparationBundle({ config, outputDirectory }) {
  // Limit writes to an ignored new directory in THIS clone. Never /etc, state or a shared checkout.
  const base = join(ROOT, 'var');
  if (typeof outputDirectory !== 'string' || !isAbsolute(outputDirectory)
    || /[\x00-\x1f]/.test(outputDirectory) || outputDirectory.split(/[\\/]/).includes('..')) {
    fail('PREP_OUTPUT', 'An absolute new output directory under this checkout var directory is required.');
  }
  const target = resolve(outputDirectory), rel = relative(base, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || (process.platform === 'win32' && !/^D:[\\/]/i.test(target))) {
    fail('PREP_OUTPUT', 'Output must remain under this D-drive checkout var directory.');
  }
  const { files, plan } = await buildPreparationBundle(config);
  try {
    await safeAncestors(dirname(target));
    await mkdir(target, { mode: 0o700 }); // Exclusive, never recursive and never overwrite.
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(join(target, name), contents, { flag: 'wx', mode: 0o600 });
    }
  } catch {
    // Leave any partial new directory for inspection. Do not delete or silently reuse it.
    fail('PREP_OUTPUT', 'Offline output was refused or incomplete; use a new protected directory and inspect locally.');
  }
  return { phase: plan.phase, decision: 'NO_GO', activationReady: false,
    outputDirectory: target, fileCount: Object.keys(files).length,
    activated: false, cloudCommandsExecuted: false, backupEnabled: false };
}

export function parsePreparationArguments(args) {
  if (!Array.isArray(args) || !['validate', 'generate'].includes(args[0])
    || args.length !== (args[0] === 'validate' ? 2 : 3)
    || args.slice(1).some(value => typeof value !== 'string' || !value || value.startsWith('-'))) {
    fail('PREP_ARGUMENTS', 'Usage: validate <non-secret-config.json> OR generate <non-secret-config.json> <new-checkout-var-directory>.');
  }
  return { command: args[0], configPath: args[1], ...(args[0] === 'generate' ? { outputDirectory: args[2] } : {}) };
}

async function main() {
  const args = parsePreparationArguments(process.argv.slice(2));
  const path = resolve(args.configPath), before = await lstat(path);
  const unsafe = () => fail('PREP_CONFIG', 'A bounded regular non-secret configuration file is required.');
  if (!before.isFile() || before.isSymbolicLink() || before.size > 16384) unsafe();
  // Precheck plus nonblocking open prevents FIFOs/devices from hanging before
  // the handle can be verified. Read at most the limit + one growth byte.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK));
  let config;
  const buffer = Buffer.alloc(16385);
  try {
    const stat = await handle.stat();
    const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
      && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
    if (!stat.isFile() || !same(before, stat)) unsafe();
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await lstat(path);
    if (offset > 16384 || offset !== before.size || after.isSymbolicLink()
      || !same(before, after) || !same(before, await handle.stat())) unsafe();
    config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset)));
  } finally { buffer.fill(0); await handle.close(); }
  if (args.command === 'generate') console.log(json(await writePreparationBundle({ config, outputDirectory: args.outputDirectory })));
  else {
    const { plan } = await buildPreparationBundle(config);
    console.log(json({ phase: plan.phase, decision: 'NO_GO', schemaValid: true, activationReady: false, activated: false,
      cloudCommandsExecuted: false, backupEnabled: false, blockers: plan.blockers }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // Never emit supplied values, JSON parse errors, environment contents or upstream diagnostics.
    console.error(json({ code: ['PREP_CONFIG', 'PREP_ARGUMENTS', 'PREP_OUTPUT', 'PREP_TEMPLATE'].includes(error.code)
      ? error.code : 'PREP_FAILED', message: 'Offline preparation failed; no activation was attempted.' }));
    process.exitCode = 1;
  });
}
