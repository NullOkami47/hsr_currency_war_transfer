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
      "bigIcon": "https://..."
    }
  ],
  "version": "4.4",
  "seasonId": "1",
  "subSeasonId": "4"
}
```

The response is shared-cacheable for one hour and may be served stale while
Vercel refreshes it.

## `POST /api/search`

An exact URL/ID lookup:

```json
{
  "source": "https://act.miyoushe.com/...#/lineup/6a56fe3021253d0e1a9f4761"
}
```

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

Candidates contain the original Chinese title and operation description, the
author's public display information, the final-stage role cards and a canonical
China source URL. Account UIDs and other non-display identifiers are omitted.
Role catalogue entries also contain Simplified Chinese, Traditional Chinese
and English names merged by stable game-data ID, plus their source portrait
icons.

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
