import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema.js';
import type { SupabaseClient } from '../src/supabase/client.js';
import type { WlClient } from '../src/wl/client.js';
import { runStaffSyncPass } from '../src/sync/pass.js';

const config = {
  env: 'dev',
  wl: { kBusiness: '111111' },
} as unknown as AppConfig;

/** A WL client whose staff call returns an empty (but valid) list, or throws. */
function fakeWl(request: () => Promise<unknown>): WlClient {
  return {
    runId: 'run-x',
    request: vi.fn(request),
    tokenStatus: () => ({ cached: true, expiresInMs: 1000, fetchCount: 1 }),
  } as unknown as WlClient;
}

interface DbScript {
  claimReturns?: unknown[]; // what a claim CAS yields (an item, or nothing)
  eligibleRemaining?: unknown[]; // countEligible result
}

function fakeDb(script: DbScript = {}) {
  const calls: Array<{
    op: string;
    table: string;
    patch?: Record<string, unknown>;
    query?: string;
  }> = [];
  const db = {
    insert: vi.fn((table: string, rows: unknown[]) => {
      calls.push({ op: 'insert', table });
      return Promise.resolve(table === 'sync_run' ? [{ run_id: 'run-x' }] : rows);
    }),
    update: vi.fn((table: string, patch: Record<string, unknown>, query: string) => {
      calls.push({ op: 'update', table, patch, query });
      // The claim compare-and-swap is the only update that reads back a row.
      const isClaim = query.includes('id=eq.') && query.includes('select=');
      return Promise.resolve(isClaim ? (script.claimReturns ?? []) : []);
    }),
    select: vi.fn((table: string, query: string) => {
      calls.push({ op: 'select', table, query });
      if (query.includes('limit=1000')) return Promise.resolve(script.eligibleRemaining ?? []);
      if (query.includes('order=next_attempt_at.asc'))
        return Promise.resolve(script.claimReturns ?? []);
      return Promise.resolve([]); // enqueue active-target lookup
    }),
  } as unknown as SupabaseClient;
  return { db, calls };
}

const okResponse = () =>
  Promise.resolve({
    body: { a_staff: {} },
    traceId: 'run-x.1',
    kLog: null,
    httpStatus: 200,
    latencyMs: 1,
  });

describe('runStaffSyncPass', () => {
  it('reports ok and closes the run when the queue drains', async () => {
    const { db, calls } = fakeDb({ claimReturns: [], eligibleRemaining: [] });
    const summary = await runStaffSyncPass(config, {
      wl: fakeWl(okResponse),
      db,
      now: () => 0,
    });

    expect(summary.state).toBe('ok');
    // The run is opened and then closed with a finished_at + ok state.
    const open = calls.find((c) => c.op === 'insert' && c.table === 'sync_run');
    const close = calls.find((c) => c.op === 'update' && c.table === 'sync_run');
    expect(open).toBeDefined();
    expect(close!.patch).toMatchObject({ state: 'ok' });
    expect(close!.patch!.finished_at).toBeTruthy();
  });

  it('reports partial when the budget stops the pass with work still eligible', async () => {
    const { db, calls } = fakeDb({ eligibleRemaining: [{ id: 'left' }] });
    const summary = await runStaffSyncPass(config, {
      wl: fakeWl(okResponse),
      db,
      now: () => 0,
      budgetMs: 0, // no budget: stop before claiming anything
    });

    expect(summary.state).toBe('partial');
    expect(summary.itemsRemaining).toBe(1);
    const close = calls.find((c) => c.op === 'update' && c.table === 'sync_run');
    expect(close!.patch).toMatchObject({ state: 'partial' });
  });

  it('reports failed when the handler throws a non-WL error', async () => {
    const item = {
      id: 'q1',
      work_type: 'staff_list',
      target_key: 'all',
      k_business: '111111',
      attempt_count: 0,
    };
    const { db } = fakeDb({ claimReturns: [item], eligibleRemaining: [] });
    const summary = await runStaffSyncPass(config, {
      wl: fakeWl(() => Promise.reject(new Error('boom'))),
      db,
      now: () => 0,
    });

    expect(summary.state).toBe('failed');
    expect(summary.error).toBe('Error');
  });
});
