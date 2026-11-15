# HSR production needrestart exception

Scope: Ubuntu 24.04, `hsr-worker-production.service`, and needrestart
`3.6-7ubuntu4.5` as inspected on 15 November 2026. This component is prepared
for review; installation and live restart behaviour need separate owner approval.
It does not perform SSH, call a cloud API, upgrade packages, restart a service,
change the service unit, or edit APT policy.

The reviewed fragment is
`scripts/infrastructure/needrestart/99-hsr-worker-production.conf`:

```perl
$nrconf{override_rc}->{qr(\Ahsr-worker-production\.service\z)} = 0;
```

Its destination is **`/etc/needrestart/conf.d/99-hsr-worker-production.conf`**.
SHA256 of the complete file, including comments and final LF:
**`4b4ee4458764e1200f1b627549e8a74577b132f619bd173e8f3f38eef5992f81`**.
Use LF line endings when packaging; the checker rejects changed fragment bytes.
The hash is also pinned in `deployment.mjs`.

`\A` and `\z` require an exact Perl string match, including rejecting a trailing
newline. The single hash entry preserves existing `override_rc` entries. It
defers automatic selection without blacklisting the worker: needrestart can
still report that its libraries are stale. Other service selections and
automatic security updates retain their existing policy. This does not prevent
explicit operator restarts, package maintainer actions, reboots or other
controllers from restarting the worker.

## Primary source evidence

- Ubuntu's [Noble service restart announcement](https://discourse.ubuntu.com/t/needrestart-changes-in-ubuntu-24-04-service-restarts/44671)
  documents automatic APT restarts and specifically recommends a Perl one-liner
  adding an `override_rc` regexp in `/etc/needrestart/conf.d/` for an exception.
- Ubuntu's [packaged README.Ubuntu](https://git.launchpad.net/ubuntu/+source/needrestart/plain/debian/README.Ubuntu?h=ubuntu/noble-updates)
  explains that unattended upgrades also use the new automatic behaviour.
