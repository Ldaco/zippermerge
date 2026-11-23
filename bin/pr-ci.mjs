const FAILURES = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);

// Keep check-run counts separate from the combined commit status, which is one
// result for all status contexts rather than a count of failed checks.
export function summarizeCi(runs, commitStatus = 'none') {
  const c = { total: runs?.length || 0, success: 0, failure: 0, pending: 0, skipped: 0, conclusion: 'none' };
  let unknown = !runs || commitStatus === 'unknown';
  for (const r of runs || []) {
    const k = r.conclusion;
    if (FAILURES.has(k)) c.failure++;
    else if (r.status !== 'completed') c.pending++;
    else if (k === 'success') c.success++;
    else if (k === 'skipped' || k === 'neutral') c.skipped++;
    else unknown = true; // Stale, missing, or unrecognized completed result.
  }
  if (c.failure || commitStatus === 'failure') c.conclusion = 'failure';
  else if (unknown) c.conclusion = 'unknown';
  else if (c.pending || commitStatus === 'pending') c.conclusion = 'pending';
  else if (c.success || commitStatus === 'success') c.conclusion = 'success';
  return c;
}

export function ciBlocker(checks) {
  if (!checks) return null;
  if (Number(checks.failure) > 0 || checks.conclusion === 'failure') {
    const text = Number(checks.failure) > 0 ? `CI failing (${checks.failure})` : 'CI failing (commit status)';
    return { state: 'failure', text };
  }
  if (checks.conclusion === 'unknown') return { state: 'unknown', text: 'CI checks unknown' };
  if (Number(checks.pending) > 0 || checks.conclusion === 'pending') return { state: 'pending', text: 'CI still running' };
  return null;
}
