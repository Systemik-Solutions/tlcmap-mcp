interface Entry<V> {
  value: V;
  size: number;
  insertedAt: number;
}

export interface ByteLruCacheOptions<V> {
  maxBytes: number;
  ttlMs: number;
  sizeOf: (v: V) => number;
  now?: () => number;
  /** Called when an entry leaves for any reason: LRU eviction, TTL expiry, or replacement by set(). */
  onEvict?: (key: string, value: V) => void;
}

/**
 * A least-recently-used cache bounded by total bytes rather than entry count.
 * The Map's insertion order is the recency order: the first key is the least
 * recently used. The TTL counts from `set`; `get` refreshes recency only.
 */
export class ByteLruCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private totalBytes = 0;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly sizeOf: (v: V) => number;
  private readonly now: () => number;
  private readonly onEvict: ((key: string, value: V) => void) | undefined;

  constructor(opts: ByteLruCacheOptions<V>) {
    this.maxBytes = opts.maxBytes;
    this.ttlMs = opts.ttlMs;
    this.sizeOf = opts.sizeOf;
    this.now = opts.now ?? Date.now;
    this.onEvict = opts.onEvict;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (this.expired(entry)) {
      this.remove(key, entry);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    const size = this.sizeOf(value);
    const existing = this.entries.get(key);
    if (existing !== undefined) this.remove(key, existing);
    if (size > this.maxBytes) return;

    this.purgeExpired();
    for (const [k, e] of this.entries) {
      if (this.totalBytes + size <= this.maxBytes) break;
      this.remove(k, e);
    }
    this.entries.set(key, { value, size, insertedAt: this.now() });
    this.totalBytes += size;
  }

  stats(): { entries: number; bytes: number } {
    this.purgeExpired();
    return { entries: this.entries.size, bytes: this.totalBytes };
  }

  private expired(entry: Entry<V>): boolean {
    return this.now() - entry.insertedAt >= this.ttlMs;
  }

  private purgeExpired(): void {
    for (const [k, e] of this.entries) {
      if (this.expired(e)) this.remove(k, e);
    }
  }

  private remove(key: string, entry: Entry<V>): void {
    this.entries.delete(key);
    this.totalBytes -= entry.size;
    this.onEvict?.(key, entry.value);
  }
}
