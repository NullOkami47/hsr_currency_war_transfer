import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOTAL_MS = 45000;
const REQUEST_MS = 5000;
const POLLS = 8;
const POLL_DELAY_MS = 4000;

class ProbeFailure extends Error {
  constructor(status, code = 502) {
    super(status);
    this.status = status;
    this.code = code;
  }
}

function secretIsValid(value) {
  return typeof value === "string" && value.length >= 32 && /^[\x21-\x7e]+$/.test(value);
}

function matchesSecret(header, secret) {
  if (typeof header !== "string" || !/^Bearer [\x21-\x7e]+$/i.test(header)) return false;
  const hash = value => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(header.slice(7)), hash(secret));
}

function stagingOrigin(value) {
  // Match the raw value before URL parsing: no userinfo, ports, normalised
  // dot segments, alternate IP encodings, extra suffixes, queries or fragments.
  const match = typeof value === "string"
    && /^https:\/\/gcp-staging\.([0-9]+)\.([0-9]+)\.([0-9]+)\.([0-9]+)\.sslip\.io\/?$/.exec(value);
  if (!match) throw new ProbeFailure("configuration_error", 503);
  const octets = match.slice(1).map(Number);
  if (octets.some((part, index) => part > 255 || String(part) !== match[index + 1])) {
    throw new ProbeFailure("configuration_error", 503);
  }
  const [a, b, c] = octets;
  const reserved = a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113);
  if (reserved) throw new ProbeFailure("configuration_error", 503);
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function raceAbort(operation, signal) {
  signal.throwIfAborted();
  let abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([operation(), interrupted]); }
  finally { signal.removeEventListener("abort", abort); }
}

async function delay(ms, signal) {
  let timer;
  try { await raceAbort(() => new Promise(resolve => { timer = setTimeout(resolve, ms); }), signal); }
  finally { clearTimeout(timer); }
}

async function requireEmptyBody(request, signal) {
  const headers = request.headers ?? {};
  if ((headers["content-length"] !== undefined && headers["content-length"] !== "0")
    || headers["transfer-encoding"] !== undefined) throw new ProbeFailure("invalid_body", 400);
  // Vercel restores the raw stream after its helpers read it. Do not consult
  // request.body: an empty JSON/form body is indistinguishable from {} there.
  // Consume the restored data/end events rather than async iteration, which
  // can see the original IncomingMessage's already-ended state on Vercel.
  let dataTarget, endTarget, onData, onEnd, onError;
  try {
    await raceAbort(() => new Promise((resolve, reject) => {
      onData = chunk => { if (Buffer.byteLength(chunk) > 0) reject(new ProbeFailure("invalid_body", 400)); };
      onEnd = resolve;
      onError = reject;
      dataTarget = request.on("data", onData);
      endTarget = request.on("end", onEnd);
      request.on("error", onError);
    }), signal);
  } finally {
    if (onData) dataTarget?.removeListener("data", onData);
    if (onEnd) endTarget?.removeListener("end", onEnd);
    if (onError) request.removeListener("error", onError);
  }
}

