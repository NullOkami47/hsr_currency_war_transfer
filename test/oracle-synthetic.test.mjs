import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import test from "node:test";
import { chromium } from "playwright-core";

// These tests replace the browser and namespace observations only. They never
// open a browser, touch real profiles, or make network requests.
function mockHost(t, { isolated = true, externalInterface = false, root = false, parentMarker = true } = {}) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const getuid = Object.getOwnPropertyDescriptor(process, "getuid");
  const parent = process.env.CURRENCY_WAR_SYNTHETIC_PARENT_NETNS;
  if (parentMarker) process.env.CURRENCY_WAR_SYNTHETIC_PARENT_NETNS = parentMarker === "invalid" ? "bad-marker" : isolated ? "net:[1]" : "net:[2]";
  else delete process.env.CURRENCY_WAR_SYNTHETIC_PARENT_NETNS;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  Object.defineProperty(process, "getuid", { value: () => root ? 0 : 1000, configurable: true });
  t.mock.method(fs, "readlink", async (path) => {
    if (path !== "/proc/self/ns/net") throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return "net:[2]";
  });
  t.mock.method(os, "networkInterfaces", () => ({
    lo: [{ internal: true }], ...(externalInterface ? { eth0: [{ internal: false }] } : {}),
  }));
  t.mock.method(childProcess, "execFileSync", () => "synthetic-chromium 1.0\n");
  t.mock.method(chromium, "executablePath", () => "/synthetic/chromium");
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platform);
    if (parent === undefined) delete process.env.CURRENCY_WAR_SYNTHETIC_PARENT_NETNS;
    else process.env.CURRENCY_WAR_SYNTHETIC_PARENT_NETNS = parent;
    if (getuid) Object.defineProperty(process, "getuid", getuid);
    else delete process.getuid;
  });
}

let importCounter = 0;
function runBrowserScript() {
  return import(new URL(`../scripts/infrastructure/oracle-synthetic-browser.mjs?test=${++importCounter}`, import.meta.url));
}

test("synthetic browser uses sandbox on both launches and removes its profile", async (t) => {
  mockHost(t);
  const calls = [];
  const output = [];
  t.mock.method(console, "log", (line) => output.push(JSON.parse(line)));
  let cookie;
  let closes = 0;
  t.mock.method(chromium, "launchPersistentContext", async (directory, options) => {
    calls.push({ directory, options });
    return {
      pages: () => [{ setContent: async () => {}, title: async () => "Synthetic staging" }],
      addCookies: async (values) => { [cookie] = values; },
      cookies: async () => [cookie],
      close: async () => { closes += 1; },
    };
  });
  await runBrowserScript();
  assert.equal(output[0].browserVersion, "synthetic-chromium 1.0");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].directory, calls[1].directory);
  for (const { options } of calls) {
    assert.equal(options.executablePath, "/synthetic/chromium");
    assert.equal(options.chromiumSandbox, true);
    assert.equal(options.headless, true);
    assert.deepEqual(options.viewport, { width: 1440, height: 1000 });
  }
  assert.equal(closes, 2);
  await assert.rejects(fs.access(calls[0].directory), { code: "ENOENT" });
});

for (const scenario of [
  { name: "root", options: { root: true }, message: /non-root Linux/ },
  { name: "missing parent namespace", options: { parentMarker: false }, message: /parent network namespace/ },
  { name: "invalid parent namespace", options: { parentMarker: "invalid" }, message: /parent network namespace/ },
  { name: "shared namespace", options: { isolated: false }, message: /network namespace is not isolated/ },
  { name: "external interface", options: { externalInterface: true }, message: /network namespace is not isolated/ },
]) {
  test(`synthetic browser rejects ${scenario.name} before launch`, async (t) => {
    mockHost(t, scenario.options);
    let launches = 0;
    t.mock.method(chromium, "launchPersistentContext", async () => { launches += 1; });
    await assert.rejects(runBrowserScript(), scenario.message);
    assert.equal(launches, 0);
  });
}

test("synthetic browser cleans up and does not retry after launch fails", async (t) => {
  mockHost(t);
  const failure = new Error("sandbox unavailable");
  let directory;
  let launches = 0;
  t.mock.method(chromium, "launchPersistentContext", async (profile) => {
    directory = profile;
    launches += 1;
    throw failure;
  });
  await assert.rejects(runBrowserScript(), (error) => error === failure);
  assert.equal(launches, 1);
  await assert.rejects(fs.access(directory), { code: "ENOENT" });
});
test("synthetic browser removes its profile even if closing the context fails", async (t) => {
  mockHost(t);
  const failure = new Error("synthetic close failure");
  let directory;
  t.mock.method(chromium, "launchPersistentContext", async (profile) => {
    directory = profile;
    return {
      pages: () => [{ setContent: async () => {}, title: async () => "Synthetic staging" }],
      addCookies: async () => {},
      close: async () => { throw failure; },
    };
  });
  try {
    await assert.rejects(runBrowserScript(), (error) => error === failure);
    await assert.rejects(fs.access(directory), { code: "ENOENT" });
  } finally {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
});
test("synthetic browser cleans its profile when executable lookup fails", async (t) => {
  mockHost(t);
  const failure = new Error("synthetic executable lookup failure");
  const makeTemp = fs.mkdtemp;
  let directory;
  t.mock.method(fs, "mkdtemp", async (...args) => { directory = await makeTemp(...args); return directory; });
  t.mock.method(chromium, "executablePath", () => { throw failure; });
  syncBuiltinESMExports();
  try {
    await assert.rejects(runBrowserScript(), (error) => error === failure);
    await assert.rejects(fs.access(directory), { code: "ENOENT" });
  } finally {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
});
test("synthetic browser does not report success when final close fails", async (t) => {
  mockHost(t);
  const output = [];
  const failure = new Error("synthetic final close failure");
  let launches = 0;
  let directory;
  let cookie;
  t.mock.method(console, "log", (line) => output.push(line));
  t.mock.method(chromium, "launchPersistentContext", async (profile) => {
    directory = profile;
    const launch = ++launches;
    return {
      pages: () => [{ setContent: async () => {}, title: async () => "Synthetic staging" }],
      addCookies: async (values) => { [cookie] = values; },
      cookies: async () => [cookie],
      close: async () => { if (launch === 2) throw failure; },
    };
  });
  try {
    await assert.rejects(runBrowserScript(), (error) => error === failure);
    assert.deepEqual(output, []);
    await assert.rejects(fs.access(directory), { code: "ENOENT" });
  } finally {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
});