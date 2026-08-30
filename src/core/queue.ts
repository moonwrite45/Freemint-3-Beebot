/**
 * Lightweight in-memory dedupe for contracts we've already surfaced.
 * The old bot's queue.ts was a full Postgres-backed job queue; we don't
 * have a DB wired up yet (that lands in Phase 4 with wallets/portfolio),
 * so this is intentionally just the dedupe piece — enough to stop the
 * same contract from being alerted twice per process lifetime.
 *
 * This resets on restart. That's a known, acceptable limitation until
 * Phase 4 adds persistence — noted here so it isn't mistaken for a bug.
 */

const MAX_SEEN = 5000;

export class SeenContracts {
  private seen = new Set<string>();
  private order: string[] = [];

  has(key: string): boolean {
    return this.seen.has(key.toLowerCase());
  }

  add(key: string): void {
    const k = key.toLowerCase();
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.order.push(k);
    if (this.order.length > MAX_SEEN) {
      const oldest = this.order.shift();
      if (oldest) this.seen.delete(oldest);
    }
  }

  size(): number {
    return this.seen.size;
  }
}

/** Composite key so the same address on two different chains isn't deduped together. */
export function seenKey(chain: string, address: string): string {
  return `${chain}:${address.toLowerCase()}`;
}
