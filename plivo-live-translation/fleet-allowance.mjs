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
      // The finite retained ledger can contain 249 charged rooms; keep reads bounded.
      const readJson = response => budget.json(response, 32 * 1024);
      const name = `${prefix}/fleet-${serviceId}/allowance-${month}.json`;
      const objectUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}`;
      let lastStatus;
      for (let attempt = 0; attempt < 12; attempt++) {
        budget.assertTime();
        try {
          const metadata = await request(objectUrl);
          let generation = '0', rooms = [], qualification, monthlyLimit = 75, recordingDailyBonus = 0;
          if (metadata.status !== 404) {
            const fields = await readJson(metadata);
            if (!fields || typeof fields !== 'object') throw new Error('fleet_allowance_unavailable');
            generation = fields.generation;
            if (!/^[1-9][0-9]{0,30}$/.test(generation ?? '')) throw new Error('fleet_allowance_unavailable');
            const value = await readJson(await request(objectUrl + `?alt=media&generation=${generation}`));
            if (!value || typeof value !== 'object' || value.schema !== 'pyai-carrier-allowance-v1' || value.service_id !== serviceId || value.month !== month
                || !Array.isArray(value.rooms) || value.rooms.length > 249 || value.rooms.some(room =>
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
                || ![10, 20, 30, 40, 50, 60].includes(qualification.extra_rooms) || qualification.reason !== 'final_carrier_qualification')) {
              throw new Error('fleet_allowance_unavailable');
            }
            const finalOctober = month === '2026-10' && qualification?.date === '2026-10-22'
              && qualification.extra_rooms === 60 && qualification.extra_monthly_rooms === 10;
            if (qualification && (qualification.extra_rooms === 60 || qualification.extra_monthly_rooms !== undefined)
                && !finalOctober) throw new Error('fleet_allowance_unavailable');
            if (qualification?.completion_rooms !== undefined
                && (!finalOctober || ![12, 24, 36, 48, 60, 72].includes(qualification.completion_rooms))) throw new Error('fleet_allowance_unavailable');
            const sustainedCompletion = finalOctober && [36, 48, 60, 72].includes(qualification.completion_rooms)
              && qualification.completion_date === '2026-10-23';
            if (qualification && (([36, 48, 60, 72].includes(qualification.completion_rooms) && !sustainedCompletion)
                || (qualification.completion_date !== undefined && !sustainedCompletion)
                || (sustainedCompletion && date < qualification.completion_date))) throw new Error('fleet_allowance_unavailable');
            const verification = finalOctober && qualification.completion_rooms === 72
              && qualification.completion_date === '2026-10-23' && [12, 22, 32, 46, 56].includes(qualification.verification_rooms)
              && qualification.verification_date === '2026-10-24';
            if (qualification && (qualification.verification_rooms !== undefined || qualification.verification_date !== undefined)
                && (!verification || date < qualification.verification_date)) throw new Error('fleet_allowance_unavailable');
            // Reuse the existing monthly ceiling; finite Oct24 slots move forward without refunding prior tests.
            if (qualification?.verification_daily_rooms !== undefined
                && (!verification || qualification.verification_daily_rooms !== (qualification.verification_rooms === 56 ? 62 : qualification.verification_rooms === 46 ? 52 : qualification.verification_rooms === 32 ? 37 : qualification.verification_rooms === 22 ? 27 : 17))) throw new Error('fleet_allowance_unavailable');
            const recordingQualification = verification && qualification.verification_rooms === 56
              && [11, 36].includes(qualification.recording_rooms) && qualification.recording_date === '2026-10-26';
            if (qualification && (qualification.recording_rooms !== undefined || qualification.recording_date !== undefined)
                && (!recordingQualification || date < qualification.recording_date)) throw new Error('fleet_allowance_unavailable');
            if (qualification?.recording_retry_date !== undefined
                && (!recordingQualification || qualification.recording_rooms !== 36
                    || qualification.recording_retry_date !== '2026-10-27')) throw new Error('fleet_allowance_unavailable');
            const recordingDay = qualification?.recording_retry_date ?? qualification?.recording_date;
            recordingDailyBonus = recordingQualification && qualification.recording_rooms === 36 && recordingDay === date ? 25 : 0;
            monthlyLimit = finalOctober && date >= qualification.date ? 85 + (qualification.completion_rooms ?? 0)
              + (verification ? qualification.verification_rooms : 0) + (recordingQualification ? qualification.recording_rooms : 0) : 75;
            if (rooms.length > monthlyLimit) throw new Error('fleet_allowance_unavailable');
          }
          if (rooms.some(room => room.id === roomId)) return;
          // Explicitly provisioned qualification reservations remain charged.
          // Dated qualification capacity also keeps team rooms available after testing.
          // Ordinary limits apply next month.
          const dailyLimit = 15 + (qualification?.date === date
            ? qualification.extra_rooms + Math.min(qualification.completion_rooms ?? 0, 24) : 0)
            + ([36, 48, 60, 72].includes(qualification?.completion_rooms) && qualification.completion_date === date ? qualification.completion_rooms - 24 : 0)
            + ([12, 22, 32, 46, 56].includes(qualification?.verification_rooms) && qualification.verification_date === date ? qualification.verification_daily_rooms ?? 12 : 0)
            + recordingDailyBonus;
          if (rooms.length >= monthlyLimit || rooms.filter(room => room.date === date).length >= dailyLimit) throw new Error('test_allowance_exhausted');
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
