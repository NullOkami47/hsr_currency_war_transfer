// Deliberately does not import BrowserSessionPublisher or any worker/store.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from 'node:timers/promises';
import { createLoginStartupGate } from './gcp-login-startup-gate.mjs';
import { REGIONS } from "../../src/api.mjs";
import { validateStandbyConfig } from "./gcp-standby.mjs";

const exec = promisify(execFile);
export const APP_URL = "https://act.hoyolab.com/sr/event/currency-wars/index.html?sign_type=2&auth_appid=rpqcurrencywar&authkey_ver=1&open_bbs=0&hyl_presentation_style=fullscreen&lang=en-us#/lineup/home";
const READ_URL = `${REGIONS.global.baseUrl}/game/user/lineup`;
const READ_BODY = Object.freeze({ game: "hkrpg", page: "1", limit: "1", lineup_type: "Tourn", order: "CreatedTime" });
const AUTH_HOSTS = new Set(["account.hoyoverse.com", "account.hoyolab.com", "sg-public-api.hoyoverse.com", "passport-api-sg.hoyolab.com", "sg-public-data-api.hoyoverse.com", "sg-public-api-static.hoyolab.com"]);
const STATIC_HOSTS = new Set(["webstatic.hoyoverse.com", "webstatic-sea.hoyoverse.com", "upload-os-bbs.hoyolab.com", "fastcdn.hoyoverse.com", "act.hoyolab.com", "act.hoyoverse.com", "act-webstatic.hoyoverse.com"]);
// Observed during the authorised 2026-11-13 password login. No wildcard APIs,
// third-party POSTs or temporary compatibility bypass. Asset hashes may change.
const LOGIN_AUTH = [
  { origin: 'https://account.hoyolab.com', path: '/login-platform/index.html', methods: ['GET'] },
  { origin: 'https://passport-api-sg.hoyolab.com', path: '/account/ma-passport/token/verifyCookieToken', methods: ['POST', 'OPTIONS'] },
  { origin: 'https://passport-api-sg.hoyolab.com', path: '/account/ma-passport/api/webLoginByPassword', methods: ['POST', 'OPTIONS'] },
  { origin: 'https://sg-public-data-api.hoyoverse.com', path: '/device-fp/api/getFp', methods: ['POST', 'OPTIONS'] },
  { origin: 'https://sg-public-api-static.hoyolab.com', path: '/account/ma-passport/api/getSwitchStatus', methods: ['GET', 'OPTIONS'] },
];
const OBSERVED_READS = new Set([
  `${REGIONS.global.baseUrl}/game/config`,
  'https://sg-act-public-api.hoyolab.com/common/badge/v1/login/info',
  'https://sdk-os-static.hoyoverse.com/combo/box/api/config/porte-fe-os/config',
  'https://sg-public-data-api.hoyoverse.com/device-fp/api/getExtList',
]);
const strategyPath = path => /(?:\/game\/|\/event\/rpgcurrencywar(?:\/|$)|lineup|strategy)/i.test(path);

function secureUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
    || /%|\\/.test(url.pathname)) throw new Error("Exact approved HTTPS URL required");
  return url;
}

