import { randomBytes } from 'node:crypto';

const ROOM = /^test-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLOT = /^slot-(?:0[1-9]|10)$/;
const same = (value, binding) => value.room_id === binding.roomId && value.slot_id === binding.slotId
  && value.project === binding.project && value.owner === binding.owner && value.expires_at === binding.expiresAt
  && value.lease_until === binding.leaseUntil;

/** Renewable ten-slot admission, fenced by GCS object generations across restarts. */
export function createFleetLeases({ bucket, prefix, serviceId, token, recover, reserveAllowance = async () => {}, fetchImpl = fetch, now = Date.now }) {
  if (!/^[a-z0-9][a-z0-9._-]{2,62}$/.test(bucket ?? '') || !/^[\w/-]{1,160}$/.test(prefix ?? '')
      || prefix.includes('..') || !/^[a-z0-9-]{8,80}$/.test(serviceId ?? '')
      || typeof token !== 'function' || typeof recover !== 'function' || typeof reserveAllowance !== 'function') throw new Error('invalid_fleet_lease_config');
  const owned = new Map();
  const object = slot => `${prefix}/fleet-${serviceId}/${slot}.json`;
  const url = name => `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}`;
  async function json(response) {
    if (!response.ok) throw new Error('fleet_lease_storage_failed');
    const reader = response.body?.getReader(); if (!reader) throw new Error('fleet_lease_storage_failed');
    let bytes = 0; const chunks = [];
    try { for (;;) { const part = await reader.read(); if (part.done) break;
      if ((bytes += part.value.length) > 8192) throw new Error('fleet_lease_response_limit'); chunks.push(part.value); } }
    finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  async function request(target, init = {}) {
    return fetchImpl(target, { ...init, headers: { Authorization: `Bearer ${await token()}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}) }, redirect: 'error', signal: AbortSignal.timeout(2000) });
  }
  function validate(value, slot) {
    if (value.schema !== 'pyai-carrier-slot-v1' || value.service_id !== serviceId || value.slot_id !== slot
        || !ROOM.test(value.room_id ?? '') || !['project', 'owner'].every(key => typeof value[key] === 'string' && /^[\w.-]{1,100}$/.test(value[key]))
        || !/^[0-9a-f]{48}$/.test(value.lease ?? '') || !Number.isSafeInteger(value.expires_at)
        || !Number.isSafeInteger(value.lease_until) || value.lease_until !== value.expires_at + 630_000
        || typeof value.terminal_verified !== 'boolean' || !Array.isArray(value.call_ids) || value.call_ids.length > 3
        || value.call_ids.some(id => !UUID.test(id)) || new Set(value.call_ids).size !== value.call_ids.length) {
      throw new Error('fleet_lease_binding_failed');
    }
  }
  async function read(slot) {
    const metadata = await request(url(object(slot)));
    if (metadata.status === 404) return { generation: '0', value: null };
    const { generation } = await json(metadata);
    if (!/^[1-9][0-9]{0,30}$/.test(generation ?? '')) throw new Error('fleet_lease_storage_failed');
    const value = await json(await request(url(object(slot)) + `?alt=media&generation=${generation}`));
    validate(value, slot); return { generation, value };
  }
  async function write(slot, value, generation) {
    const response = await request(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&ifGenerationMatch=${generation}&name=${encodeURIComponent(object(slot))}`,
      { method: 'POST', body: JSON.stringify(value) });
    if (response.status === 412) throw new Error('fleet_slot_busy');
    const result = await json(response);
    if (!/^[1-9][0-9]{0,30}$/.test(result.generation ?? '')) throw new Error('fleet_lease_storage_failed');
    return result.generation;
  }
  async function update(binding, mutation) {
    const current = await read(binding.slotId);
    if (!current.value || !same(current.value, binding) || current.value.lease !== binding.lease) throw new Error('fleet_lease_fenced');
    const value = mutation(current.value);
    await write(binding.slotId, value, current.generation); return value;
  }
  async function control() {
    const metadata = await request(url(object('admissions')));
    if (metadata.status === 404) return { generation: '0', value: { schema: 'pyai-carrier-admissions-v1', service_id: serviceId, paused: false } };
    const { generation } = await json(metadata);
    if (!/^[1-9][0-9]{0,30}$/.test(generation ?? '')) throw new Error('fleet_lease_storage_failed');
    const value = await json(await request(url(object('admissions')) + `?alt=media&generation=${generation}`));
    if (value.schema !== 'pyai-carrier-admissions-v1' || value.service_id !== serviceId || typeof value.paused !== 'boolean') throw new Error('fleet_lease_binding_failed');
    return { generation, value };
  }
  return {
    async reconcileRoom(binding) {
      if (!SLOT.test(binding.slotId ?? '') || !ROOM.test(binding.roomId ?? '')
          || !Number.isSafeInteger(binding.leaseUntil) || now() < binding.leaseUntil) throw new Error('fleet_token_still_live');
      const current = await read(binding.slotId);
      if (current.value && same(current.value, binding)) {
        if (!current.value.terminal_verified) {
          await recover({ roomId: current.value.room_id, callIds: [...current.value.call_ids] });
          await write(binding.slotId, { ...current.value, terminal_verified: true }, current.generation);
        }
      }
      // A foreign replacement is left untouched; its CAS lease still denies reuse.
      owned.delete(binding.roomId);
    },
    async setPaused(paused) {
      if (typeof paused !== 'boolean') throw new Error('invalid_drain_state');
      let written = false;
      for (let attempt = 0; attempt < 6; attempt++) {
        const previous = await control();
        try { await write('admissions', { ...previous.value, paused }, previous.generation); written = true; break; }
        catch (error) { if (error.message !== 'fleet_slot_busy') throw error; }
      }
      if (!written) throw new Error('fleet_drain_busy');
      // Strong reads follow the pause write. Every escaping room grant has a
      // preceding durable slot claim plus a subsequent unpaused-control read.
      const slots = await Promise.all(Array.from({ length: 10 }, (_, i) => read(`slot-${String(i + 1).padStart(2, '0')}`)));
      return { admissions_paused: paused, durable_active_rooms: slots.filter(slot => slot.value && !slot.value.terminal_verified).length };
    },
    async reserveRoom(binding) {
      if (!SLOT.test(binding.slotId ?? '') || !ROOM.test(binding.roomId ?? '')
          || !['project', 'owner'].every(key => typeof binding[key] === 'string' && /^[\w.-]{1,100}$/.test(binding[key]))
          || !Number.isSafeInteger(binding.expiresAt) || binding.expiresAt <= now() || binding.expiresAt > now() + 480_000
          || binding.leaseUntil !== binding.expiresAt + 630_000) throw new Error('invalid_fleet_lease');
      if ((await control()).value.paused) throw new Error('host_draining');
      const previous = await read(binding.slotId);
      if (previous.value) {
        if (previous.value.lease_until > now()) throw new Error('fleet_slot_busy');
        if (!previous.value.terminal_verified) {
          // Only recorded exact call IDs from our fenced slot may be reconciled.
          await recover({ roomId: previous.value.room_id, callIds: [...previous.value.call_ids] });
        }
      }
      const lease = randomBytes(24).toString('hex');
      const value = { schema: 'pyai-carrier-slot-v1', service_id: serviceId, slot_id: binding.slotId,
        room_id: binding.roomId, project: binding.project, owner: binding.owner, expires_at: binding.expiresAt,
        lease_until: binding.leaseUntil, lease, call_ids: [], terminal_verified: false };
      await write(binding.slotId, value, previous.generation);
      owned.set(binding.roomId, { ...binding, lease, pending: Promise.resolve() });
      await reserveAllowance(binding.roomId);
      if ((await control()).value.paused) throw new Error('host_draining');
      return lease;
    },
    async recordEntry(entry) {
      if (!['host.call.admitted', 'host.room.closed'].includes(entry.event)) return;
      const binding = owned.get(entry.host_room_id); if (!binding) throw new Error('fleet_lease_fenced');
      const pending = binding.pending.then(() => update(binding, value => {
        if (entry.event === 'host.call.admitted') {
          if (!UUID.test(entry.provider_call_id ?? '') || value.call_ids.length >= 3
              || value.call_ids.includes(entry.provider_call_id)) throw new Error('fleet_call_binding_failed');
          return { ...value, call_ids: [...value.call_ids, entry.provider_call_id] };
        }
        return { ...value, terminal_verified: entry.cleanup === 'calls_terminal_verified' };
      }));
      binding.pending = pending.catch(() => {}); await pending;
    },
    async releaseRoom(binding) {
      const current = owned.get(binding.roomId);
      if (!current || current.lease !== binding.lease || !same({ room_id: current.roomId, slot_id: current.slotId,
        project: current.project, owner: current.owner, expires_at: current.expiresAt, lease_until: current.leaseUntil }, binding)) {
        throw new Error('fleet_lease_fenced');
      }
      await current.pending;
      if (now() < binding.leaseUntil) throw new Error('fleet_token_still_live');
      await update(binding, value => { if (!value.terminal_verified) throw new Error('fleet_cleanup_unverified'); return value; });
      owned.delete(binding.roomId);
    },
  };
}