// Dependency injection is only for unit tests. The default export uses actual
// runtime environment, crypto, timers and fetch in the Vercel Node function.
export function createProbeHandler({ env = process.env, fetchImpl = globalThis.fetch,
  now = () => performance.now(), sleep = delay } = {}) {
  return async function probe(request, response) {
    const report = { ok: false, status: "upstream_error", startedAt: new Date().toISOString(),
      finishedAt: "", checks: { health: false, missingTokenRejected: false,
        wrongTokenRejected: false, created: false, synthetic: false }, upstream: {} };
    let timer, interrupted, disconnected, callerSignal;
    const budget = new AbortController();
    const deadline = now() + TOTAL_MS;
    function checkBudget() {
      budget.signal.throwIfAborted();
      if (now() >= deadline) {
        budget.abort(new ProbeFailure("timed_out", 504));
        budget.signal.throwIfAborted();
      }
    }
    function finish(code, status) {
      report.status = status;
      report.finishedAt = new Date().toISOString();
      response.statusCode = code;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.setHeader("x-content-type-options", "nosniff");
      response.end(JSON.stringify(report));
    }
    try {
      const key = env.HSR_STAGING_PROBE_KEY;
      if (!secretIsValid(key)) throw new ProbeFailure("configuration_error", 503);
      if (!matchesSecret(request.headers?.authorization, key)) throw new ProbeFailure("unauthorised", 401);
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        throw new ProbeFailure("method_not_allowed", 405);
      }
      if (env.VERCEL_ENV !== "preview") throw new ProbeFailure("preview_required", 403);
      const token = env.HSR_STAGING_WORKER_TOKEN;
      if (!secretIsValid(token)) throw new ProbeFailure("configuration_error", 503);
      const origin = stagingOrigin(env.HSR_STAGING_ORIGIN);

      interrupted = () => budget.abort(new ProbeFailure("interrupted", 408));
      disconnected = () => { if (!response.writableEnded) interrupted(); };
      request.once("aborted", interrupted);
      request.once("error", interrupted);
      response.once("close", disconnected);
      callerSignal = request.signal;
      callerSignal?.addEventListener("abort", interrupted, { once: true });
      if (callerSignal?.aborted) interrupted();
      if (request.aborted || response.destroyed) interrupted();
      timer = setTimeout(() => budget.abort(new ProbeFailure("timed_out", 504)), TOTAL_MS);
      await requireEmptyBody(request, budget.signal);
      checkBudget();

      async function upstream(name, path, { method = "GET", bearer, body, readJson = false } = {}) {
        checkBudget();
        const call = new AbortController();
        const signal = AbortSignal.any([budget.signal, call.signal]);
        const callTimer = setTimeout(() => call.abort(new ProbeFailure("timed_out", 504)),
          Math.min(REQUEST_MS, deadline - now()));
        let reply;
        try {
          return await raceAbort(async () => {
            reply = await fetchImpl(`${origin}${path}`, {
              method, redirect: "manual", signal, cache: "no-store",
              headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}),
                ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
              ...(body ? { body } : {}),
            });
            signal.throwIfAborted();
            checkBudget();
            report.upstream[name] = reply.status;
            if (reply.redirected || (reply.status >= 300 && reply.status < 400)) {
              throw new ProbeFailure("redirect_rejected");
            }
            const value = readJson ? await reply.json() : undefined;
            signal.throwIfAborted();
            checkBudget();
            return { status: reply.status, value };
          }, signal);
        } finally {
          clearTimeout(callTimer);
          // Close ignored auth/error bodies and any interrupted response. Never
          // wait for a remote body to finish during cleanup.
          if (reply?.body && !reply.body.locked) void reply.body.cancel().catch(() => {});
        }
      }

      const health = await upstream("health", "/health", { readJson: true });
      if (health.status !== 200 || health.value?.status !== "ok" || health.value?.mode !== "hsr-synthetic-worker") {
        throw new ProbeFailure("health_rejected");
      }
      report.checks.health = true;
      // No POST can be reached until both health assertions above have passed.
      const body = JSON.stringify({ sourceId: randomBytes(12).toString("hex"), clientKey: "vercel-staging-probe" });
      const missing = await upstream("missingToken", "/jobs", { method: "POST", body });
      if (missing.status !== 401) throw new ProbeFailure("worker_auth_rejected");
      report.checks.missingTokenRejected = true;
      let wrong;
      do { wrong = randomBytes(32).toString("hex"); } while (wrong === token || wrong === key);
      const rejected = await upstream("wrongToken", "/jobs", { method: "POST", body, bearer: wrong });
      if (rejected.status !== 401) throw new ProbeFailure("worker_auth_rejected");
      report.checks.wrongTokenRejected = true;
      const submitted = await upstream("create", "/jobs", { method: "POST", body, bearer: token, readJson: true });
      const jobId = submitted.value?.jobId;
      if (submitted.status !== 202 || submitted.value?.status !== "queued"
        || typeof jobId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(jobId)) {
        throw new ProbeFailure("job_rejected");
      }
      for (let attempt = 0; attempt < POLLS; attempt++) {
        if (attempt) {
          checkBudget();
          await raceAbort(() => sleep(Math.min(POLL_DELAY_MS, deadline - now()), budget.signal), budget.signal);
        }
        const polled = await upstream("poll", `/jobs/${jobId}`, { bearer: token, readJson: true });
        const job = polled.value;
        if (polled.status !== 200 || job?.jobId !== jobId) throw new ProbeFailure("job_rejected");
        const result = job.result ?? job; // Current worker's publicJob flattens its stored result.
        if (job.status === "created" && result.synthetic === true) {
          checkBudget();
          report.checks.created = true;
          report.checks.synthetic = true;
          report.ok = true;
          finish(200, "passed");
          return;
        }
        if (job.status !== "queued") throw new ProbeFailure("job_rejected");
      }
      throw new ProbeFailure("poll_exhausted", 504);
    } catch (error) {
      const failure = budget.signal.aborted ? budget.signal.reason : error;
      // Fixed strings only: no error messages, worker state, IDs, hosts or secrets.
      finish(failure instanceof ProbeFailure ? failure.code : 502,
        failure instanceof ProbeFailure ? failure.status : "upstream_error");
    } finally {
      clearTimeout(timer);
      if (interrupted) request.removeListener("aborted", interrupted);
      if (interrupted) request.removeListener("error", interrupted);
      if (disconnected) response.removeListener("close", disconnected);
      callerSignal?.removeEventListener("abort", interrupted);
    }
  };
}

export default async function handler(request, response) {
  return createProbeHandler()(request, response);
}
