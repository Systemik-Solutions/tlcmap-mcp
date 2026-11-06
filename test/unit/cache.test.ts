import { describe, expect, it } from 'vitest';
import { ByteLruCache } from '../../src/upstream/cache.js';

function make(maxBytes: number, ttlMs = 1000) {
  let t = 0;
  const cache = new ByteLruCache<string>({
    maxBytes,
    ttlMs,
    sizeOf: (v) => v.length,
    now: () => t,
  });
  return {
    cache,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('ByteLruCache', () => {
  it('expires entries after the TTL and stops counting them', () => {
    const { cache, advance } = make(100, 1000);
    cache.set('a', 'xxxx');
    advance(999);
    expect(cache.get('a')).toBe('xxxx');
    advance(1);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
  });

  it('does not extend the TTL on get', () => {
    const { cache, advance } = make(100, 1000);
    cache.set('a', 'xx');
    advance(600);
    cache.get('a');
    advance(400);
    expect(cache.get('a')).toBeUndefined();
  });

  it('evicts the least recently used entry first, and get refreshes recency', () => {
    const { cache } = make(10);
    cache.set('a', 'xxxx');
    cache.set('b', 'xxxx');
    cache.get('a');
    cache.set('c', 'xxxx');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('xxxx');
    expect(cache.get('c')).toBe('xxxx');
    expect(cache.stats()).toEqual({ entries: 2, bytes: 8 });
  });

  it('adjusts bytes when a key is replaced', () => {
    const { cache } = make(100);
    cache.set('a', 'xxxx');
    cache.set('a', 'xx');
    expect(cache.stats()).toEqual({ entries: 1, bytes: 2 });
  });

  it('does not store a value larger than maxBytes and evicts nothing', () => {
    const { cache } = make(10);
    cache.set('a', 'xxxx');
    cache.set('big', 'x'.repeat(11));
    expect(cache.get('big')).toBeUndefined();
    expect(cache.get('a')).toBe('xxxx');
    expect(cache.stats()).toEqual({ entries: 1, bytes: 4 });
  });

  it('drops a stale copy when an oversized value replaces its key', () => {
    const { cache } = make(10);
    cache.set('a', 'xxxx');
    cache.set('a', 'x'.repeat(11));
    expect(cache.get('a')).toBeUndefined();
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
  });

  it('excludes expired entries from stats', () => {
    const { cache, advance } = make(100, 1000);
    cache.set('a', 'xxxx');
    advance(1000);
    cache.set('b', 'xx');
    expect(cache.stats()).toEqual({ entries: 1, bytes: 2 });
  });

  describe('onEvict', () => {
    function withEvents(maxBytes: number, ttlMs = 1000) {
      let t = 0;
      const evicted: [string, string][] = [];
      const cache = new ByteLruCache<string>({
        maxBytes,
        ttlMs,
        sizeOf: (v) => v.length,
        now: () => t,
        onEvict: (k, v) => evicted.push([k, v]),
      });
      return { cache, evicted, advance: (ms: number) => (t += ms) };
    }

    it('fires once on LRU eviction', () => {
      const { cache, evicted } = withEvents(8);
      cache.set('a', 'xxxx');
      cache.set('b', 'yyyy');
      cache.set('c', 'zzzz');
      expect(evicted).toEqual([['a', 'xxxx']]);
    });

    it('fires on TTL expiry found by get, and by purgeExpired', () => {
      const { cache, evicted, advance } = withEvents(100, 1000);
      cache.set('a', 'xxxx');
      cache.set('b', 'yyyy');
      advance(1000);
      expect(cache.get('a')).toBeUndefined();
      expect(evicted).toEqual([['a', 'xxxx']]);
      cache.stats();
      expect(evicted).toEqual([
        ['a', 'xxxx'],
        ['b', 'yyyy'],
      ]);
    });

    it('fires when set replaces a key', () => {
      const { cache, evicted } = withEvents(100);
      cache.set('a', 'xxxx');
      cache.set('a', 'yy');
      expect(evicted).toEqual([['a', 'xxxx']]);
    });

    it('never fires for a value too large to store', () => {
      const { cache, evicted } = withEvents(3);
      cache.set('a', 'xxxx');
      expect(evicted).toEqual([]);
    });
  });
});
