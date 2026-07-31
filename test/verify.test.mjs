import assert from "node:assert/strict";
import test from "node:test";

import {
  diffPayloads,
  TransferVerificationError,
  verifyTransferPayload,
} from "../src/verify.mjs";

function payload(portalId = "106") {
  return {
    title: "來源攻略",
    description: "來源營運概念",
    lineup_type: "Tourn",
    tourn_detail: {
      portals: [{ id: portalId }],
      role_stages: [
        {
          stage: "Final",
          front_roles: [{ id: "1510", star: 1 }],
          back_roles: [],
        },
      ],
    },
  };
}

test("post-publish verification rejects wrong gameplay items", () => {
  const expected = payload();
  const actual = {
    ...payload("116"),
    title: "\"6 Debuff\"來源攻略",
    description: "來源營運概念\n來源署名",
  };

  assert.deepEqual(
    diffPayloads(expected, actual, {
      ignorePaths: ["$.title", "$.description"],
    }),
    [
      {
        path: "$.tourn_detail.portals[0].id",
        expected: "106",
        actual: "116",
      },
    ],
  );

  assert.throws(
    () =>
      verifyTransferPayload(expected, actual, {
        ignorePaths: ["$.title", "$.description"],
      }),
    (error) =>
      error instanceof TransferVerificationError &&
      error.differences.length === 1,
  );
});

test("post-publish verification accepts an exact gameplay payload", () => {
  const expected = payload();
  const actual = {
    ...payload(),
    title: "\"3 AoE\"來源攻略",
    description: "來源營運概念\n來源署名",
  };

  assert.deepEqual(
    verifyTransferPayload(expected, actual, {
      ignorePaths: ["$.title", "$.description"],
    }),
    { ok: true, differences: [] },
  );
});
