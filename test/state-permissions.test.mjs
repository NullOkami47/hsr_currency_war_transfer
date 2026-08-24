import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  hardenPrivateFile,
  preparePrivateStatePath,
} from "../src/private-state.mjs";
import { JsonTransferStore } from "../src/store.mjs";
import { JsonWorkerJobStore } from "../src/worker.mjs";

test("prepares restrictive state paths on POSIX without applying fake Windows modes", async () => {
  const calls = [];
  const mkdirFn = async (...args) => calls.push(["mkdir", ...args]);
  const chmodFn = async (...args) => calls.push(["chmod", ...args]);

  await preparePrivateStatePath("/state/transfers.json", {
    platform: "linux",
    mkdirFn,
    chmodFn,
  });
  await hardenPrivateFile("/state/transfers.json", {
    platform: "linux",
    chmodFn,
  });
  await preparePrivateStatePath("C:\\state\\jobs.json", {
    platform: "win32",
    mkdirFn,
    chmodFn,
  });
  await hardenPrivateFile("C:\\state\\jobs.json", {
    platform: "win32",
    chmodFn,
  });

  assert.deepEqual(calls, [
    ["mkdir", "/state", { recursive: true, mode: 0o700 }],
    ["chmod", "/state", 0o700],
    ["chmod", "/state/transfers.json", 0o600],
    ["mkdir", "C:\\state", { recursive: true, mode: 0o700 }],
  ]);
});

test("interprets state paths with the effective platform semantics", async () => {
  const calls = [];
  const mkdirFn = async (directory) => calls.push(directory);
  const chmodFn = async () => {};

  await preparePrivateStatePath("C:\\state\\jobs.json", {
    platform: "win32",
    mkdirFn,
    chmodFn,
  });
  await preparePrivateStatePath("C:\\state\\jobs.json", {
    platform: "linux",
    mkdirFn,
    chmodFn,
  });
  await preparePrivateStatePath("/var/lib/currency-war/jobs.json", {
    platform: "linux",
    mkdirFn,
    chmodFn,
  });

  assert.deepEqual(calls, [
    "C:\\state",
    ".",
    "/var/lib/currency-war",
  ]);
});

test("transfer and job stores create private state files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "currency-war-private-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const transferDirectory = join(directory, "transfers");
  const jobDirectory = join(directory, "jobs");
  const transferPath = join(transferDirectory, "transfers.json");
  const jobPath = join(jobDirectory, "jobs.json");

  const transferStore = new JsonTransferStore(transferPath);
  await transferStore.set("source", { globalId: "global" });
  await transferStore.withTransferLock(async () => {
    if (process.platform !== "win32") {
      assert.equal((await stat(`${transferPath}.lock`)).mode & 0o777, 0o600);
    }
  });
  const jobStore = new JsonWorkerJobStore(jobPath);
  await jobStore.updateSettings({ publicSubmissionsEnabled: false });

  if (process.platform !== "win32") {
    assert.equal((await stat(transferDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(jobDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(transferPath)).mode & 0o777, 0o600);
    assert.equal((await stat(jobPath)).mode & 0o777, 0o600);
  }
});
