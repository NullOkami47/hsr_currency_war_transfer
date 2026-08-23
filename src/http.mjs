import { createHmac, randomBytes } from "node:crypto";

import {
  fetchChinaRoleOptions,
  searchChinaStrategies,
} from "./search.mjs";
import { parseChinaLineupInput } from "./api.mjs";
import { PublicInputError } from "./errors.mjs";
import { requestAddress } from "./request-address.mjs";

const PUBLIC_REQUEST_BODY_MAX_BYTES = 65_536;
export const PUBLIC_SEARCH_LIMITS = Object.freeze({
  maxPages: 10,
  pageSize: 20,
  keywordCharacters: 120,
  authorKeywordCharacters: 80,
  roleIds: 16,
  bondIds: 16,
  requestsPerWindow: 30,
  windowMs: 60_000,
});
const LOCAL_SEARCH_HASH_SECRET = randomBytes(32);
const GLOBAL_STRATEGY_PAGE =
  "https://act.hoyolab.com/sr/event/currency-wars/index.html";

export function globalStrategyUrl(globalId) {
  const id = String(globalId ?? "").toLowerCase();
  if (!/^[a-f0-9]{24}$/.test(id)) return null;
  const encodedId = id.replace(/\d/g, (digit) =>
    String.fromCharCode(110 + Number(digit)));
  const url = new URL(GLOBAL_STRATEGY_PAGE);
  url.searchParams.set("gt__lineup_id", encodedId);
  return url.toString();
}

function sanitiseGlobalStrategyUrl(value) {
  try {
    const supplied = new URL(String(value ?? ""));
    const expected = new URL(GLOBAL_STRATEGY_PAGE);
    const encodedId = supplied.searchParams.get("gt__lineup_id");
    if (
      supplied.origin !== expected.origin
      || supplied.pathname !== expected.pathname
      || !/^[a-fn-w]{24}$/.test(encodedId ?? "")
    ) {
      return null;
    }
    expected.searchParams.set("gt__lineup_id", encodedId);
    return expected.toString();
  } catch {
    return null;
  }
}

function sendJson(response, status, body, cacheControl = "no-store") {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", cacheControl);
  response.end(JSON.stringify(body));
}

function methodNotAllowed(response, allowed) {
  response.setHeader("allow", allowed);
  sendJson(response, 405, {
    error: {
      code: "method_not_allowed",
      message: `Use ${allowed}`,
    },
  });
}

function errorResponse(response, error) {
  const inputReason = error instanceof PublicInputError ? error.reason : null;
  const isInputError = error instanceof PublicInputError;
  sendJson(response, isInputError ? 400 : 502, {
    error: {
      code: isInputError ? "invalid_request" : "china_service_error",
      ...(inputReason ? { reason: inputReason } : {}),
      message: isInputError
        ? error.message
        : "Unable to read China strategies right now",
    },
  });
}

export class TransferServiceUnavailableError extends Error {
  constructor(message = "Transfer worker is not configured", options = {}) {
    super(message, options);
    this.name = "TransferServiceUnavailableError";
  }
}

export class TransferJobNotFoundError extends Error {
  constructor(message = "Transfer job was not found", options = {}) {
    super(message, options);
    this.name = "TransferJobNotFoundError";
  }
}

export class TransferRequestRejectedError extends Error {
  constructor(code, message = "Transfer request was rejected", options = {}) {
    super(message, options);
    this.name = "TransferRequestRejectedError";
    this.code = code;
    this.status = options.status ?? 403;
    this.retryAfter = options.retryAfter ?? null;
  }
}

function parseBody(request) {
  if (
    request.body &&
    typeof request.body === "object" &&
    !Buffer.isBuffer(request.body)
  ) {
    const serialised = JSON.stringify(request.body);
    if (Buffer.byteLength(serialised) > PUBLIC_REQUEST_BODY_MAX_BYTES) {
      throw new PublicInputError("Request body is too large", "request_too_large");
    }
    return request.body;
  }

  const rawBytes = Buffer.isBuffer(request.body)
    ? request.body.length
    : Buffer.byteLength(String(request.body ?? ""));
  if (rawBytes > PUBLIC_REQUEST_BODY_MAX_BYTES) {
    throw new PublicInputError("Request body is too large", "request_too_large");
  }
  const raw = Buffer.isBuffer(request.body)
    ? request.body.toString("utf8")
    : String(request.body ?? "");
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new PublicInputError(
      "Request body must be valid JSON",
      "invalid_request",
    );
  }
}

