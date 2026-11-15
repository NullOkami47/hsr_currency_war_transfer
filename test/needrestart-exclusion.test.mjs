import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const moduleURL = new URL('../scripts/infrastructure/needrestart/deployment.mjs', import.meta.url);
const fragmentURL = new URL('../scripts/infrastructure/needrestart/99-hsr-worker-production.conf', import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
const perl = process.env.HSR_TEST_PERL || 'perl';
const hasPerl = spawnSync(perl, ['-e', 'exit 0']).status === 0;
const service = 'hsr-worker-production.service';
const destination = '/etc/needrestart/conf.d/99-hsr-worker-production.conf';
const nearNames = [
  'hsr-worker-staging.service', 'hsr-worker-productionXservice',
  'prefix-hsr-worker-production.service', 'hsr-worker-production.service-extra',
  'hsr-worker-production.service\n', 'hsr-worker-production@one.service',
  'hsr-worker-production', 'ssh.service', 'cron.service', 'caddy.service',
];

test('component module and fixed configuration fragment are present', async () => {
  assert.ok((await readFile(moduleURL)).length > 0);
  assert.ok((await readFile(fragmentURL)).length > 0);
});

test('real Perl adds only the exact service, preserving overrides and APT policy', { skip: !hasPerl }, async () => {
  const fragment = await readFile(fragmentURL, 'utf8');
  // Source is the reviewed repository fragment, not a caller-supplied config filename.
  const source = `use strict; use warnings; use JSON::PP;
our %nrconf = (override_rc => { qr(^dbus) => 0, qr(^ssh\\.service$) => 1 },
  restart => 'a', defno => 0, interpscan => 1, blacklist_rc => []);
my %original = %{$nrconf{override_rc}};
${fragment}
my @names = @{decode_json($ARGV[0])};
my @selections;
for my $rc (@names) {
  my $restart = !$nrconf{defno};
  foreach my $re (keys %{$nrconf{override_rc}}) {
    next unless($rc =~ /$re/);
    $restart = $nrconf{override_rc}->{$re}; last;
  }
  push @selections, $restart ? 1 : 0;
}
print encode_json({ selected => \\@selections,
 preserved => scalar(grep {exists $nrconf{override_rc}->{$_} && $nrconf{override_rc}->{$_} == $original{$_}} keys %original),
 count => scalar(keys %{$nrconf{override_rc}}), restart => $nrconf{restart},
 defno => $nrconf{defno}, interpscan => $nrconf{interpscan}, blacklist => $nrconf{blacklist_rc} });`;
  const result = spawnSync(perl, ['-e', source, JSON.stringify([service, ...nearNames, 'dbus.service'])], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    selected: [0, ...nearNames.map(() => 1), 0], preserved: 2, count: 3,
    restart: 'a', defno: 0, interpscan: 1, blacklist: [],
  });
});

test('exact Ubuntu package selection, sorted loading and conflicting overrides', {
  skip: !hasPerl || !process.env.HSR_TEST_NEEDRESTART_PACKAGE,
}, async t => {
  const packageRoot = process.env.HSR_TEST_NEEDRESTART_PACKAGE;
  const root = await mkdtemp(join(tmpdir(), 'hsr-needrestart-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.doesNotMatch(root, /['"\\\n\r]/);
  const confDir = join(root, 'etc/needrestart/conf.d');
  await mkdir(confDir, { recursive: true });
  const packageSource = await readFile(join(packageRoot, 'usr/sbin/needrestart'), 'utf8');
  await writeFile(join(root, 'needrestart'), packageSource);
  await writeFile(join(root, 'etc/needrestart/needrestart.conf'),
    (await readFile(join(packageRoot, 'etc/needrestart/needrestart.conf'), 'utf8'))
      .split('/etc/needrestart').join(join(root, 'etc/needrestart')));
  await writeFile(join(root, '99-hsr-worker-production.conf'), await readFile(fragmentURL));
  // Fixture-only source adaptation, under this nonprivileged test process. The
  // production CLI/evaluator accepts no config path or source overrides.
  const helper = (await readFile(new URL('../scripts/infrastructure/needrestart/selection.pl', import.meta.url), 'utf8'))
    .split('/usr/sbin/needrestart').join(join(root, 'needrestart'))
    .split('/etc/needrestart').join(join(root, 'etc/needrestart'));
  await writeFile(join(root, 'selection.pl'), helper);
  const evaluate = () => spawnSync(perl, [join(root, 'selection.pl')], { encoding: 'utf8' });
  let result = evaluate();
  assert.equal(result.status, 0, result.stderr);
  let proof = JSON.parse(result.stdout);
  assert.equal(proof.exactOnly, true);
  assert.equal(proof.after[0].selected, 0);
  for (const name of ['ssh.service', 'cron.service', 'caddy.service']) {
    assert.equal(proof.after.find(row => row.service === name).selected, 1);
  }
  // The installed -b path bypasses the selection block; never use it as proof.
  assert.ok(packageSource.indexOf('print "NEEDRESTART-SVC:') < packageSource.indexOf('my $restart = !$nrconf{defno};'));
  await writeFile(join(confDir, '00-existing.conf'), '$nrconf{override_rc}->{qr(\\Acustom\\.service\\z)} = 0;\n');
  result = evaluate();
  assert.equal(result.status, 0, result.stderr);
  proof = JSON.parse(result.stdout);
  assert.equal(proof.existingOverridesPreserved, true);
  await writeFile(join(confDir, '50-conflict.conf'), '$nrconf{override_rc}->{qr(^hsr-worker)} = 1;\n');
  result = evaluate();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /conflicting overrides/);
  await rm(join(confDir, '50-conflict.conf'));
  await writeFile(join(confDir, 'zz-later.conf'), '$nrconf{override_rc} = {};\n');
  result = evaluate();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /survive sorted loading/);
});

