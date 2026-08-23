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

The repository's memory-based search and administrator limiters protect one
process only. A multi-instance/serverless production deployment also requires
platform-level rate limiting or an injected shared-state implementation, as
described in `docs/search-api.md` and `docs/admin-connector.md`.
