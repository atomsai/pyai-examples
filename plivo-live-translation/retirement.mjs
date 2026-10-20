const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One owned-call DELETE, then signed completion or exact terminal CDR evidence. */
export function createCallRetirer({ authId, authToken, fetcher = fetch, budgetMs = 4200, pollMs = 100 }) {
  if (!/^[A-Za-z][A-Za-z0-9]{5,63}$/.test(authId ?? '') || !authToken
      || typeof fetcher !== 'function' || !Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 4500
      || !Number.isInteger(pollMs) || pollMs < 1 || pollMs > 250) throw new Error('invalid_retirement_config');
  const authorization = 'Basic ' + Buffer.from(`${authId}:${authToken}`).toString('base64');
  return async (callId, { completed = new Promise(() => {}) } = {}) => {
    if (typeof callId !== 'string' || !UUID.test(callId)) throw new Error('invalid_retired_call');
    const url = `https://api.plivo.com/v1/Account/${authId}/Call/${callId}/`;
    const controller = new AbortController();
    let deadlineTimer, pollingFailure = null;
    const expired = new Promise((_, reject) => {
      deadlineTimer = setTimeout(() => { controller.abort(); reject(new Error(pollingFailure ?? 'call_not_terminal')); }, budgetMs);
    });
    const request = async method => {
      try {
        return await fetcher(url, { method, headers: { Authorization: authorization }, redirect: 'error',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1000)]) });
      } catch { throw new Error(method === 'DELETE' ? 'carrier_hangup_failed' : 'carrier_status_failed'); }
    };
    const poll = async () => {
      // Even an already-confirmed call gets exactly one bounded DELETE attempt.
      const ended = await request('DELETE');
      if (!ended.ok && ended.status !== 404) throw new Error('carrier_hangup_failed');
      while (!controller.signal.aborted) {
        const response = await request('GET');
        if (response.ok) {
          let record;
          try { record = await response.json(); } catch { throw new Error('carrier_status_failed'); }
          if (record?.call_uuid === callId && typeof record.end_time === 'string'
              && record.end_time.length <= 80 && Number.isFinite(Date.parse(record.end_time))
              && typeof record.hangup_cause_name === 'string' && /^[\x20-\x7e]{1,160}$/.test(record.hangup_cause_name)
              && record.hangup_cause_name.trim().length > 0) {
            return 'terminal_cdr';
          }
        } else if (response.status !== 404) throw new Error('carrier_status_failed');
        await new Promise(resolve => {
          const timer = setTimeout(done, pollMs);
          function done() { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); }
          controller.signal.addEventListener('abort', done, { once: true });
          if (controller.signal.aborted) done();
        });
      }
      throw new Error('call_not_terminal');
    };
    try {
      // Start DELETE before racing a completion which may already be journaled.
      const polling = poll().catch(error => {
        pollingFailure = ['carrier_hangup_failed', 'carrier_status_failed'].includes(error?.message)
          ? error.message : 'call_not_terminal';
        // A failed REST read must not preempt independently signed terminal evidence.
        return new Promise(() => {});
      });
      return await Promise.race([polling, completed.then(() => 'signed_completed'), expired]);
    } finally { clearTimeout(deadlineTimer); controller.abort(); }
  };
}
