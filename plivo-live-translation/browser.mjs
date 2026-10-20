const status = document.querySelector('#status');
const join = document.querySelector('#join'), leave = document.querySelector('#leave');
const grant = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
let device, dialing = false, closing = false, connectionTimer;
join.disabled = !/^[a-f0-9]{48}$/.test(grant);
function close(message) {
  if (closing) return; closing = true;
  clearTimeout(connectionTimer);
  status.textContent = message; leave.disabled = true;
  try { device?.client.hangup(); device?.client.logout(); } catch { /* Already disconnected. */ }
}
join.onclick = async () => {
  join.disabled = true; status.textContent = 'Connecting…';
  try {
    const response = await fetch('/join', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant }), cache: 'no-store' });
    if (!response.ok) throw new Error('join_unavailable');
    const session = await response.json();
    document.querySelector('#role').textContent = `${session.role === 'replacement' ? 'Replacement agent' : session.role === 'agent' ? 'Agent' : 'Customer'} · private test`;
    device = new window.Plivo({ debug: 'OFF', permOnClick: true, enableTracking: false });
    leave.disabled = false;
    connectionTimer = setTimeout(() => { close('Connection timed out. Ask the operator for a fresh test link.'); }, 20_000);
    device.client.on('onLogin', () => {
      if (dialing || closing) return; dialing = true;
      if (device.client.call(session.destination, { 'X-PH-JoinGrant': grant }) === false) {
        close('Unable to start the call. Ask the operator to inspect the test record.');
      }
    });
    device.client.on('onLoginFailed', () => { close('Unable to register. Ask the operator for a fresh test link.'); });
    device.client.on('onCallAnswered', () => {
      if (closing) return;
      clearTimeout(connectionTimer);
      status.textContent = 'Connected. Wait for both participants, then speak naturally.'; leave.disabled = false;
    });
    device.client.on('onCallTerminated', () => { close('Call ended.'); });
    device.client.on('onCallFailed', () => { close('Call failed. Ask the operator to inspect the test record.'); });
    device.client.on('onMediaPermission', event => {
      if (event.status !== 'success') close('Microphone permission is required to join.');
    });
    if (device.client.loginWithAccessToken(session.token) === false) close('Unable to register. Ask the operator for a fresh test link.');
  } catch { close('Unable to join. Ask the operator for a fresh test link.'); }
};
leave.onclick = () => { close('Call ended.'); };
