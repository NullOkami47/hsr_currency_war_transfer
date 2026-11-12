# HSR standby resilience implementation plan

Goal: retain Azure Production while completing the seven authorised resilience and staging requirements from the 2026-11-12 continuation.

Architecture: extend the existing encrypted three-file backup and Compute Engine standby. Preserve Azure Blob; add private Google Cloud Storage as the secondary ciphertext destination. Keep decryption keys and recovery codes on the approved Windows host. Monitoring and retention must run independently of Codex and the stopped GCP VM.

## Constraints

- No live strategy writes, production cutover, Azure shutdown, infrastructure deletion or production DNS changes.
- Keep GCP stopped except for necessary bounded staging work; retain the provider STOP limit.
- Azure production source and browser profile stay unchanged; only separately reviewed backup utilities may be deployed.
- Scope seven-day retention to canonical backup object pairs; preserve the newest valid pair and externally restored baseline. No general resource deletion.
- Never place decryption keys, recovery codes, browser profiles, access tokens or state plaintext in Git, build sources or external testing environments.

## Work and acceptance evidence

- [ ] Preserve the current backup commits and recovery runbook on a remote branch/Draft PR; verify remote SHA and secret-free tracked file set.
- [ ] Add GCS encrypted backup delivery using scoped workload federation, immutable uploads and read-back hashes; retain Azure delivery. Test partial failure and independent destination behaviour.
- [ ] Restore a secondary production ciphertext on the approved Windows host, verify all three authenticated files and remove temporary plaintext. No publisher start.
- [ ] Deploy a remote watchdog with owner notifications for backup failure, interrupted maintenance and missed schedule. Exercise real safe alert events and inspect policy/incident evidence.
- [ ] Deploy seven-day generation/ETag-conditional retention with fresh-success and pinned-baseline safeguards; test stale, corrupt, missing, future-dated, partial and concurrent-change cases before apply.
- [ ] Implement credit collection/evaluation at USD20/USD10 or <=5 days, including unknown/stale data alerts and actual API access evidence; never auto-cut over.
- [ ] Create only staging HTTPS records and a separate Vercel preview Function. Test actual Vercel-to-GCP health, rejected authentication, authorised synthetic job and polling. Preserve Production settings.
- [ ] Prepare a fresh-profile GCP interactive login and allowlisted read-only verification; perform only when the user can authenticate. No strategy write.
- [ ] Integrate and test reproducible existing-VM startup, strict network/runtime guards, isolated state restoration and rollback procedures. Reuse prior browser/systemd evidence unless changed code requires a new check.
- [ ] Fresh-checkout independent verification, required CI, exact deployment hashes, costs and blockers recorded; leave GCP stopped.

Worktrees are isolated under D:/CodexWork. Main integration branch: codex/hsr-resilience. Credit, retention/watchdog and GCP operation agents own disjoint files and commit for review/cherry-pick. Remote development tools are unavailable in this session; use the existing D-backed WSL Linux environment for clean-checkout verification, recording this limitation.
