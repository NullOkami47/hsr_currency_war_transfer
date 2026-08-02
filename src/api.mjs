import { randomUUID } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import { request as httpsRequest } from "node:https";

import { PublicInputError } from "./errors.mjs";

export const REGIONS = Object.freeze({
  cn: Object.freeze({
    baseUrl:
      "https://act-api-takumi.miyoushe.com/event/rpgcurrencywar",
    safeReadFallbackHostnames: Object.freeze([
      "act-api-takumi.mihoyo.com",
      "api-takumi.mihoyo.com",
    ]),
    language: "zh-cn",
    origin: "https://act.miyoushe.com",
  }),
  global: Object.freeze({
    baseUrl:
      "https://sg-act-public-api.hoyolab.com/event/rpgcurrencywar",
    language: "en-us",
    origin: "https://act.hoyolab.com",
  }),
});

export class CurrencyWarApiError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "CurrencyWarApiError";
    this.retcode = options.retcode;
    this.status = options.status;
  }
}

const TRANSIENT_CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function connectionCode(error) {
  return error?.cause?.code ?? error?.code;
}

function failedAddresses(error) {
  const message = String(error?.cause?.message ?? error?.message ?? "");
  return new Set(
    [...message.matchAll(/(\d{1,3}(?:\.\d{1,3}){3}):\d+/gu)]
      .map((match) => match[1]),
  );
}

function normaliseAddresses(records) {
  return [...new Set(
    (records ?? [])
      .map((record) => typeof record === "string" ? record : record?.address)
      .filter(Boolean),
  )];
}

function requestAddress(
  url,
  { method, headers, body, signal },
  address,
  { timeoutMs = 5_000 } = {},
) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      protocol: url.protocol,
      hostname: address,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method,
      headers: {
        ...headers,
        host: url.host,
      },
      servername: url.hostname,
      signal,
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => {
        const payload = Buffer.concat(chunks).toString("utf8");
        resolve({
          ok: Number(response.statusCode) >= 200
            && Number(response.statusCode) < 300,
          status: Number(response.statusCode ?? 0),
          json: async () => JSON.parse(payload),
        });
      });
    });

    request.once("timeout", () => {
      request.destroy(Object.assign(
        new Error(
          `Currency War API edge ${address} timed out after ${timeoutMs}ms`,
        ),
        { code: "ETIMEDOUT" },
      ));
    });
    request.once("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function fetchWithEdgeFallback(
  url,
  options,
  {
    fetchFn,
    resolve4Fn,
    addressRequestFn,
    edgeFallbackLimit,
    fallbackHostnames = [],
  },
) {
  try {
    return await fetchFn(url, options);
  } catch (error) {
    if (!TRANSIENT_CONNECTION_CODES.has(connectionCode(error))) throw error;

    let addresses;
    try {
      addresses = normaliseAddresses(await resolve4Fn(url.hostname));
    } catch {
      throw error;
    }

    const alreadyFailed = failedAddresses(error);
    const candidates = addresses
      .filter((address) => !alreadyFailed.has(address))
      .slice(0, edgeFallbackLimit);
    let lastError = error;

    for (const address of candidates) {
      try {
        return await addressRequestFn(url, options, address);
      } catch (candidateError) {
        lastError = candidateError;
      }
    }

    for (const hostname of fallbackHostnames) {
      const fallbackUrl = new URL(url);
      fallbackUrl.hostname = hostname;
      try {
        return await fetchFn(fallbackUrl, options);
      } catch (fallbackError) {
        if (!TRANSIENT_CONNECTION_CODES.has(connectionCode(fallbackError))) {
          throw fallbackError;
        }
        lastError = fallbackError;
      }
    }
    throw lastError;
  }
}

function regionConfig(region) {
  const config = REGIONS[region];
  if (!config) {
    throw new TypeError(`Unsupported region: ${region}`);
  }
  return config;
}

function requestHeaders(
  region,
  { authenticatedHeaders = {}, language } = {},
) {
  const config = regionConfig(region);
  return {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    origin: config.origin,
    referer: `${config.origin}/`,
    "x-rpc-currencywar-tourn": "tourn",
    "x-rpc-device_id": randomUUID(),
    "x-rpc-lang": language ?? config.language,
    "x-rpc-platform": "pc",
    ...authenticatedHeaders,
  };
}

