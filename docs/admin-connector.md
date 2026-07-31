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

The HTTP worker wraps the same connector core with a persistent job queue.
Vercel creates and polls jobs using a shared bearer token; the public browser
never receives that token or the HoYoLAB session.

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

## Run the connected flow locally

For a one-machine setup, the launcher creates an in-memory random token and
starts both services in the background:

```powershell
npm run local:start
# Open http://127.0.0.1:4173
npm run local:stop
```

The manual equivalent is shown below when separate terminals or custom ports
are required.

Generate a long random token once:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Start the signed-in worker in one terminal:

```powershell
$env:CURRENCY_WAR_WORKER_TOKEN="paste-the-generated-token"
$env:CURRENCY_WAR_HEADLESS="1"
npm run worker
```

Start the website in another terminal with the same token:

```powershell
$env:CURRENCY_WAR_WORKER_TOKEN="paste-the-generated-token"
$env:CURRENCY_WAR_WORKER_URL="http://127.0.0.1:8787/jobs"
npm run dev
```

The website now searches anonymously, submits the selected China strategy,
polls the job, and displays the returned global share code. The worker health
endpoint is `GET /health`; job endpoints require the bearer token.

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

Run one worker process on the administrator machine or persistent VM. Set
`CURRENCY_WAR_WORKER_URL` on Vercel to its HTTPS `/jobs` endpoint and configure
the same `CURRENCY_WAR_WORKER_TOKEN` on both sides. Do not expose the worker
directly over unencrypted HTTP on the public internet; bind it to localhost
behind a TLS reverse proxy, or use a private authenticated tunnel.

The worker persists queued and completed jobs in
`~/.hsr-currency-war-transfer/jobs.json`, recovers interrupted work after a
restart, deduplicates active jobs by China strategy ID, and executes transfers
sequentially. Override the path with `CURRENCY_WAR_JOB_STATE_PATH`.

The JSON job and transfer stores are designed for a single worker process. If
the service later runs multiple worker instances, replace both with a
transactional database that enforces one active job per source ID.

The browser profile must stay on persistent encrypted storage and should never
be committed, uploaded to Vercel or returned to users.
