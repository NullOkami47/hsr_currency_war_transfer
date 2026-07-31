# Currency War transfer feasibility spike

Status: **gameplay transfer validated; local admin publishing connector
implemented and awaiting its first dedicated-profile live run**

Date: 2026-07-31

## Outcome

The transfer is feasible at the data-model and official-editor levels.

The China and global web applications use the same API shape and current
game-data identifiers. China strategy discovery and detail retrieval work
anonymously. A signed-in global account successfully created a test strategy,
replaced its gameplay configuration with the transformed China configuration,
and edited it in place through the official global UI.

The final public payload has zero gameplay differences from the transformed
China source. The two remaining full-payload differences are intentional:

- the global client calculates and writes the title's bond summary before
  calling the create/edit endpoint; and
- the operation text includes the agreed Chinese source attribution.

## Root cause of the incorrect test strategy

The first authenticated experiment used an existing global configuration as a
temporary skeleton to establish that create/edit and public retrieval worked.
It copied the source text, but did not replace every gameplay field. The spike
then treated a successful publish response as success without re-fetching and
comparing the published payload.

That allowed the unrelated global skeleton, “6 Debuff 3 Galaxy Ranger”, to
remain in the test strategy.

Two UI-specific details were also discovered during the correction:

1. the recommended two-star drawer changes character order after a main
   character is selected; selecting by a fixed visual index chose Tribbie
   instead of March 7th; and
2. `rec_equip_index` is determined by the order in which recommended-equipment
   character cards are added, not by board position.

The corrected flow selects roles by identity, creates equipment cards in source
`rec_equip_index` order, publishes, re-fetches the result and rejects the job
unless the gameplay diff is empty.

## Final live verification

- China strategy ID: `6a587503f4749840a14a360d`
- Global strategy ID: `6a6c461e6217fd436611cdc7`
- China source hash:
  `d2deb380778d1e896a784a844f7cf103e03bf791431e75d85db3dafdf6faadde`
- Unavailable source items: `0`
- Gameplay difference count: `0`
- Full difference count: `2` — title and description attribution only
- Global strategy code:
  `N/ru+b3VGnU0gIYMJFE57l6zk0i+vkTFw87ydaPmlbU=`

Global detail:

`https://act.hoyolab.com/sr/event/currency-wars/index.html?sign_type=2&auth_appid=rpqcurrencywar&authkey_ver=1&open_bbs=0&hyl_presentation_style=fullscreen&utm_source=hoyolab&utm_medium=post&lang=en-us#/lineup/6a6c461e6217fd436611cdc7`

Run the same invariant locally:

```powershell
npm run diff:live -- 6a587503f4749840a14a360d 6a6c461e6217fd436611cdc7
```

The command exits non-zero when any gameplay path differs.

## Anonymous read model

| Operation | Method and path | Anonymous |
| --- | --- | --- |
| Game configuration | `GET /game/config?game=hkrpg` | Yes |
| Recommended strategies | `POST /game/lineup/index` | Yes |
| Strategy detail | `GET /game/lineup/detail?id={id}&game=hkrpg` | Yes |

Title search is not exposed by the official API. It therefore requires bounded
pagination followed by local matching.

At the time of the spike, China and global both reported game version `4.4`,
season `1`, sub-season `4`, with no China-only or global-only IDs across roles,
traits, equipment, fight augments, portals or labels.

## Implemented locally

- Anonymous China/global API client
- China strategy URL/ID parser
- Recommended-strategy pagination and bounded local title search
- Allow-listed source-to-global transformation
- Automatic omission report for unavailable IDs
- Stable canonical SHA-256 content hash
- Caller-authenticated global create/edit functions
- Dedicated-profile browser-session publisher
- Create/update/unchanged orchestration and local idempotency lock
- Recursive payload differ and verification error
- Live post-publish differential command
- Unit and regression tests

## Production boundary

The connector uses a dedicated persistent Chrome profile on the administrator's
machine or worker VM. Code submits create/edit requests inside that signed-in
browser context, while cookies, local storage and passwords remain inside the
profile. The public Vercel application must not receive the browser profile.

Every publish job should:

1. fetch the current China source and both current game configurations;
2. transform using allow-listed stable IDs;
3. create or update the global strategy;
4. re-fetch the published global strategy;
5. compare gameplay fields against the transformed source;
6. return the code only when verification passes; and
7. otherwise publish or report the partial result according to the configured
   policy, including every failed path.

## Remaining validation

1. Run the connector once with its dedicated signed-in Chrome profile.
2. Exercise login expiry, CAPTCHA, risk-control and rate-limit handling.
3. Add the production database and queue adapter.
4. Confirm review and public-visibility timing.
5. Confirm the platform's immutable-code behaviour using an account that
   imports both the pre-edit and post-edit snapshots.

## Risks

- The first-party endpoints are undocumented and may change without notice.
- Automated writes may trigger login expiry, CAPTCHA, risk controls or account
  enforcement.
- A shared publishing account creates a moderation and quota bottleneck.
- Title search is bounded by the number of recommendation pages inspected.
- Future China/global version skew may produce partial strategies and must be
  reported item by item.
