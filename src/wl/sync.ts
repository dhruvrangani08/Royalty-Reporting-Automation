import type { AppConfig } from '../config/schema.js';
import type { AppEnv } from '../secrets/types.js';
import { WlClient, WlRequestError, type WlClientDeps } from './client.js';
import { WL_PATHS } from './endpoint.js';
import { WlAuthError } from './token.js';

/**
 * One authenticated WellnessLiving sync pass.
 *
 * The shape this enforces is the one that matters: AUTHENTICATE FIRST, then run
 * every operation on the shared token. A credential problem therefore surfaces
 * before any work is attempted, which is the difference between a cron log that
 * says "auth failed for env prod" and one that says "call 1 of 3000 failed".
 *
 * SCOPE, honestly stated: this reads. It does not yet write to Supabase, because
 * the schema (PRD M02) and the queue/worker layer (M03) do not exist yet. What
 * it does prove, in the deployed environment rather than on a laptop, is that
 * the whole chain works: token acquisition, business scoping, the
 * `status === "ok"` assertion and `k_log` capture. When the sync engine lands,
 * the steps below are replaced by real work and this function keeps its shape.
 *
 * TIME BUDGET: a Vercel function is capped (60s on Hobby) while the full daily
 * sync is budgeted at two hours (PRD section 12). So this stops STARTING new
 * steps once the budget is spent and reports what it skipped. It never truncates
 * silently - a summary that looks complete when it is not is worse than a
 * summary that says it ran out of time.
 */

/** Default step budget, comfortably inside the platform's 60s function cap. */
const DEFAULT_BUDGET_MS = 50_000;

/** The read-only calls a pass makes today, in order. */
const STEPS: ReadonlyArray<{ name: string; path: string }> = [
  { name: 'business', path: WL_PATHS.business },
  { name: 'locations', path: WL_PATHS.locationList },
  { name: 'staff', path: WL_PATHS.staffList },
];

export interface WellnessSyncStep {
  readonly name: string;
  readonly path: string;
  readonly ok: boolean;
  /** Safe to log: never contains business data, a host or a credential. */
  readonly detail: string;
  /** WL's trace id. Null when WL did not send one - it does not on every endpoint. */
  readonly kLog: string | null;
  readonly latencyMs: number;
  /**
   * How many records each top-level collection held, by field name. Counts only.
   *
   * WL returns list endpoints as KEYED OBJECTS, not arrays - `a_staff` is an
   * object keyed by uid, `a_location` by location key (verified live, 19 Aug
   * 2026). So an object's key count is as much a row count as an array's length,
   * and any mapper must iterate with Object.values() rather than treating these
   * as arrays.
   */
  readonly collections?: Readonly<Record<string, number>>;
  readonly sid?: string | null;
  readonly kind?: string;
  readonly httpStatus?: number | null;
}

export interface WellnessSyncSummary {
  readonly env: AppEnv;
  readonly ok: boolean;
  /** How many times a token was actually fetched. Should be 1 for a short pass. */
  readonly tokenFetches: number;
  readonly durationMs: number;
  readonly steps: readonly WellnessSyncStep[];
  /** Steps not attempted because the time budget ran out. Never silent. */
  readonly skipped: readonly string[];
  /** Present only when authentication itself failed, so no step ran. */
  readonly authError?: string;
}

export interface WellnessSyncDeps extends WlClientDeps {
  /** Stop starting new steps after this many ms. */
  budgetMs?: number;
  /** Inject a pre-built client, e.g. to share one token cache across passes. */
  client?: WlClient;
}

export async function runWellnessSync(
  config: AppConfig,
  deps: WellnessSyncDeps = {},
): Promise<WellnessSyncSummary> {
  const now = deps.now ?? (() => Date.now());
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const startedAt = now();

  const client =
    deps.client ??
    new WlClient(config.wl, {
      ...deps,
      env: config.env,
      timeoutMs: deps.timeoutMs ?? config.runtime.httpTimeoutMs,
      // The limits are configuration, not constants. Passing them here is what
      // makes WL_REQUESTS_PER_SECOND and WL_MAX_CONCURRENCY real: the client
      // defaults to unlimited, so a run that skipped this would be uncapped.
      requestsPerSecond: deps.requestsPerSecond ?? config.runtime.requestsPerSecond,
      maxConcurrency: deps.maxConcurrency ?? config.runtime.maxConcurrency,
      now,
    });

  // Authenticate before anything else. A failure here ends the pass with a
  // message that names the environment, and no step is attempted.
  try {
    await client.ensureAuthenticated();
  } catch (error) {
    return {
      env: config.env,
      ok: false,
      tokenFetches: client.tokenStatus().fetchCount,
      durationMs: now() - startedAt,
      steps: [],
      skipped: STEPS.map((s) => s.name),
      authError:
        error instanceof WlAuthError
          ? error.message
          : 'authentication failed for an unknown reason',
    };
  }

  const steps: WellnessSyncStep[] = [];
  const skipped: string[] = [];

  for (const step of STEPS) {
    if (now() - startedAt >= budgetMs) {
      skipped.push(step.name);
      continue;
    }
    steps.push(await runStep(client, step));
  }

  return {
    env: config.env,
    ok: steps.every((s) => s.ok) && skipped.length === 0,
    tokenFetches: client.tokenStatus().fetchCount,
    durationMs: now() - startedAt,
    steps,
    skipped,
  };
}

async function runStep(
  client: WlClient,
  step: { name: string; path: string },
): Promise<WellnessSyncStep> {
  try {
    const response = await client.request<Record<string, unknown>>(step.path);
    return {
      name: step.name,
      path: step.path,
      ok: true,
      detail: 'ok',
      kLog: response.kLog,
      latencyMs: response.latencyMs,
      collections: countCollections(response.body),
      httpStatus: response.httpStatus,
    };
  } catch (error) {
    if (error instanceof WlRequestError) {
      return {
        name: step.name,
        path: step.path,
        ok: false,
        detail: error.message,
        kLog: error.details.kLog,
        latencyMs: 0,
        sid: error.details.sid,
        kind: error.kind,
        httpStatus: error.details.httpStatus,
      };
    }
    return {
      name: step.name,
      path: step.path,
      ok: false,
      detail: 'failed for an unknown reason',
      kLog: null,
      latencyMs: 0,
    };
  }
}

/**
 * Size of every top-level collection in the payload, by field name.
 *
 * Counts only - no values. Arrays report their length, objects their key count,
 * because WL uses keyed objects for list endpoints. Enough to see that an
 * endpoint returned rows and how many, without asserting anything about field
 * names that the field mapping has not yet confirmed.
 */
function countCollections(body: unknown): Record<string, number> {
  if (typeof body !== 'object' || body === null) return {};
  const counts: Record<string, number> = {};
  // Cast to a known record so each value is `unknown` rather than `any`.
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      counts[key] = value.length;
    } else if (typeof value === 'object' && value !== null) {
      counts[key] = Object.keys(value).length;
    }
  }
  return counts;
}
