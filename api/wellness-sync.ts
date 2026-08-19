import { loadConfig } from '../src/config/index.js';
import { isAuthorizedByAny } from '../src/http/bearer.js';
import type { HttpRequest, HttpResponse } from '../src/http/types.js';
import { runWellnessSync } from '../src/wl/sync.js';

/**
 * Token-protected WellnessLiving sync trigger, deployed as a Vercel function.
 *
 * This is the endpoint a 24-hour cron calls. Inside it, the order is fixed:
 * authenticate against WellnessLiving FIRST, then run every operation on that
 * one shared token.
 *
 * WHAT IT DOES TODAY: a read-only pass that proves the authenticated chain works
 * in the deployed environment - token acquisition, business scoping, the
 * `status === "ok"` assertion, and `k_log` capture per call. It does NOT write to
 * Supabase, because the schema (PRD M02) and the queue/worker layer (M03) are not
 * built yet.
 *
 * WHAT IT CANNOT BECOME: the executor for the full daily sync. A Vercel function
 * is capped at 60s on Hobby while the daily sync is budgeted at two hours and the
 * backfill at eight (PRD section 12). When the sync engine lands, this route
 * either triggers it elsewhere or runs one bounded slice per invocation. The
 * budget guard in runWellnessSync exists so that limit is reported rather than
 * hit as a silent timeout.
 *
 * AUTH: `Authorization: Bearer <token>`, matched against SYNC_TRIGGER_TOKEN or
 * CRON_SECRET. Vercel Cron sends CRON_SECRET as the bearer automatically, so
 * setting that one variable is enough to let the schedule in and keep everyone
 * else out. Both unset means the endpoint is locked, not open.
 */

/** Accepts GET because Vercel Cron issues GET; POST for a manual trigger. */
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST']);

export default async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== undefined && !ALLOWED_METHODS.has(req.method)) {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  if (
    !isAuthorizedByAny(req.headers.authorization, [
      process.env.SYNC_TRIGGER_TOKEN,
      process.env.CRON_SECRET,
    ])
  ) {
    // Identical response whether the token is wrong or unconfigured, so the
    // endpoint reveals nothing about its own setup.
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    const config = await loadConfig();
    const summary = await runWellnessSync(config);

    // 200 only when every step ran and succeeded. A cron that reports success on
    // a partial run is worse than no cron at all.
    res.status(summary.ok ? 200 : 503).json(summary);
  } catch (error) {
    // Config errors name the offending KEYS, never their values - see
    // src/config/schema.ts. Safe to return to an authorized caller.
    res.status(500).json({
      ok: false,
      error: 'configuration could not be resolved',
      detail: error instanceof Error ? error.message : 'unknown error',
    });
  }
}
