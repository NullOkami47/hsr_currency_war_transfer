# China strategy search API

The public search layer reads the China service anonymously. It does not use
the administrator's global browser profile.

## `GET /api/roles`

Returns the current visible China role catalogue for the website's
multi-select control:

```json
{
  "roles": [
    {
      "id": "1510",
      "names": {
        "zhHans": "姬子•启行",
        "zhHant": "姬子•啟行",
        "en": "Himeko • Nova"
      },
      "name": "姬子•启行",
      "icon": "https://...",
      "bigIcon": "https://...",
      "displayCost": "4",
      "costs": ["4"],
      "isExpert": false
    }
  ],
  "version": "4.4",
  "seasonId": "1",
  "subSeasonId": "4"
}
```

The response is shared-cacheable for one hour and may be served stale while
Vercel refreshes it.

`matchIds` is present only when the upstream config represents one visible
character with several internal upgrade IDs. The website shows one option;
search treats any ID in that group as a match. `displayCost` is the visible
character's cost and drives its portrait colour. `costs` retains all costs
represented by the grouped internal IDs and drives the catalogue filters.
Therefore, Silver Wolf LV.999 has a blue cost-3 portrait, appears under the
cost-3, cost-4, and cost-5 filters, and its portrait follows the active filter
(blue, purple, or yellow). In a strategy lineup, its portrait follows the
actual internal variant's cost. Strategy search matches all three internal
IDs. `isExpert` drives the Expert Consultant catalogue filter.

## `POST /api/search`

An exact URL/ID lookup:

```json
{
  "source": "https://act.miyoushe.com/...#/lineup/6a56fe3021253d0e1a9f4761"
}
```

The direct field also accepts ordinary share text containing one
`https://act.miyoushe.com/...` strategy link; the server extracts and validates
the China URL rather than requiring the user to remove the surrounding text.

A combined title, author and role search:

```json
{
  "keyword": "姬",
  "authorKeyword": "田宮良子",
  "roleIds": ["1510", "1001"],
  "maxPages": 10,
  "pageSize": 10,
  "order": "Hot"
}
```

`keyword`, `authorKeyword` and `roleIds` use AND matching. Author matching uses
the public display name. When multiple roles are selected, every selected role
must occur in the strategy. The service validates IDs
against the current China configuration and rechecks each returned lineup
locally because the upstream API may silently ignore invalid filters.

Public requests are capped at 10 pages and 20 strategies per page. The response
includes `pageInfo.truncated`; when true, the candidate list is a bounded
result rather than an exhaustive index.

The initial China configuration and direct strategy detail reads are attempted
at most three times. Each recommendation page is attempted at most twice. A
network `TypeError` such as Node's `fetch failed` remains an upstream failure;
it is never misclassified as invalid user input. If the first recommendation
page still fails, the endpoint returns `502 china_service_error` because no
usable search result exists. If a later page still fails, the endpoint returns
HTTP 200 with every candidate already collected and marks the response as a
partial search:

```json
{
  "pageInfo": {
    "scannedPages": 3,
    "scannedStrategies": 30,
    "truncated": true,
    "partial": true,
    "failedPage": 4
  }
}
```

Successful exhaustive or normally bounded searches set `partial` to `false`
and omit `failedPage`.

Input failures return HTTP 400 with `error.code: "invalid_request"` and a stable
`error.reason`. The website uses that reason to distinguish an invalid URL/ID,
missing criteria, invalid pagination, and stale character IDs from a temporary
China service failure. When character IDs are stale, it refreshes the catalogue
and removes only the unavailable selections; it does not silently broaden and
repeat the search.

Candidates contain the original Chinese title and operation description, the
author's public display information, the final-stage role cards and a canonical
China source URL. Account UIDs and other non-display identifiers are omitted.
Role catalogue entries also contain Simplified Chinese, Traditional Chinese
and English names merged by stable game-data ID, plus their source portrait
icons. Character data is shared across the China and Global configurations;
the Global locale variants are used only to supply localised display names.

## `POST /api/transfers`

Submits the candidate selected by the user:

```json
{
  "source": "6a56fe3021253d0e1a9f4761"
}
```

The Vercel function validates the China ID and forwards it to the separately
hosted administrator worker using `CURRENCY_WAR_WORKER_URL` and
`CURRENCY_WAR_WORKER_TOKEN`. The token remains server-side. The endpoint
returns `503 transfer_service_unavailable` until both variables and the worker
are available; it never launches or receives the persistent Chrome profile.

When the worker accepts the request asynchronously, the endpoint returns HTTP
202:

```json
{
  "status": "queued",
  "jobId": "e4509e8c-3aa8-491f-b6df-30be8f5caa6e"
}
```

## `GET /api/transfers?jobId={jobId}`

Polls the authenticated administrator worker through the server-side proxy.
The browser never receives the worker URL or token. While processing, the
response remains `queued`. A completed response uses `created`, `updated`,
`unchanged`, or `partial` and includes the global `shareCode` in
`##base64=##` format. `partial` also
includes every omitted item in `ignored`. A worker failure is returned as a
sanitised `failed` result without upstream account or session details.
