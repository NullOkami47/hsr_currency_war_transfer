import { withDeadline } from "./deadline.mjs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readPrivateJson, writePrivateJson, serialiseState } from "./private-json.mjs";
import { JsonSecurityStore } from "./security-state.mjs";
import { createRequestBudget, createConcurrencyGate, REQUEST_BUDGETS } from "./request-budget.mjs";
import { parseChinaLineupInput } from "./api.mjs";
import { WorkerPolicyError } from "./errors.mjs";

const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed"]);

export const DEFAULT_WORKER_SETTINGS = Object.freeze({
  publicSubmissionsEnabled: false,
  sourceBlacklistEnabled: true,
  sourceBlacklist: Object.freeze([]),
  perIpLimit: 5,
  perIpWindowMinutes: 60,
  dailyAccountQuota: 25,
  maxPendingJobs: 20,
  retentionDays: 30,
  maxStoredJobs: 1000,
});

const SETTING_LIMITS = Object.freeze({
  perIpLimit: [1, 1000],
  perIpWindowMinutes: [1, 1440],
  dailyAccountQuota: [1, 10_000],
  maxPendingJobs: [1, 1000],
  retentionDays: [1, 365],
  maxStoredJobs: [5, 10_000],
});

function migrateLegacyAllowlist(value) {
  if (
    !("sourceAllowlistEnabled" in value)
    && !("sourceAllowlist" in value)
  ) {
    return value;
  }
  const migrated = { ...value };
  delete migrated.sourceAllowlistEnabled;
  delete migrated.sourceAllowlist;
  migrated.publicSubmissionsEnabled = false;
  migrated.sourceBlacklistEnabled = true;
  migrated.sourceBlacklist = [];
  return migrated;
}

function normaliseSettings(value = {}, { strict = false } = {}) {
  const input = strict ? value : migrateLegacyAllowlist(value);
  const settings = {
    ...DEFAULT_WORKER_SETTINGS,
    ...input,
  };
  for (const field of ["publicSubmissionsEnabled", "sourceBlacklistEnabled"]) {
    if (typeof settings[field] !== "boolean") {
      throw new TypeError(`${field} must be a boolean`);
    }
  }
  for (const [field, [minimum, maximum]] of Object.entries(SETTING_LIMITS)) {
    if (
      !Number.isInteger(settings[field])
      || settings[field] < minimum
      || settings[field] > maximum
    ) {
      throw new TypeError(`${field} must be an integer from ${minimum} to ${maximum}`);
    }
  }
  if (!Array.isArray(settings.sourceBlacklist)) {
    throw new TypeError("sourceBlacklist must be an array");
  }
  const sourceBlacklist = [...new Set(
    settings.sourceBlacklist.map((id) => String(id).toLowerCase()),
  )];
  if (
    sourceBlacklist.length > 500
    || sourceBlacklist.some((id) => !/^[a-f0-9]{24}$/i.test(id))
  ) {
    throw new TypeError(
      "sourceBlacklist must contain at most 500 valid China strategy IDs",
    );
  }
  if (strict) {
    const known = new Set([
      ...Object.keys(DEFAULT_WORKER_SETTINGS),
    ]);
    const unknown = Object.keys(input).filter((field) => !known.has(field));
    if (unknown.length > 0) {
      throw new TypeError(`Unknown worker setting: ${unknown.join(", ")}`);
    }
  }
  return { ...settings, sourceBlacklist };
}

function emptyJobState() {
  return {
    version: 4,
    settings: normaliseSettings(),
    jobs: {},
    quota: { events: [], blockedUntil: 0 },
  };
}

function cloneEmptyState() {
  return emptyJobState();
}

