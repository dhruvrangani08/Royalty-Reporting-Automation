import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { checkAll, checkSupabaseReachable } from '../src/supabase/health.js';
import { FakeProvider } from './helpers/fixtures.js';

const loadFake = () => loadConfig({ processEnv: { APP_ENV: 'dev' }, provider: new FakeProvider() });

function response(status: number): Response {
  return new Response(status === 204 ? null : '{}', { status });
}

describe('checkSupabaseReachable', () => {
  it('reports ok and sends the service role key both ways round', async () => {
    const { supabase } = await loadFake();
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(200));

    const result = await checkSupabaseReachable(supabase, { fetch: fetchMock, now: makeClock() });

    expect(result.ok).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${supabase.url}/rest/v1/`);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.apikey).toBe(supabase.serviceRoleKey);
    expect(headers.Authorization).toBe(`Bearer ${supabase.serviceRoleKey}`);
  });

  it('distinguishes a rejected key from an unreachable project', async () => {
    const { supabase } = await loadFake();

    const rejected = await checkSupabaseReachable(supabase, {
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(401)),
      now: makeClock(),
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.httpStatus).toBe(401);
    expect(rejected.detail).toMatch(/rejected/);

    const unreachable = await checkSupabaseReachable(supabase, {
      fetch: vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('fetch failed')),
      now: makeClock(),
    });
    expect(unreachable.ok).toBe(false);
    expect(unreachable.httpStatus).toBeUndefined();
    expect(unreachable.detail).toMatch(/not reachable/);
  });

  it('reports an unexpected status without claiming auth failure', async () => {
    const { supabase } = await loadFake();
    const result = await checkSupabaseReachable(supabase, {
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(503)),
      now: makeClock(),
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('503');
  });

  it('labels a timeout as such', async () => {
    const { supabase } = await loadFake();
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const result = await checkSupabaseReachable(supabase, {
      fetch: vi.fn<typeof globalThis.fetch>().mockRejectedValue(timeout),
      timeoutMs: 1234,
      now: makeClock(),
    });
    expect(result.detail).toContain('timed out after 1234ms');
  });

  it('never leaks the key or the project host into the detail text', async () => {
    const { supabase } = await loadFake();
    const result = await checkSupabaseReachable(supabase, {
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValue(new TypeError(`getaddrinfo ENOTFOUND ${supabase.url}`)),
      now: makeClock(),
    });
    expect(result.detail).not.toContain(supabase.url);
    expect(result.detail).not.toContain(supabase.serviceRoleKey);
  });
});

describe('checkAll', () => {
  it('runs the Supabase probe with the configured HTTP timeout', async () => {
    const config = await loadFake();
    const results = await checkAll(config, {
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(200)),
      now: makeClock(),
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.target).toBe('supabase:rest');
    expect(results[0]?.ok).toBe(true);
  });
});

/** Monotonic fake clock: keeps latency assertions deterministic. */
function makeClock(): () => number {
  let t = 0;
  return () => (t += 5);
}
