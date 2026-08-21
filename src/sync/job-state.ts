import type { SupabaseClient } from '../supabase/client.js';
import type { SyncPassSummary } from './pass.js';

/**
 * The per-job lifecycle row in `sync_job_state`.
 *
 * The queue resumes work BETWEEN items; this records the job as a whole - is it
 * running, paused mid-budget, or last finished cleanly - keyed by (job_name,
 * k_business). Its one load-bearing field is `last_clean_completion_at`, the
 * watermark a future incremental sync will trust: it moves ONLY when a pass drains
 * with nothing outstanding. A half-done run must not move it, or the next run skips
 * whatever it missed (the rule the 0007 schema spells out).
 *
 * NOT written here: the page cursor (page_number, report_handle, report_page). Those
 * are for a paged endpoint (/v1/report/data); nothing we sync paginates yet, so they
 * stay null until a paginated job needs them. Every upsert sends only the columns it
 * sets, so adding a cursor writer later cannot be clobbered by this one.
 */

/** Marks a job running at the start of a pass. */
export async function openJobState(
  db: SupabaseClient,
  jobName: string,
  kBusiness: string,
  now: string,
): Promise<void> {
  await db.upsert(
    'sync_job_state',
    [{ job_name: jobName, k_business: kBusiness, state: 'running', last_seen_at: now }],
    { onConflict: 'job_name,k_business' },
  );
}

/**
 * Closes a job's row with the pass verdict, moving the clean-completion watermark
 * only on a clean drain.
 *
 *   ok      -> idle,   watermark = now
 *   partial -> paused, watermark UNCHANGED (budget stopped it; more is outstanding)
 *   failed  -> failed, watermark UNCHANGED
 */
export async function closeJobState(
  db: SupabaseClient,
  jobName: string,
  kBusiness: string,
  now: string,
  passState: SyncPassSummary['state'],
): Promise<void> {
  const state = passState === 'ok' ? 'idle' : passState === 'partial' ? 'paused' : 'failed';
  await db.upsert(
    'sync_job_state',
    [
      {
        job_name: jobName,
        k_business: kBusiness,
        state,
        last_seen_at: now,
        // Only a clean drain advances the watermark. Omitted otherwise, so an
        // earlier clean completion survives a later partial/failed run.
        ...(passState === 'ok' ? { last_clean_completion_at: now } : {}),
      },
    ],
    { onConflict: 'job_name,k_business' },
  );
}
