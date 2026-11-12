import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as login from "../scripts/infrastructure/gcp-login-readonly.mjs";

const api = "https://sg-act-public-api.hoyolab.com/event/rpgcurrencywar";
const body = JSON.stringify({ game: "hkrpg", page: "1", limit: "1", lineup_type: "Tourn", order: "CreatedTime" });
const policyConfig = { authRequests: [{ origin: "https://account.hoyoverse.com", path: "/observed-auth-only", methods: ["GET", "POST"] }], assetOrigins: ["https://webstatic.hoyoverse.com"] };
const decide = (policy, url, method = "GET", resourceType = "fetch", postData) => policy({ url, method, resourceType, postData });

test('observed official login dependencies load without admitting strategy writes', () => {
  const policy = login.compileReadOnlyPolicy({authRequests:[
    {origin:'https://passport-api-sg.hoyolab.com',path:'/account/ma-passport/token/verifyCookieToken',methods:['POST','OPTIONS']},
    {origin:'https://sg-public-data-api.hoyoverse.com',path:'/device-fp/api/getFp',methods:['POST','OPTIONS']}
  ],assetOrigins:['https://fastcdn.hoyoverse.com','https://act.hoyolab.com','https://act.hoyoverse.com','https://webstatic.hoyoverse.com']});
  assert.equal(decide(policy,'https://passport-api-sg.hoyolab.com/account/ma-passport/token/verifyCookieToken','POST'),true);
  assert.equal(decide(policy,api+'/game/config','GET'),true);
  assert.equal(decide(policy,'https://sg-act-public-api.hoyolab.com/common/badge/v1/login/info','GET'),true);
  assert.equal(decide(policy,'https://fastcdn.hoyoverse.com/mi18n/hkrpg_global/observed/en-us.json','GET','fetch'),true);
  assert.equal(decide(policy,'https://act.hoyolab.com/gt-ui/assets/icons/example.svg','GET','fetch'),true);
  assert.equal(decide(policy,api+'/game/config','POST'),false);
  assert.equal(decide(policy,api+'/game/lineup/create_lineup_tourn','POST'),false);
  assert.equal(decide(policy,'https://fastcdn.hoyoverse.com/api','GET','fetch'),false);
});

