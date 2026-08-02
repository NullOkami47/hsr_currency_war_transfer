import assert from "node:assert/strict";
import test from "node:test";

import { localInstanceMatches } from "../src/local-instance.mjs";

test("only identifies the local process when its instance nonce matches", async () => {
  const matching = await localInstanceMatches(
    "http://127.0.0.1/health",
    "expected",
    {
      fetchFn: async () => ({
        ok: true,
        headers: new Headers({ "x-currency-war-instance": "expected" }),
      }),
    },
  );
  const stale = await localInstanceMatches(
    "http://127.0.0.1/health",
    "expected",
    {
      fetchFn: async () => ({
        ok: true,
        headers: new Headers({ "x-currency-war-instance": "different" }),
      }),
    },
  );
  assert.equal(matching, true);
  assert.equal(stale, false);
});