function boundedInteger(value, fallback, maximum, field) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new PublicInputError(
      `${field} must be an integer from 1 to ${maximum}`,
      "invalid_pagination",
    );
  }
  return parsed;
}

function boundedText(value, maximum, field, reason) {
  if (String(value ?? "").length > maximum) {
    throw new PublicInputError(
      `${field} must not exceed ${maximum} characters`,
      reason,
    );
  }
  return value;
}

function boundedArray(value, maximum, field, reason) {
  const entries = Array.isArray(value) ? value : [];
  if (entries.length > maximum) {
    throw new PublicInputError(
      `${field} must contain at most ${maximum} entries`,
      reason,
    );
  }
  return entries;
}

export function createInMemoryRateLimiter({
  limit = PUBLIC_SEARCH_LIMITS.requestsPerWindow,
  windowMs = PUBLIC_SEARCH_LIMITS.windowMs,
  maxEntries = 5_000,
} = {}) {
  if (
    !Number.isInteger(limit) || limit < 1
    || !Number.isInteger(windowMs) || windowMs < 1
    || !Number.isInteger(maxEntries) || maxEntries < 1
  ) {
    throw new TypeError("Rate limiter options are invalid");
  }
  const windows = new Map();

  return {
    consume(key, nowMs) {
      let entry = windows.get(key);
      if (!entry || entry.resetAt <= nowMs) {
        entry = { count: 0, resetAt: nowMs + windowMs };
      }
      entry.count += 1;
      windows.delete(key);
      windows.set(key, entry);
      while (windows.size > maxEntries) {
        windows.delete(windows.keys().next().value);
      }
      return {
        allowed: entry.count <= limit,
        retryAfter: entry.count <= limit
          ? 0
          : Math.max(1, Math.ceil((entry.resetAt - nowMs) / 1000)),
      };
    },
  };
}

const defaultPublicSearchLimiter = createInMemoryRateLimiter();

export function createRolesHandler({
  fetchChinaRoleOptionsFn = fetchChinaRoleOptions,
} = {}) {
  return async function rolesHandler(request, response) {
    if (request.method !== "GET") {
      methodNotAllowed(response, "GET");
      return;
    }

    try {
      const result = await fetchChinaRoleOptionsFn();
      sendJson(
        response,
        200,
        result,
        "public, s-maxage=3600, stale-while-revalidate=86400",
      );
    } catch (error) {
      errorResponse(response, error);
    }
  };
}

export function createSearchHandler({
  searchChinaStrategiesFn = searchChinaStrategies,
  rateLimiter = defaultPublicSearchLimiter,
  clientKeyFn = publicSearchClientKey,
  now = () => new Date(),
} = {}) {
  if (!rateLimiter || typeof rateLimiter.consume !== "function") {
    throw new TypeError("A public search rate limiter is required");
  }
  return async function searchHandler(request, response) {
    if (request.method !== "POST") {
      methodNotAllowed(response, "POST");
      return;
    }

    try {
      const body = parseBody(request);
      if (body.roleIds !== undefined && !Array.isArray(body.roleIds)) {
        throw new PublicInputError("roleIds must be an array", "invalid_roles");
      }
      if (body.bondIds !== undefined && !Array.isArray(body.bondIds)) {
        throw new PublicInputError("bondIds must be an array", "invalid_bonds");
      }
      const roleIds = boundedArray(
        body.roleIds,
        PUBLIC_SEARCH_LIMITS.roleIds,
        "roleIds",
        "too_many_roles",
      );
      const bondIds = boundedArray(
        body.bondIds,
        PUBLIC_SEARCH_LIMITS.bondIds,
        "bondIds",
        "too_many_bonds",
      );
      const keyword = boundedText(
        body.keyword,
        PUBLIC_SEARCH_LIMITS.keywordCharacters,
        "keyword",
        "keyword_too_long",
      );
      const authorKeyword = boundedText(
        body.authorKeyword,
        PUBLIC_SEARCH_LIMITS.authorKeywordCharacters,
        "authorKeyword",
        "author_keyword_too_long",
      );
      const maxPages = boundedInteger(
        body.maxPages,
        PUBLIC_SEARCH_LIMITS.maxPages,
        PUBLIC_SEARCH_LIMITS.maxPages,
        "maxPages",
      );
      const pageSize = boundedInteger(
        body.pageSize,
        10,
        PUBLIC_SEARCH_LIMITS.pageSize,
        "pageSize",
      );
      const rateLimit = await rateLimiter.consume(
        clientKeyFn(request),
        now().getTime(),
      );
      if (!rateLimit?.allowed) {
        const retryAfter = Math.max(1, Number(rateLimit?.retryAfter) || 1);
        response.setHeader("retry-after", String(retryAfter));
        sendJson(response, 429, {
          error: {
            code: "search_rate_limited",
            message: "Too many public search requests",
            retryAfter,
          },
        });
        return;
      }

      const result = await searchChinaStrategiesFn({
        source: body.source,
        keyword,
        authorKeyword,
        roleIds,
        bondIds,
        maxPages,
        pageSize,
        order: body.order ?? "Hot",
      });
      sendJson(response, 200, result);
    } catch (error) {
      errorResponse(response, error);
    }
  };
}

