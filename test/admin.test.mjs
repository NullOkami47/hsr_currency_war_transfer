import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import test from "node:test";

import {
  createAdminApiHandler,
  createAdminSessionHandler,
} from "../src/admin-http.mjs";

const ADMIN_TOKEN = "admin-token-with-at-least-thirty-two-characters";

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
