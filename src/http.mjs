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
  const inputReason = classifyInputError(error);
  const isInputError = Boolean(inputReason);
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

function classifyInputError(error) {
  if (!(error instanceof TypeError)) return null;
  const message = String(error.message ?? "");
  if (/^Unknown China role ids?:/.test(message)) return "stale_role_ids";
  if (
    /^(Invalid lineup id:|Input is neither a lineup id nor a valid URL|Only act\.miyoushe\.com lineup URLs are accepted|The URL does not contain a directly readable China lineup id)/.test(
      message,
    )
  ) {
    return "invalid_source";
  }
  if (/^Provide a China strategy/.test(message)) return "missing_criteria";
  if (/^(maxPages|pageSize) must be an integer/.test(message)) {
    return "invalid_pagination";
  }
  if (/^roleIds must be an array$/.test(message)) return "invalid_roles";
  if (/^Request body must be valid JSON$/.test(message)) return "invalid_request";
  return null;
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
    "failed",
  ]);
  const status = String(value?.status ?? "queued");
  if (!allowedStatuses.has(status)) {
    throw new Error("Transfer worker returned an unsupported status");
  }

  const rawShareCode = String(value?.shareCode ?? "");
  const shareCode = rawShareCode
    ? rawShareCode.startsWith("##") && rawShareCode.endsWith("##")
      ? rawShareCode
      : `##${rawShareCode}##`
    : null;

  return {
    status,
    jobId: value?.jobId ? String(value.jobId) : null,
    globalId: value?.globalId ? String(value.globalId) : null,
    shareCode,
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

function workerJobUrl(workerUrl, jobId) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(jobId)) {
    throw new TypeError("jobId is invalid");
  }
  const url = new URL(workerUrl);
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
} = {}) {
  return async function transfersHandler(request, response) {
    if (!["GET", "POST"].includes(request.method)) {
      methodNotAllowed(response, "GET, POST");
      return;
    }

    try {
      if (request.method === "GET") {
        const jobId = String(requestQuery(request, "jobId") ?? "");
        if (!jobId) throw new TypeError("jobId is required");
        sendJson(response, 200, publicTransferResult(await getTransferFn(jobId)));
        return;
      }

      const body = parseBody(request);
      const sourceId = parseChinaLineupInput(String(body.source ?? ""));
      const result = publicTransferResult(await submitTransferFn(sourceId));
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
      errorResponse(response, error);
    }
  };
}
