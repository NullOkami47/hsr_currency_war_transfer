import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSessionPublisher } from "../src/publisher.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(options = {}) {
  const events = [];
  const page = {
    async goto() {},
    async waitForTimeout() {},
    async evaluate() {
      return { status: 200, body: { retcode: 0, data: {} } };
    },
  };
  const context = {
    pages: () => [page],
    async close() { events.push("context-close"); },
  };
  const publisher = new BrowserSessionPublisher({
    profileDir: "synthetic-shutdown-profile",
    logger: {},
    launchPersistentContext: async (_profile, launchOptions) => {
      events.push(launchOptions);
      return context;
    },
    ...options,
  });
  return { publisher, context, page, events };
}

test("deployed sandbox and executable overrides survive the shutdown change", async () => {
  assert.throws(() => fixture({ chromiumSandbox: false }), /sandbox/i);
  const { publisher, events } = fixture({ browserExecutablePath: "/synthetic/chrome" });
  await publisher.start();
  assert.equal(events[0].chromiumSandbox, true);
  assert.equal(events[0].executablePath, "/synthetic/chrome");
  assert.equal(events[0].channel, undefined);
  await publisher.close();
});

test("only explicit worker ownership disables Playwright INT and TERM handlers", async () => {
  for (const handleProcessSignals of [undefined, false]) {
    const { publisher, events } = fixture({ handleProcessSignals });
    await publisher.start();
    assert.equal(events[0].handleSIGINT, handleProcessSignals === false ? false : undefined);
    assert.equal(events[0].handleSIGTERM, handleProcessSignals === false ? false : undefined);
    await publisher.close();
  }
});

test("one final close drains the active request and rejects further browser work", async () => {
  const { publisher, page, events } = fixture();
  const entered = deferred();
  const release = deferred();
  page.evaluate = async () => {
    entered.resolve();
    await release.promise;
    events.push("request-finished");
    return { status: 200, body: { retcode: 0, data: {} } };
  };
  const request = publisher.keepAlive();
  await entered.promise;
  const close = publisher.close();
  assert.equal(close, publisher.close(), "all callers must await the same cleanup");
  assert.equal(events.includes("context-close"), false);
  await assert.rejects(publisher.keepAlive(), /clos/i);
  await assert.rejects(publisher.start(), /clos/i);
  release.resolve();
  await request;
  await close;
  assert.deepEqual(events.slice(1), ["request-finished", "context-close"]);
  await assert.rejects(publisher.start(), /clos/i);
});

test("final close waits for an in-flight direct launch before closing its context", async () => {
  const entered = deferred();
  const release = deferred();
  let closes = 0;
  const { publisher, context } = fixture({
    launchPersistentContext: async () => {
      entered.resolve();
      await release.promise;
      return context;
    },
  });
  context.close = async () => { closes += 1; };
  const start = publisher.start();
  await entered.promise;
  const close = publisher.close();
  release.resolve();
  await start;
  await close;
  assert.equal(closes, 1);
  assert.equal(publisher.context, null);
});

test("shutdown during auth rebuild waits for it without launching a replacement", async () => {
  const entered = deferred();
  const release = deferred();
  const { publisher, context, page, events } = fixture();
  page.evaluate = async () => ({ status: 200, body: { retcode: -100 } });
  context.close = async () => {
    events.push("recovery-close");
    entered.resolve();
    await release.promise;
  };
  const request = publisher.keepAlive();
  const rejected = assert.rejects(request, /clos/i);
  await entered.promise;
  const close = publisher.close();
  release.resolve();
  await rejected;
  await close;
  assert.equal(events.filter((event) => typeof event === "object").length, 1);
  assert.equal(events.filter((event) => event === "recovery-close").length, 1);
});

test("a failed request still permits final context cleanup", async () => {
  const { publisher, page, events } = fixture();
  page.evaluate = async () => { throw new Error("synthetic request failure"); };
  await assert.rejects(publisher.keepAlive(), /synthetic/);
  await publisher.close();
  assert.equal(events.at(-1), "context-close");
});
