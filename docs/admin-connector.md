# Admin publishing connector

For step-by-step administrator password and Google Authenticator setup, see the
login and 2FA guide in [English](admin-login.md),
[Simplified Chinese](admin-login.zh-CN.md), or
[Traditional Chinese](admin-login.zh-TW.md).

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

The administrator console at `/admin` is a separate server-side boundary. The
administrator token is exchanged for an eight-hour, signed, HTTP-only,
SameSite=Strict cookie. Settings changes additionally require the session's
CSRF token. Neither credential is written to local storage. The console proxy
uses the worker bearer token server-side, and non-loopback worker URLs must use
HTTPS and must not contain URL credentials.

`CURRENCY_WAR_ADMIN_PASSWORD_HASH` may be used instead of a raw administrator
token. It stores a PBKDF2-SHA256 hash in the deployment environment while the
administrator enters the original password in `/admin`. Never commit either a
real token or password hash. A long random password remains preferable because
a hash cannot prevent online guessing of a weak password.

Set `CURRENCY_WAR_ADMIN_TOTP_SECRET` to require a second, RFC 6238-compatible
time-based code for every new administrator session. Enabling or rotating this
secret immediately invalidates sessions signed without the current TOTP key.
The setup key remains server-side and the browser sends only the current
six-digit code. A successfully used code cannot create a second session within
the same running API instance. Failed sign-ins share one generic response and
are limited to five failures per client over ten minutes within each instance.

Generate an independent setup key locally:

```powershell
npm run admin:totp:generate
```

In Google Authenticator choose **Enter a setup key**, use `Currency War Admin`
as the account name, paste the displayed key, and select **Time based**. Store
the unspaced key as `CURRENCY_WAR_ADMIN_TOTP_SECRET` in Vercel Production,
Preview and Development environments. Never reuse the password, worker token,
or administrator session secret as the TOTP key. If the phone is lost, an
authorised Vercel administrator must rotate this environment variable and
enrol the replacement Authenticator before attempting another sign-in.

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

For a one-machine setup, the launcher creates an in-memory random token and an
independent administrator token, then starts both services in the background:

```powershell
npm run local:start
# Open http://127.0.0.1:4173
# Open http://127.0.0.1:4173/admin and use the one-time token printed above
npm run local:stop
```

The local launcher enables public submission on loopback and disables the
allow-list for development. Its state file contains only process IDs and a
random instance nonce, never either token. If the one-time administrator token
is lost, stop and restart the local stack.

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
$env:CURRENCY_WAR_ADMIN_TOKEN="paste-a-different-32-byte-random-token"
npm run dev
```

The website now searches anonymously, submits the selected China strategy,
polls the job, and displays the returned global share code. The worker health
endpoint is `GET /health`; job endpoints require the bearer token.

## Administrator console and safety policy

On first production start, public submission is disabled and the source
allow-list is enabled but empty. Sign in at `/admin`, configure the policy,
then explicitly enable public submission. The settings are persisted with the
job store and enforced inside the worker, not merely hidden in the website:

| Setting | Default | Allowed range / effect |
| --- | ---: | --- |
| Public submissions | Off | Master switch for requests originating from the public API |
| Source allow-list | On, empty | Up to 500 valid 24-character China strategy IDs |
| Per-IP limit | 5 per 60 minutes | 1–1,000 requests over a 1–1,440 minute sliding window |
| Publishing-account daily quota | 25 | 1–10,000 accepted jobs per UTC day |
| Pending queue capacity | 20 | 1–1,000 queued or running jobs |
| Record retention | 30 days | 1–365 days |
| Maximum stored records | 1,000 | 5–10,000 terminal records; active jobs are always retained |

One worker uses one Global publishing account, so the daily account quota
applies to that worker's publishing identity. There is no separate end-user
account system. The IP limiter uses a keyed HMAC of the address supplied by the
trusted deployment proxy; raw addresses are not sent to or stored by the
worker. Set `CURRENCY_WAR_CLIENT_HASH_SECRET` to a stable random secret if the
rate-limit identity must survive worker-token rotation. For a non-Vercel
reverse proxy, set `CURRENCY_WAR_TRUST_PROXY=1` only after configuring it to
overwrite, rather than append, untrusted client forwarding headers.

Active duplicate requests for the same China strategy reuse the existing job
before quota checks, preventing refreshes from consuming additional quota.
Rejected policies return stable 403 or 429 codes and never start a browser
publication.

The console shows source IDs, public Global strategy IDs/share codes, status,
timestamps, and sanitised errors. It never returns client rate-limit keys,
network addresses, worker credentials, browser-profile paths, cookies, or
HoYoLAB session data.

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
connector first reloads the event page, waits eight seconds, and retries. If
that page context is stale and still returns `-100`, it closes and rebuilds the
persistent browser context once, waits another eight seconds, and makes one
final request. A third `-100` is treated as a genuine expired login.

## Production queue

Run one worker process on the administrator machine or persistent VM. Set
`CURRENCY_WAR_WORKER_URL` on Vercel to its HTTPS `/jobs` endpoint and configure
the same `CURRENCY_WAR_WORKER_TOKEN` on both sides. Set a different random
`CURRENCY_WAR_ADMIN_TOKEN` of at least 32 characters on Vercel. Do not expose the worker
directly over unencrypted HTTP on the public internet; bind it to localhost
behind a TLS reverse proxy, or use a private authenticated tunnel.

The worker persists queued and completed jobs in
`~/.hsr-currency-war-transfer/jobs.json`, recovers interrupted work after a
restart, deduplicates active jobs by China strategy ID, and executes transfers
sequentially. Terminal records are pruned by age and count according to the
administrator policy. Override the path with `CURRENCY_WAR_JOB_STATE_PATH`.

The three anonymous reads that initialise a transfer (Global configuration,
Traditional Chinese configuration and China source detail) are each attempted
at most five times with exponential backoff. This absorbs a short upstream or
network outage without ever repeating a create or edit write.

The JSON job and transfer stores are designed for a single worker process. If
the service later runs multiple worker instances, replace both with a
transactional database that enforces one active job per source ID.

The browser profile must stay on persistent encrypted storage and should never
be committed, uploaded to Vercel or returned to users.
