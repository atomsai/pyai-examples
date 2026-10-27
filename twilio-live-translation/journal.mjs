import { isDeepStrictEqual } from 'node:util';
import { createStorageBudget, isTransientStorageError } from './storage-retry.mjs';

/** A create-only event has one immutable name, including after a lost reply. */
export function createEventJournal({ bucket, prefix, token, fetchImpl = fetch, now = Date.now, sleep } = {}) {
  if (!/^[a-z0-9][a-z0-9._-]{2,62}$/.test(bucket ?? '') || !/^[\w/-]{1,160}$/.test(prefix ?? '')
      || prefix.includes('..') || typeof token !== 'function') throw new Error('journal_write_failed');
  return async entry => {
    if (!/^test-[a-f0-9-]{36}$/i.test(entry?.host_room_id ?? '') || !Number.isSafeInteger(entry.host_sequence)
        || entry.host_sequence < 1 || entry.host_sequence > 10000) throw new Error('journal_write_failed');
    const body = JSON.stringify(entry);
    if (Buffer.byteLength(body) > 65536) throw new Error('journal_limit');
    const name = `${prefix}/${entry.host_room_id}/${String(entry.host_sequence).padStart(6, '0')}.json`;
    const object = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}`;
    const upload = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(name)}`;
    const budget = createStorageBudget({ now, sleep, deadline: now() + 4500, timeoutMs: 1200, errorCode: 'journal_write_failed' });
    async function reconcile() {
      const response = await budget.request(fetchImpl, token, object);
      if (response.status === 404) { await response.body?.cancel(); return false; }
      const metadata = await budget.json(response);
      if (metadata.name !== name || !/^[1-9][0-9]*$/.test(metadata.generation ?? '')) throw new Error('journal_write_failed');
      const saved = await budget.json(await budget.request(fetchImpl, token,
        `${object}?alt=media&generation=${metadata.generation}`), 65536);
      if (!isDeepStrictEqual(saved, entry)) throw new Error('journal_conflict');
      return true;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      let uncertain;
      try {
        const response = await budget.request(fetchImpl, token, upload, { method: 'POST', body });
        if (response.status === 412) { await response.body?.cancel(); if (await reconcile()) return; throw new Error('journal_write_failed'); }
        const metadata = await budget.json(response);
        if (metadata.name !== name || !/^[1-9][0-9]*$/.test(metadata.generation ?? '')) throw new Error('journal_write_failed');
        return;
      } catch (error) {
        if (!isTransientStorageError(error) || attempt === 2) throw new Error('journal_write_failed');
        uncertain = error;
      }
      // A timeout may follow a successful create. Read its exact generation
      // before another create-only attempt; never overwrite an existing event.
      try { if (await reconcile()) return; }
      catch (error) { if (!isTransientStorageError(error)) throw new Error('journal_write_failed'); }
      if (uncertain) await budget.backoff(attempt);
    }
    throw new Error('journal_write_failed');
  };
}
