import {
  createHash,
  createHmac,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { validatedWorkerUrl } from "./http.mjs";
import { requestAddress } from "./request-address.mjs";
import { createMemorySessionStore } from "./security-state.mjs";
import { decodeTotpSecret, verifyTotpCode } from "./totp.mjs";

const SESSION_COOKIE = "currency_war_admin";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOCAL_ADMIN_CLIENT_HASH_SECRET = randomBytes(32);
const localSessionStore = createMemorySessionStore();
function defaultSessionStore(production) {
  return production || process.env.CURRENCY_WAR_WORKER_URL
    ? createWorkerSessionStore() : localSessionStore;
}
function authUnavailable(response) {
  sendJson(response, 503, { error: { code: "admin_auth_unavailable", message: "Administrator authentication is temporarily unavailable" } });
}

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

function configuredTotp(secret) {
  const value = String(secret ?? "").trim();
  if (!value) return { required: false, secret: null, key: null, invalid: false };
  try {
    return {
      required: true,
      secret: value,
      key: decodeTotpSecret(value),
      invalid: false,
    };
  } catch {
    return { required: true, secret: null, key: null, invalid: true };
  }
}

function productionTotpMissing(totp, production, allowPasswordOnlyProduction) {
  return production && !allowPasswordOnlyProduction && !totp.required;
}

function sessionCredentials(credentials, totp) {
  return credentials.map((credential) => ({
    ...credential,
    sessionSecret: totp.required
      ? createHmac("sha256", credential.secret)
          .update("currency-war-admin-totp-session\0")
          .update(totp.key)
          .digest("base64url")
      : credential.secret,
  }));
}

function loginClientKey(request, secret, addressOptions) {
  return createHmac("sha256", secret)
    .update("currency-war-admin-login-client\0")
    .update(requestAddress(request, addressOptions))
    .digest("base64url");
}

export function verifyAdministratorCredentials(credentials, supplied) {
  let matched = null;
  for (const credential of credentials) {
    const valid = credential.verify(supplied);
    if (valid && !matched) matched = credential;
  }
  return matched;
}

export function createAdminLoginLimiter({
  maxFailures = LOGIN_MAX_FAILURES,
  windowMs = LOGIN_WINDOW_MS,
  maxEntries = 5_000,
} = {}) {
  if (
    !Number.isInteger(maxFailures) || maxFailures < 1
    || !Number.isInteger(windowMs) || windowMs < 1
    || !Number.isInteger(maxEntries) || maxEntries < 1
  ) {
    throw new TypeError("Administrator login limiter options are invalid");
  }
  const attempts = new Map();

  function activeEntry(key, nowMs) {
    const entry = attempts.get(key);
    if (!entry || entry.resetAt <= nowMs) {
      attempts.delete(key);
      return null;
    }
    return entry;
  }

  return {
    retryAfter(key, nowMs) {
      const entry = activeEntry(key, nowMs);
      return entry && entry.failures >= maxFailures
        ? Math.max(1, Math.ceil((entry.resetAt - nowMs) / 1000))
        : 0;
    },
    failure(key, nowMs) {
      const entry = activeEntry(key, nowMs) ?? {
        failures: 0,
        resetAt: nowMs + windowMs,
      };
      entry.failures += 1;
      attempts.delete(key);
      attempts.set(key, entry);
      while (attempts.size > maxEntries) {
        attempts.delete(attempts.keys().next().value);
      }
    },
    success(key) {
      attempts.delete(key);
    },
  };
}

const defaultAdminLoginLimiter = createAdminLoginLimiter();

export function createAdminTotpReplayStore({ maxEntries = 5_000 } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError("Administrator TOTP replay-store options are invalid");
  }
  const usedOtps = new Map();
  return {
    consume(fingerprint, nowMs, expiresAt) {
      for (const [key, expiry] of usedOtps) {
        if (expiry <= nowMs) usedOtps.delete(key);
      }
      if ((usedOtps.get(fingerprint) ?? 0) > nowMs) return false;
      usedOtps.delete(fingerprint);
      usedOtps.set(fingerprint, expiresAt);
      while (usedOtps.size > maxEntries) {
        usedOtps.delete(usedOtps.keys().next().value);
      }
      return true;
    },
  };
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
    sessionId: randomBytes(32).toString("base64url"),
  })).toString("base64url");
  return {
    value: `${payload}.${sign(payload, token)}`,
    payload: JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
  };
}

