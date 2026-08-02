import {
  createHash,
  createHmac,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { validatedWorkerUrl } from "./http.mjs";

const SESSION_COOKIE = "currency_war_admin";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

function sameSecret(expected, supplied) {
  const digest = (value) => createHash("sha256")
    .update(String(value ?? ""))
    .digest();
  return timingSafeEqual(digest(expected), digest(supplied));
}

function configuredAdminToken(token) {
  if (!token || String(token).length < 32) return null;
  return String(token);
}

function passwordCredential(encoded) {
  const [algorithm, iterationsText, salt, expected] = String(encoded ?? "")
    .split("$");
  const iterations = Number(iterationsText);
  if (
    algorithm !== "pbkdf2_sha256"
    || !Number.isInteger(iterations)
    || iterations < 100_000
    || iterations > 2_000_000
    || !/^[A-Za-z0-9_-]{16,}$/.test(salt)
    || !/^[A-Za-z0-9_-]{40,}$/.test(expected)
  ) {
    return null;
  }
  return {
    secret: String(encoded),
    verify(supplied) {
      const password = String(supplied ?? "");
      if (!password || password.length > 1024) return false;
      const actual = pbkdf2Sync(
        password,
        Buffer.from(salt, "base64url"),
        iterations,
        32,
        "sha256",
      ).toString("base64url");
      return sameSecret(expected, actual);
    },
  };
}

function configuredAdminCredentials(adminToken, adminPasswordHash) {
  const credentials = [];
  const token = configuredAdminToken(adminToken);
  if (token) {
    credentials.push({
      secret: token,
      verify: (supplied) => sameSecret(token, supplied),
    });
  }
  const password = passwordCredential(adminPasswordHash);
  if (password) credentials.push(password);
  return credentials;
}

function parseCookies(request) {
  return Object.fromEntries(
    String(request.headers?.cookie ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        return separator < 0
          ? [part, ""]
          : [part.slice(0, separator), part.slice(separator + 1)];
      }),
  );
}

function sign(value, token) {
  return createHmac("sha256", token).update(value).digest("base64url");
}

function createSession(token, now) {
  const payload = Buffer.from(JSON.stringify({
    expiresAt: now.getTime() + SESSION_TTL_SECONDS * 1000,
    csrfToken: randomBytes(24).toString("base64url"),
  })).toString("base64url");
  return {
    value: `${payload}.${sign(payload, token)}`,
    payload: JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
  };
}

function verifySession(request, credentials, now) {
  const value = parseCookies(request)[SESSION_COOKIE];
  if (!value) return null;
  const [payload, suppliedSignature, extra] = value.split(".");
  if (!payload || !suppliedSignature || extra) return null;
  if (!credentials.some(({ secret }) =>
    sameSecret(sign(payload, secret), suppliedSignature))) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      !Number.isFinite(decoded.expiresAt)
      || decoded.expiresAt <= now.getTime()
      || !/^[A-Za-z0-9_-]{20,}$/.test(decoded.csrfToken)
    ) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function cookie(value, { secureCookies, maxAge = SESSION_TTL_SECONDS }) {
  return [
    `${SESSION_COOKIE}=${value}`,
    "Path=/api/admin",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(secureCookies ? ["Secure"] : []),
  ].join("; ");
}

function parseBody(request, maximumBytes = 65_536) {
  if (request.body && typeof request.body === "object") {
    if (Buffer.byteLength(JSON.stringify(request.body)) > maximumBytes) {
      throw new TypeError("Request body is too large");
    }
    return request.body;
  }
  const raw = Buffer.isBuffer(request.body)
    ? request.body.toString("utf8")
    : String(request.body ?? "");
  if (Buffer.byteLength(raw) > maximumBytes) {
    throw new TypeError("Request body is too large");
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new TypeError("Request body must be valid JSON");
  }
}

function methodNotAllowed(response, allowed) {
  response.setHeader("allow", allowed);
  sendJson(response, 405, {
    error: { code: "method_not_allowed", message: `Use ${allowed}` },
  });
}

