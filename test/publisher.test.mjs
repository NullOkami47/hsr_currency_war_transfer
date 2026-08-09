import assert from "node:assert/strict";
import test from "node:test";

import { BrowserSessionPublisher } from "../src/publisher.mjs";

test("publishes through the signed-in page without exposing session data", async () => {
  const calls = [];
  const page = {
    async goto(url) {
      calls.push({ type: "goto", url });
    },
    async evaluate(callback, argument) {
      calls.push({
        type: "evaluate",
        callbackType: typeof callback,
        argument,
      });
      return {
        status: 200,
        body: {
          retcode: 0,
          data: {
            lineup: { id: "6a4dfde2ce98d01a5bac0999" },
          },
        },
      };
    },
  };
  const context = {
    pages: () => [page],
    async newPage() {
      return page;
    },
    async close() {},
  };
  const publisher = new BrowserSessionPublisher({
    profileDir: "test-profile",
    launchPersistentContext: async () => context,
  });

  const result = await publisher.create({
    title: "攻略",
    description: "原文",
    lineup_type: "Tourn",
    tourn_detail: {},
  });

  assert.equal(result.lineupId, "6a4dfde2ce98d01a5bac0999");
  assert.equal(calls[0].type, "goto");
  assert.equal(calls[1].argument.payload.title, "攻略");
  assert.equal(
    calls[1].argument.endpoint.endsWith(
      "/game/lineup/create_lineup_tourn",
    ),
    true,
  );
  assert.equal("cookies" in calls[1].argument, false);
  assert.equal("storageState" in calls[1].argument, false);
});

test("uses the browser device cookie across consecutive creates", async () => {
  const officialDeviceId = "11111111-2222-4333-8444-555555555555";
  const requestArguments = [];
  let requestCount = 0;
  const page = {
    async goto() {},
    async evaluate(callback, argument) {
      requestArguments.push(argument);
      const originalDocument = globalThis.document;
      const originalFetch = globalThis.fetch;
      globalThis.document = {
        cookie: `_HYVUUID=${officialDeviceId}`,
      };
      globalThis.fetch = async (_url, options) => {
        requestCount += 1;
        const deviceMatches =
          options.headers["x-rpc-device_id"] === officialDeviceId;
        return {
          status: 200,
          async json() {
            if (requestCount > 1 && !deviceMatches) {
              return {
                retcode: -100,
                message: "Login expired. Please log in again",
              };
            }
            return {
              retcode: 0,
              data: { id: "6a4dfde2ce98d01a5bac0999" },
            };
          },
        };
      };

      try {
        return await callback(argument);
      } finally {
        globalThis.fetch = originalFetch;
        if (originalDocument === undefined) {
          delete globalThis.document;
        } else {
          globalThis.document = originalDocument;
        }
      }
    },
    async waitForTimeout() {},
  };
  const context = {
    pages: () => [page],
    async newPage() {
      return page;
    },
    async close() {},
  };
  const publisher = new BrowserSessionPublisher({
    profileDir: "test-profile",
    authRecoveryDelayMs: 0,
    launchPersistentContext: async () => context,
  });
  const payload = {
    title: "Consecutive publish",
    description: "Device identity must remain stable",
    lineup_type: "Tourn",
    tourn_detail: {},
  };

  await publisher.create(payload);
  await publisher.create(payload);

  assert.equal(requestArguments.length, 2);
  assert.equal("deviceId" in requestArguments[0], false);
  assert.equal("deviceId" in requestArguments[1], false);
});

test("recovers a created lineup id from My Posts when create returns none", async () => {
  const responses = [
    {
      status: 200,
      body: { retcode: 0, data: {} },
    },
    {
      status: 200,
      body: {
        retcode: 0,
        data: {
          list: [
            {
              id: "6a6c63da6217fd436611cdcd",
              title: "攻略｜作者",
              description: "原文\n來源：作者",
              created_at: String(Math.floor(Date.now() / 1000)),
            },
          ],
        },
      },
    },
  ];
  const page = {
    async goto() {},
    async evaluate() {
      return responses.shift();
    },
  };
  const context = {
    pages: () => [page],
    async newPage() {
      return page;
    },
    async close() {},
  };
  const publisher = new BrowserSessionPublisher({
    profileDir: "test-profile",
    launchPersistentContext: async () => context,
  });

  const result = await publisher.create({
    title: "攻略｜作者",
    description: "原文\n來源：作者",
    lineup_type: "Tourn",
    tourn_detail: {},
  });

  assert.equal(result.lineupId, "6a6c63da6217fd436611cdcd");
  assert.equal(responses.length, 0);
});

