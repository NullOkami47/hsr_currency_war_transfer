import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeTotpSecret,
  generateTotpSecret,
  totpCode,
  verifyTotpCode,
} from "../src/totp.mjs";

const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("matches the RFC 6238 SHA-1 test vector", () => {
  assert.equal(
    totpCode(RFC_SECRET, {
      now: new Date("1970-01-01T00:00:59.000Z"),
      digits: 8,
    }),
    "94287082",
  );
});

test("accepts one adjacent time step and rejects malformed codes", () => {
  const now = new Date("1970-01-01T00:01:29.000Z");
  assert.equal(verifyTotpCode(RFC_SECRET, "287082", { now }), true);
  assert.equal(verifyTotpCode(RFC_SECRET, "287082", { now, window: 0 }), false);
  assert.equal(verifyTotpCode(RFC_SECRET, "28 7082", { now }), false);
  assert.equal(verifyTotpCode(RFC_SECRET, "28708a", { now }), false);
});

test("rejects invalid or undersized Base32 secrets", () => {
  assert.throws(() => decodeTotpSecret("not!base32"), /Base32/);
  assert.throws(() => decodeTotpSecret("JBSWY3DP"), /20 bytes/);
});

test("generates a cryptographically sourced 20-byte Base32 setup key", () => {
  const secret = generateTotpSecret({
    randomBytesFn: (length) => Buffer.alloc(length, 0xab),
  });
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.deepEqual(decodeTotpSecret(secret), Buffer.alloc(20, 0xab));
});
