import plivo from 'plivo';
import { TranslationHost } from './host.mjs';

const ROLES = ['customer', 'agent', 'replacement'];
const ROOM = /^test-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scopeValid = scope => scope && ['project', 'owner'].every(key => typeof scope[key] === 'string'
  && /^[\w.-]{1,100}$/.test(scope[key]));

/** Ten isolated conversations; durable endpoint leases survive process restarts. */
export class MultiRoomTranslationHost {
  constructor(config, { endpointPool, reserveRoom, releaseRoom, reconcileRoom = async () => { throw new Error('room_reconciliation_required'); }, record, now = Date.now,
    validateSignature = plivo.validateV3Signature, ...dependencies } = {}) {
    const origin = new URL(config.publicOrigin);
    if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password
        || !Array.isArray(endpointPool) || endpointPool.length !== 10
        || endpointPool.some(slot => !/^slot-(?:0[1-9]|10)$/.test(slot.slot_id ?? '')
          || ROLES.some(role => !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(slot.endpointUsernames?.[role] ?? '')))
        || new Set(endpointPool.map(slot => slot.slot_id)).size !== 10
        || new Set(endpointPool.flatMap(slot => ROLES.map(role => slot.endpointUsernames[role]))).size !== 30
        || typeof reserveRoom !== 'function' || typeof releaseRoom !== 'function' || typeof record !== 'function') {
      throw new Error('invalid_permanent_host_config');
    }
    this.config = config; this.origin = origin.origin; this.reserve = reserveRoom; this.release = releaseRoom; this.reconcile = reconcileRoom;
    this.record = record; this.now = now; this.validateSignature = validateSignature; this.dependencies = dependencies;
    this.slots = endpointPool.map(slot => ({ ...slot, entry: null }));
    this.rooms = new Map(); this.calls = new Map(); this.nonces = new Map(); this.admissions = new WeakMap(); this.stopping = false; this.paused = false;
  }

  entry(roomId, scope) {
    if (!scopeValid(scope) || !ROOM.test(roomId ?? '')) throw new Error('invalid_room_binding');
    const entry = this.rooms.get(roomId);
    if (!entry || entry.scope.project !== scope.project || entry.scope.owner !== scope.owner) throw new Error('room_not_found');
    return entry;
  }

  async reclaim() {
    for (const slot of this.slots) {
      const entry = slot.entry;
      if (!entry?.binding || !entry.child || entry.child.room?.state !== 'closed'
          || this.now() < Math.max(entry.binding.leaseUntil, (entry.closedAt ?? 0) + 30_000)) continue;
      if (!entry.releasing) entry.releasing = Promise.resolve().then(() => entry.lease && entry.child.room.cleanup === 'calls_terminal_verified'
        ? this.release({ ...entry.binding, lease: entry.lease }) : this.reconcile(entry.binding)).then(() => {
        if (slot.entry !== entry) throw new Error('permanent_slot_binding_changed');
        for (const [callId, owner] of this.calls) if (owner === entry) this.calls.delete(callId);
        this.rooms.delete(entry.binding.roomId); slot.entry = null;
      }).catch(() => { entry.releasing = null; }); // Quarantine this slot; healthy rooms retain their own capacity.
      await entry.releasing;
    }
  }

  async create(input, scope, attempted = new Set()) {
    if (!scopeValid(scope)) throw new Error('invalid_room_binding');
    if (this.stopping || this.paused) throw new Error('host_draining');
    await this.reclaim();
    if (this.stopping || this.paused) throw new Error('host_draining');
    const slot = this.slots.find(value => value.entry === null && !attempted.has(value.slot_id));
    if (!slot) throw new Error('rooms_at_capacity');
    attempted.add(slot.slot_id);
    // Reserve locally before the first await; durable reserve is mandatory before grants escape.
    const entry = { scope: Object.freeze({ ...scope }), child: null, lease: null, binding: null, closedAt: null };
    slot.entry = entry;
    try {
      const child = new TranslationHost({ ...this.config, endpointUsernames: slot.endpointUsernames }, {
        ...this.dependencies, now: this.now, validateSignature: this.validateSignature, maxRooms: 1,
        reserveRoom: async ({ id, expiresAt }) => {
          entry.binding = Object.freeze({ slotId: slot.slot_id, roomId: id, project: scope.project, owner: scope.owner,
            expiresAt, leaseUntil: expiresAt + 630_000 });
          this.rooms.set(id, entry);
          entry.lease = await this.reserve(entry.binding);
          if (entry.lease === undefined || entry.lease === null) throw new Error('permanent_slot_lease_required');
        },
        record: async event => {
          await this.record({ ...event, host_project_id: scope.project, host_owner_id: scope.owner, host_slot_id: slot.slot_id });
          if (event.event === 'host.room.closed' && event.cleanup === 'calls_terminal_verified') entry.closedAt = this.now();
        },
      });
      entry.child = child;
      const created = await child.create(input);
      if (this.stopping || this.paused || child.room.closing) { await child.finish('host_shutdown'); throw new Error('host_draining'); }
      return created;
    } catch (error) {
      if (error?.message === 'fleet_slot_busy' && !entry.lease) {
        if (entry.binding) this.rooms.delete(entry.binding.roomId);
        slot.entry = null;
        return this.create(input, scope, attempted);
      }
      // Ambiguous durable reservation is quarantined, never reused optimistically.
      if (!entry.binding) slot.entry = null;
      throw error;
    }
  }

  snapshot(roomId, scope) { return this.entry(roomId, scope).child.snapshot(); }
  capacity() {
    const entries = this.slots.flatMap(slot => slot.entry ? [slot.entry] : []);
    const active = entries.filter(entry => entry.child?.room?.state !== 'closed').length;
    return { available: !this.stopping && !this.paused, admissions_paused: this.paused || this.stopping,
      maximum_concurrent_rooms: 10, active_rooms: active, cooldown_rooms: entries.length - active };
  }
  pauseAdmissions(paused) {
    if (typeof paused !== 'boolean' || this.stopping) throw new Error('invalid_drain_state');
    this.paused = paused; return this.capacity();
  }
  mint(grant, roomId, scope) { return this.entry(roomId, scope).child.mint(grant); }
  finish(reason, roomId, scope) { return this.entry(roomId, scope).child.finish(reason); }
  commit(roomId, leg, scope) {
    const child = this.entry(roomId, scope).child;
    if (!['customer', 'agent'].includes(leg) || !child.room?.interpretation) throw new Error('input_not_ready');
    child.room.interpretation.commit(leg);
  }

  verify(method, path, form, signature, nonce) {
    for (const [value, until] of this.nonces) if (this.now() >= until) this.nonces.delete(value);
    if (typeof nonce !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(nonce) || this.nonces.has(nonce)
        || this.nonces.size >= 1000 || typeof signature !== 'string' || !signature.length || signature.length > 1024) {
      throw new Error('invalid_plivo_signature');
    }
    const url = method === 'GET' ? this.origin.replace('https:', 'http:') + path : this.origin + path;
    if (this.validateSignature(method, url, nonce, this.config.authToken, signature, form) !== true) throw new Error('invalid_plivo_signature');
    this.nonces.set(nonce, this.now() + 600_000);
  }

  async answer(form, signature, nonce) {
    this.verify('POST', '/plivo/voice', form, signature, nonce);
    const entry = [...this.rooms.values()].find(value => value.child.grants.has(form['X-PH-JoinGrant']));
    if (!entry || typeof form.CallUUID !== 'string' || !UUID.test(form.CallUUID) || this.calls.has(form.CallUUID)) throw new Error('invalid_call_binding');
    this.calls.set(form.CallUUID, entry);
    try { return await entry.child.answer(form, signature, nonce); }
    catch (error) {
      if (!Object.values(entry.child.room.endpoints).some(endpoint => endpoint.callId === form.CallUUID)) this.calls.delete(form.CallUUID);
      throw error;
    }
  }

  status(form, signature, nonce) {
    this.verify('POST', '/plivo/status', form, signature, nonce);
    const entry = this.calls.get(form.CallUUID);
    if (!entry) throw new Error('invalid_call_binding');
    return entry.child.status(form, signature, nonce);
  }

  admit(path, signature, nonce) {
    if (typeof path !== 'string' || path.length > 2048 || !path.startsWith('/plivo/media/')) return null;
    try { this.verify('GET', path, undefined, signature, nonce); } catch { return null; }
    const entry = [...this.rooms.values()].find(value => value.child.streams.has(path));
    const endpoint = entry?.child.admit(path, signature, nonce);
    if (endpoint) this.admissions.set(endpoint, entry);
    return endpoint ?? null;
  }

  attach(endpoint, socket) {
    const entry = endpoint && this.admissions.get(endpoint);
    if (endpoint) this.admissions.delete(endpoint);
    if (!entry || this.rooms.get(entry.binding.roomId) !== entry) { socket.close(1008, 'invalid_binding'); return; }
    entry.child.attach(endpoint, socket);
  }

  async finishAll(reason = 'host_closed') {
    this.stopping = true;
    await Promise.allSettled([...this.rooms.values()].map(entry => entry.child.finish(reason)));
  }
}
