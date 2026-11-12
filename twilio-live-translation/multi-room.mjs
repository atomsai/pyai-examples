import { TranslationHost } from './host.mjs';

const validScope = scope => scope && ['project', 'owner'].every(key => typeof scope[key] === 'string' && /^[\w.-]{1,100}$/.test(scope[key]));
const validRoom = value => /^test-[0-9a-f-]{36}$/.test(value ?? '');
const slotIds = Array.from({ length: 10 }, (_, i) => `slot-${String(i + 1).padStart(2, '0')}`);

/** An isolated pool. The permanent mode uses fenced slots across restarts. */
export class MultiRoomTranslationHost {
  constructor(config, { reserveRoom, releaseRoom, reconcileRoom, record, absoluteDeadline,
    roomLifetimeMs = 480_000, now = Date.now, ...dependencies } = {}) {
    const permanent = absoluteDeadline === Infinity;
    if (!Number.isInteger(roomLifetimeMs) || roomLifetimeMs < 1000 || roomLifetimeMs > 480_000 || typeof reserveRoom !== 'function' || typeof record !== 'function'
        || (!permanent && (!Number.isFinite(absoluteDeadline) || absoluteDeadline <= now() || absoluteDeadline > now() + 1_800_000))
        || (permanent && (typeof releaseRoom !== 'function' || typeof reconcileRoom !== 'function'))) throw new Error('invalid_pool_config');
    this.config = config; this.reserve = reserveRoom; this.record = record; this.deadline = absoluteDeadline;
    this.permanent = permanent; this.release = releaseRoom; this.reconcile = reconcileRoom; this.slots = new Map();
    this.roomLifetimeMs = roomLifetimeMs; this.now = now; this.dependencies = dependencies; this.rooms = new Map(); this.calls = new Map();
    this.admissions = new WeakMap(); this.created = 0; this.stopping = false; this.paused = false;
  }
  entry(roomId, scope) {
    if (!validScope(scope) || !validRoom(roomId)) throw new Error('invalid_room_binding');
    const entry = this.rooms.get(roomId);
    if (!entry || entry.scope.project !== scope.project || entry.scope.owner !== scope.owner) throw new Error('room_not_found');
    return entry;
  }
  async reclaim() {
    for (const [slotId, entry] of this.slots) {
      if (!entry.binding || entry.child.room?.state !== 'closed'
          || this.now() < Math.max(entry.binding.leaseUntil, (entry.closedAt ?? 0) + 30_000)) continue;
      entry.releasing ??= Promise.resolve().then(() => entry.lease && entry.child.room.cleanup === 'calls_terminal_verified'
        ? this.release({ ...entry.binding, lease: entry.lease }) : this.reconcile(entry.binding)).then(() => {
        if (this.slots.get(slotId) !== entry) throw new Error('permanent_slot_binding_changed');
        for (const [callId, owner] of this.calls) if (owner === entry) this.calls.delete(callId);
        this.rooms.delete(entry.roomId); this.slots.delete(slotId);
      }).catch(() => { entry.releasing = null; });
      await entry.releasing;
    }
  }
  async create(input, scope, attempted = new Set()) {
    if (!validScope(scope)) throw new Error('invalid_room_binding');
    if (this.config.customerBilling && input.billing_session?.project_id !== scope.project) throw new Error('invalid_billing_session');
    if (this.permanent) await this.reclaim();
    if (this.stopping || this.paused || this.now() >= this.deadline) throw new Error('host_draining');
    const slotId = this.permanent ? slotIds.find(slot => !this.slots.has(slot) && !attempted.has(slot)) : slotIds[this.created];
    if (!slotId) throw new Error(this.permanent ? 'rooms_at_capacity' : 'session_limit');
    const entry = { scope: Object.freeze({ ...scope }), child: null };
    if (!this.permanent) this.created++;
    const child = new TranslationHost(this.config, {
      ...this.dependencies, now: this.now, maxRooms: 1, absoluteDeadline: this.deadline, roomLifetimeMs: this.roomLifetimeMs,
      journalAdmission: this.permanent,
      reserveRoom: async ({ id, expiresAt }) => {
        entry.roomId = id; this.rooms.set(id, entry);
        const binding = { slotId, roomId: id, expiresAt, project: scope.project, owner: scope.owner };
        if (this.permanent) {
          entry.binding = Object.freeze({ ...binding, leaseUntil: expiresAt + 630_000 });
          entry.lease = await this.reserve(entry.binding);
          if (!entry.lease) throw new Error('permanent_slot_lease_required');
        } else await this.reserve(binding);
      },
      record: async event => {
        await this.record({ ...event, host_project_id: scope.project, host_owner_id: scope.owner, host_slot_id: slotId });
        if (this.permanent && event.event === 'host.room.closed') entry.closedAt = this.now();
      },
    });
    entry.child = child;
    if (this.permanent) { this.slots.set(slotId, entry); attempted.add(slotId); }
    try {
      const created = await child.create(input);
      if (this.stopping || this.paused) { await child.finish('host_shutdown'); throw new Error('host_draining'); }
      return created;
    } catch (error) {
      if (this.permanent && error?.message === 'fleet_slot_busy' && !entry.lease) {
        this.rooms.delete(entry.roomId); this.slots.delete(slotId);
        return this.create(input, scope, attempted);
      }
      if (this.permanent && !entry.binding) this.slots.delete(slotId);
      throw error;
    }
  }
  capacity() {
    return { maximum_concurrent_rooms: 10, available: !this.stopping && !this.paused && this.now() < this.deadline,
      admitted_rooms: this.created, active_rooms: [...this.rooms.values()].filter(e => e.child?.room?.state !== 'closed').length };
  }
  pauseAdmissions(paused) {
    if (typeof paused !== 'boolean' || this.stopping) throw new Error('invalid_drain_state');
    this.paused = paused;
    return this.capacity();
  }
  snapshot(roomId, scope) { return this.entry(roomId, scope).child.snapshot(); }
  mint(grant, roomId, scope) { return this.entry(roomId, scope).child.mint(grant); }
  finish(reason, roomId, scope) { return this.entry(roomId, scope).child.finish(reason); }
  commit(roomId, leg, scope) {
    const child = this.entry(roomId, scope).child;
    if (!['customer', 'agent'].includes(leg) || !child.room.interpretation) throw new Error('input_not_ready');
    child.room.interpretation.commit(leg);
  }
  async answer(form, signature) {
    const entry = [...this.rooms.values()].find(e => e.child.grants.has(form.JoinGrant));
    if (!entry || this.calls.has(form.CallSid)) throw new Error('invalid_call_binding');
    // Global binding precedes the await; two rooms cannot race to claim a CallSid.
    this.calls.set(form.CallSid, entry);
    try { return await entry.child.answer(form, signature); }
    catch (error) {
      if (!Object.values(entry.child.room.endpoints).some(e => e.callId === form.CallSid)) this.calls.delete(form.CallSid);
      throw error;
    }
  }
  admit(path, signature) {
    const entry = [...this.rooms.values()].find(e => e.child.streams.has(path));
    const endpoint = entry?.child.admit(path, signature);
    if (endpoint) this.admissions.set(endpoint, entry);
    return endpoint ?? null;
  }
  attach(endpoint, socket) {
    const entry = endpoint && this.admissions.get(endpoint);
    if (endpoint) this.admissions.delete(endpoint);
    if (!entry || this.rooms.get(entry.roomId) !== entry) { socket.close(1008, 'invalid_binding'); return; }
    entry.child.attach(endpoint, socket);
  }
  async finishAll(reason = 'host_shutdown') {
    this.stopping = true;
    await Promise.allSettled([...this.rooms.values()].map(entry => entry.child.finish(reason)));
  }
}
