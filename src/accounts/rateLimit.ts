/**
 * Fixed-window counters: at most `limit` hits per key and `globalLimit` in total per `windowMs`.
 * In memory, per process, like the rest of the server's live state (run one instance).
 */
export class RateLimiter {
  readonly #limit: number;
  readonly #globalLimit: number;
  readonly #windowMs: number;
  #windowStart = 0;
  #total = 0;
  readonly #hits = new Map<string, number>();

  constructor(options: { limit: number; globalLimit: number; windowMs: number }) {
    this.#limit = options.limit;
    this.#globalLimit = options.globalLimit;
    this.#windowMs = options.windowMs;
  }

  /** Whether `key` may go ahead; does not count it. */
  allows(key: string, now = Date.now()): boolean {
    this.#roll(now);
    return this.#total < this.#globalLimit && (this.#hits.get(key) ?? 0) < this.#limit;
  }

  /** Counts one hit for `key`. */
  hit(key: string, now = Date.now()): void {
    this.#roll(now);
    this.#total++;
    this.#hits.set(key, (this.#hits.get(key) ?? 0) + 1);
  }

  #roll(now: number): void {
    if (now - this.#windowStart < this.#windowMs) return;
    this.#windowStart = now;
    this.#total = 0;
    this.#hits.clear();
  }
}
