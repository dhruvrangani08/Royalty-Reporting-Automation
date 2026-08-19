import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import type { AppConfig, WlConfig } from '../src/config/schema.js';
import { WlClient, type WlRequestError } from '../src/wl/client.js';
import { WlRateLimiter } from '../src/wl/rate-limit.js';
import { RETRY_SCHEDULE_MS, retryDelayMs, throttleBackoffMs } from '../src/wl/retry.js';
import { runWellnessSync } from '../src/wl/sync.js';
import { FakeProvider } from './helpers/fixtures.js';

/**
 * WL publishes no rate limits, so the client starts conservative and backs off
 * rather than failing. What is asserted here:
 *
 *   - the cap is SHARED, so N workers do not multiply the real rate by N
 *   - a throttle backs off on a widening, jittered ladder and the item is
 *     handed back for requeue rather than dropped
 *   - a permanent error costs exactly one call, because a bad parameter will be
 *     just as bad in twenty-five minutes
 *   - a throttled run still finishes
 *
 * Time is injected everywhere. A test that actually waited out a 25 minute
 * backoff would not be a test.
 */

const loadFake = (): Promise<AppConfig> =>
  loadConfig({ processEnv: { APP_ENV: 'dev' }, provider: new FakeProvider() });

async function wlConfig(): Promise<WlConfig> {
  return (await loadFake()).wl;
}

/**
 * A clock that only moves when something sleeps.
 *
 * This is what makes the spacing assertions meaningful: if the limiter did not
 * wait, time would not advance, and the next slot would still be in the past.
 */
function fakeTime() {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number): Promise<void> => {
      slept.push(ms);
      t += ms;
      return Promise.resolve();
    },
    slept,
    elapsed: () => t,
  };
}

function calledUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return '';
}

function tokenResponse(): Response {
  return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), { status: 200 });
}

function ok(): Response {
  return new Response(JSON.stringify({ status: 'ok', k_log: '[1.1msb]' }), { status: 200 });
}

/** WL's throttle: HTTP 200 with a transient sid in the envelope. */
function throttled(headers: Record<string, string> = {}): Response {
  return new Response(
    JSON.stringify({
      status: 'rate-limit',
      a_error: [{ sid: 'rate-limit', s_message: 'Too many requests.' }],
    }),
    { status: 200, headers },
  );
}

/** A bad parameter. Never succeeds, however long you wait. */
function permanent(): Response {
  return new Response(
    JSON.stringify({
      status: 'id-empty',
      a_error: [{ sid: 'id-empty', s_message: 'No ID is specified.', s_field: 'k_purchase' }],
    }),
    { status: 200 },
  );
}

/** Serves tokens, then the given factories to successive data calls. */
function routed(...dataResponses: Array<() => Response>) {
  let dataCall = 0;
  const counts = { data: 0 };
  const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
    if (calledUrl(input).includes('/oauth2/token')) return Promise.resolve(tokenResponse());
    counts.data += 1;
    const next = dataResponses[dataCall] ?? dataResponses[dataResponses.length - 1];
    dataCall += 1;
    return Promise.resolve(next === undefined ? ok() : next());
  });
  return { fetchMock, counts };
}

