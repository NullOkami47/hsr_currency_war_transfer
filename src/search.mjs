import {
  fetchConfig,
  fetchLineupDetail,
  fetchLineupPage,
  parseChinaLineupInput,
} from "./api.mjs";

const CHINA_LINEUP_URL =
  "https://act.miyoushe.com/sr/event/currency-wars/index.html";

function normaliseText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("zh-CN");
}

function uniqueStrings(values) {
  return [...new Set((values ?? []).map(String).filter(Boolean))];
}

function roleIndex(config) {
  return new Map(
    (config.role_list ?? []).map((role) => [String(role.id), role]),
  );
}

function localisedRoleIndex(config) {
  return new Map(
    (config?.role_list ?? []).map((role) => [String(role.id), role]),
  );
}

function logicalRoleKey(role) {
  return [
    normaliseText(role.name),
    String(role.icon ?? ""),
    String(role.big_icon ?? ""),
  ].join("\u0000");
}

function visibleRoleGroups(config) {
  const groups = new Map();
  for (const role of config?.role_list ?? []) {
    if (role.is_hide) continue;
    const key = logicalRoleKey(role);
    const existing = groups.get(key);
    if (existing) {
      existing.roles.push(role);
      existing.matchIds.push(String(role.id));
    } else {
      groups.set(key, { roles: [role], matchIds: [String(role.id)] });
    }
  }
  return [...groups.values()].map((group) => {
    const matchIds = group.matchIds.sort((left, right) =>
      left.localeCompare(right, "en", { numeric: true }));
    const costs = uniqueStrings(group.roles.map(({ rarity }) => rarity)).sort(
      (left, right) => left.localeCompare(right, "en", { numeric: true }),
    );
    return {
      role: group.roles.find(({ id }) => String(id) === matchIds[0]),
      matchIds,
      costs,
      isExpert: group.roles.some(({ is_expert: isExpert }) => Boolean(isExpert)),
    };
  });
}

function allLineupRoleIds(lineup) {
  return new Set(
    (lineup.tourn_detail?.role_stages ?? []).flatMap((stage) =>
      [...(stage.front_roles ?? []), ...(stage.back_roles ?? [])].map(
        (role) => String(role.id),
      ),
    ),
  );
}

function finalStage(lineup) {
  const stages = lineup.tourn_detail?.role_stages ?? [];
  return stages.find((stage) => stage.stage === "Final") ?? stages.at(-1);
}

function candidateRoles(lineup, rolesById) {
  const stage = finalStage(lineup);
  const seen = new Set();

  return [
    ...(stage?.front_roles ?? []).map((role) => ({
      role,
      position: "front",
    })),
    ...(stage?.back_roles ?? []).map((role) => ({
      role,
      position: "back",
    })),
  ]
    .filter(({ role }) => {
      const id = String(role.id);
      if (seen.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    })
    .map(({ role, position }) => {
      const configRole = rolesById.get(String(role.id));
      return {
        id: String(role.id),
        name: String(configRole?.name ?? role.name ?? ""),
        icon: String(configRole?.icon ?? role.icon ?? ""),
        bigIcon: String(configRole?.big_icon ?? ""),
        displayCost: String(configRole?.rarity ?? ""),
        position,
        star: Number(role.star ?? 0),
      };
    });
}

export function toChinaStrategyCandidate(
  lineup,
  config,
  { selectedRoleIds = [], selectedRoleGroups } = {},
) {
  if (!lineup?.id) {
    throw new TypeError("A China strategy lineup is required");
  }

  const rolesById = roleIndex(config);
  const lineupRoleIds = allLineupRoleIds(lineup);
  const selected = uniqueStrings(selectedRoleIds);

  return {
    id: String(lineup.id),
    title: String(lineup.title ?? ""),
    description: String(lineup.description ?? ""),
    author: {
      nickname: String(lineup.nickname ?? ""),
      avatarUrl: String(lineup.avatar_url ?? ""),
      certification: String(lineup.certification ?? ""),
    },
    roles: candidateRoles(lineup, rolesById),
    matchedRoleIds: selectedRoleGroups
      ? selectedRoleGroups
          .filter(({ matchIds }) => matchIds.some((id) => lineupRoleIds.has(id)))
          .map(({ selectedId }) => selectedId)
      : selected.filter((id) => lineupRoleIds.has(id)),
    createdAt: String(lineup.created_at ?? ""),
    lastEditedAt: String(lineup.last_edit ?? ""),
    isExpired: Boolean(lineup.tourn_detail?.is_expired),
    sourceUrl: `${CHINA_LINEUP_URL}#/lineup/${lineup.id}`,
  };
}

export function getChinaRoleOptions(
  config,
  { simplifiedConfig, traditionalConfig, englishConfig } = {},
) {
  const simplifiedRoles = localisedRoleIndex(simplifiedConfig);
  const traditionalRoles = localisedRoleIndex(traditionalConfig);
  const englishRoles = localisedRoleIndex(englishConfig);

  return visibleRoleGroups(config)
    .map(({ role, matchIds, costs, isExpert }) => {
      const id = String(role.id);
      const simplified = simplifiedRoles.get(id);
      const traditional = traditionalRoles.get(id);
      const english = englishRoles.get(id);
      return {
        id,
        name: String(simplified?.name ?? role.name ?? ""),
        ...(simplifiedConfig || traditionalConfig || englishConfig
          ? {
              names: {
                zhHans: String(simplified?.name ?? role.name ?? ""),
                zhHant: String(traditional?.name ?? role.name ?? ""),
                en: String(english?.name ?? role.name ?? ""),
              },
            }
          : {}),
        icon: String(english?.icon ?? traditional?.icon ?? role.icon ?? ""),
        bigIcon: String(
          english?.big_icon ?? traditional?.big_icon ?? role.big_icon ?? "",
        ),
        displayCost: String(role.rarity ?? ""),
        costs,
        isExpert,
        ...(matchIds.length > 1 ? { matchIds } : {}),
      };
    })
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name, "zh-CN", {
          numeric: true,
          sensitivity: "base",
        }) || left.id.localeCompare(right.id, "en", { numeric: true }),
    );
}

