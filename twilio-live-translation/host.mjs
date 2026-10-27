import { InterpretationRecording, interpretationLanguagePair } from "@pyai/twilio";
import { randomBytes, randomUUID } from 'node:crypto';
import twilio from 'twilio';
import { InterpretationRoom, TwilioInterpretationTransport, TwilioStreamAdmission, connectStreamTwiML } from '@pyai/twilio';

const ROLES = ['customer', 'agent', 'replacement'];
const id = () => randomBytes(24).toString('base64url');

/** One isolated test conversation; no PSTN dialing or number-routing changes. */
export class TranslationHost {
  constructor(config, { record, Room = InterpretationRoom, Transport = TwilioInterpretationTransport,
    retire = async () => { throw new Error('carrier_cleanup_unavailable'); },
    limitCall = async () => { throw new Error('carrier_limit_unavailable'); }, now = Date.now,
    maxRooms = 2, absoluteDeadline = Infinity, roomLifetimeMs = 480_000, reserveRoom = async () => {} } = {}) {
    if (!/^AC[0-9a-f]{32}$/i.test(config.accountSid) || !/^AP[0-9a-f]{32}$/i.test(config.applicationSid)
        || !/^SK[0-9a-f]{32}$/i.test(config.apiKeySid) || !config.apiKeySecret || !config.authToken
        || !config.pyaiKey || typeof record !== 'function'
        || (config.identityPrefix !== undefined && !/^[0-9a-f]{20}$/.test(config.identityPrefix))) throw new Error('invalid_host_config');
    this.origin = new URL(config.publicOrigin);
    if (this.origin.protocol !== 'https:' || this.origin.pathname !== '/' || this.origin.search
        || this.origin.hash || this.origin.username || this.origin.password) throw new Error('invalid_public_origin');
    this.config = config; this.record = record; this.Room = Room; this.Transport = Transport;
    this.retire = retire; this.limitCall = limitCall; this.now = now; this.room = null; this.created = 0;
    if (!Number.isInteger(maxRooms) || maxRooms < 1 || maxRooms > 12 || typeof reserveRoom !== 'function'
        || !(absoluteDeadline > now()) || !Number.isInteger(roomLifetimeMs) || roomLifetimeMs < 1000 || roomLifetimeMs > 480_000) throw new Error('invalid_room_bound');
    this.maxRooms = maxRooms; this.roomLifetimeMs = roomLifetimeMs; this.absoluteDeadline = absoluteDeadline; this.reserveRoom = reserveRoom;
    this.grants = new Map(); this.streams = new Map();
    this.admission = new TwilioStreamAdmission(this.origin.href.replace('https:', 'wss:'), config.authToken, 3);
  }

  async create(input) {
    if (this.room && (this.room.state !== 'closed' || this.room.cleanup !== 'calls_terminal_verified')) throw new Error('room_already_exists');
    if (this.created >= this.maxRooms || this.now() >= this.absoluteDeadline) throw new Error('session_limit');
    const pair = interpretationLanguagePair(input.language, input.agentLanguage ?? 'en');
    if (!pair.customer.voices.includes(input.customerVoice) || !pair.agent.voices.includes(input.agentVoice) || !/^[\w.-]{1,80}$/.test(input.customerVoice ?? '')
        || !/^[\w.-]{1,80}$/.test(input.agentVoice ?? '')) throw new Error('invalid_room');
    const room = { id: `test-${randomUUID()}`, state: 'waiting', createdAt: this.now(),
      expiresAt: Math.min(this.now() + this.roomLifetimeMs, this.absoluteDeadline), endpoints: {}, events: [], retired: new Set(), sequence: 0,
      closing: false, cleanup: null, interpretation: null, retiring: new Map() };
    if (input.recording) room.recording = new InterpretationRecording(input.recording, room.id, this.now);
    this.room = room; this.created++;
    room.timer = setTimeout(() => { void this.finish('lifetime_limit', room); }, room.expiresAt - this.now());
    const grants = {};
    try {
      await this.reserveRoom({ id: room.id, expiresAt: room.expiresAt });
      await this.journal({ event: 'host.room.created', language: pair.customer.code, agent_language: pair.agent.code }, room);
      if (this.room !== room || room.closing) throw new Error('room_closed');
      for (const role of ROLES) {
        const grant = id();
        const endpoint = { role, grant, identity: `pyai_test_${this.config.identityPrefix ? this.config.identityPrefix + '_' : ''}${randomBytes(12).toString('hex')}`,
          participant: { participant_id: `${room.id}-${role}`, language: role === 'customer' ? pair.customer.code : pair.agent.code,
            voice: role === 'customer' ? input.customerVoice : input.agentVoice },
          minted: false, callId: '', transport: null, limitReady: null };
        room.endpoints[role] = endpoint; this.grants.set(grant, endpoint);
        grants[role] = `${this.origin.origin}/#${grant}`;
      }
      return { id: room.id,languages:[pair.customer.code,pair.agent.code], ...(room.recording ? {recording_id:input.recording.id} : {}), expires_at: new Date(room.expiresAt).toISOString(), links: grants };
    } catch (error) { await this.finish('journal_failed', room); throw error; }
  }