export function compileReadOnlyPolicy({ authRequests = [], assetOrigins = [], officialLogin = false } = {}) {
  if (typeof officialLogin !== 'boolean') throw new Error('Explicit boolean official-login preset required');
  // Auth routes are supplied only after the main operator observes official login.
  // No guessed passport/MFA APIs, broad host patterns or strategy exceptions.
  const auth = [...(officialLogin ? LOGIN_AUTH : []), ...authRequests].map(rule => {
    const origin = secureUrl(rule.origin);
    if (origin.origin !== rule.origin || !AUTH_HOSTS.has(origin.hostname) || typeof rule.path !== "string"
      || !rule.path.startsWith("/") || strategyPath(rule.path) || /[?#%\\]/.test(rule.path)
      || new URL(rule.path, origin).origin !== origin.origin || new URL(rule.path, origin).pathname !== rule.path
      || !Array.isArray(rule.methods) || !rule.methods.length || rule.methods.some(m => !["GET", "POST", "OPTIONS"].includes(m))) throw new Error("Exact observed official authentication routes required");
    return { origin: origin.origin, path: rule.path, methods: [...rule.methods] };
  });
  const assets = new Set([...(officialLogin ? [...STATIC_HOSTS].map(host => `https://${host}`) : []), ...assetOrigins].map(value => {
    const url = secureUrl(value);
    if (url.origin !== value || !STATIC_HOSTS.has(url.hostname)) throw new Error("Explicit supported official static origin required");
    return url.origin;
  }));
  const app = new URL(APP_URL);
  return ({ url: value, method, resourceType, postData }) => {
    try {
      const url = secureUrl(value);
      if (url.href === READ_URL) {
        if (method === "OPTIONS") return true;
        if (method !== "POST") return false;
        const payload = JSON.parse(postData);
        return payload && Object.keys(payload).length === 5 && Object.entries(READ_BODY).every(([key, expected]) => payload[key] === expected);
      }
      if (method === 'GET' && OBSERVED_READS.has(url.origin + url.pathname)) return true;
      if (strategyPath(url.pathname)) return false;
      if (auth.some(rule => rule.origin === url.origin && rule.path === url.pathname && rule.methods.includes(method))) return true;
      if (officialLogin && method === 'GET' && url.origin === 'https://account.hoyolab.com'
        && /^\/login-platform\/[^/]+\.(?:js|css|png|jpe?g|webp|svg|ico|woff2?|ttf)$/.test(url.pathname)
        && ['script', 'stylesheet', 'image', 'font'].includes(resourceType)) return true;
      if (method === "GET" && resourceType === "document" && url.origin === app.origin && url.pathname === app.pathname && url.search === app.search) return true;
      if (!["GET", "HEAD"].includes(method) || !assets.has(url.origin)) return false;
      const staticPath = /\.(?:js|css|png|jpe?g|webp|svg|gif|ico|woff2?|ttf|otf|mp4|webm)$/i.test(url.pathname);
      if (["script", "stylesheet", "image", "font", "media"].includes(resourceType) && staticPath) return true;
      return ["fetch", "xhr"].includes(resourceType) && (
        (/^\/(?:admin\/)?mi18n\//.test(url.pathname) && /\.json$/i.test(url.pathname))
        || (url.origin === 'https://act.hoyolab.com' && url.pathname.startsWith('/gt-ui/assets/icons/') && /\.svg$/i.test(url.pathname)));
    } catch { return false; }
  };
}

export async function installReadOnlyRoutes(context, policy) {
  await context.route("**/*", async route => {
    try {
      const request = route.request();
      if (policy({ url: request.url(), method: request.method(), resourceType: request.resourceType(), postData: request.postData() })) {
        // route.continue can let a server redirect escape routing. Fetch exactly
        // one hop and reject redirects instead of forwarding credentials/writes.
        const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 15000 });
        try {
          if (response.status() >= 300 && response.status() < 400) { await route.abort("blockedbyclient"); return; }
          await route.fulfill({ response }); return;
        } finally { await response.dispose(); }
      }
    } catch { /* Never log request headers, URL queries, credentials or payload. */ }
    await route.abort("blockedbyclient");
  });
  await context.routeWebSocket(/.*/, socket => socket.close());
}

