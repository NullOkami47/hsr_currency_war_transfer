import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";
import handler, { createProbeHandler } from "../scripts/infrastructure/vercel-staging-probe/api/probe.mjs";

// Fetch is always mocked: these tests make no network requests and prove no
// Vercel deployment, TLS, DNS, firewall or actual worker connectivity.
const origin = "https://gcp-staging.34.80.12.34.sslip.io";
const workerToken = "unit-test-worker-token-000000000000000000";
const probeKey = "unit-test-probe-key-000000000000000000000";
const environment = {
  VERCEL_ENV: "preview", HSR_STAGING_ORIGIN: origin,
  HSR_STAGING_WORKER_TOKEN: workerToken, HSR_STAGING_PROBE_KEY: probeKey,
};
const queued = { status: "queued", jobId: "synthetic-job_1" };
const created = { status: "created", jobId: queued.jobId, synthetic: true,
  sourceId: "do-not-return-source", shareCode: "do-not-return-share-code" };
const json = (status, value) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" },
});
function successfulReplies() {
  return [json(200, { status: "ok", mode: "hsr-synthetic-worker", syntheticStateId: "private-state-id" }),
    json(401, { secret: "do-not-return-auth-body" }), json(401, {}), json(202, queued), json(200, created)];
}
function fixture({ env = {}, replies = successfulReplies(), fetchImpl, now, sleep = async () => {} } = {}) {
  const calls = [], delays = [];
  const fetchMock = async (url, options) => {
    calls.push({ url: String(url), ...options });
    if (fetchImpl) return fetchImpl(url, options, calls.length);
    assert.ok(replies.length, "unexpected upstream call");
    const next = replies.shift();
    return typeof next === "function" ? next(url, options) : next;
  };
  const run = createProbeHandler({ env: { ...environment, ...env }, fetchImpl: fetchMock,
    ...(now ? { now } : {}), sleep: async (ms, signal) => { delays.push(ms); await sleep(ms, signal); } });
  return { calls, delays, run };
}
async function invoke(run, { method = "POST", authorization = `Bearer ${probeKey}`,
  body = [], headers = {}, parsedBody, request: suppliedRequest } = {}) {
  const request = suppliedRequest ?? Readable.from(body);
  request.method = method;
  request.headers = { ...(authorization === undefined ? {} : { authorization }), ...headers };
  if (parsedBody !== undefined) request.body = parsedBody;
  const response = new EventEmitter();
  response.headers = {};
  response.setHeader = (key, value) => { response.headers[key.toLowerCase()] = value; };
  response.end = value => { response.writableEnded = true; response.text = value; };
  await run(request, response);
  return { code: response.statusCode, body: JSON.parse(response.text), headers: response.headers, request, response };
}
// Readable completion uses nextTick; a microtask-only flush starves it.
async function flush() { await new Promise(resolve => setImmediate(resolve)); }

test("unauthenticated or wrong bearer callers get 401 without touching upstream", async () => {
  for (const authorization of [null, "", "Basic abc", `Bearer ${"x".repeat(40)}`, `Bearer ${probeKey} extra`, [ `Bearer ${probeKey}` ]]) {
    const f = fixture();
    const result = await invoke(f.run, { authorization });
    assert.equal(result.code, 401);
    assert.equal(result.body.ok, false);
    assert.equal(f.calls.length, 0);
    assert.equal(result.headers["cache-control"], "no-store");
  }
  const f = fixture();
  assert.equal((await invoke(f.run, { headers: { authorization: undefined } })).code, 401);
  assert.equal(f.calls.length, 0);
});