export async function fetchChinaRoleOptions(
  { fetchConfigFn = fetchConfig } = {},
) {
  const [simplifiedResult, traditionalResult, englishResult] =
    await Promise.allSettled([
      fetchConfigFn("cn"),
      fetchConfigFn("global", { language: "zh-tw" }),
      fetchConfigFn("global", { language: "en-us" }),
    ]);
  const simplifiedConfig =
    simplifiedResult.status === "fulfilled" ? simplifiedResult.value : null;
  const traditionalConfig =
    traditionalResult.status === "fulfilled" ? traditionalResult.value : null;
  const englishConfig =
    englishResult.status === "fulfilled" ? englishResult.value : null;
  const config = simplifiedConfig ?? traditionalConfig ?? englishConfig;
  if (!config) {
    throw simplifiedResult.reason;
  }
  return {
    roles: getChinaRoleOptions(config, {
      simplifiedConfig,
      traditionalConfig,
      englishConfig,
    }),
    version: String(config.rpg_game_big_version ?? ""),
    seasonId: String(config.season_id ?? ""),
    subSeasonId: String(config.sub_season_id ?? ""),
  };
}

function validateSearchRoleIds(config, roleIds) {
  const known = roleIndex(config);
  const unknownRoleIds = roleIds.filter((id) => !known.has(id));
  if (unknownRoleIds.length > 0) {
    throw new TypeError(
      `Unknown China role id${unknownRoleIds.length === 1 ? "" : "s"}: ${unknownRoleIds.join(", ")}`,
    );
  }
}

function selectedRoleMatchGroups(config, roleIds) {
  validateSearchRoleIds(config, roleIds);
  const groupByRoleId = new Map();
  for (const group of visibleRoleGroups(config)) {
    for (const id of group.matchIds) groupByRoleId.set(id, group.matchIds);
  }

  const seenGroups = new Set();
  const selectedGroups = [];
  for (const selectedId of roleIds) {
    const matchIds = groupByRoleId.get(selectedId) ?? [selectedId];
    const key = matchIds.join("\u0000");
    if (seenGroups.has(key)) continue;
    seenGroups.add(key);
    selectedGroups.push({ selectedId, matchIds });
  }
  return selectedGroups;
}

async function fetchReadWithRetry(
  readFn,
  {
    attempts = 2,
    retryDelayMs = 150,
    waitFn = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await readFn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts && retryDelayMs > 0) {
        await waitFn(retryDelayMs);
      }
    }
  }
  throw lastError;
}

function fetchLineupPageWithRetry(fetchLineupPageFn, options, retryOptions) {
  return fetchReadWithRetry(
    () => fetchLineupPageFn("cn", options),
    retryOptions,
  );
}