async function request(
  region,
  path,
  {
    method = "GET",
    query,
    body,
    authenticatedHeaders,
    language,
    signal,
    fetchFn = fetch,
    resolve4Fn = resolve4,
    addressRequestFn = requestAddress,
    edgeFallbackLimit = 4,
  } = {},
) {
  const config = regionConfig(region);
  const url = new URL(`${config.baseUrl}${path}`);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const requestOptions = {
    method,
    headers: requestHeaders(region, { authenticatedHeaders, language }),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  };
  const safeToRetry = method === "GET" || path === "/game/lineup/index";
  const response = safeToRetry
    ? await fetchWithEdgeFallback(url, requestOptions, {
        fetchFn,
        resolve4Fn,
        addressRequestFn,
        edgeFallbackLimit,
        fallbackHostnames: config.safeReadFallbackHostnames,
      })
    : await fetchFn(url, requestOptions);

  if (!response.ok) {
    throw new CurrencyWarApiError(
      `Currency War API returned HTTP ${response.status}`,
      { status: response.status },
    );
  }

  const envelope = await response.json();
  if (envelope.retcode !== 0) {
    throw new CurrencyWarApiError(
      envelope.message || `Currency War API retcode ${envelope.retcode}`,
      { retcode: envelope.retcode },
    );
  }

  return envelope.data;
}

export function fetchConfig(region, options = {}) {
  return request(region, "/game/config", {
    ...options,
    query: { game: "hkrpg" },
  });
}

export function fetchLineupDetail(region, id, options = {}) {
  if (!/^[a-f0-9]{24}$/i.test(id)) {
    throw new PublicInputError(`Invalid lineup id: ${id}`, "invalid_source");
  }

  return request(region, "/game/lineup/detail", {
    ...options,
    query: { game: "hkrpg", id },
  });
}

export function fetchLineupPage(
  region,
  {
    page = 1,
    limit = 10,
    nextPageToken,
    roleIds = [],
    traitIds = [],
    matchChangeJob = false,
    matchHard = false,
    order = "Hot",
  } = {},
  options = {},
) {
  if (!["Hot", "CreatedTime"].includes(order)) {
    throw new PublicInputError(`Unsupported order: ${order}`, "invalid_order");
  }

  return request(region, "/game/lineup/index", {
    ...options,
    method: "POST",
    body: {
      game: "hkrpg",
      page: String(page),
      limit: String(limit),
      lineup_type: "Tourn",
      next_page_token: nextPageToken,
      role_ids: roleIds,
      trait_ids: traitIds,
      match_change_job: matchChangeJob,
      match_hard: matchHard,
      order,
    },
  });
}

export async function searchLineupsByTitle(
  region,
  keyword,
  {
    maxPages = 10,
    limit = 10,
    roleIds = [],
    traitIds = [],
    order = "Hot",
  } = {},
  options = {},
) {
  const normalisedKeyword = keyword.trim().toLocaleLowerCase();
  if (!normalisedKeyword) {
    throw new TypeError("A non-empty title keyword is required");
  }

  const matches = [];
  let nextPageToken;

  for (let page = 1; page <= maxPages; page += 1) {
    const result = await fetchLineupPage(
      region,
      {
        page,
        limit,
        nextPageToken,
        roleIds,
        traitIds,
        order,
      },
      options,
    );

    for (const lineup of result.list ?? []) {
      if (
        lineup.title
          ?.toLocaleLowerCase()
          .includes(normalisedKeyword)
      ) {
        matches.push(lineup);
      }
    }

    nextPageToken = result.next_page_token;
    if (!nextPageToken || !(result.list?.length > 0)) {
      break;
    }
  }

  return matches;
}

export function parseChinaLineupInput(value) {
  const input = value.trim();
  if (/^[a-f0-9]{24}$/i.test(input)) {
    return input.toLowerCase();
  }

  let url;
  try {
    const sharedUrl = input.match(/https:\/\/act\.miyoushe\.com\/\S+/i)?.[0];
    url = new URL(sharedUrl ?? input);
  } catch {
    throw new PublicInputError(
      "Input is neither a lineup id nor a valid URL",
      "invalid_source",
    );
  }

  if (url.hostname !== "act.miyoushe.com") {
    throw new PublicInputError(
      "Only act.miyoushe.com lineup URLs are accepted",
      "invalid_source",
    );
  }

  const routeMatch = url.hash.match(/#\/lineup\/([a-f0-9]{24})(?:[/?]|$)/i);
  if (routeMatch) {
    return routeMatch[1].toLowerCase();
  }

  const directId = url.searchParams.get("lineup_id");
  if (directId && /^[a-f0-9]{24}$/i.test(directId)) {
    return directId.toLowerCase();
  }

  throw new PublicInputError(
    "The URL does not contain a directly readable China lineup id",
    "invalid_source",
  );
}

export function createGlobalLineup(payload, authenticatedHeaders, options = {}) {
  return request("global", "/game/lineup/create_lineup_tourn", {
    ...options,
    method: "POST",
    body: { ...payload, game: "hkrpg" },
    authenticatedHeaders,
  });
}

export function editGlobalLineup(
  editLineupId,
  payload,
  authenticatedHeaders,
  options = {},
) {
  return request("global", "/game/lineup/edit", {
    ...options,
    method: "POST",
    body: {
      ...payload,
      edit_lineup_id: editLineupId,
      game: "hkrpg",
    },
    authenticatedHeaders,
  });
}