test("POST is the only accepted method and unsupported methods make no upstream calls", async () => {
  for (const method of ["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]) {
    const f = fixture();
    const result = await invoke(f.run, { method });
    assert.equal(result.code, 405);
    assert.equal(result.headers.allow, "POST");
    assert.equal(f.calls.length, 0);
  }
});

test("only an empty body is accepted, including raw streams and Vercel parsed bodies", async () => {
  for (const options of [
    { body: ["{}"] }, { body: [" "] }, { body: ["null"] },
    { body: ["{}"], parsedBody: {} }, { body: ["null"], parsedBody: null }, { body: [" "], parsedBody: " " },
    { headers: { "content-length": "2" } }, { headers: { "content-length": "invalid" } },
    { headers: { "transfer-encoding": "chunked" } },
  ]) {
    const f = fixture();
    const result = await invoke(f.run, options);
    assert.equal(result.code, 400);
    assert.equal(result.body.ok, false);
    assert.equal(f.calls.length, 0);
  }
});

test("zero-byte bodies stay empty when Vercel parses JSON or form content types as objects", async () => {
  for (const contentType of ["application/json", "application/x-www-form-urlencoded"]) {
    for (const framing of [{}, { "content-length": "0" }]) {
      const f = fixture();
      const result = await invoke(f.run, { parsedBody: {}, headers: {
        ...framing, "content-type": contentType,
      } });
      assert.equal(result.code, 200);
      assert.equal(result.body.ok, true);
    }
  }
  const f = fixture();
  assert.equal((await invoke(f.run, { body: ["{}"], headers: { "content-length": "0" } })).code, 400);
  assert.equal(f.calls.length, 0);
});

test("raw bytes decide body emptiness without invoking Vercel's lossy body getter", async () => {
  for (const body of [[], ["{}"], [" "]]) {
    const request = Readable.from(body);
    Object.defineProperty(request, "body", { get() { throw new Error("do not parse input"); } });
    const f = fixture();
    const result = await invoke(f.run, { request });
    assert.equal(result.code, body.length ? 400 : 200);
    assert.equal(result.body.ok, body.length === 0);
    assert.equal(f.calls.length, body.length ? 0 : 5);
  }
});

test("Vercel's restored body stream rejects bytes even after the original IncomingMessage ended", async () => {
  for (const bytes of ["", "{}", " "]) {
    const request = Readable.from([]);
    for await (const _chunk of request) { /* Original stream consumed by runtime. */ }
    const restored = new Readable({ read() {} });
    restored.push(Buffer.from(bytes)); restored.push(null);
    const originalOn = request.on.bind(request);
    request.read = restored.read.bind(restored);
    request.on = function (event, ...args) {
      return event === "data" || event === "end" ? restored.on(event, ...args) : originalOn(event, ...args);
    };
    const f = fixture();
    const result = await invoke(f.run, { request, headers: { "content-type": "application/json" } });
    assert.equal(result.code, bytes.length ? 400 : 200);
    assert.equal(f.calls.length, bytes.length ? 0 : 5);
  }
});

test("Preview guard refuses production, development and missing platform environment", async () => {
  for (const VERCEL_ENV of ["production", "development", "", undefined]) {
    const f = fixture({ env: { VERCEL_ENV } });
    const result = await invoke(f.run);
    assert.equal(result.code, 403);
    assert.equal(f.calls.length, 0);
  }
});

test("both secret values must have at least 32 characters before any network request", async () => {
  for (const name of ["HSR_STAGING_WORKER_TOKEN", "HSR_STAGING_PROBE_KEY"]) {
    for (const value of [undefined, "", "x".repeat(31), "x".repeat(31) + "\n"]) {
      const f = fixture({ env: { [name]: value } });
      const result = await invoke(f.run);
      assert.equal(result.code, 503);
      assert.equal(f.calls.length, 0);
    }
  }
});

test("origin is restricted to the exact HTTPS staging label and a canonical public IPv4", async () => {
  const invalid = [undefined, "", "http://gcp-staging.34.80.12.34.sslip.io", "https://production.example",
    `${origin}/jobs`, `${origin}/../`, `${origin}/?target=production`, `${origin}#x`,
    `${origin}:443`, `${origin}:8443`, `${origin}.evil.example`, `${origin}.`, `${origin}\n`,
    "https://user:password@gcp-staging.34.80.12.34.sslip.io", "https://@gcp-staging.34.80.12.34.sslip.io",
    "https://gcp-staging.34.80.12.34.sslip.io\\@production.example", "https://gcp-staging.34.80.12.34.sslip.io/%2e%2e",
    "https://34.80.12.34.sslip.io", "https://other.gcp-staging.34.80.12.34.sslip.io",
    "https://gcp-staging.034.80.12.34.sslip.io", "https://gcp-staging.256.80.12.34.sslip.io",
    "https://gcp-staging.2130706433.sslip.io", "https://gcp-staging.[::1].sslip.io",
    ...["0.1.2.3", "10.0.0.1", "100.64.0.1", "100.127.255.254", "127.0.0.1", "169.254.169.254",
      "172.16.0.1", "172.31.255.254", "192.168.0.1", "192.0.0.1", "192.0.2.1", "192.88.99.1",
      "198.18.0.1", "198.19.255.254", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "255.255.255.255"]
      .map(ip => `https://gcp-staging.${ip}.sslip.io`),
  ];
  for (const HSR_STAGING_ORIGIN of invalid) {
    const f = fixture({ env: { HSR_STAGING_ORIGIN } });
    const result = await invoke(f.run);
    assert.equal(result.code, 503, String(HSR_STAGING_ORIGIN));
    assert.equal(f.calls.length, 0, String(HSR_STAGING_ORIGIN));
  }
  const f = fixture({ env: { HSR_STAGING_ORIGIN: `${origin}/` } });
  assert.equal((await invoke(f.run)).code, 200);
  assert.equal(f.calls[0].url, `${origin}/health`);
});

test("non-synthetic or unhealthy health fails closed before every POST /jobs", async () => {
  for (const response of [
    json(200, { status: "ok" }), json(200, { mode: "hsr-synthetic-worker" }),
    json(200, { status: "bad", mode: "hsr-synthetic-worker" }),
    json(200, { status: "ok", mode: "production" }),
    json(503, { status: "ok", mode: "hsr-synthetic-worker" }),
    json(200, null), new Response("not-json", { status: 200 }),
  ]) {
    const f = fixture({ replies: [response] });
    const result = await invoke(f.run);
    assert.equal(result.code, 502);
    assert.equal(result.body.ok, false);
    assert.deepEqual(f.calls.map(call => [call.method, call.url]), [["GET", `${origin}/health`]]);
    assert.equal(f.calls[0].headers.authorization, undefined);
  }
});

test("missing and wrong worker tokens must both return exactly 401 before authorised creation", async () => {
  for (const step of [1, 2]) {
    for (const status of [200, 202, 400, 403, 429, 500]) {
      const replies = successfulReplies();
      replies[step] = json(status, { token: workerToken });
      const f = fixture({ replies });
      const result = await invoke(f.run);
      assert.equal(result.code, 502);
      assert.equal(result.body.ok, false);
      assert.equal(f.calls.length, step + 1);
      assert.ok(!f.calls.some(call => call.headers.authorization === `Bearer ${workerToken}`));
    }
  }
});

test("real worker wire format: health, auth negatives, synthetic creation and queued polling", async () => {
  const replies = successfulReplies();
  replies.splice(4, 0, json(200, queued));
  const f = fixture({ replies });
  const result = await invoke(f.run, { headers: { "content-length": "0" } });
  assert.equal(result.code, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.status, "passed");
  assert.deepEqual(result.body.checks, { health: true, missingTokenRejected: true,
    wrongTokenRejected: true, created: true, synthetic: true });
  assert.deepEqual(f.calls.map(call => [call.method, call.url]), [
    ["GET", `${origin}/health`], ["POST", `${origin}/jobs`], ["POST", `${origin}/jobs`],
    ["POST", `${origin}/jobs`], ["GET", `${origin}/jobs/synthetic-job_1`], ["GET", `${origin}/jobs/synthetic-job_1`],
  ]);
  assert.equal(f.calls[1].headers.authorization, undefined);
  assert.match(f.calls[2].headers.authorization, /^Bearer .{32,}$/);
  assert.notEqual(f.calls[2].headers.authorization, `Bearer ${workerToken}`);
  assert.equal(f.calls[3].headers.authorization, `Bearer ${workerToken}`);
  assert.equal(f.calls[4].headers.authorization, `Bearer ${workerToken}`);
  const payload = JSON.parse(f.calls[3].body);
  assert.match(payload.sourceId, /^[0-9a-f]{24}$/);
  assert.equal(JSON.parse(f.calls[1].body).sourceId, payload.sourceId);
  assert.equal(JSON.parse(f.calls[2].body).sourceId, payload.sourceId);
  assert.ok(f.calls.every(call => call.redirect === "manual" && call.signal instanceof AbortSignal));
  assert.deepEqual(f.delays, [1000]);
  assert.equal(result.request.listenerCount("aborted"), 0);
  assert.equal(result.response.listenerCount("close"), 0);
});

test("each invocation generates a fresh synthetic source, and upstream URLs never use caller URL", async () => {
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const f = fixture();
    const request = Readable.from([]);
    request.url = "/api/probe?origin=https://production.example&sourceId=actual-state";
    assert.equal((await invoke(f.run, { request })).code, 200);
    ids.push(JSON.parse(f.calls[3].body).sourceId);
    assert.ok(f.calls.every(call => call.url.startsWith(`${origin}/`)));
  }
  assert.notEqual(ids[0], ids[1]);
});

