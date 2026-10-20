/** Twelve immutable private tickets bound total preview use across restarts. */
export function createPreviewRoomBudget({ bucket, prefix, previewId, deadline, token, fetchImpl = fetch, now = Date.now }) {
  if (!/^[a-z0-9][a-z0-9._-]{2,62}$/.test(bucket) || !/^[\w/-]{1,160}$/.test(prefix)
      || !/^[a-z0-9-]{8,80}$/.test(previewId) || !Number.isFinite(deadline)) throw new Error('invalid_preview_budget');
  const retired = new Set();
  const name = slot => `${prefix}/preview-${previewId}/slot-${String(slot).padStart(2, '0')}.json`;
  return {
    retired(roomId) { retired.add(roomId); },
    async reserve({ id, expiresAt }) {
      if (!/^test-[0-9a-f-]{36}$/.test(id) || !(now() < expiresAt && expiresAt <= Math.min(deadline, now() + 480_000))) {
        throw new Error('preview_expired');
      }
      const headers = { Authorization: `Bearer ${await token()}` };
      const slots = await Promise.all(Array.from({ length: 12 }, async (_, slot) => {
        const response = await fetchImpl(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name(slot))}?alt=media`,
          { headers, signal: AbortSignal.timeout(1700), redirect: 'error' });
        if (response.status === 404) return null;
        if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 2048) throw new Error('preview_budget_read_failed');
        const text = await response.text();
        if (Buffer.byteLength(text) > 2048) throw new Error('preview_budget_read_failed');
        const value = JSON.parse(text);
        if (value.preview_id !== previewId || !/^test-[0-9a-f-]{36}$/.test(value.room_id)
            || !Number.isSafeInteger(value.expires_at) || value.expires_at > deadline) throw new Error('preview_budget_binding_failed');
        return value;
      }));
      if (slots.some(value => value && value.expires_at > now() && !retired.has(value.room_id))) throw new Error('preview_room_already_active');
      const slot = slots.findIndex(value => value === null);
      if (slot < 0) throw new Error('preview_session_limit');
      const response = await fetchImpl(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(name(slot))}`,
        { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(1700), redirect: 'error',
          body: JSON.stringify({ preview_id: previewId, room_id: id, expires_at: expiresAt, created_at: now() }) });
      // Every contender chooses the same first unused slot. A conflict is final;
      // never skip to another slot using a snapshot taken before that conflict.
      if (!response.ok) throw new Error('preview_budget_claim_failed');
    },
  };
}
