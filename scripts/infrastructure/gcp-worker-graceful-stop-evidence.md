# Isolated graceful worker stop evidence (2026-11-15)

Base: public main `cbc5b78fe831ad4a108a6fe2f1d13c34f8cc8fcf`.
Security reference: `f62b28020304d4c3c43b618757e10f8471dfc8cd`.
The reference's explicit Chromium sandbox requirement, executable/channel
overrides and worker sandbox option are retained; main had omitted these guards.

The existing `flock` wrapper becomes systemd's main process. With
`KillMode=control-group`, TERM also reaches Chrome before the worker can finish
HTTP and publisher cleanup. The isolated legacy fixture reproduces direct child
TERM and a remaining synthetic profile-lock marker. `--no-fork` alone still
reproduces that failure. With the delivered drop-in, systemd's MainPID equals
Node's PID, only Node receives TERM, and the same flock rejects a contender with
exit 75 both before stop and while child cleanup is deliberately blocked. It is
available with exit 0 only after cleanup and service exit.

Playwright's installed process launcher also registers a TERM handler by default;
its repeated `gracefullyClose()` path calls `killProcess()`. The worker therefore
explicitly owns INT/TERM shutdown. Other publisher callers retain Playwright's
default handlers. Final publisher close shares one promise, waits for active
requests and startup, and prohibits new browser launches. Auth recovery uses a
separate context close so it cannot wait on its own request chain. Repeated worker
signals await the same shutdown promise instead of exiting early.

Candidate verification on Simular Box (Ubuntu 24.04, Linux 6.8, systemd 255,
Node 24.21.0, npm 11.19.0, util-linux flock 2.39.3, Chrome 157.0.8103.38):

| Command | Exit | Result |
| --- | --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund` | 0 | Clean public dependency install |
| `node --test` | 0 | 243 passed, 1 opt-in integration test skipped |
| `HSR_SYSTEMD_SHUTDOWN_TEST=1 node --test test/gcp-worker-graceful-stop.integration.test.mjs` | 0 | 6 passed, none skipped |

The systemd run uses unique `/tmp/hsr-shutdown-systemd-*` directories and
`hsr-shutdown-<pid>-<random>-<case>.service` units, removing only those unit files
afterwards. It consumes the delivered drop-in with only the three production
paths replaced by fixture paths. Real Chrome runs as the unprivileged test user
with `chromiumSandbox: true`, a new synthetic profile, and intercepted synthetic
page/API responses. An in-flight browser request is held across TERM; browser
cleanup then precedes child and parent exit. All three Chrome Singleton markers
disappear normally, and the same profile reopens without deleting any lock.
The actual worker entrypoint also waits through repeated TERM/INT with cleanup
deliberately held. Unit tests first reproduced four lifecycle failures before the
fix; the final focused Windows run passed all 15 publisher/keepalive tests.
Independent Sol xhigh source review reported no actionable findings and reran
those 15 tests successfully; it reviewed the Linux fixture without executing it.

This change does not install a production drop-in or alter startup preflight,
profile locks, backup coordination, runtime versions, or the existing stop timeout.
Admission must already be paused and business jobs drained by the coordinator;
this is not a general job-queue drain implementation. The fixture's 5-second stop
timeout applies only to its own units. Production's stop window and the caller's
command timeout must be coordinated separately. Exact installed source identity
and production pause/restart approval remain with the coordinator. Final
commit-specific verification receipts are kept in the checkout's ignored `var/`.
