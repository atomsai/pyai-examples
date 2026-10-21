import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createStorageBudget, isTransientStorageError } from './storage-retry.mjs';

const ROOM = /^test-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLOT = /^slot-(?:0[1-9]|10)$/;
const same = (value, binding) => value.room_id === binding.roomId && value.slot_id === binding.slotId
  && value.project === binding.project && value.owner === binding.owner && value.expires_at === binding.expiresAt
  && value.lease_until === binding.leaseUntil;

/** Renewable ten-slot admission, fenced by GCS object generations across restarts. */
export function createFleetLeases({ bucket, prefix, serviceId, token, recover, reserveAllowance = async () => {}, fetchImpl = fetch, now = Date.now, sleep }) {
  if (!/^[a-z0-9][a-z0-9._-]{2,62}$/.test(bucket ?? '') || !/^[\w/-]{1,160}$/.test(prefix ?? '')
      || prefix.includes('..') || !/^[a-z0-9-]{8,80}$/.test(serviceId ?? '')
      || typeof token !== 'function' || typeof recover !== 'function' || typeof reserveAllowance !== 'function') throw new Error('invalid_fleet_lease_config');
  const owned = new Map();
  const object = slot => `${prefix}/fleet-${serviceId}/${slot}.json`;
  const url = name => `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}`;
  const storageBudget = deadline => createStorageBudget({ now, sleep, deadline, timeoutMs: 1500,
    errorCode: 'fleet_lease_storage_failed' });
  const unavailable = error => Object.assign(new Error('fleet_lease_storage_failed'),
    Number.isInteger(error?.status) ? { status: error.status } : {});
  async function backoff(budget, attempt, error) {
    try { await budget.backoff(attempt); }
    catch { throw unavailable(error); }
  }
  async function within(budget, pending) {
    budget.assertTime(); let timer;
    const task = typeof pending === 'function' ? Promise.resolve().then(() => { budget.assertTime(); return pending(); }) : pending;
    try { return await Promise.race([task, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('fleet_lease_storage_failed')), budget.remaining());
    })]); } finally { clearTimeout(timer); }
  }
  async function json(budget, response) {
    try { return await budget.json(response); }
    catch (error) {
      if (error.code === 'storage_response_limit') throw new Error('fleet_lease_response_limit');
      throw error;
    }
  }
  function validate(value, slot) {
    if (!value || typeof value !== 'object' || value.schema !== 'pyai-carrier-slot-v1' || value.service_id !== serviceId || value.slot_id !== slot
        || !ROOM.test(value.room_id ?? '') || !['project', 'owner'].every(key => typeof value[key] === 'string' && /^[\w.-]{1,100}$/.test(value[key]))
        || !/^[0-9a-f]{48}$/.test(value.lease ?? '') || !Number.isSafeInteger(value.expires_at)
        || !Number.isSafeInteger(value.lease_until) || value.lease_until !== value.expires_at + 630_000
        || typeof value.terminal_verified !== 'boolean' || !Array.isArray(value.call_ids) || value.call_ids.length > 3
        || value.call_ids.some(id => !UUID.test(id)) || new Set(value.call_ids).size !== value.call_ids.length) {
      throw new Error('fleet_lease_binding_failed');
    }
  }
  async function read(slot, budget) {
    let lastTransient;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        budget.assertTime();
        const metadata = await budget.request(fetchImpl, token, url(object(slot)));
        if (metadata.status === 404) {
          void metadata.body?.cancel().catch(() => {});
          return { generation: '0', value: null };
        }
        const stored = await json(budget, metadata), generation = stored?.generation;
        if (!/^[1-9][0-9]{0,30}$/.test(generation ?? '')) throw new Error('fleet_lease_storage_failed');
        const value = await json(budget, await budget.request(fetchImpl, token,
          url(object(slot)) + `?alt=media&generation=${generation}`));
        if (slot === 'admissions') {
          if (!value || value.schema !== 'pyai-carrier-admissions-v1' || value.service_id !== serviceId
              || typeof value.paused !== 'boolean') throw new Error('fleet_lease_binding_failed');
        } else validate(value, slot);
        return { generation, value };
      } catch (error) {
        if (!isTransientStorageError(error)) throw error;
        lastTransient = error; await backoff(budget, attempt, error);
      }
    }
    throw unavailable(lastTransient);
  }
  async function write(slot, value, generation, budget) {
    let lastTransient;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        budget.assertTime();
        const response = await budget.request(fetchImpl, token,
          `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&ifGenerationMatch=${generation}&name=${encodeURIComponent(object(slot))}`,
          { method: 'POST', body: JSON.stringify(value) });
        if (response.status === 412) {
          void response.body?.cancel().catch(() => {});
          const current = await read(slot, budget);
          if (isDeepStrictEqual(current.value, value)) return current.generation;
          throw new Error('fleet_slot_busy');
        }
        const result = await json(budget, response);
        if (!/^[1-9][0-9]{0,30}$/.test(result?.generation ?? '')) throw new Error('fleet_lease_storage_failed');
        return result.generation;
      } catch (error) {
        if (!isTransientStorageError(error)) throw error;
        lastTransient = error;
        // A lost acknowledgement may already have committed. Never repeat the
        // mutation or adopt another lease without this exact desired-state read.
        const current = await read(slot, budget);
        if (isDeepStrictEqual(current.value, value)) return current.generation;
        if (current.generation !== generation) throw new Error('fleet_slot_busy');
        await backoff(budget, attempt, error);
      }
    }
    throw unavailable(lastTransient);
  }
  async function update(binding, mutation, budget) {
    const current = await read(binding.slotId, budget);
    if (!current.value || !same(current.value, binding) || current.value.lease !== binding.lease) throw new Error('fleet_lease_fenced');
    const value = mutation(current.value);
    await write(binding.slotId, value, current.generation, budget); return value;
  }
  async function control(budget) {
    const current = await read('admissions', budget);
    return current.value ? current : { generation: '0', value: { schema: 'pyai-carrier-admissions-v1', service_id: serviceId, paused: false } };
  }
  return {
    async reconcileRoom(binding) {
      const budget = storageBudget();
      if (!SLOT.test(binding.slotId ?? '') || !ROOM.test(binding.roomId ?? '')
          || !Number.isSafeInteger(binding.leaseUntil) || now() < binding.leaseUntil) throw new Error('fleet_token_still_live');
      const current = await read(binding.slotId, budget);
      if (current.value && same(current.value, binding)) {
        if (!current.value.terminal_verified) {
          await within(budget, () => recover({ roomId: current.value.room_id, callIds: [...current.value.call_ids] }));
          await write(binding.slotId, { ...current.value, terminal_verified: true }, current.generation, budget);
        }
      }
      // A foreign replacement is left untouched; its CAS lease still denies reuse.
      owned.delete(binding.roomId);
    },
    async setPaused(paused) {
      if (typeof paused !== 'boolean') throw new Error('invalid_drain_state');
      const budget = storageBudget();
      let written = false;
      for (let attempt = 0; attempt < 6; attempt++) {
        const previous = await control(budget);
        try { await write('admissions', { ...previous.value, paused }, previous.generation, budget); written = true; break; }
        catch (error) { if (error.message !== 'fleet_slot_busy') throw error; }
      }
      if (!written) throw new Error('fleet_drain_busy');
      // Strong reads follow the pause write. Every escaping room grant has a
      // preceding durable slot claim plus a subsequent unpaused-control read.
      const slots = await Promise.all(Array.from({ length: 10 }, (_, i) => read(`slot-${String(i + 1).padStart(2, '0')}`, budget)));
      return { admissions_paused: paused, durable_active_rooms: slots.filter(slot => slot.value && !slot.value.terminal_verified).length };
    },
    async reserveRoom(binding) {
      // Leave the existing eight-second caller time for the 1.7s creation journal.
      const budget = storageBudget(now() + 6000);
      if (!SLOT.test(binding.slotId ?? '') || !ROOM.test(binding.roomId ?? '')
          || !['project', 'owner'].every(key => typeof binding[key] === 'string' && /^[\w.-]{1,100}$/.test(binding[key]))
          || !Number.isSafeInteger(binding.expiresAt) || binding.expiresAt <= now() || binding.expiresAt > now() + 480_000
          || binding.leaseUntil !== binding.expiresAt + 630_000) throw new Error('invalid_fleet_lease');
      if ((await control(budget)).value.paused) throw new Error('host_draining');
      const previous = await read(binding.slotId, budget);
      if (previous.value) {
        if (previous.value.lease_until > now()) throw new Error('fleet_slot_busy');
        if (!previous.value.terminal_verified) {
          // Only recorded exact call IDs from our fenced slot may be reconciled.
          await within(budget, () => recover({ roomId: previous.value.room_id, callIds: [...previous.value.call_ids] }));
        }
      }
      const lease = randomBytes(24).toString('hex');
      const value = { schema: 'pyai-carrier-slot-v1', service_id: serviceId, slot_id: binding.slotId,
        room_id: binding.roomId, project: binding.project, owner: binding.owner, expires_at: binding.expiresAt,
        lease_until: binding.leaseUntil, lease, call_ids: [], terminal_verified: false };
      await write(binding.slotId, value, previous.generation, budget);
      owned.set(binding.roomId, { ...binding, lease, pending: Promise.resolve() });
      await within(budget, () => reserveAllowance(binding.roomId, { deadline: budget.deadline }));
      const current = await read(binding.slotId, budget);
      if (!isDeepStrictEqual(current.value, value)) throw new Error('fleet_lease_fenced');
      if ((await control(budget)).value.paused) throw new Error('host_draining');
      budget.assertTime();
      if (binding.expiresAt <= now()) throw new Error('invalid_fleet_lease');
      return lease;
    },
    async recordEntry(entry) {
      if (!['host.call.admitted', 'host.room.closed'].includes(entry.event)) return;
      const binding = owned.get(entry.host_room_id); if (!binding) throw new Error('fleet_lease_fenced');
      const budget = storageBudget();
      const pending = binding.pending.then(() => update(binding, value => {
        if (entry.event === 'host.call.admitted') {
          if (!UUID.test(entry.provider_call_id ?? '') || value.call_ids.length >= 3
              || value.call_ids.includes(entry.provider_call_id)) throw new Error('fleet_call_binding_failed');
          return { ...value, call_ids: [...value.call_ids, entry.provider_call_id] };
        }
        return { ...value, terminal_verified: entry.cleanup === 'calls_terminal_verified' };
      }, budget));
      binding.pending = pending.catch(() => {}); await within(budget, pending);
    },
    async releaseRoom(binding) {
      const budget = storageBudget();
      const current = owned.get(binding.roomId);
      if (!current || current.lease !== binding.lease || !same({ room_id: current.roomId, slot_id: current.slotId,
        project: current.project, owner: current.owner, expires_at: current.expiresAt, lease_until: current.leaseUntil }, binding)) {
        throw new Error('fleet_lease_fenced');
      }
      await within(budget, current.pending);
      if (now() < binding.leaseUntil) throw new Error('fleet_token_still_live');
      await update(binding, value => { if (!value.terminal_verified) throw new Error('fleet_cleanup_unverified'); return value; }, budget);
      owned.delete(binding.roomId);
    },
  };
}
