import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import test from "node:test";

import {
  createAdminLoginLimiter,
  createAdminApiHandler,
  createAdminSessionHandler,
} from "../src/admin-http.mjs";

const ADMIN_TOKEN = "admin-token-with-at-least-thirty-two-characters";
const TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const TOTP_NOW = () => new Date("1970-01-01T00:00:59.000Z");
const TOTP_CODE = "287082";

function passwordHash(password) {
  const iterations = 100_000;
  const salt = Buffer.from("fixed-admin-test-salt").toString("base64url");
  const hash = pbkdf2Sync(
    password,
    Buffer.from(salt, "base64url"),
    iterations,
    32,
    "sha256",
  ).toString("base64url");
  return `pbkdf2_sha256$${iterations}$${salt}$${hash}`;
}

function responseRecorder() {
  const headers = new Map();
  return {
    statusCode: 0,
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    end(value = "") {
      this.body = value;
    },
    get headers() {
      return headers;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

function cookieFrom(response) {
  return response.headers.get("set-cookie").split(";", 1)[0];
}

test("creates an HttpOnly administrator session without returning the secret", async () => {
  const handler = createAdminSessionHandler({
    adminToken: ADMIN_TOKEN,
    secureCookies: true,
    now: () => new Date("2026-08-02T00:00:00.000Z"),
  });
  const response = responseRecorder();

  await handler(
    { method: "POST", body: { token: ADMIN_TOKEN }, headers: {} },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().authenticated, true);
  assert.match(response.json().csrfToken, /^[A-Za-z0-9_-]{20,}$/);
  assert.doesNotMatch(response.body, new RegExp(ADMIN_TOKEN));
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  assert.match(response.headers.get("set-cookie"), /SameSite=Strict/);
  assert.match(response.headers.get("set-cookie"), /Secure/);
});

test("rejects a wrong administrator credential", async () => {
  const handler = createAdminSessionHandler({ adminToken: ADMIN_TOKEN });
  const response = responseRecorder();
  await handler(
    { method: "POST", body: { token: "wrong-token" }, headers: {} },
    response,
  );
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "unauthorised");
});

test("requires both the administrator credential and a valid TOTP code", async () => {
  const handler = createAdminSessionHandler({
    adminToken: ADMIN_TOKEN,
    adminTotpSecret: TOTP_SECRET,
    now: TOTP_NOW,
    loginLimiter: createAdminLoginLimiter(),
  });

  const status = responseRecorder();
  await handler({ method: "GET", headers: {} }, status);
  assert.deepEqual(status.json(), {
    authenticated: false,
    totpRequired: true,
  });

  for (const body of [
    { token: ADMIN_TOKEN },
    { token: ADMIN_TOKEN, totp: "000000" },
    { token: "wrong-token", totp: TOTP_CODE },
  ]) {
    const rejected = responseRecorder();
    await handler({
      method: "POST",
      body,
      headers: { "x-vercel-forwarded-for": "203.0.113.10" },
    }, rejected);
    assert.equal(rejected.statusCode, 401);
    assert.deepEqual(rejected.json(), {
      error: {
        code: "unauthorised",
        message: "Invalid administrator credential",
      },
    });
  }

  const accepted = responseRecorder();
  await handler({
    method: "POST",
    body: { token: ADMIN_TOKEN, totp: TOTP_CODE },
    headers: { "x-vercel-forwarded-for": "203.0.113.11" },
  }, accepted);
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().authenticated, true);
  assert.equal(accepted.json().totpRequired, true);
});

test("rate-limits repeated administrator login failures per client", async () => {
  const now = () => new Date("2026-08-02T00:00:00.000Z");
  const handler = createAdminSessionHandler({
    adminToken: ADMIN_TOKEN,
    now,
    loginLimiter: createAdminLoginLimiter({ maxFailures: 2 }),
  });
  const request = {
    method: "POST",
    body: { token: "wrong-token" },
    headers: { "x-vercel-forwarded-for": "203.0.113.12" },
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const rejected = responseRecorder();
    await handler(request, rejected);
    assert.equal(rejected.statusCode, 401);
  }

  const limited = responseRecorder();
  await handler(request, limited);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, "too_many_attempts");
  assert.match(limited.headers.get("retry-after"), /^\d+$/);
});

