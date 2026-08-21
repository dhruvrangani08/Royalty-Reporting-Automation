import type { AppConfig } from '../config/schema.js';
import { SupabaseClient } from '../supabase/client.js';
import { WlClient, WlRequestError } from '../wl/client.js';
import { WL_PATHS } from '../wl/endpoint.js';
import { closeJobState, openJobState } from './job-state.js';
import { writeLocationList } from './locations.js';
import { writePurchaseList } from './purchases.js';
import { enqueue, outcomeFromWlError, type QueueHandler, runQueue } from './queue.js';
import { writeReceipt } from './receipts.js';
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
 * fetch, and the jobs so far are single calls (a staff list, a per-uid purchase
 * list). It lands with paginated work; until then the queue resumes BETWEEN calls.
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

/** What the passes share; only the job name, work type, seeding and handler differ. */
interface PassContext {
  readonly wl: WlClient;
  readonly db: SupabaseClient;
  readonly kBusiness: string;
  readonly runId: string;
  /** The pass clock as an ISO string - the same clock the claim filters on. */
  readonly nowIso: () => string;
}

interface JobSpec {
  readonly jobName: string;
  /** The queue work_type this pass owns; it claims only these items. */
  readonly workType: string;
  /** Enqueues the work this pass should drain. */
  readonly seed: (ctx: PassContext) => Promise<void>;
  /** Builds the handler that processes one claimed item. */
  readonly makeHandler: (ctx: PassContext) => QueueHandler;
}

/** Runs the staff sync: one job that lists staff and writes them as people. */
export function runStaffSyncPass(
  config: AppConfig,
  deps: SyncPassDeps = {},
): Promise<SyncPassSummary> {
  return runPass(config, deps, {
    jobName: 'staff_sync',
    workType: 'staff_list',
    seed: ({ db, kBusiness, nowIso }) =>
      enqueue(
        db,
        [{ work_type: 'staff_list', target_key: 'all', k_business: kBusiness }],
        nowIso(),
      ).then(() => undefined),
    makeHandler:
      ({ wl, db, kBusiness, runId }) =>
      async (item) => {
        try {
          const response = await wl.request(WL_PATHS.staffList, {
            priorAttempt: item.attempt_count,
          });
          await writeStaffList(db, { kBusiness, response, runId });
          return { kind: 'done' };
        } catch (error) {
          if (error instanceof WlRequestError) return outcomeFromWlError(error);
          throw error;
        }
      },
  });
}

/**
 * Runs the location sync: one job that lists locations and enriches their detail
 * (title, timezone) over the stubs the purchase writer left. One WL call.
 */
export function runLocationSyncPass(
  config: AppConfig,
  deps: SyncPassDeps = {},
): Promise<SyncPassSummary> {
  return runPass(config, deps, {
    jobName: 'location_sync',
    workType: 'location_list',
    seed: ({ db, kBusiness, nowIso }) =>
      enqueue(
        db,
        [{ work_type: 'location_list', target_key: 'all', k_business: kBusiness }],
        nowIso(),
      ).then(() => undefined),
    makeHandler:
      ({ wl, db, kBusiness, runId }) =>
      async (item) => {
        try {
          const response = await wl.request(WL_PATHS.locationList, {
            priorAttempt: item.attempt_count,
          });
          await writeLocationList(db, { kBusiness, response, runId });
          return { kind: 'done' };
        } catch (error) {
          if (error instanceof WlRequestError) return outcomeFromWlError(error);
          throw error;
        }
      },
  });
}

/**
 * Runs the purchase sync: one job PER person, each listing that uid's purchases.
 *
 * Seeded from `person.uid`, so coverage is exactly the people already synced
 * (staff today). The uid is the payer and already a person row, so the FK holds;
 * completeness grows as `person` does. Money is not here - it needs the receipt
 * (task 015).
 */
export function runPurchaseSyncPass(
  config: AppConfig,
  deps: SyncPassDeps = {},
): Promise<SyncPassSummary> {
  return runPass(config, deps, {
    jobName: 'purchase_sync',
    workType: 'purchase_list',
    seed: async ({ db, kBusiness, nowIso }) => {
      const people = await db.select<{ uid: string }>(
        'person',
        `k_business=eq.${kBusiness}&select=uid`,
      );
      await enqueue(
        db,
        people.map((p) => ({
          work_type: 'purchase_list',
          target_key: p.uid,
          k_business: kBusiness,
        })),
        nowIso(),
      );
    },
    makeHandler:
      ({ wl, db, kBusiness, runId }) =>
      async (item) => {
        try {
          const response = await wl.request(WL_PATHS.profilePurchaseList, {
            query: { uid: item.target_key },
            priorAttempt: item.attempt_count,
          });
          await writePurchaseList(db, {
            kBusiness,
            uidPayer: item.target_key,
            response,
            runId,
          });
          return { kind: 'done' };
        } catch (error) {
          if (error instanceof WlRequestError) return outcomeFromWlError(error);
          throw error;
        }
      },
  });
}

