import assert from "node:assert/strict";
import test from "node:test";

import {
  createGlobalLineup,
  fetchLineupDetail,
} from "../src/api.mjs";

const SOURCE_ID = "6a4e123858aa043bf1070a94";
const GLOBAL_ID = "6a6f62926217fd436611ce56";

test("uses another China CDN address after a connect timeout", async () => {
  const timeoutCause = Object.assign(
    new Error(
      "Connect Timeout Error (attempted addresses: 45.253.17.15:443, timeout: 10000ms)",
    ),
    { code: "UND_ERR_CONNECT_TIMEOUT" },
  );
  const timeoutError = new TypeError("fetch failed", { cause: timeoutCause });
  const attemptedAddresses = [];

  const result = await fetchLineupDetail("cn", SOURCE_ID, {
    fetchFn: async () => {
      throw timeoutError;
    },
    resolve4Fn: async () => ["45.253.17.15", "45.253.17.16"],
    addressRequestFn: async (_url, _options, address) => {
      attemptedAddresses.push(address);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          retcode: 0,
          data: { lineup: { id: SOURCE_ID } },
        }),
      };
    },
  });

  assert.deepEqual(attemptedAddresses, ["45.253.17.16"]);
  assert.equal(result.lineup.id, SOURCE_ID);
});

test("uses another Global CDN address for a safe detail read", async () => {
  const timeoutCause = Object.assign(
    new Error(
      "Connect Timeout Error (attempted addresses: 103.85.145.201:443, timeout: 10000ms)",
    ),
    { code: "UND_ERR_CONNECT_TIMEOUT" },
  );
  const attemptedAddresses = [];

  const result = await fetchLineupDetail("global", GLOBAL_ID, {
    fetchFn: async () => {
      throw new TypeError("fetch failed", { cause: timeoutCause });
    },
    resolve4Fn: async () => ["103.85.145.201", "103.85.145.202"],
    addressRequestFn: async (_url, _options, address) => {
      attemptedAddresses.push(address);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          retcode: 0,
          data: { lineup: { id: GLOBAL_ID } },
        }),
      };
    },
  });

  assert.deepEqual(attemptedAddresses, ["103.85.145.202"]);
  assert.equal(result.lineup.id, GLOBAL_ID);
});

test("does not retry a Global publishing write through another address", async () => {
  const timeoutCause = Object.assign(new Error("Connect Timeout Error"), {
    code: "UND_ERR_CONNECT_TIMEOUT",
  });
  let fallbackCalls = 0;

  await assert.rejects(
    () => createGlobalLineup(
      { title: "test" },
      { cookie: "session" },
      {
        fetchFn: async () => {
          throw new TypeError("fetch failed", { cause: timeoutCause });
        },
        resolve4Fn: async () => ["163.181.246.188"],
        addressRequestFn: async () => {
          fallbackCalls += 1;
        },
      },
    ),
    (error) => error.cause?.code === "UND_ERR_CONNECT_TIMEOUT",
  );
  assert.equal(fallbackCalls, 0);
});
