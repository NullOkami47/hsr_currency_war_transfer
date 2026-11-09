// Fixed-window request budgets. Active entries are never evicted to admit new clients.
export const REQUEST_BUDGETS = Object.freeze({
  roles: Object.freeze({ limit: 30, globalLimit: 120, windowMs: 60_000 }),
  submit: Object.freeze({ limit: 10, globalLimit: 60, windowMs: 60_000 }),
  poll: Object.freeze({ limit: 60, globalLimit: 600, windowMs: 60_000 }),
});

export function consumeBudget(state, kind, key, nowMs, options = REQUEST_BUDGETS[kind]) {
  const { limit, globalLimit, windowMs, maxClients = 5000 } = options ?? {};
  if (![limit, globalLimit, windowMs, maxClients].every(n => Number.isInteger(n) && n > 0)
      || !Number.isFinite(nowMs)) throw new TypeError("Invalid request budget");
  key = String(key ?? "anonymous");
  if (key.length > 200) throw new TypeError("Invalid client identity");
  const bucket = state[kind] ?? { count: 0, resetAt: nowMs + windowMs, clients: {} };
  if (bucket.resetAt <= nowMs) {
    bucket.count = 0;
    bucket.resetAt = nowMs + windowMs;
    bucket.clients = {};
  }
  const count = Object.hasOwn(bucket.clients, key) ? bucket.clients[key] : 0;
  const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - nowMs) / 1000));
  if (bucket.count >= globalLimit || count >= limit
      || (!count && Object.keys(bucket.clients).length >= maxClients)) {
    return { allowed: false, retryAfter };
  }
  bucket.count += 1;
  Object.defineProperty(bucket.clients, key, { value: count + 1, enumerable: true, configurable: true, writable: true });
  state[kind] = bucket;
  return { allowed: true, retryAfter: 0 };
}

export function createRequestBudget(options) {
  const state = {};
  return { consume(key, nowMs) { return consumeBudget(state, "requests", key, nowMs, options); } };
}

export function createConcurrencyGate(limit = 16) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError("Invalid concurrency limit");
  let active = 0;
  return {
    enter() {
      if (active >= limit) return null;
      active += 1;
      let released = false;
      return () => { if (!released) { released = true; active -= 1; } };
    },
  };
}