export async function buildReadonlySshArgs(config) {
  if (config?.host !== "127.0.0.1" || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535
    || !/^[a-z_][a-z0-9_-]*$/.test(config.user ?? "") || !/^gcp-[1-9][0-9]*$/.test(config.hostKeyAlias ?? "")
    || !Number.isInteger(config.localViewerPort) || config.localViewerPort < 1024 || config.localViewerPort > 65535
    || !isAbsolute(config.identityFile ?? "") || !isAbsolute(config.knownHostsPath ?? "")
    || [config.identityFile, config.knownHostsPath].some(path => /[\s%"'$`{}]/.test(path))) throw new Error("Explicit IAP loopback SSH configuration with non-expanding paths required");
  const stat = await lstat(config.knownHostsPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error("Dedicated regular known-hosts file required");
  const lines = (await readFile(config.knownHostsPath, "utf8")).trim().split(/\r?\n/);
  if (lines.length !== 1) throw new Error("Exactly one independently verified known-host key required");
  const [alias, type, encoded, ...extra] = lines[0].split(/\s+/);
  const key = Buffer.from(encoded ?? "", "base64");
  if (alias !== config.hostKeyAlias || type !== "ssh-ed25519" || extra.length || key.length !== 51
    || key.readUInt32BE(0) !== 11 || key.subarray(4, 15).toString() !== "ssh-ed25519" || key.readUInt32BE(15) !== 32) throw new Error("Pinned ED25519 host key required");
  const fingerprint = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
  if (fingerprint !== config.expectedFingerprint) throw new Error("Known-host fingerprint mismatch");
  return ["-F", process.platform === "win32" ? "NUL" : "/dev/null", "-N", "-T", "-p", String(config.port), "-i", config.identityFile.replaceAll("\\", "/"),
    "-L", `127.0.0.1:${config.localViewerPort}:127.0.0.1:6080`,
    "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${config.knownHostsPath.replaceAll("\\", "/")}`,
    "-o", `GlobalKnownHostsFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "-o", `HostKeyAlias=${config.hostKeyAlias}`, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes", "-o", "ForwardAgent=no", `${config.user}@127.0.0.1`];
}

async function validatePrivateParent(parent) {
  if (await realpath(parent) !== parent) throw new Error("Profile parent must not traverse symlinks");
  const stat = await lstat(parent);
  if (!stat.isDirectory() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) throw new Error("Profile parent must be private and owned by this user");
}

export async function claimFreshProfile(path, identity) {
  if (!isAbsolute(path) || !/^gcp-readonly-profile-[a-zA-Z0-9-]+$/.test(basename(path))) throw new Error("A fresh dedicated absolute profile path required");
  if (identity && (identity.project !== 'hsr-currency-war-worker' || !/^[1-9][0-9]*$/.test(identity.instanceId ?? ''))) throw new Error('Explicit same-VM profile identity required');
  await validatePrivateParent(dirname(resolve(path)));
  await mkdir(path, { mode: 0o700 }); // Exclusive. Never adopt/copy an old profile.
  const ownerPath = resolve(path, ".readonly-owner");
  const owner = await open(ownerPath, "wx", 0o600);
  try { await owner.writeFile(`${process.pid}\n`); await owner.sync(); }
  finally { await owner.close(); }
  if (identity) {
    const receipt = await open(resolve(path, '.readonly-vm.json'), 'wx', 0o600);
    try { await receipt.writeFile(JSON.stringify({ ...identity, profileName: basename(path) })); await receipt.sync(); }
    finally { await receipt.close(); }
  }
  return async () => { await unlink(ownerPath); }; // Profile stays private on this VM.
}

export async function claimExistingProfile(path, identity) {
  if (!isAbsolute(path) || !/^gcp-readonly-profile-[a-zA-Z0-9-]+$/.test(basename(path))
    || identity?.project !== 'hsr-currency-war-worker' || !/^[1-9][0-9]*$/.test(identity.instanceId ?? '')) throw new Error('Explicit same-VM profile identity required');
  await validatePrivateParent(dirname(resolve(path)));
  await validatePrivateParent(resolve(path));
  // Never adopt an arbitrary profile or remove a stale Chrome/owner lock.
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { await lstat(resolve(path, name)); throw new Error('Existing Chrome ownership requires inspection'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const receiptPath = resolve(path, '.readonly-vm.json');
  const stat = await lstat(receiptPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024
    || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) throw new Error('Private same-VM profile receipt required');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  if (receipt.project !== identity.project || receipt.instanceId !== identity.instanceId || receipt.profileName !== basename(path)) throw new Error('Profile receipt does not match this VM and directory');
  const ownerPath = resolve(path, '.readonly-owner');
  const owner = await open(ownerPath, 'wx', 0o600);
  try { await owner.writeFile(`${process.pid}\n`); await owner.sync(); }
  finally { await owner.close(); }
  return () => unlink(ownerPath);
}

export async function claimLoginSession(parent) {
  await validatePrivateParent(resolve(parent));
  const lockPath = resolve(parent, ".readonly-session-lock");
  const lock = await open(lockPath, "wx", 0o600);
  try { await lock.writeFile(`${process.pid}\n`); await lock.sync(); }
  finally { await lock.close(); }
  return () => unlink(lockPath); // No stale-lock adoption or automatic removal.
}

export async function verifyReadOnlySession(page) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ok = await page.evaluate(async ({ endpoint, payload }) => {
      // Match src/publisher.mjs. Device identity stays inside the browser.
      try {
        const cookies = Object.fromEntries(document.cookie.split(";").map(x => x.trim()).filter(Boolean).map(part => {
          const index = part.indexOf("="); return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
        }));
        const deviceId = cookies._HYVUUID ?? cookies._MHYUUID;
        if (!deviceId) return false;
        const response = await fetch(endpoint, { method: "POST", credentials: "include", redirect: "error", signal: AbortSignal.timeout(15000),
          headers: { accept: "application/json, text/plain, */*", "content-type": "application/json", "x-rpc-currencywar-tourn": "tourn",
            "x-rpc-device_id": deviceId, "x-rpc-lang": "en-us", "x-rpc-platform": "pc" }, body: JSON.stringify(payload) });
        return response.status >= 200 && response.status < 300 && (await response.json())?.retcode === 0;
      } catch { return false; }
    }, { endpoint: READ_URL, payload: READ_BODY });
    if (ok !== true) throw new Error("Authenticated read-only check failed; no response or session data exported");
  }
  return { authenticatedReadOnlyChecks: 2, strategyWrites: false };
}

export async function assertVmIdentity(config, { fetchFn = fetch } = {}) {
  const get = async path => {
    const response = await fetchFn(`http://169.254.169.254/computeMetadata/v1/${path}`, { headers: { "Metadata-Flavor": "Google" }, redirect: "error", signal: AbortSignal.timeout(3000) });
    if (!response.ok || response.headers.get("metadata-flavor") !== "Google") throw new Error("GCE identity unavailable");
    return response.text();
  };
  const [id, name, zone, project] = await Promise.all([get("instance/id"), get("instance/name"), get("instance/zone"), get("project/project-id")]);
  if (id !== config.approvedTarget.instanceId || name !== config.instance || !zone.endsWith(`/zones/${config.zone}`) || project !== config.project) throw new Error("Login VM identity mismatch");
}

export async function assertIdle({ execFn = exec, listPids = () => readdir("/proc"), readArgs = pid => readFile(`/proc/${pid}/cmdline`, "utf8"),
  allowOwnedBrowser = false, readParent = async pid => (await readFile(`/proc/${pid}/status`, "utf8")).match(/^PPid:\s+(\d+)$/m)?.[1] } = {}) {
  for (const service of ["hsr-transfer-worker.service", "hsr-worker-synthetic.service"]) {
    const { stdout } = await execFn("systemctl", ["show", service, "--property=LoadState,ActiveState,MainPID"], { timeout: 5000 });
    const p = Object.fromEntries(stdout.trim().split("\n").map(line => line.split("=")));
    if (!["loaded", "not-found"].includes(p.LoadState) || p.ActiveState !== "inactive" || p.MainPID !== "0") throw new Error("All worker services must already be inactive");
  }
  const pids = (await listPids()).filter(x => /^\d+$/.test(x));
  const owned = new Set([String(process.pid)]);
  if (allowOwnedBrowser) {
    const parents = new Map();
    for (const pid of pids) {
      try { parents.set(pid, await readParent(pid)); }
      catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
    }
    for (let changed = true; changed;) {
      changed = false;
      for (const [pid, parent] of parents) if (owned.has(parent) && !owned.has(pid)) { owned.add(pid); changed = true; }
    }
  }
  for (const pid of pids) {
    try {
      if (pid === String(process.pid)) continue;
      const args = (await readArgs(pid)).split("\0");
      if (args.some(arg => /(?:^|\/)(?:worker-server|synthetic-worker-server|transfer|adopt-mapping|connector-login|gcp-login-readonly)\.mjs$/.test(arg))
        || (/(?:^|\/)(?:chrome|google-chrome(?:-stable)?|chromium(?:-browser)?)(?:\s|$)/.test(args[0] ?? "") && !owned.has(pid))) throw new Error("Another writer or browser/login owner is active");
    } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
  }
}

export async function runReadOnlyLogin({ config, confirmReady, launchPersistentContext, checkIdentity = assertVmIdentity, checkIdle = assertIdle }) {
  validateStandbyConfig(config);
  const settings = config.login;
  if (!settings || !Number.isInteger(settings.maxSeconds) || settings.maxSeconds < 1 || settings.maxSeconds > config.maxRunSeconds) throw new Error("Bounded login duration required");
  if (settings.resume !== undefined && typeof settings.resume !== 'boolean') throw new Error('Explicit boolean resume mode required');
  const policy = compileReadOnlyPolicy(settings);
  await checkIdentity(config); await checkIdle();
  const releaseSession = await claimLoginSession(dirname(settings.profileDir));
  let release;
  try {
    release = settings.resume
      ? await claimExistingProfile(settings.profileDir, { project: config.project, instanceId: config.approvedTarget.instanceId })
      : await claimFreshProfile(settings.profileDir, { project: config.project, instanceId: config.approvedTarget.instanceId });
  }
  catch (error) { await releaseSession(); throw error; }
  let context, timer, interrupted, startupGate;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const cancelled = new Promise((_, reject) => {
    interrupted = () => reject(new Error("Read-only login cancelled or timed out"));
    controller.signal.addEventListener("abort", interrupted, { once: true });
  });
  cancelled.catch(() => {}); // Observe cancellation even while a bounded launch is pending.
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  timer = setTimeout(cancel, settings.maxSeconds * 1000);
  try {
    startupGate = await createLoginStartupGate({ hosts: [...new Set([
      new URL(APP_URL).hostname, new URL(READ_URL).hostname, ...AUTH_HOSTS, ...STATIC_HOSTS,
      'sdk-os-static.hoyoverse.com',
    ])] });
    if (!launchPersistentContext) {
      const { chromium } = await import("playwright-core");
      launchPersistentContext = chromium.launchPersistentContext.bind(chromium);
    }
    // Await launch before racing work so that a late browser can always be closed.
    context = await launchPersistentContext(settings.profileDir, { channel: "chrome", headless: settings.resume === true, chromiumSandbox: true,
      proxy: { server: startupGate.server },
      serviceWorkers: "block", acceptDownloads: false, timeout: Math.min(20000, settings.maxSeconds * 1000),
      args: ["--disable-extensions", "--disable-background-networking", "--disable-component-update", "--no-first-run", "--no-default-browser-check"] });
    const work = async () => {
      controller.signal.throwIfAborted();
      await installReadOnlyRoutes(context, policy);
      // Persistent contexts already have a blank page. WebSocket routing must be
      // installed before creating the page that will run any website scripts.
      const initialPages = context.pages();
      const page = await context.newPage();
      for (const initial of initialPages) await initial.close();
      startupGate.admit();
      await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.bringToFront();
      await confirmReady({ signal: controller.signal });
      await checkIdle({ allowOwnedBrowser: true });
      const current = new URL(page.url()), approved = new URL(APP_URL);
      if (current.origin !== approved.origin || current.pathname !== approved.pathname || current.search !== approved.search) throw new Error("Return to the approved event page before read-only checks");
      return verifyReadOnlySession(page);
    };
    return await Promise.race([work(), cancelled]);
  } finally {
    clearTimeout(timer); process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    controller.signal.removeEventListener("abort", interrupted);
    await startupGate?.close();
    if (context) {
      let closeTimer;
      try {
        await Promise.race([context.close(), new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error('Browser close unconfirmed; ownership retained')), 10000); })]);
      } finally { clearTimeout(closeTimer); }
      await release(); await releaseSession();
    }
    // A failed/ambiguous browser launch retains the ownership marker for inspection.
  }
}