function publicTransferResult(value) {
  const allowedStatuses = new Set([
    "queued",
    "created",
    "updated",
    "unchanged",
    "partial",
    "failed",
  ]);
  const status = String(value?.status ?? "queued");
  if (!allowedStatuses.has(status)) {
    throw new TransferServiceUnavailableError(
      "Transfer worker returned an unsupported status",
    );
  }

  const rawShareCode = String(value?.shareCode ?? "");
  if (["created", "updated", "unchanged", "partial"].includes(status)
      && !rawShareCode) {
    throw new TransferServiceUnavailableError(
      "Transfer worker completed without a share code",
    );
  }
  const shareCode = rawShareCode
    ? rawShareCode.startsWith("##") && rawShareCode.endsWith("##")
      ? rawShareCode
      : `##${rawShareCode}##`
    : null;
  const globalUrl = globalStrategyUrl(value?.globalId)
    ?? sanitiseGlobalStrategyUrl(value?.globalUrl);
  if (["created", "updated", "unchanged", "partial"].includes(status)
      && !globalUrl) {
    throw new TransferServiceUnavailableError(
      "Transfer worker completed without a valid Global strategy ID",
    );
  }

  return {
    status,
    jobId: value?.jobId ? String(value.jobId) : null,
    shareCode,
    globalUrl,
    ignored: Array.isArray(value?.ignored)
      ? value.ignored.map((item) => ({
          type: String(item?.type ?? "unknown"),
          id: String(item?.id ?? ""),
          reason: String(item?.reason ?? "unknown"),
        }))
      : [],
    error: status === "failed"
      ? {
          code: String(value?.error?.code ?? "transfer_failed"),
          message: "The strategy could not be transferred",
        }
      : null,
  };
}

export function validatedWorkerUrl(workerUrl) {
  const url = new URL(workerUrl);
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new TransferServiceUnavailableError(
      "Transfer worker URL must use HTTPS outside loopback",
    );
  }
  if (url.username || url.password) {
    throw new TransferServiceUnavailableError(
      "Transfer worker URL must not contain credentials",
    );
  }
  return url;
}

export function publicClientKey(
  request,
  secret = process.env.CURRENCY_WAR_CLIENT_HASH_SECRET
    ?? process.env.CURRENCY_WAR_WORKER_TOKEN,
  addressOptions,
) {
  if (!secret) return "anonymous";
  return createHmac("sha256", secret)
    .update(requestAddress(request, addressOptions))
    .digest("hex");
}

export function publicSearchClientKey(
  request,
  secret = process.env.CURRENCY_WAR_SEARCH_HASH_SECRET
    ?? process.env.CURRENCY_WAR_CLIENT_HASH_SECRET
    ?? process.env.CURRENCY_WAR_WORKER_TOKEN
    ?? LOCAL_SEARCH_HASH_SECRET,
  addressOptions,
) {
  return createHmac("sha256", secret)
    .update("currency-war-public-search\0")
    .update(requestAddress(request, addressOptions))
    .digest("base64url");
}

async function workerError(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  return body?.error ?? null;
}