test("does not let a client bypass login limits with spoofed forwarding headers", async () => {
  const handler = createAdminSessionHandler({
    adminToken: ADMIN_TOKEN,
    now: () => new Date("2026-08-02T00:00:00.000Z"),
    loginLimiter: createAdminLoginLimiter({ maxFailures: 1 }),
  });
  const request = (spoofed) => ({
    method: "POST",
    body: { token: "wrong-token" },
    headers: { "x-forwarded-for": spoofed },
    socket: { remoteAddress: "127.0.0.1" },
  });

  const first = responseRecorder();
  await handler(request("203.0.113.30"), first);
  assert.equal(first.statusCode, 401);

  const bypass = responseRecorder();
  await handler(request("203.0.113.31"), bypass);
  assert.equal(bypass.statusCode, 429);
});

test("enabling TOTP revokes a password-only administrator session", async () => {
  const passwordOnly = createAdminSessionHandler({
    adminToken: ADMIN_TOKEN,
    secureCookies: false,
    now: TOTP_NOW,
  });
  const login = responseRecorder();
  await passwordOnly(
    { method: "POST", body: { token: ADMIN_TOKEN }, headers: {} },
    login,
  );

  const totpProtected = createAdminSessionHandler({
    adminToken: ADMIN_TOKEN,
    adminTotpSecret: TOTP_SECRET,
    secureCookies: false,
    now: TOTP_NOW,
  });
  const restored = responseRecorder();
  await totpProtected(
    { method: "GET", headers: { cookie: cookieFrom(login) } },
    restored,
  );
  assert.deepEqual(restored.json(), {
    authenticated: false,
    totpRequired: true,
  });
});

test("rejects replaying a successful TOTP code within its validity window", async () => {
  const handler = createAdminSessionHandler({
    adminToken: ADMIN_TOKEN,
    adminTotpSecret: TOTP_SECRET,
    now: TOTP_NOW,
    loginLimiter: createAdminLoginLimiter(),
  });
  const body = { token: ADMIN_TOKEN, totp: TOTP_CODE };

  const first = responseRecorder();
  await handler({
    method: "POST",
    body,
    headers: { "x-vercel-forwarded-for": "203.0.113.20" },
  }, first);
  assert.equal(first.statusCode, 200);

  const replay = responseRecorder();
  await handler({
    method: "POST",
    body,
    headers: { "x-vercel-forwarded-for": "203.0.113.21" },
  }, replay);
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.json().error.code, "unauthorised");
});

test("fails closed when the configured TOTP secret is invalid", async () => {
  const handler = createAdminSessionHandler({
    adminToken: ADMIN_TOKEN,
    adminTotpSecret: "invalid!secret",
  });
  const response = responseRecorder();
  await handler({ method: "GET", headers: {} }, response);
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "admin_unconfigured");
});

test("accepts a password while storing only its PBKDF2 hash", async () => {
  const password = "local-test-password";
  const adminPasswordHash = passwordHash(password);
  const handler = createAdminSessionHandler({
    adminToken: null,
    adminPasswordHash,
    secureCookies: true,
    now: () => new Date("2026-08-02T00:00:00.000Z"),
  });
  const login = responseRecorder();

  await handler(
    { method: "POST", body: { token: password }, headers: {} },
    login,
  );

  assert.equal(login.statusCode, 200);
  assert.doesNotMatch(login.body, new RegExp(password));
  assert.doesNotMatch(login.headers.get("set-cookie"), new RegExp(password));

  const restored = responseRecorder();
  await handler(
    { method: "GET", headers: { cookie: cookieFrom(login) } },
    restored,
  );
  assert.equal(restored.json().authenticated, true);
});

