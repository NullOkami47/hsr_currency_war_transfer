import assert from "node:assert/strict";
import test from "node:test";

import {
  getSearchErrorPresentation,
  retainKnownRoleIds,
} from "../public/search-error.js";

test("presents an invalid source as a correctable input error", () => {
  assert.deepEqual(
    getSearchErrorPresentation(400, {
      error: { code: "invalid_request", reason: "invalid_source" },
    }),
    {
      titleKey: "searchInputErrorTitle",
      bodyKey: "searchInvalidSource",
      refreshRoles: false,
    },
  );
});

test("refreshes stale role criteria without broadening the search silently", () => {
  assert.deepEqual(
    getSearchErrorPresentation(400, {
      error: { code: "invalid_request", reason: "stale_role_ids" },
    }),
    {
      titleKey: "searchInputErrorTitle",
      bodyKey: "searchStaleRoles",
      refreshRoles: true,
    },
  );
  assert.deepEqual(
    retainKnownRoleIds(["1001", "removed"], new Map([["1001", {}]])),
    ["1001"],
  );
});

test("refreshes stale Bond criteria without broadening the search silently", () => {
  assert.deepEqual(
    getSearchErrorPresentation(400, {
      error: { code: "invalid_request", reason: "stale_bond_ids" },
    }),
    {
      titleKey: "searchInputErrorTitle",
      bodyKey: "searchStaleBonds",
      refreshRoles: true,
    },
  );
});

test("keeps upstream failures on the temporary China service message", () => {
  assert.deepEqual(
    getSearchErrorPresentation(502, {
      error: { code: "china_service_error" },
    }),
    {
      titleKey: "searchErrorTitle",
      bodyKey: "searchErrorBody",
      refreshRoles: false,
    },
  );
});