export async function submitTransferToWorker(
  sourceId,
  {
    workerUrl = process.env.CURRENCY_WAR_WORKER_URL,
    workerToken = process.env.CURRENCY_WAR_WORKER_TOKEN,
    clientKey,
    fetchFn = fetch,
  } = {},
) {
  if (!workerUrl || !workerToken) {
    throw new TransferServiceUnavailableError();
  }

  let response;
  try {
    const url = validatedWorkerUrl(workerUrl);
    response = await fetchFn(url.toString(), {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${workerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sourceId,
        ...(clientKey ? { clientKey } : {}),
      }),
      redirect: "error",
      signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    if (error instanceof TransferServiceUnavailableError) throw error;
    throw new TransferServiceUnavailableError(
      "Transfer worker could not be reached",
      { cause: error },
    );
  }

  if (!response.ok) {
    const policy = await workerError(response);
    if ([403, 429].includes(response.status) && policy?.code) {
      throw new TransferRequestRejectedError(policy.code, policy.message, {
        status: response.status,
        retryAfter: policy.retryAfter,
      });
    }
    throw new TransferServiceUnavailableError(
      `Transfer worker returned HTTP ${response.status}`,
    );
  }
  return publicTransferResult(await response.json());
}

function workerJobUrl(workerUrl, jobId) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(jobId)) {
    throw new TypeError("jobId is invalid");
  }
  const url = validatedWorkerUrl(workerUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${jobId}`;
  return url.toString();
}

export async function getTransferFromWorker(
  jobId,
  {
    workerUrl = process.env.CURRENCY_WAR_WORKER_URL,
    workerToken = process.env.CURRENCY_WAR_WORKER_TOKEN,
    fetchFn = fetch,
  } = {},
) {
  if (!workerUrl || !workerToken) {
    throw new TransferServiceUnavailableError();
  }

  let response;
  try {
    response = await fetchFn(workerJobUrl(workerUrl, jobId), {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${workerToken}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (error instanceof TypeError && /jobId/.test(error.message)) throw error;
    throw new TransferServiceUnavailableError(
      "Transfer worker could not be reached",
      { cause: error },
    );
  }

  if (response.status === 404) throw new TransferJobNotFoundError();
  if (!response.ok) {
    throw new TransferServiceUnavailableError(
      `Transfer worker returned HTTP ${response.status}`,
    );
  }
  return publicTransferResult(await response.json());
}

function requestQuery(request, name) {
  const direct = request.query?.[name];
  if (Array.isArray(direct)) return direct[0];
  if (direct !== undefined) return direct;
  return new URL(request.url ?? "/", "http://local.invalid")
    .searchParams.get(name);
}

export function createTransfersHandler({
  submitTransferFn = submitTransferToWorker,
  getTransferFn = getTransferFromWorker,
  clientKeyFn = publicClientKey,
} = {}) {
  return async function transfersHandler(request, response) {
    if (!["GET", "POST"].includes(request.method)) {
      methodNotAllowed(response, "GET, POST");
      return;
    }

    try {
      if (request.method === "GET") {
        const jobId = String(requestQuery(request, "jobId") ?? "");
        if (!jobId) {
          throw new PublicInputError("jobId is required", "invalid_job_id");
        }
        sendJson(response, 200, publicTransferResult(await getTransferFn(jobId)));
        return;
      }

      const body = parseBody(request);
      const sourceId = parseChinaLineupInput(String(body.source ?? ""));
      const result = publicTransferResult(await submitTransferFn(sourceId, {
        clientKey: clientKeyFn(request),
      }));
      sendJson(response, result.status === "queued" ? 202 : 200, result);
    } catch (error) {
      if (error instanceof TransferJobNotFoundError) {
        sendJson(response, 404, {
          error: {
            code: "transfer_job_not_found",
            message: "Transfer job was not found",
          },
        });
        return;
      }
      if (error instanceof TransferServiceUnavailableError) {
        sendJson(response, 503, {
          error: {
            code: "transfer_service_unavailable",
            message: "Transfer service is not connected yet",
          },
        });
        return;
      }
      if (error instanceof TransferRequestRejectedError) {
        if (error.retryAfter) response.setHeader("retry-after", error.retryAfter);
        sendJson(response, error.status, {
          error: {
            code: error.code,
            message: error.message,
            ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
          },
        });
        return;
      }
      errorResponse(response, error);
    }
  };
}