test("only the existing exact read API and fixed harmless payload are admitted", () => {
  const policy = login.compileReadOnlyPolicy(policyConfig);
  assert.equal(decide(policy, `${api}/game/user/lineup`, "POST", "fetch", body), true);
  for (const patch of [{ limit: "20" }, { game: "other" }, { edit_lineup_id: "bad" }]) assert.equal(decide(policy, `${api}/game/user/lineup`, "POST", "fetch", JSON.stringify({ ...JSON.parse(body), ...patch })), false);
  for (const path of ["/game/lineup/create_lineup_tourn", "/game/lineup/edit", "/game/lineup/delete", "/unknown", "/game/user/lineup?write=1"]) {
    for (const method of ["GET", "POST", "PUT", "DELETE", "OPTIONS"]) assert.equal(decide(policy, api + path, method, "fetch", body), false);
  }
  assert.equal(decide(policy, `${api}/game/user/lineup`, "OPTIONS", "fetch"), true);
});
test("official auth pages work independently of request type while arbitrary auth/API writes stay blocked", () => {
  const policy = login.compileReadOnlyPolicy(policyConfig);
  assert.equal(decide(policy, "https://account.hoyoverse.com/observed-auth-only?lang=en", "POST", "xhr", "credentials-never-logged"), true);
  assert.equal(decide(policy, login.APP_URL, "GET", "document"), true);
  assert.equal(decide(policy, "https://webstatic.hoyoverse.com/script.js", "GET", "script"), true);
  for (const url of ["http://account.hoyoverse.com/observed-auth-only", "https://account.hoyoverse.com.evil.invalid/observed-auth-only", "https://account.hoyoverse.com/unapproved", "https://webstatic.hoyoverse.com/event/rpgcurrencywar/game/lineup/edit"]) assert.equal(decide(policy, url, "POST", "xhr", body), false);
  assert.equal(decide(policy, "https://webstatic.hoyoverse.com/api", "GET", "fetch"), false);
  for (const origin of ["https://evil.invalid", "https://sg-act-public-api.hoyolab.com"]) assert.throws(() => login.compileReadOnlyPolicy({ authRequests: [{ origin, path: "/game/lineup/edit", methods: ["POST"] }] }));
});
test("routing is default-deny, applies to every page, and closes WebSockets", async () => {
  let routeHandler, wsHandler;
  const context = { route: async (_, f) => { routeHandler = f; }, routeWebSocket: async (_, f) => { wsHandler = f; } };
  await login.installReadOnlyRoutes(context, login.compileReadOnlyPolicy(policyConfig));
  let continued = 0, aborted = 0, closed = 0;
  for (const url of [`${api}/game/lineup/edit`, `${api}/game/user/lineup`]) await routeHandler({ request: () => ({ url: () => url, method: () => "POST", resourceType: () => "fetch", postData: () => body }),
    fetch: async () => ({ status: () => 200, dispose: async () => {} }), fulfill: async () => { continued++; }, abort: async () => { aborted++; } });
  await wsHandler({ close: () => { closed++; } });
  assert.equal(continued, 1); assert.equal(aborted, 1); assert.equal(closed, 1);
});
test("known-host pin is required before generating an IAP loopback SSH plan", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "gcp-knownhost-test-")));
  try {
    const key = Buffer.concat([Buffer.from([0,0,0,11]), Buffer.from("ssh-ed25519"), Buffer.from([0,0,0,32]), Buffer.alloc(32, 7)]);
    const knownHostsPath = join(dir, "known_hosts");
    await writeFile(knownHostsPath, `gcp-123 ssh-ed25519 ${key.toString("base64")}\n`);
    const config = { host: "127.0.0.1", port: 22022, localViewerPort: 61080, user: "operator", identityFile: join(dir, "id_ed25519"), knownHostsPath, hostKeyAlias: "gcp-123", expectedFingerprint: `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}` };
    const args = await login.buildReadonlySshArgs(config);
    for (const flag of ["StrictHostKeyChecking=yes", `UserKnownHostsFile=${knownHostsPath.replaceAll("\\", "/")}`, "HostKeyAlias=gcp-123", "IdentitiesOnly=yes", "ExitOnForwardFailure=yes"]) assert.ok(args.includes(flag));
    assert.ok(args.includes("127.0.0.1:61080:127.0.0.1:6080"));
    await assert.rejects(login.buildReadonlySshArgs({ ...config, expectedFingerprint: "SHA256:incorrect" }));
    await assert.rejects(login.buildReadonlySshArgs({ ...config, host: "192.0.2.1" }));
    await writeFile(knownHostsPath, ""); await assert.rejects(login.buildReadonlySshArgs(config));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("fresh profile has one owner and never adopts an existing browser directory", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "gcp-profile-test-")));
  try {
    const path = join(parent, "gcp-readonly-profile-one");
    const release = await login.claimFreshProfile(path);
    await assert.rejects(login.claimFreshProfile(path));
    assert.equal((await readFile(join(path, ".readonly-owner"), "utf8")).trim(), String(process.pid));
    await release();
    await assert.rejects(login.claimFreshProfile(path));
    const existing = join(parent, "gcp-readonly-profile-existing"); await mkdir(existing); await writeFile(join(existing, "Cookies"), "private");
    await assert.rejects(login.claimFreshProfile(existing));
    assert.equal(await readFile(join(existing, "Cookies"), "utf8"), "private");
  } finally { await rm(parent, { recursive: true, force: true }); }
});
test("read-only verification runs the existing request twice and returns only a minimal result", async () => {
  const oldDocument = globalThis.document, oldFetch = globalThis.fetch; let calls = 0;
  globalThis.document = { cookie: "_HYVUUID=synthetic-secret" };
  globalThis.fetch = async (url, options) => {
    calls++; assert.equal(url, `${api}/game/user/lineup`); assert.equal(options.method, "POST"); assert.deepEqual(JSON.parse(options.body), JSON.parse(body));
    return { status: 200, json: async () => ({ retcode: 0, data: { secret: "must-not-leave-page" } }) };
  };
  try {
    const result = await login.verifyReadOnlySession({ evaluate: (fn, argument) => fn(argument) });
    assert.deepEqual(result, { authenticatedReadOnlyChecks: 2, strategyWrites: false }); assert.equal(calls, 2);
    calls = 0; globalThis.fetch = async () => ({ status: 200, json: async () => ({ retcode: ++calls === 1 ? 0 : -100, message: "secret" }) });
    await assert.rejects(login.verifyReadOnlySession({ evaluate: (fn, argument) => fn(argument) }), error => !error.message.includes("secret"));
  } finally { globalThis.document = oldDocument; globalThis.fetch = oldFetch; }
});

