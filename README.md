# HSR Currency War Transfer

**English** | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)

This repository contains the transfer core and a local, admin-managed
publishing connector for copying Currency War strategies from the China
service to the global service.

Validated so far:

- anonymous China/global reads;
- cross-region game-data ID compatibility;
- allow-listed payload transformation;
- authenticated create/edit through the official global web UI;
- a code-driven browser-session publisher that does not export cookies; and
- post-publish gameplay verification against the China source.

The exact gameplay payload for the test strategy matches the China source.
The local publisher is implemented and unit-tested. Live publishing requires
the administrator to sign in to its dedicated Chrome profile.

See [docs/feasibility-spike.md](docs/feasibility-spike.md) for the evidence,
root-cause analysis and remaining risks.

## Run

Node.js 20 or later is required.

```powershell
npm run local:start
npm run local:stop
npm run dev
npm test
npm run probe -- 6a587503f4749840a14a360d
npm run search -- 6a587503f4749840a14a360d
npm run search -- --author 田宮良子
npm run search -- --keyword 姬子 --roles 1510,1001
npm run search -- --list-roles 姬子
npm run diff:live -- 6a587503f4749840a14a360d 6a6c461e6217fd436611cdc7
npm run connector:login
npm run worker
npm run mapping:adopt -- 6a587503f4749840a14a360d 6a6c461e6217fd436611cdc7
npm run transfer -- 6a587503f4749840a14a360d
```

`npm run dev` starts the local website at `http://127.0.0.1:4173`. The site
supports exact China URL/ID lookup, title and author search, multiple-character
and Faction/School Bond AND filtering, candidate selection and transfer
submission. Completed submissions keep their Global code and official link in
browser-local history (up to 50 records). It includes light and dark themes.
Interface chrome, character names and Bond names are available in
Traditional Chinese, Simplified Chinese and English; source strategy text is
kept unchanged.

`npm run local:start` starts both the website and the authenticated worker on
localhost with an in-memory random token. `npm run local:stop` stops both
background processes. Run `npm run connector:login` first whenever the saved
HoYoLAB session or publishing account needs to be changed.

On Vercel, configure `CURRENCY_WAR_WORKER_URL`,
`CURRENCY_WAR_WORKER_TOKEN`, and a separate `CURRENCY_WAR_ADMIN_TOKEN` as
server-side environment variables to connect the submit button to the separate
authenticated publishing worker and enable the `/admin` console. Run
`npm run worker` on the administrator machine or persistent VM with the same
token. The website creates a job, polls it through the Vercel API, and returns
the global share code plus an official strategy-page link without exposing the
worker token or HoYoLAB session to the browser. Active duplicate requests for the same China strategy share one
job; completed requests run the existing create/update/unchanged comparison.

Without these variables, search and selection still work and transfer
submission returns a clear service-unavailable state. See `.env.example` and
`docs/admin-connector.md` for the complete local and production setup.

See the [administrator login and 2FA guide](docs/admin-login.md) for password
setup, Google Authenticator enrolment, rotation and recovery.

After signing in at `/admin`, an administrator can inspect publishing records
and change the public-submission switch, source strategy blacklist, per-IP
rate limit, publishing-account daily quota, pending queue capacity, and record
retention policy. Public submissions are disabled by default and the source
blacklist starts enabled and empty, so it blocks no strategy IDs. Here, “per account” means the single
Global publishing account attached to that worker.

`probe` reads and transforms without writing. `diff:live` re-fetches both
published strategies, normalises them through the same transformer, and exits
non-zero if any gameplay field differs.

`search` accepts a China strategy URL/ID for an exact lookup, or searches the
bounded China recommendation feed by title, author display name and multiple
role IDs. Filters use AND matching; every selected role must occur in the
candidate strategy. Use `--list-roles` to retrieve the current visible
China role catalogue and IDs. Search results are safe display candidates and
exclude author account identifiers.

The same functionality is exposed as Vercel functions at `GET /api/roles` and
`POST /api/search`. See
[docs/search-api.md](docs/search-api.md) for the request and response contract.

`connector:login` opens a dedicated Chrome profile. The administrator can sign
in, sign out or change the publishing account there at any time, then close the
window. `transfer` performs the complete create/update/verify flow using that
profile's session. It never reads or exports the browser's cookies, local
storage or passwords.

`mapping:adopt` registers a global strategy that was created before the
connector existed. The next transfer verifies it and updates it in place if
needed, instead of creating a duplicate.

By default, the profile and source-to-global mapping are stored outside the
repository under:

```text
~/.hsr-currency-war-transfer/browser-profile
~/.hsr-currency-war-transfer/transfers.json
```

Override them with `CURRENCY_WAR_PROFILE_DIR` and
`CURRENCY_WAR_STATE_PATH`, or the `--profile-dir` and `--state` command
options.

## Transfer rules

- Read the two bonds already selected by the China title, map their stable trait
  IDs to global `zh-tw` names, and rebuild the prefix, for example
  `【6战技点4命运圣杯】` → `【6戰技點4命運聖杯】`.
- Preserve the remaining Chinese title and operation text.
- Add `｜作者名稱` to the title only when it remains within 60
  characters.
- Add `來源：作者名稱` to the operation text only when it remains
  within 800 characters.
- Ignore IDs unavailable on global and return every omission in `ignored`.
- If the mapped global strategy still matches, return its existing code.
- If the source changed, edit the mapped strategy in place.
- If no valid mapping exists, create a new strategy.
- Re-fetch and compare the published payload before returning success.
- Verify the complete rebuilt title prefix as well as gameplay fields.
- Serialise local publishing jobs so repeated requests cannot create a race.

See [docs/admin-connector.md](docs/admin-connector.md) for deployment and
account-operation details.

## First-party endpoints

China base:

`https://act-api-takumi.miyoushe.com/event/rpgcurrencywar`

Global base:

`https://sg-act-public-api.hoyolab.com/event/rpgcurrencywar`

Read operations:

- `GET /game/config?game=hkrpg`
- `POST /game/lineup/index`
- `GET /game/lineup/detail?id={id}&game=hkrpg`

Authenticated global write operations:

- `POST /game/lineup/create_lineup_tourn`
- `POST /game/lineup/edit`

These are first-party web application endpoints, not a documented public API.
They may change without notice.
