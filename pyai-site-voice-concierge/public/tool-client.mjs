// A tool definition is not an executor. Forward only explicitly supported actions.
export async function executeDemoTool(evt, fetchImpl = fetch) {
  if (evt.name !== 'save_demo_enquiry') return { type: 'tool_result', call_id: evt.call_id, error: 'tool_not_supported' };
  try {
    const response = await fetchImpl('/demo-action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(evt), signal: AbortSignal.timeout(5000) });
    const result = await response.json();
    if (!response.ok || result.success !== true) throw new Error('action_unconfirmed');
    return { type: 'tool_result', call_id: evt.call_id, result };
  } catch {
    // The write may have succeeded. Do not retry or claim completion.
    return { type: 'tool_result', call_id: evt.call_id, error: 'action_outcome_unconfirmed_do_not_retry' };
  }
}
