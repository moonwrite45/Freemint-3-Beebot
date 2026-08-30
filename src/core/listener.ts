/**
 * On-chain discovery source. Watches new blocks for:
 *   1) new contract creations, and
 *   2) transactions calling a known mint-like function selector
 * and feeds candidates into the (already-fixed) scanner for real
 * verification — this listener only ever proposes candidates, it never
 * itself decides "free or not." That decision stays entirely in
 * scanner.ts, which is the piece we already made honest.
 */

import { getPublicClient } from "./chain.js";
import { getChainConfig, type ChainId } from "./chains.js";
import type { SeenContracts } from "./queue.js";
import { seenKey } from "./queue.js";

// A deliberately small, well-known set of mint-like selectors used only
// to decide "worth scanning," never "is free" — that call is scanner.ts's
// alone, using real state reads/dry-runs.
const MINT_SELECTORS = new Set<string>([
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

export interface DiscoveryCandidate {
  contractAddress: string;
  chain: ChainId;
  txHash: string;
  source: "onchain_new_contract" | "onchain_mint_call";
}

export type CandidateCallback = (candidate: DiscoveryCandidate) => Promise<void>;

const POLL_INTERVAL_MS = 6_000;
const BASE_RECONNECT_MS = 2_000;
const MAX_RECONNECT_MS = 30_000;

export class ChainListener {
  private chain: ChainId;
  private onCandidate: CandidateCallback;
  private seen: SeenContracts;
  private running = false;
  private reconnectDelay = BASE_RECONNECT_MS;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastBlock: bigint | null = null;

  constructor(chain: ChainId, onCandidate: CandidateCallback, seen: SeenContracts) {
    this.chain = chain;
    this.onCandidate = onCandidate;
    this.seen = seen;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    console.log(`[${this.chain}] listener starting`);
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

    const block = await client.getBlock({ blockNumber: latest, includeTransactions: true });
    this.lastBlock = latest;

    const txs = (block.transactions ?? []) as Array<{
      to: string | null;
      hash: string;
      input: string;
    }>;

    for (const tx of txs) {
      // New contract creation: `to` is null.
      if (tx.to === null) {
        const receipt = await client.getTransactionReceipt({ hash: tx.hash as `0x${string}` }).catch(() => null);
        const contractAddress = receipt?.contractAddress;
        if (contractAddress) await this.emit(contractAddress, tx.hash, "onchain_new_contract");
        continue;
      }

      const selector = (tx.input || "0x").slice(0, 10);
      if (MINT_SELECTORS.has(selector)) {
        await this.emit(tx.to, tx.hash, "onchain_mint_call");
      }
    }
  }

  private async emit(contractAddress: string, txHash: string, source: DiscoveryCandidate["source"]): Promise<void> {
    const key = seenKey(this.chain, contractAddress);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    await this.onCandidate({ contractAddress, chain: this.chain, txHash, source }).catch((cause) =>
      console.error(`[${this.chain}] candidate handler error:`, cause)
    );
  }
}

export function startAllListeners(chains: ChainId[], onCandidate: CandidateCallback, seen: SeenContracts): ChainListener[] {
  return chains.map((chain) => {
    const listener = new ChainListener(chain, onCandidate, seen);
    listener.start();
    return listener;
  });
}
