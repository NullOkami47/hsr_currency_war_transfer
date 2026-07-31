import {
  fetchChinaRoleOptions,
  searchChinaStrategies,
} from "./search.mjs";
import { parseChinaLineupInput } from "./api.mjs";

const PUBLIC_SEARCH_LIMITS = Object.freeze({
  maxPages: 10,
  pageSize: 20,
});

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
  const isInputError = error instanceof TypeError;
  sendJson(response, isInputError ? 400 : 502, {
    error: {
      code: isInputError ? "invalid_request" : "china_service_error",
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

function parseBody(request) {
  if (
    request.body &&
    typeof request.body === "object" &&
    !Buffer.isBuffer(request.body)
  ) {
    return request.body;
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
    throw new TypeError("Request body must be valid JSON");
  }
}

function boundedInteger(value, fallback, maximum, field) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new TypeError(`${field} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

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
} = {}) {
  return async function searchHandler(request, response) {
    if (request.method !== "POST") {
      methodNotAllowed(response, "POST");
      return;
    }

    try {
      const body = parseBody(request);
      const roleIds = Array.isArray(body.roleIds) ? body.roleIds : [];
      if (body.roleIds !== undefined && !Array.isArray(body.roleIds)) {
        throw new TypeError("roleIds must be an array");
      }

      const result = await searchChinaStrategiesFn({
        source: body.source,
        keyword: body.keyword,
        authorKeyword: body.authorKeyword,
        roleIds,
        maxPages: boundedInteger(
          body.maxPages,
          PUBLIC_SEARCH_LIMITS.maxPages,
          PUBLIC_SEARCH_LIMITS.maxPages,
          "maxPages",
        ),
        pageSize: boundedInteger(
          body.pageSize,
          10,
          PUBLIC_SEARCH_LIMITS.pageSize,
          "pageSize",
        ),
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
  ]);
  const status = String(value?.status ?? "queued");
  if (!allowedStatuses.has(status)) {
    throw new Error("Transfer worker returned an unsupported status");
  }

  return {
    status,
    jobId: value?.jobId ? String(value.jobId) : null,
    globalId: value?.globalId ? String(value.globalId) : null,
    shareCode: value?.shareCode ? String(value.shareCode) : null,
    ignored: Array.isArray(value?.ignored)
      ? value.ignored.map((item) => ({
          type: String(item?.type ?? "unknown"),
          id: String(item?.id ?? ""),
          reason: String(item?.reason ?? "unknown"),
        }))
      : [],
  };
}

export async function submitTransferToWorker(
  sourceId,
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
    response = await fetchFn(workerUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${workerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sourceId }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    throw new TransferServiceUnavailableError(
      "Transfer worker could not be reached",
      { cause: error },
    );
  }

  if (!response.ok) {
    throw new TransferServiceUnavailableError(
      `Transfer worker returned HTTP ${response.status}`,
    );
  }
  return publicTransferResult(await response.json());
}

export function createTransfersHandler({
  submitTransferFn = submitTransferToWorker,
} = {}) {
  return async function transfersHandler(request, response) {
    if (request.method !== "POST") {
      methodNotAllowed(response, "POST");
      return;
    }

    try {
      const body = parseBody(request);
      const sourceId = parseChinaLineupInput(String(body.source ?? ""));
      const result = await submitTransferFn(sourceId);
      sendJson(response, result.status === "queued" ? 202 : 200, result);
    } catch (error) {
      if (error instanceof TransferServiceUnavailableError) {
        sendJson(response, 503, {
          error: {
            code: "transfer_service_unavailable",
            message: "Transfer service is not connected yet",
          },
        });
        return;
      }
      errorResponse(response, error);
    }
  };
}
