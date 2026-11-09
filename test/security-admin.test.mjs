import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import test from "node:test";
import { createAdminSessionHandler, createAdminApiHandler, createWorkerSessionStore } from "../src/admin-http.mjs";
import { JsonSecurityStore, createMemorySessionStore, ADMIN_SESSION_TTL_MS, ADMIN_SESSION_CLOCK_SKEW_MS } from "../src/security-state.mjs";
import { createWorkerHandler } from "../src/worker.mjs";

const TOKEN = "synthetic-administrator-token-for-tests-only";
const WORKER_TOKEN = "synthetic-worker-token-for-session-tests-only";
function response() {
  return { headers: {}, setHeader(k,v) { this.headers[k.toLowerCase()] = v; },
    end(body) { this.body = JSON.parse(body); } };
}
async function call(handler, request) {
  const res = response();
  await handler({ headers: {}, ...request }, res);
  return res;
}
function factory(sessionStore, extra = {}) {
  const options = { adminToken: TOKEN, adminTotpSecret: "", production: false, secureCookies: false, sessionStore, ...extra };
  return { session: createAdminSessionHandler(options), api: createAdminApiHandler({ ...options, fetchDashboardFn: async () => ({ settings: {} }), updateSettingsFn: async () => ({ settings: {} }) }) };
}
async function login(handler) {
  const result = await call(handler, { method: "POST", body: { token: TOKEN } });
  assert.equal(result.statusCode, 200);
  return { cookie: result.headers["set-cookie"].split(";")[0], "x-csrf-token": result.body.csrfToken };
}

test("F5 copied sessions are revoked across API instances and persistent worker restarts", async t => {
  const dir = await mkdtemp(join(tmpdir(), "hsr-session-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "security.json");
  let worker = createWorkerHandler({ queue: {}, token: WORKER_TOKEN, securityStore: new JsonSecurityStore(path) });
  let requests = 0;
  const remote = () => createWorkerSessionStore({
    workerUrl: "http://127.0.0.1/jobs", workerToken: WORKER_TOKEN,
    fetchFn: async (url, options) => {
      requests++;
      assert.equal(new URL(url).pathname, "/admin");
      const res = await call(worker, { method: options.method, url: new URL(url).pathname, headers: options.headers, body: JSON.parse(options.body) });
      return { ok: res.statusCode < 400, status: res.statusCode, json: async () => res.body };
    },
  });
  const first = factory(remote());
  const headers = await login(first.session);
  assert.equal((await call(factory(remote()).api, { method: "GET", headers })).statusCode, 200);
  const logout = await call(first.session, { method: "DELETE", headers });
  assert.equal(logout.statusCode, 200);
  assert.match(logout.headers["set-cookie"], /Max-Age=0/);
  worker = createWorkerHandler({ queue: {}, token: WORKER_TOKEN, securityStore: new JsonSecurityStore(path) });
  const restarted = factory(remote());
  assert.equal((await call(restarted.session, { method: "GET", headers })).body.authenticated, false);
  assert.equal((await call(restarted.api, { method: "GET", headers })).statusCode, 401);
  assert.equal((await call(restarted.api, { method: "PUT", headers, body: {} })).statusCode, 401);
  // A lost response can be retried safely after the first revoke committed.
  assert.equal((await call(restarted.session, { method: "DELETE", headers })).statusCode, 200);
  assert.ok(requests >= 7);
});

test("F5 successful logout only revokes the selected session", async () => {
  const { session, api } = factory(createMemorySessionStore());
  const one = await login(session), two = await login(session);
  assert.notEqual(one.cookie, two.cookie);
  assert.equal((await call(session, { method: "DELETE", headers: one })).statusCode, 200);
  assert.equal((await call(api, { method: "GET", headers: one })).statusCode, 401);
  assert.equal((await call(api, { method: "GET", headers: two })).statusCode, 200);
});

test("F5 logout requires CSRF before attempting server-side revocation", async () => {
  const state = createMemorySessionStore();
  let revocations = 0;
  const { session, api } = factory({ ...state, revoke: (...args) => { revocations++; return state.revoke(...args); } });
  const headers = await login(session);
  const res = await call(session, { method: "DELETE", headers: { cookie: headers.cookie } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.headers["set-cookie"], undefined);
  assert.equal(revocations, 0);
  assert.equal((await call(api, { method: "GET", headers })).statusCode, 200);
});

test("F5 revoke failure preserves the cookie and returns a sanitised failure", async () => {
  const state = createMemorySessionStore();
  const { session } = factory({ ...state, revoke: async () => { throw new Error("private-session-store-details"); } });
  const headers = await login(session);
  const res = await call(session, { method: "DELETE", headers });
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["set-cookie"], undefined);
  assert.notEqual(res.body.authenticated, false);
  assert.doesNotMatch(JSON.stringify(res.body), /private-session-store/);
});

test("F5 registration and validation failures never issue or accept a session", async () => {
  const state = createMemorySessionStore();
  const failedRegister = factory({ ...state, register: async () => { throw new Error("private-register-error"); } });
  const res = await call(failedRegister.session, { method: "POST", body: { token: TOKEN } });
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["set-cookie"], undefined);
  const working = factory(state);
  const headers = await login(working.session);
  const failedRead = factory({ ...state, isActive: async () => { throw new Error("private-read-error"); } });
  assert.equal((await call(failedRead.session, { method: "GET", headers })).statusCode, 503);
  assert.equal((await call(failedRead.api, { method: "GET", headers })).statusCode, 503);
});

test("F5 production fails closed when the shared worker session store is unconfigured", async () => {
  const { session } = factory(createWorkerSessionStore({ workerUrl: "", workerToken: "" }), {
    production: true, allowPasswordOnlyProduction: true,
  });
  const res = await call(session, { method: "POST", body: { token: TOKEN } });
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["set-cookie"], undefined);
});