async function fixture(t, { previous, proof = true, failPostCheck = false } = {}) {
  const { createDeployment } = await import(moduleURL);
  const root = await mkdtemp(join(tmpdir(), 'hsr-needrestart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path => join(root, path.replace(/^\//, ''));
  const put = async (path, data) => {
    await mkdir(dirname(file(path)), { recursive: true });
    await writeFile(file(path), data);
  };
  await mkdir(file('/etc/needrestart/conf.d'), { recursive: true });
  await mkdir(file('/var/lib'), { recursive: true });
  await put('/etc/needrestart/needrestart.conf', '# synthetic fixture\n');
  await put('/etc/apt/apt.conf.d/20auto-upgrades', 'APT::Periodic::Unattended-Upgrade "1";\n');
  await put('/etc/apt/apt.conf.d/99needrestart', 'DPkg::Post-Invoke { "/usr/lib/needrestart/apt-pinvoke"; };\n');
  await put('/usr/sbin/needrestart', '# synthetic installed package\n');
  await put('/usr/lib/needrestart/apt-pinvoke', '# synthetic hook\n');
  if (previous !== undefined) await put(destination, previous);
  let calls = 0;
  const deployment = createDeployment({
    fixtureRoot: root,
    inspectSelection: async () => {
      calls++;
      if (!proof) throw new Error('conflicting override');
      if (failPostCheck && calls === 3) throw new Error('post-install check interrupted');
      return { exactOnly: true, source: 'synthetic test adapter' };
    },
  });
  return { root, file, put, deployment, calls: () => calls };
}

test('check is read-only and binds the fixed destination and fragment hash', async t => {
  const f = await fixture(t);
  const plan = await f.deployment.check();
  assert.equal(plan.service, service);
  assert.equal(plan.destination, destination);
  assert.equal(plan.fragmentSha256, sha(await readFile(fragmentURL)));
  assert.match(plan.approval, /^[a-f0-9]{64}$/);
  assert.deepEqual(await readdir(f.file('/etc/needrestart/conf.d')), []);
  await assert.rejects(readFile(f.file('/var/lib/hsr-needrestart-deployment')), { code: 'ENOENT' });
});

test('apply without approval does no inspection and creates no files', async t => {
  const f = await fixture(t);
  await assert.rejects(f.deployment.apply(), /approval/i);
  assert.equal(f.calls(), 0);
  assert.deepEqual(await readdir(f.file('/etc/needrestart/conf.d')), []);
});

test('stale approval refuses APT and needrestart configuration drift', async t => {
  for (const path of ['/etc/apt/apt.conf.d/20auto-upgrades', '/etc/needrestart/needrestart.conf', '/etc/needrestart/conf.d/50-other.conf']) {
    const f = await fixture(t);
    const plan = await f.deployment.check();
    await f.put(path, '# changed after review\n');
    await assert.rejects(f.deployment.apply(plan.approval), /drift|approval/i);
    await assert.rejects(readFile(f.file(destination)), { code: 'ENOENT' });
  }
});

test('conflicting effective selection blocks apply', async t => {
  const f = await fixture(t, { proof: false });
  await assert.rejects(f.deployment.apply('a'.repeat(64)), /conflicting override/);
  await assert.rejects(readFile(f.file(destination)), { code: 'ENOENT' });
});

for (const previous of [undefined, '# pre-existing managed fragment\n']) {
  test(`approved isolated fixture installation and rollback ${previous === undefined ? 'remove new file' : 'restore exact backup'}`, async t => {
    const f = await fixture(t, { previous });
    const aptBefore = await readFile(f.file('/etc/apt/apt.conf.d/20auto-upgrades'));
    const mainBefore = await readFile(f.file('/etc/needrestart/needrestart.conf'));
    const plan = await f.deployment.check();
    const installed = await f.deployment.apply(plan.approval);
    assert.deepEqual(await readFile(f.file(destination)), await readFile(fragmentURL));
    assert.equal(installed.fragmentSha256, plan.fragmentSha256);
    assert.match(installed.transaction, /^[a-f0-9-]{36}$/);
    const rollbackPlan = await f.deployment.checkRollback(installed.transaction);
    await assert.rejects(f.deployment.rollback(installed.transaction), /approval/i);
    await f.deployment.rollback(installed.transaction, rollbackPlan.approval);
    if (previous === undefined) await assert.rejects(readFile(f.file(destination)), { code: 'ENOENT' });
    else assert.equal(await readFile(f.file(destination), 'utf8'), previous);
    assert.deepEqual(await readFile(f.file('/etc/apt/apt.conf.d/20auto-upgrades')), aptBefore);
    assert.deepEqual(await readFile(f.file('/etc/needrestart/needrestart.conf')), mainBefore);
  });
}

test('rollback refuses changed installed fragment and unrelated APT drift', async t => {
  for (const path of [destination, '/etc/apt/apt.conf.d/20auto-upgrades']) {
    const f = await fixture(t);
    const plan = await f.deployment.check();
    const installed = await f.deployment.apply(plan.approval);
    const rollback = await f.deployment.checkRollback(installed.transaction);
    await f.put(path, '# subsequent operator change\n');
    await assert.rejects(f.deployment.rollback(installed.transaction, rollback.approval), /drift/i);
    assert.equal(await readFile(f.file(path), 'utf8'), '# subsequent operator change\n');
  }
});

test('rollback rejects backup tampering and traversal transaction identifiers', async t => {
  const f = await fixture(t, { previous: '# original\n' });
  const plan = await f.deployment.check();
  const installed = await f.deployment.apply(plan.approval);
  await f.put(`/var/lib/hsr-needrestart-deployment/${installed.transaction}/fragment.before`, '# tampered\n');
  await assert.rejects(f.deployment.checkRollback(installed.transaction), /backup|hash/i);
  await assert.rejects(f.deployment.checkRollback('../other'), /transaction/i);
});

test('failed post-check retains prepared receipt and permits approved rollback', async t => {
  const f = await fixture(t, { failPostCheck: true });
  const plan = await f.deployment.check();
  let transaction;
  await assert.rejects(f.deployment.apply(plan.approval), error => {
    assert.match(error.message, /post-install check interrupted/);
    transaction = error.message.match(/Transaction ([a-f0-9-]{36})/)[1];
    return true;
  });
  const receiptPath = `/var/lib/hsr-needrestart-deployment/${transaction}/receipt.json`;
  assert.equal(JSON.parse(await readFile(f.file(receiptPath))).phase, 'prepared');
  const rollback = await f.deployment.checkRollback(transaction);
  await f.deployment.rollback(transaction, rollback.approval);
  await assert.rejects(readFile(f.file(destination)), { code: 'ENOENT' });
});

test('existing transaction lock prevents a second installer', async t => {
  const f = await fixture(t);
  const plan = await f.deployment.check();
  await mkdir(f.file('/var/lib/hsr-needrestart-deployment/lock'), { recursive: true });
  await assert.rejects(f.deployment.apply(plan.approval), /lock exists/);
  await assert.rejects(readFile(f.file(destination)), { code: 'ENOENT' });
});

test('symlinked configuration is rejected instead of executing or modifying its target', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await f.put('/untrusted.conf', 'die "must never execute";\n');
  await symlink(f.file('/untrusted.conf'), f.file('/etc/needrestart/conf.d/50-link.conf'));
  await assert.rejects(f.deployment.check(), /symlink|regular|trusted/i);
  assert.equal(f.calls(), 0);
});

test('CLI refuses caller-supplied configuration roots and unapproved mutation', async () => {
  for (const args of [['check', '--root', '/tmp/evil'], ['apply'], ['rollback', '--transaction', '../evil']]) {
    const result = spawnSync(process.execPath, [moduleURL.pathname.replace(/^\/([A-Za-z]:)/, '$1'), ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /approval|arguments|transaction|option/i);
  }
});
