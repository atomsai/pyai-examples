import { TranslationHost } from './host.mjs';

const validScope = scope => scope && ['project', 'owner'].every(key => typeof scope[key] === 'string' && /^[\w.-]{1,100}$/.test(scope[key]));
const validRoom = value => /^test-[0-9a-f-]{36}$/.test(value ?? '');

/** Bounded, isolated carrier acceptance pool. The durable reservation is never refunded.
 * One process owns the pool; a fresh operation prefix is required on every launch. */
export class MultiRoomTranslationHost {
  constructor(config, { reserveRoom, record, absoluteDeadline, roomLifetimeMs = 480_000, now = Date.now, ...dependencies } = {}) {
    if (!Number.isInteger(roomLifetimeMs) || roomLifetimeMs < 1000 || roomLifetimeMs > 480_000 || typeof reserveRoom !== 'function' || typeof record !== 'function' || !Number.isFinite(absoluteDeadline)
        || absoluteDeadline <= now() || absoluteDeadline > now() + 1_800_000) throw new Error('invalid_pool_config');
    this.config = config; this.reserve = reserveRoom; this.record = record; this.deadline = absoluteDeadline;
    this.roomLifetimeMs = roomLifetimeMs; this.now = now; this.dependencies = dependencies; this.rooms = new Map(); this.calls = new Map();
    this.admissions = new WeakMap(); this.created = 0; this.stopping = false;
  }
  entry(roomId, scope) {
    if (!validScope(scope) || !validRoom(roomId)) throw new Error('invalid_room_binding');
    const entry = this.rooms.get(roomId);
    if (!entry || entry.scope.project !== scope.project || entry.scope.owner !== scope.owner) throw new Error('room_not_found');
    return entry;
  }
  async create(input, scope) {
    if (!validScope(scope)) throw new Error('invalid_room_binding');
    if (this.stopping || this.now() >= this.deadline) throw new Error('host_draining');
    // Claim before awaiting persistence. Failed/ambiguous reservations remain charged.
    if (this.created >= 10) throw new Error('session_limit');
    const slotId = `slot-${String(++this.created).padStart(2, '0')}`;
    const entry = { scope: Object.freeze({ ...scope }), child: null };
    const child = new TranslationHost(this.config, {
      ...this.dependencies, now: this.now, maxRooms: 1, absoluteDeadline: this.deadline, roomLifetimeMs: this.roomLifetimeMs,
      reserveRoom: async ({ id, expiresAt }) => {
        entry.roomId = id; this.rooms.set(id, entry);
        await this.reserve({ slotId, roomId: id, expiresAt, project: scope.project, owner: scope.owner });
      },
      record: event => this.record({ ...event, host_project_id: scope.project, host_owner_id: scope.owner, host_slot_id: slotId }),
    });
    entry.child = child;
    const created = await child.create(input);
    if (this.stopping) { await child.finish('host_shutdown'); throw new Error('host_draining'); }
    return created;
  }
  capacity() {
    return { maximum_concurrent_rooms: 10, available: !this.stopping && this.now() < this.deadline,
      admitted_rooms: this.created, active_rooms: [...this.rooms.values()].filter(e => e.child.room.state !== 'closed').length };
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