test("all upstream redirects are refused without forwarding credentials or creating more work", async () => {
  for (let step = 0; step < 5; step++) {
    for (const status of [301, 302, 303, 307, 308]) {
      const replies = successfulReplies();
      replies[step] = new Response(null, { status, headers: { location: "https://production.example/jobs" } });
      const f = fixture({ replies });
      const result = await invoke(f.run);
      assert.equal(result.code, 502);
      assert.equal(result.body.status, "redirect_rejected");
      assert.equal(f.calls.length, step + 1);
      assert.ok(f.calls.every(call => call.redirect === "manual" && call.url.startsWith(origin)));
    }
  }
});

test("unexpected create responses and unsafe job IDs never get polled", async () => {
  for (const response of [json(200, queued), json(401, queued), json(202, {}),
    json(202, { ...queued, jobId: "../admin" }), json(202, { ...queued, jobId: "https://production.example" }),
    json(202, { ...queued, jobId: "a".repeat(101) }), json(202, { ...queued, status: "created" }),
  ]) {
    const replies = successfulReplies(); replies[3] = response;
    const f = fixture({ replies });
    const result = await invoke(f.run);
    assert.equal(result.code, 502);
    assert.equal(result.body.ok, false);
    assert.equal(f.calls.length, 4);
  }
});