test("login orchestration installs guards before navigation, preserves profile ownership until browser closes", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "gcp-login-test-")));
  const steps = []; let launchOptions, ownerAtClose;
  const profile = join(parent, "gcp-readonly-profile-flow");
  const config = { account: "operator@example.invalid", project: "hsr-currency-war-worker", zone: "us-central1-a", instance: "hsr-worker-standby", maxRunSeconds: 3600,
    approvedTarget: { account: "operator@example.invalid", project: "hsr-currency-war-worker", zone: "us-central1-a", instance: "hsr-worker-standby", instanceId: "123", diskId: "456" },
    login: { ...policyConfig, profileDir: profile, maxSeconds: 10 } };
  const page = { goto: async () => { steps.push("navigate"); }, bringToFront: async () => {}, url: () => login.APP_URL, evaluate: async () => true };
  const context = { route: async () => { steps.push("guard"); }, routeWebSocket: async () => { steps.push("ws-guard"); },
    pages: () => [{ close: async () => { steps.push("initial-close"); } }], newPage: async () => { steps.push("new-page"); return page; },
    close: async () => { steps.push("close"); ownerAtClose = await readFile(join(profile, ".readonly-owner"), "utf8"); } };
  try {
    const result = await login.runReadOnlyLogin({ config, checkIdentity: async () => { steps.push("identity"); }, checkIdle: async () => { steps.push("idle"); },
      confirmReady: async () => { steps.push("manual-ready"); }, launchPersistentContext: async (_, options) => { launchOptions = options; steps.push("launch"); return context; } });
    assert.deepEqual(result, { authenticatedReadOnlyChecks: 2, strategyWrites: false });
    assert.deepEqual(steps, ["identity", "idle", "launch", "guard", "ws-guard", "new-page", "initial-close", "navigate", "manual-ready", "idle", "close"]);
    assert.equal(launchOptions.serviceWorkers, "block"); assert.equal(launchOptions.chromiumSandbox, true); assert.equal(launchOptions.acceptDownloads, false);
    assert.equal(ownerAtClose.trim(), String(process.pid));
    await assert.rejects(readFile(join(profile, ".readonly-owner")), { code: "ENOENT" });
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("failed identity or active writer prevents any browser launch", async () => {
  const config = { account: "operator@example.invalid", project: "hsr-currency-war-worker", zone: "us-central1-a", instance: "hsr-worker-standby", maxRunSeconds: 3600,
    approvedTarget: { account: "operator@example.invalid", project: "hsr-currency-war-worker", zone: "us-central1-a", instance: "hsr-worker-standby", instanceId: "123", diskId: "456" },
    login: { ...policyConfig, profileDir: "D:/unused", maxSeconds: 10 } };
  let launches = 0;
  for (const failure of ["identity", "idle"]) await assert.rejects(login.runReadOnlyLogin({ config, checkIdentity: async () => { if (failure === "identity") throw new Error("wrong VM"); },
    checkIdle: async () => { if (failure === "idle") throw new Error("writer active"); }, launchPersistentContext: async () => { launches++; } }));
  assert.equal(launches, 0);
});

test("VM identity uses only four pinned metadata reads and rejects project or ID drift", async () => {
  const config = { instance: "hsr-worker-standby", project: "hsr-currency-war-worker", zone: "us-central1-a", approvedTarget: { instanceId: "123" } };
  const values = { "instance/id": "123", "instance/name": "hsr-worker-standby", "instance/zone": "projects/456/zones/us-central1-a", "project/project-id": "hsr-currency-war-worker" };
  const seen = [];
  const fetchFn = async (url, options) => { assert.equal(options.headers["Metadata-Flavor"], "Google"); assert.equal(options.redirect, "error"); seen.push(url); return { ok: true, headers: new Headers({ "Metadata-Flavor": "Google" }), text: async () => values[url.split("/computeMetadata/v1/")[1]] }; };
  await login.assertVmIdentity(config, { fetchFn }); assert.equal(seen.length, 4);
  await assert.rejects(login.assertVmIdentity({ ...config, project: "other" }, { fetchFn }));
  await assert.rejects(login.assertVmIdentity({ ...config, approvedTarget: { instanceId: "replacement" } }, { fetchFn }));
});

test("idle check rejects restarting services, nonzero PIDs and manual writers", async () => {
  for (const stdout of ["LoadState=loaded\nActiveState=activating\nMainPID=0", "LoadState=loaded\nActiveState=inactive\nMainPID=123"]) await assert.rejects(login.assertIdle({ execFn: async () => ({ stdout }), listPids: async () => [] }));
  const execFn = async () => ({ stdout: "LoadState=loaded\nActiveState=inactive\nMainPID=0" });
  for (const command of ["worker-server", "synthetic-worker-server", "transfer", "adopt-mapping", "connector-login"]) await assert.rejects(login.assertIdle({ execFn, listPids: async () => ["123"], readArgs: async () => `node\0/opt/worker/${command}.mjs\0` }));
  await login.assertIdle({ execFn, listPids: async () => [] });
});

test("real Chrome blocks strategy fetches and WebSockets before any proxy connection", { skip: process.env.HSR_READONLY_BROWSER_GUARD_TEST !== "1" }, async () => {
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("node:http");
  const parent = await realpath(await mkdtemp(join(tmpdir(), "gcp-route-browser-test-")));
  const connections = []; let context;
  // A rejecting loopback proxy makes accidental upstream traffic impossible.
  const proxy = createServer((request, response) => { connections.push(request.url); response.writeHead(502).end(); });
  proxy.on("connect", (request, socket) => { connections.push(request.url); socket.destroy(); });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  try {
    context = await chromium.launchPersistentContext(join(parent, "profile"), { channel: "chrome", headless: true,
      chromiumSandbox: true, serviceWorkers: "block", acceptDownloads: false, timeout: 20000,
      proxy: { server: `http://127.0.0.1:${proxy.address().port}` }, args: ["--disable-background-networking", "--disable-extensions"] });
    await login.installReadOnlyRoutes(context, login.compileReadOnlyPolicy(policyConfig));
    const page = await context.newPage();
    await page.setContent("<title>Read-only request guard</title>");
    const before = connections.length;
    const requests = await page.evaluate(async () => {
      const requests = [];
      for (const suffix of ["create_lineup_tourn", "edit", "delete"]) for (const method of ["GET", "POST", "DELETE"]) {
        try { await fetch(`https://sg-act-public-api.hoyolab.com/event/rpgcurrencywar/game/lineup/${suffix}`, { method }); requests.push("unexpected"); }
        catch { requests.push("blocked"); }
      }
      return requests;
    });
    const afterFetch = connections.slice(before);
    const socketBlocked = await page.evaluate(() => new Promise(resolve => {
        const socket = new WebSocket("wss://sg-act-public-api.hoyolab.com/strategy-write");
        socket.onopen = () => { socket.close(); resolve(false); };
        socket.onerror = () => resolve(true); socket.onclose = () => resolve(true);
      }));
    assert.deepEqual(requests, Array(9).fill("blocked")); assert.equal(socketBlocked, true);
    assert.deepEqual(afterFetch, []);
    assert.deepEqual(connections.slice(before), []);
  } finally {
    try { await context?.close(); }
    finally { await new Promise(resolve => proxy.close(resolve)); await rm(parent, { recursive: true, force: true }); }
  }
});

test("allowed auth cannot follow an upstream redirect into a strategy write", async () => {
  let handler, followed = false, aborted = false;
  await login.installReadOnlyRoutes({ route: async (_, fn) => { handler = fn; }, routeWebSocket: async () => {} }, login.compileReadOnlyPolicy(policyConfig));
  await handler({ request: () => ({ url: () => "https://account.hoyoverse.com/observed-auth-only", method: () => "POST", resourceType: () => "fetch", postData: () => "auth-data" }),
    continue: async () => { followed = true; }, fetch: async options => { assert.equal(options.maxRedirects, 0); return { status: () => 307, dispose: async () => {} }; },
    fulfill: async () => { followed = true; }, abort: async () => { aborted = true; } });
  assert.equal(followed, false); assert.equal(aborted, true);
});

test("login timeout closes the owned browser and leaves its profile private", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "gcp-login-timeout-test-")));
  const profile = join(parent, "gcp-readonly-profile-timeout"); let closed = 0;
  const config = { account: "operator@example.invalid", project: "hsr-currency-war-worker", zone: "us-central1-a", instance: "hsr-worker-standby", maxRunSeconds: 3600,
    approvedTarget: { account: "operator@example.invalid", project: "hsr-currency-war-worker", zone: "us-central1-a", instance: "hsr-worker-standby", instanceId: "123", diskId: "456" },
    login: { profileDir: profile, maxSeconds: 1 } };
  const page = { goto: async () => {}, bringToFront: async () => {} };
  try {
    await assert.rejects(login.runReadOnlyLogin({ config, checkIdentity: async () => {}, checkIdle: async () => {}, confirmReady: async () => new Promise(() => {}),
      launchPersistentContext: async () => ({ route: async () => {}, routeWebSocket: async () => {}, pages: () => [], newPage: async () => page, close: async () => { closed++; } }) }), /timed out/);
    assert.equal(closed, 1); await assert.rejects(readFile(join(profile, ".readonly-owner")), { code: "ENOENT" });
    await assert.rejects(login.claimFreshProfile(profile));
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("OpenSSH option parsing cannot switch to an unverified known-hosts file", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "gcp-ssh-path-test-")));
  try {
    const key = Buffer.concat([Buffer.from([0,0,0,11]), Buffer.from("ssh-ed25519"), Buffer.from([0,0,0,32]), Buffer.alloc(32, 7)]);
    for (const name of ["known hosts", "known%h", "known${HOSTNAME}"]) {
      const knownHostsPath = join(parent, name); await writeFile(knownHostsPath, `gcp-123 ssh-ed25519 ${key.toString("base64")}\n`);
      await assert.rejects(login.buildReadonlySshArgs({ host: "127.0.0.1", port: 22022, localViewerPort: 61080, user: "operator", identityFile: join(parent, "id"), knownHostsPath,
        hostKeyAlias: "gcp-123", expectedFingerprint: `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}` }));
    }
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("one shared login lock excludes a second owner even with another fresh profile", async () => {
  assert.equal(typeof login.claimLoginSession, "function");
  const parent = await realpath(await mkdtemp(join(tmpdir(), "gcp-session-lock-test-")));
  try {
    const release = await login.claimLoginSession(parent);
    await assert.rejects(login.claimLoginSession(parent));
    await release(); const nextRelease = await login.claimLoginSession(parent); await nextRelease();
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("idle admission rejects other Chrome and read-only login owners, but permits this process", async () => {
  const execFn = async () => ({ stdout: "LoadState=loaded\nActiveState=inactive\nMainPID=0" });
  for (const args of ["/opt/google/chrome/chrome\0--user-data-dir=/private/other", "node\0/opt/worker/gcp-login-readonly.mjs\0login", "/usr/bin/chromium\0"]) {
    await assert.rejects(login.assertIdle({ execFn, listPids: async () => ["123456789"], readArgs: async () => args }));
  }
  await login.assertIdle({ execFn, listPids: async () => [String(process.pid)], readArgs: async () => "node\0/opt/worker/gcp-login-readonly.mjs\0login" });
});

test("post-launch idle check admits only Chrome descendants of this login process", async () => {
  const execFn = async () => ({ stdout: "LoadState=loaded\nActiveState=inactive\nMainPID=0" });
  const dependencies = { execFn, allowOwnedBrowser: true, listPids: async () => ["987654321", "987654322"],
    readArgs: async () => "/opt/google/chrome/chrome\0--type=renderer", readParent: async pid => pid === "987654321" ? String(process.pid) : "987654321" };
  await login.assertIdle(dependencies);
  await assert.rejects(login.assertIdle({ ...dependencies, readParent: async () => "1" }));
});
