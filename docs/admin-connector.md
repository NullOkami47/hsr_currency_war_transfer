# Admin publishing connector

## Boundary

Vercel should host the public website and API, but it should not hold or run the
HoYoLAB browser session. The publishing worker runs on the administrator's
computer or a small persistent VM:

```text
Public website / API
        |
        | queued transfer job
        v
Admin connector (persistent Chrome profile)
        |
        | authenticated first-party request
        v
Global Currency War service
```

The current command-line connector is the worker core. A later queue adapter can
feed it jobs from Vercel without changing the transfer rules.

## First login

Install Node.js 20 or later and Google Chrome, then run:

```powershell
npm install
npm run connector:login
```

Sign in to the intended HoYoLAB account in the opened browser and close the
browser window. The session stays in the dedicated profile. The connector does
not inspect or export its cookies.

To adopt the strategy created during the feasibility test:

```powershell
npm run mapping:adopt -- `
  6a587503f4749840a14a360d `
  6a6c461e6217fd436611cdc7
```

This prevents the first connector run from creating a duplicate.

## Change the publishing account

Run `npm run connector:login` again, sign out in HoYoLAB, then sign in with the
new account. No code or environment-secret change is required.

To keep separate admin accounts, give each account a different profile and
state file:

```powershell
npm run connector:login -- --profile-dir D:\currency-war\account-a
npm run transfer -- <CHINA_URL_OR_ID> `
  --profile-dir D:\currency-war\account-a `
  --state D:\currency-war\account-a-transfers.json
```

The mapping file belongs to the publishing account. Do not point a different
account at the old account's mapping unless its existing global strategies are
also migrated.

## Transfer states

| Result | Meaning |
| --- | --- |
| `unchanged` | Source and published global payload still match; existing code returned |
| `updated` | Existing mapped strategy changed and was edited in place |
| `created` | No readable mapped strategy existed, so a new one was created |

`ignored` lists every China item that was unavailable in the current global
configuration. Such a strategy is intentionally published as a partial version
and the omissions remain visible to the caller.

`attribution.title` and `attribution.description` report `added`,
`already-present`, `skipped-no-space` or `skipped-no-author`. The current
official editor limits are 60 characters for the editable title and 800 for the
operation strategy. Override these admin settings with
`CURRENCY_WAR_TITLE_LIMIT` and `CURRENCY_WAR_DESCRIPTION_LIMIT` if the
official client changes them.

`titlePrefix.status` reports whether the source-selected bond prefix was
`translated`, retained as `fallback-source`, or skipped because the source had
no prefix. The official editor generates this prefix in client-side code before
calling create/edit; the API endpoint does not add it. The connector therefore
maps the source trait IDs to global `zh-tw` names and includes the rebuilt
prefix in post-publish verification.

An unexpected post-publish difference is not treated as success. The connector
retries public reads briefly to tolerate cache delay, then raises a verification
error containing the failed payload paths.

The global create endpoint may return success without a lineup ID. In that
case, the connector does not repeat the create call. It queries My Posts and
recovers the newest exact title-and-description match, preventing a duplicate.

When a headless browser has just started, HoYoLAB can temporarily return
`retcode -100` before its account component restores the saved session. The
connector waits eight seconds and retries that request once. A second `-100`
is treated as a genuine expired login and is not retried again.

## Production queue

The public API should insert one idempotent job keyed by the China strategy ID.
A single connector worker should claim jobs sequentially, run `transferStrategy`
and store its result. A production database should enforce a unique source ID
and replace the local JSON mapping. This gives the website the same behaviour
as the current local lock while allowing restarts and multiple web instances.

The browser profile must stay on persistent encrypted storage and should never
be committed, uploaded to Vercel or returned to users.