describe('the rate limiter is shared and configurable', () => {
  it('spaces requests to the configured rate', async () => {
    const time = fakeTime();
    const limiter = new WlRateLimiter({ requestsPerSecond: 5, now: time.now, sleep: time.sleep });

    for (let i = 0; i < 4; i += 1) await limiter.run(() => Promise.resolve(i));

    // 5/s means one every 200ms. The first is free; three wait.
    expect(time.slept).toEqual([200, 200, 200]);
    expect(limiter.stats().admitted).toBe(4);
  });

  it('honours a different configured rate', async () => {
    const time = fakeTime();
    const limiter = new WlRateLimiter({ requestsPerSecond: 2, now: time.now, sleep: time.sleep });

    for (let i = 0; i < 3; i += 1) await limiter.run(() => Promise.resolve(i));

    expect(time.slept).toEqual([500, 500]);
  });

  it('does not wait at all when no limit is configured', async () => {
    const time = fakeTime();
    const limiter = new WlRateLimiter({ now: time.now, sleep: time.sleep });

    for (let i = 0; i < 10; i += 1) await limiter.run(() => Promise.resolve(i));

    expect(time.slept).toEqual([]);
  });

  it('caps the rate ACROSS workers, not per worker', async () => {
    const wl = await wlConfig();
    const time = fakeTime();
    // One limiter, two clients - the shape runWellnessSync uses.
    const limiter = new WlRateLimiter({ requestsPerSecond: 5, now: time.now, sleep: time.sleep });
    const workerA = new WlClient(wl, { fetch: routed(ok).fetchMock, limiter, now: time.now });
    const workerB = new WlClient(wl, { fetch: routed(ok).fetchMock, limiter, now: time.now });

    await workerA.request('/v1/business');
    await workerB.request('/v1/business');
    await workerA.request('/v1/business');

    // Three calls through ONE cap. Per-worker limiters would have let workerB's
    // call go immediately, costing a 200ms wait rather than two.
    expect(limiter.stats().admitted).toBe(3);
    expect(time.slept).toEqual([200, 200]);
  });

  it('caps how many requests are in flight at once', async () => {
    const limiter = new WlRateLimiter({ maxConcurrency: 2 });
    const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
    let inFlight = 0;
    let peak = 0;
    /** Each running task parks on a gate, so the test decides when it finishes. */
    const gates: Array<() => void> = [];

    const runs = Array.from({ length: 5 }, () =>
      limiter.run(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => gates.push(resolve));
        inFlight -= 1;
      }),
    );

    // Five started, but only two may be running: the rest are queued.
    await flush();
    expect(inFlight).toBe(2);

    // Releasing one admits exactly one more, never two.
    for (let i = 0; i < 5; i += 1) {
      gates.shift()?.();
      await flush();
    }
    await Promise.all(runs);

    expect(peak).toBe(2);
    expect(limiter.stats().admitted).toBe(5);
  });

  it('applies the configured limits on the real sync path', async () => {
    const config = await loadFake();
    const time = fakeTime();
    const { fetchMock } = routed(ok);

    await runWellnessSync(config, { fetch: fetchMock, now: time.now, sleep: time.sleep });

    // FakeProvider resolves the schema default of 5/s, and sync must pass it
    // through: without that wiring WL_REQUESTS_PER_SECOND would be dead config.
    expect(config.runtime.requestsPerSecond).toBe(5);
    expect(time.slept.every((ms) => ms === 200)).toBe(true);
    expect(time.slept.length).toBeGreaterThan(0);
  });
});

describe('a throttle backs off, widens and requeues', () => {
  it('backs off on a widening ladder rather than a fixed delay', async () => {
    const wl = await wlConfig();
    const time = fakeTime();
    const { fetchMock, counts } = routed(throttled);
    const client = new WlClient(wl, {
      fetch: fetchMock,
      now: time.now,
      sleep: time.sleep,
      random: () => 0, // pin the jitter so the ladder itself is visible
    });

    await client.request('/v1/business').catch(() => undefined);

    // 1s, 5s, 25s - increasing, then it stops trying in-process.
    expect(time.slept).toEqual([1_000, 5_000, 25_000]);
    expect(counts.data).toBe(4);
  });

  it('adds jitter on top of the base delay, never below it', () => {
    expect(throttleBackoffMs(0, () => 0)).toBe(1_000);
    expect(throttleBackoffMs(0, () => 1)).toBe(1_200);
    expect(throttleBackoffMs(0, () => 0.5)).toBe(1_100);
    // The documented delay is the floor, so a reader checking the schedule
    // against the ticket sees the number they expect.
    expect(throttleBackoffMs(2, () => 0)).toBe(25_000);
  });

  it('prefers WL Retry-After over our own ladder', async () => {
    const wl = await wlConfig();
    const time = fakeTime();
    const { fetchMock } = routed(() => throttled({ 'retry-after': '3' }), ok);
    const client = new WlClient(wl, { fetch: fetchMock, now: time.now, sleep: time.sleep });

    const result = await client.request('/v1/business');

    expect(time.slept).toEqual([3_000]);
    expect(result.httpStatus).toBe(200);
  });

  it('ignores an absurd Retry-After rather than stalling the run', async () => {
    const wl = await wlConfig();
    const time = fakeTime();
    const { fetchMock } = routed(() => throttled({ 'retry-after': '86400' }), ok);
    const client = new WlClient(wl, {
      fetch: fetchMock,
      now: time.now,
      sleep: time.sleep,
      random: () => 0,
    });

    await client.request('/v1/business');

    expect(time.slept).toEqual([1_000]);
  });

  it('hands the item back for requeue once the in-process ladder is spent', async () => {
    const wl = await wlConfig();
    const time = fakeTime();
    const { fetchMock } = routed(throttled);
    const client = new WlClient(wl, {
      fetch: fetchMock,
      now: time.now,
      sleep: time.sleep,
      random: () => 0,
    });

    const error = (await client.request('/v1/business').catch((e: unknown) => e)) as WlRequestError;

    expect(error.kind).toBe('transient');
    expect(error.isRetryable).toBe(true);
    // Not dropped: the queue layer is told when to try again.
    expect(error.details.requeueAfterMs).toBe(60_000);
    expect(error.details.attempts).toBe(4);
  });
});

