/**
 * The shared WellnessLiving rate limiter.
 *
 * WL does not publish its limits, so the service starts deliberately
 * conservative (PRD section 8: ~5 requests per second, 5 concurrent) and backs
 * off rather than failing when it is throttled.
 *
 * SHARED IS THE WHOLE POINT. A limiter owned by one worker caps that worker
 * only, so N workers multiply the real rate by N and the cap becomes fiction.
 * One instance is built per process from config and handed to every client, the
 * same way the token cache is.
 *
 * Two independent limits, both enforced here:
 *
 *   - RATE: requests are spaced so no more than `requestsPerSecond` start in
 *     any second. Slots are reserved in arrival order, so a burst is spread
 *     rather than rejected, and callers keep their place in the queue.
 *   - CONCURRENCY: at most `maxConcurrency` requests are in flight at once,
 *     which bounds memory and open sockets regardless of how slow WL is.
 *
 * `now` and `sleep` are injectable so tests assert the delays without waiting
 * them out.
 */

export interface WlRateLimiterOptions {
  /**
   * Requests started per second. Omitted means unlimited.
   *
   * Unlimited is the default because the limit is configuration, not a constant:
   * `runWellnessSync` always passes the resolved `config.runtime` values, so the
   * deployed path is capped. A bare `new WlClient()` in a test or a one-off
   * script is not, which keeps unit tests instant.
   */
  requestsPerSecond?: number;
  /** Requests in flight at once. Omitted means unlimited. */
  maxConcurrency?: number;
  /** Injectable clock so tests do not depend on wall time. */
  now?: () => number;
  /** Injectable delay so tests do not wait out a backoff. */
  sleep?: (ms: number) => Promise<void>;
}

export interface WlRateLimiterStats {
  /** How many calls have been admitted. */
  readonly admitted: number;
  /** Total ms callers spent waiting for a slot. Surfaces a limit set too low. */
  readonly waitedMs: number;
  /** Currently in flight. */
  readonly inFlight: number;
  readonly requestsPerSecond: number;
  readonly maxConcurrency: number;
}

const realSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

export class WlRateLimiter {
  private readonly rps: number;
  private readonly maxConcurrency: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Earliest time the next request may start, in the injected clock's units. */
  private nextSlotAt = 0;
  private inFlight = 0;
  /** FIFO waiters for a concurrency slot. Order preserved: no starvation. */
  private readonly waiters: Array<() => void> = [];

  private admitted = 0;
  private waitedMs = 0;

  constructor(options: WlRateLimiterOptions = {}) {
    this.rps = normalisePositive(options.requestsPerSecond);
    this.maxConcurrency = normalisePositive(options.maxConcurrency);
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? realSleep;
  }

  stats(): WlRateLimiterStats {
    return {
      admitted: this.admitted,
      waitedMs: this.waitedMs,
      inFlight: this.inFlight,
      requestsPerSecond: this.rps,
      maxConcurrency: this.maxConcurrency,
    };
  }

  /**
   * Runs `fn` once a concurrency slot and a rate slot are both available.
   *
   * A wrapper rather than acquire/release because the slot must be returned even
   * when `fn` throws - and it always throws eventually, since every WL failure
   * mode surfaces as an exception.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireConcurrencySlot();
    try {
      await this.awaitRateSlot();
      this.admitted += 1;
      return await fn();
    } finally {
      this.releaseConcurrencySlot();
    }
  }

  private async acquireConcurrencySlot(): Promise<void> {
    if (this.inFlight < this.maxConcurrency) {
      this.inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.inFlight += 1;
  }

  private releaseConcurrencySlot(): void {
    this.inFlight -= 1;
    const next = this.waiters.shift();
    if (next !== undefined) next();
  }

  /**
   * Reserves the next rate slot and waits for it.
   *
   * The reservation is made synchronously, before any await, so two callers
   * racing here cannot be handed the same slot.
   */
  private async awaitRateSlot(): Promise<void> {
    if (this.rps === Number.POSITIVE_INFINITY) return;

    const intervalMs = 1000 / this.rps;
    const now = this.now();
    const slotAt = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slotAt + intervalMs;

    const waitMs = slotAt - now;
    if (waitMs > 0) {
      this.waitedMs += waitMs;
      await this.sleep(waitMs);
    }
  }
}

/** A limit is a positive number or nothing; zero and nonsense mean unlimited. */
function normalisePositive(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return value;
}
