const status = document.querySelector('#status');
const join = document.querySelector('#join'), leave = document.querySelector('#leave');
const grant = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
let device, call;
join.disabled = !/^[A-Za-z0-9_-]{32}$/.test(grant);
join.onclick = async () => {
  join.disabled = true; status.textContent = 'Connecting…';
  try {
    const response = await fetch('/join', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant }), cache: 'no-store' });
    if (!response.ok) throw new Error('join_unavailable');
    const session = await response.json();
    document.querySelector('#role').textContent = `${session.role === 'replacement' ? 'Replacement agent' : session.role === 'agent' ? 'Agent' : 'Customer'} · private test`;
    device = new Twilio.Device(session.token, { closeProtection: true, logLevel: 0 });
    device.on('error', () => { status.textContent = 'Call failed. Ask the operator to inspect the test record.'; });
    call = await device.connect({ params: { JoinGrant: grant } });
    call.on('accept', () => { status.textContent = 'Connected. Wait for both participants, then speak naturally.'; });
    call.on('disconnect', () => { status.textContent = 'Call ended.'; leave.disabled = true; device.destroy(); });
    call.on('error', () => { status.textContent = 'Call interrupted. Ask the operator to inspect the test record.'; });
    leave.disabled = false;
  } catch { status.textContent = 'Unable to join. Ask the operator for a fresh test link.'; device?.destroy(); }
};
leave.onclick = () => { call?.disconnect(); device?.destroy(); leave.disabled = true; status.textContent = 'Call ended.'; };
