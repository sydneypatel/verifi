import type { Evidence } from './types';

/**
 * Evidence is cached, not whole results: a filing never changes, so a post
 * checked by a thousand people costs one lookup. Swap MemoryCache for a
 * Postgres-backed one (Supabase) when there is more than one server instance.
 */
export interface EvidenceCache {
  get(key: string): Promise<Evidence | undefined>;
  set(key: string, value: Evidence, ttlMs: number): Promise<void>;
}

export class MemoryCache implements EvidenceCache {
  private store = new Map<string, { value: Evidence; expires: number }>();

  constructor(private now: () => number = Date.now) {}

  async get(key: string): Promise<Evidence | undefined> {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  async set(key: string, value: Evidence, ttlMs: number): Promise<void> {
    this.store.set(key, { value, expires: this.now() + ttlMs });
  }
}
