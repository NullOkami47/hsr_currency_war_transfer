import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("administrator page exposes labelled safety controls and an audit table", async () => {
  const html = await readFile(
    new URL("../public/admin.html", import.meta.url),
    "utf8",
  );

  for (const id of [
    "admin-totp",
    "setting-public-enabled",
    "setting-blacklist-enabled",
    "setting-blacklist",
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
  assert.match(html, /來源封鎖清單（blacklist）/);
  assert.match(html, /<th scope="col">/);
  assert.match(html, /<link rel="icon" href="\/favicon\.svg"/);
  assert.match(html, /匿名 Internet 使用者會消耗發布帳戶的每日配額/);
  assert.match(html, /專用的 HoYoLAB 發布帳戶/);
  assert.match(html, /不要使用高價值的個人帳戶/);
  assert.doesNotMatch(html, /value="[^\"]*admin[^\"]*token/i);
});

test("administrator script keeps credentials out of browser storage", async () => {
  const script = await readFile(
    new URL("../public/admin.js", import.meta.url),
    "utf8",
  );

  assert.match(script, /"x-csrf-token": state\.csrfToken/);
  assert.match(script, /elements\["admin-token"\]\.value = ""/);
  assert.match(script, /elements\["admin-totp"\]\.value = ""/);
  assert.match(script, /JSON\.stringify\(\{ token, totp \}\)/);
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

test("completed transfers expose an official Global strategy link", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="view-global-strategy"/);
  assert.match(html, /target="_blank" rel="noreferrer"/);
  assert.match(script, /if \(data\.globalUrl\)/);
  assert.match(script, /elements\["view-global-strategy"\]\.href/);
  assert.match(script, /viewGlobalStrategy: "開啟已完成的國際服攻略"/);
});

test("uses international-service terminology across the localised website", async () => {
  const localisedUi = (
    await Promise.all([
      "app.js",
      "history-page.js",
      "history.html",
      "index.html",
      "showcase.html",
    ].map((file) => readFile(new URL(`../public/${file}`, import.meta.url), "utf8")))
  ).join("\n");

  assert.doesNotMatch(localisedUi, /全球服/);
  assert.match(localisedUi, /國際服/);
  assert.match(localisedUi, /国际服/);
});