  mint(grant) {
    const endpoint = this.grants.get(grant), room = this.room;
    if (!room || room.closing || this.now() >= room.expiresAt || !endpoint || endpoint.minted) throw new Error('invalid_join_grant');
    endpoint.minted = true;
    const token = new twilio.jwt.AccessToken(this.config.accountSid, this.config.apiKeySid, this.config.apiKeySecret,
      { identity: endpoint.identity, ttl: 600 });
    token.addGrant(new twilio.jwt.AccessToken.VoiceGrant({ outgoingApplicationSid: this.config.applicationSid,
      incomingAllow: false }));
    return { token: token.toJwt(), role: endpoint.role, expires_at: new Date(room.expiresAt).toISOString() };
  }

  /** Validate the exact configured public URL, never Host/X-Forwarded-Host. */
  async answer(form, signature) {
    if (!twilio.validateRequest(this.config.authToken, signature, `${this.origin.origin}/twilio/voice`, form)) {
      throw new Error('invalid_twilio_signature');
    }
    const endpoint = this.grants.get(form.JoinGrant), room = this.room;
    if (!room || room.closing || this.now() >= room.expiresAt || !endpoint || !endpoint.minted || endpoint.callId
        || form.AccountSid !== this.config.accountSid || form.From !== `client:${endpoint.identity}`
        || !/^CA[0-9a-f]{32}$/i.test(form.CallSid)
        || Object.values(room.endpoints).some(value => value.callId === form.CallSid)
        || (endpoint.role === 'replacement' && room.state !== 'connected')) throw new Error('invalid_call_binding');
    endpoint.callId = form.CallSid;
    this.grants.delete(endpoint.grant);
    const issued = this.admission.issue({ accountSid: this.config.accountSid, callSid: endpoint.callId,
      participantId: endpoint.participant.participant_id, externalCallId: room.id }, 30_000);
    const path = new URL(issued.url).pathname;
    const timer = setTimeout(() => { void this.finish('stream_admission_timeout', room); }, 30_000);
    this.streams.set(path, { endpoint, issued, timer, room });
    return connectStreamTwiML(issued.url);
  }

  admit(path, signature) {
    const item = this.streams.get(path);
    if (!item || !this.room || item.room !== this.room || this.room.closing) return null;
    const binding = item.issued.consume(`wss://${this.origin.host}${path}`, signature);
    if (!binding) return null;
    clearTimeout(item.timer); this.streams.delete(path);
    return item.endpoint;
  }

  attach(endpoint, socket) {
    const room = this.room;
    if (!room || room.closing || endpoint.transport || !Object.values(room.endpoints).includes(endpoint)) {
      socket.close(1008, 'invalid_binding'); return;
    }
    const transport = new this.Transport(socket, endpoint.callId, endpoint.participant.participant_id, this.config.accountSid);
    endpoint.transport = transport;
    transport.onFailure = () => { void this.finish('transport_failed', room); };
    // The answer webhook can run while Twilio still reports ringing. Updating
    // timeLimit requires an active call, established by its media start frame.
    endpoint.limitReady = transport.ready.then(async () => {
      if (room.closing) return transport.close();
      const seconds = Math.floor((room.expiresAt - this.now()) / 1000);
      if (seconds < 1) { await this.finish('lifetime_limit', room); return; }
      try { await this.limitCall(endpoint.callId, Math.min(seconds, 480)); }
      catch (error) {
        // Twilio's error message can contain request/credential information.
        // Retain only bounded numeric diagnostics before failing closed.
        const code = Number.isSafeInteger(error?.code) && error.code >= 0 && error.code <= 99_999_999 ? error.code : null;
        const status = Number.isSafeInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : null;
        try { await this.journal({ event: 'host.call.limit.failed', role: endpoint.role, provider_call_id: endpoint.callId,
          twilio_error_code: code, twilio_http_status: status }, room); }
        finally { await this.finish('carrier_limit_failed', room); }
        throw new Error('carrier_limit_failed');
      }
    });
    void endpoint.limitReady.then(async () => {
      if (room.closing) return transport.close();
      await this.journal({ event: 'host.call.connected', role: endpoint.role, provider_call_id: endpoint.callId }, room);
      if (endpoint.role === 'replacement') {
        if (!room.interpretation || room.state !== 'connected') throw new Error('transfer_not_ready');
        room.state = 'transferring';
        await room.interpretation.replaceAgent(endpoint.participant, transport);
        room.state = 'connected';
        await this.journal({ event: 'host.transfer.completed', provider_call_id: endpoint.callId,
          transports: this.transportDiagnostics(room) }, room);
      } else if (!room.interpretation && room.endpoints.customer.transport && room.endpoints.agent.transport) {
        // Both start callbacks can wake together. Neither may create the
        // interpreter until both active calls have their carrier limit applied.
        await Promise.all(['customer', 'agent'].map(role => room.endpoints[role].limitReady));
        // Both callbacks can wake on the same readiness promise; create exactly one interpreter.
        if (room.interpretation || room.closing) return;
        room.state = 'connecting';
        room.interpretation = new this.Room({ apiKey: this.config.pyaiKey, externalCallId: room.id,
          lifetimeMs: Math.max(1000, room.expiresAt - this.now()),
          legs: Object.fromEntries(['customer', 'agent'].map(role => [role,
            { participant: room.endpoints[role].participant, transport: room.endpoints[role].transport }])),
          record: async event => {
            if (this.room !== room || room.closing) return;
            await this.journal(event, room);
            if (!room.closing && event.event === 'session.started') room.state = 'connected';
          },
          retireCall: async callId => { await this.retireOnce(callId, room); },
          observeAudio: (kind, leg, pcm) => room.recording?.capture(kind, leg, pcm),
          onClose: reason => { void this.finish(reason, room); } });
      }
    }).catch(() => { void this.finish('call_setup_failed', room); });
  }

