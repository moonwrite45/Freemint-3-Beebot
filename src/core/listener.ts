/**
 * On-chain block watcher. Pluggable-watcher architecture: ONE polling
 * loop per chain feeds every transaction to a list of ChainWatchers, so
 * free-mint discovery and whale copy-mint tracking share the same RPC
 * calls instead of each running an independent poll loop. That matters
 * concretely here — Robinhood Chain's and Ink's own docs warn against
 * hammering their public RPC endpoints with bot traffic, so doubling
 * read load for a second watcher would have been a real cost, not a
 * theoretical one.
 */

import { getPublicClient } from "./chain.js";
import type { ChainId } from "./chains.js";

// A deliberately small, well-known set of mint-like selectors used only
// to decide "worth looking at further," never "is free" — that call is
// scanner.ts's alone, using real state reads/dry-runs.
export const MINT_SELECTORS = new Set<string>([
  "0x1249c58b", // mint()
  "0xa0712d68", // mint(uint256)
  "0x6a627842", // mint(address)
  "0x40c10f19", // mint(address,uint256)
  "0x4e6ec247", // claim()
  "0x84bb1e42", // claim(uint256)
  "0x161ac21f", // mintPublic
  "0xefef39a1", // mintSeaDrop
  "0x8d45fc5e", // freeMint()
]);

export interface TxInfo {
  to: string | null;
  from: string;
  hash: string;
  input: string;
  value: bigint;
}

export interface ChainWatcher {
  /** Called for every transaction in every new block on this chain. */
  onTransaction?(tx: TxInfo, chain: ChainId): Promise<void>;
  /** Called specifically for new contract creations (to === null). */
  onNewContract?(address: string, chain: ChainId, txHash: string): Promise<void>;
}

const POLL_INTERVAL_MS = 6_000;
const BASE_RECONNECT_MS = 2_000;
const MAX_RECONNECT_MS = 30_000;

export class ChainListener {
  private chain: ChainId;
  private watchers: ChainWatcher[];
  private running = false;
  private reconnectDelay = BASE_RECONNECT_MS;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastBlock: bigint | null = null;

  constructor(chain: ChainId, watchers: ChainWatcher[]) {
    this.chain = chain;
    this.watchers = watchers;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    console.log(`[${this.chain}] listener starting (${this.watchers.length} watcher(s))`);
    this.pollLoop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private async pollLoop(): Promise<void> {
    if (!this.running) return;
    try {
      await this.pollOnce();
      this.reconnectDelay = BASE_RECONNECT_MS; // reset backoff on success
    } catch (cause) {
      console.error(`[${this.chain}] listener error:`, cause);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
    }
    this.timer = setTimeout(() => this.pollLoop(), this.reconnectDelay === BASE_RECONNECT_MS ? POLL_INTERVAL_MS : this.reconnectDelay);
  }

  private async pollOnce(): Promise<void> {
    const client = getPublicClient(this.chain);
    const latest = await client.getBlockNumber();

    const from = this.lastBlock === null ? latest : this.lastBlock + 1n;
    if (from > latest) return; // nothing new yet

    // Bug fix: this used to compute `from` and then only ever fetch the
    // single `latest` block — any block produced between polls (a slow
    // RPC response, a backoff pause after an error, or just the chain
    // producing blocks faster than POLL_INTERVAL_MS) was silently never
    // read, meaning transactions in it were never seen by any watcher.
    // Now walks the full range, capped so a long outage doesn't try to
    // replay hundreds of blocks in one burst against a public RPC.
    const MAX_BLOCKS_PER_POLL = 10n;
    const rangeEnd = latest - from + 1n > MAX_BLOCKS_PER_POLL ? from + MAX_BLOCKS_PER_POLL - 1n : latest;
    if (rangeEnd < latest) {
      console.warn(
        `[${this.chain}] falling behind — processing blocks ${from}-${rangeEnd} of ${latest}, will catch up over subsequent polls`
      );
    }

    for (let blockNumber = from; blockNumber <= rangeEnd; blockNumber++) {
      const block = await client.getBlock({ blockNumber, includeTransactions: true });

      const txs = (block.transactions ?? []) as Array<{
        to: string | null;
        from: string;
        hash: string;
        input: string;
        value: bigint;
      }>;

      for (const raw of txs) {
        const tx: TxInfo = { to: raw.to, from: raw.from, hash: raw.hash, input: raw.input, value: raw.value };

        if (tx.to === null) {
          const receipt = await client.getTransactionReceipt({ hash: tx.hash as `0x${string}` }).catch(() => null);
          const contractAddress = receipt?.contractAddress;
          if (contractAddress) {
            for (const w of this.watchers) {
              await w.onNewContract?.(contractAddress, this.chain, tx.hash).catch((cause: unknown) =>
                console.error(`[${this.chain}] watcher onNewContract error:`, cause)
              );
            }
          }
          continue;
        }

        for (const w of this.watchers) {
          await w.onTransaction?.(tx, this.chain).catch((cause: unknown) =>
            console.error(`[${this.chain}] watcher onTransaction error:`, cause)
          );
        }
      }

      this.lastBlock = blockNumber;
    }
  }
}

export function startAllListeners(chains: ChainId[], watchers: ChainWatcher[]): ChainListener[] {
  return chains.map((chain) => {
    const listener = new ChainListener(chain, watchers);
    listener.start();
    return listener;
  });
}
