// Opt in on an isolated Linux systemd host with passwordless sudo:
// HSR_SYSTEMD_SHUTDOWN_TEST=1 node --test test/gcp-worker-graceful-stop.integration.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, appendFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const self = fileURLToPath(import.meta.url);
const repo = resolve(dirname(self), "..");
async function exists(path) {
  try { await lstat(path); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function until(predicate, message, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out: ${message}`);
}
function run(command, args, accepted = [0]) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
  assert.ifError(result.error);
  assert.ok(accepted.includes(result.status), `${command} ${args.join(" ")}: ${result.status}\n${result.stderr}`);
  return result.stdout.trim();
}
function control(...args) { return run("sudo", ["-n", "systemctl", ...args]); }
function conflict(lock, expected) {
  run("/usr/bin/flock", ["--nonblock", "--conflict-exit-code", "75", lock, "/usr/bin/true"], [expected]);
}

async function childFixture(root) {
  process.on("SIGTERM", async () => {
    await writeFile(join(root, "child-term"), "unexpected group signal");
    process.exit(88);
  });
  process.on("message", async () => {
    await writeFile(join(root, "child-cleanup-started"), "ready");
    await until(() => exists(join(root, "release-child")), "release synthetic child");
    await appendFile(join(root, "events"), "child-cleaned\n");
    // Only the synthetic child's own marker, never a real Chrome lock.
    const { unlink } = await import("node:fs/promises");
    await unlink(join(root, "synthetic-profile-lock"));
    process.exit(0);
  });
  await writeFile(join(root, "synthetic-profile-lock"), "synthetic child owns this");
  process.send("ready");
}

async function workerFixture(root, mode) {
  const child = spawn(process.execPath, [self, "--child", root], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  await once(child, "message");
  const childExit = once(child, "exit");
  let publisher;
  let request;
  if (mode === "chromium") {
    const { BrowserSessionPublisher } = await import("../src/publisher.mjs");
    const { chromium } = await import("playwright-core");
    publisher = new BrowserSessionPublisher({
      profileDir: join(root, "chrome-profile"),
      browserExecutablePath: "/usr/bin/google-chrome",
      chromiumSandbox: true,
      handleProcessSignals: false,
      headless: true,
      launchPersistentContext: async (profile, options) => {
        const context = await chromium.launchPersistentContext(profile, options);
        await context.route("**/*", async (route) => {
          if (route.request().url().includes("/game/user/lineup")) {
            await writeFile(join(root, "request-started"), "ready");
            await until(() => exists(join(root, "release-request")), "release browser request");
            await route.fulfill({
              contentType: "application/json",
              headers: {
                "access-control-allow-origin": "https://act.hoyolab.com",
                "access-control-allow-credentials": "true",
              },
              body: JSON.stringify({ retcode: 0, data: { list: [] } }),
            });
          } else {
            await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Isolated shutdown fixture</title>" });
          }
        });
        await context.addCookies([{ name: "_HYVUUID", value: "synthetic-fixture-device", url: "https://act.hoyolab.com" }]);
        return context;
      },
    });
    request = publisher.keepAlive();
    // Observe rejection promptly; the awaited original promise below still fails.
    request.catch(() => {});
    await until(() => exists(join(root, "request-started")), "real browser request");
  }
  const server = createServer((_req, res) => res.end("synthetic"));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  let shutdown;
  const stop = () => {
    shutdown ??= (async () => {
      await writeFile(join(root, "parent-term"), String(process.pid));
      await new Promise((done) => server.close(done));
      if (publisher) {
        await publisher.close();
        await request;
        await appendFile(join(root, "events"), "browser-closed\n");
      }
      if (child.connected) child.send("cleanup");
      const [code, signal] = await childExit;
      assert.equal(code, 0, `child exited with ${signal}`);
      await appendFile(join(root, "events"), "parent-cleaned\n");
    })();
    shutdown.then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await writeFile(join(root, "ready"), JSON.stringify({ pid: process.pid, child: child.pid }));
}

async function integration(t) {
  run("sudo", ["-n", "true"]);
  assert.equal(run("ps", ["-p", "1", "-o", "comm="]), "systemd");
  const root = await mkdtemp(join(tmpdir(), "hsr-shutdown-systemd-"));
  const prefix = `hsr-shutdown-${process.pid}-${root.split("-").at(-1)}`;
  t.diagnostic(`isolatedRoot=${root}; node=${process.version}; systemd=${run("systemctl", ["--version"]).split("\n")[0]}`);
  const productionDropIn = await readFile(join(repo, "scripts/infrastructure/systemd/gcp-worker-graceful-stop.conf"), "utf8");
  let index = 0;
  async function service(name, mode, dropIn) {
    const dir = join(root, `${++index}-${name}`);
    await mkdir(dir, { mode: 0o700 });
    const unit = `${prefix}-${index}.service`;
    const unitPath = `/run/systemd/system/${unit}`;
    const lock = join(dir, "worker.flock");
    const command = `${process.execPath} ${self} --fixture ${dir} ${mode}`;
    const unitFile = join(dir, unit);
    await writeFile(unitFile, `[Unit]\nDescription=Isolated graceful shutdown regression fixture\n[Service]\nType=simple\nUser=${process.getuid()}\nGroup=${process.getgid()}\nExecStart=/usr/bin/flock --nonblock --conflict-exit-code 75 ${lock} ${command}\nKillMode=control-group\nTimeoutStopSec=5s\nRestart=no\n`);
    run("sudo", ["-n", "install", "-m", "644", unitFile, unitPath]);
    if (dropIn) {
      // Consume the delivered artifact; substitute only isolated fixture paths.
      const config = dropIn
        .replaceAll("/var/lib/hsr-transfer-worker-staging/login/.production-worker.flock", lock)
        .replaceAll("/opt/node-v24.22.3-linux-x64/bin/node /opt/hsr-transfer-worker-staging/scripts/worker-server.mjs", command);
      const configFile = join(dir, "override.conf");
      await writeFile(configFile, config);
      run("sudo", ["-n", "install", "-d", `${unitPath}.d`]);
      run("sudo", ["-n", "install", "-m", "644", configFile, `${unitPath}.d/override.conf`]);
    }
    control("daemon-reload");
    const record = { dir, unit, unitPath, lock };
    t.after(() => {
      // Every path/unit is constructed above for this invocation only.
      run("sudo", ["-n", "systemctl", "stop", unit], [0, 5]);
      run("sudo", ["-n", "systemctl", "reset-failed", unit], [0, 1]);
      run("sudo", ["-n", "rm", "-f", `${unitPath}.d/override.conf`, unitPath]);
      if (dropIn) run("sudo", ["-n", "rmdir", `${unitPath}.d`]);
      control("daemon-reload");
    });
    control("start", unit);
    await until(() => exists(join(dir, "ready")), `${unit} readiness`);
    conflict(lock, 75);
    return record;
  }
  for (const [name, dropIn] of [
    ["legacy-flock-control-group", null],
    ["no-fork-alone", productionDropIn.replace("KillMode=mixed", "KillMode=control-group")],
  ]) {
    await t.test(`${name} reproduces child SIGTERM and stale synthetic lock`, async () => {
      const { dir, unit, lock } = await service(name, "synthetic", dropIn);
      const result = spawnSync("sudo", ["-n", "systemctl", "stop", unit], { encoding: "utf8", timeout: 15_000 });
      assert.ifError(result.error);
      assert.equal(result.status, 0);
      assert.equal(await exists(join(dir, "child-term")), true);
      assert.equal(await exists(join(dir, "synthetic-profile-lock")), true);
      assert.equal(await exists(join(dir, "events")), false);
      conflict(lock, 0);
    });
  }
  for (const mode of ["synthetic", "chromium"]) {
    await t.test(`delivered drop-in gracefully stops ${mode} and keeps flock until cleanup`, async () => {
      const { dir, unit, lock } = await service(`fixed-${mode}`, mode, productionDropIn);
      const { pid } = JSON.parse(await readFile(join(dir, "ready"), "utf8"));
      assert.equal(Number(control("show", unit, "-p", "MainPID", "--value")), pid);
      assert.equal(control("show", unit, "-p", "KillMode", "--value"), "mixed");
      const stop = spawn("sudo", ["-n", "systemctl", "stop", unit]);
      const stopped = once(stop, "exit");
      await until(() => exists(join(dir, "parent-term")), "main Node received TERM");
      if (mode === "chromium") {
        assert.equal(await exists(join(dir, "chrome-profile/SingletonLock")), true);
        conflict(lock, 75);
        await writeFile(join(dir, "release-request"), "release");
      }
      await until(() => exists(join(dir, "child-cleanup-started")), "child cleanup");
      assert.equal(await exists(join(dir, "child-term")), false);
      assert.equal(await exists(join(dir, "synthetic-profile-lock")), true);
      conflict(lock, 75);
      await writeFile(join(dir, "release-child"), "release");
      assert.deepEqual(await stopped, [0, null]);
      assert.equal(control("show", unit, "-p", "Result", "--value"), "success");
      assert.equal(control("show", unit, "-p", "MainPID", "--value"), "0");
      assert.equal(await exists(join(dir, "synthetic-profile-lock")), false);
      conflict(lock, 0);
      const events = await readFile(join(dir, "events"), "utf8");
      assert.equal(events, `${mode === "chromium" ? "browser-closed\n" : ""}child-cleaned\nparent-cleaned\n`);
      if (mode === "chromium") {
        assert.equal(await exists(join(dir, "chrome-profile/SingletonLock")), false);
        assert.equal(await exists(join(dir, "chrome-profile/SingletonSocket")), false);
        assert.equal(await exists(join(dir, "chrome-profile/SingletonCookie")), false);
        const { chromium } = await import("playwright-core");
        const reopened = await chromium.launchPersistentContext(join(dir, "chrome-profile"), {
          executablePath: "/usr/bin/google-chrome",
          chromiumSandbox: true, headless: true,
          handleSIGINT: false, handleSIGTERM: false,
        });
        await reopened.close();
        assert.equal(await exists(join(dir, "chrome-profile/SingletonLock")), false);
        t.diagnostic(`real Chrome profile reopened without lock removal; ${run("/usr/bin/google-chrome", ["--version"])}`);
      }
    });
  }
  await t.test("actual worker shares cleanup across repeated TERM and INT", async () => {
    const dir = join(root, "actual-worker");
    await mkdir(dir);
    const preload = join(dir, "preload.mjs");
    await writeFile(preload, `import { BrowserSessionPublisher } from ${JSON.stringify(pathToFileURL(join(repo, "src/publisher.mjs")).href)};\nimport { writeFile, access } from 'node:fs/promises';\nimport { setTimeout as delay } from 'node:timers/promises';\nconst original = BrowserSessionPublisher.prototype.close;\nBrowserSessionPublisher.prototype.close = async function () {\nawait writeFile(${JSON.stringify(join(dir, "closing"))}, JSON.stringify({ signals: this.handleProcessSignals, sandbox: this.chromiumSandbox }));\nfor (;;) { try { await access(${JSON.stringify(join(dir, "release"))}); break; } catch { await delay(20); } }\nawait original.call(this);\n};\n`);
    const listener = createServer();
    await new Promise((done) => listener.listen(0, "127.0.0.1", done));
    const port = listener.address().port;
    await new Promise((done) => listener.close(done));
    const child = spawn(process.execPath, ["--import", preload, join(repo, "scripts/worker-server.mjs")], {
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        CURRENCY_WAR_PROFILE_DIR: join(dir, "profile"),
        CURRENCY_WAR_STATE_PATH: join(dir, "transfers.json"),
        CURRENCY_WAR_JOB_STATE_PATH: join(dir, "jobs.json"),
        CURRENCY_WAR_WORKER_TOKEN: "synthetic-isolated-worker-token-000000",
        CURRENCY_WAR_WORKER_HOST: "127.0.0.1",
        CURRENCY_WAR_WORKER_PORT: String(port),
        CURRENCY_WAR_SESSION_KEEPALIVE_MINUTES: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    await until(() => output.includes("worker listening"), `actual worker startup: ${output}`);
    child.kill("SIGTERM");
    await until(() => exists(join(dir, "closing")), "actual worker entered cleanup");
    assert.deepEqual(JSON.parse(await readFile(join(dir, "closing"), "utf8")), { signals: false, sandbox: true });
    child.kill("SIGTERM");
    child.kill("SIGINT");
    await delay(150);
    assert.equal(child.exitCode, null, "signals must not bypass pending cleanup");
    assert.equal(child.signalCode, null);
    await writeFile(join(dir, "release"), "release");
    assert.deepEqual(await exited, [0, null]);
  });
}

if (process.argv[2] === "--child") {
  await childFixture(process.argv[3]);
} else if (process.argv[2] === "--fixture") {
  await workerFixture(process.argv[3], process.argv[4]);
} else {
  test("isolated systemd production-worker graceful shutdown", {
    skip: process.platform !== "linux" || process.env.HSR_SYSTEMD_SHUTDOWN_TEST !== "1",
    timeout: 120_000,
  }, integration);
}