  async journal(event, room = this.room) {
    if (!room) throw new Error('room_unavailable');
    // Source, target, gate, delivery and transfer records persist; no PCM or per-chunk write on the audio path.
    if (event.event === 'audio.chunk') return;
    const { audio, ...metadata } = event;
    const entry = { ...metadata, host_room_id: room.id, host_sequence: ++room.sequence, recorded_at: new Date(this.now()).toISOString() };
    if (room.sequence > 2000 || Buffer.byteLength(JSON.stringify(entry)) > 65536) throw new Error('journal_limit');
    // Storage writes may finish out of order. Keep them concurrent, but expose
    // only the acknowledged sequence prefix to snapshots and recording metadata.
    const persisted = Promise.resolve().then(() => this.record(entry));
    const published = Promise.all([room.journalTail ?? Promise.resolve(), persisted]).then(() => {
      room.recording?.event(entry); room.events.push(entry);
    });
    room.journalTail = published;
    await published;
  }

  async retireOnce(callId, room = this.room) {
    if (!room || !Object.values(room.endpoints).some(endpoint => endpoint.callId === callId)) throw new Error('invalid_retired_call');
    if (room.retired.has(callId)) return;
    if (!room.retiring.has(callId)) {
      const promise = Promise.resolve().then(() => this.retire(callId)).then(() => { room.retired.add(callId); });
      room.retiring.set(callId, promise);
    }
    await room.retiring.get(callId);
  }

  snapshot() {
    const room = this.room;
    if (!room) return { state: 'empty' };
    return { id: room.id, state: room.state, cleanup: room.cleanup, expires_at: new Date(room.expiresAt).toISOString(),
      events: room.events, endpoints: Object.fromEntries(Object.entries(room.endpoints).map(([role, endpoint]) =>
        [role, { connected: !!endpoint.transport, provider_call_id: endpoint.callId || null,
          transport: endpoint.transport?.diagnostics ?? null }])) };
  }

  transportDiagnostics(room = this.room) {
    return Object.fromEntries(Object.entries(room.endpoints).map(([role, endpoint]) =>
      [role, { provider_call_id: endpoint.callId || null, ...(endpoint.transport?.diagnostics ?? {}) }]));
  }

  finish(reason = 'host_closed', room = this.room) {
    if (!room || room !== this.room) return Promise.resolve();
    if (room.finishing) return room.finishing;
    room.closing = true; room.state = 'closing'; clearTimeout(room.timer); this.grants.clear();
    for (const item of this.streams.values()) clearTimeout(item.timer);
    this.streams.clear();
    // Schedule cleanup after installing the promise: Room.close synchronously invokes onClose.
    room.finishing = Promise.resolve().then(async () => {
      room.interpretation?.close(reason);
      for (const endpoint of Object.values(room.endpoints)) endpoint.transport?.close();
      const results = await Promise.allSettled(Object.values(room.endpoints)
        .filter(endpoint => endpoint.callId).map(endpoint => this.retireOnce(endpoint.callId, room)));
      room.cleanup = results.every(result => result.status === 'fulfilled') ? 'calls_terminal_verified' : 'needs_reconciliation';
      try { await this.journal({ event: 'host.room.closed', reason, cleanup: room.cleanup, transports: this.transportDiagnostics(room) }, room); }
      catch { room.cleanup = 'journal_failed'; }
      if (room.recording) {
        room.recordingStatus = 'saving';
        try { await room.recording.finish(); room.recordingStatus = 'ready'; }
        catch { room.recordingStatus = 'incomplete'; }
      }
      room.state = 'closed';
    });
    return room.finishing;
  }
}
