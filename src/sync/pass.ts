import type { AppConfig } from '../config/schema.js';
import { SupabaseClient } from '../supabase/client.js';
import { WlClient, WlRequestError } from '../wl/client.js';
import { WL_PATHS } from '../wl/endpoint.js';
import { enqueue, outcomeFromWlError, type QueueHandler, runQueue } from './queue.js';
import { writeStaffList } from './writer.js';

/**
 * One bounded sync pass, the shape the cron route runs.
 *
 * A pass opens a `sync_run` row, seeds and drains the queue within a time budget,
 * and closes the row with an honest verdict. `partial` - the budget ran out with
 * work still eligible - is the NORMAL way a long run ends, not a failure: the next
 * invocation resumes from the queue, because the queue is the durable cursor.
 *
 * NOT here yet: the `sync_job_state` page cursor. It only matters for a paginated
 * fetch, and the only job so far (staff) is a single whole-list call. It lands with
 * the paginated purchase work (task 014); until then there is nothing to resume
 * WITHIN a call, and the queue resumes BETWEEN them.
 */

export interface SyncPassDeps {
  /** Share one WL client per pass so every call carries the same run id. */
  wl?: WlClient;
  db?: SupabaseClient;
  now?: () => number;
  /** Stop STARTING new queue batches once this many ms have passed. */
  budgetMs?: number;
  /** Items claimed per batch. */
  limit?: number;
  /** Claim lease length, kept above the step budget. */
  leaseMs?: number;
}

export interface SyncPassSummary {
  readonly runId: string;
  readonly state: 'ok' | 'partial' | 'failed';
  readonly claimed: number;
  readonly done: number;
  readonly requeued: number;
  readonly dead: number;
  readonly itemsRemaining: number;
  readonly error?: string;
}

const DEFAULT_BUDGET_MS = 50_000;
const DEFAULT_LIMIT = 10;
const DEFAULT_LEASE_MS = 55_000;
const JOB_NAME = 'staff_sync';

/**
 * Runs the staff sync as a durable, bounded pass. Enqueues the staff job, drains
 * the queue until it is empty or the budget stops it, and records the run.
 */
export async function runStaffSyncPass(
  config: AppConfig,
  deps: SyncPassDeps = {},
): Promise<SyncPassSummary> {
  const now = deps.now ?? (() => Date.now());
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const limit = deps.limit ?? DEFAULT_LIMIT;
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const startedAt = now();

  const wl = deps.wl ?? new WlClient(config.wl, { env: config.env });
  const db = deps.db ?? new SupabaseClient(config.supabase);
  const runId = wl.runId;
  const kBusiness = config.wl.kBusiness;
  const iso = (): string => new Date(now()).toISOString();

  const handler: QueueHandler = async (item) => {
    try {
      const response = await wl.request(WL_PATHS.staffList, { priorAttempt: item.attempt_count });
      await writeStaffList(db, { kBusiness, response, runId });
      return { kind: 'done' };
    } catch (error) {
      if (error instanceof WlRequestError) return outcomeFromWlError(error);
      throw error; // a genuine bug, not an API failure - let the pass record it
    }
  };

  await openRun(db, runId, kBusiness, iso());

  const totals = { claimed: 0, done: 0, requeued: 0, dead: 0 };
  let failure: string | null = null;
  try {
    await enqueue(db, [{ work_type: 'staff_list', target_key: 'all', k_business: kBusiness }]);
    for (;;) {
      // Budget is checked before starting a batch, never mid-item - the same rule
      // batch.ts and the request deadline follow.
      if (now() - startedAt >= budgetMs) break;
      const s = await runQueue(db, handler, { now: iso(), workerId: runId, limit, leaseMs });
      totals.claimed += s.claimed;
      totals.done += s.done;
      totals.requeued += s.requeued;
      totals.dead += s.dead;
      if (s.claimed === 0) break; // nothing eligible: the queue is drained
    }
  } catch (error) {
    failure = error instanceof Error ? error.name : 'unknown error';
  }

  const itemsRemaining = await countEligible(db, iso());
  const state: SyncPassSummary['state'] =
    failure !== null ? 'failed' : itemsRemaining > 0 ? 'partial' : 'ok';

  await closeRun(db, runId, iso(), {
    state,
    rowsFailed: totals.dead,
    itemsRemaining,
    tokenFetches: wl.tokenStatus().fetchCount,
    error: failure,
  });

  return {
    runId,
    state,
    ...totals,
    itemsRemaining,
    ...(failure === null ? {} : { error: failure }),
  };
}

async function openRun(
  db: SupabaseClient,
  runId: string,
  kBusiness: string,
  startedAt: string,
): Promise<void> {
  await db.insert('sync_run', [
    {
      run_id: runId,
      job_name: JOB_NAME,
      k_business: kBusiness,
      started_at: startedAt,
      state: 'running',
    },
  ]);
}

async function closeRun(
  db: SupabaseClient,
  runId: string,
  finishedAt: string,
  outcome: {
    state: SyncPassSummary['state'];
    rowsFailed: number;
    itemsRemaining: number;
    tokenFetches: number;
    error: string | null;
  },
): Promise<void> {
  await db.update(
    'sync_run',
    {
      state: outcome.state,
      finished_at: finishedAt, // the constraint requires this once state != running
      rows_failed: outcome.rowsFailed,
      items_remaining: outcome.itemsRemaining,
      token_fetches: outcome.tokenFetches,
      ...(outcome.error === null ? {} : { error: outcome.error }),
    },
    `run_id=eq.${runId}`,
  );
}

/** How many items are claimable right now - the measure of "is there work left". */
async function countEligible(db: SupabaseClient, now: string): Promise<number> {
  // ponytail: caps the look at 1000; a queue past that is a scaling problem to
  // solve with a PostgREST count header, not a reason to block a pass today.
  const rows = await db.select(
    'sync_queue',
    `state=eq.pending&next_attempt_at=lte.${now}&limit=1000&select=id`,
  );
  return rows.length;
}