async function verifySession(request, credentials, now, sessionStore, requireActive = true) {
  const value = parseCookies(request)[SESSION_COOKIE];
  if (!value || value.length > 2048) return null;
  const [payload, suppliedSignature, extra] = value.split(".");
  if (!payload || !suppliedSignature || extra) return null;
  if (!credentials.some(({ sessionSecret }) =>
    sameSecret(sign(payload, sessionSecret), suppliedSignature))) return null;
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!Number.isFinite(decoded.expiresAt) || decoded.expiresAt <= now.getTime()
        || !/^[A-Za-z0-9_-]{20,100}$/.test(decoded.csrfToken)
        || !/^[A-Za-z0-9_-]{32,100}$/.test(decoded.sessionId)) return null;
  } catch { return null; }
  // Storage/transport failures propagate to a 503, never an authenticated result.
  if (requireActive && !await sessionStore.isActive(decoded.sessionId, now.getTime())) return null;
  return decoded;
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
  adminTotpSecret = process.env.CURRENCY_WAR_ADMIN_TOTP_SECRET,
  production = process.env.NODE_ENV === "production" || process.env.VERCEL === "1",
  allowPasswordOnlyProduction =
    process.env.CURRENCY_WAR_ADMIN_ALLOW_PASSWORD_ONLY_PRODUCTION === "1",
  secureCookies = process.env.NODE_ENV === "production" || process.env.VERCEL === "1",
  now = () => new Date(),
  loginLimiter = defaultAdminLoginLimiter,
  totpReplayStore = createAdminTotpReplayStore(),
  clientHashSecret = process.env.CURRENCY_WAR_ADMIN_CLIENT_HASH_SECRET
    ?? adminToken
    ?? adminPasswordHash
    ?? LOCAL_ADMIN_CLIENT_HASH_SECRET,
  requestAddressOptions,
  sessionStore = defaultSessionStore(production),
} = {}) {
  if (
    !sessionStore
    || typeof sessionStore.register !== "function"
    || typeof sessionStore.isActive !== "function"
    || typeof sessionStore.revoke !== "function"
    || !loginLimiter
    || typeof loginLimiter.retryAfter !== "function"
    || typeof loginLimiter.failure !== "function"
    || typeof loginLimiter.success !== "function"
    || !totpReplayStore
    || typeof totpReplayStore.consume !== "function"
  ) {
    throw new TypeError("Administrator rate-limit stores are invalid");
  }
  return async function adminSessionHandler(request, response) {
    const configuredCredentials = configuredAdminCredentials(
      adminToken,
      adminPasswordHash,
    );
    const totp = configuredTotp(adminTotpSecret);
    if (
      configuredCredentials.length === 0
      || totp.invalid
      || productionTotpMissing(totp, production, allowPasswordOnlyProduction)
    ) {
      sendJson(response, 503, {
        error: {
          code: "admin_unconfigured",
          message: "Administrator access is not configured",
        },
      });
      return;
    }
    const credentials = sessionCredentials(configuredCredentials, totp);

    if (!['GET', 'POST', 'DELETE'].includes(request.method)) {
      methodNotAllowed(response, "GET, POST, DELETE");
      return;
    }

    if (request.method === "POST") {
      let body;
      try {
        body = parseBody(request);
      } catch (error) {
        sendJson(response, 400, {
          error: { code: "invalid_request", message: error.message },
        });
        return;
      }
      try {
        const nowValue = now();
        const clientKey = loginClientKey(
          request,
          clientHashSecret,
          requestAddressOptions,
        );
        const retryAfter = await loginLimiter.retryAfter(
          clientKey,
          nowValue.getTime(),
        );
        if (retryAfter) {
          response.setHeader("retry-after", String(retryAfter));
          sendJson(response, 429, {
            error: {
              code: "too_many_attempts",
              message: "Too many administrator sign-in attempts",
              retryAfter,
            },
          });
          return;
        }
        const credential = verifyAdministratorCredentials(
          credentials,
          body.token,
        );
        const totpValid = !totp.required || verifyTotpCode(
          totp.secret,
          body.totp,
          { now: nowValue },
        );
        const totpFresh = !totp.required || !credential || !totpValid
          ? !totp.required
          : await totpReplayStore.consume(
              createHmac("sha256", totp.key)
                .update("currency-war-admin-used-totp\0")
                .update(String(body.totp))
                .digest("base64url"),
              nowValue.getTime(),
              nowValue.getTime() + 90_000,
            );
        if (!credential || !totpValid || !totpFresh) {
          await loginLimiter.failure(clientKey, nowValue.getTime());
          sendJson(response, 401, {
            error: { code: "unauthorised", message: "Invalid administrator credential" },
          });
          return;
        }
        await loginLimiter.success(clientKey);
        const session = createSession(credential.sessionSecret, nowValue);
        await sessionStore.register(session.payload.sessionId, session.payload.expiresAt, nowValue.getTime());
        response.setHeader("set-cookie", cookie(session.value, { secureCookies }));
        sendJson(response, 200, {
          authenticated: true,
          totpRequired: totp.required,
          csrfToken: session.payload.csrfToken,
          expiresAt: new Date(session.payload.expiresAt).toISOString(),
        });
      } catch {
        sendJson(response, 503, {
          error: {
            code: "admin_auth_unavailable",
            message: "Administrator authentication is temporarily unavailable",
          },
        });
      }
      return;
    }

    let session;
    try {
      session = await verifySession(request, credentials, now(), sessionStore, request.method !== "DELETE");
    } catch { authUnavailable(response); return; }
    if (request.method === "DELETE") {
      if (!session || !sameSecret(session.csrfToken, request.headers?.["x-csrf-token"])) {
        sendJson(response, 403, {
          error: { code: "csrf_failed", message: "Administrator request could not be verified" },
        });
        return;
      }
      try { await sessionStore.revoke(session.sessionId, now().getTime()); }
      catch { authUnavailable(response); return; }
      response.setHeader("set-cookie", cookie("", { secureCookies, maxAge: 0 }));
      sendJson(response, 200, { authenticated: false });
      return;
    }

    sendJson(response, 200, session
      ? {
          authenticated: true,
          totpRequired: totp.required,
          csrfToken: session.csrfToken,
          expiresAt: new Date(session.expiresAt).toISOString(),
        }
      : { authenticated: false, totpRequired: totp.required });
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

export function createWorkerSessionStore(options = {}) {
  async function operation(action, id, expiresAt) {
    const result = await workerAdminRequest("POST", { action, id, ...(expiresAt === undefined ? {} : { expiresAt }) }, options);
    if (typeof result?.active !== "boolean") throw new Error("Invalid worker session response");
    return result.active;
  }
  return {
    async register(id, expiresAt) {
      if (!await operation("session.register", id, expiresAt)) throw new Error("Session registration failed");
    },
    isActive(id) { return operation("session.check", id); },
    async revoke(id) {
      if (await operation("session.revoke", id)) throw new Error("Session revocation failed");
    },
  };
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
  adminTotpSecret = process.env.CURRENCY_WAR_ADMIN_TOTP_SECRET,
  production = process.env.NODE_ENV === "production" || process.env.VERCEL === "1",
  allowPasswordOnlyProduction =
    process.env.CURRENCY_WAR_ADMIN_ALLOW_PASSWORD_ONLY_PRODUCTION === "1",
  now = () => new Date(),
  fetchDashboardFn = fetchWorkerDashboard,
  updateSettingsFn = updateWorkerSettings,
  sessionStore = defaultSessionStore(production),
} = {}) {
  return async function adminApiHandler(request, response) {
    const configuredCredentials = configuredAdminCredentials(
      adminToken,
      adminPasswordHash,
    );
    const totp = configuredTotp(adminTotpSecret);
    if (
      configuredCredentials.length === 0
      || totp.invalid
      || productionTotpMissing(totp, production, allowPasswordOnlyProduction)
    ) {
      sendJson(response, 503, {
        error: { code: "admin_unconfigured", message: "Administrator access is not configured" },
      });
      return;
    }
    const credentials = sessionCredentials(configuredCredentials, totp);
    if (!['GET', 'PUT'].includes(request.method)) {
      methodNotAllowed(response, "GET, PUT");
      return;
    }
    let session;
    try { session = await verifySession(request, credentials, now(), sessionStore); }
    catch { authUnavailable(response); return; }
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
