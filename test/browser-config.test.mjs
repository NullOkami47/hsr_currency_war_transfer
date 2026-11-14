import assert from "node:assert/strict";
import test from "node:test";

import { BrowserSessionPublisher } from "../src/publisher.mjs";

// Only the browser boundary is replaced: no real profile, network or login.
function configuredPublisher(env, options) {
  const keys = [
    "CURRENCY_WAR_BROWSER_CHANNEL",
    "CURRENCY_WAR_BROWSER_EXECUTABLE_PATH",
    "CURRENCY_WAR_CHROMIUM_SANDBOX",
  ];
  const previous = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    return new BrowserSessionPublisher({ profileDir: "unused-test-profile", ...options });
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
}

for (const { name, env, options = {}, selection } of [
  { name: "retains Azure Chrome default", env: {}, selection: { channel: "chrome" } },
  { name: "treats empty environment settings as defaults", env: {
    CURRENCY_WAR_BROWSER_CHANNEL: "", CURRENCY_WAR_BROWSER_EXECUTABLE_PATH: "",
  }, selection: { channel: "chrome" } },
  { name: "uses an environment-selected browser channel", env: {
    CURRENCY_WAR_BROWSER_CHANNEL: "chromium",
  }, selection: { channel: "chromium" } },
  { name: "uses an executable without passing a conflicting channel", env: {
    CURRENCY_WAR_BROWSER_CHANNEL: "chrome",
    CURRENCY_WAR_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
  }, selection: { executablePath: "/usr/bin/chromium" } },
  { name: "preserves explicit constructor channel over environment", env: {
    CURRENCY_WAR_BROWSER_CHANNEL: "chromium",
  }, options: { browserChannel: "msedge" }, selection: { channel: "msedge" } },
  { name: "preserves explicit executable paths containing spaces", env: {
    CURRENCY_WAR_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
  }, options: { browserExecutablePath: "D:/Test Browser/chrome.exe" },
  selection: { executablePath: "D:/Test Browser/chrome.exe" } },
]) {
  test(name, async () => {
    const calls = [];
    const publisher = configuredPublisher(env, {
      ...options,
      headless: true,
      launchPersistentContext: async (profile, launchOptions) => {
        calls.push({ profile, launchOptions });
        return { pages: () => [{ async goto() {} }], async close() {} };
      },
    });
    await publisher.start();
    await publisher.close();
    // Recovery/restart must retain the same selection too.
    await publisher.start();
    await publisher.close();
    assert.deepEqual(calls, Array.from({ length: 2 }, () => ({
      profile: "unused-test-profile",
      launchOptions: { ...selection, chromiumSandbox: true, headless: true, viewport: { width: 1440, height: 1000 } },
    })));
  });
}

test("rejects disabling the Chromium OS sandbox via options or environment", async () => {
  let launches = 0;
  for (const [env, options] of [
    [{}, { chromiumSandbox: false }],
    [{ CURRENCY_WAR_CHROMIUM_SANDBOX: "0" }, {}],
    [{ CURRENCY_WAR_CHROMIUM_SANDBOX: "false" }, {}],
  ]) {
    assert.throws(
      () => configuredPublisher(env, {
        ...options,
        launchPersistentContext: async () => { launches += 1; },
      }),
      { name: "TypeError", message: "Chromium sandbox must remain explicitly enabled" },
    );
  }
  assert.equal(launches, 0);
});

test("propagates executable launch failure without falling back to another browser", async () => {
  const failure = new Error("Browser executable does not exist");
  let launches = 0;
  const publisher = configuredPublisher({
    CURRENCY_WAR_BROWSER_EXECUTABLE_PATH: "/missing/chromium",
  }, {
    launchPersistentContext: async () => { launches += 1; throw failure; },
  });
  await assert.rejects(publisher.start(), (error) => error === failure);
  assert.equal(launches, 1);
  assert.equal(publisher.context, null);
});
