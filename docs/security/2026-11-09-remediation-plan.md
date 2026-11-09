# Security scan remediation implementation plan

**Goal:** remediate the five supplied findings against main 6c5d4131ebfe4bd1c6b1cac77e6f2c1161a34682 while preserving anonymous China reads and authenticated Global publishing.

**Evidence:** the scan URL redirects to the Codex Security Cloud plugin page in the available Chrome session. The full report was not accessible. The supplied finding descriptions and the checked-out source are the evidence used here. Baseline: 155 passed, 0 failed, 1 platform-specific skip.

**Architecture:** keep public API validation and local backpressure, with the existing authenticated persistent worker as the shared authority for transfer request budgets, publishing quotas and administrator sessions. Catalogue reads use one canonical cached operation with a bounded deadline. No production tests, deployment, infrastructure changes, merge or finding closure are authorised.

## Verified root causes

1. `createRolesHandler` accepts arbitrary query strings and invokes three uncached configuration reads per request. `request` has no default overall deadline, including DNS, fallback and response body reads.
2. Worker startup calls `updateSettings({publicSubmissionsEnabled:true})` every time the bootstrap environment flag is set.
3. `pruneState` deletes terminal records before per-client and daily quota checks, which count remaining jobs.
4. The public transfers handler has no request/concurrency budget or strict polling identifier check. Worker duplicates still cause the entire job state to be rewritten. All polling reads hit persistent state.
5. The logout UI reports success in `finally`. Server logout only clears the browser cookie; the signed session can be replayed for eight hours.

## Work and validation

- [x] Catalogue: reject query variants, cache/single-flight/negative cache, per-client and aggregate budgets, concurrency cap, end-to-end abort deadline. Test bursts, timeout, failure cooldown and recovery, including stalled DNS and body reads.
- [x] Worker policy: create-only bootstrap and versioned quota ledger independent of retained history. Conservatively lock submissions for 24 hours when migrating legacy history that may already have been pruned. Test disable/restart, migration, completion/pruning, exact expiry and concurrent requests.
- [x] Transfer admission: bound per-client and aggregate POST/GET calls before disk access, use a separate durable request-budget store at the shared worker, validate before forwarding, and skip unchanged job writes. Test multiple API instances against the same worker, reboots, malformed queries, overload, spoofed identities, duplicate writes and storage failures.
- [x] Logout: issue unique sessions registered on the shared worker, validate active sessions for all administrative operations, revoke before clearing cookie, fail closed on storage/transport errors. Reuse the existing bearer-authenticated `/admin` worker route for session operations; add no public privileged route. Test copied cookies across handlers/restarts, failed revocation, invalid CSRF and truthful UI feedback.
- [x] Run existing and new suites, audit dependencies, verify tests fail without the fixes, review security boundaries, document deployment scope and residual risk.
- Delivery: commit meaningful changes, push `codex/security-scan-remediation`, create a PR against `main`, and complete available validation. Use CircleCI if remote CI is needed; do not enable GitHub Actions or change CI configuration unnecessarily.

## Deployment boundary

A JSON-backed worker must have one active process per state directory. Multiple serverless API instances share its durable policy, budgets and sessions. Local API caches/limits alone are not fleet-wide DDoS protection. Platform ingress limits remain an operator deployment control and are not changed by this task.