export async function searchChinaStrategies(
  {
    source,
    keyword = "",
    authorKeyword = "",
    roleIds = [],
    maxPages = 10,
    pageSize = 10,
    order = "Hot",
  } = {},
  {
    fetchConfigFn = fetchConfig,
    fetchLineupDetailFn = fetchLineupDetail,
    fetchLineupPageFn = fetchLineupPage,
    pageRetryAttempts = 2,
    pageRetryDelayMs = 150,
    initialReadRetryAttempts = 3,
    initialReadRetryDelayMs = 250,
    waitFn,
  } = {},
) {
  const directSource = String(source ?? "").trim();
  const titleKeyword = String(keyword ?? "").trim();
  const authorNameKeyword = String(authorKeyword ?? "").trim();
  const selectedRoleIds = uniqueStrings(roleIds);

  if (directSource) {
    const sourceId = parseChinaLineupInput(directSource);
    const initialRetryOptions = {
      attempts: initialReadRetryAttempts,
      retryDelayMs: initialReadRetryDelayMs,
      ...(waitFn ? { waitFn } : {}),
    };
    const [config, detail] = await Promise.all([
      fetchReadWithRetry(() => fetchConfigFn("cn"), initialRetryOptions),
      fetchReadWithRetry(
        () => fetchLineupDetailFn("cn", sourceId),
        initialRetryOptions,
      ),
    ]);
    if (!detail?.lineup) {
      throw new Error(`China strategy ${sourceId} was not found`);
    }

    return {
      mode: "direct",
      query: {
        sourceId,
        keyword: "",
        authorKeyword: "",
        roleIds: [],
        roleMatch: "all",
        order: null,
      },
      candidates: [toChinaStrategyCandidate(detail.lineup, config)],
      pageInfo: {
        scannedPages: 0,
        scannedStrategies: 1,
        truncated: false,
        partial: false,
      },
    };
  }

  if (!titleKeyword && !authorNameKeyword && selectedRoleIds.length === 0) {
    throw new TypeError(
      "Provide a China strategy URL/ID, title keyword, author name or at least one role",
    );
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) {
    throw new TypeError("maxPages must be an integer from 1 to 100");
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new TypeError("pageSize must be an integer from 1 to 50");
  }

  const config = await fetchReadWithRetry(() => fetchConfigFn("cn"), {
    attempts: initialReadRetryAttempts,
    retryDelayMs: initialReadRetryDelayMs,
    ...(waitFn ? { waitFn } : {}),
  });
  const selectedRoleGroups = selectedRoleMatchGroups(
    config,
    selectedRoleIds,
  );
  const upstreamRoleIds = selectedRoleGroups
    .filter(({ matchIds }) => matchIds.length === 1)
    .map(({ matchIds }) => matchIds[0]);

  const normalisedKeyword = normaliseText(titleKeyword);
  const normalisedAuthorKeyword = normaliseText(authorNameKeyword);
  const candidates = [];
  const seenIds = new Set();
  let nextPageToken;
  let scannedPages = 0;
  let scannedStrategies = 0;
  let hasMore = false;
  let failedPage = null;

  for (let page = 1; page <= maxPages; page += 1) {
    let result;
    try {
      result = await fetchLineupPageWithRetry(
        fetchLineupPageFn,
        {
          page,
          limit: pageSize,
          nextPageToken,
          roleIds: upstreamRoleIds,
          order,
        },
        {
          attempts: pageRetryAttempts,
          retryDelayMs: pageRetryDelayMs,
          ...(waitFn ? { waitFn } : {}),
        },
      );
    } catch (error) {
      if (scannedPages === 0) throw error;
      failedPage = page;
      break;
    }
    const lineups = result.list ?? [];
    scannedPages += 1;
    scannedStrategies += lineups.length;

    for (const lineup of lineups) {
      const id = String(lineup.id ?? "");
      if (!id || seenIds.has(id)) {
        continue;
      }
      seenIds.add(id);

      const lineupRoleIds = allLineupRoleIds(lineup);
      const matchesKeyword =
        !normalisedKeyword ||
        normaliseText(lineup.title).includes(normalisedKeyword);
      const matchesAuthor =
        !normalisedAuthorKeyword ||
        normaliseText(lineup.nickname).includes(normalisedAuthorKeyword);
      const matchesAllRoles = selectedRoleGroups.every(({ matchIds }) =>
        matchIds.some((roleId) => lineupRoleIds.has(roleId)),
      );

      if (matchesKeyword && matchesAuthor && matchesAllRoles) {
        candidates.push(
          toChinaStrategyCandidate(lineup, config, {
            selectedRoleIds,
            selectedRoleGroups,
          }),
        );
      }
    }

    nextPageToken = result.next_page_token;
    hasMore = Boolean(nextPageToken && lineups.length > 0);
    if (!hasMore) {
      break;
    }
  }

  return {
    mode: "search",
    query: {
      sourceId: null,
      keyword: titleKeyword,
      authorKeyword: authorNameKeyword,
      roleIds: selectedRoleIds,
      roleMatch: "all",
      order,
    },
    candidates,
    pageInfo: {
      scannedPages,
      scannedStrategies,
      truncated: Boolean(failedPage) || (hasMore && scannedPages === maxPages),
      partial: Boolean(failedPage),
      ...(failedPage ? { failedPage } : {}),
    },
  };
}
