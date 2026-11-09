import { readPrivateJson, writePrivateJson, serialiseState } from "./private-json.mjs";
import { consumeBudget, REQUEST_BUDGETS } from "./request-budget.mjs";

export const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const ADMIN_SESSION_CLOCK_SKEW_MS = 60_000;
const MAX_SESSIONS = 1000;
function validId(id) { return /^[A-Za-z0-9_-]{32,100}$/.test(String(id ?? "")); }
function pruneSessions(state, nowMs) {
  for (const [id, expiresAt] of Object.entries(state.sessions)) {
    if (!validId(id) || !Number.isFinite(expiresAt)) throw new Error("Invalid session state");
    if (expiresAt <= nowMs) delete state.sessions[id];
  }
}
function sessionOperation(state, operation, id, expiresAt, nowMs) {
  if (!validId(id)) throw new TypeError("Invalid administrator session identifier");
  pruneSessions(state, nowMs);
  if (operation === "check") return Object.hasOwn(state.sessions, id);
  if (operation === "revoke") { delete state.sessions[id]; return true; }
  if (operation !== "register" || !Number.isFinite(expiresAt) || expiresAt <= nowMs
      || expiresAt > nowMs + ADMIN_SESSION_TTL_MS + ADMIN_SESSION_CLOCK_SKEW_MS) throw new TypeError("Invalid session expiry");
  if (Object.keys(state.sessions).length >= MAX_SESSIONS) throw new Error("Session capacity reached");
  // Accept small clock differences across API/worker hosts, but the worker
  // remains authoritative: tolerance never extends the eight-hour lifetime.
  state.sessions[id] = Math.min(expiresAt, nowMs + ADMIN_SESSION_TTL_MS);
  return true;
}

export function createMemorySessionStore() {
  const state = { sessions: {} };
  return {
    register(id, expiresAt, nowMs) { return sessionOperation(state, "register", id, expiresAt, nowMs); },
    isActive(id, nowMs) { return sessionOperation(state, "check", id, undefined, nowMs); },
    revoke(id, nowMs) { return sessionOperation(state, "revoke", id, undefined, nowMs); },
  };
}

export class JsonSecurityStore {
  constructor(path) { if (!path) throw new TypeError("Security state path is required"); this.path = path; }
  async readState() {
    const state = await readPrivateJson(this.path) ?? { version: 1, requests: {}, sessions: {} };
    if (state.version !== 1 || !state.requests || !state.sessions
        || Array.isArray(state.requests) || Array.isArray(state.sessions)) throw new Error("Invalid security state");
    for (const [kind, bucket] of Object.entries(state.requests)) {
      if (!REQUEST_BUDGETS[kind] || !Number.isInteger(bucket.count) || bucket.count < 0
          || !Number.isFinite(bucket.resetAt) || !bucket.clients || Array.isArray(bucket.clients)
          || Object.keys(bucket.clients).length > 5000
          || Object.values(bucket.clients).some(n => !Number.isInteger(n) || n < 1)) throw new Error("Invalid request budget state");
    }
    return state;
  }
  transact(fn) {
    return serialiseState(this.path, async () => {
      const state = await this.readState();
      const before = JSON.stringify(state);
      const result = fn(state);
      if (JSON.stringify(state) !== before) await writePrivateJson(this.path, state);
      return result;
    });
  }
  consume(kind, key, nowMs) {
    if (!REQUEST_BUDGETS[kind]) throw new TypeError("Unknown request budget");
    return this.transact(state => consumeBudget(state.requests, kind, key, nowMs));
  }
  register(id, expiresAt, nowMs) { return this.transact(s => sessionOperation(s, "register", id, expiresAt, nowMs)); }
  isActive(id, nowMs) { return this.transact(s => sessionOperation(s, "check", id, undefined, nowMs)); }
  revoke(id, nowMs) { return this.transact(s => sessionOperation(s, "revoke", id, undefined, nowMs)); }
}
