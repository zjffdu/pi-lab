export interface CacheScope {
  tenantId: string;
  /** Present for owner-scoped entries; omitted for tenant-scoped ones. */
  subject?: string;
}

/**
 * A cache whose every key is namespaced by scope. The composite key is a JSON array rather than
 * a delimiter-joined string: `["a:b", "c"]` and `["a", "b:c"]` stay distinct, where
 * `"a:b" + ":" + "c"` and `"a" + ":" + "b:c"` would collide.
 */
export class ScopedCache<V> {
  private readonly entries = new Map<string, V>();
  private hits = 0;

  public static keyFor(scope: CacheScope, key: string): string {
    return JSON.stringify([scope.tenantId, scope.subject ?? null, key]);
  }

  public get(scope: CacheScope, key: string): V | undefined {
    const value = this.entries.get(ScopedCache.keyFor(scope, key));
    if (value !== undefined) this.hits += 1;
    return value;
  }

  public set(scope: CacheScope, key: string, value: V): void {
    this.entries.set(ScopedCache.keyFor(scope, key), value);
  }

  /** How many `get` calls found an entry. Lets a test prove a lookup was served from cache without reading tool output. */
  public get hitCount(): number {
    return this.hits;
  }

  public get size(): number {
    return this.entries.size;
  }
}