test("created requires synthetic === true, and terminal/foreign/malformed polling never succeeds", async () => {
  for (const value of [
    { ...created, synthetic: undefined }, { ...created, synthetic: false }, { ...created, synthetic: "true" },
    { ...created, status: "failed" }, { ...created, status: "partial" },
    { ...created, jobId: "different-job" }, { ...created, status: "completed" }, null,
  ]) {
    const replies = successfulReplies(); replies[4] = json(200, value);
    const f = fixture({ replies });
    const result = await invoke(f.run);
    assert.equal(result.code, 502);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.checks.synthetic, false);
    assert.equal(f.calls.length, 5);
  }
});

test("nested synthetic results are checked without returning their actual contents", async () => {
  const replies = successfulReplies();
  replies[4] = json(200, { status: "created", jobId: queued.jobId, result: created });
  const f = fixture({ replies });
  const result = await invoke(f.run);
  assert.equal(result.code, 200);
  assert.equal(result.body.checks.synthetic, true);
});

test("polling stops after eight reads with bounded delays and never fabricates success", async () => {
  const replies = successfulReplies().slice(0, 4);
  for (let i = 0; i < 8; i++) replies.push(json(200, queued));
  const f = fixture({ replies });
  const result = await invoke(f.run);
  assert.equal(result.code, 504);
  assert.equal(result.body.status, "poll_exhausted");
  assert.equal(result.body.ok, false);
  assert.equal(f.calls.length, 12);
  assert.deepEqual(f.delays, [1000, 1000, 1000, 1000, 1000, 1000, 1000]);
});

