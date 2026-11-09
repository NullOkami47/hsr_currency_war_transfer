# Security policy

## Supported version

Security fixes are maintained on the latest `main` branch. Older commits,
forks and deployments are not supported unless their operator has backported
the relevant fixes.

## Report a vulnerability privately

The preferred route is GitHub **Security → Report a vulnerability**. When the
repository owner has enabled Private Vulnerability Reporting, use:

https://github.com/NullOkami47/hsr_currency_war_transfer/security/advisories/new

If that workflow is unavailable, contact the repository owner through an
already trusted private channel. If no private channel exists, open only a
minimal public issue asking the owner to establish one; do not include the
affected component, exploit steps, impact or sensitive evidence in that issue.

Include the affected commit or deployed version, impacted endpoint/component,
reproduction preconditions, minimal redacted steps, security impact and any
suggested mitigation. State whether the issue is already being exploited and
how the reporter can be contacted for follow-up.

Never attach real HoYoLAB cookies, browser/Chrome profiles, worker tokens,
administrator credentials or password hashes, TOTP setup keys, Vercel secrets,
private keys, or unredacted request dumps to a public issue. If sensitive proof
is essential, agree on a private transfer method with the maintainer first.

## Trust boundary

The public frontend and Vercel API perform anonymous China-service reads and
validate public requests. Global publication crosses a separate authenticated
boundary to the persistent worker. The worker holds the policy state and uses a
persistent HoYoLAB browser profile to create or edit Global strategies:

```text
public frontend / Vercel API
            |
            | authenticated worker request (server-side token only)
            v
persistent worker and server-side policy
            |
            v
persistent HoYoLAB browser profile
```

The browser must never receive the worker bearer token. The HoYoLAB profile and
cookies must remain on protected persistent worker storage and must never be
committed, uploaded to Vercel or included in diagnostics.

Catalogue and search caches/limiters and administrator login/TOTP limiters
protect one API process only. Multi-instance/serverless production deployments
also require platform ingress controls or injected shared implementations;
see `docs/search-api.md` and `docs/admin-connector.md`.

Transfer submission and polling have both per-instance backpressure and a
durable request budget on the common authenticated worker. Publishing quotas
are a separate ledger, independent of retained job history. Administrator
sessions are registered, checked and revoked on that same worker in production;
unavailable session storage fails closed. No new public privileged route is
exposed: session operations use the existing bearer-authenticated worker
`/admin` route.

Run exactly one worker process for each state directory and publishing account.
The JSON stores serialise operations within that process; they are not a
multi-process database. Keep the job, mapping and security state together on
protected persistent storage. Deleting or restoring old security state can
reset budgets; treat state restore as a controlled administrative operation.
Deploy the worker before the API when adopting the session registry. Existing
stateless administrator cookies require a fresh login. Legacy job-state
migration conservatively pauses new public jobs for 24 hours because previous
retention may already have erased accounting evidence. No credential, profile
or publishing-account data is included in that migration.
