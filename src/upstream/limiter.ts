import { TlcmapError } from '../errors.js';

interface Waiter {
  grant: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Limiter {
  private inFlight = 0;
  private readonly waiters: Waiter[] = [];
  private readonly concurrency: number;
  private readonly queueMax: number;
  private readonly queueTimeoutMs: number;
  private readonly now: () => number;

  constructor(opts: {
    concurrency: number;
    queueMax: number;
    queueTimeoutMs: number;
    now?: () => number;
  }) {
    this.concurrency = opts.concurrency;
    this.queueMax = opts.queueMax;
    this.queueTimeoutMs = opts.queueTimeoutMs;
    this.now = opts.now ?? Date.now;
  }

  async run<T>(fn: () => Promise<T>): Promise<{ value: T; queueWaitMs: number }> {
    let queueWaitMs = 0;
    if (this.inFlight < this.concurrency && this.waiters.length === 0) {
      this.inFlight++;
    } else {
      const queuedAt = this.now();
      await this.waitForSlot();
      queueWaitMs = this.now() - queuedAt;
    }
    try {
      return { value: await fn(), queueWaitMs };
    } finally {
      this.release();
    }
  }

  stats(): { inFlight: number; queued: number } {
    return { inFlight: this.inFlight, queued: this.waiters.length };
  }

  private busy(): TlcmapError {
    return new TlcmapError(
      'SERVER_BUSY',
      'The server is handling as many requests as it can. Please try again shortly.',
      { queued: this.waiters.length, retry_after_s: Math.ceil(this.queueTimeoutMs / 1000) },
    );
  }

  // Resolves once a slot has been handed over (inFlight already counts it).
  private waitForSlot(): Promise<void> {
    if (this.waiters.length >= this.queueMax) return Promise.reject(this.busy());
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: resolve,
        timer: setTimeout(() => {
          const err = this.busy(); // counts this waiter, as the full-queue path counts the queue
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(err);
        }, this.queueTimeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.grant(); // slot passes straight to the oldest live waiter
    } else {
      this.inFlight--;
    }
  }
}

export class SingleFlight<T> {
  private readonly inFlight = new Map<string, Promise<T>>();

  async do(key: string, fn: () => Promise<T>): Promise<{ value: T; shared: boolean }> {
    const existing = this.inFlight.get(key);
    if (existing) return { value: await existing, shared: true };
    const promise = fn();
    this.inFlight.set(key, promise);
    const clear = () => {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    };
    promise.then(clear, clear);
    return { value: await promise, shared: false };
  }
}
