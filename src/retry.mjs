export async function retryRead(
  operation,
  {
    attempts = 2,
    retryDelayMs = 150,
    backoffFactor = 1,
    waitFn = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts && retryDelayMs > 0) {
        await waitFn(retryDelayMs * (backoffFactor ** (attempt - 1)));
      }
    }
  }
  throw lastError;
}
