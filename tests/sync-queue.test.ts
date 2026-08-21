import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '../src/supabase/client.js';
import { WlRequestError } from '../src/wl/client.js';
import {
  claimBatch,
  enqueue,
  outcomeFromWlError,
  type QueueHandler,
  type QueueItem,
  runQueue,
  settle,
} from '../src/sync/queue.js';

const NOW = '2026-08-21T00:00:00.000Z';

interface Responses {
  select?: (table: string, query: string) => unknown[];
  update?: (table: string, patch: Record<string, unknown>, query: string) => unknown[];
}

function fakeDb(responses: Responses = {}) {
  const calls: Array<{
    op: string;
    table: string;
    patch?: Record<string, unknown>;
    query?: string;
    rows?: unknown[];
  }> = [];
  const db = {
    select: vi.fn((table: string, query: string) => {
      calls.push({ op: 'select', table, query });
      return Promise.resolve(responses.select?.(table, query) ?? []);
    }),
    update: vi.fn((table: string, patch: Record<string, unknown>, query: string) => {
      calls.push({ op: 'update', table, patch, query });
      return Promise.resolve(responses.update?.(table, patch, query) ?? []);
    }),
    insert: vi.fn((table: string, rows: unknown[]) => {
      calls.push({ op: 'insert', table, rows });
      return Promise.resolve(rows);
    }),
  } as unknown as SupabaseClient;
  return { db, calls };
}

const item: QueueItem = {
  id: 'q1',
  work_type: 'staff_list',
  target_key: 'all',
  k_business: '111111',
  attempt_count: 0,
};

function wlError(requeueAfterMs: number | null): WlRequestError {
  return new WlRequestError('transient', 'throttled', {
    path: '/v1/staff/list',
    sid: 'rate-limit',
    sField: null,
    traceId: 't.1',
    kLog: null,
    httpStatus: 200,
    latencyMs: 5,
    retryAfterMs: null,
    attempts: 4,
    requeueAfterMs,
  });
}

describe('outcomeFromWlError', () => {
  it('requeues when the client still has guidance', () => {
    const outcome = outcomeFromWlError(wlError(60_000));
    expect(outcome.kind).toBe('requeue');
    if (outcome.kind === 'requeue') {
      expect(outcome.requeueAfterMs).toBe(60_000);
      expect(outcome.failure.sid).toBe('rate-limit');
      expect(outcome.failure.traceId).toBe('t.1');
    }
  });

  it('dead-letters when requeue guidance is null (spent or permanent)', () => {
    expect(outcomeFromWlError(wlError(null)).kind).toBe('dead');
  });
});

describe('settle', () => {
  it('marks a done item done', async () => {
    const { db, calls } = fakeDb();
    await settle(db, item, { kind: 'done' }, NOW);
    expect(calls[0]).toMatchObject({ op: 'update', table: 'sync_queue', patch: { state: 'done' } });
    expect(calls[0]!.query).toContain('id=eq.q1');
  });

  it('requeues with next_attempt_at and advances attempt_count (decision 4)', async () => {
    const { db, calls } = fakeDb();
    await settle(db, item, outcomeFromWlError(wlError(60_000)), NOW);

    const patch = calls[0]!.patch as Record<string, unknown>;
    expect(patch.state).toBe('pending');
    // attempt_count 0 -> 1: the NEXT failure lands a rung further out.
    expect(patch.attempt_count).toBe(1);
    // next_attempt_at = now + the client's requeue delay.
    expect(patch.next_attempt_at).toBe(new Date(Date.parse(NOW) + 60_000).toISOString());
    expect(patch.last_error_sid).toBe('rate-limit');
    // Lease is released so the item is cleanly claimable again.
    expect(patch.claim_expires_at).toBeNull();
  });

  it('dead-letters with the error recorded', async () => {
    const { db, calls } = fakeDb();
    await settle(db, item, outcomeFromWlError(wlError(null)), NOW);
    const patch = calls[0]!.patch as Record<string, unknown>;
    expect(patch.state).toBe('dead');
    expect(patch.last_error).toBe('throttled');
  });
});

describe('claimBatch', () => {
  const opts = {
    now: NOW,
    workerId: 'run-1',
    limit: 5,
    leaseMs: 55_000,
    workTypes: ['staff_list'],
  };

  it('claims a candidate whose compare-and-swap wins', async () => {
    const { db } = fakeDb({
      select: () => [item],
      update: () => [item], // the conditional PATCH matched: we won the row
    });
    const claimed = await claimBatch(db, opts);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.id).toBe('q1');
  });

  it('skips a candidate another worker already claimed (empty swap)', async () => {
    const { db } = fakeDb({
      select: () => [item],
      update: () => [], // conditional filter matched nothing: lost the race
    });
    expect(await claimBatch(db, opts)).toEqual([]);
  });

  it('claims only the requested work types - no cross-job theft', async () => {
    let claimQuery = '';
    const { db } = fakeDb({
      select: (_t, q) => {
        claimQuery = q;
        return [];
      },
    });
    await claimBatch(db, opts);
    expect(claimQuery).toContain('work_type=in.(staff_list)');
  });

  it('claims under a lease that expires after now', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { db } = fakeDb({
      select: () => [item],
      update: (_t, patch) => {
        seen.push(patch);
        return [item];
      },
    });
    await claimBatch(db, opts);
    expect(seen[0]!.claim_expires_at).toBe(new Date(Date.parse(NOW) + 55_000).toISOString());
    expect(seen[0]!.state).toBe('in_progress');
  });
});

describe('runQueue', () => {
  const opts = {
    now: NOW,
    workerId: 'run-1',
    limit: 5,
    leaseMs: 55_000,
    workTypes: ['staff_list'],
  };

  it('reclaims, claims, runs the handler and settles, counting outcomes', async () => {
    const { db, calls } = fakeDb({
      // reclaim update -> [], claim select -> [item], claim swap -> [item]
      update: (_t, _p, query) => (query.includes('claim_expires_at=lt') ? [] : [item]),
      select: () => [item],
    });
    const handler: QueueHandler = vi.fn((claimed: QueueItem) => {
      // The handler can read attempt_count to pass as priorAttempt (decision 4).
      expect(claimed.attempt_count).toBe(0);
      return Promise.resolve({ kind: 'done' as const });
    });

    const summary = await runQueue(db, handler, opts);

    expect(handler).toHaveBeenCalledOnce();
    expect(summary).toMatchObject({ claimed: 1, done: 1, requeued: 0, dead: 0 });
    // Last write settles the item done.
    expect(calls.at(-1)).toMatchObject({ table: 'sync_queue', patch: { state: 'done' } });
  });
});

describe('enqueue', () => {
  it('skips a target that already has an active item', async () => {
    const { db, calls } = fakeDb({
      select: () => [{ work_type: 'staff_list', target_key: 'all', k_business: '111111' }],
    });
    const added = await enqueue(db, [
      { work_type: 'staff_list', target_key: 'all', k_business: '111111' },
    ]);
    expect(added).toBe(0);
    expect(calls.some((c) => c.op === 'insert')).toBe(false);
  });

  it('inserts a genuinely new target', async () => {
    const { db, calls } = fakeDb({ select: () => [] });
    const added = await enqueue(db, [
      { work_type: 'staff_list', target_key: 'all', k_business: '111111' },
    ]);
    expect(added).toBe(1);
    expect(calls.some((c) => c.op === 'insert')).toBe(true);
  });
});
