import { randomBytes, randomUUID } from 'node:crypto';
import plivo from 'plivo';
import { InterpretationRoom, PlivoInterpretationTransport, PlivoStreamAdmission } from '@pyai/twilio';

const ROLES = ['customer', 'agent', 'replacement'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSPORT_FAILURES = new Set(['provider_start_timeout', 'provider_contract_failed', 'provider_socket_error',
  'provider_socket_closed', 'provider_start_binding_failed', 'provider_stopped', 'provider_playback_timeout',
  'provider_send_failed', 'provider_clear_timeout']);
const RETIREMENT_FAILURES = new Set(['carrier_hangup_failed', 'carrier_status_failed', 'call_not_terminal']);
const escapeXml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sameEndpoint = (address, username) => [username + '@phone.plivo.com', 'sip:' + username + '@phone.plivo.com'].includes(address);
// A non-E.164 marker reaches the JWT-selected outgoing application; it is not
// a request to dial the application's public inbound SIP URI.
const sameApplication = (address, applicationId) => [applicationId, `${applicationId}@phone.plivo.com`, `sip:${applicationId}@phone.plivo.com`].includes(address);
// Browser SDK 2.2.21 registers JWT calls as `${sub}_${iss}`. The signed callback
// may represent the endpoint as a user or SIP URI; each accepted value still
// names this exact server-owned endpoint and account.
const sameSource = (address, username, authId) => [username, `${username}_${authId}`]
  .some(identity => address === identity || sameEndpoint(address, identity));

/** One isolated browser-endpoint conversation. No PSTN origination or number routing. */
export class TranslationHost {
  constructor(config, { record, Room = InterpretationRoom, Transport = PlivoInterpretationTransport,
    validateSignature = plivo.validateV3Signature,
    mintToken = async () => { throw new Error('carrier_token_unavailable'); },
    retire = async () => { throw new Error('carrier_cleanup_unavailable'); }, now = Date.now,
    maxRooms = 2, absoluteDeadline = Infinity, reserveRoom = async () => {} } = {}) {
    if (typeof config.authId !== 'string' || !/^[A-Za-z][A-Za-z0-9]{5,63}$/.test(config.authId)
        || typeof config.applicationId !== 'string' || !/^\d{16,32}$/.test(config.applicationId)
        || !config.authToken || !config.pyaiKey || typeof record !== 'function'
        || ROLES.some(role => !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(config.endpointUsernames?.[role] ?? ''))
        || new Set(ROLES.map(role => config.endpointUsernames[role])).size !== 3) throw new Error('invalid_host_config');
    this.origin = new URL(config.publicOrigin);
    if (this.origin.protocol !== 'https:' || this.origin.pathname !== '/' || this.origin.search
        || this.origin.hash || this.origin.username || this.origin.password) throw new Error('invalid_public_origin');
    this.config = config; this.record = record; this.Room = Room; this.Transport = Transport;
    this.mintToken = mintToken; this.retire = retire; this.now = now; this.validateSignature = validateSignature;
    if (!Number.isInteger(maxRooms) || maxRooms < 1 || maxRooms > 12 || typeof reserveRoom !== 'function') throw new Error('invalid_room_bound');
    this.maxRooms = maxRooms; this.absoluteDeadline = absoluteDeadline; this.reserveRoom = reserveRoom;
    this.room = null; this.created = 0; this.grants = new Map(); this.streams = new Map(); this.webhookNonces = new Map();
    this.consumedAdmissions = new WeakMap();
    this.admission = new PlivoStreamAdmission(this.origin.href.replace('https:', 'wss:'), config.authToken,
      (...args) => validateSignature(...args) === true, 3, now, { signatureProtocol: 'http' });
  }

  async create(input) {
    if (this.room && (this.room.state !== 'closed' || this.room.cleanup !== 'calls_terminal_verified')) throw new Error('room_already_exists');
    if (this.created >= this.maxRooms || this.now() >= this.absoluteDeadline) throw new Error('session_limit');
    if (!['hi', 'pa'].includes(input.language) || !/^[\w.-]{1,80}$/.test(input.customerVoice ?? '')
        || !/^[\w.-]{1,80}$/.test(input.agentVoice ?? '')) throw new Error('invalid_room');
    const room = { id: `test-${randomUUID()}`, state: 'waiting', createdAt: this.now(),
      expiresAt: Math.min(this.now() + 480_000, this.absoluteDeadline), endpoints: {}, events: [], retired: new Set(), sequence: 0,
      closing: false, cleanup: null, interpretation: null, retiring: new Map(), completed: new Set(), terminalWaiters: new Map() };
    this.room = room; this.created++;
    room.timer = setTimeout(() => { void this.finish('lifetime_limit'); }, room.expiresAt - this.now());
    const links = {};
    try {
      await this.reserveRoom({ id: room.id, expiresAt: room.expiresAt });
      await this.journal({ event: 'host.room.created', language: input.language });
      for (const role of ROLES) {
        const grant = randomBytes(24).toString('hex');
        const endpoint = { role, grant, username: this.config.endpointUsernames[role],
          participant: { participant_id: `${room.id}-${role}`, language: role === 'customer' ? input.language : 'en',
            voice: role === 'customer' ? input.customerVoice : input.agentVoice },
          minted: false, tokenIssued: false, callId: '', streamUrl: '', transport: null, transportFailure: null,
          retirementProof: null, retirementFailure: null };
        room.endpoints[role] = endpoint; this.grants.set(grant, endpoint);
        links[role] = `${this.origin.origin}/#${grant}`;
      }
      return { id: room.id, expires_at: new Date(room.expiresAt).toISOString(), links };
    } catch (error) { await this.finish('journal_failed'); throw error; }
  }

  async mint(grant) {
    const endpoint = this.grants.get(grant), room = this.room;
    if (!room || room.closing || this.now() >= room.expiresAt || !endpoint || endpoint.minted
        || (endpoint.role === 'replacement' && room.state !== 'connected')) throw new Error('invalid_join_grant');
    endpoint.minted = true;
    try {
      const now = Math.floor(this.now() / 1000);
      const token = await this.mintToken({ iss: this.config.authId, sub: endpoint.username, nbf: now,
        exp: now + 600, app: this.config.applicationId, per: { voice: { incoming_allow: false, outgoing_allow: true } } });
      if (typeof token !== 'string' || !token.length || token.length > 16384 || room.closing) throw new Error('invalid_carrier_token');
      endpoint.tokenIssued = true;
      return { token, role: endpoint.role, destination: this.config.applicationId,
        expires_at: new Date(room.expiresAt).toISOString() };
    } catch (error) { await this.finish('token_mint_failed'); throw error; }
  }

  /** Exact configured answer URI, POST parameters and account signature; no proxy-host trust. */
  verifyWebhook(form, signature, nonce, path = '/plivo/voice') {
    for (const [value, expiresAt] of this.webhookNonces) if (this.now() >= expiresAt) this.webhookNonces.delete(value);
    if (!['/plivo/voice', '/plivo/status'].includes(path)
        || typeof nonce !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(nonce) || this.webhookNonces.has(nonce)
        || this.webhookNonces.size >= 100 || typeof signature !== 'string' || !signature.length || signature.length > 1024) {
      throw new Error('invalid_plivo_signature');
    }
    if (this.validateSignature('POST', `${this.origin.origin}${path}`, nonce,
      this.config.authToken, signature, form) !== true) throw new Error('invalid_plivo_signature');
    this.webhookNonces.set(nonce, this.now() + 600_000);
  }

  async answer(form, signature, nonce) {
    this.verifyWebhook(form, signature, nonce);
    const endpoint = this.grants.get(form['X-PH-JoinGrant']), room = this.room;
    if (!room || room.closing || this.now() >= room.expiresAt || !endpoint || !endpoint.tokenIssued || endpoint.callId
        || !sameSource(form.From, endpoint.username, this.config.authId) || !sameApplication(form.To, this.config.applicationId)
        || typeof form.CallUUID !== 'string' || !UUID.test(form.CallUUID)
        || (form.AuthId !== undefined && form.AuthId !== this.config.authId)
        || Object.values(room.endpoints).some(value => value.callId === form.CallUUID)
        || (endpoint.role === 'replacement' && room.state !== 'connected')) throw new Error('invalid_call_binding');
    endpoint.callId = form.CallUUID; this.grants.delete(endpoint.grant);
    try {
      await this.journal({ event: 'host.call.admitted', role: endpoint.role, provider_call_id: endpoint.callId });
      const expiresAt = Math.min(this.now() + 30_000, room.expiresAt, this.absoluteDeadline);
      const issued = this.admission.issue({ accountId: this.config.authId, callId: endpoint.callId,
        participantId: endpoint.participant.participant_id, externalCallId: room.id }, 30_000);
      endpoint.streamUrl = issued.url;
      const path = new URL(issued.url).pathname;
      const timer = setTimeout(() => { void this.finish('stream_admission_timeout'); }, 30_000);
      this.streams.set(path, { endpoint, issued, timer, room, expiresAt });
      const seconds = Math.max(1, Math.min(480, Math.floor((room.expiresAt - this.now()) / 1000)));
      // Scheduled Hangup runs while the exclusive Stream blocks subsequent XML.
      return `<Response><Hangup schedule="${seconds}"/><Stream bidirectional="true" keepCallAlive="true" audioTrack="inbound" contentType="audio/x-l16;rate=16000" streamTimeout="${seconds}">${escapeXml(issued.url)}</Stream><Hangup/></Response>`;
    } catch (error) { await this.finish('call_admission_failed'); throw error; }
  }

  async status(form, signature, nonce) {
    this.verifyWebhook(form, signature, nonce, '/plivo/status');
    const room = this.room;
    const endpoint = room && typeof form.CallUUID === 'string' && UUID.test(form.CallUUID)
      && Object.values(room.endpoints).find(value => value.callId === form.CallUUID);
    if (!endpoint || (form.AuthId !== undefined && form.AuthId !== this.config.authId)) throw new Error('invalid_call_binding');
    await this.journal({ event: 'host.call.status', role: endpoint.role, provider_call_id: endpoint.callId,
      status: String(form.CallStatus ?? '').slice(0, 80), hangup_cause: String(form.HangupCauseName ?? '').slice(0, 160) });
    if (form.CallStatus === 'completed') {
      // Only the verified exact-call callback, durably recorded above, can settle retirement.
      room.completed.add(endpoint.callId); room.terminalWaiters.get(endpoint.callId)?.();
    }
    if (form.CallStatus === 'completed' && !room.closing && !room.retired.has(endpoint.callId)
        && !room.retiring.has(endpoint.callId)) await this.finish('provider_call_completed');
  }

  admit(path, signature, nonce) {
    const item = this.streams.get(path), room = this.room;
    if (!item || !room || item.room !== room || room.closing || this.now() >= item.expiresAt
        || this.now() >= room.expiresAt || room.endpoints[item.endpoint.role] !== item.endpoint
        || item.endpoint.transport || item.endpoint.streamUrl !== item.issued.url
        || room.retired.has(item.endpoint.callId) || room.retiring.has(item.endpoint.callId)) return null;
    const binding = item.issued.consume(`wss://${this.origin.host}${path}`, signature, nonce);
    if (!binding) return null;
    clearTimeout(item.timer); this.streams.delete(path);
    const endpoint = item.endpoint;
    if (binding.accountId !== this.config.authId || binding.callId !== endpoint.callId
        || binding.participantId !== endpoint.participant.participant_id || binding.externalCallId !== room.id) return null;
    this.consumedAdmissions.set(endpoint, Object.freeze({ ...binding, endpoint, room, role: endpoint.role,
      streamUrl: item.issued.url, expiresAt: item.expiresAt }));
    return endpoint;
  }

  attach(endpoint, socket) {
    const room = this.room, proof = endpoint && this.consumedAdmissions.get(endpoint);
    if (endpoint) this.consumedAdmissions.delete(endpoint);
    const current = () => !!proof && this.room === room && proof.room === room && !room.closing
      && this.now() < proof.expiresAt && this.now() < room.expiresAt && this.now() < this.absoluteDeadline
      && proof.endpoint === endpoint && room.endpoints[proof.role] === endpoint
      && proof.accountId === this.config.authId && proof.callId === endpoint.callId
      && proof.participantId === endpoint.participant.participant_id && proof.externalCallId === room.id
      && proof.streamUrl === endpoint.streamUrl && !room.retired.has(proof.callId) && !room.retiring.has(proof.callId);
    if (!room || !current() || endpoint.transport) {
      socket.close(1008, 'invalid_binding'); return;
    }
    let transport;
    try {
      transport = new this.Transport(socket, proof.callId, proof.participantId, proof.accountId, {
        verifyStartBinding: binding => current() && endpoint.transport === transport && !!binding
          && binding.accountId === proof.accountId && binding.callId === proof.callId
          && binding.participantId === proof.participantId && typeof binding.streamId === 'string' && UUID.test(binding.streamId)
          && typeof binding.providerAccountId === 'string'
          && (binding.providerAccountId === proof.accountId || /^[0-9]{1,20}$/.test(binding.providerAccountId)),
      });
    } catch {
      endpoint.transportFailure = 'provider_transport_setup_failed'; socket.close(1008, 'transport_setup_failed');
      void this.finish('transport_failed'); return;
    }
    endpoint.transport = transport; transport.onFailure = reason => {
      if (this.room !== room || room.closing) return;
      endpoint.transportFailure = TRANSPORT_FAILURES.has(reason) ? reason : 'provider_transport_failed';
      void this.finish('transport_failed');
    };
    void transport.ready.then(async () => {
      if (room.closing) return transport.close();
      await this.journal({ event: 'host.call.connected', role: endpoint.role, provider_call_id: endpoint.callId });
      if (endpoint.role === 'replacement') {
        if (!room.interpretation || room.state !== 'connected') throw new Error('transfer_not_ready');
        room.state = 'transferring'; await room.interpretation.replaceAgent(endpoint.participant, transport);
        room.state = 'connected';
        await this.journal({ event: 'host.transfer.completed', provider_call_id: endpoint.callId,
          transports: this.transportDiagnostics() });
      } else if (!room.interpretation && room.endpoints.customer.transport && room.endpoints.agent.transport) {
        await Promise.all(['customer', 'agent'].map(role => room.endpoints[role].transport.ready));
        if (room.interpretation || room.closing) return;
        room.state = 'connecting';
        room.interpretation = new this.Room({ apiKey: this.config.pyaiKey, externalCallId: room.id,
          lifetimeMs: Math.max(1000, room.expiresAt - this.now()),
          legs: Object.fromEntries(['customer', 'agent'].map(role => [role,
            { participant: room.endpoints[role].participant, transport: room.endpoints[role].transport }])),
          record: async event => { await this.journal(event); if (event.event === 'session.started') room.state = 'connected'; },
          retireCall: async callId => { await this.retireOnce(callId); },
          onClose: reason => { void this.finish(reason); } });
      }
    }).catch(() => { void this.finish('call_setup_failed'); });
  }

  async journal(event) {
    const room = this.room;
    if (!room) throw new Error('room_unavailable');
    if (event.event === 'audio.chunk') return;
    const { audio, ...metadata } = event;
    const entry = { ...metadata, host_room_id: room.id, host_sequence: ++room.sequence, recorded_at: new Date(this.now()).toISOString() };
    if (room.events.length >= 2000 || Buffer.byteLength(JSON.stringify(entry)) > 65536) throw new Error('journal_limit');
    await this.record(entry); room.events.push(entry);
  }

  async retireOnce(callId) {
    const room = this.room;
    const endpoint = room && Object.values(room.endpoints).find(value => value.callId === callId);
    if (!UUID.test(callId) || !endpoint) throw new Error('invalid_retired_call');
    if (room.retired.has(callId)) return;
    if (!room.retiring.has(callId)) {
      let confirm;
      const completed = new Promise(resolve => { confirm = resolve; });
      // Register before retire() can issue DELETE and cause a synchronous callback.
      room.terminalWaiters.set(callId, confirm);
      if (room.completed.has(callId)) confirm();
      const pending = Promise.resolve().then(() => this.retire(callId, { completed })).then(proof => {
        endpoint.retirementProof = ['signed_completed', 'terminal_cdr'].includes(proof) ? proof : null;
        endpoint.retirementFailure = null; room.retired.add(callId);
      }).catch(error => {
        endpoint.retirementFailure = RETIREMENT_FAILURES.has(error?.message) ? error.message : 'carrier_retirement_failed';
        throw new Error(endpoint.retirementFailure);
      }).finally(() => {
        if (room.terminalWaiters.get(callId) === confirm) room.terminalWaiters.delete(callId);
        // A failed attempt must not prevent later cleanup from confirming the call.
        if (room.retiring.get(callId) === pending) room.retiring.delete(callId);
      });
      room.retiring.set(callId, pending);
    }
    await room.retiring.get(callId);
  }

  snapshot() {
    const room = this.room;
    if (!room) return { state: 'empty' };
    return { id: room.id, state: room.state, cleanup: room.cleanup, expires_at: new Date(room.expiresAt).toISOString(),
      events: room.events, endpoints: Object.fromEntries(Object.entries(room.endpoints).map(([role, endpoint]) =>
        [role, { connected: !!endpoint.transport, provider_call_id: endpoint.callId || null,
          retirement: { proof: endpoint.retirementProof, failure_code: endpoint.retirementFailure },
          transport: endpoint.transport ? { ...endpoint.transport.diagnostics, failure_code: endpoint.transportFailure } : null }])) };
  }

  transportDiagnostics() {
    return Object.fromEntries(Object.entries(this.room.endpoints).map(([role, endpoint]) =>
      [role, { provider_call_id: endpoint.callId || null, ...(endpoint.transport?.diagnostics ?? {}), failure_code: endpoint.transportFailure,
        retirement: { proof: endpoint.retirementProof, failure_code: endpoint.retirementFailure } }]));
  }

  finish(reason = 'host_closed') {
    const room = this.room;
    if (!room) return Promise.resolve();
    if (room.finishing) return room.finishing;
    room.closing = true; room.state = 'closing'; clearTimeout(room.timer); this.grants.clear();
    this.consumedAdmissions = new WeakMap();
    for (const item of this.streams.values()) clearTimeout(item.timer);
    this.streams.clear();
    room.finishing = Promise.resolve().then(async () => {
      room.interpretation?.close(reason);
      for (const endpoint of Object.values(room.endpoints)) endpoint.transport?.close();
      const results = await Promise.allSettled(Object.values(room.endpoints)
        .filter(endpoint => endpoint.callId).map(endpoint => this.retireOnce(endpoint.callId)));
      room.cleanup = results.every(result => result.status === 'fulfilled') ? 'calls_terminal_verified' : 'needs_reconciliation';
      room.state = 'closed';
      try { await this.journal({ event: 'host.room.closed', reason, cleanup: room.cleanup, transports: this.transportDiagnostics() }); }
      catch { room.cleanup = 'journal_failed'; }
    });
    return room.finishing;
  }
}