test("F5 legacy stateless cookies cannot bypass the active-session registry", async () => {
  const payload = Buffer.from(JSON.stringify({ csrfToken: "x".repeat(32), expiresAt: Date.now() + ADMIN_SESSION_TTL_MS })).toString("base64url");
  const signature = createHmac("sha256", TOKEN).update(payload).digest("base64url");
  const { api } = factory(createMemorySessionStore());
  assert.equal((await call(api, { method: "GET", headers: { cookie: `currency_war_admin=${payload}.${signature}` } })).statusCode, 401);
});

test("F5 persistent sessions expire, reject excessive lifetimes and fail closed on corruption", async t => {
  const dir = await mkdtemp(join(tmpdir(), "hsr-session-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "security.json"), id = "x".repeat(43);
  const store = new JsonSecurityStore(path);
  await assert.rejects(() => store.register(id, ADMIN_SESSION_TTL_MS + ADMIN_SESSION_CLOCK_SKEW_MS + 1, 0));
  await store.register(id, 1000, 0);
  assert.equal(await new JsonSecurityStore(path).isActive(id, 999), true);
  assert.equal(await new JsonSecurityStore(path).isActive(id, 1000), false);
  await writeFile(path, "corrupt");
  await assert.rejects(() => store.isActive(id, 1001));
  assert.equal(await readFile(path, "utf8"), "corrupt");
});

test("F5 session state mutations are unavailable without the existing worker bearer token", async () => {
  let calls = 0;
  const worker = createWorkerHandler({ token: WORKER_TOKEN, queue: {}, securityStore: { register: () => { calls++; } } });
  const res = await call(worker, { method: "POST", url: "/admin", body: { action: "session.register", id: "x".repeat(43), expiresAt: Date.now() + 1000 } });
  assert.equal(res.statusCode, 401);
  assert.equal(calls, 0);
});

async function uiFixture(deleteOutcome) {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { value: "", checked: false, hidden: false, disabled: false, dataset: {}, listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute() {}, focus() {}, replaceChildren() {}, append() {},
    });
    return nodes.get(id);
  }
  let deletes = 0;
  const script = await readFile(new URL("../public/admin.js", import.meta.url), "utf8");
  const context = {
    document: { getElementById: node, documentElement: { dataset: {}, style: {} }, querySelector: () => null },
    fetch: async (_url, options) => {
      if (options.method === "DELETE") { deletes++; return deleteOutcome(); }
      return { ok: true, json: async () => ({ authenticated: false }) };
    },
  };
  await vm.runInNewContext(`(async () => { ${script}\n state.csrfToken = "synthetic-csrf"; showConsole(); return () => state.csrfToken; })()`, context);
  return { nodes, node, clicks: () => deletes, logout: () => node("admin-logout").listeners.click() };
}

for (const failure of ["network", "server", "csrf"]) {
  test(`F5 UI never announces successful logout on ${failure} failure and allows retry`, async () => {
    const ui = await uiFixture(async () => {
      if (failure === "network") throw new Error("offline");
      return { ok: false, status: failure === "csrf" ? 403 : 503, json: async () => ({ error: { message: "failure" } }) };
    });
    await ui.logout();
    assert.equal(ui.node("admin-console").hidden, false);
    assert.equal(ui.node("admin-login").hidden, true);
    assert.match(ui.node("admin-save-status").textContent, /登出未完成/);
    assert.equal(ui.node("admin-logout").disabled, false);
    assert.notEqual(ui.node("admin-login-status").textContent, "已安全登出。");
    await ui.logout();
    assert.equal(ui.clicks(), 2);
  });
}

test("F5 UI only returns to login after the server acknowledges logout", async () => {
  const ui = await uiFixture(async () => ({ ok: true, status: 200, json: async () => ({ authenticated: false }) }));
  await ui.logout();
  assert.equal(ui.node("admin-console").hidden, true);
  assert.equal(ui.node("admin-login").hidden, false);
  assert.equal(ui.node("admin-login-status").textContent, "已安全登出。");
});

test("F5 a malformed success response cannot make the UI claim logout completed", async () => {
  const ui = await uiFixture(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  await ui.logout();
  assert.equal(ui.node("admin-console").hidden, false);
  assert.match(ui.node("admin-save-status").textContent, /登出未完成/);
});

for (const skewMs of [-60_000, -1, 0, 1, 60_000]) {
  test(`F5 shared session registration accepts bounded clock skew (${skewMs}ms) without extending worker TTL`, async () => {
    const time = Date.parse("2026-11-09T12:00:00Z");
    const workerState = createMemorySessionStore();
    let registeredId;
    const securityStore = {
      ...workerState,
      register(id, expiresAt, nowMs) { registeredId = id; return workerState.register(id, expiresAt, nowMs); },
    };
    const worker = createWorkerHandler({ token: WORKER_TOKEN, queue: {}, securityStore, now: () => new Date(time) });
    const remote = createWorkerSessionStore({ workerUrl: "http://127.0.0.1/jobs", workerToken: WORKER_TOKEN,
      fetchFn: async (url, options) => {
        const res = await call(worker, { method: options.method, url: new URL(url).pathname, headers: options.headers, body: JSON.parse(options.body) });
        return { ok: res.statusCode < 400, status: res.statusCode, json: async () => res.body };
      },
    });
    const { session, api } = factory(remote, { now: () => new Date(time + skewMs) });
    const headers = await login(session);
    assert.equal((await call(api, { method: "GET", headers })).statusCode, 200);
    assert.equal(workerState.isActive(registeredId, time + ADMIN_SESSION_TTL_MS), false);
  });
}
