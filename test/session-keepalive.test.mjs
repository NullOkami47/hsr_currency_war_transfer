import assert from "node:assert/strict";
import test from "node:test";

import { startSessionKeepalive } from "../src/session-keepalive.mjs";

test("session keepalive reschedules after success and can be stopped", async () => {
  const scheduled = [];
  const cleared = [];
  const logs = [];
  let calls = 0;
  const stop = startSessionKeepalive({
    publisher: {
      async keepAlive() { calls += 1; },
    },
    intervalMs: 21_600_000,
    initialDelayMs: 1_000,
    logger: { info: (line) => logs.push(line) },
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => cleared.push(timer),
  });

  assert.equal(scheduled[0].delay, 1_000);
  await scheduled[0].callback();
  assert.equal(calls, 1);
  assert.equal(scheduled[1].delay, 21_600_000);
  assert.match(logs[0], /"event":"keepalive_ok"/);

  stop();
  assert.equal(cleared[0], scheduled[1]);
});

test("session keepalive failure log contains metadata but not the message", async () => {
  const scheduled = [];
  const logs = [];
  const error = new Error("sensitive upstream response");
  error.name = "PublishingSessionError";
  error.retcode = -100;
  const stop = startSessionKeepalive({
    publisher: { async keepAlive() { throw error; } },
    intervalMs: 10_000,
    logger: { warn: (line) => logs.push(line) },
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    clearTimeoutFn() {},
  });

  await scheduled[0].callback();
  stop();

  assert.match(logs[0], /"event":"keepalive_failed"/);
  assert.match(logs[0], /"retcode":-100/);
  assert.doesNotMatch(logs[0], /sensitive upstream response/);
});
