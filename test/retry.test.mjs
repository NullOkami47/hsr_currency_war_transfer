import assert from "node:assert/strict";
import test from "node:test";

import { retryRead } from "../src/retry.mjs";

test("backs off safe read retries exponentially", async () => {
  const waits = [];
  let attempts = 0;

  const result = await retryRead(
    async () => {
      attempts += 1;
      if (attempts < 4) throw new TypeError("fetch failed");
      return "ok";
    },
    {
      attempts: 4,
      retryDelayMs: 100,
      backoffFactor: 2,
      waitFn: async (milliseconds) => waits.push(milliseconds),
    },
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 4);
  assert.deepEqual(waits, [100, 200, 400]);
});
