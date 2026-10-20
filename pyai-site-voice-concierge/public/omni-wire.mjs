// Native caller text is never interpreted as a control or role-bearing object.
// Legacy JSON is available only when the transport explicitly selects it.
function transcriptText(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4000
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ? value : null;
}
function transcriptRole(value) {
  if (['user','caller','human'].includes(value)) return 'user';
  if (['assistant','agent'].includes(value)) return 'assistant';
  return null;
}
export function normalizeOmniTranscriptBody(body, transcriptFormat = "text") {
  if (!["text", "legacy-json"].includes(transcriptFormat)) return null;
  if (!body?.length || body.length > 16384) return null;
  let decoded;
  try { decoded = new TextDecoder('utf-8',{fatal:true}).decode(body); } catch { return null; }
  if (transcriptFormat === "text") {
    const text = transcriptText(decoded);
    return text ? {event:'transcript',role:'user',text,final:false,mode:'delta'} : null;
  }
  let value;
  try { value = JSON.parse(decoded); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== undefined
      || (value.event !== undefined && value.event !== 'transcript')) return null;
  const role = transcriptRole(value.role ?? value.speaker);
  const mode = typeof value.delta === 'string' ? 'delta' : 'replace';
  const text = transcriptText(mode === 'delta' ? value.delta : typeof value.text === 'string' ? value.text : value.transcript);
  if (!role || !text || (value.final !== undefined && typeof value.final !== 'boolean')
      || (value.sequence !== undefined && (!Number.isSafeInteger(value.sequence) || value.sequence < 0))) return null;
  return {event:'transcript',role,text,final:value.final === true,mode,
    ...(value.sequence === undefined ? {} : {sequence:value.sequence})};
}
export function normalizeOmniServerControl(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.event === 'transcript') {
    const text = transcriptText(value.text);
    if (value.role !== 'assistant' || value.final !== true || !text?.trim()
        || Object.keys(value).length !== 4
        || !Object.keys(value).every(key=>['event','role','text','final'].includes(key))) return null;
    // This is synthesis text, not evidence that any audio was heard.
    return {...value,mode:'replace'};
  }
  if (typeof value.event === 'string' && value.event) return value;
  if (value.type !== 'audio_position'
      || !Object.keys(value).every(key=>['type','call_id','sent_ms','realtime_ms'].includes(key))
      || typeof value.sent_ms !== 'number' || !Number.isFinite(value.sent_ms) || value.sent_ms < 0
      || typeof value.realtime_ms !== 'number' || !Number.isFinite(value.realtime_ms) || value.realtime_ms < 0
      || (value.call_id !== undefined && (typeof value.call_id !== 'string' || !value.call_id))) return null;
  return {...value,event:'audio_position'};
}