async function main() {
  const [action, configPath, authority, ...extra] = process.argv.slice(2);
  if (!configPath || extra.length || !["ssh-plan", "login", "verify-session"].includes(action)) throw new Error("Usage: gcp-login-readonly.mjs ssh-plan|login|verify-session private-config.json [--authorise-readonly-login|--authorise-readonly-resume]");
  const config = JSON.parse((await readFile(configPath, "utf8")).replace(/^\uFEFF/, ""));
  validateStandbyConfig(config);
  if (config.ssh?.hostKeyAlias !== `gcp-${config.approvedTarget.instanceId}`) throw new Error("Host key must be bound to the pinned instance ID");
  if (action === "ssh-plan") {
    console.log(JSON.stringify({ executable: "ssh", args: await buildReadonlySshArgs(config.ssh), execute: false })); return;
  }
  const resume = action === 'verify-session';
  if (authority !== (resume ? '--authorise-readonly-resume' : '--authorise-readonly-login')
    || (config.login?.resume === true) !== resume || process.platform !== "linux" || process.getuid() === 0
    || dirname(config.login?.profileDir ?? "") !== "/var/lib/hsr-transfer-worker-staging/login"
    || Object.keys(process.env).some(key => key.startsWith("CURRENCY_WAR_"))) throw new Error("Explicit non-root VM-only read-only login in the fixed private login directory without production environment required");
  if (resume) {
    const result = await runReadOnlyLogin({ config, confirmReady: ({ signal }) => delay(4000, undefined, { signal }) });
    console.log(JSON.stringify({ ...result, profileResumed: true, profileExported: false, productionStateVerified: false, publisherStarted: false }));
    return;
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const result = await runReadOnlyLogin({ config, confirmReady: async ({ signal }) => {
      const answer = await terminal.question("Complete official login/MFA manually. Return to the event page; enter ready for two read-only checks: ", { signal });
      if (answer !== "ready") throw new Error("Operator did not confirm readiness");
    } });
    console.log(JSON.stringify({ ...result, profileExported: false, productionStateVerified: false, publisherStarted: false }));
  } finally { terminal.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  console.error("Read-only login failed; no authenticated session or cloud success claimed. Keep publishers stopped; inspect private files locally without exporting cookies or diagnostics.");
  process.exitCode = 1;
});