test("protects dashboard reads and settings writes with session plus CSRF", async () => {
  const now = () => new Date("2026-08-02T00:00:00.000Z");
  const sessions = createAdminSessionHandler({
    adminToken: ADMIN_TOKEN,
    secureCookies: false,
    now,
  });
  const login = responseRecorder();
  await sessions(
    { method: "POST", body: { token: ADMIN_TOKEN }, headers: {} },
    login,
  );
  const cookie = cookieFrom(login);
  const csrfToken = login.json().csrfToken;
  let savedSettings;
  const handler = createAdminApiHandler({
    adminToken: ADMIN_TOKEN,
    now,
    fetchDashboardFn: async () => ({
      settings: { publicSubmissionsEnabled: false },
      stats: { pending: 0 },
      jobs: [],
    }),
    updateSettingsFn: async (settings) => {
      savedSettings = settings;
      return { ...settings, publicSubmissionsEnabled: true };
    },
  });

  const unauthorised = responseRecorder();
  await handler({ method: "GET", headers: {} }, unauthorised);
  assert.equal(unauthorised.statusCode, 401);

  const dashboard = responseRecorder();
  await handler(
    { method: "GET", headers: { cookie } },
    dashboard,
  );
  assert.equal(dashboard.statusCode, 200);
  assert.deepEqual(dashboard.json().jobs, []);

  const missingCsrf = responseRecorder();
  await handler(
    { method: "PUT", headers: { cookie }, body: { dailyAccountQuota: 8 } },
    missingCsrf,
  );
  assert.equal(missingCsrf.statusCode, 403);

  const saved = responseRecorder();
  await handler(
    {
      method: "PUT",
      headers: { cookie, "x-csrf-token": csrfToken },
      body: { dailyAccountQuota: 8 },
    },
    saved,
  );
  assert.deepEqual(savedSettings, { dailyAccountQuota: 8 });
  assert.equal(saved.json().settings.publicSubmissionsEnabled, true);
});

test("requires a TOTP-bound session for dashboard access", async () => {
  const sessions = createAdminSessionHandler({
    adminToken: ADMIN_TOKEN,
    adminTotpSecret: TOTP_SECRET,
    secureCookies: false,
    now: TOTP_NOW,
    loginLimiter: createAdminLoginLimiter(),
  });
  const login = responseRecorder();
  await sessions({
    method: "POST",
    body: { token: ADMIN_TOKEN, totp: TOTP_CODE },
    headers: {},
  }, login);

  const handler = createAdminApiHandler({
    adminToken: ADMIN_TOKEN,
    adminTotpSecret: TOTP_SECRET,
    now: TOTP_NOW,
    fetchDashboardFn: async () => ({ settings: {}, stats: {}, jobs: [] }),
  });
  const dashboard = responseRecorder();
  await handler({
    method: "GET",
    headers: { cookie: cookieFrom(login) },
  }, dashboard);
  assert.equal(dashboard.statusCode, 200);
});

test("restores a valid session without exposing the administrator token", async () => {
  const now = () => new Date("2026-08-02T00:00:00.000Z");
  const handler = createAdminSessionHandler({
    adminToken: ADMIN_TOKEN,
    secureCookies: false,
    now,
  });
  const login = responseRecorder();
  await handler(
    { method: "POST", body: { token: ADMIN_TOKEN }, headers: {} },
    login,
  );
  const restored = responseRecorder();
  await handler(
    { method: "GET", headers: { cookie: cookieFrom(login) } },
    restored,
  );
  assert.equal(restored.json().authenticated, true);
  assert.equal(restored.json().csrfToken, login.json().csrfToken);
  assert.doesNotMatch(restored.body, new RegExp(ADMIN_TOKEN));
});
