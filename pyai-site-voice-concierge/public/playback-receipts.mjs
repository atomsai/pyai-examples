/** Player receipts are evidence of rendered chunks, never receipt/scheduling time. */
export class OmniPlaybackReceipts {
    enabled = false;
    epoch = 0;
    segment;
    reset() { this.enabled = false; this.flush(); }
    flush() { this.epoch++; this.segment = undefined; }
    control(frame) {
        if (frame.event === "configured")
            this.enabled = frame.playback_ack === true;
        if (frame.event === "audio_segment_start" && this.enabled) {
            if (typeof frame.reply_id !== "string" || !/^[a-f0-9]{32}$/.test(frame.reply_id)
                || typeof frame.segment_id !== "string" || !/^[1-9][0-9]{0,5}$/.test(frame.segment_id)
                || frame.sample_rate !== 24000) {
                this.flush();
                return;
            }
            this.segment = { reply: frame.reply_id, id: frame.segment_id, received: 0,
                confirmed: 0, epoch: this.epoch, chunks: new Map() };
        }
        else if (frame.event === "audio_segment_done"
            && frame.reply_id === this.segment?.reply && frame.segment_id === this.segment?.id) {
            this.segment = undefined;
        }
        else if (["flush", "barge_in", "reply_interrupted", "reply_failed"].includes(String(frame.event))) {
            this.flush();
        }
    }
    chunk(samples, send) {
        const segment = this.segment;
        if (!this.enabled || !segment || !Number.isSafeInteger(samples) || samples <= 0)
            return () => { };
        const start = segment.received;
        const chunk = { end: start + samples, played: false };
        segment.received = chunk.end;
        segment.chunks.set(start, chunk);
        return () => {
            if (chunk.played || segment.epoch !== this.epoch)
                return;
            chunk.played = true;
            const before = segment.confirmed;
            let next = segment.chunks.get(segment.confirmed);
            while (next?.played) {
                segment.chunks.delete(segment.confirmed);
                segment.confirmed = next.end;
                next = segment.chunks.get(segment.confirmed);
            }
            if (segment.confirmed > before)
                send({ type: "playback_progress",
                    reply_id: segment.reply, segment_id: segment.id, played_samples: segment.confirmed });
        };
    }
}
