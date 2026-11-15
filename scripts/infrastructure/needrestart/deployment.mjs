import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chown, lstat, mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export const SERVICE = 'hsr-worker-production.service';
export const DESTINATION = '/etc/needrestart/conf.d/99-hsr-worker-production.conf';
const STATE = '/var/lib/hsr-needrestart-deployment';
const CONFIG_DIR = '/etc/needrestart/conf.d';
const APT_DIR = '/etc/apt/apt.conf.d';
const componentDirectory = dirname(fileURLToPath(import.meta.url));
const fragmentPath = join(componentDirectory, '99-hsr-worker-production.conf');
const probePath = join(componentDirectory, 'selection.pl');
const fragmentText = "# Defer only this worker's needrestart restart to an approved maintenance window.\n"
  + "# Keep Ubuntu's existing service overrides and automatic security updates.\n"
  + '$nrconf{override_rc}->{qr(\\Ahsr-worker-production\\.service\\z)} = 0;\n';
export const FRAGMENT_SHA256 = hash(fragmentText);
const run = promisify(execFile);
const cleanEnvironment = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' };
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function equal(left, right) { return canonical(left) === canonical(right); }
function approvalRequired(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Explicit plan SHA256 approval is required.');
}

/** Fixed-path production controller. fixtureRoot requires a synthetic evaluator;
 * it never redirects the real Perl evaluator to a user-controlled config tree.
 * The CLI deliberately exposes neither fixtureRoot nor inspectSelection.
 */
