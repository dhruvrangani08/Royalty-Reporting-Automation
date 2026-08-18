import type { AppConfig, SupabaseConfig } from '../config/schema.js';

export interface HealthCheckResult {
  /** What was probed, in words safe to print. */
  readonly target: string;
  readonly ok: boolean;
  /** Human-readable outcome. Never contains a credential or a host. */
  readonly detail: string;
  readonly httpStatus?: number;
  readonly latencyMs: number;
}

export interface SupabaseHealthDeps {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Injectable clock so tests do not depend on wall time. */
  now?: () => number;
}

/**
 * Confirms the Supabase project is reachable AND that the service role key is
 * accepted.
 *
 * Probes the PostgREST root rather than a table, because this runs before the
 * schema (PRD M02) exists. A 200 means the project answered and authenticated
 * the key; 401/403 means it answered and rejected it - a materially different
 * failure, so they are reported differently.
 */
export async function checkSupabaseReachable(
  supabase: SupabaseConfig,
  deps: SupabaseHealthDeps = {},
): Promise<HealthCheckResult> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const now = deps.now ?? (() => Date.now());
  const target = 'supabase:rest';
  const startedAt = now();

  try {
    const response = await doFetch(`${supabase.url}/rest/v1/`, {
      method: 'GET',
      headers: {
        apikey: supabase.serviceRoleKey,
        Authorization: `Bearer ${supabase.serviceRoleKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    const latencyMs = now() - startedAt;

    if (response.ok) {
      return {
        target,
        ok: true,
        detail: 'reachable, service role key accepted',
        httpStatus: response.status,
        latencyMs,
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        target,
        ok: false,
        detail: 'reachable, but the service role key was rejected - rotate or re-copy the key',
        httpStatus: response.status,
        latencyMs,
      };
    }

    return {
      target,
      ok: false,
      detail: `unexpected HTTP status ${String(response.status)}`,
      httpStatus: response.status,
      latencyMs,
    };
  } catch (cause) {
    const latencyMs = now() - startedAt;
    return {
      target,
      ok: false,
      detail: `not reachable: ${describeFetchFailure(cause, timeoutMs)}`,
      latencyMs,
    };
  }
}

/** Runs every reachability check the foundation layer owns. */
export async function checkAll(
  config: AppConfig,
  deps: SupabaseHealthDeps = {},
): Promise<HealthCheckResult[]> {
  return [
    await checkSupabaseReachable(config.supabase, {
      ...deps,
      timeoutMs: deps.timeoutMs ?? config.runtime.httpTimeoutMs,
    }),
  ];
}

function describeFetchFailure(cause: unknown, timeoutMs: number): string {
  if (cause instanceof Error) {
    if (cause.name === 'TimeoutError' || cause.name === 'AbortError') {
      return `timed out after ${String(timeoutMs)}ms`;
    }
    // The message can carry the host; the URL itself is configuration, so only
    // the error class is reported.
    return cause.name;
  }
  return 'unknown error';
}
