import { timingSafeEqual } from 'node:crypto';
import { loadConfig } from '../src/config/index.js';
import { checkAll } from '../src/supabase/health.js';

/**
 * Token-protected health probe, deployed as a Vercel Serverless Function.
 *
 * This is the ONLY thing this repo deploys to Vercel, and deliberately so: a
 * Vercel function is capped at 60s on Hobby, while the daily sync is budgeted at
 * two hours and the backfill at eight (PRD section 12). The sync engine runs
 * elsewhere; this endpoint exists to answer one question from outside the
 * network - "can the deployed environment resolve its config and reach
 * Supabase?" - which is otherwise only checkable from a developer's laptop.
 *
 * Requires: Authorization: Bearer <HEALTHCHECK_TOKEN>
 */

/**
 * Minimal structural types for the Vercel Node runtime.
 *
 * Declared locally rather than depending on @vercel/node: these three members
 * are all this handler touches, and a types-only dependency on the platform is
 * not worth carrying for them.
 */
export interface HealthRequest {
  readonly method?: string | undefined;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface HealthResponse {
  status(code: number): HealthResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

/**
 * Constant-time bearer token comparison.
 *
 * Returns false when no token is configured: an unset HEALTHCHECK_TOKEN must
 * lock the endpoint, never open it.
 */
export function isAuthorized(
  headerValue: string | string[] | undefined,
  expected: string | undefined,
): boolean {
  if (expected === undefined || expected.length === 0) return false;

  const header = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (header === undefined) return false;

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const presented = match?.[1];
  if (presented === undefined) return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so length is checked first. The
  // length of a token is not a useful secret.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export default async function handler(req: HealthRequest, res: HealthResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  if (!isAuthorized(req.headers.authorization, process.env.HEALTHCHECK_TOKEN)) {
    // Identical response whether the token is wrong or unconfigured, so the
    // endpoint reveals nothing about its own setup.
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    const config = await loadConfig();
    const results = await checkAll(config);
    const ok = results.every((r) => r.ok);

    res.status(ok ? 200 : 503).json({
      env: config.env,
      secretsProvider: config.secretsProviderName,
      ok,
      results,
    });
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
