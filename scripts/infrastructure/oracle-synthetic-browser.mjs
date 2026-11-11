// Run as the dedicated non-root user in a fresh, isolated Linux network namespace.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readlink, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

if (process.platform !== "linux" || !process.getuid || process.getuid() === 0) {
  throw new Error("Run as a non-root Linux user in an isolated network namespace");
}
// The trusted launcher captures its namespace before unshare and passes it in
// a cleared environment. Non-root users may not read /proc/1/ns/net.
const parentNetwork = process.env.CURRENCY_WAR_SYNTHETIC_PARENT_NETNS;
if (!/^net:\[\d+\]$/.test(parentNetwork ?? "")) {
  throw new Error("Missing or invalid parent network namespace marker");
}
const ownNetwork = await readlink("/proc/self/ns/net");
if (!/^net:\[\d+\]$/.test(ownNetwork) || ownNetwork === parentNetwork
    || Object.values(networkInterfaces()).flat().some((entry) => !entry.internal)) {
  throw new Error("Refusing to run: network namespace is not isolated");
}

const directory = await mkdtemp(join(tmpdir(), "hsr-oracle-synthetic-"));
let context;
let result;
try {
  const executablePath = chromium.executablePath();
  const launch = () => chromium.launchPersistentContext(directory, {
    executablePath, chromiumSandbox: true, headless: true, viewport: { width: 1440, height: 1000 },
  });
  context = await launch();
  const version = execFileSync(executablePath, ["--version"], { encoding: "utf8" }).trim();
  const page = context.pages()[0] ?? await context.newPage();
  await page.setContent("<title>Synthetic staging</title><p>offline</p>");
  assert.equal(await page.title(), "Synthetic staging");
  await context.addCookies([{
    name: "synthetic", value: "staging-only", url: "http://127.0.0.1/",
    expires: Math.floor(Date.now() / 1000) + 3600,
  }]);
  await context.close();
  context = await launch();
  const cookies = await context.cookies("http://127.0.0.1/");
  assert.equal(cookies.find((cookie) => cookie.name === "synthetic")?.value, "staging-only");
  result = { result: "pass", browserVersion: version, executablePath,
    playwrightVersion: createRequire(import.meta.url)("playwright-core/package.json").version,
    network: "isolated namespace", profile: "synthetic temporary profile" };
} finally {
  try {
    await context?.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
console.log(JSON.stringify(result));
