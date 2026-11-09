# Security remediation verification — 9 November 2026

Repository: `NullOkami47/hsr_currency_war_transfer`

Scan: `wfr_0812ebee1cb472c14b455bf89b444fc75af4a3334b270ddf92f6282bb2636fa9`

Verified baseline/main: `6c5d4131ebfe4bd1c6b1cac77e6f2c1161a34682`.

## Scope and evidence

The full scan report was **not accessible** in this task. The supplied URL
redirected to the Codex Security Cloud plugin page in the available logged-in
Chrome session. The five descriptions supplied by the repository owner were
verified directly against the current main source before implementation.

All implementation and testing used an isolated worktree and temporary data on
D:. Tests use synthetic credentials, mock upstream services, temporary state
and loopback listeners. No real HoYoLAB profile, cookie, administrator secret
or worker bearer token was read or used. No production request/load test,
deployment, infrastructure change, merge or finding closure was performed.

## Finding disposition

| Finding | Root cause | Remediation | Evidence |
| --- | --- | --- | --- |
| F1 — role catalogue request amplification | Query variants invoked three uncached config reads; fallback/DNS/body reads had no overall deadline. | Reject all query parameters; one-hour process cache, shared in-flight load, 15-second failure cooldown, bounded callers, per-client/aggregate request budgets, and a 15-second end-to-end abort deadline. | Cache-busting rejected before I/O; concurrent misses call the loader once; TTL/recovery, three locale reads, caller abort, stalled fetch/DNS/body, aggregate limits and client churn covered. |
| F2 — publishing re-enabled on restart | Startup unconditionally applied the bootstrap flag to persisted settings. | Create-only bootstrap, durable first-run defaults and existing settings precedence. Corrupt state fails closed. | Initial off/on states and explicit disable survive restart; an actual spawned worker is enabled, disabled through its authenticated admin route, stopped and restarted with bootstrap still set, and remains disabled. |
| F3 — quota bypass via history pruning | Quotas counted retained jobs after terminal records were pruned. | Version-4 quota ledger independent of retained history; all accepted jobs count across completion/failure; 24-hour maximum client window; conservative persisted migration recovery interval. | Tiny retained history with exhausted daily/client quotas still rejects new jobs after reload; dashboard accounting, UTC boundary, sliding-window expiry, settings changes and simultaneous store callers covered. |
| F4 — anonymous transfer resource exhaustion | No public request/concurrency budget; worker polling read state freely and active duplicates rewrote history. | Separate submit/poll local and durable worker budgets, bounded identities/concurrency/body reads, strict query/job-ID validation, server-derived HMAC identity, no-op write elision. | Two newly constructed API instances share one worker authority; submit/poll limits survive worker reconstruction; aggregate churn, failure paths, overload, Retry-After, spoofed headers and duplicate write counts covered. |
| F5 — incomplete logout | UI reported success in finally; server only deleted the browser cookie. | Register unique sessions in worker state, check active status on each admin operation, persist revocation before clearing cookie, require explicit logout acknowledgement in UI. | Copied cookie rejected across API handlers and worker restart; other sessions preserved; bad CSRF, failed registration/read/revoke, malformed acknowledgements, legacy cookies and UI network/server/retry paths covered. |

## Validation record

Baseline: `npm ci --ignore-scripts` and `npm test`: **155 passed, 0 failed,
1 platform-specific skip** (156 tests). Eight initial regression tests were
run against the original implementation and **all eight failed**, demonstrating
the original defects rather than merely adding passing tests.

Final verification before commit: **217 total tests**, including **61 new
security regression tests**.
The suite includes the unchanged China-to-Global transformation, publication,
retry, sanitisation, mapping and history tests, in addition to security tests.
The Linux test copy uses canonical LF shell scripts; the first attempt against
the Windows checkout exposed CRLF in an unchanged shell helper, then passed
when the copy used the same LF representation that Git stores.

- Windows Node 20.20.2: **216 passed, 0 failed, 1 POSIX-only skip**.
- Windows Node 22.23.4: **216 passed, 0 failed, 1 POSIX-only skip**.
- Windows Node 24.18.0: **216 passed, 0 failed, 1 POSIX-only skip**.
- Linux/WSL Node 22.23.2: **217 passed, 0 failed, 0 skipped**, including POSIX state permissions and Caddy ownership/mode restoration.
- `npm audit --audit-level=high`: zero vulnerabilities at the verification time.
- `git diff --check`: no whitespace errors.
- Changed-file credential-pattern scan: no private keys, GitHub tokens or
  HoYoLAB credential values found (synthetic test values only).
- Independent review identified a P2 cross-host clock-skew issue in new session
  registration. A red test reproduced failure at +1 ms and +60 seconds. The fix
  accepts at most one minute of forward skew and clamps persisted expiry to the
  worker's eight-hour maximum. Five cross-clock integration cases and the
  beyond-tolerance rejection pass. The reviewer then reran all five cross-clock cases, checked expiry immediately
  before/at the boundary and rejected over-tolerance/non-finite expiry, and
  confirmed the P2 resolved. No remaining confirmed P1/P2 findings were reported.

The available CircleCI organisation was inspected while logged in. It listed
two other projects and no existing project/pipeline for this repository. No
CircleCI configuration/project was added. GitHub Actions configuration remains
unchanged; commits explicitly skip Actions to honour the request not to run
GitHub-hosted CI. This task does not claim a remote CI pass.

A separate loopback-only browser fixture was prepared to fail the first logout
and allow retry. Before interacting with it, the Chrome OpenCLI extension
connection became unavailable, confirmed by `opencli doctor`. Therefore no
successful rendered Chrome logout check is claimed. Automated UI tests execute
the actual `public/admin.js` with DOM/network fixtures; they are behavioural
tests, not a screenshot or visual-design acceptance.

## Deployment and remaining risks

1. Deploy the worker before the API. Production authentication now depends on
   its session registry; the API fails closed if the compatible worker is
   unavailable. Existing stateless cookies require a new login.
2. Existing version-2/3 state gets a persisted 24-hour public-admission cooldown
   because previously pruned records cannot reconstruct accurate historical
   quotas. It does not silently enable publishing or discard queued work.
3. Use one worker process per state directory/account. Serverless API instances
   share that worker's durable transfer budgets, quotas and sessions. Multiple
   worker processes require a transactional shared backend, not shared JSON files.
4. Catalogue/search and login/TOTP in-memory protections are per process.
   Production ingress/CDN/WAF controls remain necessary for fleet-wide and
   volumetric protection. No production platform control was changed or verified.
5. Keep all state files on protected persistent storage. State deletion, rollback
   or secret rotation can affect security accounting; backups/restores must be
   deliberate administrative operations. Windows requires suitable NTFS ACLs.
6. Logout prevents subsequent authentication with that session; it cannot cancel
   operations already authorised before the revocation transaction.

No exploit was exercised against a live public service. The findings are
remediated in source within the documented architecture; production effectiveness
requires an explicitly approved deployment and its operational controls.