export function createDeployment({ fixtureRoot, inspectSelection } = {}) {
  const fixture = fixtureRoot !== undefined;
  if (fixture && (!fixtureRoot || resolve(fixtureRoot) === resolve('/') || typeof inspectSelection !== 'function')) {
    throw new Error('An isolated fixture requires a synthetic selection evaluator.');
  }
  if (!fixture && inspectSelection) throw new Error('Production evaluator cannot be replaced.');
  const local = path => fixture ? join(resolve(fixtureRoot), path.replace(/^\//, '')) : path;

  async function trusted(path, { directory = false, optional = false } = {}) {
    const actual = local(path);
    let stat;
    try { stat = await lstat(actual); } catch (error) {
      if (optional && error.code === 'ENOENT') return null;
      throw error;
    }
    // Ubuntu ships /usr/bin/perl and perl5.38.2 as root-owned hardlinks.
    if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())
      || (!directory && path !== '/usr/bin/perl' && stat.nlink !== 1)) {
      throw new Error(`Expected trusted ${directory ? 'directory' : 'regular file'}, no symlinks/hardlinks: ${path}`);
    }
    if (!fixture) {
      if (stat.uid !== 0 || (stat.mode & 0o022)) throw new Error(`Root-owned, non-writable configuration required: ${path}`);
      for (let parent = dirname(actual); ; parent = dirname(parent)) {
        const ancestor = await lstat(parent);
        if (!ancestor.isDirectory() || ancestor.isSymbolicLink() || ancestor.uid !== 0 || (ancestor.mode & 0o022)) {
          throw new Error(`Untrusted path ancestor: ${parent}`);
        }
        if (parent === '/') break;
      }
    }
    return stat;
  }

  async function bytes(path, optional = false) {
    const stat = await trusted(path, { optional });
    if (!stat) return null;
    const handle = await open(local(path), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error(`Configuration drift while opening: ${path}`);
      return await handle.readFile();
    } finally { await handle.close(); }
  }

  async function fingerprint(path, optional = false) {
    const data = await bytes(path, optional);
    if (data === null) return null;
    const stat = await trusted(path);
    return { sha256: hash(data), mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid };
  }

  async function snapshot() {
    const files = {};
    const directories = {};
    for (const dir of [CONFIG_DIR, APT_DIR]) {
      await trusted(dir, { directory: true });
      const names = (await readdir(local(dir))).sort();
      directories[dir] = names;
      for (const name of names) {
        // Explicit character allow-list also prevents special two-argument Perl
        // open/glob filenames in needrestart's stock loader.
        if (!/^[A-Za-z0-9_.+-]+$/.test(name)) throw new Error(`Unsupported configuration filename in ${dir}`);
        files[`${dir}/${name}`] = await fingerprint(`${dir}/${name}`);
      }
    }
    for (const path of ['/etc/needrestart/needrestart.conf', '/usr/sbin/needrestart', '/usr/lib/needrestart/apt-pinvoke']) {
      files[path] = await fingerprint(path);
    }
    files['/etc/apt/apt.conf'] = await fingerprint('/etc/apt/apt.conf', true);
    if (!fixture) {
      for (const path of ['/usr/lib/os-release', '/usr/bin/perl', probePath, fragmentPath, fileURLToPath(import.meta.url)]) {
        files[path] = await fingerprint(path);
      }
      const os = (await bytes('/usr/lib/os-release')).toString();
      if (!/^ID=ubuntu$/m.test(os) || !/^VERSION_ID="24\.04"$/m.test(os)) throw new Error('Ubuntu 24.04 is required.');
      if (hash(await bytes(fragmentPath)) !== FRAGMENT_SHA256) throw new Error('Bundled fragment hash mismatch.');
    }
    return { files, directories };
  }

  async function selection() {
    if (fixture) return inspectSelection();
    // No shell, inherited Perl options, config arguments or production restart.
    const { stdout } = await run('/usr/bin/perl', [probePath], {
      env: cleanEnvironment, timeout: 30000, maxBuffer: 1024 * 1024,
    });
    const proof = JSON.parse(stdout);
    if (proof.exactOnly !== true || proof.existingOverridesPreserved !== true || proof.nonServiceConfigurationPreserved !== true) {
      throw new Error('Effective selection proof failed.');
    }
    return proof;
  }

  async function check() {
    const before = await snapshot();
    const proof = await selection();
    const after = await snapshot();
    if (!equal(before, after)) throw new Error('Configuration drift during check.');
    const plan = {
      version: 1, operation: 'apply', service: SERVICE, destination: DESTINATION,
      fragmentSha256: FRAGMENT_SHA256, snapshot: before, proof,
      alreadyInstalled: before.files[DESTINATION]?.sha256 === FRAGMENT_SHA256,
    };
    return { ...plan, approval: hash(canonical(plan)) };
  }

  async function ensureState() {
    if (!fixture && (process.platform !== 'linux' || process.getuid?.() !== 0)) throw new Error('Root on Ubuntu 24.04 is required.');
    await trusted('/var/lib', { directory: true });
    try { await mkdir(local(STATE), { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await trusted(STATE, { directory: true });
    if (!fixture && (stat.mode & 0o077)) throw new Error('Deployment state must be private mode 0700.');
  }

  async function syncDirectory(path) {
    if (process.platform === 'win32') return;
    const handle = await open(local(path), constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async function writeNew(path, data, mode) {
    const handle = await open(local(path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), mode);
    try {
      await handle.writeFile(data);
      if (process.platform !== 'win32') await handle.chmod(mode);
      await handle.sync();
    } finally { await handle.close(); }
  }

  async function atomic(path, data, mode, metadata) {
    const temporary = `${dirname(path)}/.hsr-needrestart-${randomUUID()}.tmp`;
    await writeNew(temporary, data, mode);
    try {
      if (!fixture && metadata) {
        await chown(local(temporary), metadata.uid, metadata.gid);
        const handle = await open(local(temporary), constants.O_RDONLY);
        try { await handle.sync(); } finally { await handle.close(); }
      }
      await rename(local(temporary), local(path));
      await syncDirectory(dirname(path));
    } finally { await unlink(local(temporary)).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }

  async function locked(operation) {
    await ensureState();
    const lock = `${STATE}/lock`;
    await mkdir(local(lock), { mode: 0o700 }).catch(error => {
      if (error.code === 'EEXIST') throw new Error('Deployment lock exists; review interrupted operation before removing it.');
      throw error;
    });
    try { return await operation(); } finally { await rmdir(local(lock)); }
  }

  function withTarget(original, metadata) {
    const result = structuredClone(original);
    if (metadata) result.files[DESTINATION] = metadata;
    else delete result.files[DESTINATION];
    result.directories[CONFIG_DIR] = result.directories[CONFIG_DIR].filter(name => name !== '99-hsr-worker-production.conf');
    if (metadata) result.directories[CONFIG_DIR].push('99-hsr-worker-production.conf');
    result.directories[CONFIG_DIR].sort();
    return result;
  }

  async function apply(approval) {
    approvalRequired(approval);
    // Inspect before creating the state directory or lock: stale approvals are
    // rejected without filesystem writes.
    const plan = await check();
    if (plan.approval !== approval) throw new Error('Approval mismatch or configuration drift.');
    if (plan.alreadyInstalled) throw new Error('Fragment is already installed; retain its original rollback receipt.');
    return locked(async () => {
      if (!equal(await snapshot(), plan.snapshot)) throw new Error('Configuration drift before installation.');
      const transaction = randomUUID();
      const dir = `${STATE}/${transaction}`;
      await mkdir(local(dir), { mode: 0o700 });
      const original = await bytes(DESTINATION, true);
      if (original !== null) await writeNew(`${dir}/fragment.before`, original, 0o600);
      const destinationMetadata = plan.snapshot.files[DESTINATION] || null;
      if (original !== null && hash(original) !== destinationMetadata.sha256) throw new Error('Backup configuration drift.');
      const installedMetadata = { sha256: FRAGMENT_SHA256, mode: fixture && process.platform === 'win32' ? 0o666 : 0o644,
        uid: fixture ? (await lstat(local(dir))).uid : 0, gid: fixture ? (await lstat(local(dir))).gid : 0 };
      // Journal/backup are durable before modifying conf.d. A failed post-check
      // keeps this receipt for drift-checked rollback; there is no blind retry.
      const receipt = {
        version: 1, transaction, phase: 'prepared', service: SERVICE, destination: DESTINATION,
        fragmentSha256: FRAGMENT_SHA256, before: plan.snapshot,
        installed: withTarget(plan.snapshot, installedMetadata),
        backup: destinationMetadata,
      };
      await atomic(`${dir}/receipt.json`, JSON.stringify(receipt) + '\n', 0o600);
      await syncDirectory(STATE);
      if (!equal(await snapshot(), plan.snapshot)) throw new Error('Configuration drift before atomic installation.');
      try {
        await atomic(DESTINATION, fragmentText, 0o644);
        if (!equal(await snapshot(), receipt.installed)) throw new Error('Configuration drift after installation.');
        await selection();
        if (!equal(await snapshot(), receipt.installed)) throw new Error('Configuration drift during post-check.');
        receipt.phase = 'installed';
        await atomic(`${dir}/receipt.json`, JSON.stringify(receipt) + '\n', 0o600);
      } catch (error) {
        throw new Error(`${error.message} Transaction ${transaction} retained for rollback-check.`, { cause: error });
      }
      return { transaction, destination: DESTINATION, fragmentSha256: FRAGMENT_SHA256, phase: receipt.phase };
    });
  }

  async function rollbackReceipt(transaction) {
    if (typeof transaction !== 'string' || !uuidPattern.test(transaction)) throw new Error('Invalid transaction identifier.');
    const dir = `${STATE}/${transaction}`;
    const stateStat = await trusted(STATE, { directory: true });
    const dirStat = await trusted(dir, { directory: true });
    if (!fixture && ((stateStat.mode | dirStat.mode) & 0o077)) throw new Error('Rollback state must be private mode 0700.');
    const receipt = JSON.parse(await bytes(`${dir}/receipt.json`));
    if (receipt.version !== 1 || receipt.transaction !== transaction || receipt.service !== SERVICE
      || receipt.destination !== DESTINATION || receipt.fragmentSha256 !== FRAGMENT_SHA256
      || !['prepared', 'installed'].includes(receipt.phase) || !receipt.before || !receipt.installed
      || !equal(receipt.installed, withTarget(receipt.before, receipt.installed.files?.[DESTINATION]))) {
      throw new Error('Invalid rollback receipt.');
    }
    let backup = null;
    if (receipt.backup) {
      backup = await bytes(`${dir}/fragment.before`);
      if (hash(backup) !== receipt.backup.sha256 || !equal(receipt.backup, receipt.before.files[DESTINATION])) {
        throw new Error('Backup hash mismatch.');
      }
    } else if (receipt.before.files[DESTINATION]) throw new Error('Missing backup metadata.');
    return { dir, receipt, backup };
  }

  async function checkRollback(transaction) {
    const { receipt, backup } = await rollbackReceipt(transaction);
    const current = await snapshot();
    if (!equal(current, receipt.installed)) throw new Error('Configuration drift blocks automatic rollback.');
    const plan = { version: 1, operation: 'rollback', service: SERVICE, destination: DESTINATION,
      transaction, snapshot: current, restoreSha256: backup === null ? null : hash(backup), receiptSha256: hash(canonical(receipt)) };
    return { ...plan, approval: hash(canonical(plan)) };
  }

  async function rollback(transaction, approval) {
    approvalRequired(approval);
    const plan = await checkRollback(transaction);
    if (plan.approval !== approval) throw new Error('Rollback approval mismatch or configuration drift.');
    return locked(async () => {
      const { dir, receipt, backup } = await rollbackReceipt(transaction);
      if (hash(canonical(receipt)) !== plan.receiptSha256 || !equal(await snapshot(), plan.snapshot)) throw new Error('Rollback configuration drift.');
      if (backup === null) { await unlink(local(DESTINATION)); await syncDirectory(CONFIG_DIR); }
      else await atomic(DESTINATION, backup, receipt.backup.mode, receipt.backup);
      if (!equal(await snapshot(), receipt.before)) throw new Error('Configuration drift after rollback.');
      receipt.phase = 'rolled-back';
      await atomic(`${dir}/receipt.json`, JSON.stringify(receipt) + '\n', 0o600);
      return { transaction, phase: 'rolled-back', destination: DESTINATION };
    });
  }
  return { check, apply, checkRollback, rollback };
}

export async function main(args) {
  const [command, ...options] = args;
  const allowed = {
    check: [], apply: ['--approve'], 'rollback-check': ['--transaction'],
    rollback: ['--transaction', '--approve'],
  };
  if (!Object.hasOwn(allowed, command) || options.length !== allowed[command].length * 2) throw new Error('Invalid arguments; check | apply --approve SHA256 | rollback-check --transaction UUID | rollback --transaction UUID --approve SHA256.');
  const values = {};
  for (let index = 0; index < options.length; index += 2) {
    if (!allowed[command].includes(options[index]) || Object.hasOwn(values, options[index])) throw new Error('Invalid option.');
    values[options[index]] = options[index + 1];
  }
  if (command === 'apply' || command === 'rollback') approvalRequired(values['--approve']);
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Root on Ubuntu 24.04 is required.');
  const deployment = createDeployment();
  if (command === 'check') return deployment.check();
  if (command === 'apply') return deployment.apply(values['--approve']);
  if (command === 'rollback-check') return deployment.checkRollback(values['--transaction']);
  return deployment.rollback(values['--transaction'], values['--approve']);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n')).catch(error => {
    process.stderr.write(error.message + '\n'); process.exitCode = 1;
  });
}