test("responses only expose booleans, fixed statuses and timestamps on success and failure", async () => {
  for (const fail of [false, true]) {
    const replies = successfulReplies();
    if (fail) replies[4] = () => { throw new Error(`${workerToken} ${probeKey} private-error-state`); };
    const f = fixture({ replies });
    const result = await invoke(f.run);
    assert.equal(result.body.ok, !fail);
    assert.deepEqual(Object.keys(result.body).sort(), ["checks", "finishedAt", "ok", "startedAt", "status", "upstream"]);
    for (const key of ["startedAt", "finishedAt"]) assert.ok(Number.isFinite(Date.parse(result.body[key])));
    assert.ok(Object.values(result.body.checks).every(value => typeof value === "boolean"));
    assert.ok(Object.values(result.body.upstream).every(value => Number.isInteger(value) && value >= 100 && value <= 599));
    const text = JSON.stringify(result.body);
    for (const sensitive of [origin, workerToken, probeKey, queued.jobId, "private-state-id",
      "do-not-return", "private-error-state", JSON.parse(f.calls[3].body).sourceId]) {
      assert.ok(!text.includes(sensitive), sensitive);
    }
  }
});

test("a stalled fetch is aborted after five seconds even if it ignores AbortSignal", { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ fetchImpl: () => new Promise(() => {}) });
  const pending = invoke(f.run);
  await flush();
  t.mock.timers.tick(4999);
  assert.equal(f.calls[0].signal.aborted, false);
  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(result.code, 504);
  assert.equal(result.body.ok, false);
  assert.equal(f.calls[0].signal.aborted, true);
});

test("the five second timeout includes an upstream response body that never finishes", { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ fetchImpl: async () => ({ status: 200, redirected: false,
    json: () => new Promise(() => {}), body: { cancel: async () => {} } }) });
  const pending = invoke(f.run);
  await flush();
  t.mock.timers.tick(5000);
  const result = await pending;
  assert.equal(result.code, 504);
  assert.equal(result.body.ok, false);
});

test("the total deadline of 45 seconds also aborts a body stalled before upstream", { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const request = new Readable({ read() {} });
  t.after(() => request.destroy());
  const f = fixture();
  const pending = invoke(f.run, { request });
  await flush();
  t.mock.timers.tick(45000);
  const result = await pending;
  assert.equal(result.code, 504);
  assert.equal(result.body.ok, false);
  assert.equal(f.calls.length, 0);
});

test("total elapsed budget caps remaining calls even when the eight poll limit has not been reached", async () => {
  let elapsed = 0;
  const f = fixture({ now: () => elapsed, sleep: async () => { elapsed = 45000; },
    replies: [...successfulReplies().slice(0, 4), json(200, queued)] });
  const result = await invoke(f.run);
  assert.equal(result.code, 504);
  assert.equal(result.body.status, "timed_out");
  assert.equal(result.body.ok, false);
  assert.equal(f.calls.length, 5);
});

test("interruption of upstream or polling delay never returns fake success", async () => {
  for (const duringDelay of [false, true]) {
    const request = Readable.from([]);
    const f = fixture(duringDelay ? {
      replies: [...successfulReplies().slice(0, 4), json(200, queued)],
      sleep: async () => { request.emit("aborted"); },
    } : { fetchImpl: async () => { request.emit("aborted"); throw new Error("connection interrupted"); } });
    const result = await invoke(f.run, { request });
    assert.equal(result.code, 408);
    assert.equal(result.body.status, "interrupted");
    assert.equal(result.body.ok, false);
    assert.equal(result.body.checks.synthetic, false);
    assert.ok(f.calls.every(call => call.signal.aborted));
    assert.equal(f.calls.length, duringDelay ? 5 : 1);
  }
});

test("the built-in poll delay waits one second and clears its timer when interrupted", { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const interrupt of [false, true]) {
    const request = Readable.from([]);
    const replies = [...successfulReplies().slice(0, 4), json(200, queued), json(200, created)];
    let calls = 0;
    const run = createProbeHandler({ env: environment,
      fetchImpl: async () => { calls++; return replies.shift(); } });
    const pending = invoke(run, { request });
    await flush();
    assert.equal(calls, 5);
    t.mock.timers.tick(999);
    await flush();
    assert.equal(calls, 5);
    if (interrupt) request.emit("aborted"); else t.mock.timers.tick(1);
    const result = await pending;
    assert.equal(result.code, interrupt ? 408 : 200);
    assert.equal(result.body.ok, !interrupt);
    assert.equal(calls, interrupt ? 5 : 6);
  }
});

