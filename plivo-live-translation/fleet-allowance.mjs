import { createStorageBudget, isTransientStorageError } from './storage-retry.mjs';

/** Internal tester reserves a full eight minutes at admission; no retail debit. */
export function createFleetAllowance({ bucket, prefix, serviceId, token, fetchImpl = fetch, now = Date.now, sleep }) {
  if (!/^[a-z0-9][a-z0-9._-]{2,62}$/.test(bucket ?? '') || !/^[\w/-]{1,160}$/.test(prefix ?? '')
      || prefix.includes('..') || !/^[a-z0-9-]{8,80}$/.test(serviceId ?? '') || typeof token !== 'function') {
    throw new Error('invalid_fleet_allowance_config');
  }
  return {
    async reserve(roomId, options = {}) {
      if (!/^test-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(roomId ?? '')) throw new Error('invalid_allowance_room');
      const budget = createStorageBudget({ now, sleep, deadline: options.deadline, errorCode: 'fleet_allowance_unavailable' });
      const date = new Date(now()).toISOString().slice(0, 10), month = date.slice(0, 7);
      const request = (url, init) => budget.request(fetchImpl, token, url, init);
      const readJson = response => budget.json(response);
      const name = `${prefix}/fleet-${serviceId}/allowance-${month}.json`;
      const objectUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}`;
      let lastStatus;
      for (let attempt = 0; attempt < 12; attempt++) {
        budget.assertTime();
        try {
          const metadata = await request(objectUrl);
          let generation = '0', rooms = [], qualification;
          if (metadata.status !== 404) {
            const fields = await readJson(metadata);
            if (!fields || typeof fields !== 'object') throw new Error('fleet_allowance_unavailable');
            generation = fields.generation;
            if (!/^[1-9][0-9]{0,30}$/.test(generation ?? '')) throw new Error('fleet_allowance_unavailable');
            const value = await readJson(await request(objectUrl + `?alt=media&generation=${generation}`));
            if (!value || typeof value !== 'object' || value.schema !== 'pyai-carrier-allowance-v1' || value.service_id !== serviceId || value.month !== month
                || !Array.isArray(value.rooms) || value.rooms.length > 75 || value.rooms.some(room =>
                  !room || typeof room !== 'object' || !/^test-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(room.id ?? '')
                  || !/^\d{4}-\d{2}-\d{2}$/.test(room.date ?? '') || room.date.slice(0, 7) !== month
                  || !Number.isFinite(Date.parse(room.date)) || new Date(Date.parse(room.date)).toISOString().slice(0, 10) !== room.date)
                || new Set(value.rooms.map(room => room.id)).size !== value.rooms.length) throw new Error('fleet_allowance_unavailable');
            rooms = value.rooms;
            qualification = value.qualification;
            if (qualification !== undefined && (!qualification || typeof qualification !== 'object'
                || typeof qualification.date !== 'string' || qualification.date.slice(0, 7) !== month
                || !/^\d{4}-\d{2}-\d{2}$/.test(qualification.date)
                || !Number.isFinite(Date.parse(qualification.date))
                || new Date(Date.parse(qualification.date)).toISOString().slice(0, 10) !== qualification.date
                || ![10, 20, 30, 40].includes(qualification.extra_rooms) || qualification.reason !== 'final_carrier_qualification')) {
              throw new Error('fleet_allowance_unavailable');
            }
          }
          if (rooms.some(room => room.id === roomId)) return;
          // A trusted storage operator may admit at most four dated qualification blocks.
          // Every room still consumes the unchanged 75-room monthly budget;
          // existing attempts are never removed or reclassified.
          const dailyLimit = 15 + (qualification?.date === date ? qualification.extra_rooms : 0);
          if (rooms.length >= 75 || rooms.filter(room => room.date === date).length >= dailyLimit) throw new Error('test_allowance_exhausted');
          const response = await request(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&ifGenerationMatch=${generation}&name=${encodeURIComponent(name)}`,
            { method: 'POST', body: JSON.stringify({ schema: 'pyai-carrier-allowance-v1', service_id: serviceId, month,
              rooms: [...rooms, { id: roomId, date }], ...(qualification ? { qualification } : {}) }) });
          if (response.status === 412) continue; // Re-read the winning generation before another attempt.
          const stored = await readJson(response);
          if (!stored || typeof stored !== 'object' || !/^[1-9][0-9]{0,30}$/.test(stored.generation ?? '')) throw new Error('fleet_allowance_unavailable');
          return;
        } catch (error) {
          if (!isTransientStorageError(error)) throw error;
          if (Number.isInteger(error.status)) lastStatus = error.status;
          if (attempt === 11) break;
          try { await budget.backoff(attempt); }
          catch (ended) { if (lastStatus !== undefined) ended.status = lastStatus; throw ended; }
          // Strongly re-read the current generation and room identity after
          // every transient outcome, including an ambiguously committed CAS.
        }
      }
      throw Object.assign(new Error('fleet_allowance_busy'), lastStatus === undefined ? {} : { status: lastStatus });
    },
  };
}
