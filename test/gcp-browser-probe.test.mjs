import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createProbeHandler } from "../scripts/infrastructure/gcp-browser-probe.mjs";

const token = "synthetic-test-only-".repeat(3);
async function serve(t, probe) {
  const server = createServer(createProbeHandler({ token, probe }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
const authorised = { method: "POST", headers: { authorization: `Bearer ${token}` } };

test("probe rejects missing, wrong and malformed tokens without launching Chrome", async t => {
  let calls = 0;
  const base = await serve(t, async () => { calls++; });
  for (const authorization of [undefined, "Bearer wrong", `Basic ${token}`, `Bearer ${token}extra`]) {
    const response = await fetch(`${base}/probe`, { method: "POST", headers: authorization ? { authorization } : {} });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(calls, 0);
  assert.throws(() => createProbeHandler({ token: "short" }), /32/);
});

test("health and unknown routes never launch browser; probe accepts no input", async t => {
  let calls = 0;
  const base = await serve(t, async () => { calls++; return { synthetic: true }; });
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/jobs`, authorised)).status, 404);
  assert.equal((await fetch(`${base}/probe?url=https://example.com`, authorised)).status, 404);
  assert.equal((await fetch(`${base}/probe`, { ...authorised, body: "{}" })).status, 400);
  assert.equal(calls, 0);
  const response = await fetch(`${base}/probe`, authorised);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { synthetic: true });
  assert.equal(calls, 1);
});

test("concurrent probes are rejected until the active browser closes", async t => {
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const base = await serve(t, async () => { entered(); await gate; return { synthetic: true }; });
  const first = fetch(`${base}/probe`, authorised);
  await started;
  const duplicate = await fetch(`${base}/probe`, authorised);
  assert.equal(duplicate.status, 429);
  assert.equal(duplicate.headers.get("retry-after"), "5");
  release();
  assert.equal((await first).status, 200);
});

test("browser errors are redacted and release admission for a later attempt", async t => {
  let calls = 0;
  const base = await serve(t, async () => {
    if (++calls === 1) throw new Error(`private-profile ${token}`);
    return { synthetic: true };
  });
  const failure = await fetch(`${base}/probe`, authorised);
  assert.equal(failure.status, 503);
  assert.deepEqual(await failure.json(), { error: "synthetic_browser_probe_failed" });
  assert.equal((await fetch(`${base}/probe`, authorised)).status, 200);
});
