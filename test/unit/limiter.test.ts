import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TlcmapError } from '../../src/errors.js';
import { Limiter, SingleFlight } from '../../src/upstream/limiter.js';

function deferred<T = string>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const opts = { concurrency: 2, queueMax: 1, queueTimeoutMs: 20_000 };

describe('Limiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('queues a third run until a slot frees', async () => {
    const limiter = new Limiter(opts);
    const a = deferred();
    const b = deferred();
    const fn3 = vi.fn(async () => 'c');
    const p1 = limiter.run(() => a.promise);
    const p2 = limiter.run(() => b.promise);
    const p3 = limiter.run(fn3);
    expect(limiter.stats()).toEqual({ inFlight: 2, queued: 1 });
    expect(fn3).not.toHaveBeenCalled();
    a.resolve('a');
    expect((await p1).value).toBe('a');
    expect((await p3).value).toBe('c');
    b.resolve('b');
    await p2;
    expect(limiter.stats()).toEqual({ inFlight: 0, queued: 0 });
  });

  it('rejects immediately with SERVER_BUSY when the queue is full', async () => {
    const limiter = new Limiter(opts);
    const a = deferred();
    const b = deferred();
    void limiter.run(() => a.promise);
    void limiter.run(() => b.promise);
    void limiter.run(async () => 'queued');
    const fn4 = vi.fn(async () => 'd');
    const err = await limiter.run(fn4).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TlcmapError);
    expect((err as TlcmapError).code).toBe('SERVER_BUSY');
    expect((err as TlcmapError).details).toEqual({ queued: 1, retry_after_s: 20 });
    expect(fn4).not.toHaveBeenCalled();
  });

  it('rejects a waiter after queueTimeoutMs and never calls its fn', async () => {
    const limiter = new Limiter(opts);
    const a = deferred();
    const b = deferred();
    void limiter.run(() => a.promise);
    void limiter.run(() => b.promise);
    const fn3 = vi.fn(async () => 'c');
    const p3 = limiter.run(fn3).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    const err = await p3;
    expect((err as TlcmapError).code).toBe('SERVER_BUSY');
    expect((err as TlcmapError).details).toEqual({ queued: 1, retry_after_s: 20 });
    expect(limiter.stats()).toEqual({ inFlight: 2, queued: 0 });
    a.resolve('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(fn3).not.toHaveBeenCalled();
    expect(limiter.stats()).toEqual({ inFlight: 1, queued: 0 });
  });

  it('reports queueWaitMs, and 0 when a slot is immediate', async () => {
    let t = 1000;
    const limiter = new Limiter({ ...opts, now: () => t });
    const a = deferred();
    const b = deferred();
    const p1 = limiter.run(() => a.promise);
    void limiter.run(() => b.promise);
    const p3 = limiter.run(async () => 'c');
    t += 750;
    a.resolve('a');
    expect((await p1).queueWaitMs).toBe(0);
    expect((await p3).queueWaitMs).toBe(750);
  });

  it('grants freed slots to the oldest waiter first', async () => {
    const limiter = new Limiter({ ...opts, queueMax: 2 });
    const a = deferred();
    const b = deferred();
    const order: string[] = [];
    void limiter.run(() => a.promise);
    void limiter.run(() => b.promise);
    const p3 = limiter.run(async () => void order.push('first'));
    const p4 = limiter.run(async () => void order.push('second'));
    a.resolve('a');
    await p3;
    await p4;
    expect(order).toEqual(['first', 'second']);
  });

  it('frees the slot when fn rejects', async () => {
    const limiter = new Limiter({ ...opts, concurrency: 1 });
    await expect(limiter.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(limiter.stats()).toEqual({ inFlight: 0, queued: 0 });
    expect((await limiter.run(async () => 'ok')).value).toBe('ok');
  });
});

describe('SingleFlight', () => {
  it('shares one call between concurrent callers, then calls again after settling', async () => {
    const sf = new SingleFlight<string>();
    const d = deferred();
    const fn = vi.fn(() => d.promise);
    const p1 = sf.do('k', fn);
    const p2 = sf.do('k', fn);
    d.resolve('v');
    expect(await p1).toEqual({ value: 'v', shared: false });
    expect(await p2).toEqual({ value: 'v', shared: true });
    expect(fn).toHaveBeenCalledTimes(1);
    await sf.do('k', async () => 'w');
    const fn2 = vi.fn(async () => 'x');
    await sf.do('k', fn2);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it('gives joiners the same rejection and clears the entry', async () => {
    const sf = new SingleFlight<string>();
    const d = deferred();
    const fn = vi.fn(() => d.promise);
    const p1 = sf.do('k', fn).catch((e: unknown) => e);
    const p2 = sf.do('k', fn).catch((e: unknown) => e);
    const boom = new Error('boom');
    d.reject(boom);
    expect(await p1).toBe(boom);
    expect(await p2).toBe(boom);
    expect(fn).toHaveBeenCalledTimes(1);
    expect((await sf.do('k', async () => 'again')).value).toBe('again');
  });
});
