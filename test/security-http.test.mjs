import assert from "node:assert/strict";
import test from "node:test";
import { fetchConfig } from "../src/api.mjs";
import { fetchChinaRoleOptions } from "../src/search.mjs";
import { createRolesHandler, createTransfersHandler, publicClientKey } from "../src/http.mjs";
import { createRequestBudget, REQUEST_BUDGETS } from "../src/request-budget.mjs";

function response() {
  return { headers: {}, setHeader(key, value) { this.headers[key] = value; },
    end(value) { this.body = JSON.parse(value); } };
}
async function call(handler, request = {}) {
  const res = response();
  await handler({ method: "GET", url: "/api/roles", headers: {}, ...request }, res);
  return res;
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("F1 query variants and wrong methods never reach the catalogue loader", async () => {
  let calls = 0;
  const handler = createRolesHandler({ fetchChinaRoleOptionsFn: async () => { calls++; return {}; } });
  for (const request of [
    { url: "/api/roles?refresh=1&refresh=2" },
    { query: { nonce: "a" } },
    { method: "POST" },
  ]) {
    const res = await call(handler, request);
    assert.ok([400, 405].includes(res.statusCode));
    assert.equal(res.headers["cache-control"], "no-store");
  }
  assert.equal(calls, 0);
});

test("F1 failed refresh is single-flight, negatively cached and recovers at expiry", async () => {
  let time = 0, calls = 0;
  const handler = createRolesHandler({
    now: () => new Date(time), failureTtlMs: 100, cacheTtlMs: 200,
    fetchChinaRoleOptionsFn: async () => {
      calls++;
      if (calls === 1) throw new Error("private-upstream-details");
      return { version: String(calls) };
    },
  });
  const failed = await Promise.all(Array.from({ length: 5 }, () => call(handler)));
  assert.ok(failed.every(res => res.statusCode === 502));
  assert.ok(failed.every(res => !JSON.stringify(res.body).includes("private-upstream")));
  assert.equal(calls, 1);
  assert.equal((await call(handler)).statusCode, 502);
  time = 100;
  assert.equal((await call(handler)).body.version, "2");
  time = 299;
  assert.equal((await call(handler)).body.version, "2");
  time = 300;
  assert.equal((await call(handler)).body.version, "3");
});

test("F1 catalogue deadline releases waiters and suppresses repeated stalled loads", async () => {
  let calls = 0, signal;
  const handler = createRolesHandler({ timeoutMs: 10, fetchChinaRoleOptionsFn: options => {
    calls++; signal = options.signal; return new Promise(() => {});
  } });
  assert.equal((await call(handler)).statusCode, 502);
  assert.equal(signal.aborted, true);
  assert.equal((await call(handler)).statusCode, 502);
  assert.equal(calls, 1);
});

test("F1 catalogue fan-out is at most three locale reads with a shared deadline", async () => {
  const calls = [];
  const result = await fetchChinaRoleOptions({ fetchConfigFn: async (region, options) => {
    calls.push({ region, options });
    return { role_list: [], trait_info_list: [] };
  } });
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map(entry => entry.options.signal)).size, 1);
  assert.deepEqual(result.roles, []);
});

for (const stall of ["fetch", "dns", "body"]) {
  test(`F1 overall API deadline includes stalled ${stall}`, async () => {
    let signal, addresses = 0;
    const never = () => new Promise(() => {});
    await assert.rejects(() => fetchConfig("cn", {
      timeoutMs: 10,
      fetchFn: async (_url, options) => {
        signal = options.signal;
        if (stall === "fetch") return never();
        if (stall === "dns") throw Object.assign(new Error("connect"), { code: "ETIMEDOUT" });
        return { ok: true, json: never };
      },
      resolve4Fn: never,
      addressRequestFn: async () => { addresses++; },
    }), error => error.name === "TimeoutError");
    assert.equal(signal.aborted, true);
    assert.equal(addresses, 0);
  });
}

test("F1 caller cancellation stops fallback instead of starting new upstream requests", async () => {
  const controller = new AbortController();
  let calls = 0, dns = 0;
  await assert.rejects(() => fetchConfig("cn", {
    signal: controller.signal,
    fetchFn: async () => {
      calls++;
      controller.abort(new DOMException("cancelled", "AbortError"));
      throw Object.assign(new Error("connect"), { code: "ETIMEDOUT" });
    },
    resolve4Fn: async () => { dns++; return ["127.0.0.2"]; },
  }), error => error.name === "AbortError");
  assert.equal(calls, 1);
  assert.equal(dns, 0);
});

