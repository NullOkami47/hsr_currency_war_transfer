import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("administrator page exposes labelled safety controls and an audit table", async () => {
  const html = await readFile(
    new URL("../public/admin.html", import.meta.url),
    "utf8",
  );

  for (const id of [
    "setting-public-enabled",
    "setting-allowlist-enabled",
    "setting-allowlist",
    "setting-ip-limit",
    "setting-ip-window",
    "setting-daily-quota",
    "setting-max-pending",
    "setting-retention-days",
    "setting-max-stored",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /<table>/);
  assert.match(html, /<th scope="col">/);
  assert.doesNotMatch(html, /value="[^\"]*admin[^\"]*token/i);
});

test("administrator script keeps credentials out of browser storage", async () => {
  const script = await readFile(
    new URL("../public/admin.js", import.meta.url),
    "utf8",
  );

  assert.match(script, /"x-csrf-token": state\.csrfToken/);
  assert.match(script, /elements\["admin-token"\]\.value = ""/);
  assert.match(
    script,
    /state\.csrfToken = session\.csrfToken;\s+showConsole\(\);\s+await loadDashboard/,
  );
  assert.doesNotMatch(script, /localStorage\.setItem\([^)]*token/i);
  assert.doesNotMatch(script, /sessionStorage/i);
});

test("expired candidates cannot be selected or submitted", async () => {
  const script = await readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );

  assert.match(script, /radio\.disabled = Boolean\(candidate\.isExpired\)/);
  assert.match(
    script,
    /if \(!candidate\.isExpired && !event\.target\.closest\("a, button, input"\)\) selectCandidate/,
  );
  assert.match(script, /candidate--expired/);
});