/**
 * Runs the receipt sync: one job PER purchase still missing its total, each
 * fetching /v1/purchase/receipt to fill money and the payment breakdown (task 015).
 * Seeded from purchases with a null m_total, so a re-run enriches only the unpriced.
 */
export function runReceiptSyncPass(
  config: AppConfig,
  deps: SyncPassDeps = {},
): Promise<SyncPassSummary> {
  return runPass(config, deps, {
    jobName: 'receipt_sync',
    workType: 'purchase_receipt',
    seed: async ({ db, kBusiness, nowIso }) => {
      const unpriced = await db.select<{ k_purchase: string }>(
        'purchase',
        `k_business=eq.${kBusiness}&m_total=is.null&select=k_purchase`,
      );
      await enqueue(
        db,
        unpriced.map((p) => ({
          work_type: 'purchase_receipt',
          target_key: p.k_purchase,
          k_business: kBusiness,
        })),
        nowIso(),
      );
    },
    makeHandler:
      ({ wl, db, kBusiness, runId }) =>
      async (item) => {
        try {
          const response = await wl.request(WL_PATHS.purchaseReceipt, {
            query: { k_purchase: item.target_key },
            priorAttempt: item.attempt_count,
          });
          await writeReceipt(db, { kBusiness, kPurchase: item.target_key, response, runId });
          return { kind: 'done' };
        } catch (error) {
          if (error instanceof WlRequestError) return outcomeFromWlError(error);
          throw error;
        }
      },
  });
}

/** The shared shell: open a run, seed, drain within budget, close with a verdict. */
async function runPass(
  config: AppConfig,
  deps: SyncPassDeps,
  spec: JobSpec,
): Promise<SyncPassSummary> {
  const now = deps.now ?? (() => Date.now());
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const limit = deps.limit ?? DEFAULT_LIMIT;
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const startedAt = now();

  const wl = deps.wl ?? new WlClient(config.wl, { env: config.env });
  const db = deps.db ?? new SupabaseClient(config.supabase);
  const iso = (): string => new Date(now()).toISOString();
  const ctx: PassContext = {
    wl,
    db,
    kBusiness: config.wl.kBusiness,
    runId: wl.runId,
    nowIso: iso,
  };
  const handler = spec.makeHandler(ctx);

  await openRun(db, ctx.runId, ctx.kBusiness, spec.jobName, iso());
  await openJobState(db, spec.jobName, ctx.kBusiness, iso());

  const totals = { claimed: 0, done: 0, requeued: 0, dead: 0 };
  let failure: string | null = null;
  try {
    await spec.seed(ctx);
    for (;;) {
      // Budget is checked before starting a batch, never mid-item.
      if (now() - startedAt >= budgetMs) break;
      const s = await runQueue(db, handler, {
        now: iso(),
        workerId: ctx.runId,
        limit,
        leaseMs,
        workTypes: [spec.workType],
      });
      totals.claimed += s.claimed;
      totals.done += s.done;
      totals.requeued += s.requeued;
      totals.dead += s.dead;
      if (s.claimed === 0) break; // nothing eligible: the queue is drained
    }
  } catch (error) {
    failure = error instanceof Error ? error.name : 'unknown error';
  }

  const itemsRemaining = await countEligible(db, iso(), spec.workType);
  const state: SyncPassSummary['state'] =
    failure !== null ? 'failed' : itemsRemaining > 0 ? 'partial' : 'ok';

  await closeRun(db, ctx.runId, iso(), {
    state,
    rowsFailed: totals.dead,
    itemsRemaining,
    tokenFetches: wl.tokenStatus().fetchCount,
    error: failure,
  });
  await closeJobState(db, spec.jobName, ctx.kBusiness, iso(), state);

  return {
    runId: ctx.runId,
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
  jobName: string,
  startedAt: string,
): Promise<void> {
  await db.insert('sync_run', [
    {
      run_id: runId,
      job_name: jobName,
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

/** How many of THIS job's items are claimable now - the measure of "work left". */
async function countEligible(db: SupabaseClient, now: string, workType: string): Promise<number> {
  // ponytail: caps the look at 1000; a queue past that is a scaling problem to
  // solve with a PostgREST count header, not a reason to block a pass today.
  const rows = await db.select(
    'sync_queue',
    `state=eq.pending&next_attempt_at=lte.${now}&work_type=eq.${workType}&limit=1000&select=id`,
  );
  return rows.length;
}
