export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRateLimitRetry(fn, { maxAttempts = 10, baseDelayMs = 500, maxDelayMs = 30_000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (error?.status !== 429 || attempt >= maxAttempts - 1) throw error;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      await sleep(delay);
    }
  }
  throw lastError;
}