function pruneState(state, now = new Date()) {
  const settings = normaliseSettings(state.settings);
  state.settings = settings;
  if (!state.quota || !Array.isArray(state.quota.events)
      || !Number.isFinite(state.quota.blockedUntil)
      || state.quota.events.some(event => !Number.isFinite(event.at) || typeof event.clientKey !== "string")) {
    throw new Error("Invalid quota state");
  }
  // Retain the maximum configurable client window, regardless of current settings.
  state.quota.events = state.quota.events.filter(event => event.at > now.getTime() - 86_400_000);
  const cutoff = now.getTime() - settings.retentionDays * 86_400_000;
  const jobs = Object.values(state.jobs ?? {});
  const active = jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status));
  const terminal = jobs
    .filter((job) => TERMINAL_JOB_STATUSES.has(job.status))
    .filter((job) => Date.parse(job.updatedAt ?? job.createdAt ?? 0) >= cutoff)
    .sort((left, right) =>
      String(right.updatedAt ?? right.createdAt).localeCompare(
        String(left.updatedAt ?? left.createdAt),
      ));
  const terminalLimit = Math.max(0, settings.maxStoredJobs - active.length);
  state.jobs = Object.fromEntries(
    [...active, ...terminal.slice(0, terminalLimit)].map((job) => [job.id, job]),
  );
  return state;
}

