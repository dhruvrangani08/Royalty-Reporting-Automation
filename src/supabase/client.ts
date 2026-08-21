import type { SupabaseConfig } from '../config/schema.js';

/**
 * The Supabase data path for the sync engine.
 *
 * PostgREST over `fetch`, nothing more. The service writes with the service-role
 * key, so this is a trusted server-side path - never a browser one. There is no
 * ORM and no query builder on purpose: the writer needs insert, upsert and
 * select, and a fourth verb is a fourth thing to test.
 *
 * TWO RULES CARRIED FROM THE REST OF THE PROJECT:
 *
 *   - The host never reaches a log or an error message. A network failure is
 *     reported by its error class only, because the URL is configuration.
 *   - The service-role key bypasses RLS. It is a header here and nowhere else;
 *     it is never formatted into a message.
 */

export interface SupabaseClientDeps {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface UpsertOptions {
  /**
   * The unique column(s) PostgREST resolves a conflict on, e.g. `"uid"` or
   * `"k_purchase,item_index"`. Required for a real upsert: without it PostgREST
   * cannot tell an update from a duplicate-key error.
   */
  readonly onConflict: string;
}

/** A Supabase write or read that PostgREST rejected, or that never completed. */
export class SupabaseError extends Error {
  constructor(
    readonly table: string,
    readonly httpStatus: number | null,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SupabaseError';
  }
}

export class SupabaseClient {
  private readonly doFetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: SupabaseConfig,
    deps: SupabaseClientDeps = {},
  ) {
    // Bound to globalThis: an unbound fetch reference throws in some runtimes.
    this.doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = deps.timeoutMs ?? 30_000;
  }

  /** Inserts rows and returns them as stored (ids and defaults filled in). */
  async insert<T = Record<string, unknown>>(
    table: string,
    rows: ReadonlyArray<Record<string, unknown>>,
  ): Promise<T[]> {
    return this.write<T>(table, rows, 'return=representation', '');
  }

  /**
   * Upserts rows on `options.onConflict` and returns them as stored.
   *
   * Idempotent: a row already present is updated in place, not duplicated. This
   * is what lets a sync re-run without piling up copies of the same record.
   */
  async upsert<T = Record<string, unknown>>(
    table: string,
    rows: ReadonlyArray<Record<string, unknown>>,
    options: UpsertOptions,
  ): Promise<T[]> {
    return this.write<T>(
      table,
      rows,
      'resolution=merge-duplicates,return=representation',
      `?on_conflict=${encodeURIComponent(options.onConflict)}`,
    );
  }

  /**
   * Patches rows matching `query` and returns the ones actually changed.
   *
   * The returned array is the compare-and-swap the queue claim relies on: a
   * conditional filter (`state=eq.pending`) that matches nothing means another
   * worker got there first, and the empty result says so without a second read.
   */
  async update<T = Record<string, unknown>>(
    table: string,
    patch: Record<string, unknown>,
    query: string,
  ): Promise<T[]> {
    const response = await this.send(table, `${this.base(table)}?${query}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });
    return this.parse<T>(table, response);
  }

  /**
   * Selects rows with a raw PostgREST query string, e.g. `"uid=eq.123&limit=1"`.
   * Kept deliberately thin - the caller writes the filter it needs.
   */
  async select<T = Record<string, unknown>>(table: string, query = ''): Promise<T[]> {
    const suffix = query.length === 0 ? '' : `?${query}`;
    const response = await this.send(table, `${this.base(table)}${suffix}`, { method: 'GET' });
    return this.parse<T>(table, response);
  }

  private async write<T>(
    table: string,
    rows: ReadonlyArray<Record<string, unknown>>,
    prefer: string,
    querySuffix: string,
  ): Promise<T[]> {
    // Nothing to write is not an error, and an empty POST is a wasted round trip.
    if (rows.length === 0) return [];
    const response = await this.send(table, `${this.base(table)}${querySuffix}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: prefer },
      body: JSON.stringify(rows),
    });
    return this.parse<T>(table, response);
  }

  private base(table: string): string {
    return `${this.config.url}/rest/v1/${table}`;
  }

  private async send(
    table: string,
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response> {
    try {
      return await this.doFetch(url, {
        method: init.method,
        headers: {
          apikey: this.config.serviceRoleKey,
          Authorization: `Bearer ${this.config.serviceRoleKey}`,
          Accept: 'application/json',
          ...(init.headers ?? {}),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      // Network failure or timeout. The message can carry the host, so only the
      // error class is reported.
      throw new SupabaseError(table, null, describeFetchFailure(cause, this.timeoutMs), { cause });
    }
  }

  private async parse<T>(table: string, response: Response): Promise<T[]> {
    const raw = await response.text();
    if (!response.ok) {
      // PostgREST error bodies are query-level (a constraint name, a bad column),
      // not network-level, so they carry no host. Surface the code and message to
      // make the failure actionable; fall back to the status alone.
      const err = parseJson(raw);
      const code = readString(err, 'code');
      const message = readString(err, 'message');
      const detail =
        message === null
          ? `HTTP ${String(response.status)}`
          : `${code === null ? '' : `${code}: `}${message}`;
      throw new SupabaseError(table, response.status, detail);
    }
    const parsed = parseJson(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  }
}

function describeFetchFailure(cause: unknown, timeoutMs: number): string {
  if (cause instanceof Error) {
    if (cause.name === 'TimeoutError' || cause.name === 'AbortError') {
      return `timed out after ${String(timeoutMs)}ms`;
    }
    return cause.name;
  }
  return 'unknown error';
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readString(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = (value as Record<string, unknown>)[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
