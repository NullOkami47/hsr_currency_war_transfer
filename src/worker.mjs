import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { parseChinaLineupInput } from "./api.mjs";

const EMPTY_JOB_STATE = Object.freeze({ version: 1, jobs: {} });
const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);

function cloneEmptyState() {
  return structuredClone(EMPTY_JOB_STATE);
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

export class JsonWorkerJobStore {
  constructor(path) {
    if (!path) throw new TypeError("A worker job-state path is required");
    this.path = path;
    this.writeChain = Promise.resolve();
  }

  async readState() {
    try {
      const state = JSON.parse(await readFile(this.path, "utf8"));
      return { version: 1, jobs: state?.jobs ?? {} };
    } catch (error) {
      if (error.code === "ENOENT") return cloneEmptyState();
      throw error;
    }
  }

  async writeState(state) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.path);
  }

  mutate(callback) {
    const operation = this.writeChain.then(async () => {
      const state = await this.readState();
      const result = await callback(state);
      await this.writeState(state);
      return result;
    });
    this.writeChain = operation.catch(() => {});
    return operation;
  }

  async get(jobId) {
    await this.writeChain;
    return (await this.readState()).jobs[jobId] ?? null;
  }

  async findActiveBySource(sourceId) {
    await this.writeChain;
    return Object.values((await this.readState()).jobs).find(
      (job) => job.sourceId === sourceId && ACTIVE_JOB_STATUSES.has(job.status),
    ) ?? null;
  }

  create(sourceId, now = new Date()) {
    return this.mutate((state) => {
      const timestamp = now.toISOString();
      const job = {
        id: randomUUID(),
        sourceId,
        status: "queued",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.jobs[job.id] = job;
      return job;
    });
  }

  createOrGetActive(sourceId, now = new Date()) {
    return this.mutate((state) => {
      const active = Object.values(state.jobs).find(
        (job) => job.sourceId === sourceId && ACTIVE_JOB_STATUSES.has(job.status),
      );
      if (active) return { job: active, created: false };

      const timestamp = now.toISOString();
      const job = {
        id: randomUUID(),
        sourceId,
        status: "queued",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.jobs[job.id] = job;
      return { job, created: true };
    });
  }

  update(jobId, patch, now = new Date()) {
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
    });
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

  async submit(input) {
    const sourceId = parseChinaLineupInput(String(input ?? ""));
    const { job, created } = await this.store.createOrGetActive(
      sourceId,
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
                code: error?.name === "PublishingSessionError"
                  ? "publishing_session_error"
                  : "transfer_failed",
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
  const expectedBuffer = Buffer.from(token);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length
    && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

async function readJsonBody(request, maximumBytes = 16_384) {
  if (request.body && typeof request.body === "object") return request.body;
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
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

export function createWorkerHandler({ queue, token }) {
  if (!queue || !token) throw new TypeError("A queue and worker token are required");

  return async function workerHandler(request, response) {
    const url = new URL(request.url ?? "/", "http://worker.local");
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (!authorised(request, token)) {
      sendJson(response, 401, { error: { code: "unauthorised" } });
      return;
    }

    try {
      if (request.method === "POST" && url.pathname === "/jobs") {
        const body = await readJsonBody(request);
        sendJson(response, 202, await queue.submit(body.sourceId));
        return;
      }

      const jobMatch = url.pathname.match(/^\/jobs\/([A-Za-z0-9_-]{1,100})$/);
      if (request.method === "GET" && jobMatch) {
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
      const inputError = error instanceof TypeError;
      sendJson(response, inputError ? 400 : 500, {
        error: {
          code: inputError ? "invalid_request" : "worker_error",
          message: inputError ? error.message : "The worker could not process the request",
        },
      });
    }
  };
}