- The upstream [v3.6 configuration](https://github.com/liske/needrestart/blob/v3.6/ex/needrestart.conf)
  documents `override_rc`, warns that `blacklist_rc` hides services completely,
  and loads `.conf` files in Perl lexical order. The installed Ubuntu
  `README.needrestart` confirms that ordering.

The private inspection evidence remains outside Git. It identified the package
version above and a pending `libc6` reboot requirement; installing this exception
does not clear that requirement or update libraries already mapped by the worker.
Schedule the separately approved drain/restart or reboot needed to adopt security
fixes. Never provoke a libc upgrade to demonstrate this exclusion.

## Selection proof and trust boundary

`selection.pl` reads only the fixed installed needrestart program, fixed system
configuration and sibling reviewed fragment. Invoke it through `deployment.mjs`;
the controller first validates root ownership, non-writable ancestors and regular
files. It rejects symlinked configuration, hardlinked configuration, unsupported
filenames and customised conf.d loaders. Ubuntu's root-owned Perl executable may
be hardlinked to its versioned binary. Administrator-controlled Perl configuration
is executable code, so it must be reviewed and trusted before checking it. No
user-supplied config path, service regexp, fragment, shell command, or Perl
environment is accepted by the production CLI.

The evaluator extracts the actual installed default table and supported
automatic/list selection stanza. It evaluates current and candidate configuration
with the candidate inserted at its real sorted position. It tests the exact
worker, near names, and unrelated services. It checks every matching target rule
is false because the installed first-match hash iteration is unordered. A later
snippet clearing the exception, an existing conflicting rule, changed existing
overrides, or an unsupported implementation blocks approval. This is a synthetic
selection proof, not a scan proving a running process currently needs restart.

**`needrestart -b -r l` is not exclusion evidence.** In this package the batch
branch prints `NEEDRESTART-SVC` then skips `override_rc` selection. An optional
separately authorised live inspection can use `needrestart -r l -m u -u
NeedRestart::UI::stdio` with `DEBIAN_FRONTEND=noninteractive`, without `-b`, and
retain its output; explicit `-r l` prevents restarts. It is not run by this tool.

## Installation and approval interface

On the approved host, stage only the three reviewed component files in a
root-owned directory such as `/usr/local/lib/hsr-needrestart`, with root-owned
non-writable ancestors and mode 0644 files. Use a trusted Node >=20 installation,
a clean environment, and Ubuntu's `/usr/bin/perl`. Do not run privileged code
directly out of a user-writable checkout or copy private inspection data there.
Keep the release commit and file hashes with the private deployment record.

The following are interface examples for the future approved operator, **not
instructions to apply this during implementation**:

```sh
# Syntax only: does not load the fragment or restart services.
/usr/bin/perl -c /usr/local/lib/hsr-needrestart/99-hsr-worker-production.conf
/usr/bin/perl -c /usr/local/lib/hsr-needrestart/selection.pl

# Read-only check; emits a reviewable JSON plan and approval SHA256.
sudo env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin /absolute/trusted/node \
  /usr/local/lib/hsr-needrestart/deployment.mjs check

# Only after explicit approval of THAT plan, its host, release and behaviour:
sudo env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin /absolute/trusted/node \
  /usr/local/lib/hsr-needrestart/deployment.mjs apply --approve <plan-approval-SHA256>
```

The approval is a drift binding, not authentication or permission by itself.
Never automatically feed `check` output into `apply`. Missing/wrong approvals
fail. APT configuration and every needrestart config file, directory inventory,
source and tooling hashes are compared again before mutation. Apply creates a
private mode 0700 `/var/lib/hsr-needrestart-deployment/<UUID>/` with a mode 0600
receipt and, if needed, `fragment.before`. It records backup SHA256 and metadata
before an atomic, mode 0644 fragment installation. It then rechecks effective
selection and all protected hashes. It never calls needrestart's scanner, its
APT hook or `systemctl`; no daemon reload is required for this config fragment.
Reapplying the same fragment is rejected to preserve the original rollback chain.

## Rollback and interrupted operations

```sh
sudo env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin /absolute/trusted/node \
  /usr/local/lib/hsr-needrestart/deployment.mjs rollback-check --transaction <UUID>

# Separate explicit approval of the displayed rollback plan is required.
sudo env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin /absolute/trusted/node \
  /usr/local/lib/hsr-needrestart/deployment.mjs rollback --transaction <UUID> \
  --approve <rollback-plan-approval-SHA256>
```

Rollback verifies the protected post-install configuration, receipt, original
backup hash and metadata. It restores only the prior fragment, or removes the
fragment if none existed. It verifies that the entire protected pre-install
snapshot is restored. It does not restart anything; removing the exception
restores prior selection for a future APT transaction.

A failed post-check preserves the prepared receipt and reports its UUID for
`rollback-check`. There is no blind automatic rollback over newer operator
changes. Any APT/config/tooling drift blocks automatic rollback and requires
manual review of the private receipt. A killed process can leave the private
`lock` directory: inspect the receipt, processes and any `.hsr-needrestart-*.tmp`
files first; never remove a lock or retry a transaction blindly. A crash before
fragment replacement may leave only a backup and prepared receipt, with no live
config change. Never commit these host records or transfer them to Box.

## Reproducible component tests

```sh
node --test test/needrestart-exclusion.test.mjs

# Optional exact Ubuntu package fixture, downloaded/extracted without installation:
HSR_TEST_NEEDRESTART_PACKAGE=/path/to/extracted \
  node --test test/needrestart-exclusion.test.mjs
```

`HSR_TEST_PERL` can name a local test interpreter. Without Perl, the behavioural
Perl tests explicitly skip. The exact-package test requires the fixture variable;
the suite otherwise skips that one check. That test alone adapts fixed paths into
a temporary, nonprivileged fixture. The production CLI has no fixture/config-root
option. Filesystem transaction tests use a synthetic evaluator and isolated
temporary tree; they are not live apply authorisation or independent deployment
evidence. On Windows set TEMP/TMP to a D-drive test directory. Main integration
owns clean exact-commit Ubuntu qualification and any future live approval.
