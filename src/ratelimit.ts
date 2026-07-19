// Dogear — client-side rate limiting.
//
// The lesson from testing: reacting to 429 responses is too late. By the time
// a service tells you to slow down, you have already been penalised, and on
// Open Library the penalty outlasts the burst that caused it.
//
// So Dogear polices itself. A token bucket caps the outgoing request rate
// below what each service tolerates, and callers wait for a token rather than
// firing and hoping. This is the standard approach — the same shape as the
// limiters in well-behaved API clients everywhere — and it costs nothing when
// you are under the limit.
//
// Pure and dependency-free: time and sleeping are injected so the behaviour
// can be tested without waiting.

export interface BucketOptions {
    /** Maximum tokens held at once — how large a burst is allowed. */
    capacity: number;
    /** Tokens added per second. */
    refillPerSecond: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}

export class TokenBucket {
    private tokens: number;
    private lastRefill: number;
    private readonly capacity: number;
    private readonly refillPerSecond: number;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;

    /** Diagnostics: how often callers actually had to wait. */
    stats = { granted: 0, waited: 0, totalWaitMs: 0 };

    constructor(options: BucketOptions) {
        this.capacity = Math.max(1, options.capacity);
        this.refillPerSecond = Math.max(0.001, options.refillPerSecond);
        this.now = options.now ?? (() => Date.now());
        this.sleep = options.sleep ?? ((ms) => new Promise((r) => window.setTimeout(r, ms)));
        // Start full: the first search of a session should be instant.
        this.tokens = this.capacity;
        this.lastRefill = this.now();
    }

    private refill(): void {
        const now = this.now();
        const elapsedMs = now - this.lastRefill;
        if (elapsedMs <= 0) return;
        this.tokens = Math.min(
            this.capacity,
            this.tokens + (elapsedMs / 1000) * this.refillPerSecond,
        );
        this.lastRefill = now;
    }

    /** Tokens available right now, for display and tests. */
    available(): number {
        this.refill();
        return this.tokens;
    }

    /** Milliseconds until a token would be free, or 0 if one is ready. */
    delayUntilReady(): number {
        this.refill();
        if (this.tokens >= 1) return 0;
        const needed = 1 - this.tokens;
        return Math.ceil((needed / this.refillPerSecond) * 1000);
    }

    /** Take a token without waiting. Returns false if none is available. */
    tryTake(): boolean {
        this.refill();
        if (this.tokens < 1) return false;
        this.tokens -= 1;
        this.stats.granted++;
        return true;
    }

    /** Wait for a token, then take it. */
    async take(): Promise<void> {
        const wait = this.delayUntilReady();
        if (wait > 0) {
            this.stats.waited++;
            this.stats.totalWaitMs += wait;
            await this.sleep(wait);
            this.refill();
        }
        this.tokens = Math.max(0, this.tokens - 1);
        this.stats.granted++;
    }
}

/**
 * A daily counter, for services that limit per day rather than per second.
 *
 * Google Books counts queries per day, so a per-second bucket cannot protect
 * you from it. Knowing the daily figure also lets the interface warn before
 * the limit is reached rather than after.
 */
export class DailyBudget {
    private day: string;
    private used = 0;

    constructor(
        private readonly limit: number,
        private readonly now: () => number = () => Date.now(),
    ) {
        this.day = this.today();
    }

    private today(): string {
        const d = new Date(this.now());
        return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    }

    private rollover(): void {
        const today = this.today();
        if (today !== this.day) {
            this.day = today;
            this.used = 0;
        }
    }

    spent(): number {
        this.rollover();
        return this.used;
    }

    remaining(): number {
        this.rollover();
        return Math.max(0, this.limit - this.used);
    }

    /** Record one request. Returns false when the budget is already spent. */
    consume(): boolean {
        this.rollover();
        if (this.used >= this.limit) return false;
        this.used++;
        return true;
    }

    /** Restore a saved count, so the budget survives a restart. */
    restore(day: string, used: number): void {
        if (day === this.today()) {
            this.day = day;
            this.used = Math.max(0, used);
        }
    }

    snapshot(): { day: string; used: number } {
        this.rollover();
        return { day: this.day, used: this.used };
    }
}
