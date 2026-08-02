import assert from "node:assert/strict";
import test from "node:test";

import { PublicInputError } from "../src/errors.mjs";

import {
  createRolesHandler,
  createSearchHandler,
  createTransfersHandler,
  getTransferFromWorker,
  publicClientKey,
  submitTransferToWorker,
  TransferServiceUnavailableError,
} from "../src/http.mjs";

test("hashes a trusted client address and ignores spoofable forwarding headers", () => {
  const request = {
    headers: { "x-forwarded-for": "203.0.113.10" },
    socket: { remoteAddress: "127.0.0.1" },
  };
  const localKey = publicClientKey(request, "test-hash-secret");
  const vercelKey = publicClientKey({
    ...request,
    headers: { "x-vercel-forwarded-for": "203.0.113.10" },
  }, "test-hash-secret");

  assert.match(localKey, /^[a-f0-9]{64}$/);
  assert.notEqual(localKey, vercelKey);
  assert.doesNotMatch(localKey, /127\.0\.0\.1/);
  assert.doesNotMatch(vercelKey, /203\.0\.113\.10/);
});

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

test("serves the visible China role catalogue with shared caching", async () => {
  const handler = createRolesHandler({
    fetchChinaRoleOptionsFn: async () => ({
      roles: [{ id: "1510", name: "姬子•启行" }],
      version: "4.4",
    }),
  });
  const response = responseRecorder();

  await handler({ method: "GET" }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().roles[0].id, "1510");
  assert.match(response.headers.get("cache-control"), /s-maxage=3600/);
});

test("serves bounded combined strategy searches", async () => {
  let received;
  const handler = createSearchHandler({
    searchChinaStrategiesFn: async (query) => {
      received = query;
      return { mode: "search", candidates: [] };
    },
  });
  const response = responseRecorder();

  await handler(
    {
      method: "POST",
      body: {
        keyword: "姬子",
        authorKeyword: "田宮良子",
        roleIds: ["1510", "1001"],
        maxPages: 4,
        pageSize: 20,
      },
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(received, {
    source: undefined,
    keyword: "姬子",
    authorKeyword: "田宮良子",
    roleIds: ["1510", "1001"],
    maxPages: 4,
    pageSize: 20,
    order: "Hot",
  });
});

test("rejects an excessive public search before calling China", async () => {
  let called = false;
  const handler = createSearchHandler({
    searchChinaStrategiesFn: async () => {
      called = true;
    },
  });
  const response = responseRecorder();

  await handler(
    {
      method: "POST",
      body: JSON.stringify({ keyword: "姬子", maxPages: 11 }),
    },
    response,
  );

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "invalid_request");
  assert.equal(response.json().error.reason, "invalid_pagination");
  assert.equal(called, false);
});

test("classifies stale role ids as refreshable input", async () => {
  const handler = createSearchHandler({
    searchChinaStrategiesFn: async () => {
      throw new PublicInputError(
        "Unknown China role id: removed",
        "stale_role_ids",
      );
    },
  });
  const response = responseRecorder();

  await handler(
    { method: "POST", body: { roleIds: ["removed"] } },
    response,
  );

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "invalid_request");
  assert.equal(response.json().error.reason, "stale_role_ids");
});

test("does not expose upstream error details", async () => {
  const handler = createSearchHandler({
    searchChinaStrategiesFn: async () => {
      throw new Error("sensitive upstream response");
    },
  });
  const response = responseRecorder();

  await handler(
    { method: "POST", body: { keyword: "姬子" } },
    response,
  );

  assert.equal(response.statusCode, 502);
  assert.equal(
    response.json().error.message,
    "Unable to read China strategies right now",
  );
  assert.doesNotMatch(response.body, /sensitive/);
});

test("does not misclassify a fetch TypeError as invalid user input", async () => {
  const handler = createSearchHandler({
    searchChinaStrategiesFn: async () => {
      throw new TypeError("fetch failed");
    },
  });
  const response = responseRecorder();

  await handler(
    { method: "POST", body: { keyword: "姬子" } },
    response,
  );

  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error.code, "china_service_error");
  assert.equal(response.json().error.reason, undefined);
});

test("submits a validated China strategy ID to the worker", async () => {
  let receivedId;
  const handler = createTransfersHandler({
    submitTransferFn: async (sourceId) => {
      receivedId = sourceId;
      return {
        status: "unchanged",
        globalId: "6a6c694a2a5c4702d0b47b26",
        shareCode: "share-code=",
        ignored: [],
      };
    },
  });
  const response = responseRecorder();

  await handler(
    {
      method: "POST",
      body: { source: "6a56fe3021253d0e1a9f4761" },
    },
    response,
  );

  assert.equal(receivedId, "6a56fe3021253d0e1a9f4761");
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().shareCode, "##share-code=##");
  assert.equal("globalId" in response.json(), false);
  assert.equal(
    response.json().globalUrl,
    "https://act.hoyolab.com/sr/event/currency-wars/index.html?gt__lineup_id=tatctwrapascrunpdnbrubpt",
  );
});

