import {
  fetchConfig,
  fetchLineupDetail,
  fetchLineupPage,
  parseChinaLineupInput,
} from "./api.mjs";
import { PublicInputError } from "./errors.mjs";
import { finalStage } from "./lineup.mjs";
import { retryRead } from "./retry.mjs";

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

function bondIndex(config) {
  return new Map(
    (config?.trait_info_list ?? [])
      .filter(({ trait_type: type }) => [0, 1].includes(Number(type)))
      .map((bond) => [String(bond.trait_id), bond]),
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

function allLineupBondIds(lineup) {
  return new Set(
    (lineup.tourn_detail?.role_stages ?? []).flatMap((stage) =>
      (stage.traits ?? []).map((bond) => String(bond.trait_id)),
    ),
  );
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

function interactionCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

export function toChinaStrategyCandidate(
  lineup,
  config,
  { selectedRoleIds = [], selectedRoleGroups, selectedBondIds = [] } = {},
) {
  if (!lineup?.id) {
    throw new TypeError("A China strategy lineup is required");
  }

  const rolesById = roleIndex(config);
  const lineupRoleIds = allLineupRoleIds(lineup);
  const lineupBondIds = allLineupBondIds(lineup);
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
    engagement: {
      likes: interactionCount(lineup.game_data?.interact?.like),
      saves: interactionCount(lineup.game_data?.interact?.favour),
    },
    roles: candidateRoles(lineup, rolesById),
    matchedRoleIds: selectedRoleGroups
      ? selectedRoleGroups
          .filter(({ matchIds }) => matchIds.some((id) => lineupRoleIds.has(id)))
          .map(({ selectedId }) => selectedId)
      : selected.filter((id) => lineupRoleIds.has(id)),
    matchedBondIds: uniqueStrings(selectedBondIds).filter((id) =>
      lineupBondIds.has(id)),
    createdAt: String(lineup.created_at ?? ""),
    lastEditedAt: String(lineup.last_edit ?? ""),
    isExpired: Boolean(lineup.tourn_detail?.is_expired),
    sourceUrl: `${CHINA_LINEUP_URL}#/lineup/${lineup.id}`,
  };
}

export function getChinaBondOptions(
  config,
  { simplifiedConfig, traditionalConfig, englishConfig } = {},
) {
  const simplifiedBonds = bondIndex(simplifiedConfig);
  const traditionalBonds = bondIndex(traditionalConfig);
  const englishBonds = bondIndex(englishConfig);

  return [...bondIndex(config).values()]
    .map((bond) => {
      const id = String(bond.trait_id);
      const simplified = simplifiedBonds.get(id);
      const traditional = traditionalBonds.get(id);
      const english = englishBonds.get(id);
      return {
        id,
        type: Number(bond.trait_type) === 0 ? "faction" : "school",
        name: String(simplified?.trait_name ?? bond.trait_name ?? ""),
        names: {
          zhHans: String(simplified?.trait_name ?? bond.trait_name ?? ""),
          zhHant: String(traditional?.trait_name ?? bond.trait_name ?? ""),
          en: String(english?.trait_name ?? bond.trait_name ?? ""),
        },
        icon: String(
          english?.trait_icon
            ?? traditional?.trait_icon
            ?? bond.trait_icon
            ?? "",
        ),
      };
    })
    .sort(
      (left, right) =>
        left.type.localeCompare(right.type, "en")
        || left.name.localeCompare(right.name, "zh-CN", {
          numeric: true,
          sensitivity: "base",
        })
        || left.id.localeCompare(right.id, "en", { numeric: true }),
    );
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
    bonds: getChinaBondOptions(config, {
      simplifiedConfig,
      traditionalConfig,
      englishConfig,
    }),
    version: String(config.rpg_game_big_version ?? ""),
    seasonId: String(config.season_id ?? ""),
    subSeasonId: String(config.sub_season_id ?? ""),
  };
}

function validateSearchBondIds(config, bondIds) {
  const known = bondIndex(config);
  const unknownBondIds = bondIds.filter((id) => !known.has(id));
  if (unknownBondIds.length > 0) {
    throw new PublicInputError(
      `Unknown China Bond id${unknownBondIds.length === 1 ? "" : "s"}: ${unknownBondIds.join(", ")}`,
      "stale_bond_ids",
    );
  }
}

function validateSearchRoleIds(config, roleIds) {
  const known = roleIndex(config);
  const unknownRoleIds = roleIds.filter((id) => !known.has(id));
  if (unknownRoleIds.length > 0) {
    throw new PublicInputError(
      `Unknown China role id${unknownRoleIds.length === 1 ? "" : "s"}: ${unknownRoleIds.join(", ")}`,
      "stale_role_ids",
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

function fetchLineupPageWithRetry(fetchLineupPageFn, options, retryOptions) {
  return retryRead(
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
    bondIds = [],
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
  const selectedBondIds = uniqueStrings(bondIds);

  if (directSource) {
    const sourceId = parseChinaLineupInput(directSource);
    const initialRetryOptions = {
      attempts: initialReadRetryAttempts,
      retryDelayMs: initialReadRetryDelayMs,
      ...(waitFn ? { waitFn } : {}),
    };
    const [config, detail] = await Promise.all([
      retryRead(() => fetchConfigFn("cn"), initialRetryOptions),
      retryRead(
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
        bondIds: [],
        roleMatch: "all",
        bondMatch: "all",
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

  if (
    !titleKeyword
    && !authorNameKeyword
    && selectedRoleIds.length === 0
    && selectedBondIds.length === 0
  ) {
    throw new PublicInputError(
      "Provide a China strategy URL/ID, title keyword, author name, role or Bond",
      "missing_criteria",
    );
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) {
    throw new PublicInputError(
      "maxPages must be an integer from 1 to 100",
      "invalid_pagination",
    );
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new PublicInputError(
      "pageSize must be an integer from 1 to 50",
      "invalid_pagination",
    );
  }

  const config = await retryRead(() => fetchConfigFn("cn"), {
    attempts: initialReadRetryAttempts,
    retryDelayMs: initialReadRetryDelayMs,
    ...(waitFn ? { waitFn } : {}),
  });
  const selectedRoleGroups = selectedRoleMatchGroups(
    config,
    selectedRoleIds,
  );
  validateSearchBondIds(config, selectedBondIds);
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
          traitIds: selectedBondIds,
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
      const lineupBondIds = allLineupBondIds(lineup);
      const matchesKeyword =
        !normalisedKeyword ||
        normaliseText(lineup.title).includes(normalisedKeyword);
      const matchesAuthor =
        !normalisedAuthorKeyword ||
        normaliseText(lineup.nickname).includes(normalisedAuthorKeyword);
      const matchesAllRoles = selectedRoleGroups.every(({ matchIds }) =>
        matchIds.some((roleId) => lineupRoleIds.has(roleId)),
      );
      const matchesAllBonds = selectedBondIds.every((bondId) =>
        lineupBondIds.has(bondId),
      );

      if (
        matchesKeyword
        && matchesAuthor
        && matchesAllRoles
        && matchesAllBonds
      ) {
        candidates.push(
          toChinaStrategyCandidate(lineup, config, {
            selectedRoleIds,
            selectedRoleGroups,
            selectedBondIds,
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
      bondIds: selectedBondIds,
      roleMatch: "all",
      bondMatch: "all",
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