test("response disconnection aborts in-flight work and releases lifecycle listeners", { timeout: 2000 }, async () => {
  const request = Readable.from([]);
  const response = new EventEmitter();
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  let signal;
  const f = fixture({ fetchImpl: async (_url, options) => {
    signal = options.signal; started(); return new Promise(() => {});
  } });
  request.method = "POST";
  request.headers = { authorization: `Bearer ${probeKey}` };
  response.setHeader = () => {};
  response.end = text => { response.text = text; response.writableEnded = true; };
  const pending = f.run(request, response);
  await entered;
  response.emit("close");
  await pending;
  assert.equal(response.statusCode, 408);
  assert.equal(JSON.parse(response.text).ok, false);
  assert.equal(signal.aborted, true);
  assert.equal(request.listenerCount("aborted"), 0);
  assert.equal(response.listenerCount("close"), 0);
});

test("a request error after body consumption interrupts health and cannot report success", async () => {
  const request = Readable.from([]);
  const replies = successfulReplies();
  const f = fixture({ fetchImpl: async (_url, _options, count) => {
    if (count === 1) request.emit("error", new Error("caller transport failed"));
    return replies.shift();
  } });
  const result = await invoke(f.run, { request });
  assert.equal(result.code, 408);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.status, "interrupted");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].signal.aborted, true);
});

test("a platform request AbortSignal interrupts in-flight work before jobs can be created", async () => {
  const request = Readable.from([]);
  const controller = new AbortController();
  request.signal = controller.signal;
  const f = fixture({ fetchImpl: async () => {
    controller.abort();
    return json(200, { status: "ok", mode: "hsr-synthetic-worker" });
  } });
  const result = await invoke(f.run, { request });
  assert.equal(result.code, 408);
  assert.equal(result.body.status, "interrupted");
  assert.equal(result.body.ok, false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].signal.aborted, true);
});

test("a late poll gets only the remaining total budget, not a fresh five seconds", { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let elapsed = 0;
  const replies = successfulReplies().slice(0, 4);
  const calls = [];
  // Move the clock just before the first poll, leaving two seconds for it.
  const submit = replies[3];
  replies[3] = () => { elapsed = 43000; return submit; };
  const run = createProbeHandler({ env: environment, now: () => elapsed,
    fetchImpl: async (url, options) => {
      if (replies.length) {
        const next = replies.shift();
        return typeof next === "function" ? next() : next;
      }
      calls.push({ url, ...options });
      return new Promise(() => {});
    } });
  const pending = invoke(run);
  await flush();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1999);
  assert.equal(calls[0].signal.aborted, false);
  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(result.code, 504);
  assert.equal(result.body.ok, false);
  assert.equal(calls[0].signal.aborted, true);
});

test("the exported Vercel handler reads runtime environment and uses fetch without deployment", async t => {
  const saved = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  Object.assign(process.env, environment);
  const replies = successfulReplies();
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => { calls.push({ url, ...options }); return replies.shift(); });
  const result = await invoke(handler);
  assert.equal(result.code, 200);
  assert.equal(result.body.ok, true);
  assert.equal(calls.length, 5);
});

test("isolated project declares the Node function with maximum duration no greater than 60 seconds", async () => {
  const base = new URL("../scripts/infrastructure/vercel-staging-probe/", import.meta.url);
  const config = JSON.parse(await readFile(new URL("vercel.json", base), "utf8"));
  const pkg = JSON.parse(await readFile(new URL("package.json", base), "utf8"));
  assert.equal(config.framework, null);
  assert.ok(config.functions["api/probe.mjs"].maxDuration <= 60);
  assert.ok(config.functions["api/probe.mjs"].maxDuration >= 45);
  assert.equal(config.functions["api/probe.mjs"].supportsCancellation, true);
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, "module");
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
});
