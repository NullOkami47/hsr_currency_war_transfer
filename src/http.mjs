import { createHmac } from "node:crypto";

import {
  fetchChinaRoleOptions,
  searchChinaStrategies,
} from "./search.mjs";
import { parseChinaLineupInput } from "./api.mjs";
import { PublicInputError } from "./errors.mjs";

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
    if (Buffer.byteLength(serialised) > 65_536) {
      throw new PublicInputError("Request body is too large", "request_too_large");
    }
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
        throw new PublicInputError("roleIds must be an array", "invalid_roles");
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

  return {
    status,
    jobId: value?.jobId ? String(value.jobId) : null,
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

function requestAddress(request) {
  const forwarded = request.headers?.["x-vercel-forwarded-for"]
    ?? (process.env.CURRENCY_WAR_TRUST_PROXY === "1"
      ? request.headers?.["x-forwarded-for"]
      : undefined);
  const candidate = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return String(candidate ?? request.socket?.remoteAddress ?? "unknown")
    .split(",", 1)[0]
    .trim()
    .slice(0, 200);
}

export function publicClientKey(
  request,
  secret = process.env.CURRENCY_WAR_CLIENT_HASH_SECRET
    ?? process.env.CURRENCY_WAR_WORKER_TOKEN,
) {
  if (!secret) return "anonymous";
  return createHmac("sha256", secret)
    .update(requestAddress(request))
    .digest("hex");
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
