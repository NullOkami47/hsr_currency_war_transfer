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

test("waits once for the browser login session to recover from retcode -100", async () => {
  const responses = [
    {
      status: 200,
      body: {
        retcode: -100,
        message: "Login expired. Please log in again",
      },
    },
    {
      status: 200,
      body: {
        retcode: 0,
        data: { id: "6a6c63da6217fd436611cdcd" },
      },
    },
  ];
  let waited = 0;
  const page = {
    async goto() {},
    async waitForTimeout(milliseconds) {
      waited += milliseconds;
    },
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
  assert.equal(responses.length, 0);
});