test("reports an unconfigured transfer worker without leaking details", async () => {
  const handler = createTransfersHandler({
    submitTransferFn: async () => {
      throw new TransferServiceUnavailableError("private worker detail");
    },
  });
  const response = responseRecorder();

  await handler(
    {
      method: "POST",
      body: { source: "6a56fe3021253d0e1a9f4761" },
    },
    response,
  );

  assert.equal(response.statusCode, 503);
  assert.equal(
    response.json().error.code,
    "transfer_service_unavailable",
  );
  assert.doesNotMatch(response.body, /private/);
});

test("authenticates worker requests on the server only", async () => {
  let request;
  const result = await submitTransferToWorker(
    "6a56fe3021253d0e1a9f4761",
    {
      workerUrl: "https://worker.example/jobs",
      workerToken: "server-secret",
      fetchFn: async (url, options) => {
        request = { url, options };
        return {
          ok: true,
          json: async () => ({ status: "queued", jobId: "job-1" }),
        };
      },
    },
  );

  assert.equal(result.status, "queued");
  assert.equal(request.url, "https://worker.example/jobs");
  assert.equal(request.options.headers.authorization, "Bearer server-secret");
  assert.deepEqual(JSON.parse(request.options.body), {
    sourceId: "6a56fe3021253d0e1a9f4761",
  });
});

test("polls a queued transfer through the server-side worker token", async () => {
  let request;
  const result = await getTransferFromWorker("job-1", {
    workerUrl: "https://worker.example/jobs",
    workerToken: "server-secret",
    fetchFn: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "created",
          jobId: "job-1",
          globalId: "6a6c694a2a5c4702d0b47b26",
          shareCode: "global-code=",
          ignored: [],
        }),
      };
    },
  });

  assert.equal(result.status, "created");
  assert.equal(result.shareCode, "##global-code=##");
  assert.match(result.globalUrl, /gt__lineup_id=/);
  assert.equal(request.url, "https://worker.example/jobs/job-1");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.headers.authorization, "Bearer server-secret");
});

test("serves transfer polling from the public API", async () => {
  let receivedJobId;
  const handler = createTransfersHandler({
    getTransferFn: async (jobId) => {
      receivedJobId = jobId;
      return { status: "queued", jobId };
    },
  });
  const response = responseRecorder();

  await handler(
    { method: "GET", url: "/api/transfers?jobId=job-2" },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(receivedJobId, "job-2");
  assert.deepEqual(response.json(), {
    status: "queued",
    jobId: "job-2",
    shareCode: null,
    globalUrl: null,
    ignored: [],
    error: null,
  });
});

test("rejects a public plaintext worker URL before sending the token", async () => {
  let called = false;
  await assert.rejects(
    () => submitTransferToWorker(
      "6a56fe3021253d0e1a9f4761",
      {
        workerUrl: "http://worker.example/jobs",
        workerToken: "server-secret",
        fetchFn: async () => {
          called = true;
        },
      },
    ),
    /HTTPS/,
  );
  assert.equal(called, false);
});

test("allows plaintext worker traffic only on loopback", async () => {
  const result = await submitTransferToWorker(
    "6a56fe3021253d0e1a9f4761",
    {
      workerUrl: "http://127.0.0.1:8787/jobs",
      workerToken: "server-secret",
      fetchFn: async () => ({
        ok: true,
        json: async () => ({ status: "queued", jobId: "local-job" }),
      }),
    },
  );
  assert.equal(result.jobId, "local-job");
});

test("sanitises a failed worker result", async () => {
  const result = await getTransferFromWorker("job-3", {
    workerUrl: "https://worker.example/jobs",
    workerToken: "server-secret",
    fetchFn: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: "failed",
        jobId: "job-3",
        error: {
          code: "publishing_session_error",
          message: "sensitive upstream account detail",
        },
      }),
    }),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "publishing_session_error");
  assert.equal(result.error.message, "The strategy could not be transferred");
  assert.doesNotMatch(JSON.stringify(result), /sensitive/);
});

test("rejects a completed worker result without a share code", async () => {
  await assert.rejects(
    () => getTransferFromWorker("job-4", {
      workerUrl: "https://worker.example/jobs",
      workerToken: "server-secret",
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: "created", jobId: "job-4" }),
      }),
    }),
    /without a share code/,
  );
});

test("reports a malformed completed worker result as unavailable", async () => {
  const handler = createTransfersHandler({
    getTransferFn: async () => ({ status: "created", jobId: "job-5" }),
  });
  const response = responseRecorder();

  await handler(
    { method: "GET", url: "/api/transfers?jobId=job-5" },
    response,
  );

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "transfer_service_unavailable");
});

test("rejects an untrusted completed Global strategy URL", async () => {
  const handler = createTransfersHandler({
    getTransferFn: async () => ({
      status: "created",
      jobId: "job-6",
      shareCode: "global-code=",
      globalUrl: "https://example.com/?gt__lineup_id=tatctwrapascrunpdnbrubpt",
    }),
  });
  const response = responseRecorder();

  await handler(
    { method: "GET", url: "/api/transfers?jobId=job-6" },
    response,
  );

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "transfer_service_unavailable");
});
