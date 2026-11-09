// A deadline covers the entire operation, including DNS and response-body reads.
export function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

export async function withDeadline(operation, { signal, timeoutMs = 15_000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("A positive request deadline is required");
  }
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new DOMException("Request deadline exceeded", "TimeoutError"));
  }, timeoutMs);
  try {
    controller.signal.throwIfAborted();
    return await abortable(Promise.resolve().then(() => operation(controller.signal)), controller.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
