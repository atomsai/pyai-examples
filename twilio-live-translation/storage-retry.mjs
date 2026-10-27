/** Bounded storage I/O only; callers reconcile conditional writes before retrying. */
export function isTransientStorageError(error) {
  return error?.status === 429 || (Number.isInteger(error?.status) && error.status >= 500 && error.status <= 599)
    || ['AbortError', 'TimeoutError'].includes(error?.name) || error instanceof TypeError;
}

export function createStorageBudget({ now = Date.now, sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  deadline, timeoutMs = 1500, errorCode = 'fleet_storage_unavailable' } = {}) {
  const started = now(), end = Math.min(deadline ?? started + 6500, started + 6500);
  if (!Number.isFinite(end) || !Number.isFinite(timeoutMs) || timeoutMs < 1 || typeof sleep !== 'function') throw new Error(errorCode);
  const remaining = () => Math.max(0, end - now());
  const assertTime = () => { if (remaining() <= 0) throw new Error(errorCode); };
  async function bounded(run, maximum = timeoutMs, cancel = () => {}) {
    assertTime(); const duration = Math.max(1, Math.floor(Math.min(maximum, remaining())));
    const controller = new AbortController(); let timer;
    try {
      return await Promise.race([Promise.resolve().then(() => run(controller.signal)), new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(); try { cancel(); } catch { /* Preserve the bounded timeout. */ }
          reject(Object.assign(new Error(errorCode), { name: 'TimeoutError' }));
        }, duration);
      })]);
    } finally { clearTimeout(timer); }
  }
  return {
    deadline: end, remaining, assertTime,
    async request(fetchImpl, token, url, init = {}) {
      if (!String(url).startsWith('https://storage.googleapis.com/')) throw new Error(errorCode);
      return bounded(async signal => {
        const credential = await token(); assertTime();
        if (signal.aborted) throw Object.assign(new Error(errorCode), { name: 'TimeoutError' });
        if (typeof credential !== 'string' || !credential.length) throw new Error(errorCode);
        return fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${credential}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}) }, redirect: 'error', signal });
      });
    },
    async json(response, maximum = 8192) {
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw Object.assign(new Error(errorCode), { status: response.status });
      }
      const reader = response.body?.getReader(); if (!reader) throw new Error(errorCode);
      let bytes = 0; const chunks = [];
      try {
        return await bounded(async () => {
          for (;;) { const part = await reader.read(); if (part.done) break;
            if ((bytes += part.value.length) > maximum) throw Object.assign(new Error(errorCode), { code: 'storage_response_limit' }); chunks.push(part.value); }
          try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new Error(errorCode); }
        }, timeoutMs, () => { void reader.cancel().catch(() => {}); });
      } finally { void reader.cancel().catch(() => {}); }
    },
    async backoff(attempt) {
      assertTime(); const delay = Math.min(100 * 2 ** Math.min(Math.max(0, attempt), 4), 1000, remaining() - 1);
      if (delay <= 0) throw new Error(errorCode);
      await bounded(() => sleep(delay), remaining()); assertTime();
    },
  };
}