function startOfUtcDay(now) {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function publicJob(job) {
  if (!job) return null;
  if (ACTIVE_JOB_STATUSES.has(job.status)) {
    return { status: "queued", jobId: job.id };
  }
  if (job.status === "failed") {
    return {
      status: "failed",
      jobId: job.id,
      error: {
        code: job.error?.code ?? "transfer_failed",
        message: "The strategy could not be transferred",
      },
    };
  }

  const result = job.result ?? {};
  return {
    ...result,
    status: result.ignored?.length ? "partial" : result.status,
    jobId: job.id,
  };
}

function safeAdminError(error) {
  const code = String(error?.code ?? "transfer_failed");
  const messages = {
    expired_source: "The China strategy has expired",
    publishing_session_error: "The publishing session requires administrator attention",
  };
  return {
    code,
    message: messages[code] ?? "The transfer could not be completed",
  };
}

export class JsonWorkerJobStore {
  constructor(path, { now = () => new Date() } = {}) {
    if (!path) throw new TypeError("A worker job-state path is required");
    this.path = path;
    this.now = now;
    this.writeChain = Promise.resolve();
  }

  async readState(now = this.now(), raw = undefined) {
    if (raw === undefined) raw = await readPrivateJson(this.path);
    if (!raw) return cloneEmptyState();
    if (![2, 3, 4].includes(raw.version) || !raw.settings || !raw.jobs) {
      throw new Error("Invalid worker state");
    }
    const legacy = raw.version < 4;
    return pruneState({
      version: 4,
      settings: normaliseSettings(raw.settings),
      jobs: raw.jobs,
      quota: legacy ? {
        events: Object.values(raw.jobs).map(job => ({
          at: Date.parse(job.createdAt), clientKey: String(job.clientKey ?? ""),
        })),
        // Old retention may already have destroyed quota evidence. Never assume
        // that missing history means unused quota during a rolling upgrade.
        blockedUntil: now.getTime() + 86_400_000,
      } : raw.quota,
    }, now);
  }

  writeState(state) { return writePrivateJson(this.path, state); }

  initialise(bootstrap = {}) {
    const operation = serialiseState(this.path, async () => {
      const raw = await readPrivateJson(this.path);
      if (raw) {
        const state = await this.readState(this.now(), raw);
        if (raw.version !== 4) await this.writeState(state);
        return structuredClone(state.settings);
      }
      const state = cloneEmptyState();
      state.settings = normaliseSettings(bootstrap, { strict: true });
      await this.writeState(state);
      return structuredClone(state.settings);
    });
    this.writeChain = operation.catch(() => {});
    return operation;
  }

  mutate(callback, now = this.now()) {
    const operation = serialiseState(this.path, async () => {
      const raw = await readPrivateJson(this.path);
      const state = await this.readState(now, raw);
      if (raw && raw.version !== 4) await this.writeState(state);
      const before = JSON.stringify(state);
      const result = await callback(state);
      pruneState(state, now);
      // A duplicate or no-op must not rewrite the entire history file.
      if (!raw || JSON.stringify(state) !== before) await this.writeState(state);
      return result;
    });
    this.writeChain = operation.catch(() => {});
    return operation;
  }

  async get(jobId) {
    await this.writeChain;
    return (await this.readState()).jobs[jobId] ?? null;
  }

  createOrGetActive(sourceId, context = {}, now = this.now()) {
    return this.mutate((state) => {
      if (context.public) {
        const settings = normaliseSettings(state.settings);
        if (!settings.publicSubmissionsEnabled) {
          throw new WorkerPolicyError(
            "public_submissions_disabled",
            "Public transfer submissions are disabled",
          );
        }
        if (
          settings.sourceBlacklistEnabled
          && settings.sourceBlacklist.includes(sourceId)
        ) {
          throw new WorkerPolicyError(
            "source_blocked",
            "This China strategy is on the administrator blacklist",
          );
        }
      }

      const active = Object.values(state.jobs).find(
        (job) => job.sourceId === sourceId && ACTIVE_JOB_STATUSES.has(job.status),
      );
      if (active) return { job: active, created: false };

      if (context.public) {
        const settings = normaliseSettings(state.settings);
        const jobs = Object.values(state.jobs);
        const activeCount = jobs.filter((job) =>
          ACTIVE_JOB_STATUSES.has(job.status)).length;
        if (activeCount >= settings.maxPendingJobs) {
          throw new WorkerPolicyError(
            "queue_full",
            "The transfer queue is at capacity",
            { status: 429, retryAfter: 300 },
          );
        }
        if (state.quota.blockedUntil > now.getTime()) {
          throw new WorkerPolicyError("quota_migration_cooldown", "Publishing quotas are recovering after a state upgrade", {
            status: 429, retryAfter: Math.ceil((state.quota.blockedUntil - now.getTime()) / 1000),
          });
        }
        const dayStart = startOfUtcDay(now);
        const jobsToday = state.quota.events.filter(event => event.at >= dayStart).length;
        if (jobsToday >= settings.dailyAccountQuota) {
          const nextDay = dayStart + 86_400_000;
          throw new WorkerPolicyError(
            "daily_quota_reached",
            "The publishing account has reached its daily quota",
            {
              status: 429,
              retryAfter: Math.max(1, Math.ceil((nextDay - now.getTime()) / 1000)),
            },
          );
        }
        const windowStart = now.getTime()
          - settings.perIpWindowMinutes * 60_000;
        const clientJobs = state.quota.events.filter(event =>
          event.clientKey === String(context.clientKey ?? "anonymous")
          && event.at > windowStart);
        if (clientJobs.length >= settings.perIpLimit) {
          const oldest = Math.min(...clientJobs.map(event => event.at));
          throw new WorkerPolicyError(
            "rate_limited",
            "This client has reached the transfer submission limit",
            {
              status: 429,
              retryAfter: Math.max(
                1,
                Math.ceil((oldest + settings.perIpWindowMinutes * 60_000
                  - now.getTime()) / 1000),
              ),
            },
          );
        }
      }

      if (state.quota.events.length >= 20_000) {
        throw new WorkerPolicyError("quota_capacity", "Publishing accounting is at capacity", { status: 429, retryAfter: 3600 });
      }
      const timestamp = now.toISOString();
      const job = {
        id: randomUUID(),
        sourceId,
        status: "queued",
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(context.public ? { clientKey: String(context.clientKey ?? "anonymous") } : {}),
      };
      state.jobs[job.id] = job;
      state.quota.events.push({ at: now.getTime(), clientKey: context.public ? String(context.clientKey ?? "anonymous") : "" });
      return { job, created: true };
    }, now);
  }

  updateSettings(patch) {
    return this.mutate((state) => {
      state.settings = normaliseSettings(
        { ...state.settings, ...patch },
        { strict: true },
      );
      return structuredClone(state.settings);
    });
  }

  async dashboard(now = this.now()) {
    await this.writeChain;
    const state = pruneState(await this.readState(now), now);
    const jobs = Object.values(state.jobs)
      .sort((left, right) => String(right.createdAt).localeCompare(left.createdAt))
      .map((job) => ({
        id: job.id,
        sourceId: job.sourceId,
        status: ACTIVE_JOB_STATUSES.has(job.status) ? "queued" : job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        result: job.result
          ? {
              status: job.result.status,
              globalId: job.result.globalId ?? null,
              shareCode: job.result.shareCode ?? null,
              ignoredCount: job.result.ignored?.length ?? 0,
            }
          : null,
        error: job.error ? safeAdminError(job.error) : null,
      }));
    const counts = Object.fromEntries(
      ["queued", "running", "completed", "failed"].map((status) => [
        status,
        Object.values(state.jobs).filter((job) => job.status === status).length,
      ]),
    );
    const jobsToday = state.quota.events.filter(event => event.at >= startOfUtcDay(now)).length;
    return {
      settings: structuredClone(state.settings),
      stats: {
        ...counts,
        active: counts.queued + counts.running,
        jobsToday,
        quotaRecoveryUntil: state.quota.blockedUntil > now.getTime() ? new Date(state.quota.blockedUntil).toISOString() : null,
        remainingDailyQuota: state.quota.blockedUntil > now.getTime() ? 0 : Math.max(
          0,
          state.settings.dailyAccountQuota - jobsToday,
        ),
        storedJobs: jobs.length,
      },
      jobs,
    };
  }

  update(jobId, patch, now = this.now()) {
    return this.mutate((state) => {
      const current = state.jobs[jobId];
      if (!current) throw new Error(`Unknown transfer job: ${jobId}`);
      const updated = {
        ...current,
        ...patch,
        id: current.id,
        sourceId: current.sourceId,
        updatedAt: now.toISOString(),
      };
      state.jobs[jobId] = updated;
      return updated;
    }, now);
  }

  async recoverable() {
    await this.writeChain;
    return Object.values((await this.readState()).jobs)
      .filter((job) => ACTIVE_JOB_STATUSES.has(job.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}

export class TransferJobQueue {
  constructor({ store, transferFn, now = () => new Date() }) {
    if (!store || typeof transferFn !== "function") {
      throw new TypeError("A job store and transfer function are required");
    }
    this.store = store;
    this.transferFn = transferFn;
    this.now = now;
    this.pending = [];
    this.running = false;
  }

  async start() {
    const recoverable = await this.store.recoverable();
    for (const job of recoverable) {
      await this.store.update(job.id, { status: "queued" }, this.now());
      this.pending.push(job.id);
    }
    this.drain();
  }

  async submit(input, context = {}) {
    const sourceId = parseChinaLineupInput(String(input ?? ""));
    const { job, created } = await this.store.createOrGetActive(
      sourceId,
      context,
      this.now(),
    );
    if (created) {
      this.pending.push(job.id);
      this.drain();
    }
    return publicJob(job);
  }

  async get(jobId) {
    return publicJob(await this.store.get(jobId));
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const jobId = this.pending.shift();
        const job = await this.store.update(
          jobId,
          { status: "running", error: null },
          this.now(),
        );
        try {
          const result = await this.transferFn(job.sourceId);
          await this.store.update(
            jobId,
            { status: "completed", result, error: null },
            this.now(),
          );
        } catch (error) {
          await this.store.update(
            jobId,
            {
              status: "failed",
              result: null,
              error: {
                code: error?.reason
                  ?? (error?.name === "PublishingSessionError"
                    ? "publishing_session_error"
                    : "transfer_failed"),
                message: String(error?.message ?? "Transfer failed"),
              },
            },
            this.now(),
          );
        }
      }
    } finally {
      this.running = false;
      if (this.pending.length > 0) this.drain();
    }
  }
}

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

function authorised(request, token) {
  const supplied = String(request.headers?.authorization ?? "")
    .replace(/^Bearer\s+/i, "");
  const digest = (value) => createHash("sha256").update(String(value)).digest();
  return timingSafeEqual(digest(token), digest(supplied));
}

async function readJsonBody(request, maximumBytes = 65_536) {
  try {
    return await withDeadline(signal => readJsonBodyContent(request, maximumBytes, signal), { timeoutMs: 5000 });
  } catch (error) {
    if (error.name === "TimeoutError") request.destroy?.();
    throw error;
  }
}
async function readJsonBodyContent(request, maximumBytes, signal) {
  if (request.body && typeof request.body === "object") {
    if (Buffer.byteLength(JSON.stringify(request.body)) > maximumBytes) {
      throw new TypeError("Request body is too large");
    }
    return request.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    signal.throwIfAborted();
    size += chunk.length;
    if (size > maximumBytes) throw new TypeError("Request body is too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new TypeError("Request body must be valid JSON");
  }
}

export function createWorkerHandler({
  queue, store, token, instanceId = null,
  securityStore = store?.path ? new JsonSecurityStore(store.path + ".security.json") : null,
  now = () => new Date(), maxConcurrent = 8,
}) {
  if (!queue || !token) throw new TypeError("A queue and worker token are required");

  const gate = createConcurrencyGate(maxConcurrent);
  const localBudgets = Object.fromEntries(["submit", "poll"].map(kind => [kind, createRequestBudget(REQUEST_BUDGETS[kind])]));
  async function admit(kind, clientKey) {
    const time = now().getTime();
    const local = localBudgets[kind].consume(clientKey, time);
    if (!local.allowed) throw new WorkerPolicyError("request_rate_limited", "Too many transfer requests", { status: 429, retryAfter: local.retryAfter });
    // Local limits reject floods before disk I/O. This durable authority is shared
    // by all API instances and remains effective across worker restarts.
    if (securityStore) {
      const durable = await securityStore.consume(kind, clientKey, time);
      if (!durable.allowed) throw new WorkerPolicyError("request_rate_limited", "Too many transfer requests", { status: 429, retryAfter: durable.retryAfter });
    }
  }
  return async function workerHandler(request, response) {
    const url = new URL(request.url ?? "/", "http://worker.local");
    if (request.method === "GET" && url.pathname === "/health") {
      if (instanceId) response.setHeader("x-currency-war-instance", instanceId);
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (!authorised(request, token)) {
      sendJson(response, 401, { error: { code: "unauthorised" } });
      return;
    }

    const release = gate.enter();
    if (!release) {
      response.setHeader("retry-after", "1");
      sendJson(response, 429, { error: { code: "worker_busy", message: "Worker is busy", retryAfter: 1 } });
      return;
    }
    try {
      if (url.search) throw new TypeError("Worker routes do not accept query parameters");
      if (request.method === "POST" && url.pathname === "/jobs") {
        const body = await readJsonBody(request);
        const clientKey = String(body.clientKey ?? "anonymous");
        const sourceId = parseChinaLineupInput(String(body.sourceId ?? ""));
        await admit("submit", clientKey);
        sendJson(response, 202, await queue.submit(sourceId, { public: true, clientKey }));
        return;
      }

      if (request.method === "POST" && url.pathname === "/admin" && securityStore) {
        const body = await readJsonBody(request, 2048);
        const time = now().getTime();
        let active;
        if (body.action === "session.register") active = await securityStore.register(body.id, body.expiresAt, time);
        else if (body.action === "session.check") active = await securityStore.isActive(body.id, time);
        else if (body.action === "session.revoke") { await securityStore.revoke(body.id, time); active = false; }
        else throw new TypeError("Unknown administrator operation");
        sendJson(response, 200, { active });
        return;
      }

      if (request.method === "GET" && url.pathname === "/admin" && store) {
        sendJson(response, 200, await store.dashboard());
        return;
      }

      if (request.method === "PUT" && url.pathname === "/admin" && store) {
        const body = await readJsonBody(request);
        const settings = await store.updateSettings(body);
        sendJson(response, 200, { settings });
        return;
      }

      const jobMatch = url.pathname.match(/^\/jobs\/([A-Za-z0-9_-]{1,100})$/);
      if (request.method === "GET" && jobMatch) {
        await admit("poll", String(request.headers?.["x-currency-war-client"] ?? "anonymous"));
        const job = await queue.get(jobMatch[1]);
        if (!job) {
          sendJson(response, 404, { error: { code: "job_not_found" } });
          return;
        }
        sendJson(response, 200, job);
        return;
      }

      sendJson(response, 404, { error: { code: "not_found" } });
    } catch (error) {
      const policyError = error instanceof WorkerPolicyError;
      const inputError = error instanceof TypeError;
      if (policyError && error.retryAfter) {
        response.setHeader("retry-after", error.retryAfter);
      }
      sendJson(response, policyError ? error.status : inputError ? 400 : 500, {
        error: {
          code: policyError
            ? error.code
            : inputError ? "invalid_request" : "worker_error",
          message: policyError || inputError
            ? error.message
            : "The worker could not process the request",
          ...(policyError && error.retryAfter
            ? { retryAfter: error.retryAfter }
            : {}),
        },
      });
    } finally { release(); }
  };
}
