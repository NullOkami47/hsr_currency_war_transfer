// Synthetic compatibility diagnostic only. Never loads a HoYoLAB URL or profile.
import assert from "node:assert/strict";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function probeBrowser() {
  if (process.platform !== "linux" || process.getuid() === 0) {
    throw new Error("The diagnostic requires a non-root Linux user");
  }
  const { chromium } = await import("playwright-core");
  const directory = await mkdtemp(join(tmpdir(), "hsr-gcp-synthetic-"));
  let context;
  let version;
  try {
    const options = {
      ...(process.env.CURRENCY_WAR_BROWSER_EXECUTABLE_PATH
        ? { executablePath: process.env.CURRENCY_WAR_BROWSER_EXECUTABLE_PATH }
        : { channel: process.env.CURRENCY_WAR_BROWSER_CHANNEL || "chromium" }),
      chromiumSandbox: true, headless: true, timeout: 20_000,
      serviceWorkers: "block",
    };
    context = await chromium.launchPersistentContext(directory, options);
    // Fresh synthetic profile: no restored tabs, login data or external URLs.
    await context.route("**/*", route => route.abort());
    const page = context.pages()[0] ?? await context.newPage();
    await page.setContent("<title>HSR synthetic browser probe</title>");
    assert.equal(await page.title(), "HSR synthetic browser probe");
    version = context.browser().version();
    await context.addCookies([{
      name: "synthetic", value: "probe-only", url: "http://127.0.0.1/",
      expires: Math.floor(Date.now() / 1000) + 3600,
    }]);
    await context.close();
    context = null;
    context = await chromium.launchPersistentContext(directory, options);
    await context.route("**/*", route => route.abort());
    assert.equal((await context.cookies("http://127.0.0.1/"))
      .find(cookie => cookie.name === "synthetic")?.value, "probe-only");
  } finally {
    try { await context?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
  return { synthetic: true, browserVersion: version, sandboxRequested: true,
    launches: 2, cookiePersistedAcrossBrowserRestart: true,
    node: process.version, arch: process.arch, nodeRssBytes: process.memoryUsage().rss };
}

export function createProbeHandler({ token, probe = probeBrowser, probeTimeoutMs = 60_000,
  onTimeout = () => {} } = {}) {
  if (typeof token !== "string" || token.length < 32 || token.length > 256) {
    throw new Error("HSR_PROBE_TOKEN must contain 32 to 256 characters");
  }
  if (!Number.isInteger(probeTimeoutMs) || probeTimeoutMs < 1 || probeTimeoutMs > 120_000) {
    throw new Error("Invalid probe deadline");
  }
  let poisoned = false;
  const digest = value => createHash("sha256").update(value).digest();
  const expected = digest(`Bearer ${token}`);
  let busy = false;
  return async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET" && request.url === "/health") {
      send(poisoned ? 503 : 200, { status: poisoned ? "restart_required" : "ok", mode: "synthetic-browser-probe" });
      return;
    }
    const supplied = request.headers.authorization;
    if (typeof supplied !== "string" || supplied.length > 512
      || !timingSafeEqual(expected, digest(supplied))) {
      send(401, { error: "unauthorised" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/probe") {
      send(404, { error: "not_found" });
      return;
    }
    if (request.headers["transfer-encoding"] || Number(request.headers["content-length"] ?? 0) !== 0) {
      send(400, { error: "body_not_permitted" });
      return;
    }
    if (poisoned) {
      send(503, { error: "restart_required" });
      return;
    }
    if (busy) {
      response.setHeader("retry-after", "5");
      send(429, { error: "probe_busy" });
      return;
    }
    busy = true;
    let timer;
    const deadline = Symbol("deadline");
    try {
      const result = await Promise.race([
        Promise.resolve().then(probe),
        new Promise(resolve => { timer = setTimeout(() => resolve(deadline), probeTimeoutMs); }),
      ]);
      if (result === deadline) {
        // Never release ownership while a stuck browser may still be alive.
        // The executable exits so the container runtime kills its process tree.
        poisoned = true;
        send(503, { error: "probe_deadline_exceeded" });
        onTimeout();
      } else send(200, result);
    } catch { send(503, { error: "synthetic_browser_probe_failed" }); }
    finally { clearTimeout(timer); if (!poisoned) busy = false; }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  const server = createServer(createProbeHandler({ token: process.env.HSR_PROBE_TOKEN,
    onTimeout: () => { setTimeout(() => process.exit(1), 100).unref(); } }));
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.listen(port, "0.0.0.0");
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 8_000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