test("F1 per-client role budgets also apply to cached responses", async () => {
  let calls = 0, time = 0;
  const handler = createRolesHandler({
    now: () => new Date(time),
    rateLimiter: createRequestBudget({ limit: 2, globalLimit: 3, windowMs: 1000 }),
    clientKeyFn: request => request.headers.client,
    fetchChinaRoleOptionsFn: async () => { calls++; return {}; },
  });
  assert.equal((await call(handler, { headers: { client: "one" } })).statusCode, 200);
  assert.equal((await call(handler, { headers: { client: "one" } })).statusCode, 200);
  const limited = await call(handler, { headers: { client: "one" } });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers["retry-after"], "1");
  assert.equal((await call(handler, { headers: { client: "two" } })).statusCode, 200);
  assert.equal((await call(handler, { headers: { client: "three" } })).statusCode, 429);
  time = 1000;
  assert.equal((await call(handler, { headers: { client: "one" } })).statusCode, 200);
  assert.equal(calls, 1);
});

test("active rate-limit identities cannot be evicted by identity churn", () => {
  const budget = createRequestBudget({ limit: 1, globalLimit: 100, windowMs: 1000, maxClients: 1 });
  assert.equal(budget.consume("one", 0).allowed, true);
  assert.equal(budget.consume("two", 1).allowed, false);
  assert.equal(budget.consume("one", 2).allowed, false);
  assert.equal(budget.consume("two", 1000).allowed, true);
});

test("F1 bounds concurrent catalogue waiters before allocating more work", async () => {
  const gate = deferred();
  const handler = createRolesHandler({ maxConcurrent: 1, fetchChinaRoleOptionsFn: () => gate.promise });
  const first = call(handler);
  assert.equal((await call(handler)).statusCode, 429);
  gate.resolve({ roles: [] });
  assert.equal((await first).statusCode, 200);
  assert.equal((await call(handler)).statusCode, 200);
});

for (const method of ["GET", "POST"]) {
  test(`F4 ${method} request budget applies before forwarding and emits Retry-After`, async () => {
    let calls = 0;
    const handler = createTransfersHandler({
      getTransferFn: async () => { calls++; return { status: "queued", jobId: "job-1" }; },
      submitTransferFn: async () => { calls++; return { status: "queued", jobId: "job-1" }; },
    });
    const kind = method === "GET" ? "poll" : "submit";
    const request = { method, url: method === "GET" ? "/api/transfers?jobId=job-1" : "/api/transfers", body: { source: "6a56fe3021253d0e1a9f4761" } };
    for (let i = 0; i < REQUEST_BUDGETS[kind].limit; i++) {
      assert.ok([200, 202].includes((await call(handler, request)).statusCode));
    }
    const blocked = await call(handler, request);
    assert.equal(blocked.statusCode, 429);
    assert.ok(Number(blocked.headers["retry-after"]) > 0);
    assert.equal(calls, REQUEST_BUDGETS[kind].limit);
  });
}

test("F4 ambiguous, repeated and extra transfer query parameters are rejected", async () => {
  let calls = 0;
  const handler = createTransfersHandler({ getTransferFn: async () => { calls++; } });
  for (const request of [
    { url: "/api/transfers?jobId=one&jobId=two" },
    { url: "/api/transfers?jobId=one&nonce=1" },
    { url: "/api/transfers", query: { jobId: ["one", "two"] } },
    { url: "/api/transfers?jobId=one", query: { jobId: "two" } },
  ]) assert.equal((await call(handler, request)).statusCode, 400);
  assert.equal(calls, 0);
});

test("F4 concurrency is bounded and failed requests release their slot", async () => {
  const gate = deferred();
  const handler = createTransfersHandler({ maxConcurrent: 1, getTransferFn: () => gate.promise });
  const request = { url: "/api/transfers?jobId=job-1" };
  const first = call(handler, request);
  assert.equal((await call(handler, request)).statusCode, 429);
  gate.resolve({ status: "queued", jobId: "job-1" });
  assert.equal((await first).statusCode, 200);
  assert.equal((await call(handler, request)).statusCode, 200);
});

test("F4 forwarding headers cannot change anonymous transfer identity without proxy trust", () => {
  const request = { socket: { remoteAddress: "192.0.2.8" }, headers: {} };
  const trusted = { vercel: false, trustProxy: false };
  const expected = publicClientKey(request, "synthetic-secret", trusted);
  request.headers["x-forwarded-for"] = "192.0.2.9";
  request.headers["x-vercel-forwarded-for"] = "192.0.2.10";
  assert.equal(publicClientKey(request, "synthetic-secret", trusted), expected);
  assert.doesNotMatch(expected, /192\.0\.2/);
});