describe('a permanent error fails immediately', () => {
  it('makes exactly one call and never sleeps', async () => {
    const wl = await wlConfig();
    const time = fakeTime();
    const { fetchMock, counts } = routed(permanent);
    const client = new WlClient(wl, { fetch: fetchMock, now: time.now, sleep: time.sleep });

    const error = (await client.request('/v1/business').catch((e: unknown) => e)) as WlRequestError;

    expect(error.kind).toBe('permanent');
    expect(counts.data).toBe(1);
    expect(time.slept).toEqual([]);
    expect(error.details.attempts).toBe(1);
  });

  it('gives the queue nothing to retry, so it goes straight to dead-letter', async () => {
    const wl = await wlConfig();
    const time = fakeTime();
    const client = new WlClient(wl, {
      fetch: routed(permanent).fetchMock,
      now: time.now,
      sleep: time.sleep,
    });

    const error = (await client.request('/v1/business').catch((e: unknown) => e)) as WlRequestError;

    expect(error.details.requeueAfterMs).toBeNull();
    expect(error.isRetryable).toBe(false);
  });
});

describe('the requeue schedule is 1, 5 and 25 minutes', () => {
  it('matches the documented schedule', () => {
    expect(RETRY_SCHEDULE_MS).toEqual([60_000, 300_000, 1_500_000]);
    expect(retryDelayMs(0, () => 0)).toBe(60_000);
    expect(retryDelayMs(1, () => 0)).toBe(300_000);
    expect(retryDelayMs(2, () => 0)).toBe(1_500_000);
  });

  it('jitters each step so a throttled fleet does not wake in lockstep', () => {
    expect(retryDelayMs(0, () => 1)).toBe(72_000);
    expect(retryDelayMs(1, () => 1)).toBe(360_000);
  });

  it('runs out rather than retrying forever', () => {
    expect(retryDelayMs(3, () => 0)).toBeNull();
    expect(retryDelayMs(99, () => 0)).toBeNull();
  });
});

describe('a throttled run still finishes', () => {
  it('succeeds when WL throttles and then recovers', async () => {
    const config = await loadFake();
    const time = fakeTime();
    // Every step is throttled once, then answers normally.
    let call = 0;
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
      if (calledUrl(input).includes('/oauth2/token')) return Promise.resolve(tokenResponse());
      call += 1;
      return Promise.resolve(call % 2 === 1 ? throttled() : ok());
    });

    const summary = await runWellnessSync(config, {
      fetch: fetchMock,
      now: time.now,
      sleep: time.sleep,
      random: () => 0,
    });

    expect(summary.ok).toBe(true);
    expect(summary.steps.every((s) => s.ok)).toBe(true);
    // It waited rather than failing.
    expect(time.slept).toContain(1_000);
  });
});
