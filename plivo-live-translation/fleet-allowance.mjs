/** Internal tester reserves a full eight minutes at admission; no retail debit. */
export function createFleetAllowance({ bucket, prefix, serviceId, token, fetchImpl = fetch, now = Date.now }) {
  if (!/^[a-z0-9][a-z0-9._-]{2,62}$/.test(bucket ?? '') || !/^[\w/-]{1,160}$/.test(prefix ?? '')
      || prefix.includes('..') || !/^[a-z0-9-]{8,80}$/.test(serviceId ?? '') || typeof token !== 'function') {
    throw new Error('invalid_fleet_allowance_config');
  }
  const readJson = async response => {
    if (!response.ok) throw new Error('fleet_allowance_unavailable');
    const reader = response.body?.getReader(); if (!reader) throw new Error('fleet_allowance_unavailable');
    let bytes = 0; const chunks = [];
    try { for (;;) { const part = await reader.read(); if (part.done) break;
      if ((bytes += part.value.length) > 8192) throw new Error('fleet_allowance_unavailable'); chunks.push(part.value); } }
    finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString());
  };
  async function request(url, init = {}) {
    return fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${await token()}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}) }, redirect: 'error', signal: AbortSignal.timeout(1500) });
  }
  return {
    async reserve(roomId) {
      if (!/^test-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(roomId ?? '')) throw new Error('invalid_allowance_room');
      const date = new Date(now()).toISOString().slice(0, 10), month = date.slice(0, 7);
      const name = `${prefix}/fleet-${serviceId}/allowance-${month}.json`;
      const objectUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}`;
      for (let attempt = 0; attempt < 12; attempt++) {
        const metadata = await request(objectUrl);
        let generation = '0', rooms = [];
        if (metadata.status !== 404) {
          generation = (await readJson(metadata)).generation;
          if (!/^[1-9][0-9]{0,30}$/.test(generation ?? '')) throw new Error('fleet_allowance_unavailable');
          const value = await readJson(await request(objectUrl + `?alt=media&generation=${generation}`));
          if (value.schema !== 'pyai-carrier-allowance-v1' || value.service_id !== serviceId || value.month !== month
              || !Array.isArray(value.rooms) || value.rooms.length > 75 || value.rooms.some(room =>
                !/^test-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(room.id ?? '')
                || !/^\d{4}-\d{2}-\d{2}$/.test(room.date ?? '') || room.date.slice(0, 7) !== month
                || !Number.isFinite(Date.parse(room.date)) || new Date(Date.parse(room.date)).toISOString().slice(0, 10) !== room.date)
              || new Set(value.rooms.map(room => room.id)).size !== value.rooms.length) throw new Error('fleet_allowance_unavailable');
          rooms = value.rooms;
        }
        if (rooms.some(room => room.id === roomId)) return;
        if (rooms.length >= 75 || rooms.filter(room => room.date === date).length >= 15) throw new Error('test_allowance_exhausted');
        const response = await request(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&ifGenerationMatch=${generation}&name=${encodeURIComponent(name)}`,
          { method: 'POST', body: JSON.stringify({ schema: 'pyai-carrier-allowance-v1', service_id: serviceId, month,
            rooms: [...rooms, { id: roomId, date }] }) });
        if (response.status === 412) continue; // Re-read the winning generation before another attempt.
        const stored = await readJson(response);
        if (!/^[1-9][0-9]{0,30}$/.test(stored.generation ?? '')) throw new Error('fleet_allowance_unavailable');
        return;
      }
      throw new Error('fleet_allowance_busy');
    },
  };
}
