import assert from "node:assert/strict";
import test from "node:test";

import {
  createRolesHandler,
  createSearchHandler,
  createTransfersHandler,
  getTransferFromWorker,
  submitTransferToWorker,
  TransferServiceUnavailableError,
} from "../src/http.mjs";

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
  assert.equal(called, false);
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
          shareCode: "global-code=",
          ignored: [],
        }),
      };
    },
  });

  assert.equal(result.status, "created");
  assert.equal(result.shareCode, "##global-code=##");
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
    globalId: null,
    shareCode: null,
    ignored: [],
    error: null,
  });
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