test("reloads the event page once to recover from retcode -100", async () => {
  let waited = 0;
  const visitedUrls = [];
  const page = {
    async goto(url) {
      visitedUrls.push(url);
    },
    async waitForTimeout(milliseconds) {
      waited += milliseconds;
    },
    async evaluate() {
      if (visitedUrls.length < 2) {
        return {
          status: 200,
          body: {
            retcode: -100,
            message: "Login expired. Please log in again",
          },
        };
      }
      return {
        status: 200,
        body: {
          retcode: 0,
          data: { id: "6a6c63da6217fd436611cdcd" },
        },
      };
    },
  };
  const context = {
    pages: () => [page],
    async newPage() {
      return page;
    },
    async close() {},
  };
  const publisher = new BrowserSessionPublisher({
    profileDir: "test-profile",
    authRecoveryDelayMs: 8_000,
    launchPersistentContext: async () => context,
  });

  const result = await publisher.create({
    title: "攻略｜作者",
    description: "原文\n來源：作者",
    lineup_type: "Tourn",
    tourn_detail: {},
  });

  assert.equal(result.lineupId, "6a6c63da6217fd436611cdcd");
  assert.equal(waited, 8_000);
  assert.equal(visitedUrls.length, 2);
  assert.equal(visitedUrls[0], visitedUrls[1]);
});

test("rebuilds a stale browser context when page reload cannot recover retcode -100", async () => {
  let launches = 0;
  let staleContextCloses = 0;
  let waited = 0;
  const stalePage = {
    async goto() {},
    async waitForTimeout(milliseconds) {
      waited += milliseconds;
    },
    async evaluate() {
      return {
        status: 200,
        body: {
          retcode: -100,
          message: "Login expired. Please log in again",
        },
      };
    },
  };
  const recoveredPage = {
    async goto() {},
    async waitForTimeout(milliseconds) {
      waited += milliseconds;
    },
    async evaluate() {
      return {
        status: 200,
        body: {
          retcode: 0,
          data: { id: "6a6c63da6217fd436611cdcd" },
        },
      };
    },
  };
  const contexts = [
    {
      pages: () => [stalePage],
      async newPage() {
        return stalePage;
      },
      async close() {
        staleContextCloses += 1;
      },
    },
    {
      pages: () => [recoveredPage],
      async newPage() {
        return recoveredPage;
      },
      async close() {},
    },
  ];
  const publisher = new BrowserSessionPublisher({
    profileDir: "test-profile",
    authRecoveryDelayMs: 8_000,
    launchPersistentContext: async () => {
      const context = contexts[launches];
      launches += 1;
      return context;
    },
  });

  const result = await publisher.create({
    title: "攻略｜作者",
    description: "原文\n來源：作者",
    lineup_type: "Tourn",
    tourn_detail: {},
  });

  assert.equal(result.lineupId, "6a6c63da6217fd436611cdcd");
  assert.equal(launches, 2);
  assert.equal(staleContextCloses, 1);
  assert.equal(waited, 16_000);
});

test("keepalive performs a read-only My Posts request", async () => {
  const requests = [];
  const page = {
    async goto() {},
    async evaluate(_callback, argument) {
      requests.push(argument);
      return { status: 200, body: { retcode: 0, data: { list: [] } } };
    },
  };
  const context = {
    pages: () => [page],
    async newPage() { return page; },
    async close() {},
  };
  const publisher = new BrowserSessionPublisher({
    profileDir: "test-profile",
    launchPersistentContext: async () => context,
  });

  await publisher.keepAlive();

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].endpoint.endsWith("/game/user/lineup"),
    true,
  );
  assert.deepEqual(requests[0].payload, {
    game: "hkrpg",
    page: "1",
    limit: "1",
    lineup_type: "Tourn",
    order: "CreatedTime",
  });
});

test("session diagnostics record recovery metadata without request secrets", async () => {
  const logs = [];
  let attempts = 0;
  const page = {
    async goto() {},
    async waitForTimeout() {},
    async evaluate() {
      attempts += 1;
      return attempts === 1
        ? { status: 200, body: { retcode: -100, message: "secret detail" } }
        : { status: 200, body: { retcode: 0, data: {} } };
    },
  };
  const context = {
    pages: () => [page],
    async newPage() { return page; },
    async close() {},
  };
  const logger = {
    warn(line) { logs.push(line); },
    info(line) { logs.push(line); },
  };
  const publisher = new BrowserSessionPublisher({
    profileDir: "test-profile",
    authRecoveryDelayMs: 0,
    launchPersistentContext: async () => context,
    logger,
  });

  await publisher.keepAlive();

  assert.equal(logs.length, 2);
  assert.match(logs[0], /"event":"auth_recovery"/);
  assert.match(logs[0], /"action":"reload_event_page"/);
  assert.match(logs[1], /"event":"auth_recovered"/);
  assert.doesNotMatch(logs.join("\n"), /secret detail|cookie|deviceId|payload/i);
});
