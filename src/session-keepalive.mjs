function writeEvent(logger, level, event, details = {}) {
  const method = typeof logger?.[level] === "function"
    ? logger[level]
    : logger?.log;
  if (typeof method !== "function") return;
  method.call(
    logger,
    `[publishing-session] ${JSON.stringify({ event, ...details })}`,
  );
}

export function startSessionKeepalive({
  publisher,
  intervalMs,
  initialDelayMs = Math.min(intervalMs, 60_000),
  logger = console,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  if (!publisher || typeof publisher.keepAlive !== "function") {
    throw new TypeError("publisher.keepAlive must be a function");
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError("intervalMs must be greater than zero");
  }

  let stopped = false;
  let timer;

  const schedule = (delay) => {
    if (stopped) return;
    timer = setTimeoutFn(run, delay);
    timer?.unref?.();
  };
  const run = async () => {
    try {
      await publisher.keepAlive();
      writeEvent(logger, "info", "keepalive_ok");
    } catch (error) {
      writeEvent(logger, "warn", "keepalive_failed", {
        errorName: error?.name ?? "Error",
        status: error?.status ?? null,
        retcode: error?.retcode ?? null,
      });
    } finally {
      schedule(intervalMs);
    }
  };

  schedule(initialDelayMs);
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeoutFn(timer);
  };
}
