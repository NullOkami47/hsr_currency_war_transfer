import {
  fetchConfig,
  fetchLineupDetail,
  parseChinaLineupInput,
} from "./api.mjs";
import { PublicInputError } from "./errors.mjs";
import { finalStage } from "./lineup.mjs";
import { retryRead } from "./retry.mjs";
import { contentHash, toGlobalPublishPayload } from "./transform.mjs";
import { diffPayloads, verifyTransferPayload } from "./verify.mjs";

export const GLOBAL_TEXT_LIMITS = Object.freeze({
  title: 60,
  description: 800,
});

const INITIAL_READ_RETRY = Object.freeze({
  attempts: 5,
  retryDelayMs: 500,
  backoffFactor: 2,
});

class PublishedStrategyNotFoundError extends Error {
  constructor(lineupId, options = {}) {
    super(`Published global strategy ${lineupId} was not found`, options);
    this.name = "PublishedStrategyNotFoundError";
  }
}

export function buildGlobalTitlePrefix(sourceLineup, globalTitleConfig) {
  const sourceMatch = String(sourceLineup.title ?? "").match(/^【([^】]+)】/u);
  if (!sourceMatch) {
    return {
      value: "",
      status: "skipped-source-missing",
      traits: [],
    };
  }

  const sourcePrefix = `【${sourceMatch[1]}】`;
  const sourceTraits = finalStage(sourceLineup)?.traits ?? [];
  const translatedNames = new Map(
    (globalTitleConfig.trait_info_list ?? []).map((trait) => [
      String(trait.trait_id),
      String(trait.trait_name ?? ""),
    ]),
  );
  const selectedTraits = sourceTraits
    .map((trait) => {
      const sourceName = String(trait.trait_name ?? "");
      const nameIndex = sourceMatch[1].indexOf(sourceName);
      if (!sourceName || nameIndex < 0) {
        return null;
      }
      const countMatch = sourceMatch[1]
        .slice(0, nameIndex)
        .match(/(\d+)$/u);
      if (!countMatch) {
        return null;
      }
      return {
        id: String(trait.trait_id),
        count: Number(countMatch[1]),
        sourceName,
        globalName: translatedNames.get(String(trait.trait_id)) ?? "",
        index: nameIndex,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.index - right.index);

  if (
    selectedTraits.length === 0 ||
    selectedTraits.some((trait) => !trait.globalName)
  ) {
    return {
      value: sourcePrefix,
      status: "fallback-source",
      traits: selectedTraits,
    };
  }

  return {
    value: `【${selectedTraits
      .map((trait) => `${trait.count}${trait.globalName}`)
      .join("")}】`,
    status: "translated",
    traits: selectedTraits,
  };
}

function appendIfFits(value, suffix, limit) {
  const original = String(value ?? "");
  if (original.endsWith(suffix)) {
    return { value: original, status: "already-present" };
  }

  const attributed = `${original}${suffix}`;
  if (attributed.length > limit) {
    return { value: original, status: "skipped-no-space" };
  }

  return { value: attributed, status: "added" };
}

export function applySourceAttribution(
  payload,
  sourceLineup,
  limits = GLOBAL_TEXT_LIMITS,
) {
  const nickname = String(sourceLineup.nickname ?? "").trim();
  if (!nickname) {
    return {
      payload,
      attribution: {
        title: "skipped-no-author",
        description: "skipped-no-author",
      },
    };
  }

  const description = String(payload.description ?? "").trimEnd();
  const titleResult = appendIfFits(
    payload.title,
    `｜${nickname}`,
    limits.title,
  );
  const descriptionAttribution = `來源：${nickname}`;
  const descriptionResult =
    description === descriptionAttribution ||
    description.endsWith(`\n${descriptionAttribution}`)
      ? { value: description, status: "already-present" }
      : appendIfFits(
          description,
          description ? `\n${descriptionAttribution}` : descriptionAttribution,
          limits.description,
        );

  return {
    payload: {
      ...payload,
      title: titleResult.value,
      description: descriptionResult.value,
    },
    attribution: {
      title: titleResult.status,
      description: descriptionResult.status,
    },
  };
}

function normalisePublished(lineup, globalConfig) {
  const payload = toGlobalPublishPayload(lineup, globalConfig).payload;
  return {
    ...payload,
    // The official editor calculates this prefix before calling create/edit.
    // Preserve it during verification so a missing prefix cannot pass again.
    title: String(lineup.title ?? ""),
  };
}

async function fetchPublished(
  fetchLineupDetailFn,
  lineupId,
  retryOptions = { attempts: 3, retryDelayMs: 500 },
) {
  try {
    return await retryRead(async () => {
      const result = await fetchLineupDetailFn("global", lineupId);
      if (!result?.lineup) {
        throw new PublishedStrategyNotFoundError(lineupId);
      }
      return result.lineup;
    }, retryOptions);
  } catch (error) {
    if (error instanceof PublishedStrategyNotFoundError) throw error;
    if (error?.status === 404) {
      throw new PublishedStrategyNotFoundError(lineupId, { cause: error });
    }
    throw error;
  }
}

async function fetchVerifiedPublication(
  fetchLineupDetailFn,
  lineupId,
  expectedPayload,
  globalConfig,
  {
    attempts = 5,
    retryDelayMs = 500,
  } = {},
) {
  let lastError;
  let lastActualPayload;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await fetchLineupDetailFn("global", lineupId);
      const lineup = result?.lineup;
      if (!lineup) {
        throw new Error("Published global strategy was not readable");
      }

      const actualPayload = normalisePublished(lineup, globalConfig);
      const differences = diffPayloads(expectedPayload, actualPayload);
      if (differences.length === 0) {
        return lineup;
      }
      lastActualPayload = actualPayload;
      lastError = new Error(
        `Published strategy is not current yet (${differences.length} differences)`,
      );
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  if (lastActualPayload) {
    // Surface the exact failed paths instead of a generic cache timeout.
    verifyTransferPayload(expectedPayload, lastActualPayload);
  }
  throw lastError;
}

async function transferResolved(
  sourceId,
  {
    publisher,
    store,
    fetchConfigFn = fetchConfig,
    fetchLineupDetailFn = fetchLineupDetail,
    now = () => new Date(),
    verification,
    readRetry,
    mappedReadRetry,
    attributionLimits = GLOBAL_TEXT_LIMITS,
  },
) {
  if (!publisher || !store) {
    throw new TypeError("A publisher and transfer store are required");
  }

  const initialReadRetry = {
    ...INITIAL_READ_RETRY,
    ...readRetry,
  };
  const [globalConfig, globalTitleConfig, sourceResult] = await Promise.all([
    retryRead(() => fetchConfigFn("global"), initialReadRetry),
    retryRead(
      () => fetchConfigFn("global", {
        authenticatedHeaders: { "x-rpc-lang": "zh-tw" },
      }),
      initialReadRetry,
    ),
    retryRead(
      () => fetchLineupDetailFn("cn", sourceId),
      initialReadRetry,
    ),
  ]);
  const sourceLineup = sourceResult?.lineup;
  if (!sourceLineup) {
    throw new Error(`China strategy ${sourceId} was not found`);
  }
  if (sourceLineup.tourn_detail?.is_expired) {
    throw new PublicInputError(
      "The China strategy has expired and cannot be transferred",
      "expired_source",
    );
  }

  const transformed = toGlobalPublishPayload(sourceLineup, globalConfig);
  const attributed = applySourceAttribution(
    transformed.payload,
    sourceLineup,
    attributionLimits,
  );
  const titlePrefix = buildGlobalTitlePrefix(
    sourceLineup,
    globalTitleConfig,
  );
  const payload = {
    ...attributed.payload,
    title: `${titlePrefix.value}${attributed.payload.title}`,
  };
  const sourceHash = contentHash(payload);
  const previous = await store.get(sourceId);
  let existingLineup;

  if (previous?.globalId) {
    try {
      existingLineup = await fetchPublished(
        fetchLineupDetailFn,
        previous.globalId,
        mappedReadRetry,
      );
    } catch (error) {
      if (!(error instanceof PublishedStrategyNotFoundError)) throw error;
      existingLineup = null;
    }
  }

  if (existingLineup) {
    const currentPayload = normalisePublished(
      existingLineup,
      globalConfig,
    );
    const differences = diffPayloads(payload, currentPayload);

    if (previous.sourceHash === sourceHash && differences.length === 0) {
      const shareCode = String(
        existingLineup.tourn_detail?.share_code ?? previous.shareCode ?? "",
      );
      if (!shareCode) {
        throw new Error("Published global strategy did not return a share code");
      }
      return {
        status: "unchanged",
        sourceId,
        globalId: previous.globalId,
        shareCode,
        sourceHash,
        ignored: transformed.ignored,
        attribution: attributed.attribution,
        titlePrefix,
        differences: [],
      };
    }
  }

  const publication = existingLineup
    ? await publisher.edit(previous.globalId, payload)
    : await publisher.create(payload);
  const globalId = publication.lineupId;
  const published = await fetchVerifiedPublication(
    fetchLineupDetailFn,
    globalId,
    payload,
    globalConfig,
    verification,
  );
  const actualPayload = normalisePublished(published, globalConfig);
  verifyTransferPayload(payload, actualPayload);

  const shareCode = String(published.tourn_detail?.share_code ?? "");
  if (!shareCode) {
    throw new Error("Published global strategy did not return a share code");
  }
  await store.set(sourceId, {
    globalId,
    sourceHash,
    shareCode,
    updatedAt: now().toISOString(),
  });

  return {
    status: existingLineup ? "updated" : "created",
    sourceId,
    globalId,
    shareCode,
    sourceHash,
    ignored: transformed.ignored,
    attribution: attributed.attribution,
    titlePrefix,
    differences: [],
  };
}

export async function transferStrategy(input, options) {
  const sourceId = parseChinaLineupInput(input);
  if (typeof options?.store?.withTransferLock === "function") {
    return options.store.withTransferLock(
      () => transferResolved(sourceId, options),
    );
  }
  return transferResolved(sourceId, options);
}