export function createAdminSessionHandler({
  adminToken = process.env.CURRENCY_WAR_ADMIN_TOKEN,
  adminPasswordHash = process.env.CURRENCY_WAR_ADMIN_PASSWORD_HASH,
  secureCookies = process.env.NODE_ENV === "production" || process.env.VERCEL === "1",
  now = () => new Date(),
} = {}) {
  return async function adminSessionHandler(request, response) {
    const credentials = configuredAdminCredentials(
      adminToken,
      adminPasswordHash,
    );
    if (credentials.length === 0) {
      sendJson(response, 503, {
        error: {
          code: "admin_unconfigured",
          message: "Administrator access is not configured",
        },
      });
      return;
    }

    if (!['GET', 'POST', 'DELETE'].includes(request.method)) {
      methodNotAllowed(response, "GET, POST, DELETE");
      return;
    }

    if (request.method === "POST") {
      try {
        const body = parseBody(request);
        const credential = credentials.find(({ verify }) => verify(body.token));
        if (!credential) {
          sendJson(response, 401, {
            error: { code: "unauthorised", message: "Invalid administrator credential" },
          });
          return;
        }
        const session = createSession(credential.secret, now());
        response.setHeader("set-cookie", cookie(session.value, { secureCookies }));
        sendJson(response, 200, {
          authenticated: true,
          csrfToken: session.payload.csrfToken,
          expiresAt: new Date(session.payload.expiresAt).toISOString(),
        });
      } catch (error) {
        sendJson(response, 400, {
          error: { code: "invalid_request", message: error.message },
        });
      }
      return;
    }

    const session = verifySession(request, credentials, now());
    if (request.method === "DELETE") {
      if (!session || !sameSecret(session.csrfToken, request.headers?.["x-csrf-token"])) {
        sendJson(response, 403, {
          error: { code: "csrf_failed", message: "Administrator request could not be verified" },
        });
        return;
      }
      response.setHeader("set-cookie", cookie("", { secureCookies, maxAge: 0 }));
      sendJson(response, 200, { authenticated: false });
      return;
    }

    sendJson(response, 200, session
      ? {
          authenticated: true,
          csrfToken: session.csrfToken,
          expiresAt: new Date(session.expiresAt).toISOString(),
        }
      : { authenticated: false });
  };
}

class WorkerAdminError extends Error {
  constructor(message, { status = 502, code = "worker_admin_error" } = {}) {
    super(message);
    this.name = "WorkerAdminError";
    this.status = status;
    this.code = code;
  }
}

function workerAdminUrl(workerUrl) {
  const url = validatedWorkerUrl(workerUrl);
  url.pathname = `${url.pathname.replace(/\/jobs\/?$/, "").replace(/\/$/, "")}/admin`;
  url.search = "";
  return url.toString();
}

async function workerAdminRequest(method, body, {
  workerUrl = process.env.CURRENCY_WAR_WORKER_URL,
  workerToken = process.env.CURRENCY_WAR_WORKER_TOKEN,
  fetchFn = fetch,
} = {}) {
  if (!workerUrl || !workerToken) {
    throw new WorkerAdminError("Administrator worker is not configured", {
      status: 503,
      code: "worker_unavailable",
    });
  }
  let response;
  try {
    response = await fetchFn(workerAdminUrl(workerUrl), {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${workerToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (error instanceof WorkerAdminError) throw error;
    throw new WorkerAdminError("Administrator worker could not be reached", {
      status: 503,
      code: "worker_unavailable",
    });
  }
  let result = {};
  try {
    result = await response.json();
  } catch {}
  if (!response.ok) {
    throw new WorkerAdminError(
      String(result?.error?.message ?? "Administrator worker rejected the request"),
      {
        status: [400, 403, 429].includes(response.status) ? response.status : 502,
        code: String(result?.error?.code ?? "worker_admin_error"),
      },
    );
  }
  return result;
}

export function fetchWorkerDashboard(options) {
  return workerAdminRequest("GET", undefined, options);
}

export async function updateWorkerSettings(settings, options) {
  return workerAdminRequest("PUT", settings, options);
}

export function createAdminApiHandler({
  adminToken = process.env.CURRENCY_WAR_ADMIN_TOKEN,
  adminPasswordHash = process.env.CURRENCY_WAR_ADMIN_PASSWORD_HASH,
  now = () => new Date(),
  fetchDashboardFn = fetchWorkerDashboard,
  updateSettingsFn = updateWorkerSettings,
} = {}) {
  return async function adminApiHandler(request, response) {
    const credentials = configuredAdminCredentials(
      adminToken,
      adminPasswordHash,
    );
    if (credentials.length === 0) {
      sendJson(response, 503, {
        error: { code: "admin_unconfigured", message: "Administrator access is not configured" },
      });
      return;
    }
    if (!['GET', 'PUT'].includes(request.method)) {
      methodNotAllowed(response, "GET, PUT");
      return;
    }
    const session = verifySession(request, credentials, now());
    if (!session) {
      sendJson(response, 401, {
        error: { code: "unauthorised", message: "Administrator sign-in is required" },
      });
      return;
    }
    if (
      request.method === "PUT"
      && !sameSecret(session.csrfToken, request.headers?.["x-csrf-token"])
    ) {
      sendJson(response, 403, {
        error: { code: "csrf_failed", message: "Administrator request could not be verified" },
      });
      return;
    }
    try {
      if (request.method === "GET") {
        sendJson(response, 200, await fetchDashboardFn());
      } else {
        const settings = await updateSettingsFn(parseBody(request));
        sendJson(response, 200, settings?.settings ? settings : { settings });
      }
    } catch (error) {
      const status = error instanceof WorkerAdminError
        ? error.status
        : error instanceof TypeError ? 400 : 502;
      sendJson(response, status, {
        error: {
          code: error.code ?? (status === 400 ? "invalid_request" : "worker_admin_error"),
          message: status >= 500
            ? "Administrator worker is unavailable"
            : error.message,
        },
      });
    }
  };
}
