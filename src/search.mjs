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
        position,
        star: Number(role.star ?? 0),
      };
    });
}

export function toChinaStrategyCandidate(
  lineup,
  config,
  { selectedRoleIds = [] } = {},
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
    matchedRoleIds: selected.filter((id) => lineupRoleIds.has(id)),
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

  return (config.role_list ?? [])
    .filter((role) => !role.is_hide)
    .map((role) => {
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
  } = {},
) {
  const directSource = String(source ?? "").trim();
  const titleKeyword = String(keyword ?? "").trim();
  const authorNameKeyword = String(authorKeyword ?? "").trim();
  const selectedRoleIds = uniqueStrings(roleIds);

  if (directSource) {
    const sourceId = parseChinaLineupInput(directSource);
    const [config, detail] = await Promise.all([
      fetchConfigFn("cn"),
      fetchLineupDetailFn("cn", sourceId),
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

  const config = await fetchConfigFn("cn");
  validateSearchRoleIds(config, selectedRoleIds);

  const normalisedKeyword = normaliseText(titleKeyword);
  const normalisedAuthorKeyword = normaliseText(authorNameKeyword);
  const candidates = [];
  const seenIds = new Set();
  let nextPageToken;
  let scannedPages = 0;
  let scannedStrategies = 0;
  let hasMore = false;

  for (let page = 1; page <= maxPages; page += 1) {
    const result = await fetchLineupPageFn("cn", {
      page,
      limit: pageSize,
      nextPageToken,
      roleIds: selectedRoleIds,
      order,
    });
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
      const matchesAllRoles = selectedRoleIds.every((roleId) =>
        lineupRoleIds.has(roleId),
      );

      if (matchesKeyword && matchesAuthor && matchesAllRoles) {
        candidates.push(
          toChinaStrategyCandidate(lineup, config, {
            selectedRoleIds,
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
      truncated: hasMore && scannedPages === maxPages,
    },
  };
}
